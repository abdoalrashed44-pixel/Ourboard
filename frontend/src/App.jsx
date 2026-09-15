import { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import { Stage, Layer, Rect, Ellipse, Line, Text, Circle, Transformer } from 'react-konva';
import './App.css';

// VITE_BACKEND_URL is set in Vercel's dashboard once the backend is deployed; localhost
// stays the default so local dev keeps working without needing that env var.
const socket = io(import.meta.env.VITE_BACKEND_URL || "http://localhost:5000");

const TOOLS = ["select", "rect", "circle", "line", "text", "eraser"];

// Five colors chosen to stay readable against the black canvas background — shared by
// every tool (rect/circle/line stroke, and text)
const PALETTE = ["#FFFFFF", "#FFD60A", "#64D2FF", "#32D74B", "#FF9F0A"];

// A shape's bounding box in canvas coordinates — used by both the eraser (does the eraser
// circle overlap this shape?) and the marquee select (is this shape inside the drag box?).
// Lines don't have a meaningful width/height, so their box comes from their actual points.
function getShapeBounds(shape) {
  if (shape.type === "line") {
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

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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

function App() {
  // "connected" | "reconnecting" | "disconnected"
  const [connectionStatus, setConnectionStatus] = useState("connected");
  const hasDisconnectedOnce = useRef(false);
  const [currentBoardId, setCurrentBoardId] = useState("main");
  const [boardNameInput, setBoardNameInput] = useState("main");
  const [switchingBoard, setSwitchingBoard] = useState(false);
  const [shapes, setShapes] = useState([]);
  const [tool, setTool] = useState("rect");
  // A Set of shape ids, file-explorer style: plain click replaces it, Ctrl/Cmd/Shift-click
  // toggles one id in or out, drag-select (marquee) replaces or adds a whole batch at once
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Style new rect/circle/line shapes are drawn with — changed via either style menu below
  const [drawColor, setDrawColor] = useState(PALETTE[0]);
  const [drawThickness, setDrawThickness] = useState(2);
  const [showLineMenu, setShowLineMenu] = useState(false);
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
  const eraserMenuRef = useRef(null);
  const shapeMenuRef = useRef(null);
  // Tool that was active before the user started holding Ctrl, so releasing it restores it
  const preSelectTool = useRef(null);
  // Trails behind the raw cursor position while drawing a line — this is what smooths
  // freehand strokes and gives them a slight, deliberate lag
  const smoothPos = useRef({ x: 0, y: 0 });
  const stageContainerRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  // Marquee-select bookkeeping: where the drag started, and whether it should ADD to the
  // current selection (Ctrl/Shift held) rather than replace it
  const marqueeStart = useRef(null);
  const marqueeAdditive = useRef(false);
  // While dragging one shape that's part of a multi-selection, holds every selected
  // shape's on-screen position at the moment the drag started, so the others can be
  // moved by the same live delta
  const groupDragStart = useRef({});

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
      // replay whatever shape events we missed while offline. If it didn't (too long offline,
      // or the server itself restarted), our board may be stale — Load is the manual fallback.
      flashStatus(
        socket.recovered ? "Reconnected — you're back in sync" : "Reconnected — click Load if your board looks out of date"
      );
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

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.io.off("reconnect_attempt");
      socket.off("shape:add");
      socket.off("shape:update");
      socket.off("shape:delete");
      socket.off("board:sync");
    };
  }, []);

  // Attach the resize handles, but only when exactly one resizable shape (rect/circle/text)
  // is selected. Multiple shapes, or a line, just get the plain selection highlight instead.
  useEffect(() => {
    if (!trRef.current) return;
    if (selectedIds.size !== 1) {
      trRef.current.nodes([]);
      trRef.current.getLayer()?.batchDraw();
      return;
    }
    const id = [...selectedIds][0];
    const shape = shapes.find((s) => s.id === id);
    const canResize = shape && (shape.type === "rect" || shape.type === "circle" || shape.type === "text");
    trRef.current.nodes(canResize && shapeRefs.current[id] ? [shapeRefs.current[id]] : []);
    trRef.current.getLayer()?.batchDraw();
  }, [selectedIds, shapes]);

  // Close the line/eraser/shape style menus on any click outside them
  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (showLineMenu && lineMenuRef.current && !lineMenuRef.current.contains(e.target)) {
        setShowLineMenu(false);
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
  }, [showLineMenu, showEraserMenu, shapeMenu]);

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
    applyDiff(action.added, action.removed); // reverse: delete what it added, restore what it removed
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

  // Switches to a different board by name, creating it if it doesn't exist yet. Replaces
  // the whole canvas with that board's saved shapes, same as loading — switching boards
  // and opening one are the same action from the user's point of view.
  const handleSwitchBoard = () => {
    const id = boardNameInput.trim();
    if (!id || switchingBoard) return;
    setSwitchingBoard(true);
    socket.emit("board:join", id, (response) => {
      setSwitchingBoard(false);
      if (response.success) {
        setCurrentBoardId(response.boardId);
        setBoardNameInput(response.boardId);
        setShapes(dedupeShapes(response.shapes));
        setUndoStack([]);
        setRedoStack([]);
        setSelectedIds(new Set());
        flashStatus(`Switched to board "${response.boardId}"`);
      } else {
        flashStatus(`Switch failed: ${response.error}`);
      }
    });
  };

  const handleGenerate = () => {
    if (!aiPrompt.trim() || generating) return;
    setGenerating(true);
    socket.emit("board:generate", aiPrompt, (response) => {
      setGenerating(false);
      if (response.success) {
        setShapes((prev) => [...prev, ...response.shapes]);
        pushUndo([], response.shapes);
        setAiPrompt("");
        flashStatus(`Generated ${response.shapes.length} shape${response.shapes.length === 1 ? "" : "s"}`);
      } else {
        flashStatus(`Generation failed: ${response.error}`);
      }
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
    const dataUrl = stage.toDataURL({ x: left, y: top, width, height, mimeType: "image/png" });
    hiddenIds.forEach((id) => shapeRefs.current[id]?.show());
    trRef.current?.show();
    stage.batchDraw();

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
      const added = response.shapes.map((s) => ({
        ...s,
        x: s.x + left,
        y: s.y + top,
        points: s.type === "line" ? s.points.map((v, i) => (i % 2 === 0 ? v + left : v + top)) : s.points,
        createdBy: socket.id,
      }));
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
    if (t !== "line") setShowLineMenu(false);
    if (t !== "eraser") setShowEraserMenu(false);
  };

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
    const hits = shapes.filter((s) => rectsIntersect(eraserBounds, getShapeBounds(s)));
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
        toAdd.push({ ...shape, id: `shape_${crypto.randomUUID()}`, points });
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

  // Scroll wheel resizes the eraser while it's the active tool — scroll up to grow it,
  // down to shrink it, same 8-80px range as the slider (they control the same state)
  const handleWheel = (e) => {
    if (tool !== "eraser") return;
    e.evt.preventDefault();
    const step = e.evt.deltaY < 0 ? 4 : -4;
    setEraserSize((prev) => Math.min(80, Math.max(8, prev + step)));
  };

  const handleMouseDown = (e) => {
    const pos = e.target.getStage().getPointerPosition();

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

    drawingShapeId.current = id;
    isDrawing.current = true;
    smoothPos.current = { x: pos.x, y: pos.y };

    // Add a zero-size shape immediately so it grows under the cursor as we drag
    setShapes((prev) => [
      ...prev,
      {
        id,
        type: tool,
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
        stroke: drawColor,
        strokeWidth: drawThickness,
        fill: "transparent",
        points: tool === "line" ? [pos.x, pos.y] : [],
        text: "",
        createdBy: socket.id,
      },
    ]);
  };

  const handleMouseMove = (e) => {
    const pos = e.target.getStage().getPointerPosition();

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
        const hitIds = shapes.filter((s) => rectsIntersect(box, getShapeBounds(s))).map((s) => s.id);
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
    const finishedShape = shapes.find((shape) => shape.id === drawingShapeId.current);
    if (finishedShape) {
      socket.emit("shape:add", finishedShape);
      pushUndo([], [finishedShape]);

      // Rect/circle get a style menu right after placement so you can tweak color/thickness
      if (finishedShape.type === "rect" || finishedShape.type === "circle") {
        setShapeMenu({
          shapeId: finishedShape.id,
          x: finishedShape.x + Math.max(0, finishedShape.width),
          y: finishedShape.y + Math.max(0, finishedShape.height),
          color: finishedShape.stroke,
          thickness: finishedShape.strokeWidth,
        });
      }
    }
    drawingShapeId.current = null;
  };

  // Actually commits a shape's new position to state + the socket, given its Konva node.
  // Shared by single-shape drags and every shape in a multi-select group drag.
  const commitDrag = (shape, node) => {
    if (shape.type === "line") {
      const dx = node.x();
      const dy = node.y();
      const newPoints = shape.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
      node.position({ x: 0, y: 0 });
      const updated = { ...shape, points: newPoints };
      setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
      socket.emit("shape:update", updated);
      return;
    }
    const updated =
      shape.type === "circle"
        ? { ...shape, x: node.x() - shape.width / 2, y: node.y() - shape.height / 2 }
        : { ...shape, x: node.x(), y: node.y() };
    setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
    socket.emit("shape:update", updated);
  };

  // If you start dragging a shape that isn't part of the current multi-selection, it just
  // becomes the new (solo) selection and moves alone. Otherwise, record every selected
  // shape's starting position so they can all be moved by the same delta as you drag.
  const handleShapeDragStart = (shape) => () => {
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
  // Konva node by the same delta, directly — no React re-render needed until drag end
  const handleShapeDragMove = (shape) => (e) => {
    const start = groupDragStart.current[shape.id];
    if (!start) return;
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
  };

  const handleShapeDragEnd = (shape) => (e) => {
    const groupIds = Object.keys(groupDragStart.current);
    if (groupIds.length > 0) {
      groupIds.forEach((id) => {
        const s = shapes.find((sh) => sh.id === id);
        const node = shapeRefs.current[id];
        if (s && node) commitDrag(s, node);
      });
      groupDragStart.current = {};
      return;
    }
    commitDrag(shape, e.target);
  };

  // Transformer resize reports a scale factor, not a new width/height — apply it to our
  // stored size (and font size, for text), then reset the node's internal scale back to 1
  const handleTransformEnd = (shape) => (e) => {
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);

    if (shape.type === "text") {
      const avgScale = (scaleX + scaleY) / 2;
      const updated = {
        ...shape,
        x: node.x(),
        y: node.y(),
        width: Math.max(20, shape.width * scaleX),
        fontSize: Math.max(8, (shape.fontSize || 18) * avgScale),
      };
      setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
      socket.emit("shape:update", updated);
      return;
    }

    const newWidth = shape.width * scaleX;
    const newHeight = shape.height * scaleY;
    const updated =
      shape.type === "circle"
        ? { ...shape, x: node.x() - newWidth / 2, y: node.y() - newHeight / 2, width: newWidth, height: newHeight }
        : { ...shape, x: node.x(), y: node.y(), width: newWidth, height: newHeight };

    setShapes((prev) => prev.map((s) => (s.id === shape.id ? updated : s)));
    socket.emit("shape:update", updated);
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

  const confirmText = () => {
    if (!textEditor || !textEditor.value.trim()) {
      setTextEditor(null);
      return;
    }
    // Read the box's current on-screen size, since the user may have dragged to resize it
    const el = textareaRef.current;
    const width = el ? el.offsetWidth : textEditor.width;
    const height = el ? el.offsetHeight : textEditor.height;

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
      createdBy: socket.id,
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

  const renderShape = (shape) => {
    const selectable = tool === "select";
    const isSelected = selectedIds.has(shape.id);
    // Every shape type is clickable/draggable/highlightable the same way — only the
    // Konva element and its shape-specific props differ below
    const commonProps = {
      key: shape.id,
      ref: (node) => (shapeRefs.current[shape.id] = node),
      draggable: selectable,
      onClick: handleSelect(shape.id),
      onTap: handleSelect(shape.id),
      onDragStart: handleShapeDragStart(shape),
      onDragMove: handleShapeDragMove(shape),
      onDragEnd: handleShapeDragEnd(shape),
      shadowColor: "#ffffff",
      shadowBlur: isSelected ? 10 : 0,
      shadowOpacity: isSelected ? 0.8 : 0,
    };

    switch (shape.type) {
      case "rect":
        return (
          <Rect
            {...commonProps}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth || 2}
            fill={shape.fill}
            onTransformEnd={handleTransformEnd(shape)}
          />
        );
      // Circle tool draws a bounding box, same drag gesture as rect, fitted with an ellipse
      case "circle":
        return (
          <Ellipse
            {...commonProps}
            x={shape.x + shape.width / 2}
            y={shape.y + shape.height / 2}
            radiusX={Math.abs(shape.width / 2)}
            radiusY={Math.abs(shape.height / 2)}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth || 2}
            fill={shape.fill}
            onTransformEnd={handleTransformEnd(shape)}
          />
        );
      case "line":
        return (
          <Line
            {...commonProps}
            points={shape.points}
            stroke={shape.stroke}
            strokeWidth={shape.strokeWidth || 2}
            lineCap="round"
            lineJoin="round"
            tension={0.55}
          />
        );
      case "text":
        return (
          <Text
            {...commonProps}
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
          background: "rgba(17,17,17,0.75)",
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
          zIndex: 30,
          display: "flex",
          gap: "8px",
          background: "rgba(17,17,17,0.85)",
          padding: "8px",
          borderRadius: "8px",
        }}
      >
        {TOOLS.map((t) => (
          <div key={t} style={{ position: "relative" }}>
            <button
              onClick={() => {
                switchTool(t);
                if (t === "line") setShowLineMenu(true);
                if (t === "eraser") setShowEraserMenu(true);
              }}
              style={{
                padding: "6px 14px",
                fontWeight: tool === t ? "bold" : "normal",
                border: tool === t ? "2px solid #333" : "1px solid #999",
                borderRadius: "4px",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t}
            </button>

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
                <StyleMenu
                  color={drawColor}
                  thickness={drawThickness}
                  onPickColor={setDrawColor}
                  onPickThickness={setDrawThickness}
                />
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
            padding: "6px 14px",
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
            padding: "6px 14px",
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
            padding: "6px 14px",
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
            padding: "6px 14px",
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
            padding: "6px 14px",
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

        <input
          type="text"
          value={boardNameInput}
          onChange={(e) => setBoardNameInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSwitchBoard();
          }}
          disabled={switchingBoard}
          title="Board name"
          style={{
            width: "90px",
            padding: "6px 8px",
            borderRadius: "4px",
            border: "1px solid #666",
            background: "#111",
            color: "#fff",
            fontSize: "13px",
          }}
        />
        <button
          onClick={handleSwitchBoard}
          disabled={switchingBoard || !boardNameInput.trim() || boardNameInput.trim() === currentBoardId}
          title="Switch to (or create) this board"
          style={{
            padding: "6px 14px",
            borderRadius: "4px",
            border: "1px solid #999",
            cursor:
              switchingBoard || !boardNameInput.trim() || boardNameInput.trim() === currentBoardId
                ? "default"
                : "pointer",
            background: "#1a1a1a",
            color: switchingBoard || !boardNameInput.trim() || boardNameInput.trim() === currentBoardId ? "#555" : "#fff",
          }}
        >
          {switchingBoard ? "..." : "Switch"}
        </button>
      </div>

      <div
        style={{
          position: "absolute",
          top: "48px",
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
            padding: "6px 14px",
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

      <div ref={stageContainerRef} style={{ position: "absolute", inset: 0 }}>
        <Stage
          ref={stageRef}
          width={canvasSize.width}
          height={canvasSize.height}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          style={{
            backgroundColor: "#000000",
            cursor:
              tool === "text" ? "text" : tool === "eraser" ? "none" : tool === "select" ? "default" : "crosshair",
          }}
        >
          <Layer>
            {/* Real pixel fill, not just CSS — so an exported image (used by AI sketch
                conversion) has an actual black background instead of transparent */}
            <Rect
              x={0}
              y={0}
              width={canvasSize.width}
              height={canvasSize.height}
              fill="#000000"
              listening={false}
            />
            {shapes.map(renderShape)}
            <Transformer
              ref={trRef}
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
              left: shapeMenu.x,
              top: shapeMenu.y,
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
          </div>
        )}

        {textEditor && (
          <div
            style={{
              position: "absolute",
              left: textEditor.x,
              top: textEditor.y,
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              zIndex: 10,
            }}
          >
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

            <textarea
              ref={textareaRef}
              autoFocus
              value={textEditor.value}
              onChange={(e) => setTextEditor((prev) => ({ ...prev, value: e.target.value }))}
              style={{
                width: `${textEditor.width}px`,
                height: `${textEditor.height}px`,
                resize: "both",
                overflow: "auto",
                background: "#111111",
                color: textEditor.color,
                border: `1px solid ${textEditor.color}`,
                borderRadius: "4px",
                fontSize: "18px",
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
