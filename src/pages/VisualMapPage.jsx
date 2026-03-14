/**
 * VisualMapPage — route: /hub/visual-map
 *
 * Shows the force-graph visualization + documentation panel.
 * Triggers graph generation on first mount (if not already done).
 * ChatPanel is global in App so it's always accessible here too.
 * If no repoId in context, redirects to /.
 */

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import VisualMap from '../components/VisualMap'
import { useRepo } from '../context/RepoContext'

// Inline DocCard — duplicated here to keep VisualMapPage self-contained
// and avoid importing the internal component from AuditComplete.
import { useState } from 'react'

function DocCard({ auditId, repoName }) {
  const [state, setState] = useState('idle')
  const [doc, setDoc]     = useState('')
  const docEndRef         = useRef(null)

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

  return (
    <div className="doc-card">
      <div className="doc-card-header">
        <div className="doc-card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#2952ff" strokeWidth="1.8" strokeLinejoin="round"/>
            <polyline points="14 2 14 8 20 8" stroke="#2952ff" strokeWidth="1.8" strokeLinejoin="round"/>
            <line x1="16" y1="13" x2="8" y2="13" stroke="#2952ff" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="16" y1="17" x2="8" y2="17" stroke="#2952ff" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <span>Documentation</span>
        </div>
        {state === 'done' && (
          <button className="doc-card-copy-btn" type="button"
            onClick={() => navigator.clipboard.writeText(doc).catch(() => {})}
            title="Copy to clipboard">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
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
            Generate comprehensive AI documentation for <strong>{repoName || 'this repo'}</strong>.
          </p>
          <button className="doc-card-generate-btn" type="button" onClick={generate} disabled={!auditId}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fill="none"/>
            </svg>
            Generate Documentation
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
          <button className="doc-card-regen-btn" type="button"
            onClick={() => { setState('idle'); setDoc('') }}>
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VisualMapPage() {
  const navigate  = useNavigate()
  const { repoId, repoUrl, repoName, setMapReady, graphJobRef, clearRepo } = useRepo()

  // Guard: no repo → go home
  useEffect(() => {
    if (!repoId) navigate('/', { replace: true })
  }, [repoId, navigate])

  // Trigger graph build on first visit if not already in flight
  useEffect(() => {
    if (!repoId || graphJobRef.current) return
    const job = fetch(`/api/audit/${repoId}/graph`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(() => setMapReady(true))
      .catch(err => {
        console.warn('[VisualMapPage] Graph build error:', err.message)
        setMapReady(true)
      })
    graphJobRef.current = job
  }, [repoId, graphJobRef, setMapReady])

  if (!repoId) return null

  const auditData = { auditId: repoId, repoName, repoUrl, findings: [] }

  function handleReset() {
    clearRepo()
    navigate('/')
  }

  return (
    <div className="screen vm-page">
      <Navbar onStartAudit={handleReset} />
      <div className="vm-page-body">
        <button className="vm-back-btn" onClick={() => navigate('/hub')} type="button">
          &#x2190; Hub
        </button>
        <DocCard auditId={repoId} repoName={repoName} />
        <VisualMap auditData={auditData} repoUrl={repoUrl} />
      </div>
    </div>
  )
}
