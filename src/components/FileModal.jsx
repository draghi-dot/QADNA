import { useState, useEffect, useRef } from 'react'

const EXT_COLOR = {
  js: '#f7df1e', jsx: '#1a6bff', ts: '#3178c6', tsx: '#38bdf8',
  py: '#3776ab', go: '#00add8', css: '#c084fc', html: '#f97316',
  json: '#86efac', md: '#7a7a8a',
}

function extColor(id = '') {
  const ext = id.split('.').pop()?.toLowerCase()
  return EXT_COLOR[ext] || '#7a7a8a'
}

export default function FileModal({ node, auditId, onClose }) {
  const [aiState, setAiState] = useState('idle') // idle | loading | done | error
  const [aiText,  setAiText]  = useState('')
  const [gitInfo, setGitInfo] = useState(null)
  const bottomRef             = useRef(null)

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Auto-scroll as text streams in
  useEffect(() => {
    if (aiState === 'loading') bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [aiText, aiState])

  // Fetch git info on mount
  useEffect(() => {
    if (!auditId || !node?.id) return
    fetch('/api/audit/file-git-info', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ auditId, filePath: node.id }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setGitInfo(data) })
      .catch(() => {})
  }, [auditId, node?.id])

  async function askPurpose() {
    if (aiState !== 'idle') return
    setAiState('loading')
    setAiText('')

    try {
      const res = await fetch('/api/audit/file-purpose', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ auditId, filePath: node.id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

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
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type === 'delta') setAiText(t => t + ev.text)
            if (ev.type === 'done')  setAiState('done')
            if (ev.type === 'error') throw new Error(ev.message)
          } catch { /* ignore malformed */ }
        }
      }
      setAiState('done')
    } catch (err) {
      setAiText(err.message)
      setAiState('error')
    }
  }

  const color = extColor(node.id)
  const ext   = node.id.split('.').pop()?.toLowerCase() || 'file'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
        padding: 20,
      }}
    >
      {/* Card */}
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`File details: ${node.label}`}
        style={{
          background: '#ffffff',
          border: '1px solid rgba(0,0,0,0.07)',
          borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.14)',
          width: '100%', maxWidth: 520,
          maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px 14px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
              {/* File type badge */}
              <div style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                background: color + '10', border: `1px solid ${color}28`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{
                  fontSize: 9, fontWeight: 800, color,
                  letterSpacing: '0.04em',
                  fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                }}>
                  {ext.slice(0, 3).toUpperCase()}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{
                  fontSize: 14, fontWeight: 600, color: '#0a0a0a', margin: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  letterSpacing: '-0.01em',
                }}>
                  {node.label}
                </p>
                <p style={{
                  fontSize: 11, color: '#7a7a8a', margin: '2px 0 0',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                }}>
                  {node.id}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                flexShrink: 0, background: 'none',
                border: '1px solid rgba(0,0,0,0.07)',
                borderRadius: 6, width: 28, height: 28, cursor: 'pointer',
                color: '#7a7a8a', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              &#x2715;
            </button>
          </div>

          {/* Meta badges */}
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            <span style={{
              padding: '2px 8px', borderRadius: 100,
              background: color + '0e', color, fontSize: 10, fontWeight: 700,
              border: `1px solid ${color}22`,
              fontFamily: 'IBM Plex Mono, SF Mono, monospace',
            }}>
              .{ext}
            </span>
            {node.group && node.group !== ext && (
              <span style={{
                padding: '2px 8px', borderRadius: 100, background: 'rgba(26,107,255,0.06)',
                color: '#1a6bff', fontSize: 10, fontWeight: 600,
                border: '1px solid rgba(26,107,255,0.12)',
                fontFamily: 'IBM Plex Mono, SF Mono, monospace',
              }}>
                {node.group}
              </span>
            )}
            {(node.size > 0) && (
              <span style={{
                padding: '2px 8px', borderRadius: 100, background: 'rgba(0,0,0,0.03)',
                color: '#7a7a8a', fontSize: 10, border: '1px solid rgba(0,0,0,0.06)',
                fontFamily: 'IBM Plex Mono, SF Mono, monospace',
              }}>
                {node.size} import{node.size !== 1 ? 's' : ''}
              </span>
            )}
            {node.findingCount > 0 && (
              <span style={{
                padding: '2px 8px', borderRadius: 100, background: '#ef444408',
                color: '#ef4444', fontSize: 10, fontWeight: 700,
                border: '1px solid #ef444420',
                fontFamily: 'IBM Plex Mono, SF Mono, monospace',
              }}>
                {node.findingCount} issue{node.findingCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

          {/* Git metadata */}
          {gitInfo && gitInfo.lastChanged && (
            <div style={{
              display: 'flex', gap: 20, marginBottom: 16,
              padding: '10px 14px',
              background: '#f7f7f8', borderRadius: 8, border: '1px solid rgba(0,0,0,0.06)',
            }}>
              <div>
                <div style={{
                  fontSize: 9, fontWeight: 700,
                  fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                  color: '#7a7a8a', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: 4,
                }}>
                  Last changed
                </div>
                <div style={{ fontSize: 12, color: '#0a0a0a', fontWeight: 500 }}>
                  {gitInfo.lastChanged}
                </div>
              </div>
              {gitInfo.message && (
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 9, fontWeight: 700,
                    fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                    color: '#7a7a8a', textTransform: 'uppercase',
                    letterSpacing: '0.08em', marginBottom: 4,
                  }}>
                    Commit
                  </div>
                  <div style={{
                    fontSize: 12, color: '#4a4a5a',
                    maxWidth: 200, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                  }}>
                    {gitInfo.message}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Git loading skeleton */}
          {!gitInfo && auditId && (
            <div style={{
              display: 'flex', gap: 20, marginBottom: 16,
              padding: '10px 14px',
              background: '#f7f7f8', borderRadius: 8, border: '1px solid rgba(0,0,0,0.06)',
            }}>
              <div>
                <div style={{
                  fontSize: 9, fontWeight: 700,
                  fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                  color: '#7a7a8a', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: 5,
                }}>Last changed</div>
                <div style={{ width: 72, height: 10, borderRadius: 3, background: '#e8e8e8', animation: 'shimmer 1.4s ease infinite' }} />
              </div>
              <div>
                <div style={{
                  fontSize: 9, fontWeight: 700,
                  fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                  color: '#7a7a8a', textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: 5,
                }}>Commit</div>
                <div style={{ width: 128, height: 10, borderRadius: 3, background: '#e8e8e8', animation: 'shimmer 1.4s ease infinite' }} />
              </div>
            </div>
          )}

          {/* Findings list */}
          {node.findings && node.findings.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <p style={{
                fontSize: 9, fontWeight: 700,
                fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                color: '#7a7a8a', textTransform: 'uppercase',
                letterSpacing: '0.1em', marginBottom: 8,
              }}>
                Security Findings
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {node.findings.map((f, i) => {
                  const sev = f.severity?.toLowerCase()
                  const c = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#1a6bff', info: '#7a7a8a' }[sev] || '#7a7a8a'
                  return (
                    <div key={i} style={{
                      display: 'flex', gap: 9, alignItems: 'flex-start',
                      padding: '8px 11px', borderRadius: 8,
                      background: c + '08', border: `1px solid ${c}18`,
                    }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700,
                        fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                        color: c,
                        padding: '2px 6px', borderRadius: 4,
                        background: c + '14', flexShrink: 0, marginTop: 1,
                        letterSpacing: '0.05em',
                      }}>
                        {f.severity?.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 12.5, color: '#4a4a5a', lineHeight: 1.55 }}>
                        {f.type}: {f.description}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* AI section */}
          <div>
            {aiState === 'idle' && (
              <button
                onClick={askPurpose}
                style={{
                  width: '100%', padding: '11px 0', borderRadius: 8,
                  background: '#1a6bff',
                  border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600, color: '#fff',
                  letterSpacing: '-0.01em',
                  boxShadow: '0 2px 10px rgba(26,107,255,0.22)',
                  transition: 'background 0.15s, box-shadow 0.15s, transform 0.15s',
                  fontFamily: 'IBM Plex Sans, sans-serif',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#0050e6'; e.currentTarget.style.transform = 'translateY(-1px)' }}
                onMouseLeave={e => { e.currentTarget.style.background = '#1a6bff'; e.currentTarget.style.transform = 'translateY(0)' }}
              >
                Explain purpose
              </button>
            )}

            {(aiState === 'loading' || aiState === 'done') && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                  <div style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: aiState === 'loading' ? '#1a6bff' : '#22c55e',
                    animation: aiState === 'loading' ? 'pulse 1s infinite' : 'none',
                  }} />
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                    color: aiState === 'loading' ? '#1a6bff' : '#22c55e',
                    textTransform: 'uppercase', letterSpacing: '0.07em',
                  }}>
                    {aiState === 'loading' ? 'Analyzing...' : 'Analysis complete'}
                  </span>
                </div>
                <div style={{
                  padding: '12px 14px',
                  background: '#f7f7f8',
                  border: '1px solid rgba(0,0,0,0.06)',
                  borderRadius: 8,
                }}>
                  <p style={{
                    fontSize: 13, color: '#4a4a5a', lineHeight: 1.75,
                    whiteSpace: 'pre-wrap', margin: 0,
                    fontFamily: 'IBM Plex Sans, sans-serif',
                  }}>
                    {aiText}
                    {aiState === 'loading' && (
                      <span style={{
                        display: 'inline-block', width: 6, height: 13, background: '#1a6bff',
                        marginLeft: 2, borderRadius: 1,
                        animation: 'blink 0.8s step-end infinite', verticalAlign: 'text-bottom',
                      }} />
                    )}
                  </p>
                  <div ref={bottomRef} />
                </div>
              </div>
            )}

            {aiState === 'error' && (
              <div style={{
                padding: 12, borderRadius: 8,
                background: 'rgba(239,68,68,0.04)',
                border: '1px solid rgba(239,68,68,0.15)',
              }}>
                <p style={{ color: '#d93025', fontSize: 12, margin: '0 0 8px', lineHeight: 1.5, fontFamily: 'IBM Plex Mono, SF Mono, monospace' }}>
                  Failed: {aiText}
                </p>
                <button
                  onClick={() => { setAiState('idle'); setAiText('') }}
                  style={{
                    fontSize: 11, color: '#7a7a8a', background: 'none',
                    border: 'none', cursor: 'pointer', textDecoration: 'underline',
                    padding: 0, fontFamily: 'IBM Plex Mono, SF Mono, monospace',
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes shimmer { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </div>
  )
}
