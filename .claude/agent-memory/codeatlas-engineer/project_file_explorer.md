---
name: Visual Map — Tour-First GraphFlow redesign
description: VisualMap now uses GraphFlow (ReactFlow+Dagre) as the main canvas; the hero experience is the Kimi AI "Take Tour" feature
type: project
---

VisualMap was rewritten to make GraphFlow the primary canvas and the guided tour the hero feature for new developers. FileExplorer is no longer used in VisualMap.

**Why:** The FileExplorer scatter-map was a self-guided exploration tool. The new goal is onboarding new developers — Kimi AI generates a 10-15 step architectural narrative via `/api/audit/tour`. The WelcomeOverlay is the first thing a user sees after the graph loads.

**How to apply:** Do not reintroduce FileExplorer into VisualMap. If tour endpoints are unavailable, the graph still works — tour and AI metadata are loaded with `Promise.allSettled` and fail silently.

## Architecture

### VisualMap.jsx
- Phase state machine: `loading` -> `ready` | `error`
- After graph ready, fires two parallel POSTs in `Promise.allSettled`: `/api/audit/entry-point` and `/api/audit/card-summaries`
- `startTour()` POSTs to `/api/audit/tour`, sets `tourSteps` and `tourActive`
- Tour node is driven by `tourSteps[tourIdx].target` — passed as `tourNodeId` prop to GraphFlow

### Sub-components (all in VisualMap.jsx)
- `WelcomeOverlay` — glassmorphism modal shown on graph-ready; two actions: startTour or explore freely
- `TourLoadingOverlay` — full-screen dark blur while Kimi AI generates steps
- `TourSidebar` — 280px dark left sidebar with step list, progress bar, exit button; only visible when `tourActive`
- `TourStepCard` — dark bottom bar with step description, Prev/Next/Finish navigation
- `FloatingTourButton` — bottom-right pill; shown when graph ready but welcome/tour dismissed
- `LoadingOverlay` / `ErrorOverlay` — same loading UX as before

### GraphFlow.jsx changes
- Added `tourNodeId` prop
- `TourZoomer` inner component: uses `useReactFlow().fitView` to animate camera to the tour target node when `tourNodeId` changes; uses a ref to debounce repeated calls to the same node
- Highlight useEffect extended: when `tourNodeId` is set and no impact/query highlight is active, dims non-tour nodes to 0.15 opacity and highlighted node to full; edges connected to tour target get blue color + animated; `isTourHighlight` boolean is set in node data via the same `setNodes` call
- Dependency array includes `tourNodeId`

### CardNode.jsx changes
- Reads `data.isTourHighlight`
- When true: blue `2.5px solid #2952ff` border, `tourPulse` CSS animation (injected once via `document.createElement('style')`), "on tour" badge
- `boxShadow` is `undefined` when animating (the keyframe provides it)

## Tour step schema expected from /api/audit/tour
`{ steps: [{ target: string, type: string, description: string, action: string }] }`
`target` is a file path that may be a suffix match — GraphFlow and TourZoomer both check `n.id.endsWith('/' + tourNodeId)` for flexibility.
