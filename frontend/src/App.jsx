import { useEffect, useState, useRef } from 'react';
import Konva from 'konva';
import { Stage, Layer, Group, Rect, Ellipse, Line, Text, Circle, Arrow, Shape, Transformer } from 'react-konva';
import { socket } from './socket';
import BoardImage from './BoardImage.jsx';
import './App.css';

// "shapes" isn't a tool itself — it's the dropdown button holding every SHAPE_TOOLS entry.
// The "line" button also holds the highlighter, chosen inside its menu
const TOOLS = ["select", "hand", "shapes", "line", "sticky", "text", "eraser"];

// Sticky notes are always this yellow, with dark text, like a paper sticky note
const STICKY_YELLOW = "#FDE29A";
const STICKY_TEXT = "#333333";

// Everything in the Shapes dropdown, grouped by diagram, with what each shape means.
// "dashedArrow" is a tool only: it draws a normal arrow shape with dashed: true
const SHAPE_TOOLS = [
  { group: "Flowchart", type: "rect", label: "Rectangle", hint: "Process step" },
  { group: "Flowchart", type: "circle", label: "Circle", hint: "" },
  { group: "Flowchart", type: "pill", label: "Pill", hint: "Start / End" },
  { group: "Flowchart", type: "diamond", label: "Diamond", hint: "Decision" },
  { group: "Flowchart", type: "parallelogram", label: "Parallelogram", hint: "Input / Output" },
  { group: "Flowchart", type: "cylinder", label: "Cylinder", hint: "Database" },
  { group: "Flowchart", type: "arrow", label: "Arrow", hint: "Flow direction" },
  { group: "Use case diagram", type: "actor", label: "Actor", hint: "User / system" },
  { group: "Use case diagram", type: "usecase", label: "Use case", hint: "Action (oval)" },
  { group: "Use case diagram", type: "boundary", label: "System boundary", hint: "Frame + title" },
  { group: "Use case diagram", type: "dashedArrow", label: "Dashed arrow", hint: "«include» / «extend»" },
  { group: "Table", type: "table", label: "Table", hint: "Rows × columns" },
];

// Shapes drawn by dragging out a box, each a Group of outline + label (a table draws its
// grid of cells instead of one label)
const BOX_TYPES = ["rect", "circle", "pill", "diamond", "parallelogram", "cylinder", "actor", "usecase", "boundary", "sticky", "table"];

// A table's text lives in its `cells` field: one list per row, one text per cell. Every
// column is equally wide and every row equally tall, so the grid is just the table's size
// divided up — no per-cell sizes to store or keep in sync
const TABLE_START = { rows: 3, cols: 3 };
const TABLE_MAX_LINES = 10; // the most rows, and the most columns
// However small a table is dragged out, each cell gets at least this much room
const TABLE_MIN_CELL = { width: 60, height: 32 };

function emptyCells(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(""));
}

// Shapes an arrow or line can attach to. A system boundary is left out: it's a frame
// around other shapes, not something you connect to
const ATTACHABLE_TYPES = BOX_TYPES.filter((t) => t !== "boundary");

// The freehand tool's shapes are stored as type "line", but the button says "Marker"
const TOOL_LABELS = { line: "marker" };

// Single-key shortcuts, pressed without Ctrl so that Ctrl+V can still mean paste
const SHORTCUT_KEYS = { select: "V", hand: "H", line: "M" };

// Zoom limits: 0.25 = 25%, 4 = 400%. Zoom is per-user and never sent over the socket
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

// Pictures travel inside their shape as text (a "data URL"), and auto-save sends the whole
// board each time — so each picture is shrunk in the browser first, and a board holds only
// a few. Worst case: 10 × 300 KB = 3 MB per save, inside the server's 8 MB message limit
const MAX_IMAGE_SIDE = 1000; // pixels, on the picture's longest side
const MAX_IMAGE_BYTES = 300 * 1024; // a data URL is plain text, so 1 character = 1 byte
const MAX_IMAGES_PER_BOARD = 10;
// How big a new picture first appears on the board (it can be resized from there)
const IMAGE_START_SIZE = 400;
const RESIZE_ALL_SIDES = ["top-left", "top-center", "top-right", "middle-right", "middle-left", "bottom-left", "bottom-center", "bottom-right"];
// Pictures resize from the corners only, which keeps their proportions
const RESIZE_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];

// Reads a picture file and shrinks it: at most MAX_IMAGE_SIDE pixels on its longest side,
// saved as a JPEG, lowering the quality step by step until it fits MAX_IMAGE_BYTES.
// Resolves to { src, width, height }, where src is the shrunk picture as a data URL
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const fileUrl = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(fileUrl);
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      // JPEG can't store see-through pixels, so paint them black: the board's own colour
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.6, 0.4]) {
        const src = canvas.toDataURL("image/jpeg", quality);
        if (src.length <= MAX_IMAGE_BYTES) {
          resolve({ src, width: canvas.width, height: canvas.height });
          return;
        }
      }
      reject(new Error("That picture is too detailed — try a smaller one"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(fileUrl);
      reject(new Error("That file isn't a picture the browser can open"));
    };
    img.src = fileUrl;
  });
}

// Five colors chosen to stay readable against the black canvas background — shared by
// every tool (rect/circle/line stroke, and text)
const PALETTE = ["#FFFFFF", "#FFD60A", "#64D2FF", "#32D74B", "#FF9F0A"];

// A shape's bounding box in canvas coordinates — used by both the eraser (does the eraser
// circle overlap this shape?) and the marquee select (is this shape inside the drag box?).
// Lines don't have a meaningful width/height, so their box comes from their actual points.
function getShapeBounds(shape) {
  if (shape.type === "line" || shape.type === "arrow") {
    // A plain loop instead of Math.min(...points) — spreading a long freehand line's
    // points into a function call gets expensive fast, and this runs on every shape,
    // every mousemove, while erasing
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < shape.points.length; i += 2) {
      const x = shape.points[i];
      const y = shape.points[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  return {
    x: Math.min(shape.x, shape.x + shape.width),
    y: Math.min(shape.y, shape.y + shape.height),
    width: Math.abs(shape.width),
    height: Math.abs(shape.height),
  };
}

// How big a piece of text will be when drawn, so an arrow's label can be centred on the
// arrow with a background box exactly its size
function measureText(text, fontSize) {
  const node = new Konva.Text({ text, fontSize });
  const size = { width: node.width(), height: node.height() };
  node.destroy();
  return size;
}

// Where an arrow's label goes: the middle of its middle segment. A hand-drawn arrow has one
// segment; an AI arrow routed around other shapes has three
function getArrowLabelPoint(points) {
  const segments = points.length / 2 - 1;
  const i = Math.floor((segments - 1) / 2) * 2; // where the middle segment's first point starts
  return { x: (points[i] + points[i + 2]) / 2, y: (points[i + 1] + points[i + 3]) / 2 };
}

// Where a box shape's label goes, inside the shape's own box (0,0 = its top-left corner).
// Most shapes use the whole box; a few need a smaller area so text stays inside the outline
function getLabelArea(type, width, height) {
  if (type === "diamond") return { x: width * 0.2, y: 0, width: width * 0.6, height };
  // Ovals: pull the text in from the sides so it doesn't cross the curved edge
  if (type === "circle" || type === "usecase") return { x: width * 0.12, y: 0, width: width * 0.76, height };
  // A system boundary's title sits along its top edge, leaving the inside free
  if (type === "boundary") return { x: 0, y: 0, width, height: Math.min(36, height) };
  // An actor's name goes under the stick figure, a bit wider than the figure itself
  if (type === "actor") return { x: -30, y: height * 0.78, width: width + 60, height: Math.max(height * 0.22, 28) };
  if (type === "parallelogram") {
    const slant = getParallelogramSlant(width, height);
    return { x: slant, y: 0, width: width - slant * 2, height };
  }
  if (type === "cylinder") {
    const lid = getCylinderLid(width, height);
    return { x: 0, y: lid * 2, width, height: height - lid * 2 };
  }
  return { x: 0, y: 0, width, height };
}

// How far a parallelogram's top edge is pushed right compared with its bottom edge
function getParallelogramSlant(width, height) {
  return Math.min(width * 0.25, height * 0.5);
}

// Height of the oval "lid" on top of a cylinder (and of the curve at its bottom)
function getCylinderLid(width, height) {
  return Math.min(height * 0.15, width * 0.25);
}

// The visible outline of a box shape, drawn inside its Group from 0,0 to width,height.
// `style` carries the colour, thickness and selection glow
function renderOutline(type, width, height, style) {
  switch (type) {
    case "sticky":
      // Solid yellow paper with no border; `style` still brings the selection glow
      return <Rect width={width} height={height} {...style} fill={STICKY_YELLOW} stroke={undefined} cornerRadius={4} />;
    case "circle":
    case "usecase":
      return <Ellipse x={width / 2} y={height / 2} radiusX={width / 2} radiusY={height / 2} {...style} />;
    case "boundary":
      // fillEnabled={false} gives the frame no "inside" at all — Konva's click detection
      // would otherwise treat the whole box as solid even with no fill colour. So clicks and
      // drag-selections inside it reach the use cases; the frame itself is picked up by its
      // border (made 12px wide for clicking) or its title
      return <Rect width={width} height={height} {...style} fillEnabled={false} hitStrokeWidth={12} />;
    case "actor": {
      // A stick figure in the top three-quarters of the box. The invisible Rect behind it
      // makes the whole figure clickable, not just its thin lines
      const figure = height * 0.75;
      const head = Math.min(width * 0.25, figure * 0.15);
      const hips = figure * 0.62;
      return (
        <>
          <Rect width={width} height={height} fill="transparent" />
          <Shape
            {...style}
            sceneFunc={(context, node) => {
              const middle = width / 2;
              context.beginPath();
              context.arc(middle, head, head, 0, Math.PI * 2); // head
              context.moveTo(middle, head * 2);
              context.lineTo(middle, hips); // body
              context.moveTo(width * 0.1, figure * 0.35);
              context.lineTo(width * 0.9, figure * 0.35); // arms
              context.moveTo(middle, hips);
              context.lineTo(width * 0.15, figure); // left leg
              context.moveTo(middle, hips);
              context.lineTo(width * 0.85, figure); // right leg
              context.strokeShape(node);
            }}
          />
        </>
      );
    }
    case "pill":
      // Rounding the corners by half the shorter side makes the ends fully round
      return <Rect width={width} height={height} cornerRadius={Math.min(width, height) / 2} {...style} />;
    case "diamond":
      // Four corner points: top-middle, right-middle, bottom-middle, left-middle
      return <Line points={[width / 2, 0, width, height / 2, width / 2, height, 0, height / 2]} closed {...style} />;
    case "parallelogram": {
      const slant = getParallelogramSlant(width, height);
      return <Line points={[slant, 0, width, 0, width - slant, height, 0, height]} closed {...style} />;
    }
    case "cylinder": {
      // Konva has no cylinder, so draw one by hand: two straight sides, a curved bottom
      // edge, and a full oval lid on top
      const lid = getCylinderLid(width, height);
      return (
        <Shape
          {...style}
          sceneFunc={(context, node) => {
            context.beginPath();
            context.moveTo(0, lid);
            context.lineTo(0, height - lid);
            context.ellipse(width / 2, height - lid, width / 2, lid, 0, Math.PI, 0, true);
            context.lineTo(width, lid);
            context.ellipse(width / 2, lid, width / 2, lid, 0, 0, Math.PI * 2);
            context.fillStrokeShape(node);
          }}
        />
      );
    }
    default:
      return <Rect width={width} height={height} {...style} />;
  }
}

// Where a straight line from the middle of a box shape towards point (px, py) crosses the
// shape's outline — so a connector stops exactly at the edge, whatever the shape
function outlinePoint(type, box, px, py) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  let t;
  if (type === "circle" || type === "usecase") {
    t = 1 / Math.sqrt((dx * dx) / (halfW * halfW) + (dy * dy) / (halfH * halfH));
  } else if (type === "diamond") {
    t = 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH);
  } else {
    // Every other shape counts as its box. Dividing by a 0 dx or dy gives Infinity,
    // which Math.min then simply ignores
    t = Math.min(halfW / Math.abs(dx), halfH / Math.abs(dy));
  }
  return [cx + dx * t, cy + dy * t];
}

// A connector's start and end points. Each end is either attached to a shape
// ({ type, box }) — then it sits where the connector crosses that shape's outline — or a
// free point ({ point: [x, y] }) that stays where it is
function connectorPoints(fromEnd, toEnd) {
  const middle = (end) => end.point || [end.box.x + end.box.width / 2, end.box.y + end.box.height / 2];
  const [fromX, fromY] = middle(fromEnd);
  const [toX, toY] = middle(toEnd);
  const start = fromEnd.point || outlinePoint(fromEnd.type, fromEnd.box, toX, toY);
  const end = toEnd.point || outlinePoint(toEnd.type, toEnd.box, fromX, fromY);
  return [...start, ...end];
}

// The smallest box that fits around every shape in a list
function boundsOfShapes(list) {
  const boxes = list.map(getShapeBounds);
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// A copy of a shape moved by dx, dy — its position and, for lines and arrows, every point
function moveShape(shape, dx, dy) {
  return {
    ...shape,
    x: shape.x + dx,
    y: shape.y + dy,
    points: shape.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
  };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// True when box `inner` lies completely inside box `outer`
function rectContains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

// Splits a line's points at whatever falls inside the eraser circle, keeping the parts
// outside it. Each surviving run of consecutive points becomes its own sub-line — this is
// what makes the eraser trim a stroke instead of deleting the whole thing.
function eraseLinePoints(points, pos, radius) {
  const runs = [];
  let current = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const touched = Math.hypot(x - pos.x, y - pos.y) <= radius;
    if (touched) {
      if (current.length >= 4) runs.push(current); // need at least 2 points to keep a line
      current = [];
    } else {
      current.push(x, y);
    }
  }
  if (current.length >= 4) runs.push(current);
  return runs;
}

// Defends against duplicate ids in a loaded board — e.g. ones that got saved to MongoDB
// before the shape:add dedupe guard existed. Keeps the last copy of any repeated id.
function dedupeShapes(list) {
  const byId = new Map();
  list.forEach((shape) => byId.set(shape.id, shape));
  return [...byId.values()];
}

// Small reusable color + thickness picker, used both by the Line tool's pre-draw menu
// and a shape's post-placement menu
function StyleMenu({ color, thickness, onPickColor, onPickThickness }) {
  return (
    <>
      <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
        {PALETTE.map((c) => (
          <button
            key={c}
            onClick={() => onPickColor(c)}
            title={c}
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              background: c,
              border: color === c ? "2px solid white" : "1px solid #666",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <input
          type="range"
          min="1"
          max="20"
          step="1"
          value={thickness}
          onChange={(e) => onPickThickness(Number(e.target.value))}
          style={{ width: "110px", cursor: "pointer" }}
        />
        <span style={{ color: "#ccc", fontSize: "12px", width: "28px" }}>{thickness}px</span>
      </div>
    </>
  );
}

// The whiteboard for one board. Root shows it once the server has let the user into a
// board: boardId is that board's name, initialShapes its saved drawing, userId who's
// drawing (recorded in each new shape's createdBy), and onLeaveBoard goes back to the list
function App({ boardId, initialShapes, userId, onLeaveBoard }) {
  // "connected" | "reconnecting" | "disconnected" — starting from the socket's real state
  const [connectionStatus, setConnectionStatus] = useState(socket.connected ? "connected" : "disconnected");
  const hasDisconnectedOnce = useRef(false);
  const [shapes, setShapes] = useState(() => dedupeShapes(initialShapes));
  const [tool, setTool] = useState("rect");
  // A Set of shape ids, file-explorer style: plain click replaces it, Ctrl/Cmd/Shift-click
  // toggles one id in or out, drag-select (marquee) replaces or adds a whole batch at once
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Style new rect/circle/line shapes are drawn with — changed via either style menu below
  const [drawColor, setDrawColor] = useState(PALETTE[0]);
  const [drawThickness, setDrawThickness] = useState(2);
  const [showLineMenu, setShowLineMenu] = useState(false);
  const [showShapesMenu, setShowShapesMenu] = useState(false);
  const [eraserSize, setEraserSize] = useState(24);
  const [showEraserMenu, setShowEraserMenu] = useState(false);
  const [eraserPos, setEraserPos] = useState(null);
  // { shapeId, x, y, color, thickness } while a just-placed shape's style menu is open
  const [shapeMenu, setShapeMenu] = useState(null);
  // While set, a resizable text box overlay is open at this position/size/color
  const [textEditor, setTextEditor] = useState(null);
  // Brief "Board saved" / "Save failed: ..." message shown near the toolbar
  const [saveStatus, setSaveStatus] = useState(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  // The live drag-select rectangle while it's being dragged out, for rendering only
  const [marquee, setMarquee] = useState(null);
  const isDrawing = useRef(false);
  const drawingShapeId = useRef(null);
  const isErasing = useRef(false);
  // While erasing: what's changed so far this drag, so the network only hears about it once,
  // at the end, instead of on every mousemove
  const eraseSession = useRef(null);
  const lastErasePos = useRef(null);
  const textareaRef = useRef(null);
  // Shapes *this* client created, in order, so Undo/Redo only affects your own work.
  // Undoing pops from undoStack onto redoStack, and vice versa; drawing something new
  // clears redoStack, same as browser back/forward history
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const shapeRefs = useRef({});
  const trRef = useRef(null);
  const stageRef = useRef(null);
  const [convertingSketch, setConvertingSketch] = useState(false);
  const [explaining, setExplaining] = useState(false);
  // { text } while the AI-explanation panel is open, null when closed
  const [explainPanel, setExplainPanel] = useState(null);
  const lineMenuRef = useRef(null);
  const shapesMenuRef = useRef(null);
  // The hidden file picker behind the Image button
  const imageInputRef = useRef(null);
  const eraserMenuRef = useRef(null);
  const shapeMenuRef = useRef(null);
  // Tool that was active before the user started holding Ctrl, so releasing it restores it
  const preSelectTool = useRef(null);
  // Trails behind the raw cursor position while drawing a line — this is what smooths
  // freehand strokes and gives them a slight, deliberate lag
  const smoothPos = useRef({ x: 0, y: 0 });
  const stageContainerRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  // This user's camera over the board: scale is the zoom level, x/y is how far the whole
  // board has been dragged by the Hand tool. Shapes keep their real coordinates; only the
  // view moves, which is why none of this is synced to other users
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  // Marquee-select bookkeeping: where the drag started, and whether it should ADD to the
  // current selection (Ctrl/Shift held) rather than replace it
  const marqueeStart = useRef(null);
  const marqueeAdditive = useRef(false);
  // While dragging one shape that's part of a multi-selection, holds every selected
  // shape's on-screen position at the moment the drag started, so the others can be
  // moved by the same live delta
  const groupDragStart = useRef({});
  // All shapes as they were when the current drag started. Connectors are recalculated
  // from these on every drag step, so the steps don't add up on top of each other
  const dragBase = useRef(null);

  // The canvas fills whatever space is left below the header/toolbar — measure that
  // space directly rather than guessing fixed pixel numbers, so it adapts to any screen
  useEffect(() => {
    const updateCanvasSize = () => {
      if (!stageContainerRef.current) return;
      setCanvasSize({
        width: stageContainerRef.current.offsetWidth,
        height: stageContainerRef.current.offsetHeight,
      });
    };
    updateCanvasSize();
    window.addEventListener("resize", updateCanvasSize);
    return () => window.removeEventListener("resize", updateCanvasSize);
  }, []);

  useEffect(() => {
    socket.on("connect", () => {
      setConnectionStatus("connected");
      if (!hasDisconnectedOnce.current) return; // first-ever connect, nothing to recover from
      // socket.recovered tells us whether Socket.IO's connection state recovery managed to
      // replay whatever shape events we missed while offline
      if (socket.recovered) {
        flashStatus("Reconnected — you're back in sync");
        return;
      }
      // It didn't (offline too long, or the server restarted), so the server has forgotten
      // which board we were on. Open it again — as its owner or a member no password is
      // needed — and take its saved shapes, so we're properly back in sync
      socket.emit("board:join", { name: boardId }, (response) => {
        if (!response.success) {
          onLeaveBoard(response.error);
          return;
        }
        setShapes(dedupeShapes(response.shapes));
        flashStatus("Reconnected — you're back in sync");
      });
    });
    socket.on("disconnect", () => {
      setConnectionStatus("disconnected");
      hasDisconnectedOnce.current = true;
    });
    // Reconnection-attempt events live on the Manager (socket.io), not the socket itself
    socket.io.on("reconnect_attempt", () => setConnectionStatus("reconnecting"));

    // Another user finished drawing a shape — add it to our canvas too. Guard against
    // duplicates (e.g. a stray extra listener from a dev-server hot-reload) so the same
    // id never ends up in the list twice
    socket.on("shape:add", (shape) => {
      setShapes((prev) => (prev.some((s) => s.id === shape.id) ? prev : [...prev, shape]));
    });

    // Another user moved, resized, or re-edited a shape
    socket.on("shape:update", (shape) => {
      setShapes((prev) => prev.map((s) => (s.id === shape.id ? shape : s)));
    });

    // A shape was undone/erased/removed somewhere else
    socket.on("shape:delete", ({ id }) => {
      setShapes((prev) => prev.filter((s) => s.id !== id));
    });

    // Someone else clicked Load — replace our whole board with the one they loaded
    socket.on("board:sync", (loadedShapes) => {
      setShapes(dedupeShapes(loadedShapes));
      setUndoStack([]);
      setRedoStack([]);
      setSelectedIds(new Set());
    });

    // The owner deleted this board while we were on it — back to the boards list
    socket.on("board:deleted", () => onLeaveBoard("That board was deleted by its owner"));

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.io.off("reconnect_attempt");
      socket.off("shape:add");
      socket.off("shape:update");
      socket.off("shape:delete");
      socket.off("board:sync");
      socket.off("board:deleted");
    };
  }, [boardId, onLeaveBoard]);

  // Auto-save: persist the board a moment after any change settles, so anyone opening it
  // later always finds what's already been drawn, without someone remembering to click
  // Save. The whiteboard only appears once the board's saved shapes have arrived, so there's
  // no risk of saving an empty board over a real one
  useEffect(() => {
    const timeout = setTimeout(() => {
      socket.emit("board:save", shapes, () => {});
    }, 800);
    return () => clearTimeout(timeout);
  }, [shapes]);

  // Attach the resize handles, but only when exactly one resizable shape (a box shape or
  // text) is selected. Multiple shapes, a line or an arrow just get the selection glow.
  useEffect(() => {
    if (!trRef.current) return;
    if (selectedIds.size !== 1) {
      trRef.current.nodes([]);
      trRef.current.getLayer()?.batchDraw();
      return;
    }
    const id = [...selectedIds][0];
    const shape = shapes.find((s) => s.id === id);
    const canResize = shape && (BOX_TYPES.includes(shape.type) || shape.type === "text" || shape.type === "image");
    trRef.current.nodes(canResize && shapeRefs.current[id] ? [shapeRefs.current[id]] : []);
    trRef.current.getLayer()?.batchDraw();
  }, [selectedIds, shapes]);

  // Close the line/eraser/shape style menus on any click outside them
  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (showLineMenu && lineMenuRef.current && !lineMenuRef.current.contains(e.target)) {
        setShowLineMenu(false);
      }
      if (showShapesMenu && shapesMenuRef.current && !shapesMenuRef.current.contains(e.target)) {
        setShowShapesMenu(false);
      }
      if (showEraserMenu && eraserMenuRef.current && !eraserMenuRef.current.contains(e.target)) {
        setShowEraserMenu(false);
      }
      if (shapeMenu && shapeMenuRef.current && !shapeMenuRef.current.contains(e.target)) {
        setShapeMenu(null);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showLineMenu, showShapesMenu, showEraserMenu, shapeMenu]);

  // Every undoable action is stored as a "diff": the shapes it removed and the shapes it
  // added. Undo reverses the diff (delete what was added, restore what was removed); Redo
  // re-applies it forward. This one mechanism covers drawing a shape (added: [shape]),
  // deleting a selection (removed: [...]), and erasing part of a line (removed: [original
  // line], added: [the trimmed pieces]) without needing a special case for each.
  const applyDiff = (removed, added) => {
    const removedIds = new Set(removed.map((s) => s.id));
    setShapes((prev) => [...prev.filter((s) => !removedIds.has(s.id)), ...added]);
    removed.forEach((s) => socket.emit("shape:delete", { id: s.id }));
    added.forEach((s) => socket.emit("shape:add", s));
    setSelectedIds((prev) => {
      if (![...removedIds].some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      removedIds.forEach((id) => next.delete(id));
      return next;
    });
  };

  const pushUndo = (removed, added) => {
    setUndoStack((prev) => [...prev, { removed, added }]);
    setRedoStack([]);
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const action = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, action]);
    applyDiff(action.added, action.removed); // reverse: delete what it added, restore what it removed,applyDiff tells all users about the updates. 
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const action = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, action]);
    applyDiff(action.removed, action.added); // forward: reapply it exactly as it happened
  };

  // Removes every currently-selected shape at once — now goes through the same undo history
  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    const removed = shapes.filter((s) => selectedIds.has(s.id));
    applyDiff(removed, []);
    pushUndo(removed, []);
  };

  // Brief "Saved" / "Save failed" style message that clears itself after a couple seconds
  const flashStatus = (message) => {
    setSaveStatus(message);
    setTimeout(() => setSaveStatus(null), 2500);
  };

  const handleSave = () => {
    socket.emit("board:save", shapes, (response) => {
      flashStatus(response.success ? "Board saved" : `Save failed: ${response.error}`);
    });
  };

  const handleLoad = () => {
    socket.emit("board:load", (response) => {
      if (response.success) {
        setShapes(dedupeShapes(response.shapes));
        setUndoStack([]);
        setRedoStack([]);
        setSelectedIds(new Set());
        flashStatus("Board loaded");
      } else {
        flashStatus(`Load failed: ${response.error}`);
      }
    });
  };

  // Back to the boards list. Save first so nothing from the last 800 ms (the auto-save
  // delay) is lost, then tell the server to stop sending this board's live updates
  const handleLeaveBoard = () => {
    socket.emit("board:save", shapes, () => {});
    socket.emit("board:leave");
    onLeaveBoard();
  };

  // The server lays a generated diagram out around 0,0. This moves it into empty space —
  // to the right of everything already on the board, or the middle of the screen if the
  // board is empty — and slides the view over (zooming out if needed) so all of it shows
  const placeInEmptySpace = (newShapes) => {
    const diagram = boundsOfShapes(newShapes);
    let left;
    let top;
    if (shapes.length > 0) {
      const existing = boundsOfShapes(shapes);
      left = existing.x + existing.width + 150;
      top = existing.y;
    } else {
      left = (canvasSize.width / 2 - view.x) / view.scale - diagram.width / 2;
      top = (canvasSize.height / 2 - view.y) / view.scale - diagram.height / 2;
    }
    const fitScale = Math.min((canvasSize.width * 0.9) / diagram.width, (canvasSize.height * 0.8) / diagram.height);
    const scale = Math.max(MIN_ZOOM, Math.min(view.scale, fitScale));
    setView({
      scale,
      x: canvasSize.width / 2 - (left + diagram.width / 2) * scale,
      y: canvasSize.height / 2 - (top + diagram.height / 2) * scale,
    });
    return newShapes.map((s) => moveShape(s, left - diagram.x, top - diagram.y));
  };

  const handleGenerate = () => {
    if (!aiPrompt.trim() || generating) return;
    setGenerating(true);
    socket.emit("board:generate", aiPrompt, (response) => {
      setGenerating(false);
      if (!response.success) {
        flashStatus(`Generation failed: ${response.error}`);
        return;
      }
      const placed = placeInEmptySpace(response.shapes);
      // applyDiff adds the shapes here and sends shape:add to everyone else, like any edit
      applyDiff([], placed);
      pushUndo([], placed);
      // Select the whole new diagram, so one drag moves all of it
      setTool("select");
      setSelectedIds(new Set(placed.map((s) => s.id)));
      setAiPrompt("");
      flashStatus(`Generated ${placed.length} shape${placed.length === 1 ? "" : "s"}`);
    });
  };

  // Crops the given shapes to a PNG, temporarily hiding everything else and the
  // Transformer handles so they don't end up in the image. Shared by sketch-conversion
  // and AI explain, which both need "just this selection, as a picture" to hand to Gemini.
  // Returns null if the selection has no area (e.g. would only happen for an empty list).
  const captureShapesImage = (selected) => {
    const bounds = selected.map(getShapeBounds);
    const left = Math.min(...bounds.map((b) => b.x));
    const top = Math.min(...bounds.map((b) => b.y));
    const right = Math.max(...bounds.map((b) => b.x + b.width));
    const bottom = Math.max(...bounds.map((b) => b.y + b.height));
    const width = Math.ceil(right - left);
    const height = Math.ceil(bottom - top);
    if (width <= 0 || height <= 0) return null;

    const selectedIdSet = new Set(selected.map((s) => s.id));
    const stage = stageRef.current;
    const hiddenIds = shapes.filter((s) => !selectedIdSet.has(s.id)).map((s) => s.id);
    hiddenIds.forEach((id) => shapeRefs.current[id]?.hide());
    trRef.current?.hide();
    stage.batchDraw();
    // Take the picture at 100% zoom with no panning, so left/top/width/height (board units)
    // match the image's pixels exactly — then put this user's view straight back
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    const shapesCanvas = stage.toCanvas({ x: left, y: top, width, height, pixelRatio: 1 });
    stage.scale({ x: view.scale, y: view.scale });
    stage.position({ x: view.x, y: view.y });
    hiddenIds.forEach((id) => shapeRefs.current[id]?.show());
    trRef.current?.show();
    stage.batchDraw();

    // Paint the shapes onto solid black: most strokes are white, which the AI couldn't
    // see on a transparent background
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(shapesCanvas, 0, 0);
    const dataUrl = output.toDataURL("image/png");

    return { imageBase64: dataUrl.split(",")[1], mimeType: "image/png", width, height, left, top };
  };

  // Sends the current selection's image to the AI and swaps the rough originals for the
  // cleaned-up result via the normal undo-tracked diff — so it syncs to other users and
  // undoes exactly like any other edit
  const handleConvertSketch = () => {
    if (selectedIds.size === 0 || convertingSketch) return;
    const selected = shapes.filter((s) => selectedIds.has(s.id));
    const capture = captureShapesImage(selected);
    if (!capture) return;
    const { left, top, ...payload } = capture;

    setConvertingSketch(true);
    socket.emit("board:convertSketch", payload, (response) => {
      setConvertingSketch(false);
      if (!response.success) {
        flashStatus(`Conversion failed: ${response.error}`);
        return;
      }
      // Shapes came back in the cropped image's own 0..width / 0..height space —
      // shift them back to where the selection actually was on the real canvas
      const moved = response.shapes.map((s) => ({ ...moveShape(s, left, top), createdBy: userId }));
      // Arrows and lines in the converted sketch attach to the shapes they touch — the new
      // ones, or anything already on the board that wasn't part of the sketch
      const candidates = [...shapes.filter((s) => !selected.includes(s)), ...moved];
      const added = moved.map((s) => (s.type === "arrow" || s.type === "line" ? attachEnds(s, candidates) : s));
      applyDiff(selected, added);
      pushUndo(selected, added);
      setSelectedIds(new Set());
      flashStatus(`Converted to ${added.length} shape${added.length === 1 ? "" : "s"}`);
    });
  };

  // Sends the current selection's image to the AI and shows the plain-language explanation
  // it comes back with in a dismissable panel. Read-only — no shapes change.
  const handleExplainSelection = () => {
    if (selectedIds.size === 0 || explaining) return;
    const selected = shapes.filter((s) => selectedIds.has(s.id));
    const capture = captureShapesImage(selected);
    if (!capture) return;

    setExplaining(true);
    socket.emit(
      "board:explainSelection",
      { imageBase64: capture.imageBase64, mimeType: capture.mimeType },
      (response) => {
        setExplaining(false);
        if (response.success) {
          setExplainPanel({ text: response.explanation });
        } else {
          flashStatus(`Explain failed: ${response.error}`);
        }
      }
    );
  };

  // Adds a picture from the clipboard or the Image button: shrinks it, then places it in
  // the middle of the screen as a new shape, selected and ready to move or resize. It goes
  // through applyDiff + pushUndo like any other new shape, so it syncs and can be undone
  const addImageFile = async (file) => {
    if (shapes.filter((s) => s.type === "image").length >= MAX_IMAGES_PER_BOARD) {
      flashStatus(`A board can hold ${MAX_IMAGES_PER_BOARD} pictures at most`);
      return;
    }
    let picture;
    try {
      picture = await shrinkImage(file);
    } catch (err) {
      flashStatus(err.message);
      return;
    }
    const fit = Math.min(1, IMAGE_START_SIZE / Math.max(picture.width, picture.height));
    const width = picture.width * fit;
    const height = picture.height * fit;
    // The middle of the screen, in board coordinates (zoom and panning undone)
    const centreX = (canvasSize.width / 2 - view.x) / view.scale;
    const centreY = (canvasSize.height / 2 - view.y) / view.scale;
    const shape = {
      id: `shape_${crypto.randomUUID()}`,
      type: "image",
      x: centreX - width / 2,
      y: centreY - height / 2,
      width,
      height,
      src: picture.src,
      stroke: "transparent",
      fill: "transparent",
      points: [],
      text: "",
      createdBy: userId,
    };
    applyDiff([], [shape]);
    pushUndo([], [shape]);
    // Pasting ends the hold-Ctrl-to-select shortcut, so letting go of Ctrl afterwards
    // doesn't switch tools and drop the new picture's selection
    preSelectTool.current = null;
    setTool("select");
    setSelectedIds(new Set([shape.id]));
  };

  // Ctrl+V with a picture on the clipboard (a screenshot, or "Copy image" in a browser)
  // puts it on the board. While typing in a text box, paste is left alone to paste text
  useEffect(() => {
    const onPaste = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      addImageFile(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, view, canvasSize]);

  // Ctrl+Z / Cmd+Z to undo, Ctrl+Shift+Z or Ctrl+Y to redo, Delete/Backspace to remove the
  // current selection — none of this while typing in the text box or the AI prompt input
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      const key = e.key.toLowerCase();
      const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && key === "z";
      const isRedo = (e.ctrlKey || e.metaKey) && ((e.shiftKey && key === "z") || key === "y");
      if (isUndo) {
        e.preventDefault();
        handleUndo();
      } else if (isRedo) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, redoStack, selectedIds]);

  const switchTool = (t) => {
    setTool(t);
    setSelectedIds(new Set());
    setShapeMenu(null);
    setEraserPos(null);
    if (t !== "line" && t !== "highlighter") setShowLineMenu(false);
    if (t !== "eraser") setShowEraserMenu(false);
    setShowShapesMenu(false);
  };

  // V / H / M switch tools — ignored while typing in a text box, and ignored with Ctrl held
  // so Ctrl+V stays "paste"
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const shortcutTool = TOOLS.find((t) => SHORTCUT_KEYS[t] === e.key.toUpperCase());
      if (!shortcutTool) return;
      switchTool(shortcutTool);
      if (shortcutTool === "line") setShowLineMenu(true); // same as clicking Marker
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Hold Ctrl to temporarily use the Select tool; releasing it restores whatever tool
  // was active before, so you don't have to keep clicking back and forth
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Control") return;
      if (document.activeElement && document.activeElement.tagName === "TEXTAREA") return;
      if (preSelectTool.current !== null) return; // already held, ignore key-repeat
      preSelectTool.current = tool;
      switchTool("select");
    };
    const onKeyUp = (e) => {
      if (e.key !== "Control") return;
      if (preSelectTool.current === null) return;
      switchTool(preSelectTool.current);
      preSelectTool.current = null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Marks a shape as gone for this erase drag, keeping the full original shape (not just
  // its id) so the whole drag can be undone later. If it was itself a fragment created
  // earlier in the *same* drag, the network was never told it existed, so just forget it —
  // no delete needs to be sent, and it was never "originally there" for undo to restore.
  const recordErased = (shape) => {
    const session = eraseSession.current;
    if (session.addedShapes.has(shape.id)) {
      session.addedShapes.delete(shape.id);
    } else {
      session.deletedShapes.set(shape.id, shape);
    }
  };

  // Lines get trimmed at exactly the touched points (real partial erasing); rect/circle/text
  // aren't paths, so for them the eraser still removes the whole shape it touches. Local
  // state updates immediately for live feedback, but nothing goes over the socket until the
  // drag ends (see handleMouseUp) — erasing through a long line was firing dozens of network
  // round-trips per second otherwise.
  const eraseAt = (pos) => {
    const radius = eraserSize / 2;
    const eraserBounds = { x: pos.x - radius, y: pos.y - radius, width: eraserSize, height: eraserSize };
    const hits = shapes.filter((s) => {
      const bounds = getShapeBounds(s);
      if (!rectsIntersect(eraserBounds, bounds)) return false;
      // A system boundary is a big frame around other shapes, so erasing the shapes
      // inside it mustn't delete it — only touching near its border does
      if (s.type === "boundary") {
        const inside = { x: bounds.x + 10, y: bounds.y + 10, width: bounds.width - 20, height: bounds.height - 20 };
        return !rectContains(inside, eraserBounds);
      }
      return true;
    });
    if (hits.length === 0) return;

    const toDelete = [];
    const toAdd = [];

    hits.forEach((shape) => {
      if (shape.type !== "line") {
        toDelete.push(shape);
        return;
      }
      const runs = eraseLinePoints(shape.points, pos, radius);
      const survivingPointCount = runs.reduce((sum, run) => sum + run.length, 0);
      if (survivingPointCount === shape.points.length) return; // bbox overlapped, but nothing actually touched
      toDelete.push(shape);
      runs.forEach((points) => {
        // The leftover pieces of an erased line aren't attached to anything any more
        toAdd.push({ ...shape, id: `shape_${crypto.randomUUID()}`, points, from: undefined, to: undefined });
      });
    });

    if (toDelete.length === 0) return;

    const deleteSet = new Set(toDelete.map((s) => s.id));
    setShapes((prev) => [...prev.filter((s) => !deleteSet.has(s.id)), ...toAdd]);

    toDelete.forEach(recordErased);
    toAdd.forEach((shape) => eraseSession.current.addedShapes.set(shape.id, shape));

    setSelectedIds((prev) => {
      if (![...deleteSet].some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      deleteSet.forEach((id) => next.delete(id));
      return next;
    });
  };

  // Zooms by `factor` while keeping the board point under `screenPoint` in the same spot on
  // screen — so Ctrl+scroll zooms toward the mouse, and the buttons zoom toward the middle
  const zoomAt = (screenPoint, factor) => {
    setView((prev) => {
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.scale * factor));
      const boardX = (screenPoint.x - prev.x) / prev.scale;
      const boardY = (screenPoint.y - prev.y) / prev.scale;
      return { scale, x: screenPoint.x - boardX * scale, y: screenPoint.y - boardY * scale };
    });
  };

  const zoomFromCenter = (factor) => zoomAt({ x: canvasSize.width / 2, y: canvasSize.height / 2 }, factor);

  // Board coordinates → screen pixels, for the HTML boxes (text editor, style menu) that
  // sit on top of the canvas and so don't get zoomed or panned by Konva automatically
  const toScreen = (point) => ({ x: point.x * view.scale + view.x, y: point.y * view.scale + view.y });

  // The Hand tool drags the whole Stage. Shapes' own drag events bubble up to the Stage
  // too, so only react when the thing being dragged is the Stage itself
  const handleStagePan = (e) => {
    const stage = e.target.getStage();
    if (e.target !== stage) return;
    setView((prev) => ({ ...prev, x: stage.x(), y: stage.y() }));
  };

  // Ctrl + scroll zooms (trackpad pinch arrives the same way). Otherwise, the scroll wheel
  // resizes the eraser while it's the active tool — scroll up to grow it, down to shrink
  // it, same 8-80px range as the slider (they control the same state)
  const handleWheel = (e) => {
    if (e.evt.ctrlKey) {
      e.evt.preventDefault(); // stop the browser zooming the whole page instead
      zoomAt(e.target.getStage().getPointerPosition(), e.evt.deltaY < 0 ? 1.1 : 1 / 1.1);
      return;
    }
    if (tool !== "eraser") return;
    e.evt.preventDefault();
    const step = e.evt.deltaY < 0 ? 4 : -4;
    setEraserSize((prev) => Math.min(80, Math.max(8, prev + step)));
  };

  // Opens the text box exactly over a shape to edit its label. isLabel tells confirmText to
  // update this shape instead of adding a new text shape. A sticky note's box is yellow with
  // dark text, so typing looks like writing on the note itself
  const openLabelEditor = (shape) => {
    const box = getShapeBounds(shape);
    const isSticky = shape.type === "sticky";
    setTextEditor({
      id: shape.id,
      isLabel: true,
      x: box.x,
      y: box.y,
      width: Math.max(80, box.width),
      height: Math.max(40, box.height),
      fontSize: shape.fontSize || 18,
      color: isSticky ? STICKY_TEXT : shape.stroke,
      background: isSticky ? STICKY_YELLOW : undefined,
      value: shape.text || "",
    });
  };

  const handleMouseDown = (e) => {
    // Relative = in board coordinates, with zoom and panning already undone
    const pos = e.target.getStage().getRelativePointerPosition();

    if (tool === "hand") return; // Konva drags the Stage itself; nothing to draw

    if (tool === "eraser") {
      isErasing.current = true;
      eraseSession.current = { deletedShapes: new Map(), addedShapes: new Map() };
      lastErasePos.current = pos;
      eraseAt(pos);
      return;
    }

    if (tool === "select") {
      // Clicked empty canvas (not a shape) — start a drag-select box. Ctrl/Cmd/Shift
      // means "add to the current selection" instead of replacing it.
      if (e.target === e.target.getStage()) {
        marqueeStart.current = pos;
        marqueeAdditive.current = e.evt.ctrlKey || e.evt.metaKey || e.evt.shiftKey;
        setMarquee({ x: pos.x, y: pos.y, width: 0, height: 0 });
        if (!marqueeAdditive.current) setSelectedIds(new Set());
      }
      return;
    }

    const id = `shape_${crypto.randomUUID()}`;

    // Text has no drag phase — open a resizable text box at the click point instead
    if (tool === "text") {
      if (textEditor) return; // already editing one, ignore extra clicks
      setTextEditor({
        id,
        x: pos.x,
        y: pos.y,
        width: 160,
        height: 40,
        fontSize: 18,
        color: PALETTE[0],
        value: "",
      });
      return;
    }

    // A sticky note is placed with a single click: a yellow square centred on the click,
    // with its text box opened straight away so you can start typing
    if (tool === "sticky") {
      if (textEditor) return; // finish the note being typed first
      const sticky = {
        id,
        type: "sticky",
        x: pos.x - 100,
        y: pos.y - 100,
        width: 200,
        height: 200,
        stroke: STICKY_YELLOW,
        strokeWidth: 0,
        fill: STICKY_YELLOW,
        points: [],
        text: "",
        fontSize: 18,
        createdBy: userId,
      };
      setShapes((prev) => [...prev, sticky]);
      socket.emit("shape:add", sticky);
      pushUndo([], [sticky]);
      openLabelEditor(sticky);
      return;
    }

    drawingShapeId.current = id;
    isDrawing.current = true;
    smoothPos.current = { x: pos.x, y: pos.y };

    // Both arrow tools draw an "arrow" shape; the dashed one is for UML «include» / «extend»
    // links, so it starts with that label already filled in
    const isArrowTool = tool === "arrow" || tool === "dashedArrow";
    // The highlighter draws an ordinary freehand line — thick, yellow and see-through
    const isHighlighter = tool === "highlighter";

    // Add a zero-size shape immediately so it grows under the cursor as we drag
    setShapes((prev) => [
      ...prev,
      {
        id,
        type: isArrowTool ? "arrow" : isHighlighter ? "line" : tool,
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
        stroke: isHighlighter ? "#FFD60A" : drawColor,
        strokeWidth: isHighlighter ? 18 : drawThickness,
        fill: "transparent",
        // A line starts as one point and grows; an arrow is always start point + end point
        points: tool === "line" || isHighlighter ? [pos.x, pos.y] : isArrowTool ? [pos.x, pos.y, pos.x, pos.y] : [],
        text: tool === "dashedArrow" ? "«include»" : "",
        ...(isArrowTool && { dashed: tool === "dashedArrow" }),
        ...(isHighlighter && { highlight: true }),
        ...(tool === "table" && { cells: emptyCells(TABLE_START.rows, TABLE_START.cols) }),
        createdBy: userId,
      },
    ]);
  };

  const handleMouseMove = (e) => {
    const pos = e.target.getStage().getRelativePointerPosition();

    if (tool === "eraser") {
      setEraserPos(pos);
      // Skip re-checking every shape on the board for tiny sub-pixel jitter — only
      // actually erase once the cursor has moved a few pixels since the last check
      if (isErasing.current) {
        const last = lastErasePos.current;
        if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) >= 4) {
          eraseAt(pos);
          lastErasePos.current = pos;
        }
      }
      return;
    }

    if (marqueeStart.current) {
      setMarquee({
        x: Math.min(marqueeStart.current.x, pos.x),
        y: Math.min(marqueeStart.current.y, pos.y),
        width: Math.abs(pos.x - marqueeStart.current.x),
        height: Math.abs(pos.y - marqueeStart.current.y),
      });
      return;
    }

    if (!isDrawing.current) return;

    setShapes((prev) =>
      prev.map((shape) => {
        if (shape.id !== drawingShapeId.current) return shape;
        // Freehand lines grow by appending a smoothed point (chases the cursor rather than
        // snapping to it exactly), boxed shapes just resize to the raw cursor position
        if (shape.type === "line") {
          const SMOOTHING = 0.15; // lower = smoother + more delay, higher = snappier
          const smooth = smoothPos.current;
          smooth.x += (pos.x - smooth.x) * SMOOTHING;
          smooth.y += (pos.y - smooth.y) * SMOOTHING;
          return { ...shape, points: [...shape.points, smooth.x, smooth.y] };
        }
        // An arrow keeps its start point and moves its end point to the cursor
        if (shape.type === "arrow") {
          return { ...shape, points: [shape.points[0], shape.points[1], pos.x, pos.y] };
        }
        return { ...shape, width: pos.x - shape.x, height: pos.y - shape.y };
      })
    );
  };

  const handleMouseUp = () => {
    if (tool === "eraser") {
      isErasing.current = false;
      // Send everything that changed during this whole drag as one batch, now that it's
      // over, and record the whole drag as a single undo action
      const session = eraseSession.current;
      if (session && (session.deletedShapes.size > 0 || session.addedShapes.size > 0)) {
        const removed = [...session.deletedShapes.values()];
        const added = [...session.addedShapes.values()];
        removed.forEach((s) => socket.emit("shape:delete", { id: s.id }));
        added.forEach((s) => socket.emit("shape:add", s));
        pushUndo(removed, added);
      }
      eraseSession.current = null;
      return;
    }

    if (marqueeStart.current) {
      const box = marquee;
      marqueeStart.current = null;
      setMarquee(null);
      if (box && (box.width > 3 || box.height > 3)) {
        // A system boundary is only picked up when the box fully covers it, so you can
        // drag-select the use cases inside a boundary without grabbing the frame too
        const hitIds = shapes
          .filter((s) =>
            s.type === "boundary" ? rectContains(box, getShapeBounds(s)) : rectsIntersect(box, getShapeBounds(s))
          )
          .map((s) => s.id);
        setSelectedIds((prev) => {
          const next = marqueeAdditive.current ? new Set(prev) : new Set();
          hitIds.forEach((id) => next.add(id));
          return next;
        });
      }
      return;
    }

    if (!isDrawing.current) return;
    isDrawing.current = false;

    // Only tell other users once the shape is finished, not on every drag step
    let finishedShape = shapes.find((shape) => shape.id === drawingShapeId.current);

    // A click without a drag makes a box or arrow with (almost) no size — invisible, or for
    // a dashed arrow just a floating label. Throw it away instead of syncing and saving it.
    // Marker strokes are kept: a short dab is a deliberate mark
    if (finishedShape && finishedShape.type !== "line") {
      const size = getShapeBounds(finishedShape);
      if (size.width < 3 && size.height < 3) {
        setShapes((prev) => prev.filter((s) => s.id !== finishedShape.id));
        drawingShapeId.current = null;
        return;
      }
    }

    // A table dragged out too small to type in is grown to fit its cells
    if (finishedShape && finishedShape.type === "table") {
      const box = getShapeBounds(finishedShape);
      const grown = {
        ...finishedShape,
        ...box,
        width: Math.max(box.width, TABLE_START.cols * TABLE_MIN_CELL.width),
        height: Math.max(box.height, TABLE_START.rows * TABLE_MIN_CELL.height),
      };
      setShapes((prev) => prev.map((s) => (s.id === grown.id ? grown : s)));
      finishedShape = grown;
    }

    // An arrow started or released on a shape becomes attached to it
    if (finishedShape && finishedShape.type === "arrow") {
      const attached = attachEnds(finishedShape, shapes.filter((s) => s.id !== finishedShape.id));
      if (attached !== finishedShape) {
        setShapes((prev) => prev.map((s) => (s.id === attached.id ? attached : s)));
        finishedShape = attached;
      }
    }

    if (finishedShape) {
      socket.emit("shape:add", finishedShape);
      pushUndo([], [finishedShape]);

      // Box shapes and arrows get a style menu right after placement so you can tweak
      // color/thickness — next to a box's corner, or at an arrow's tip
      const isArrow = finishedShape.type === "arrow";
      if (BOX_TYPES.includes(finishedShape.type) || isArrow) {
        setShapeMenu({
          shapeId: finishedShape.id,
          x: isArrow ? finishedShape.points[2] : finishedShape.x + Math.max(0, finishedShape.width),
          y: isArrow ? finishedShape.points[3] : finishedShape.y + Math.max(0, finishedShape.height),
          color: finishedShape.stroke,
          thickness: finishedShape.strokeWidth,
        });
      }
    }
    drawingShapeId.current = null;
  };

  // The top-most shape that an arrow end dropped at `pos` should attach to, if any. A few
  // pixels of slack, so letting go right on a shape's edge still counts
  const attachableShapeAt = (pos, candidates) => {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const s = candidates[i];
      if (!ATTACHABLE_TYPES.includes(s.type)) continue;
      const b = getShapeBounds(s);
      if (pos.x >= b.x - 6 && pos.x <= b.x + b.width + 6 && pos.y >= b.y - 6 && pos.y <= b.y + b.height + 6) return s;
    }
    return null;
  };

  // Attaches an arrow's or line's ends to the shapes they were drawn on (from / to hold
  // those shapes' ids) and snaps the attached ends onto the shapes' outlines
  const attachEnds = (connector, candidates) => {
    const p = connector.points;
    const startPos = { x: p[0], y: p[1] };
    const endPos = { x: p[p.length - 2], y: p[p.length - 1] };
    const fromShape = attachableShapeAt(startPos, candidates);
    const toShape = attachableShapeAt(endPos, candidates);
    // Nothing underneath, or both ends inside the same shape: leave it as drawn
    if ((!fromShape && !toShape) || fromShape === toShape) return connector;
    const end = (shape, pos) => (shape ? { type: shape.type, box: getShapeBounds(shape) } : { point: [pos.x, pos.y] });
    return {
      ...connector,
      from: fromShape?.id,
      to: toShape?.id,
      points: connectorPoints(end(fromShape, startPos), end(toShape, endPos)),
    };
  };

  // Keeps connectors attached when the shapes at their ends move or resize.
  // movedBoxes: shape id → that shape's new bounds. base: the shapes before the move.
  // If both ends moved together (dragging a whole diagram) the connector just slides and
  // keeps its route; if only one end moved, it's redrawn straight between the outlines.
  // emit: also send the result to other users — only once the drag is over
  const rerouteConnectors = (movedBoxes, base, draggedIds, emit) => {
    const changed = [];
    base.forEach((c) => {
      if ((c.type !== "line" && c.type !== "arrow") || draggedIds.has(c.id)) return;
      const fromMoved = movedBoxes[c.from];
      const toMoved = movedBoxes[c.to];
      if (!fromMoved && !toMoved) return;
      let points;
      if (fromMoved && toMoved) {
        const before = getShapeBounds(base.find((s) => s.id === c.from));
        points = moveShape(c, fromMoved.x - before.x, fromMoved.y - before.y).points;
      } else {
        // An end whose shape no longer exists (deleted) just stays where it is
        const end = (id, moved, point) => {
          const shape = id && base.find((s) => s.id === id);
          return shape ? { type: shape.type, box: moved || getShapeBounds(shape) } : { point };
        };
        const p = c.points;
        points = connectorPoints(
          end(c.from, fromMoved, [p[0], p[1]]),
          end(c.to, toMoved, [p[p.length - 2], p[p.length - 1]])
        );
      }
      changed.push({ ...c, points });
    });
    if (changed.length === 0) return;
    const byId = new Map(changed.map((c) => [c.id, c]));
    setShapes((prev) => prev.map((s) => byId.get(s.id) || s));
    if (emit) changed.forEach((c) => socket.emit("shape:update", c));
  };

  // Where each dragged box shape is right now, read straight from its Konva node
  const liveBoxBounds = (ids, base) => {
    const result = {};
    ids.forEach((id) => {
      const shape = base.find((s) => s.id === id);
      const node = shapeRefs.current[id];
      if (shape && node && BOX_TYPES.includes(shape.type)) {
        result[id] = { ...getShapeBounds(shape), x: node.x(), y: node.y() };
      }
    });
    return result;
  };

  // Actually commits a shape's new position to state + the socket, given its Konva node.
  // Shared by single-shape drags and every shape in a multi-select group drag.
  // movedIds: everything that moved in this drag
  const commitDrag = (shape, node, movedIds) => {
    // Lines and arrows are stored as points, so dragging shifts every point by how far the
    // node moved, then puts the node back at 0,0
    if (shape.type === "line" || shape.type === "arrow") {
      const dx = node.x();
      const dy = node.y();
      const newPoints = shape.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
      node.position({ x: 0, y: 0 });
      // An end stays attached only if the shape it's attached to moved along with it;
      // dragging an arrow away on its own detaches it
      const updated = {
        ...shape,
        points: newPoints,
        from: movedIds.has(shape.from) ? shape.from : undefined,
        to: movedIds.has(shape.to) ? shape.to : undefined,
      };
      setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
      socket.emit("shape:update", updated);
      return;
    }
    // Every other shape's Konva node sits at the shape's top-left corner, so the node's
    // position is the new x/y. Width/height are stored positive from here on, even if the
    // shape was first drawn by dragging up or left
    const box = getShapeBounds(shape);
    const updated = { ...shape, x: node.x(), y: node.y(), width: box.width, height: box.height };
    setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
    socket.emit("shape:update", updated);
  };

  // If you start dragging a shape that isn't part of the current multi-selection, it just
  // becomes the new (solo) selection and moves alone. Otherwise, record every selected
  // shape's starting position so they can all be moved by the same delta as you drag.
  const handleShapeDragStart = (shape) => () => {
    dragBase.current = shapes;
    if (!selectedIds.has(shape.id) || selectedIds.size <= 1) {
      if (!selectedIds.has(shape.id)) setSelectedIds(new Set([shape.id]));
      groupDragStart.current = {};
      return;
    }
    const positions = {};
    selectedIds.forEach((id) => {
      const node = shapeRefs.current[id];
      if (node) positions[id] = { x: node.x(), y: node.y() };
    });
    groupDragStart.current = positions;
  };

  // Live-follow: while dragging one shape in a group, shove every other selected shape's
  // Konva node by the same delta, directly — no React re-render needed until drag end.
  // Then let connectors attached to the moving shapes follow too (on this screen only;
  // other users get the final result when the drag ends)
  const handleShapeDragMove = (shape) => (e) => {
    const start = groupDragStart.current[shape.id];
    if (start) {
      const node = e.target;
      const dx = node.x() - start.x;
      const dy = node.y() - start.y;
      Object.keys(groupDragStart.current).forEach((id) => {
        if (id === shape.id) return;
        const otherNode = shapeRefs.current[id];
        const otherStart = groupDragStart.current[id];
        if (otherNode && otherStart) otherNode.position({ x: otherStart.x + dx, y: otherStart.y + dy });
      });
      node.getLayer()?.batchDraw();
    }
    if (!dragBase.current) return;
    const movingIds = start ? Object.keys(groupDragStart.current) : [shape.id];
    rerouteConnectors(liveBoxBounds(movingIds, dragBase.current), dragBase.current, new Set(movingIds), false);
  };

  const handleShapeDragEnd = (shape) => (e) => {
    const groupIds = Object.keys(groupDragStart.current);
    const movedIds = new Set(groupIds.length > 0 ? groupIds : [shape.id]);
    const base = dragBase.current || shapes;
    // Read where the boxes ended up before commitDrag resets any line nodes
    const movedBoxes = liveBoxBounds([...movedIds], base);
    if (groupIds.length > 0) {
      groupIds.forEach((id) => {
        const s = shapes.find((sh) => sh.id === id);
        const node = shapeRefs.current[id];
        if (s && node) commitDrag(s, node, movedIds);
      });
      groupDragStart.current = {};
    } else {
      commitDrag(shape, e.target, movedIds);
    }
    rerouteConnectors(movedBoxes, base, movedIds, true);
    dragBase.current = null;
  };

  // Transformer resize reports a scale factor, not a new width/height — apply it to our
  // stored size (and font size, for text), then reset the node's internal scale back to 1.
  // Turning a shape with the rotate handle is saved too, in degrees. Konva turns a shape
  // around its top-left corner, so it also moves x/y to make the turn look centred — both
  // are read back from the node and stored together
  const handleTransformEnd = (shape) => (e) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    const rotation = node.rotation();

    if (shape.type === "text") {
      const avgScale = (scaleX + scaleY) / 2;
      const updated = {
        ...shape,
        x: node.x(),
        y: node.y(),
        rotation,
        width: Math.max(20, shape.width * scaleX),
        fontSize: Math.max(8, (shape.fontSize || 18) * avgScale),
      };
      setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
      socket.emit("shape:update", updated);
      return;
    }

    const box = getShapeBounds(shape);
    const updated = { ...shape, x: node.x(), y: node.y(), rotation, width: box.width * scaleX, height: box.height * scaleY };

    setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
    socket.emit("shape:update", updated);
    // Connectors attached to it are redrawn to meet its new outline
    rerouteConnectors({ [shape.id]: getShapeBounds(updated) }, shapes, new Set([shape.id]), true);
  };

  // File-explorer-style click: plain click selects only this shape, Ctrl/Cmd/Shift-click
  // toggles it in or out of the current selection
  const handleSelect = (id) => (e) => {
    if (tool !== "select") return;
    const isMultiKey = e.evt.ctrlKey || e.evt.metaKey || e.evt.shiftKey;
    setSelectedIds((prev) => {
      if (!isMultiKey) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTextDblClick = (shape) => () => {
    if (tool !== "select") return;
    setTextEditor({
      id: shape.id,
      x: shape.x,
      y: shape.y,
      width: shape.width || 160,
      height: shape.height || 40,
      fontSize: shape.fontSize || 18,
      color: shape.fill,
      value: shape.text,
    });
  };

  // Double-clicking a shape edits its label (see openLabelEditor)
  const handleLabelDblClick = (shape) => () => {
    if (tool !== "select") return;
    openLabelEditor(shape);
  };

  // Saves a change to a table — a cell's text, or a row/column added or removed — and
  // makes it undoable: the undo history stores the table before and after, so undo swaps
  // the old one back in. Arrows attached to the table follow its new size
  const commitTableChange = (before, after) => {
    setShapes((prev) => prev.map((s) => (s.id === after.id ? after : s)));
    socket.emit("shape:update", after);
    pushUndo([before], [after]);
    rerouteConnectors({ [after.id]: getShapeBounds(after) }, shapes, new Set([after.id]), true);
  };

  // Double-clicking a table opens the text box over just the cell that was clicked: which
  // row and column that is comes from how far into the table the click landed. The table's
  // own Group measures that (currentTarget), so it's right even when the table is rotated
  const handleCellDblClick = (shape) => (e) => {
    if (tool !== "select") return;
    const inside = e.currentTarget.getRelativePointerPosition();
    const box = getShapeBounds(shape);
    const rows = shape.cells.length;
    const cols = shape.cells[0].length;
    const cellWidth = box.width / cols;
    const cellHeight = box.height / rows;
    const row = Math.min(rows - 1, Math.max(0, Math.floor(inside.y / cellHeight)));
    const col = Math.min(cols - 1, Math.max(0, Math.floor(inside.x / cellWidth)));
    setTextEditor({
      id: shape.id,
      isLabel: true,
      cell: { row, col },
      x: box.x + col * cellWidth,
      y: box.y + row * cellHeight,
      width: Math.max(80, cellWidth),
      height: Math.max(36, cellHeight),
      fontSize: shape.fontSize || 16,
      color: shape.stroke,
      value: shape.cells[row][col],
    });
  };

  // The + / − Row and Column buttons. Rows are added and removed at the bottom, columns at
  // the right; every cell that stays keeps its text, and cells keep their size, so the
  // table grows or shrinks by one cell
  const resizeTable = (table, rowChange, colChange) => {
    const rows = table.cells.length;
    const cols = table.cells[0].length;
    const newRows = rows + rowChange;
    const newCols = cols + colChange;
    if (newRows < 1 || newCols < 1 || newRows > TABLE_MAX_LINES || newCols > TABLE_MAX_LINES) return;
    const box = getShapeBounds(table);
    const cells = Array.from({ length: newRows }, (_, r) =>
      Array.from({ length: newCols }, (_, c) => table.cells[r]?.[c] ?? "")
    );
    commitTableChange(table, {
      ...table,
      ...box,
      width: (box.width / cols) * newCols,
      height: (box.height / rows) * newRows,
      cells,
    });
  };

  const confirmText = () => {
    if (textEditor?.isLabel) {
      const target = shapes.find((s) => s.id === textEditor.id);
      if (target && textEditor.cell) {
        const { row, col } = textEditor.cell;
        const value = textEditor.value.trim();
        // The cell may be gone if someone else removed its row or column meanwhile
        const current = target.cells[row]?.[col];
        if (current !== undefined && current !== value) {
          const cells = target.cells.map((cellsInRow, r) =>
            cellsInRow.map((text, c) => (r === row && c === col ? value : text))
          );
          commitTableChange(target, { ...target, cells });
        }
      } else if (target) {
        const updated = { ...target, text: textEditor.value.trim() }; // empty = remove the label
        setShapes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        socket.emit("shape:update", updated);
      }
      setTextEditor(null);
      return;
    }
    if (!textEditor || !textEditor.value.trim()) {
      setTextEditor(null);
      return;
    }
    // Read the box's current on-screen size, since the user may have dragged to resize it,
    // then divide by the zoom to turn screen pixels back into board units
    const el = textareaRef.current;
    const width = el ? el.offsetWidth / view.scale : textEditor.width;
    const height = el ? el.offsetHeight / view.scale : textEditor.height;

    const shape = {
      id: textEditor.id,
      type: "text",
      x: textEditor.x,
      y: textEditor.y,
      width,
      height,
      fontSize: textEditor.fontSize || 18,
      stroke: textEditor.color,
      fill: textEditor.color,
      points: [],
      text: textEditor.value,
      createdBy: userId,
    };

    const isEditingExisting = shapes.some((s) => s.id === shape.id);
    setShapes((prev) =>
      isEditingExisting ? prev.map((s) => (s.id === shape.id ? shape : s)) : [...prev, shape]
    );
    socket.emit(isEditingExisting ? "shape:update" : "shape:add", shape);
    if (!isEditingExisting) {
      pushUndo([], [shape]);
    }
    setTextEditor(null);
  };

  const cancelText = () => setTextEditor(null);

  // Applies a color/thickness pick from the post-placement shape menu to that one shape,
  // and remembers it as the default style for the next shape you draw
  const applyShapeStyle = ({ color, thickness }) => {
    if (!shapeMenu) return;
    if (color) setDrawColor(color);
    if (thickness) setDrawThickness(thickness);

    const current = shapes.find((s) => s.id === shapeMenu.shapeId);
    if (!current) return;
    const updated = { ...current, stroke: color ?? current.stroke, strokeWidth: thickness ?? current.strokeWidth };

    setShapes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    socket.emit("shape:update", updated);
    setShapeMenu((prev) => (prev ? { ...prev, color: updated.stroke, thickness: updated.strokeWidth } : prev));
  };

  // The Shapes button counts as the active tool whenever any shape from its menu is chosen,
  // and shows that shape's name
  const activeShape = SHAPE_TOOLS.find((s) => s.type === tool);
  // A lone selected picture gets corner handles only (see RESIZE_CORNERS)
  const selectedIsImage =
    selectedIds.size === 1 && shapes.find((s) => selectedIds.has(s.id))?.type === "image";
  // A lone selected table gets the + / − Row and Column buttons underneath it
  const selectedTable =
    tool === "select" && selectedIds.size === 1
      ? shapes.find((s) => selectedIds.has(s.id) && s.type === "table")
      : null;
  const isToolActive = (t) => {
    if (t === "shapes") return Boolean(activeShape);
    if (t === "line") return tool === "line" || tool === "highlighter"; // one button, two pens
    return tool === t;
  };

  const renderShape = (shape) => {
    const selectable = tool === "select";
    const isSelected = selectedIds.has(shape.id);
    // Every shape type is clickable/draggable the same way — only the Konva element and
    // its shape-specific props differ below
    const commonProps = {
      key: shape.id,
      ref: (node) => (shapeRefs.current[shape.id] = node),
      // Degrees, set with the rotate handle; shapes that were never turned have none.
      // Lines and arrows never get the handle, so theirs is always 0
      rotation: shape.rotation || 0,
      draggable: selectable,
      onClick: handleSelect(shape.id),
      onTap: handleSelect(shape.id),
      onDragStart: handleShapeDragStart(shape),
      onDragMove: handleShapeDragMove(shape),
      onDragEnd: handleShapeDragEnd(shape),
    };
    // The white glow on selected shapes. Kept separate because a Group can't glow — only
    // the visible shapes inside it can
    const highlight = {
      shadowColor: "#ffffff",
      shadowBlur: isSelected ? 10 : 0,
      shadowOpacity: isSelected ? 0.8 : 0,
    };

    // A table is a Group too: its outline, a shaded header row, the grid lines and one text
    // per cell. Only the outline listens for clicks; everything else lets them through
    if (shape.type === "table") {
      const box = getShapeBounds(shape);
      const rows = shape.cells.length;
      const cols = shape.cells[0].length;
      const cellWidth = box.width / cols;
      const cellHeight = box.height / rows;
      const gridLine = { stroke: shape.stroke, strokeWidth: 1, opacity: 0.6, listening: false };
      return (
        <Group
          {...commonProps}
          x={box.x}
          y={box.y}
          onTransformEnd={handleTransformEnd(shape)}
          onDblClick={handleCellDblClick(shape)}
          onDblTap={handleCellDblClick(shape)}
        >
          <Rect width={box.width} height={box.height} stroke={shape.stroke} strokeWidth={shape.strokeWidth || 2} {...highlight} />
          <Rect width={box.width} height={cellHeight} fill={shape.stroke} opacity={0.15} listening={false} />
          {Array.from({ length: cols - 1 }, (_, i) => (
            <Line key={`col${i}`} points={[cellWidth * (i + 1), 0, cellWidth * (i + 1), box.height]} {...gridLine} />
          ))}
          {Array.from({ length: rows - 1 }, (_, i) => (
            <Line key={`row${i}`} points={[0, cellHeight * (i + 1), box.width, cellHeight * (i + 1)]} {...gridLine} />
          ))}
          {shape.cells.map((cellsInRow, r) =>
            cellsInRow.map((text, c) =>
              text ? (
                <Text
                  key={`${r}-${c}`}
                  x={c * cellWidth}
                  y={r * cellHeight}
                  width={cellWidth}
                  height={cellHeight}
                  text={text}
                  fill={shape.stroke}
                  fontSize={shape.fontSize || 16}
                  fontStyle={r === 0 ? "bold" : "normal"}
                  verticalAlign="middle"
                  padding={8}
                  wrap="word"
                  // Text too long for its cell ends in "…" instead of spilling out
                  ellipsis
                  listening={false}
                />
              ) : null
            )
          )}
        </Group>
      );
    }

    // A box shape is a Group: its outline plus a centred label, so the two always move and
    // resize together. The Group sits at the top-left corner of the shape's box and its
    // children are drawn from 0,0 inside it
    if (BOX_TYPES.includes(shape.type)) {
      const box = getShapeBounds(shape);
      const labelArea = getLabelArea(shape.type, box.width, box.height);
      const outline = {
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth || 2,
        fill: shape.fill,
        ...highlight,
      };
      return (
        <Group
          {...commonProps}
          x={box.x}
          y={box.y}
          onTransformEnd={handleTransformEnd(shape)}
          onDblClick={handleLabelDblClick(shape)}
          onDblTap={handleLabelDblClick(shape)}
        >
          {renderOutline(shape.type, box.width, box.height, outline)}
          {shape.text && (
            <Text
              {...labelArea}
              text={shape.text}
              fill={shape.type === "sticky" ? STICKY_TEXT : shape.stroke}
              fontSize={shape.fontSize || 18}
              fontStyle={shape.type === "boundary" ? "bold" : "normal"}
              // A sticky note reads like paper, from the top-left; every other label is centred
              align={shape.type === "sticky" ? "left" : "center"}
              verticalAlign={shape.type === "sticky" ? "top" : "middle"}
              wrap="word"
              padding={shape.type === "sticky" ? 14 : 6}
              // Labels let clicks pass through to their shape — except a boundary's title,
              // which is the easy place to grab the frame since it has no fill
              listening={shape.type === "boundary"}
            />
          )}
        </Group>
      );
    }

    switch (shape.type) {
      // An arrow is a Group too, so its optional label (like "Yes" / "No" out of a
      // decision) moves with it. The label sits on a black patch in the middle of the
      // arrow, so the line doesn't run through the words
      case "arrow": {
        const labelPoint = getArrowLabelPoint(shape.points);
        const labelSize = shape.text ? measureText(shape.text, 14) : null;
        return (
          <Group {...commonProps} onDblClick={handleLabelDblClick(shape)} onDblTap={handleLabelDblClick(shape)}>
            <Arrow
              points={shape.points}
              stroke={shape.stroke}
              fill={shape.stroke}
              strokeWidth={shape.strokeWidth || 2}
              pointerLength={10}
              pointerWidth={10}
              dash={shape.dashed ? [10, 6] : undefined}
              hitStrokeWidth={16}
              {...highlight}
            />
            {labelSize && (
              <>
                <Rect
                  x={labelPoint.x - labelSize.width / 2 - 4}
                  y={labelPoint.y - labelSize.height / 2 - 2}
                  width={labelSize.width + 8}
                  height={labelSize.height + 4}
                  fill="#000000"
                  listening={false}
                />
                <Text
                  x={labelPoint.x - labelSize.width / 2}
                  y={labelPoint.y - labelSize.height / 2}
                  text={shape.text}
                  fontSize={14}
                  fill={shape.stroke}
                  listening={false}
                />
              </>
            )}
          </Group>
        );
      }
      case "line":
        return (
          <Line
            {...commonProps}
            {...highlight}
            points={shape.points}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth || 2}
            // Highlighter strokes are see-through, so what's underneath still shows
            opacity={shape.highlight ? 0.4 : 1}
            lineCap="round"
            lineJoin="round"
            tension={0.55}
          />
        );
      case "text":
        return (
          <Text
            {...commonProps}
            {...highlight}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            text={shape.text}
            fill={shape.fill}
            fontSize={shape.fontSize || 18}
            wrap="word"
            onDblClick={handleTextDblClick(shape)}
            onDblTap={handleTextDblClick(shape)}
            onTransformEnd={handleTransformEnd(shape)}
          />
        );
      case "image":
        return (
          <BoardImage
            {...commonProps}
            {...highlight}
            src={shape.src}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            onTransformEnd={handleTransformEnd(shape)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: "10px",
          left: "10px",
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontFamily: "sans-serif",
          fontSize: "13px",
          color: "#ddd",
          background: "rgba(14, 13, 13, 0.75)",
          padding: "4px 10px",
          borderRadius: "6px",
        }}
      >
        <span>OurBoard</span>
        <span
          title={
            connectionStatus === "connected"
              ? "Connected"
              : connectionStatus === "reconnecting"
              ? "Reconnecting..."
              : "Disconnected"
          }
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background:
              connectionStatus === "connected" ? "#32D74B" : connectionStatus === "reconnecting" ? "#FFD60A" : "#FF3B30",
            display: "inline-block",
          }}
        />
      </div>

      <div
        style={{
          position: "absolute",
          top: "10px",
          left: "50%",
          transform: "translateX(-50%)",
          // One layer above the other floating panels, so the toolbar's dropdown menus
          // always open on top of them
          zIndex: 40,
          display: "flex",
          gap: "8px",
          background: "rgba(17,17,17,0.85)",
          padding: "8px",
          borderRadius: "8px",
        }}
      >
        {TOOLS.map((t) => (
          // The Shapes wrapper holds both its button and its menu, so clicking the button
          // again doesn't count as an "outside click" that closes the menu
          <div key={t} ref={t === "shapes" ? shapesMenuRef : undefined} style={{ position: "relative" }}>
            <button
              onClick={() => {
                if (t === "shapes") {
                  setShowShapesMenu((open) => !open);
                  return;
                }
                // The pen button keeps whichever pen (marker or highlighter) you last chose
                switchTool(t === "line" && tool === "highlighter" ? "highlighter" : t);
                if (t === "line") setShowLineMenu(true);
                if (t === "eraser") setShowEraserMenu(true);
              }}
              title={SHORTCUT_KEYS[t] ? `Shortcut: ${SHORTCUT_KEYS[t]}` : undefined}
              style={{
                padding: "6px 10px",
                fontWeight: isToolActive(t) ? "bold" : "normal",
                border: isToolActive(t) ? "2px solid #333" : "1px solid #999",
                borderRadius: "4px",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t === "shapes"
                ? `${activeShape ? activeShape.label : "Shapes"} ▾`
                : t === "line" && tool === "highlighter"
                ? "highlighter"
                : TOOL_LABELS[t] || t}
            </button>

            {t === "shapes" && showShapesMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "110%",
                  left: 0,
                  background: "#111",
                  border: "1px solid #444",
                  borderRadius: "6px",
                  padding: "6px",
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                  minWidth: "230px",
                }}
              >
                {SHAPE_TOOLS.map((s, i) => (
                  <div key={s.type} style={{ display: "flex", flexDirection: "column" }}>
                    {/* A small heading wherever the next diagram's shapes start */}
                    {(i === 0 || SHAPE_TOOLS[i - 1].group !== s.group) && (
                      <div
                        style={{
                          color: "#888",
                          fontSize: "11px",
                          textTransform: "uppercase",
                          fontFamily: "sans-serif",
                          padding: i === 0 ? "2px 10px 4px" : "10px 10px 4px",
                        }}
                      >
                        {s.group}
                      </div>
                    )}
                    <button
                      onClick={() => switchTool(s.type)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "12px",
                        padding: "6px 10px",
                        border: "none",
                        borderRadius: "4px",
                        background: tool === s.type ? "#333" : "transparent",
                        color: "#fff",
                        cursor: "pointer",
                        fontSize: "13px",
                      }}
                    >
                      <span>{s.label}</span>
                      <span style={{ color: "#888" }}>{s.hint}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {t === "line" && showLineMenu && (
              <div
                ref={lineMenuRef}
                style={{
                  position: "absolute",
                  top: "110%",
                  left: 0,
                  background: "#111",
                  border: "1px solid #444",
                  borderRadius: "6px",
                  padding: "10px",
                  zIndex: 20,
                }}
              >
                {/* Choose the pen: the marker, or the see-through yellow highlighter */}
                <div style={{ display: "flex", gap: "4px", marginBottom: "10px" }}>
                  {[
                    { pen: "line", label: "Marker" },
                    { pen: "highlighter", label: "Highlighter" },
                  ].map(({ pen, label }) => (
                    <button
                      key={pen}
                      onClick={() => switchTool(pen)}
                      style={{
                        flex: 1,
                        padding: "4px 8px",
                        border: "1px solid #444",
                        borderRadius: "4px",
                        background: tool === pen ? "#333" : "transparent",
                        color: "#fff",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* The highlighter is always yellow and thick, so colour and size are marker-only */}
                {tool === "line" && (
                  <StyleMenu
                    color={drawColor}
                    thickness={drawThickness}
                    onPickColor={setDrawColor}
                    onPickThickness={setDrawThickness}
                  />
                )}
              </div>
            )}

            {t === "eraser" && showEraserMenu && (
              <div
                ref={eraserMenuRef}
                style={{
                  position: "absolute",
                  top: "110%",
                  left: 0,
                  background: "#111",
                  border: "1px solid #444",
                  borderRadius: "6px",
                  padding: "10px",
                  zIndex: 20,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="range"
                    min="8"
                    max="80"
                    step="2"
                    value={eraserSize}
                    onChange={(e) => setEraserSize(Number(e.target.value))}
                    style={{ width: "110px", cursor: "pointer" }}
                  />
                  <span style={{ color: "#ccc", fontSize: "12px", width: "32px" }}>{eraserSize}px</span>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* An action, not a tool: opens the computer's file picker. Ctrl+V does the same
            with a picture that's already on the clipboard */}
        <button
          onClick={() => imageInputRef.current?.click()}
          title="Add a picture (or paste one with Ctrl+V)"
          style={{ padding: "6px 10px", border: "1px solid #999", borderRadius: "4px", cursor: "pointer" }}
        >
          Image
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // so picking the same file again still counts as a change
            if (file) addImageFile(file);
          }}
        />

        <button
          onClick={handleUndo}
          disabled={undoStack.length === 0}
          title="Undo (Ctrl+Z)"
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            border: "1px solid #666",
            background: "#1a1a1a",
            color: undoStack.length === 0 ? "#555" : "#fff",
            cursor: undoStack.length === 0 ? "default" : "pointer",
            fontSize: "16px",
          }}
        >
          ←
        </button>
        <button
          onClick={handleRedo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Shift+Z)"
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            border: "1px solid #666",
            background: "#1a1a1a",
            color: redoStack.length === 0 ? "#555" : "#fff",
            cursor: redoStack.length === 0 ? "default" : "pointer",
            fontSize: "16px",
          }}
        >
          →
        </button>

        <button
          onClick={handleDeleteSelected}
          disabled={selectedIds.size === 0}
          title="Delete selected (Del)"
          style={{
            padding: "6px 10px",
            border: "1px solid #999",
            borderRadius: "4px",
            cursor: selectedIds.size === 0 ? "default" : "pointer",
            background: "#1a1a1a",
            color: selectedIds.size === 0 ? "#555" : "#fff",
          }}
        >
          Delete
        </button>

        <button
          onClick={handleConvertSketch}
          disabled={selectedIds.size === 0 || convertingSketch}
          title="Convert selected sketch to a clean diagram"
          style={{
            padding: "6px 10px",
            border: "1px solid #999",
            borderRadius: "4px",
            cursor: selectedIds.size === 0 || convertingSketch ? "default" : "pointer",
            background: "#1a1a1a",
            color: selectedIds.size === 0 || convertingSketch ? "#555" : "#fff",
          }}
        >
          {convertingSketch ? "Converting..." : "Convert"}
        </button>

        <button
          onClick={handleExplainSelection}
          disabled={selectedIds.size === 0 || explaining}
          title="Explain selected area"
          style={{
            padding: "6px 10px",
            border: "1px solid #999",
            borderRadius: "4px",
            cursor: selectedIds.size === 0 || explaining ? "default" : "pointer",
            background: "#1a1a1a",
            color: selectedIds.size === 0 || explaining ? "#555" : "#fff",
          }}
        >
          {explaining ? "Explaining..." : "Explain"}
        </button>

        <button
          onClick={handleSave}
          title="Save board"
          style={{
            padding: "6px 10px",
            border: "1px solid #999",
            borderRadius: "4px",
            cursor: "pointer",
            background: "#1a1a1a",
            color: "#fff",
          }}
        >
          Save
        </button>
        <button
          onClick={handleLoad}
          title="Load board"
          style={{
            padding: "6px 10px",
            border: "1px solid #999",
            borderRadius: "4px",
            cursor: "pointer",
            background: "#1a1a1a",
            color: "#fff",
          }}
        >
          Load
        </button>

        <span style={{ width: "1px", background: "#444", alignSelf: "stretch", margin: "0 2px" }} />

        <span
          title="This board's name"
          style={{ color: "#ddd", fontSize: "13px", fontFamily: "sans-serif", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {boardId}
        </span>
        <button
          onClick={handleLeaveBoard}
          title="Back to your boards"
          style={{
            padding: "6px 10px",
            borderRadius: "4px",
            border: "1px solid #999",
            cursor: "pointer",
            background: "#1a1a1a",
            color: "#fff",
          }}
        >
          Boards
        </button>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: "10px",
          left: "10px",
          zIndex: 30,
          display: "flex",
          gap: "8px",
          background: "rgba(17,17,17,0.85)",
          padding: "8px",
          borderRadius: "8px",
        }}
      >
        <input
          type="text"
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleGenerate();
          }}
          placeholder="Describe a diagram to generate..."
          disabled={generating}
          style={{
            width: "280px",
            padding: "6px 10px",
            borderRadius: "4px",
            border: "1px solid #666",
            background: "#111",
            color: "#fff",
            fontSize: "13px",
          }}
        />
        <button
          onClick={handleGenerate}
          disabled={generating || !aiPrompt.trim()}
          style={{
            padding: "6px 10px",
            borderRadius: "4px",
            border: "1px solid #999",
            cursor: generating || !aiPrompt.trim() ? "default" : "pointer",
            background: "#1a1a1a",
            color: generating ? "#555" : "#fff",
          }}
        >
          {generating ? "Generating..." : "Generate"}
        </button>
      </div>

      {explainPanel && (
        <div
          style={{
            position: "absolute",
            top: "10px",
            right: "10px",
            zIndex: 30,
            width: "300px",
            background: "rgba(17,17,17,0.95)",
            border: "1px solid #444",
            borderRadius: "8px",
            padding: "10px 12px",
            color: "#ddd",
            fontFamily: "sans-serif",
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
            <strong style={{ color: "#fff" }}>AI Explanation</strong>
            <button
              onClick={() => setExplainPanel(null)}
              title="Close"
              style={{ background: "none", border: "none", color: "#999", cursor: "pointer", fontSize: "16px", lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </div>
          {explainPanel.text}
        </div>
      )}

      {saveStatus && (
        <div
          style={{
            position: "absolute",
            top: "56px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: "rgba(17,17,17,0.9)",
            color: "#ddd",
            fontFamily: "sans-serif",
            fontSize: "13px",
            padding: "4px 12px",
            borderRadius: "6px",
          }}
        >
          {saveStatus}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          bottom: "10px",
          right: "10px",
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: "4px",
          background: "rgba(17,17,17,0.85)",
          padding: "6px",
          borderRadius: "8px",
        }}
      >
        <button
          onClick={() => zoomFromCenter(1 / 1.25)}
          disabled={view.scale <= MIN_ZOOM}
          title="Zoom out (Ctrl + scroll)"
          style={{ width: "28px", height: "28px", borderRadius: "4px", border: "1px solid #666", background: "#1a1a1a", color: "#fff", cursor: "pointer" }}
        >
          −
        </button>
        <button
          onClick={() => zoomFromCenter(1 / view.scale)}
          title="Reset to 100%"
          style={{ width: "52px", height: "28px", borderRadius: "4px", border: "none", background: "transparent", color: "#ddd", cursor: "pointer", fontSize: "12px" }}
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button
          onClick={() => zoomFromCenter(1.25)}
          disabled={view.scale >= MAX_ZOOM}
          title="Zoom in (Ctrl + scroll)"
          style={{ width: "28px", height: "28px", borderRadius: "4px", border: "1px solid #666", background: "#1a1a1a", color: "#fff", cursor: "pointer" }}
        >
          +
        </button>
      </div>

      <div ref={stageContainerRef} style={{ position: "absolute", inset: 0 }}>
        <Stage
          ref={stageRef}
          width={canvasSize.width}
          height={canvasSize.height}
          scaleX={view.scale}
          scaleY={view.scale}
          x={view.x}
          y={view.y}
          draggable={tool === "hand"}
          onDragMove={handleStagePan}
          onDragEnd={handleStagePan}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          style={{
            backgroundColor: "#000000",
            cursor:
              tool === "text"
                ? "text"
                : tool === "eraser"
                ? "none"
                : tool === "select"
                ? "default"
                : tool === "hand"
                ? "grab"
                : "crosshair",
          }}
        >
          <Layer>
            {shapes.map(renderShape)}
            <Transformer
              ref={trRef}
              enabledAnchors={selectedIsImage ? RESIZE_CORNERS : RESIZE_ALL_SIDES}
              boundBoxFunc={(oldBox, newBox) => {
                if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5) return oldBox;
                return newBox;
              }}
            />
            {marquee && (
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.width}
                height={marquee.height}
                fill="rgba(100,210,255,0.15)"
                stroke="#64D2FF"
                strokeWidth={1}
                dash={[4, 4]}
                listening={false}
              />
            )}
            {tool === "eraser" && eraserPos && (
              <Circle
                x={eraserPos.x}
                y={eraserPos.y}
                radius={eraserSize / 2}
                stroke="#ffffff"
                strokeWidth={1}
                dash={[4, 4]}
                listening={false}
              />
            )}
          </Layer>
        </Stage>

        {shapeMenu && (
          <div
            ref={shapeMenuRef}
            style={{
              position: "absolute",
              left: toScreen(shapeMenu).x,
              top: toScreen(shapeMenu).y,
              background: "#111",
              border: "1px solid #444",
              borderRadius: "6px",
              padding: "10px",
              zIndex: 20,
            }}
          >
            <StyleMenu
              color={shapeMenu.color}
              thickness={shapeMenu.thickness}
              onPickColor={(color) => applyShapeStyle({ color })}
              onPickThickness={(thickness) => applyShapeStyle({ thickness })}
            />
            <div style={{ color: "#888", fontSize: "11px", marginTop: "8px", fontFamily: "sans-serif" }}>
              {shapes.find((s) => s.id === shapeMenu.shapeId)?.type === "table"
                ? "Tip: double-click a cell to type in it"
                : "Tip: double-click it to add a label"}
            </div>
          </div>
        )}

        {selectedTable && !textEditor && (
          <div
            style={{
              position: "absolute",
              left: toScreen(getShapeBounds(selectedTable)).x,
              top: toScreen({ x: 0, y: getShapeBounds(selectedTable).y + getShapeBounds(selectedTable).height }).y + 8,
              display: "flex",
              gap: "4px",
              zIndex: 20,
            }}
          >
            {[
              { label: "+ Row", rows: 1, cols: 0 },
              { label: "− Row", rows: -1, cols: 0 },
              { label: "+ Column", rows: 0, cols: 1 },
              { label: "− Column", rows: 0, cols: -1 },
            ].map((b) => (
              <button
                key={b.label}
                onClick={() => resizeTable(selectedTable, b.rows, b.cols)}
                style={{
                  padding: "4px 8px",
                  background: "#111",
                  color: "#fff",
                  border: "1px solid #444",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "12px",
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}

        {textEditor && (
          <div
            style={{
              position: "absolute",
              left: toScreen(textEditor).x,
              top: toScreen(textEditor).y,
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              zIndex: 10,
            }}
          >
            {/* A label always matches its shape's outline colour, so no colour picker for labels */}
            {!textEditor.isLabel && (
              <div style={{ display: "flex", gap: "6px" }}>
                {PALETTE.map((color) => (
                  <button
                    key={color}
                    onClick={() => setTextEditor((prev) => ({ ...prev, color }))}
                    title={color}
                    style={{
                      width: "18px",
                      height: "18px",
                      borderRadius: "50%",
                      background: color,
                      border: textEditor.color === color ? "2px solid white" : "1px solid #666",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              autoFocus
              value={textEditor.value}
              onChange={(e) => setTextEditor((prev) => ({ ...prev, value: e.target.value }))}
              style={{
                width: `${textEditor.width * view.scale}px`,
                height: `${textEditor.height * view.scale}px`,
                resize: "both",
                overflow: "auto",
                background: textEditor.background || "#111111",
                color: textEditor.color,
                border: `1px solid ${textEditor.color}`,
                borderRadius: "4px",
                fontSize: `${(textEditor.fontSize || 18) * view.scale}px`,
                fontFamily: "sans-serif",
                padding: "4px",
              }}
            />

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={confirmText} style={{ cursor: "pointer" }}>
                {shapes.some((s) => s.id === textEditor.id) ? "Save" : "Add"}
              </button>
              <button onClick={cancelText} style={{ cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
