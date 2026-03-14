import { useState, useEffect, useRef } from 'react'
import Navbar from './Navbar'

/**
 * Extracts the "owner/repo" portion from a GitHub URL for display.
 * @param {string} url
 * @returns {string}
 */
function extractRepoSlug(url) {
  try {
    const { pathname } = new URL(url)
    return pathname.replace(/^\//, '').replace(/\/$/, '')
  } catch {
    return url
  }
}

/**
 * Loading / analysis screen — two visual phases:
 *
 *  Phase 1  auditId is null (Phase 1 POST is still in flight):
 *           Large headline "CLONING REPOSITORY..." with pulsing dots.
 *
 *  Phase 2  auditId is set: open SSE to /api/audit/:auditId/analyze and
 *           stream AI reasoning tokens into a scrollable monospace panel.
 *
 * @param {{
 *   repoUrl: string,
 *   repoName: string,
 *   auditId: string|null,
 *   findings: object[],
 *   onComplete: (report: object|null) => void,
 * }} props
 */
export default function LoadingScreen({ repoUrl, repoName, auditId, findings, onComplete }) {
  const slug = extractRepoSlug(repoUrl)
  const displayName = repoName || slug

  // --- Phase 1 state ---
  const [phase, setPhase] = useState('cloning') // 'cloning' | 'streaming'

  // --- Phase 2 / reasoning state ---
  const [reasoningText, setReasoningText] = useState('')
  const [barProgress, setBarProgress] = useState(0)

  const reasoningBodyRef = useRef(null)
  const barTimerRef = useRef(null)
  const eventSourceRef = useRef(null)

  // Count of unique files mentioned in findings for the status line
  const fileCount = findings
    ? new Set(findings.map((f) => f.file).filter(Boolean)).size
    : 0
  const findingCount = findings ? findings.length : 0

  // -----------------------------------------------------------------------
  // Phase 2 — open SSE once auditId is available
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!auditId) return  // still in Phase 1

    setPhase('streaming')
    setReasoningText('')
    setBarProgress(0)

    // Animate progress bar from 0 → 90 % over ~15 s, then snap to 100 on complete
    const START_MS = Date.now()
    const DURATION_MS = 15_000
    const tick = () => {
      const elapsed = Date.now() - START_MS
      const pct = Math.min(90, (elapsed / DURATION_MS) * 90)
      setBarProgress(pct)
      if (pct < 90) {
        barTimerRef.current = requestAnimationFrame(tick)
      }
    }
    barTimerRef.current = requestAnimationFrame(tick)

    // Open SSE stream
    const es = new EventSource(`/api/audit/${auditId}/analyze`)
    eventSourceRef.current = es

    es.onmessage = (event) => {
      // Guard against the terminal [DONE] sentinel
      if (event.data === '[DONE]') {
        es.close()
        return
      }

      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return  // ignore malformed frames
      }

      if (payload.type === 'reasoning') {
        setReasoningText((prev) => prev + payload.text)
      } else if (payload.type === 'complete') {
        // Snap progress bar to 100 % then hand off
        cancelAnimationFrame(barTimerRef.current)
        setBarProgress(100)
        es.close()
        // Small delay so the user sees 100 % before the transition
        setTimeout(() => {
          onComplete(payload.report)
        }, 400)
      } else if (payload.type === 'error') {
        console.error('[LoadingScreen] SSE error event:', payload.message)
        es.close()
        onComplete(null)
      }
    }

    es.onerror = () => {
      console.error('[LoadingScreen] EventSource connection error')
      es.close()
      onComplete(null)
    }

    return () => {
      cancelAnimationFrame(barTimerRef.current)
      es.close()
    }
  }, [auditId]) // eslint-disable-line react-hooks/exhaustive-deps
  // onComplete is stable (useCallback in App); omitting from deps to avoid re-opening stream

  // -----------------------------------------------------------------------
  // Auto-scroll reasoning box to bottom as new text arrives
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (reasoningBodyRef.current) {
      reasoningBodyRef.current.scrollTop = reasoningBodyRef.current.scrollHeight
    }
  }, [reasoningText])

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="screen loading-screen">
      <Navbar />

      <div className="loading-body">

        {/* ── Phase 1: cloning ── */}
        {phase === 'cloning' && (
          <>
            <div>
              <h2 className="loading-headline">CLONING REPOSITORY...</h2>
              <p className="loading-repo">
                <strong>{displayName}</strong>
              </p>
            </div>

            <div className="spinner-dots" aria-label="Loading" role="status">
              <span className="spinner-dot" />
              <span className="spinner-dot" />
              <span className="spinner-dot" />
            </div>

            <div className="progress-block">
              <div className="progress-meta">
                <span>Scanning repository</span>
                <span className="pct">—</span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill progress-fill--indeterminate"
                  role="progressbar"
                  aria-valuenow={0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
            </div>
          </>
        )}

        {/* ── Phase 2: streaming reasoning ── */}
        {phase === 'streaming' && (
          <>
            <div>
              <h2 className="loading-headline">ANALYZING CODE...</h2>
              <p className="loading-repo">
                <strong>{displayName}</strong>
              </p>
            </div>

            {/* Reasoning panel */}
            <div className="reasoning-panel">
              <span className="reasoning-label">AI REASONING</span>
              <div className="reasoning-body" ref={reasoningBodyRef}>
                <p className="reasoning-text">
                  {reasoningText || 'Waiting for AI response\u2026'}
                  {reasoningText.length > 0 && (
                    <span className="reasoning-cursor">|</span>
                  )}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="progress-block">
              <div className="progress-meta">
                <span>AI analysis</span>
                <span className="pct">{Math.round(barProgress)}%</span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${barProgress}%` }}
                  role="progressbar"
                  aria-valuenow={Math.round(barProgress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>

              {/* Status line */}
              <p className="loading-status-line">
                Analyzing {findingCount} finding{findingCount !== 1 ? 's' : ''} across {fileCount} file{fileCount !== 1 ? 's' : ''}...
              </p>
            </div>
          </>
        )}

      </div>
    </div>
  )
}
