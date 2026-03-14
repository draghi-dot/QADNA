---
name: audit_backend_architecture
description: Full-stack audit system decisions: Express server, scanner patterns, AI model, JSON safety, integration tests, and the March 2026 restructure.
type: project
---

## Backend audit system

Express server runs on port 3001. All server files use ES modules (`type: module` in package.json).

### AI Model — ALWAYS Kimi K2.5

- Featherless API (OpenAI-compatible) at `https://api.featherless.ai/v1`
- Model: `moonshotai/Kimi-K2.5` — hardcoded as `const KIMI` in `server/index.js`. Never use any other model.
- **Why:** Featherless plan = 4 concurrent units. Kimi costs 4 units per request. Multiple models simultaneously causes 429 errors.
- `callAIStream(messages, onDelta)` and `callAI(messages)` — no model param, always KIMI.
- `server/ai.js` (GLM-5) is NOT imported by index.js after the restructure. It still exists but is unused.
- Fallback report (`buildFallbackReport`) is defined inline in `server/index.js`.

### User flow (after March 2026 restructure)

1. User submits URL → `POST /api/repo/clone` → fast shallow git clone → returns `{ repoId, repoName, repoUrl }`
2. LandingScreen shows inline "Cloning..." spinner (no navigation away)
3. On success → transition to hub (AuditComplete) with 4 cards — NO audit data yet
4. User clicks Report card → ReportPage idle state with "Start Security Audit" button
5. User clicks button → `POST /api/audit/run` SSE → scan + Kimi AI → displays results inline
6. Visual Map card → uses `repoId` directly (graph endpoint works from cloned dir)

### Endpoint map

- `POST /api/repo/clone` — fast clone only; returns `{ repoId, repoName, repoUrl }` after `git clone --depth 1`
- `POST /api/audit/run` — SSE; takes `{ repoId }`; runs scan then Kimi AI; emits `scan_start`, `scan_complete`, `reasoning`, `complete`, `error`
- `POST /api/audit/start` — legacy; clone + scan synchronously, returns JSON (kept for backward compat with old LoadingScreen flow)
- `GET /api/audit/:auditId/analyze` — legacy SSE; AI analysis of previously scanned repo (kept for backward compat)
- `GET /api/audit/:auditId/graph` — dependency graph; cached on audit record
- `POST /api/chat` — SSE chat; `auditId` optional for context; no model param
- `POST /api/audit/analyze-visual` — non-streaming; returns `{ summary, workflow, keyFiles, risks }`; no model param
- `POST /api/audit/generate-docs` — SSE; markdown docs generation; no model param

### audits Map

The `repoId` from `/api/repo/clone` IS the `auditId` for all other endpoints. Clone-only records have `status: 'cloned'`. This means the graph, docs, and visual-analysis endpoints all work immediately after clone without needing an audit to run first.

### Scanner

- Pure regex-based static analysis in `server/scanner.js` — no external tools
- Walks up to 8 directory levels, skips node_modules/.git/dist/build/__pycache__/.next etc.
- Only scans text files under 500KB, caps at 200 findings
- `sanitizeStr()` strips control characters from snippets before JSON serialization

### VisualMap AI analysis — LAZY (button only)

`VisualMap.jsx` does NOT auto-call analyze-visual on mount. It shows an "AI Analysis" button. Clicking triggers `runAiAnalysis()` which calls `POST /api/audit/analyze-visual`. This prevents concurrent requests on mount.

### Integration test results (expressjs/express)

- Clone: ~5–30s (shallow, depth 1)
- Scan: ~200 findings across ~162 files
- AI: ~5794 prompt tokens, 1400–1665 completion tokens per call
- Start command: `npm run start` (Vite port 5174 + Express port 3001 via concurrently)
