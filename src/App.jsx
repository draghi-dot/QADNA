/**
 * App — root router shell.
 *
 * Route map:
 *   /                  LandingPage   — URL input + clone
 *   /hub               HubPage       — 4-card selection hub
 *   /hub/dashboard     RepoDashboardPage — repo overview dashboard
 *   /hub/visual-map    VisualMapPage — the force-graph visualization
 *
 * Shared repo state lives in RepoContext (src/context/RepoContext.jsx).
 * On reload, the app checks Firestore for a saved session and auto-navigates to /hub.
 */

import { useEffect, useState, useRef } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import LandingPage   from './pages/LandingPage'
import HubPage       from './pages/HubPage'
import RepoDashboardPage from './pages/RepoDashboardPage'
import VisualMapPage  from './pages/VisualMapPage'
import WhatToFixPage  from './pages/WhatToFixPage'
import ChatPanel     from './components/ChatPanel'
import ProfileModal  from './components/ProfileModal'
import { useRepo }   from './context/RepoContext'
import { useAuth }   from './context/AuthContext'

const Spinner = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fcfcfc' }}>
    <div style={{ textAlign: 'center' }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', border: '2px solid rgba(26,107,255,0.12)', borderTopColor: '#1a6bff', animation: 'spin 0.85s linear infinite', margin: '0 auto 14px' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <p style={{ color: '#7a7a8a', fontSize: 12, fontFamily: 'IBM Plex Mono, monospace', letterSpacing: '0.04em' }}>Loading...</p>
    </div>
  </div>
)

// Only paid + authenticated users can access protected routes
function ProtectedRoute({ children }) {
  const { user, hasPaid, authLoading } = useAuth()
  if (authLoading) return <Spinner />
  if (!user || !hasPaid) return <Navigate to="/" replace />
  return children
}

function Toast({ message, repoName, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className="toast-container">
      <div className="toast">
        <span className="toast-icon">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </span>
        {message} <span className="toast-repo">{repoName}</span>
      </div>
    </div>
  )
}

export default function App() {
  const { repoId, repoName, sessionLoading } = useRepo()
  const { user, authLoading, profileOpen, closeProfile, refreshPayment } = useAuth()
  const [toast, setToast] = useState(null)
  const prevRepoRef = useRef(repoId)

  // Show toast when repo changes (not on initial load)
  useEffect(() => {
    if (prevRepoRef.current && repoId && repoId !== prevRepoRef.current && repoName) {
      setToast({ message: 'Switched to', repoName })
    }
    prevRepoRef.current = repoId
  }, [repoId, repoName])

  // On page load: if returning from Stripe, verify or check payment
  useEffect(() => {
    if (!user) return
    const params = new URLSearchParams(window.location.search)
    const sessionId = params.get('session_id')
    const success = params.get('payment_success')

    if (success === 'true') {
      window.history.replaceState({}, '', window.location.pathname)
      const verify = sessionId
        ? fetch('/api/stripe/verify-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, userId: user.uid }),
          })
        : fetch('/api/stripe/check-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.uid }),
          })
      verify.then(() => refreshPayment()).catch(() => {})
    }
  }, [user, refreshPayment])

  // Wait for both auth and session to resolve before rendering
  if (authLoading || sessionLoading) return <Spinner />

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/hub"            element={<ProtectedRoute><HubPage /></ProtectedRoute>} />
        <Route path="/hub/dashboard"   element={<ProtectedRoute><RepoDashboardPage /></ProtectedRoute>} />
        <Route path="/hub/visual-map"  element={<ProtectedRoute><VisualMapPage /></ProtectedRoute>} />
        <Route path="/hub/what-to-fix" element={<ProtectedRoute><WhatToFixPage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <ChatPanel repoId={repoId} repoName={repoName} />
      {profileOpen && <ProfileModal onClose={closeProfile} />}
      {toast && <Toast message={toast.message} repoName={toast.repoName} onDone={() => setToast(null)} />}
    </div>
  )
}
