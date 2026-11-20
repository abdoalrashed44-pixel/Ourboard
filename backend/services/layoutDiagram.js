import { randomUUID } from 'crypto';

// Turns the AI's diagram *content* (nodes and edges, no coordinates) into board shapes in
// the app's one shape format. The layout is done here by our own code because AI models
// are unreliable at pixel coordinates. Diagrams are laid out around 0,0; the browser then
// moves the whole diagram into empty space on the board.

const WHITE = '#FFFFFF';
const GREEN = '#32D74B';
const YELLOW = '#FFD60A';
const BLUE = '#64D2FF';

const FONT_SIZE = 18;
const CHAR_WIDTH = 9.5; // rough width of one character at FONT_SIZE, for sizing boxes
const LINE_HEIGHT = 22;

// How each flowchart step type is drawn. textShare = how much of the box's width the label
// may use (a diamond's text has to stay inside its narrow middle)
const FLOW_NODE_STYLES = {
  start: { shape: 'pill', stroke: GREEN, minWidth: 140, maxWidth: 220, minHeight: 56 },
  end: { shape: 'pill', stroke: GREEN, minWidth: 140, maxWidth: 220, minHeight: 56 },
  process: { shape: 'rect', stroke: WHITE, minWidth: 170, maxWidth: 260, minHeight: 64 },
  decision: { shape: 'diamond', stroke: YELLOW, minWidth: 200, maxWidth: 300, minHeight: 110, textShare: 0.6 },
  io: { shape: 'parallelogram', stroke: WHITE, minWidth: 190, maxWidth: 280, minHeight: 64, textShare: 0.7 },
  database: { shape: 'cylinder', stroke: WHITE, minWidth: 140, maxWidth: 220, minHeight: 100 },
};

const ROW_GAP = 70;
const COLUMN_GAP = 70;
const LANE_GAP = 50; // distance from the diagram's edge to the first side lane for routed arrows
const LANE_SPACING = 35; // distance between neighbouring side lanes

// How far in from its box a shape's left/right side is at mid-height, so arrows touch the
// outline. A parallelogram's sides slant inwards; the slant matches getParallelogramSlant
// in the frontend, which draws it
function sideInset(shapeType, width, height) {
  return shapeType === 'parallelogram' ? Math.min(width * 0.25, height * 0.5) / 2 : 0;
}

// A shape in the board's normal format, with safe defaults for anything not given
function makeShape(fields) {
  return {
    id: `shape_${randomUUID()}`,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    stroke: WHITE,
    strokeWidth: 2,
    fill: 'transparent',
    points: [],
    text: '',
    fontSize: FONT_SIZE,
    createdBy: 'ai',
    ...fields,
  };
}

// How big a box must be for its label: wider for longer labels (up to a limit), then
// taller if the text still has to wrap onto more lines
function sizeForLabel(label, { minWidth, maxWidth, minHeight, textShare = 1 }) {
  const textWidth = label.length * CHAR_WIDTH;
  const width = Math.min(maxWidth, Math.max(minWidth, textWidth / textShare + 40));
  const usableWidth = width * textShare - 30;
  const lines = Math.max(1, Math.ceil(textWidth / usableWidth));
  return { width, height: Math.max(minHeight, lines * LINE_HEIGHT + 30) };
}

// --- Flowchart -------------------------------------------------------------------------

function layoutFlowchart(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => outgoing.get(e.from).push(e));

  // 1. Find loops. Walk the chart from Start, going as deep as possible first. An edge
  //    that leads back to a step still on the path we're walking is a loop, like
  //    "wrong password → go back to Enter details". Loops are drawn around the side later
  const start = nodes.find((n) => n.type === 'start') || nodes[0];
  const state = new Map(); // id → 'walking' while on the current path, 'done' after
  const loopEdges = new Set();
  const discovered = []; // the order steps were first reached, used to keep rows tidy
  const walk = (id) => {
    state.set(id, 'walking');
    discovered.push(id);
    for (const edge of outgoing.get(id)) {
      const seen = state.get(edge.to);
      if (seen === 'walking') loopEdges.add(edge);
      else if (!seen) walk(edge.to);
    }
    state.set(id, 'done');
  };
  walk(start.id);
  nodes.forEach((n) => {
    if (!state.has(n.id)) walk(n.id); // steps that nothing leads to from Start
  });

  // 2. Rows. Every step goes at least one row below each step that leads into it, so all
  //    arrows except loops point downward. Keep pushing steps down until nothing changes
  const forwardEdges = edges.filter((e) => !loopEdges.has(e));
  const rowOf = new Map(discovered.map((id) => [id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of forwardEdges) {
      if (rowOf.get(e.to) < rowOf.get(e.from) + 1) {
        rowOf.set(e.to, rowOf.get(e.from) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = [];
  discovered.forEach((id) => {
    const r = rowOf.get(id);
    (rows[r] = rows[r] || []).push(id);
  });

  // 3. Positions, row by row from the top. Inside a row, steps are ordered by where the
  //    steps leading into them sit, so branches stay on their own side and arrows cross
  //    less. Each row is centred on x = 0
  const boxes = new Map(); // id → { x, y, width, height }
  const centreX = (id) => boxes.get(id).x + boxes.get(id).width / 2;
  let y = 0;
  rows.filter(Boolean).forEach((ids) => {
    const parentAverage = (id) => {
      const parents = forwardEdges.filter((e) => e.to === id && boxes.has(e.from)).map((e) => centreX(e.from));
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 0;
    };
    ids.sort((a, b) => parentAverage(a) - parentAverage(b));

    const sizes = ids.map((id) => sizeForLabel(byId.get(id).label, FLOW_NODE_STYLES[byId.get(id).type]));
    const rowWidth = sizes.reduce((sum, s) => sum + s.width, 0) + COLUMN_GAP * (ids.length - 1);
    const rowHeight = Math.max(...sizes.map((s) => s.height));
    let x = -rowWidth / 2;
    ids.forEach((id, i) => {
      boxes.set(id, { x, y: y + (rowHeight - sizes[i].height) / 2, ...sizes[i] });
      x += sizes[i].width + COLUMN_GAP;
    });
    y += rowHeight + ROW_GAP;
  });

  // node id → the board shape drawn for it, so each arrow can record which shapes it joins
  const nodeShapes = new Map(
    nodes.map((n) => {
      const style = FLOW_NODE_STYLES[n.type];
      return [n.id, makeShape({ type: style.shape, stroke: style.stroke, text: n.label, ...boxes.get(n.id) })];
    })
  );
  const shapes = [...nodeShapes.values()];

  // 4. Arrows. Into the very next row: straight down, bottom-middle to top-middle.
  //    Skipping rows: around the left side, so it doesn't cut through the steps in between.
  //    Loops: around the right side, back up to the earlier step
  const all = [...boxes.values()];
  const diagramLeft = Math.min(...all.map((b) => b.x));
  const diagramRight = Math.max(...all.map((b) => b.x + b.width));
  let leftLanes = 0;
  let rightLanes = 0;
  edges.forEach((e) => {
    const from = boxes.get(e.from);
    const to = boxes.get(e.to);
    const fromMiddleY = from.y + from.height / 2;
    const toMiddleY = to.y + to.height / 2;
    const fromInset = sideInset(FLOW_NODE_STYLES[byId.get(e.from).type].shape, from.width, from.height);
    const toInset = sideInset(FLOW_NODE_STYLES[byId.get(e.to).type].shape, to.width, to.height);
    let points;
    if (loopEdges.has(e)) {
      const laneX = diagramRight + LANE_GAP + LANE_SPACING * rightLanes++;
      points = [
        from.x + from.width - fromInset, fromMiddleY,
        laneX, fromMiddleY,
        laneX, toMiddleY,
        to.x + to.width - toInset, toMiddleY,
      ];
    } else if (rowOf.get(e.to) - rowOf.get(e.from) > 1) {
      const laneX = diagramLeft - LANE_GAP - LANE_SPACING * leftLanes++;
      points = [
        from.x + fromInset, fromMiddleY,
        laneX, fromMiddleY,
        laneX, toMiddleY,
        to.x + toInset, toMiddleY,
      ];
    } else {
      points = [from.x + from.width / 2, from.y + from.height, to.x + to.width / 2, to.y];
    }
    // from / to attach the arrow to its two shapes, so it follows them when they're moved
    const ends = { from: nodeShapes.get(e.from).id, to: nodeShapes.get(e.to).id };
    shapes.push(makeShape({ type: 'arrow', points, text: e.label, fontSize: 14, dashed: false, ...ends }));
  });

  return shapes;
}

// --- Use case diagram ------------------------------------------------------------------

const USE_CASE_SIZE = { minWidth: 200, maxWidth: 280, minHeight: 70, textShare: 0.76 };
const ACTOR_WIDTH = 70;
const ACTOR_HEIGHT = 130;
const ACTOR_GAP = 130; // space between an actor and the system boundary
const BOUNDARY_PADDING = 40;
const BOUNDARY_TITLE_SPACE = 50;
const CASE_GAP = 60; // room between ovals for a labelled «include» / «extend» arrow

// Where a line from an oval's centre towards point (px, py) crosses the oval's edge, so
// lines start and stop exactly on the outline instead of at the centre
function ovalEdgePoint(box, px, py) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const t = 1 / Math.sqrt((dx * dx) / ((box.width / 2) ** 2) + (dy * dy) / ((box.height / 2) ** 2));
  return [cx + dx * t, cy + dy * t];
}

// Where a line attaches to an actor: the side facing the other end, at arm height
function actorEdgePoint(box, px) {
  const armY = box.y + box.height * 0.26;
  return px < box.x + box.width / 2 ? [box.x, armY] : [box.x + box.width, armY];
}

function layoutUseCase(title, nodes, edges) {
  const actors = nodes.filter((n) => n.type === 'actor');
  const useCases = nodes.filter((n) => n.type === 'usecase');
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Order the use cases so each one sits right next to any use case it «include»s or
  // «extend»s — then those dashed arrows are short and don't cross other ovals
  const related = edges.filter((e) => e.style === 'include' || e.style === 'extend');
  const ordered = [];
  const place = (id) => {
    if (ordered.includes(id) || byId.get(id)?.type !== 'usecase') return;
    ordered.push(id);
    related.filter((e) => e.from === id).forEach((e) => place(e.to));
    related.filter((e) => e.to === id).forEach((e) => place(e.from));
  };
  useCases.forEach((u) => place(u.id));

  // Use cases stack inside the boundary: one column, or two when there are many
  const columns = ordered.length > 6 ? 2 : 1;
  const perColumn = Math.ceil(ordered.length / columns);
  const sizes = new Map(ordered.map((id) => [id, sizeForLabel(byId.get(id).label, USE_CASE_SIZE)]));
  const columnWidth = Math.max(...[...sizes.values()].map((s) => s.width));
  const boxes = new Map();
  let tallestColumn = 0;
  for (let c = 0; c < columns; c++) {
    let y = BOUNDARY_TITLE_SPACE;
    ordered.slice(c * perColumn, (c + 1) * perColumn).forEach((id) => {
      const size = sizes.get(id);
      const columnX = BOUNDARY_PADDING + c * (columnWidth + COLUMN_GAP);
      boxes.set(id, { x: columnX + (columnWidth - size.width) / 2, y, ...size });
      y += size.height + CASE_GAP;
    });
    tallestColumn = Math.max(tallestColumn, y - CASE_GAP);
  }
  const boundary = {
    x: 0,
    y: 0,
    width: BOUNDARY_PADDING * 2 + columns * columnWidth + (columns - 1) * COLUMN_GAP,
    height: tallestColumn + BOUNDARY_PADDING,
  };

  // Actors stand outside the boundary: one on the left, two split left and right, and so
  // on. Each actor stands with its arms level with the middle of the use cases it's linked
  // to, so its lines run as flat as possible
  const armLevel = ACTOR_HEIGHT * 0.26; // matches actorEdgePoint
  const linkedMiddleY = (actorId) => {
    const ys = edges
      .filter((e) => e.from === actorId || e.to === actorId)
      .map((e) => (e.from === actorId ? e.to : e.from))
      .filter((id) => byId.get(id).type === 'usecase')
      .map((id) => boxes.get(id).y + boxes.get(id).height / 2);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : boundary.height / 2;
  };
  const leftCount = actors.length >= 2 ? Math.ceil(actors.length / 2) : actors.length;
  [actors.slice(0, leftCount), actors.slice(leftCount)].forEach((side, sideIndex) => {
    const x = sideIndex === 0 ? -ACTOR_GAP - ACTOR_WIDTH : boundary.width + ACTOR_GAP;
    // Top to bottom by where each actor wants to stand, then push any that would overlap
    // the one above further down
    const wanted = side
      .map((actor) => ({ actor, y: linkedMiddleY(actor.id) - armLevel }))
      .sort((a, b) => a.y - b.y);
    wanted.forEach((w, i) => {
      if (i > 0) w.y = Math.max(w.y, wanted[i - 1].y + ACTOR_HEIGHT + 40);
      boxes.set(w.actor.id, { x, y: w.y, width: ACTOR_WIDTH, height: ACTOR_HEIGHT });
    });
  });

  // The boundary comes first in the list so it's drawn behind everything else. nodeShapes:
  // node id → its board shape, so each link can record which shapes it joins
  const nodeShapes = new Map();
  ordered.forEach((id) => {
    nodeShapes.set(id, makeShape({ type: 'usecase', stroke: BLUE, text: byId.get(id).label, ...boxes.get(id) }));
  });
  actors.forEach((a) => nodeShapes.set(a.id, makeShape({ type: 'actor', text: a.label, ...boxes.get(a.id) })));
  const shapes = [makeShape({ type: 'boundary', text: title || 'System', ...boundary }), ...nodeShapes.values()];

  // Links: actor ↔ use case is a plain line; «include» / «extend» are dashed arrows;
  // anything else is a normal arrow. Each end attaches to the outline facing the other end
  const anchor = (id, towards) => {
    const box = boxes.get(id);
    const otherBox = boxes.get(towards);
    const otherX = otherBox.x + otherBox.width / 2;
    const otherY = otherBox.y + otherBox.height / 2;
    return byId.get(id).type === 'actor' ? actorEdgePoint(box, otherX) : ovalEdgePoint(box, otherX, otherY);
  };
  edges.forEach((e) => {
    if (!boxes.has(e.from) || !boxes.has(e.to)) return;
    const points = [...anchor(e.from, e.to), ...anchor(e.to, e.from)];
    const ends = { from: nodeShapes.get(e.from).id, to: nodeShapes.get(e.to).id };
    const isActorLink = byId.get(e.from).type === 'actor' || byId.get(e.to).type === 'actor';
    if (e.style === 'association' || (isActorLink && e.style === 'flow')) {
      shapes.push(makeShape({ type: 'line', points, ...ends }));
    } else if (e.style === 'include' || e.style === 'extend') {
      shapes.push(makeShape({ type: 'arrow', points, text: `«${e.style}»`, fontSize: 14, dashed: true, ...ends }));
    } else {
      shapes.push(makeShape({ type: 'arrow', points, text: e.label, fontSize: 14, dashed: false, ...ends }));
    }
  });

  return shapes;
}

export function layoutDiagram(diagram) {
  return diagram.kind === 'usecase'
    ? layoutUseCase(diagram.title, diagram.nodes, diagram.edges)
    : layoutFlowchart(diagram.nodes, diagram.edges);
}
