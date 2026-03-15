/**
 * ExplorerSections
 *
 * Pure 3-step project explorer — no generation gate, starts on step 1.
 *
 * Step 1: Project Structure (file tree + inline code viewer)
 * Step 2: Frameworks & Languages (donut chart)
 * Step 3: Contributors (avatar list)
 *
 * All three sections are mounted simultaneously so their API calls fire
 * immediately. Visibility is controlled by opacity/pointer-events only.
 * Bottom nav (Back / Next) is always pinned to the viewport bottom.
 *
 * Props:
 *   repoId  string
 */

import { useState, useEffect, useCallback, useMemo } from 'react'

// ─── Brand color palette ──────────────────────────────────────────────────────

const CHART_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#ec4899',
  '#84cc16', '#14b8a6', '#a78bfa', '#fb923c',
]

// ─── Donut Chart ──────────────────────────────────────────────────────────────

function polarToXY(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function arcPath(cx, cy, r, startDeg, endDeg) {
  const clampedEnd = Math.min(endDeg, startDeg + 359.999)
  const start = polarToXY(cx, cy, r, startDeg)
  const end   = polarToXY(cx, cy, r, clampedEnd)
  const large = clampedEnd - startDeg > 180 ? 1 : 0
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`
}

function DonutChart({ langs, totalFiles }) {
  const [hovered, setHovered] = useState(null)
  const totalBytes = useMemo(() => langs.reduce((s, l) => s + l.bytes, 0), [langs])

  const slices = useMemo(() => {
    let cursor = 0
    return langs.map((l, idx) => {
      const pct   = totalBytes > 0 ? (l.bytes / totalBytes) * 100 : 0
      const deg   = (pct / 100) * 360
      const color = CHART_PALETTE[idx % CHART_PALETTE.length]
      const s     = { ...l, color, pct, startDeg: cursor, endDeg: cursor + deg }
      cursor += deg
      return s
    })
  }, [langs, totalBytes])

  const SIZE = 240, CX = 120, CY = 120, R_OUT = 96, R_IN = 58
  const hov  = hovered !== null ? slices[hovered] : null

  return (
    <div className="ge-donut-wrap">
      <svg className="ge-donut-svg" viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-label="Language distribution donut chart">
        <circle cx={CX} cy={CY} r={(R_OUT + R_IN) / 2}
          fill="none" stroke="rgba(0,0,0,0.04)" strokeWidth={R_OUT - R_IN} />
        {slices.map((s, i) => {
          if (s.pct < 0.3) return null
          const isHov  = hovered === i
          const outerR = isHov ? R_OUT + 7 : R_OUT
          const outer  = arcPath(CX, CY, outerR, s.startDeg, s.endDeg)
          const inner  = arcPath(CX, CY, R_IN, s.endDeg, s.startDeg)
          const ep     = polarToXY(CX, CY, R_IN, s.endDeg)
          return (
            <path key={s.name}
              d={`${outer} L ${ep.x} ${ep.y} ${inner} Z`}
              fill={s.color}
              opacity={hovered !== null && !isHov ? 0.28 : 1}
              style={{ transition: 'opacity 0.2s ease', cursor: 'pointer' }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}>
              <title>{s.name}: {s.pct.toFixed(1)}%</title>
            </path>
          )
        })}
        {hov ? (
          <>
            <text x={CX} y={CY - 10} textAnchor="middle" fill={hov.color}
              fontSize="14" fontWeight="700" fontFamily="Inter, sans-serif">{hov.name}</text>
            <text x={CX} y={CY + 9} textAnchor="middle" fill="#0a0a0a"
              fontSize="13" fontFamily="Inter, sans-serif">{hov.pct.toFixed(1)}%</text>
            <text x={CX} y={CY + 26} textAnchor="middle" fill="#7a7a8a"
              fontSize="10" fontFamily="Inter, sans-serif">
              {hov.count} file{hov.count !== 1 ? 's' : ''}
            </text>
          </>
        ) : (
          <>
            <text x={CX} y={CY - 6} textAnchor="middle" fill="#4a4a5a"
              fontSize="12" fontWeight="600" fontFamily="Inter, sans-serif">{totalFiles} files</text>
            <text x={CX} y={CY + 12} textAnchor="middle" fill="#7a7a8a"
              fontSize="10" fontFamily="Inter, sans-serif">hover to inspect</text>
          </>
        )}
      </svg>
      <div className="ge-donut-legend">
        {slices.filter(s => s.pct >= 0.3).map((s) => (
          <div key={s.name}
            className={`ge-donut-legend-item${hovered === slices.indexOf(s) ? ' ge-donut-legend-item--active' : ''}`}
            onMouseEnter={() => setHovered(slices.indexOf(s))}
            onMouseLeave={() => setHovered(null)}>
            <span className="ge-donut-legend-dot" style={{ background: s.color }} />
            <span className="ge-donut-legend-name">{s.name}</span>
            <span className="ge-donut-legend-pct">{s.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function FolderIcon({ open }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
        stroke={open ? '#1a6bff' : '#7a7a8a'}
        strokeWidth="1.6" fill={open ? 'rgba(96,165,250,0.15)' : 'none'} strokeLinejoin="round" />
    </svg>
  )
}

const EXT_COLORS = {
  js:'#f7df1e', jsx:'#61dafb', ts:'#3178c6', tsx:'#38bdf8',
  py:'#3776ab', go:'#00add8', css:'#c084fc', scss:'#c6538c',
  html:'#f97316', json:'#86efac', md:'#94a3b8', rs:'#dea584',
  vue:'#41b883', svelte:'#ff3e00',
}

function FileIcon({ ext }) {
  const color = EXT_COLORS[ext] || '#7a7a8a'
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
        stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
      <polyline points="14 2 14 8 20 8" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronRight({ open }) {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      style={{ flexShrink: 0, transition: 'transform 0.18s ease', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <polyline points="9 18 15 12 9 6" stroke="#7a7a8a"
        strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── File tree ────────────────────────────────────────────────────────────────

function TreeNode({ node, depth, onFileClick }) {
  const [open, setOpen] = useState(depth < 1)
  const ext    = node.name.includes('.') ? node.name.split('.').pop().toLowerCase() : ''
  const indent = depth * 14

  if (node.type === 'dir') {
    return (
      <div>
        <button className="ge-tree-row ge-tree-row--dir"
          style={{ paddingLeft: 6 + indent }}
          onClick={() => setOpen(o => !o)} type="button">
          <ChevronRight open={open} />
          <FolderIcon open={open} />
          <span className="ge-tree-name">{node.name}</span>
          {node.children && <span className="ge-tree-count">{node.children.length}</span>}
        </button>
        {open && node.children && node.children.map((child, i) => (
          <TreeNode key={child.path || i} node={child} depth={depth + 1} onFileClick={onFileClick} />
        ))}
      </div>
    )
  }

  return (
    <button className="ge-tree-row ge-tree-row--file ge-tree-row--clickable"
      style={{ paddingLeft: 6 + indent }} type="button" onClick={() => onFileClick(node)}>
      <span style={{ width: 9, flexShrink: 0 }} />
      <FileIcon ext={ext} />
      <span className="ge-tree-name ge-tree-name--file">{node.name}</span>
    </button>
  )
}

// ─── File viewer ──────────────────────────────────────────────────────────────

function FileViewer({ repoId, file, onBack }) {
  const [status, setStatus] = useState('loading')
  const [content, setContent] = useState('')
  const [lines, setLines]     = useState(0)
  const [truncated, setTrunc] = useState(false)
  const [err, setErr]         = useState('')

  useEffect(() => {
    if (!repoId || !file?.path) return
    setStatus('loading')
    fetch(`/api/repo/${repoId}/file?path=${encodeURIComponent(file.path)}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => { setContent(d.content); setLines(d.lines); setTrunc(d.truncated); setStatus('ready') })
      .catch(e => { setErr(e.message); setStatus('error') })
  }, [repoId, file])

  const codeLines = useMemo(() => content.split('\n'), [content])

  return (
    <div className="ge-file-viewer">
      <div className="ge-file-viewer-header">
        <button className="ge-file-viewer-back" type="button" onClick={onBack}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to Structure
        </button>
        <span className="ge-file-viewer-name">{file.name}</span>
        {status === 'ready' && (
          <span className="ge-file-viewer-meta">
            {lines} line{lines !== 1 ? 's' : ''}{truncated ? ' (first 500)' : ''}
          </span>
        )}
      </div>
      {status === 'loading' && (
        <div className="ge-spinner-row" style={{ padding: '24px 20px' }}>
          <span className="spinner-dot" /><span className="spinner-dot" /><span className="spinner-dot" />
          <span className="ge-spinner-label">Loading file...</span>
        </div>
      )}
      {status === 'error' && <p className="ge-section-error" style={{ padding: '24px 20px' }}>{err}</p>}
      {status === 'ready' && (
        <div className="ge-file-viewer-code">
          <pre className="ge-file-viewer-pre" aria-label={`Contents of ${file.name}`}>
            {codeLines.map((line, i) => (
              <div key={i} className="ge-code-line">
                <span className="ge-code-ln">{i + 1}</span>
                <span className="ge-code-text">{line}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function SectionStructure({ repoId, visible }) {
  const [status, setStatus] = useState('loading')
  const [tree, setTree]     = useState(null)
  const [err, setErr]       = useState('')
  const [viewingFile, setViewingFile] = useState(null)

  useEffect(() => {
    if (!repoId) return
    fetch(`/api/repo/${repoId}/filetree`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => { setTree(d.tree); setStatus('ready') })
      .catch(e => { setErr(e.message); setStatus('error') })
  }, [repoId])

  return (
    <div className={`ge-section${visible ? ' ge-section--visible' : ''}`}>
      <p className="ge-section-eyebrow">Project Structure</p>
      {status === 'loading' && (
        <div className="ge-spinner-row">
          <span className="spinner-dot" /><span className="spinner-dot" /><span className="spinner-dot" />
          <span className="ge-spinner-label">Loading file tree...</span>
        </div>
      )}
      {status === 'error' && <p className="ge-section-error">{err}</p>}
      {status === 'ready' && tree && !viewingFile && (
        <div className="ge-tree-scroll">
          <TreeNode node={tree} depth={0} onFileClick={setViewingFile} />
        </div>
      )}
      {status === 'ready' && viewingFile && (
        <FileViewer repoId={repoId} file={viewingFile} onBack={() => setViewingFile(null)} />
      )}
    </div>
  )
}

function SectionLanguages({ repoId, visible }) {
  const [status, setStatus]     = useState('loading')
  const [langs, setLangs]       = useState([])
  const [totalFiles, setTotal]  = useState(0)
  const [err, setErr]           = useState('')

  useEffect(() => {
    if (!repoId) return
    fetch(`/api/repo/${repoId}/languages`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => { setLangs(d.languages || []); setTotal(d.totalFiles || 0); setStatus('ready') })
      .catch(e => { setErr(e.message); setStatus('error') })
  }, [repoId])

  return (
    <div className={`ge-section ge-section--center${visible ? ' ge-section--visible' : ''}`}>
      <p className="ge-section-eyebrow">Frameworks &amp; Languages</p>
      {status === 'loading' && (
        <div className="ge-spinner-row">
          <span className="spinner-dot" /><span className="spinner-dot" /><span className="spinner-dot" />
          <span className="ge-spinner-label">Analyzing languages...</span>
        </div>
      )}
      {status === 'error' && <p className="ge-section-error">{err}</p>}
      {status === 'ready' && langs.length === 0 && <p className="ge-section-empty">No language data found.</p>}
      {status === 'ready' && langs.length > 0 && <DonutChart langs={langs} totalFiles={totalFiles} />}
    </div>
  )
}

function SectionContributors({ repoId, visible }) {
  const [status, setStatus]  = useState('loading')
  const [contributors, setC] = useState([])
  const [err, setErr]        = useState('')

  useEffect(() => {
    if (!repoId) return
    fetch(`/api/repo/${repoId}/contributors`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => { setC(d.contributors || []); setStatus('ready') })
      .catch(e => { setErr(e.message); setStatus('error') })
  }, [repoId])

  return (
    <div className={`ge-section${visible ? ' ge-section--visible' : ''}`}>
      <p className="ge-section-eyebrow">Contributors</p>
      {status === 'loading' && (
        <div className="ge-spinner-row">
          <span className="spinner-dot" /><span className="spinner-dot" /><span className="spinner-dot" />
          <span className="ge-spinner-label">Loading contributors...</span>
        </div>
      )}
      {status === 'error' && <p className="ge-section-error">{err}</p>}
      {status === 'ready' && contributors.length === 0 && <p className="ge-section-empty">No contributor history found.</p>}
      {status === 'ready' && contributors.length > 0 && (
        <div className="ge-contrib-list">
          {contributors.slice(0, 12).map((c, i) => (
            <a key={c.email || i} href={c.profileUrl} target="_blank" rel="noopener noreferrer"
              className="ge-contrib-row">
              <span className="ge-contrib-rank">#{i + 1}</span>
              <img className="ge-contrib-avatar" src={c.avatarUrl} alt={c.name}
                width={36} height={36}
                onError={ev => {
                  ev.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&size=72&background=1e293b&color=60a5fa&bold=true`
                }} />
              <div className="ge-contrib-info">
                <span className="ge-contrib-name">{c.name}</span>
                <span className="ge-contrib-email">{c.email}</span>
              </div>
              <span className="ge-contrib-commits">{c.commits} commit{c.commits !== 1 ? 's' : ''}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

const SECTION_LABELS = ['Project Structure', 'Languages', 'Contributors']
const SECTION_COUNT  = 3

/**
 * @param {{ repoId: string }} props
 */
export default function ExplorerSections({ repoId }) {
  const [step, setStep] = useState(1)   // start on section 1 immediately

  const goNext = useCallback(() => setStep(s => Math.min(s + 1, SECTION_COUNT)), [])
  const goPrev = useCallback(() => setStep(s => Math.max(s - 1, 1)),             [])

  return (
    <div className="ge-root">
      <div className="ge-sections-wrap">
        {/* Header row: section label + step dots */}
        <div className="ge-status-pill">
          <span className="ge-status-label">{SECTION_LABELS[step - 1]}</span>
        </div>

        <div className="ge-step-indicators" aria-hidden="true">
          {[1, 2, 3].map(n => (
            <span key={n}
              className={`ge-step-dot${step === n ? ' ge-step-dot--active' : step > n ? ' ge-step-dot--done' : ''}`}
            />
          ))}
        </div>

        {/* All sections mounted simultaneously */}
        <div className="ge-content-area">
          <SectionStructure    repoId={repoId} visible={step === 1} />
          <SectionLanguages    repoId={repoId} visible={step === 2} />
          <SectionContributors repoId={repoId} visible={step === 3} />
        </div>

        {/* Bottom nav */}
        <div className="ge-nav-bar">
          {step > 1 ? (
            <button className="ge-nav-btn ge-nav-btn--secondary" type="button" onClick={goPrev}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back
            </button>
          ) : (
            <span />
          )}

          {step < SECTION_COUNT ? (
            <button className="ge-nav-btn ge-nav-btn--primary" type="button" onClick={goNext}>
              Next
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <polyline points="9 18 15 12 9 6" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>
    </div>
  )
}
