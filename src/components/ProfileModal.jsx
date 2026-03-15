import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useRepo } from '../context/RepoContext'

const PAYMENT_LINK = 'https://buy.stripe.com/test_4gM00k3xff6fcgS2nubEA00'

export default function ProfileModal({ onClose }) {
  const { user, hasPaid, login, logout, refreshPayment } = useAuth()
  const { setRepo } = useRepo()
  const navigate = useNavigate()
  const [repos, setRepos] = useState([])
  const [reposLoading, setReposLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)

  // GitHub PAT state
  const [patInput, setPatInput] = useState('')
  const [patSaving, setPatSaving] = useState(false)
  const [patStatus, setPatStatus] = useState(null) // { connected, login?, avatarUrl? } or null
  const [patChecking, setPatChecking] = useState(false)

  // Load repos if paid
  useEffect(() => {
    if (!user || !hasPaid) return
    setReposLoading(true)
    fetch(`/api/user/repos?uid=${user.uid}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setRepos(data.repos || []))
      .catch(() => setRepos([]))
      .finally(() => setReposLoading(false))
  }, [user, hasPaid])

  // Check GitHub PAT status on mount
  useEffect(() => {
    if (!user || !hasPaid) return
    setPatChecking(true)
    fetch('/api/user/github-token/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: user.uid }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setPatStatus(data) })
      .catch(() => {})
      .finally(() => setPatChecking(false))
  }, [user, hasPaid])

  async function handleSavePat() {
    if (!patInput.trim() || !user) return
    setPatSaving(true)
    try {
      await fetch('/api/user/github-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid, githubPat: patInput.trim() }),
      })
      setPatInput('')
      const verifyRes = await fetch('/api/user/github-token/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid }),
      })
      const data = await verifyRes.json()
      setPatStatus(data)
    } catch {}
    setPatSaving(false)
  }

  async function handleDisconnectPat() {
    if (!user) return
    try {
      await fetch('/api/user/github-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid, githubPat: '' }),
      })
      setPatStatus({ connected: false })
    } catch {}
  }

  function handleBuyAccess() {
    if (!user) return
    window.location.href = `${PAYMENT_LINK}?client_reference_id=${encodeURIComponent(user.uid)}`
  }

  async function handleVerify() {
    if (!user) return
    setVerifying(true)
    try {
      await fetch('/api/stripe/check-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid }),
      })
      await refreshPayment()
    } catch {}
    setVerifying(false)
  }

  async function handleLogin() {
    try { await login() } catch {}
  }

  async function handleDeleteRepo(e, auditId) {
    e.stopPropagation()
    if (!confirm('Delete this repo and all its data?')) return
    try {
      await fetch(`/api/audit/${auditId}`, { method: 'DELETE' })
      setRepos(prev => prev.filter(r => r.auditId !== auditId))
    } catch {}
  }

  function handleLogout() { logout(); onClose() }

  return (
    <>
      <div className="profile-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="profile-modal" role="dialog" aria-label="Account" aria-modal="true">
        <div className="profile-modal-header">
          <span className="profile-modal-title">Account</span>
          <button className="profile-modal-close" onClick={onClose} type="button" aria-label="Close">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {!user ? (
          <div className="profile-modal-body">
            <p className="profile-modal-hint">Sign in to start analyzing repositories.</p>
            <button className="profile-google-btn" type="button" onClick={handleLogin}>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
          </div>
        ) : (
          <div className="profile-modal-body">
            <div className="profile-modal-user">
              {user.photoURL && (
                <img src={user.photoURL} alt="" className="profile-modal-avatar" referrerPolicy="no-referrer" />
              )}
              <div>
                <div className="profile-modal-name">{user.displayName || 'User'}</div>
                <div className="profile-modal-email">{user.email}</div>
              </div>
              {hasPaid && (
                <span className="profile-modal-badge">
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  Pro
                </span>
              )}
            </div>

            {!hasPaid ? (
              <div className="profile-modal-upgrade">
                {verifying ? (
                  <div style={{ textAlign: 'center', padding: '10px 0' }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%',
                      border: '2px solid rgba(26,107,255,0.15)',
                      borderTopColor: '#1a6bff',
                      animation: 'spin 0.8s linear infinite',
                      margin: '0 auto 8px',
                    }} />
                    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
                    <p style={{ fontSize: 12, color: '#7a7a8a', margin: 0, fontFamily: 'IBM Plex Mono, monospace' }}>Verifying payment...</p>
                  </div>
                ) : (
                  <>
                    <div className="profile-modal-plan-label">Pro Plan</div>
                    <div className="profile-modal-price">
                      <span className="profile-modal-price-amount">$24.99</span>
                      <span className="profile-modal-price-period">/ month</span>
                    </div>
                    <ul className="profile-modal-features">
                      <li>Unlimited repo analysis</li>
                      <li>Interactive visual maps</li>
                      <li>AI codebase insights</li>
                      <li>Full repo history</li>
                    </ul>
                    <button className="profile-buy-btn" type="button" onClick={handleBuyAccess}>
                      Subscribe &mdash; $24.99/mo
                    </button>
                    <button className="profile-verify-btn" type="button" onClick={handleVerify}>
                      Already subscribed? Verify
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="profile-modal-repos">
                <div className="profile-modal-verified-banner">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  Pro subscription active
                </div>

                {/* GitHub Access */}
                <div className="profile-gh-section">
                  <div className="profile-gh-title">GitHub Access</div>
                  {patChecking ? (
                    <p className="profile-gh-hint">Checking...</p>
                  ) : patStatus?.connected ? (
                    <div className="profile-gh-connected">
                      <div className="profile-gh-connected-info">
                        {patStatus.avatarUrl && (
                          <img src={patStatus.avatarUrl} alt="" className="profile-gh-avatar" referrerPolicy="no-referrer" />
                        )}
                        <span className="profile-gh-login">@{patStatus.login}</span>
                        <span className="profile-gh-badge">Connected</span>
                      </div>
                      <button className="profile-gh-disconnect" type="button" onClick={handleDisconnectPat}>
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <div className="profile-gh-input-wrap">
                      <p className="profile-gh-hint">
                        Add a GitHub token to analyze private repos.
                      </p>
                      <div className="profile-gh-row">
                        <input
                          className="profile-gh-input"
                          type="password"
                          placeholder="ghp_xxxxxxxxxxxx"
                          value={patInput}
                          onChange={e => setPatInput(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSavePat() }}
                        />
                        <button
                          className="profile-gh-save"
                          type="button"
                          onClick={handleSavePat}
                          disabled={patSaving || !patInput.trim()}
                        >
                          {patSaving ? '...' : 'Save'}
                        </button>
                      </div>
                      {patStatus && !patStatus.connected && patStatus.error && (
                        <p className="profile-gh-error">{patStatus.error}</p>
                      )}
                      <a
                        className="profile-gh-help"
                        href="https://github.com/settings/tokens/new?scopes=repo&description=QADNA"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Create a token on GitHub
                      </a>
                    </div>
                  )}
                </div>

                <div className="profile-modal-repos-title">Analyzed repos</div>
                {reposLoading ? (
                  <div className="profile-modal-repos-loading">Loading...</div>
                ) : repos.length === 0 ? (
                  <p className="profile-modal-repos-empty">No repos analyzed yet.</p>
                ) : (
                  <ul className="profile-modal-repos-list">
                    {repos.map(r => (
                      <li
                        key={r.auditId}
                        className="profile-modal-repo-item profile-modal-repo-item--clickable"
                        onClick={() => {
                          setRepo({ id: r.auditId, url: r.repoUrl || '', name: r.repoName || r.auditId })
                          onClose()
                          navigate('/hub')
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setRepo({ id: r.auditId, url: r.repoUrl || '', name: r.repoName || r.auditId })
                            onClose()
                            navigate('/hub')
                          }
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0, opacity: 0.3 }} aria-hidden="true">
                          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                        </svg>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block' }}>{r.repoName || r.auditId}</span>
                          {r.analyzedBy && (
                            <span className="profile-modal-repo-email">{r.analyzedBy}</span>
                          )}
                        </div>
                        <button
                          className="profile-modal-repo-delete"
                          title="Delete repo"
                          onClick={(e) => handleDeleteRepo(e, r.auditId)}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                          </svg>
                        </button>
                        <span className="profile-modal-repo-arrow">&#x2192;</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <button className="profile-logout-btn" type="button" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </>
  )
}
