---
name: Generating Experience UI Flow
description: Interactive loading experience between repo clone and hub — greeting animation, tabbed explorer, map-ready CTA
type: project
---

The "generating experience" is a full screen between `landing` and `hub` (screen state `'generating'`).

**Flow:**
1. After clone completes, App transitions to `generating` screen
2. `GeneratingExperience` component animates in "Let's get it started" text (fadeUp, 100ms delay)
3. "Generate Visual Map" button fades in at 900ms
4. User clicks → `onGenerate()` fires, graph build starts in background via `GET /api/audit/:repoId/graph`
5. While waiting, tabbed explorer shows 3 sections navigable with "Next" buttons
6. When graph fetch resolves, `mapReady=true` flows down as prop → pulsing "See Visual Map" button appears
7. User clicks → transitions to `hub` screen (AuditComplete)

**State ownership:** `mapReady` and the graph fetch promise live in `App.jsx` (not the component), so the component is purely presentational w.r.t generation status.

**Three backend endpoints added to `server/index.js`:**
- `GET /api/repo/:repoId/filetree` — recursive dir tree, skips node_modules/dist etc, dirs-first sort
- `GET /api/repo/:repoId/languages` — file extension breakdown with colors and byte counts; language names normalized (e.g. `.jsx` → "JSX", `.ts`+`.tsx` → "TypeScript")
- `GET /api/repo/:repoId/contributors` — `git log --format="%an|%ae"` parsed via simple-git; falls back to `simple-git`'s native log if custom format doesn't parse; GitHub no-reply emails decoded to username; Gravatar MD5 hash used for other avatars

**CSS classes:** All prefixed `ge-` for the main flow, `filetree-` for the tree, `langs-` for language chart, `contributor-` for the list. All live in `src/index.css` starting around line 2242.

**Component:** `src/components/GeneratingExperience.jsx`

**Why:** Hackathon demo needs to wow judges — the 30-60s graph generation time is dead time without this. The explorer gives the user real data to interact with, making the wait feel productive.

**How to apply:** When touching the generating screen or the three new API routes, refer to this pattern. The contributor parsing has a two-pass fallback because simple-git's custom `--format` parsing is unreliable.

---

## VisualMap graph enrichment (added 2026-03-14)

After the graph loads and enters `ready` phase, three non-blocking enrichment fetches fire in parallel:

1. **Entry point** (`POST /api/audit/entry-point`) — AI picks single best entry file + reading path (3-4 files). `entryPointId` drives amber border+glow on CardNode. `readingPath` drives animated amber edges between those nodes. A dismissable floating banner points at the entry point with reasoning text. Falls back to highest-`size` node.

2. **Card summaries** (`POST /api/audit/card-summaries`) — Reads up to 2KB of each of the top 30 files, sends all in one AI prompt, gets back a `{ summaries: { fileId: "one sentence" } }` dict. Merged into `node.data.intentSummary` and shown as italic text on every CardNode (always visible, not in expanded section).

3. **Flow query bar** (`POST /api/audit/flow-query`) — Pill-shaped search input at top-center of canvas. Submits `{ auditId, query }`. AI returns `{ path: string[], explanation: string }`. Path nodes highlighted in purple, non-path nodes dimmed 25%. Explanation shown in a panel below the bar.

**Client-side features (no new endpoint needed):**
- **Transitive impact BFS** — reverseAdj built from edge list (edges mean source imports target; reverse = who imports me). BFS from each nodeId gives `affectedNodes`. `impactScore = affectedNodes.length`. Badge on CardNode: red ≥10, orange ≥5, gray else. Clicking badge calls `onImpactClick` → `impactHighlight` state dims non-affected to 25% opacity, highlights affected edges orange.
- **Dead node detection** — `size === 0` and not entry point and not in reading path → `isDead = true`. CardNode renders at 40% opacity + "◌ Unused" tag. Toggle button top-right: "Show all" / "Active only" (hides dead nodes when active only).

**White theme applied across all graph components:**
- Canvas: `#f8fafc`
- Background dots: `#cbd5e1`
- Cards: `bg-white`, `border-slate-200`, dark text
- Group nodes: `rgba(241,245,249,0.85)` fill, `2px dashed #cbd5e1` border
- Default edges: `#94a3b8`
- Loading overlay: `background: #ffffff` (inline style overrides the `.vm-overlay` dark CSS)
- Accent blue kept: `#2952ff`
