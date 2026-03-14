import { useEffect, useState } from 'react'
import GraphFlow from './GraphFlow'
import FileModal from './FileModal'

// ─── Component ────────────────────────────────────────────────────────────────

export default function VisualMap({ auditData, repoUrl }) {
  const auditId  = auditData?.auditId
  const repoName = auditData?.repoName
    || repoUrl?.replace(/\/$/, '').split('/').slice(-2).join('/')
    || 'Repository'

  const [phase,     setPhase]     = useState('loading') // loading | ready | error
  const [errMsg,    setErrMsg]    = useState('')
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [panel,     setPanel]     = useState(null)

  // Progress simulation
  const [loadStep, setLoadStep] = useState(0)
  const [loadPct,  setLoadPct]  = useState(0)

  const LOAD_STEPS = [
    'Scanning repository files…',
    'Parsing import statements…',
    'Resolving dependencies…',
    'AI selecting key files…',
    'Building graph…',
  ]

  useEffect(() => {
    if (phase !== 'loading') return
    setLoadStep(0)
    setLoadPct(0)
    const pctInterval = setInterval(() => {
      setLoadPct(p => p < 88 ? Math.min(p + (Math.random() * 4 + 1), 88) : p)
    }, 400)
    const stepInterval = setInterval(() => {
      setLoadStep(s => Math.min(s + 1, LOAD_STEPS.length - 1))
    }, 1800)
    return () => { clearInterval(pctInterval); clearInterval(stepInterval) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (phase === 'ready') setLoadPct(100)
  }, [phase])

  // ── Fetch graph data ──────────────────────────────────────────────────────
  useEffect(() => {
    const findingsByFile = {}
    for (const f of (auditData?.findings || [])) {
      const key = (f.file || 'unknown').replace(/^\//, '')
      ;(findingsByFile[key] = findingsByFile[key] || []).push(f)
    }

    const buildFromFindings = () => {
      const paths = Object.keys(findingsByFile)
      if (!paths.length) {
        setErrMsg('No file data available for this audit.')
        setPhase('error')
        return
      }
      const nodes = paths.map((id) => ({
        id,
        label:    id.split('/').pop(),
        group:    groupFromId(id),
        size:     findingsByFile[id].length,
        findings: findingsByFile[id],
        findingCount: findingsByFile[id].length,
      }))
      setGraphData({ nodes, links: [] })
      setPhase('ready')
    }

    if (!auditId) { buildFromFindings(); return }

    setPhase('loading')
    fetch(`/api/audit/${auditId}/graph`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(async data => {
        const allNodes = (data.nodes || []).map(n => ({
          ...n,
          label:        n.label || n.id.split('/').pop(),
          group:        n.group || groupFromId(n.id),
          findings:     findingsByFile[n.id] || [],
          findingCount: (findingsByFile[n.id] || []).length,
        }))
        const allLinks = (data.edges || data.links || []).map(e => ({
          source: e.source,
          target: e.target,
        }))

        // Ask AI which files are most important
        let keyIds = null
        try {
          const aiRes = await fetch('/api/audit/key-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auditId }),
          })
          if (aiRes.ok) {
            const aiData = await aiRes.json()
            if (aiData.ids && aiData.ids.length > 0) keyIds = new Set(aiData.ids)
          }
        } catch {
          // silently fall back to all files
        }

        // Filter to key files only (keep edges between key nodes)
        const nodes = keyIds ? allNodes.filter(n => keyIds.has(n.id)) : allNodes
        const nodeSet = new Set(nodes.map(n => n.id))
        const links = allLinks.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target))

        setGraphData({ nodes, links })
        setPhase('ready')
      })
      .catch(() => buildFromFindings())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditId])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="vm-root">

      {/* React Flow graph */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
        {phase === 'ready' && (
          <GraphFlow
            graphData={graphData}
            onNodeClick={node => setPanel(node)}
          />
        )}
      </div>

      {/* Loading overlay */}
      {phase === 'loading' && (
        <div className="vm-overlay vm-overlay--dark">
          <p style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, marginBottom: 24, letterSpacing: '-0.01em' }}>
            Building Dependency Graph
          </p>
          <div style={{ width: 280, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 999, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{
              height: '100%', width: `${loadPct}%`,
              background: 'linear-gradient(90deg, #2952ff, #38bdf8)',
              borderRadius: 999, transition: 'width 0.4s ease',
            }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 280 }}>
            {LOAD_STEPS.map((step, i) => (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  background: i < loadStep ? '#2952ff' : i === loadStep ? 'rgba(41,82,255,0.35)' : 'rgba(255,255,255,0.08)',
                  border: i === loadStep ? '2px solid #2952ff' : '2px solid transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.4s ease',
                }}>
                  {i < loadStep && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                  {i === loadStep && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#2952ff' }} />}
                </div>
                <span style={{ fontSize: 13, color: i <= loadStep ? '#e2e8f0' : '#475569', fontWeight: i === loadStep ? 500 : 400, transition: 'color 0.3s' }}>
                  {step}
                </span>
              </div>
            ))}
          </div>
          <p style={{ color: '#475569', fontSize: 11, marginTop: 24 }}>{Math.round(loadPct)}% complete</p>
        </div>
      )}

      {/* Error overlay */}
      {phase === 'error' && (
        <div className="vm-overlay vm-overlay--dark">
          <p style={{ color: '#ef4444', fontSize: 13, textAlign: 'center', maxWidth: 340, lineHeight: 1.6 }}>
            {errMsg}
          </p>
        </div>
      )}

      {/* File detail modal */}
      {panel && (
        <FileModal
          node={panel}
          auditId={auditId}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  )
}

function groupFromId(id) {
  const dot = id.lastIndexOf('.')
  if (dot < 0) return 'other'
  const ext = id.slice(dot + 1).toLowerCase()
  const MAP = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
    ts: 'ts', tsx: 'tsx', py: 'py', go: 'go',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', json: 'json', md: 'md',
  }
  return MAP[ext] || 'other'
}
