---
name: project-timeline
description: "TM471 academic timeline/deadlines for OurBoard from the report's Gantt chart"
metadata: 
  node_type: memory
  type: project
  originSessionId: 95d3f1c9-ebec-4d2f-bdf0-437abfbc6bd6
  modified: 2026-09-15T20:57:40.867Z
---

Report's TM471 schedule (spans 18/01/2026 - 20/12/2026):
- TM471-A Planning: 18/01/2026 - 14/02/2026
- TM471-A Requirements & Analysis (Ch.1 intro, Ch.2 lit review, functional/non-functional
  reqs, UML diagrams): 15/02/2026 - 16/04/2026. Eid Al Fitr break 08/03 - 28/03/2026.
- TMA 1 & Report 1 (Part A Final) due: 16/04/2026
- Summer break (no enrollment): 22/05/2026 - 31/08/2026
- TM471-B Design (system architecture, DB diagrams, canvas UI design): 01/09 - 30/09/2026
- TM471-B Implementation: 01/10 - 15/11/2026
  - Env setup & WebSocket real-time sync: 01/10 - 15/10/2026
  - Integrating multimodal AI (text-to-diagram): 16/10 - 31/10/2026
  - On-demand explanations full implementation: 01/11 - 15/11/2026
- TM471-B Testing (unit/integration/acceptance, bugfixing): 16/11 - 30/11/2026
- TM471-B Deployment: 01/12 - 20/12/2026
  - TMA 2 & Final Report 2 due: 10/12/2026
  - Final presentation: 11/12 - 20/12/2026

**Why:** These are hard academic deadlines from the submitted report's own Gantt chart,
not derivable from code. [[project_overview]] has the surrounding academic context.

**How to apply:** When the user asks "what should we work on next" or timing seems
tight, check today's date against this schedule — e.g., as of implementation-phase
work, prioritize WebSocket sync before AI features to match the report's own ordering
(sync first, then text-to-diagram AI, then explanations).
