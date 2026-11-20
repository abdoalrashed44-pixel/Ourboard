import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import { layoutDiagram } from './layoutDiagram.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// What a converted sketch may contain — the board's own shape types
const SKETCH_SHAPE_TYPES = ['rect', 'circle', 'pill', 'diamond', 'parallelogram', 'cylinder', 'actor', 'arrow', 'line', 'text'];
// Same palette the frontend's style menus use, so AI-generated shapes stay visually consistent
const PALETTE = ['#FFFFFF', '#FFD60A', '#64D2FF', '#32D74B', '#FF9F0A'];

// Gemini "thinks" privately before answering unless told not to. Measured on this app:
// Generate went from ~64 s to ~12 s and Explain from ~6 s to ~3 s with thinking at minimal
const MINIMAL_THINKING = { thinkingConfig: { thinkingLevel: 'minimal' } };

// Generate asks the AI only for a diagram's *content*: its steps and how they connect.
// layoutDiagram.js then works out every position, so the drawing is tidy every time
const DIAGRAM_PROMPT = `You design diagrams for a collaborative whiteboard. Turn the user's request into the CONTENT of one diagram: its nodes and the edges between them. Do not give positions or sizes — the app lays the diagram out itself.

Choose "kind":
- "usecase" for use case diagrams (UML): actors and what they can do with a system.
- "flowchart" for everything else: processes, algorithms, workflows, and general box-and-arrow diagrams such as system architectures.

Flowchart rules:
- Exactly one node of type "start" labelled "Start", and at least one node of type "end" labelled "End".
- "process" for an action, "decision" for a yes/no question (its label ends with "?"), "io" for input or output (e.g. "Enter email and password"), "database" for stored data.
- Every decision has exactly two outgoing edges, labelled "Yes" and "No".
- Edges use style "flow" and point the way the process moves. A step that repeats points back to an earlier node.

Use case rules:
- "actor" nodes are people or outside systems, labelled with a role ("Student", "Admin").
- "usecase" nodes are goals, labelled starting with a verb ("Borrow book").
- "title" is the system's name.
- Connect each actor to the use cases it performs with style "association", from the actor to the use case.
- Use style "include" (from a use case to one it always includes) and "extend" (from an optional use case to the one it extends) only where they genuinely apply.

Labels are short: 2 to 6 words. Use at most 25 nodes. Every edge's "from" and "to" must be ids of listed nodes.`;

// The exact answer shape Gemini must fill in. Giving it this template means it can't
// reply with prose, a different structure or unknown node types. No list-length limits
// here: Google rejects templates whose nested lists have them ("too many states"), so the
// 25-node / 40-edge caps are enforced by cleanDiagram instead
const DIAGRAM_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['flowchart', 'usecase'] },
    title: { type: 'string', description: 'Use case diagrams: the system name. Flowcharts: empty string.' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['start', 'end', 'process', 'decision', 'io', 'database', 'actor', 'usecase'] },
          label: { type: 'string' },
        },
        required: ['id', 'type', 'label'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
          style: { type: 'string', enum: ['flow', 'association', 'include', 'extend'] },
        },
        required: ['from', 'to', 'style'],
      },
    },
  },
  required: ['kind', 'nodes', 'edges'],
};

const NODE_TYPES = {
  flowchart: ['start', 'end', 'process', 'decision', 'io', 'database'],
  usecase: ['actor', 'usecase'],
};
const EDGE_STYLES = ['flow', 'association', 'include', 'extend'];

const cleanLabel = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');

// The schema makes Gemini's answer the right shape, but the content still isn't trusted:
// drop node types that don't belong to this kind of diagram, repeated ids, and edges that
// point at nodes which don't exist or loop straight back to the same node
function cleanDiagram(raw) {
  if (!raw || !NODE_TYPES[raw.kind]) throw new Error('AI did not return a flowchart or use case diagram');

  const nodes = [];
  const ids = new Set();
  for (const node of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const id = String(node?.id ?? '').trim();
    if (!id || ids.has(id) || !NODE_TYPES[raw.kind].includes(node.type)) continue;
    ids.add(id);
    nodes.push({ id, type: node.type, label: cleanLabel(node.label) });
    if (nodes.length === 25) break;
  }
  if (nodes.length === 0) throw new Error('AI did not return any usable steps');
  if (raw.kind === 'usecase' && !nodes.some((n) => n.type === 'usecase')) {
    throw new Error('AI did not return any use cases');
  }

  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .map((e) => ({
      from: String(e?.from ?? ''),
      to: String(e?.to ?? ''),
      label: cleanLabel(e?.label),
      style: EDGE_STYLES.includes(e?.style) ? e.style : 'flow',
    }))
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .slice(0, 40);

  return { kind: raw.kind, title: cleanLabel(raw.title), nodes, edges };
}

// Gemini's reply text as JSON, with a clear error if it isn't JSON at all
function parseAiJson(result) {
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error('AI did not return valid JSON');
  }
}

// Turns whatever Gemini returns into shapes that actually match our schema — AI output
// is never trusted as-is, every field gets checked or replaced with a safe default
function sanitizeShape(raw) {
  if (!raw || !SKETCH_SHAPE_TYPES.includes(raw.type)) return null;

  const stroke = PALETTE.includes(raw.stroke) ? raw.stroke : PALETTE[0];
  const isPath = raw.type === 'line' || raw.type === 'arrow';
  const numbers = Array.isArray(raw.points) ? raw.points.map(Number).filter((n) => !Number.isNaN(n)) : [];
  const points = numbers.slice(0, numbers.length - (numbers.length % 2)); // whole x,y pairs only
  if (isPath && points.length < 4) return null; // a line or arrow needs a start and an end

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
    points: isPath ? points : [],
    text: cleanLabel(raw.text),
    fontSize: raw.type === 'arrow' ? 14 : 18,
    ...(raw.type === 'arrow' && { dashed: false }),
    createdBy: 'ai',
  };
}

// Vision prompt for turning a rough hand-drawn sketch into clean shapes. Unlike Generate,
// the AI does give coordinates here, because a converted sketch must stay where it was drawn
const SKETCH_PROMPT = (width, height) => `You are converting a rough hand-drawn sketch into a clean diagram for a collaborative whiteboard app.
The attached image is ${width}x${height} pixels, showing thin freehand strokes and rough handwriting on a black background.
Work out what the user was trying to draw and redraw it tidily, keeping everything roughly where it was drawn:
- A box-like scribble is "rect"; a box with fully rounded ends is "pill"; a round scribble is "circle"; a diamond is "diamond"; a slanted box is "parallelogram"; a can shape is "cylinder"; a stick figure is "actor".
- A stroke with an arrowhead is "arrow"; a plain connecting stroke is "line". Give their "points" as [startX, startY, endX, endY], with an arrow's tip at the end.
- Handwriting INSIDE a shape is that shape's "text" label — never a separate text shape. Handwriting under a stick figure is the actor's "text". Handwriting along an arrow is the arrow's "text".
- Only handwriting that isn't inside or next to any shape becomes its own "text" shape.

Rules:
- Use the image's own pixel coordinates: x from 0 to ${width}, y from 0 to ${height}. x and y are the top-left corner of the shape's box.
- Straighten the wobbly strokes into tidy shapes — don't copy the rough points.
- "stroke" is the palette colour closest to the sketch's colour.
- At most 20 shapes.`;

// The answer template for Convert: a list of shapes using only the board's shape types
const SKETCH_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: SKETCH_SHAPE_TYPES },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
      stroke: { type: 'string', enum: PALETTE },
      text: { type: 'string' },
      points: { type: 'array', items: { type: 'number' } },
    },
    required: ['type', 'x', 'y', 'width', 'height'],
  },
};

export async function convertSketch({ imageBase64, mimeType, width, height }) {
  const result = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [
      { text: SKETCH_PROMPT(width, height) },
      { inlineData: { mimeType, data: imageBase64 } },
    ],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: SKETCH_SCHEMA,
      ...MINIMAL_THINKING,
    },
  });

  const parsed = parseAiJson(result);
  if (!Array.isArray(parsed)) throw new Error('AI response was not a list of shapes');

  const shapes = parsed.map(sanitizeShape).filter(Boolean).slice(0, 20);
  if (shapes.length === 0) throw new Error('AI could not identify any shapes in the sketch');
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
    config: MINIMAL_THINKING,
  });

  const explanation = result.text?.trim();
  if (!explanation) {
    throw new Error('AI did not return an explanation');
  }

  return explanation;
}

// Asks the AI for the diagram's content, checks it, then lays it out as board shapes
export async function generateDiagram(prompt) {
  const result = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: `${DIAGRAM_PROMPT}\n\nUser request: ${prompt}`,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: DIAGRAM_SCHEMA,
      ...MINIMAL_THINKING,
    },
  });

  return layoutDiagram(cleanDiagram(parseAiJson(result)));
}
