---
name: CodeAtlas Frontend Architecture
description: Key decisions made during the frontend build for the QADNA/CodeAtlas project, including the light redesign
type: project
---

Three-screen SPA with a simple string-based state machine in App.jsx: 'landing' | 'loading' | 'complete'. No router needed at this stage.

**Why:** Single-page flow is sufficient for the hackathon demo path. Adding react-router would be premature until the graph canvas (Step 4 in the vision) needs its own route.

**How to apply:** When adding the graph canvas screen, introduce react-router at that point rather than retrofitting it now.

## Current design: Clean light theme (redesigned 2026-03-14)

The original dark/cyberpunk aesthetic (neon green, dark backgrounds, scanlines, radar spinner, terminal window) was replaced entirely with a clean light design:

- Background: off-white `#f5f5f5`
- Accent: electric blue `#2952ff` only — no neon green, no neon cyan, no purple
- Typography: Inter 900 weight, uppercase, tight letter-spacing for hero headlines
- Navbar: centered blue pill/capsule (`border-radius: 100px`), white nav links, black solid CTA button
- Loading screen: pulsing blue dots + clean progress bar — no radar, no terminal
- Action cards: white surface, `#e5e5e5` border, blue top-border on hover, slight lift shadow

## Component layout

- `src/App.jsx` — state machine, timer logic, renders whichever screen is active
- `src/components/Navbar.jsx` — shared blue pill navbar, used on all three screens
- `src/components/Background.jsx` — null component (stub kept for compatibility)
- `src/components/ParticleField.jsx` — null component (removed, stub kept)
- `src/components/LandingScreen.jsx` — hero headline, URL input + validation, SVG illustration
- `src/components/LoadingScreen.jsx` — bold headline, spinner dots, progress bar
- `src/components/AuditComplete.jsx` — stats row + 3 action cards with inline SVG icons

## Styling

Pure CSS in `src/index.css` with CSS custom properties (no Tailwind, no CSS modules). All brand colours defined as variables in `:root`. Font stack: Inter only (400/600/700/800/900 weights). Loaded via Google Fonts in index.html. JetBrains Mono removed.

## Loading simulation

`AUDIT_DURATION_MS = 3800`. Progress bar animated via `setInterval` (50ms tick) computing `elapsed/total * 95`, then snapped to 100% on timeout. No terminal log animation in the new design.

## GitHub URL validation

Validates using `new URL()` — checks `protocol === 'https:'`, `hostname === 'github.com'`, and that the pathname splits into exactly 2 non-empty segments (owner + repo). No regex needed.

## Build output (verified clean, post-redesign)

- 20 modules transformed, no errors
- CSS: 8.47 kB / 2.28 kB gzip
- JS: 202 kB / 63 kB gzip (React + Firebase)
