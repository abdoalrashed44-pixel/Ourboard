---
name: project-requirements
description: "OurBoard's functional/non-functional requirements, use cases, and initial class diagram as committed in the report"
metadata: 
  node_type: memory
  type: project
  originSessionId: 95d3f1c9-ebec-4d2f-bdf0-437abfbc6bd6
  modified: 2026-09-15T20:57:36.110Z
---

**Functional requirements (report Ch.3.1):**
1. Multiple users collaborate on a shared canvas simultaneously via WebSockets
2. AI generates structured diagrams from a text prompt
3. AI converts rough hand-drawn sketches into formatted shapes/digital structures
4. On-demand technical explanations for a user-selected canvas area/elements

**Non-functional requirements (report Ch.3.2):** near-zero-delay WebSocket updates;
server must handle concurrent sessions without degrading AI API response time;
lightweight/shallow-learning-curve UI; works in all modern browsers, no plugins.

**Use cases (report Ch.3.3, see Figure 3.1):** Join a Session (login + board ID,
includes Login); Collaborate on canvas (draw/add shape -> broadcast via WebSocket;
alt path: connection drop shows "Reconnecting" indicator, auto-syncs missed elements
on reconnect); Generate from Text/Sketch Prompts (alt path: AI timeout/invalid data ->
abort render, show error, ask user to rephrase); Request Explanation (select canvas
area -> AI returns explanation in a side panel); Save/Load Collaborative Session
(read/write canvas state to external storage/DB). Actors: System User, AI API,
External Storage Service.

**Initial class diagram (report Ch.3.4, Figure 3.2):**
- User: userID, userName, connectionStatus; +joinBoard(), +leaveBoard(), +triggerAI()
- Board: boardID, activeUsers: list<User>, canvasState; +broadcastUpdate(),
  +saveState(), +loadState() — 1 Board has 1..* Users, 1..* CanvasElements, 1 AIAgent
- CanvasElement: elementID, type, coordinates; +render(), +updatePosition(), +delete()
- AIAgent: endpointURL, modelType; +generateDiagram(), +explainContext()

**Why:** This is the formal spec from the submitted report — it's what gets defended,
so implementation should trace back to it even where CLAUDE.md's shape schema (id,
type, x, y, width, height, stroke, fill, points, text, createdBy) is more concrete
than the report's abstract CanvasElement class.

**How to apply:** Treat CLAUDE.md's data model as the up-to-date implementation detail
of the report's CanvasElement/AIAgent classes — don't treat the report's class diagram
as something to literally recreate in code, but check new features against these four
functional requirements and five use cases so nothing drifts from what's defended.
See [[project_overview]] and [[project_timeline]].
