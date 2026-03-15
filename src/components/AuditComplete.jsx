import { useState, useRef, useEffect } from 'react'
import Navbar from './Navbar'
import AuditBoard from './AuditBoard'
import VisualMap from './VisualMap'

// ─── Documentation card (left side of Visual Map) ────────────────────────────

function DocCard({ auditId, repoName }) {
  const [state, setState] = useState('idle')  // idle | loading | done | error
  const [doc, setDoc]     = useState('')
  const docEndRef = useRef(null)

  // Scroll to bottom as text streams in
  useEffect(() => {
    if (state === 'loading') docEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [doc, state])

  async function generate() {
    if (!auditId) return
    setState('loading')
    setDoc('')

    try {
      const res = await fetch('/api/audit/generate-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId }),
      })

      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          try {
            const ev = JSON.parse(raw)
            if (ev.type === 'delta') setDoc(d => d + ev.text)
            if (ev.type === 'done')  setState('done')
            if (ev.type === 'error') throw new Error(ev.message)
          } catch { /* ignore malformed lines */ }
        }
      }
      setState('done')
    } catch (err) {
      setState('error')
      setDoc(err.message)
    }
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(doc).catch(() => {})
  }

  return (
    <div className="doc-card">
      <div className="doc-card-header">
        <div className="doc-card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#1a6bff" strokeWidth="1.8" strokeLinejoin="round"/>
            <polyline points="14 2 14 8 20 8" stroke="#1a6bff" strokeWidth="1.8" strokeLinejoin="round"/>
            <line x1="16" y1="13" x2="8" y2="13" stroke="#1a6bff" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="16" y1="17" x2="8" y2="17" stroke="#1a6bff" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <span>Documentation</span>
        </div>
        {state === 'done' && (
          <button className="doc-card-copy-btn" type="button" onClick={copyToClipboard} title="Copy to clipboard">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="2"/>
            </svg>
            Copy
          </button>
        )}
      </div>

      {state === 'idle' && (
        <div className="doc-card-idle">
          <p className="doc-card-idle-desc">
            Generate AI documentation for <strong>{repoName || 'this repo'}</strong> — project structure, setup guide, architecture overview.
          </p>
          <button
            className="doc-card-generate-btn"
            type="button"
            onClick={generate}
            disabled={!auditId}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fill="none"/>
            </svg>
            Generate Docs
          </button>
        </div>
      )}

      {state === 'loading' && (
        <div className="doc-card-content">
          <div className="doc-card-streaming">
            <pre className="doc-card-pre">{doc}<span className="doc-card-cursor">▋</span></pre>
            <div ref={docEndRef} />
          </div>
        </div>
      )}

      {state === 'done' && (
        <div className="doc-card-content">
          <pre className="doc-card-pre">{doc}</pre>
          <button
            className="doc-card-regen-btn"
            type="button"
            onClick={() => { setState('idle'); setDoc('') }}
          >
            Regenerate
          </button>
        </div>
      )}

      {state === 'error' && (
        <div className="doc-card-error">
          <p>Error: {doc}</p>
          <button type="button" onClick={() => { setState('idle'); setDoc('') }}>Try again</button>
        </div>
      )}
    </div>
  )
}

function extractRepoSlug(url) {
  try {
    const { pathname } = new URL(url)
    return pathname.replace(/^\//, '').replace(/\/$/, '')
  } catch { return url }
}

// ─── Sub-pages ───────────────────────────────────────────────────────────────

/**
 * ReportPage — self-contained audit runner.
 * Idle → user clicks "Start Security Audit" → SSE stream → done
 */
function ReportPage({ repoId, repoName, repoUrl, onBack, onReset }) {
  const slug = extractRepoSlug(repoUrl)

  // auditState: 'idle' | 'scanning' | 'streaming' | 'done' | 'error'
  const [auditState, setAuditState]   = useState('idle')
  const [auditData, setAuditData]     = useState(null)
  const [findings, setFindings]       = useState([])
  const [scanSummary, setScanSummary] = useState(null)
  const [reasoningText, setReasoningText] = useState('')
  const [barProgress, setBarProgress] = useState(0)
  const [errorMsg, setErrorMsg]       = useState('')

  const reasoningBodyRef = useRef(null)
  const barTimerRef      = useRef(null)

  // Auto-scroll reasoning panel
  useEffect(() => {
    if (reasoningBodyRef.current) {
      reasoningBodyRef.current.scrollTop = reasoningBodyRef.current.scrollHeight
    }
  }, [reasoningText])

  async function startAudit() {
    if (!repoId) return
    setAuditState('scanning')
    setFindings([])
    setScanSummary(null)
    setReasoningText('')
    setBarProgress(0)
    setErrorMsg('')

    // Track locally to avoid stale closure when building the final auditData object
    let localFindings  = []
    let localScanSummary = null

    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId }),
      })

      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const dec    = new TextDecoder()
      let buf      = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') continue

          let ev
          try { ev = JSON.parse(raw) } catch { continue }

          if (ev.type === 'scan_start') {
            // already in scanning state
          } else if (ev.type === 'scan_complete') {
            localFindings    = ev.findings || []
            localScanSummary = ev.summary || null
            setFindings(localFindings)
            setScanSummary(localScanSummary)
            setAuditState('streaming')

            // Kick off progress bar animation
            cancelAnimationFrame(barTimerRef.current)
            const START_MS = Date.now()
            const DURATION_MS = 20_000
            const tick = () => {
              const elapsed = Date.now() - START_MS
              const pct = Math.min(90, (elapsed / DURATION_MS) * 90)
              setBarProgress(pct)
              if (pct < 90) barTimerRef.current = requestAnimationFrame(tick)
            }
            barTimerRef.current = requestAnimationFrame(tick)
          } else if (ev.type === 'reasoning') {
            setReasoningText(prev => prev + ev.text)
          } else if (ev.type === 'complete') {
            cancelAnimationFrame(barTimerRef.current)
            setBarProgress(100)
            const full = {
              auditId: repoId,
              repoId,
              repoUrl,
              repoName,
              findings: localFindings,
              scanSummary: localScanSummary,
              aiReport: ev.report || {
                overallRating: 'Unknown',
                executiveSummary: 'AI analysis unavailable.',
                riskScore: 0,
                categories: [],
              },
            }
            setAuditData(full)
            setAuditState('done')
          } else if (ev.type === 'error') {
            cancelAnimationFrame(barTimerRef.current)
            throw new Error(ev.message || 'Unknown error from server')
          }
        }
      }
    } catch (err) {
      cancelAnimationFrame(barTimerRef.current)
      setErrorMsg(err.message)
      setAuditState('error')
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(barTimerRef.current)
  }, [])

  const findingCount = findings.length
  const fileCount = new Set(findings.map(f => f.file).filter(Boolean)).size

  return (
    <div className="screen complete-screen">
      <Navbar onStartAudit={onReset} />
      <div className="complete-body">
        <button className="back-btn" onClick={onBack} type="button">&#x2190; Hub</button>

        <div className="complete-header">
          <h1 className="complete-headline">Security Report</h1>
          <p className="complete-repo">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="#9b9b9b" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer">{slug}</a>
          </p>
        </div>

        {/* Idle state — call to action */}
        {auditState === 'idle' && (
          <div className="report-idle">
            <div className="report-idle-icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path d="M16 2.5 L27 8.5 V16 Q27 26 16 30 Q5 26 5 16 V8.5 Z" stroke="#1a6bff" strokeWidth="1.5" fill="rgba(26,107,255,0.06)" strokeLinejoin="round" />
                <polyline points="10,17 14,21 22,12" stroke="#1a6bff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h2 className="report-idle-title">Security Audit</h2>
            <p className="report-idle-desc">
              Run a full static security scan on <strong>{repoName}</strong>. QADNA will analyze for vulnerabilities, exposed secrets, unsafe patterns, and more.
            </p>
            <button
              className="report-start-btn"
              type="button"
              onClick={startAudit}
              disabled={!repoId}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
              </svg>
              Start Security Audit
            </button>
          </div>
        )}

        {/* Scanning state */}
        {auditState === 'scanning' && (
          <div className="loading-body report-loading-body">
            <h2 className="loading-headline">Scanning repository...</h2>
            <p className="loading-repo"><strong>{repoName}</strong></p>
            <div className="spinner-dots" aria-label="Loading" role="status">
              <span className="spinner-dot" />
              <span className="spinner-dot" />
              <span className="spinner-dot" />
            </div>
            <div className="progress-block">
              <div className="progress-meta">
                <span>Running static analysis</span>
                <span className="pct">—</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill progress-fill--indeterminate" role="progressbar" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100} />
              </div>
            </div>
          </div>
        )}

        {/* Streaming AI analysis state */}
        {auditState === 'streaming' && (
          <div className="loading-body report-loading-body">
            <h2 className="loading-headline">Analyzing code...</h2>
            <p className="loading-repo"><strong>{repoName}</strong></p>

            <div className="reasoning-panel">
              <span className="reasoning-label">AI Reasoning</span>
              <div className="reasoning-body" ref={reasoningBodyRef}>
                <p className="reasoning-text">
                  {reasoningText || 'Waiting for AI response...'}
                  {reasoningText.length > 0 && <span className="reasoning-cursor">|</span>}
                </p>
              </div>
            </div>

            <div className="progress-block">
              <div className="progress-meta">
                <span>AI analysis</span>
                <span className="pct">{Math.round(barProgress)}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${barProgress}%` }} role="progressbar" aria-valuenow={Math.round(barProgress)} aria-valuemin={0} aria-valuemax={100} />
              </div>
              <p className="loading-status-line">
                Analyzing {findingCount} finding{findingCount !== 1 ? 's' : ''} across {fileCount} file{fileCount !== 1 ? 's' : ''}...
              </p>
            </div>
          </div>
        )}

        {/* Done state */}
        {auditState === 'done' && auditData && (
          <AuditBoard auditData={auditData} onTerminate={onReset} />
        )}

        {/* Error state */}
        {auditState === 'error' && (
          <div className="report-error">
            <p className="report-error-msg">Audit failed: {errorMsg}</p>
            <button
              className="report-start-btn"
              type="button"
              onClick={() => { setAuditState('idle'); setErrorMsg('') }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function VisualMapPage({ repoId, repoName, repoUrl, onBack, onReset }) {
  // Build a minimal auditData-like object for VisualMap
  const auditData = { auditId: repoId, repoName, repoUrl, findings: [] }

  return (
    <div className="screen vm-page">
      <Navbar onStartAudit={onReset} />
      <div className="vm-page-body">
        <button className="vm-back-btn" onClick={onBack} type="button">&#x2190; Hub</button>
        <DocCard auditId={repoId} repoName={repoName} />
        <VisualMap auditData={auditData} repoUrl={repoUrl} />
      </div>
    </div>
  )
}


function ComingSoonPage({ title, description, color, icon, onBack, onReset }) {
  return (
    <div className="screen complete-screen">
      <Navbar onStartAudit={onReset} />
      <div className="complete-body">
        <button className="back-btn" onClick={onBack} type="button">&#x2190; Hub</button>
        <div className="coming-soon-page">
          <div className="coming-soon-page-icon" style={{ background: `${color}10`, border: `1px solid ${color}28` }}>
            {icon}
          </div>
          <h1 className="coming-soon-page-title">{title}</h1>
          <p className="coming-soon-page-desc">{description}</p>
          <span className="coming-soon-badge">Coming Soon</span>
        </div>
      </div>
    </div>
  )
}

// ─── Card definitions ────────────────────────────────────────────────────────

const CARDS = [
  {
    id: 'map',
    title: 'Visual Map',
    desc: 'Interactive force-directed graph of every file, module, and dependency.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="2.5" />
        <circle cx="4" cy="5" r="2" />
        <circle cx="20" cy="5" r="2" />
        <circle cx="4" cy="19" r="2" />
        <circle cx="20" cy="19" r="2" />
        <line x1="5.8" y1="6.6" x2="10" y2="10.2" />
        <line x1="18.2" y1="6.6" x2="14" y2="10.2" />
        <line x1="5.8" y1="17.4" x2="10" y2="13.8" />
        <line x1="18.2" y1="17.4" x2="14" y2="13.8" />
      </svg>
    ),
  },
  {
    id: 'dashboard',
    title: 'Repo Dashboard',
    desc: 'Overview of commits, contributors, mapped nodes, and risk flags.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'report',
    title: 'Security Report',
    desc: 'Full static audit — vulnerabilities, severity breakdown, and AI-generated remediation.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2L21 7v5c0 5.5-3.8 10.7-9 12-5.2-1.3-9-6.5-9-12V7l9-5z" />
        <polyline points="9 12 11 14 15 10" />
      </svg>
    ),
  },
  {
    id: 'fix',
    title: 'What to Fix',
    desc: 'AI-generated improvement recommendations based on your project structure.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    ),
  },
]

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Hub page + sub-page router.
 * @param {{
 *   repoId: string,
 *   repoName: string,
 *   repoUrl: string,
 *   onReset: () => void,
 *   onOpenMap?: () => void,
 *   onOpenExplore?: () => void,
 *   initialPage?: string|null
 * }} props
 */
export default function AuditComplete({ repoId, repoName, repoUrl, onReset, onOpenMap, onOpenDashboard, onOpenWhatToFix, initialPage = null }) {
  const [page, setPage] = useState(initialPage)
  const slug = extractRepoSlug(repoUrl)

  if (page === 'report') return (
    <ReportPage
      repoId={repoId}
      repoName={repoName}
      repoUrl={repoUrl}
      onBack={() => setPage(null)}
      onReset={onReset}
    />
  )
  if (page === 'map') return (
    <VisualMapPage
      repoId={repoId}
      repoName={repoName}
      repoUrl={repoUrl}
      onBack={() => setPage(null)}
      onReset={onReset}
    />
  )

  function handleCardClick(card) {
    if (card.id === 'map' && onOpenMap) return onOpenMap()
    if (card.id === 'dashboard' && onOpenDashboard) return onOpenDashboard()
    if (card.id === 'fix' && onOpenWhatToFix) return onOpenWhatToFix()
    setPage(card.id)
  }

  return (
    <div className="screen complete-screen">
      <Navbar onStartAudit={onReset} />
      <div className="complete-body">
        <button className="back-btn" onClick={onReset} type="button">&#x2190; New Repo</button>

        <div className="complete-header">
          <h1 className="complete-headline">Choose an analysis</h1>
          <p className="complete-repo">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="#9b9b9b" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer">{slug}</a>
          </p>
        </div>

        <div className="audit-cards-grid">
          {CARDS.map((card) => (
            <button
              key={card.id}
              className="audit-nav-card"
              onClick={() => handleCardClick(card)}
              type="button"
            >
              <div className="audit-nav-card-icon">
                {card.icon}
              </div>
              <div className="audit-nav-card-body">
                <p className="audit-nav-card-title">{card.title}</p>
                <p className="audit-nav-card-desc">{card.desc}</p>
              </div>
              <span className="audit-nav-card-arrow">&#x2192;</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
