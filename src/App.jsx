/**
 * App — root router shell.
 *
 * Route map:
 *   /                  LandingPage   — URL input + clone
 *   /hub               HubPage       — 4-card selection hub
 *   /hub/explore       ExplorePage   — 3-step exploration + graph generation
 *   /hub/visual-map    VisualMapPage — the force-graph visualization
 *
 * Shared repo state lives in RepoContext (src/context/RepoContext.jsx).
 * ChatPanel floats globally so it persists across route transitions.
 */

import { Routes, Route, Navigate } from 'react-router-dom'
import LandingPage   from './pages/LandingPage'
import HubPage       from './pages/HubPage'
import ExplorePage   from './pages/ExplorePage'
import VisualMapPage from './pages/VisualMapPage'
import ChatPanel     from './components/ChatPanel'
import { useRepo }   from './context/RepoContext'

export default function App() {
  const { repoId, repoName } = useRepo()

  return (
    <div className="app">
      <Routes>
        <Route path="/"               element={<LandingPage />} />
        <Route path="/hub"            element={<HubPage />} />
        <Route path="/hub/explore"    element={<ExplorePage />} />
        <Route path="/hub/visual-map" element={<VisualMapPage />} />
        {/* Catch-all — redirect unknown paths to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Global floating chat panel — available on all pages */}
      <ChatPanel repoId={repoId} repoName={repoName} />
    </div>
  )
}
