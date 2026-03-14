import { useState, useEffect, useRef } from 'react'

const EXT_COLOR = {
  js: '#f7df1e', jsx: '#61dafb', ts: '#3178c6', tsx: '#38bdf8',
  py: '#3776ab', go: '#00add8', css: '#c084fc', html: '#f97316',
  json: '#86efac', md: '#94a3b8',
}

function extColor(id = '') {
  const ext = id.split('.').pop()?.toLowerCase()
  return EXT_COLOR[ext] || '#64748b'
}

export default function FileModal({ node, auditId, onClose }) {
  const [aiState, setAiState]   = useState('idle') // idle | loading | done | error
  const [aiText,  setAiText]    = useState('')
  const bottomRef               = useRef(null)

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

  async function askPurpose() {
    if (aiState !== 'idle') return
    setAiState('loading')
    setAiText('')

    try {
      const res = await fetch('/api/audit/file-purpose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId, filePath: node.id }),
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
    /* Backdrop */
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
        padding: 24,
      }}
    >
      {/* Card — stop click propagation so clicking inside doesn't close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#18181b',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 20,
          boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
          width: '100%', maxWidth: 580,
          maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              {/* File type dot */}
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: color + '22', border: `1.5px solid ${color}55`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: '0.02em' }}>
                  {ext.slice(0, 3).toUpperCase()}
                </span>
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.label}
                </p>
                <p style={{ fontSize: 12, color: '#64748b', margin: '3px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {node.id}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ flexShrink: 0, background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: '32px', textAlign: 'center' }}
            >
              ×
            </button>
          </div>

          {/* Meta badges */}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <span style={{ padding: '3px 10px', borderRadius: 999, background: color + '18', color, fontSize: 12, fontWeight: 600, border: `1px solid ${color}33` }}>
              {node.group || ext}
            </span>
            {(node.size > 0) && (
              <span style={{ padding: '3px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.05)', color: '#94a3b8', fontSize: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
                imported by {node.size} file{node.size !== 1 ? 's' : ''}
              </span>
            )}
            {node.findingCount > 0 && (
              <span style={{ padding: '3px 10px', borderRadius: 999, background: '#ef444418', color: '#ef4444', fontSize: 12, fontWeight: 600, border: '1px solid #ef444433' }}>
                {node.findingCount} issue{node.findingCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {/* Findings list */}
          {node.findings && node.findings.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Security Findings</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {node.findings.map((f, i) => {
                  const sev = f.severity?.toLowerCase()
                  const c = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', info: '#6b7280' }[sev] || '#6b7280'
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: c + '10', border: `1px solid ${c}22` }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: c, padding: '1px 6px', borderRadius: 4, background: c + '22', flexShrink: 0, marginTop: 1 }}>
                        {f.severity?.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>{f.type}: {f.description}</span>
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
                  width: '100%', padding: '13px 0', borderRadius: 12,
                  background: 'linear-gradient(135deg, #2952ff, #38bdf8)',
                  border: 'none', cursor: 'pointer',
                  fontSize: 14, fontWeight: 700, color: '#fff',
                  letterSpacing: '0.01em',
                  boxShadow: '0 4px 24px rgba(41,82,255,0.35)',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
                onMouseLeave={e => e.currentTarget.style.opacity = '1'}
              >
                ✦ What is its purpose?
              </button>
            )}

            {(aiState === 'loading' || aiState === 'done') && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: aiState === 'loading' ? '#38bdf8' : '#22c55e', boxShadow: aiState === 'loading' ? '0 0 6px #38bdf8' : 'none', animation: aiState === 'loading' ? 'pulse 1s infinite' : 'none' }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: aiState === 'loading' ? '#38bdf8' : '#22c55e' }}>
                    {aiState === 'loading' ? 'Analyzing…' : 'Analysis complete'}
                  </span>
                </div>
                <p style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.75, whiteSpace: 'pre-wrap', margin: 0 }}>
                  {aiText}
                  {aiState === 'loading' && <span style={{ display: 'inline-block', width: 8, height: 14, background: '#38bdf8', marginLeft: 2, borderRadius: 1, animation: 'blink 0.8s step-end infinite', verticalAlign: 'text-bottom' }} />}
                </p>
                <div ref={bottomRef} />
              </div>
            )}

            {aiState === 'error' && (
              <div style={{ padding: 14, borderRadius: 10, background: '#ef444412', border: '1px solid #ef444430' }}>
                <p style={{ color: '#ef4444', fontSize: 13, margin: '0 0 10px' }}>Failed to get AI response: {aiText}</p>
                <button onClick={() => { setAiState('idle'); setAiText('') }} style={{ fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </div>
  )
}
