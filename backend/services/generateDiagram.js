import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SHAPE_TYPES = ['rect', 'circle', 'line', 'text'];
// Same palette the frontend's style menus use, so AI-generated shapes stay visually consistent
const PALETTE = ['#FFFFFF', '#FFD60A', '#64D2FF', '#32D74B', '#FF9F0A'];

const PROMPT_INSTRUCTIONS = `You are a diagram generator for a collaborative whiteboard app.
Given a user's request, respond with ONLY a JSON array of shape objects — no markdown, no code fences, no explanation, just the raw array.

Each shape object must look like this:
{
  "type": "rect" | "circle" | "line" | "text",
  "x": number,
  "y": number,
  "width": number,
  "height": number,
  "stroke": one of ${JSON.stringify(PALETTE)},
  "text": string (the label text — only used when type is "text"),
  "points": array of numbers (a flat [x1,y1,x2,y2,...] path — only used when type is "line")
}

Rules:
- Lay shapes out inside a canvas roughly 1200 wide and 700 tall, starting near x=50, y=50.
- Use "rect" or "circle" for boxes/nodes, "line" to connect them, "text" for labels.
- Generate at most 20 shapes.
- Output must be valid JSON: a single array, nothing else.`;

// Turns whatever Gemini returns into shapes that actually match our schema — AI output
// is never trusted as-is, every field gets checked or replaced with a safe default
function sanitizeShape(raw) {
  if (!raw || !SHAPE_TYPES.includes(raw.type)) return null;

  const stroke = PALETTE.includes(raw.stroke) ? raw.stroke : PALETTE[0];
  const points = Array.isArray(raw.points) ? raw.points.map(Number).filter((n) => !Number.isNaN(n)) : [];

  return {
    id: `shape_${randomUUID()}`,
    type: raw.type,
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    stroke,
    strokeWidth: 2,
    fill: raw.type === 'text' ? stroke : 'transparent',
    points,
    text: typeof raw.text === 'string' ? raw.text : '',
    fontSize: 18,
    createdBy: 'ai',
  };
}

// Vision prompt for turning a rough hand-drawn sketch into clean shapes — same output
// schema as generateDiagram, but the input is an image instead of a text description
const SKETCH_PROMPT_INSTRUCTIONS = (width, height) => `You are converting a rough hand-drawn sketch into a clean diagram for a collaborative whiteboard app.
The attached image is ${width}x${height} pixels, showing thin freehand strokes and rough handwriting on a black background.
Identify what the user was trying to draw — a box-like scribble becomes "rect", a round scribble becomes "circle", a connecting stroke becomes "line", and any legible handwritten words become "text".
Respond with ONLY a JSON array of shape objects — no markdown, no code fences, no explanation, just the raw array.

Each shape object must look like this:
{
  "type": "rect" | "circle" | "line" | "text",
  "x": number,
  "y": number,
  "width": number,
  "height": number,
  "stroke": one of ${JSON.stringify(PALETTE)},
  "text": string (the label text — only used when type is "text"),
  "points": array of numbers (a flat [x1,y1,x2,y2,...] path — only used when type is "line")
}

Rules:
- Use the image's own pixel coordinates: x from 0 to ${width}, y from 0 to ${height}.
- Straighten and clean up the rough strokes into tidy shapes — don't just copy the wobbly original points.
- Generate at most 20 shapes.
- Output must be valid JSON: a single array, nothing else.`;

// Shared by generateDiagram and convertSketch — both just hand Gemini a different prompt
// and expect the same "JSON array of shapes" response back
async function callGeminiForShapes(contents) {
  const result = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents,
    config: {
      responseMimeType: 'application/json',
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error('AI did not return valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('AI response was not a list of shapes');
  }

  return parsed.map(sanitizeShape).filter(Boolean).slice(0, 20);
}

export async function convertSketch({ imageBase64, mimeType, width, height }) {
  const shapes = await callGeminiForShapes([
    { text: SKETCH_PROMPT_INSTRUCTIONS(width, height) },
    { inlineData: { mimeType, data: imageBase64 } },
  ]);

  if (shapes.length === 0) {
    throw new Error('AI could not identify any shapes in the sketch');
  }

  return shapes;
}

// Plain-text prompt for describing what a selected part of the board shows — no shape
// schema involved here, the response is just an explanation for a human to read
const EXPLAIN_PROMPT_INSTRUCTIONS = `You are looking at a snippet from a technical diagram on a collaborative whiteboard.
Explain in plain language what it shows — the concept, flow, or structure being diagrammed.
Be concise: 2-4 sentences. If the content isn't clear or meaningful enough to explain, say so honestly instead of guessing.`;

export async function explainSelection({ imageBase64, mimeType }) {
  const result = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [
      { text: EXPLAIN_PROMPT_INSTRUCTIONS },
      { inlineData: { mimeType, data: imageBase64 } },
    ],
  });

  const explanation = result.text?.trim();
  if (!explanation) {
    throw new Error('AI did not return an explanation');
  }

  return explanation;
}

export async function generateDiagram(prompt) {
  const shapes = await callGeminiForShapes(`${PROMPT_INSTRUCTIONS}\n\nUser request: ${prompt}`);

  if (shapes.length === 0) {
    throw new Error('AI did not return any usable shapes');
  }

  return shapes;
}
