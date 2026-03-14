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
