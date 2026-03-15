import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_COLOR = {
  js: '#f7df1e', jsx: '#61dafb', ts: '#3178c6', tsx: '#38bdf8',
  py: '#3776ab', go: '#00add8', css: '#c084fc', html: '#f97316',
  json: '#86efac', md: '#94a3b8',
}

const DEFAULT_QUERIES = [
  'What is the main entry point?',
  'How is the project structured?',
]

// ─── Layout helpers ───────────────────────────────────────────────────────────

/**
 * Deterministic hash of a string to a positive integer.
 * @param {string} str
 * @returns {number}
 */
function hashCode(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * Seeded pseudo-random value in [0, 1).
 * @param {number} seed
 * @returns {number}
 */
function seededRand(seed) {
  const x = Math.sin(seed + 1) * 43758.5453
  return x - Math.floor(x)
}

/**
 * Place all dirs and files on a 2D canvas using a golden-angle spiral
 * with seeded jitter, so positions are consistent across re-renders.
 *
 * @param {string[]} dirs   - Full dir path strings
 * @param {Array<{id:string}>} files - File node objects
 * @returns {Array<{x:number, y:number, w:number, h:number, isDir:boolean, id:string}>}
 */
function layoutItems(dirs, files) {
  const all = [
    ...dirs.map(d => ({ id: d, isDir: true })),
    ...files.map(f => ({ ...f, isDir: false })),
  ]

  return all.map((item, i) => {
    const seed = hashCode(item.id || String(i))
    const angle = i * 2.39996                        // golden angle
    const radius = 200 + Math.pow(i, 0.65) * 150
    const jx = (seededRand(seed) - 0.5) * 300
    const jy = (seededRand(seed + 7) - 0.5) * 200
    return {
      ...item,
      x: Math.cos(angle) * radius + jx,
      y: Math.sin(angle) * radius * 0.6 + jy,
      w: item.isDir ? 220 : 190,
      h: item.isDir ? 110 : 90,
    }
  })
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────

/**
 * Parse flat file paths into a virtual FS tree.
 * Each key is a directory path ('' = root).
 * @param {Array<{id: string}>} nodes
 * @returns {Map<string, {dirs: Set<string>, files: Array}>}
 */
function buildTree(nodes) {
  const tree = new Map()
  tree.set('', { dirs: new Set(), files: [] })

  for (const node of nodes) {
    const rawPath = node.id.replace(/^\//, '')
    const parts = rawPath.split('/')
    const filename = parts[parts.length - 1]
    if (!filename) continue

    const parentDir = parts.slice(0, -1).join('/')
    if (!tree.has(parentDir)) tree.set(parentDir, { dirs: new Set(), files: [] })
    tree.get(parentDir).files.push(node)

    for (let depth = 0; depth < parts.length - 1; depth++) {
      const dirPath = parts.slice(0, depth + 1).join('/')
      const parentPath = parts.slice(0, depth).join('/')
      if (!tree.has(dirPath)) tree.set(dirPath, { dirs: new Set(), files: [] })
      if (!tree.has(parentPath)) tree.set(parentPath, { dirs: new Set(), files: [] })
      tree.get(parentPath).dirs.add(dirPath)
    }
  }

  return tree
}

/** @param {Map} tree @param {string} dirPath @returns {number} */
function countFilesRecursive(tree, dirPath) {
  const entry = tree.get(dirPath)
  if (!entry) return 0
  let count = entry.files.length
  for (const sub of entry.dirs) count += countFilesRecursive(tree, sub)
  return count
}

/** @param {Map} tree @param {string} dirPath @param {Object} fbf @returns {number} */
function countFindingsInDir(tree, dirPath, fbf) {
  const entry = tree.get(dirPath)
  if (!entry) return 0
  let count = 0
  for (const f of entry.files) count += (fbf[f.id] || []).length
  for (const sub of entry.dirs) count += countFindingsInDir(tree, sub, fbf)
  return count
}

/** @param {string[]} paths @returns {string} */
function lcaOfPaths(paths) {
  if (!paths.length) return ''
  const split = paths.map(p => p.replace(/^\//, '').split('/').slice(0, -1))
  return split.reduce((acc, parts) => {
    const res = []
    for (let i = 0; i < Math.min(acc.length, parts.length); i++) {
      if (acc[i] === parts[i]) res.push(parts[i])
      else break
    }
    return res
  }).join('/')
}

/** @param {string} filePath @returns {string[]} */
function allAncestorDirs(filePath) {
  const parts = filePath.replace(/^\//, '').split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** @param {string} p @returns {string} */
function parentOf(p) {
  const parts = p.replace(/^\//, '').split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

function extFromId(id = '') {
  return id.split('.').pop()?.toLowerCase() || ''
}

// ─── DirCard ──────────────────────────────────────────────────────────────────

/**
 * Absolutely-positioned directory card rendered on the map canvas.
 */
function DirCard({ item, isHighlighted, tree, findingsByFile, onClick }) {
  const [hovered, setHovered] = useState(false)

  const fileCount = useMemo(() => countFilesRecursive(tree, item.id), [tree, item.id])
  const findingCount = useMemo(() => countFindingsInDir(tree, item.id, findingsByFile), [tree, item.id, findingsByFile])
  const name = item.id.split('/').pop() || 'root'

  return (
    <div
      onClick={e => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        cursor: 'pointer',
        background: isHighlighted
          ? 'linear-gradient(135deg, #dbeafe, #eff6ff)'
          : hovered
            ? 'linear-gradient(135deg, #eff6ff, #f8faff)'
            : '#ffffff',
        border: isHighlighted
          ? '2.5px solid #3b82f6'
          : hovered
            ? '2px solid #93c5fd'
            : '1.5px solid #dbeafe',
        borderRadius: 18,
        padding: '16px 18px',
        boxShadow: hovered
          ? '0 12px 40px rgba(59,130,246,0.18), 0 2px 8px rgba(0,0,0,0.06)'
          : isHighlighted
            ? '0 4px 20px rgba(59,130,246,0.18)'
            : '0 2px 12px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.15s, border-color 0.15s, background 0.15s',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Folder icon */}
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: isHighlighted ? '#dbeafe' : '#eff6ff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
              fill="#93c5fd" stroke="#3b82f6" strokeWidth="1.5" />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: '#1e40af',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {name}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
            {fileCount} file{fileCount !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {findingCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 11, color: '#ef4444', fontWeight: 600,
          background: '#fef2f2', padding: '3px 8px',
          borderRadius: 999, alignSelf: 'flex-start',
          border: '1px solid #fecaca',
        }}>
          {findingCount} {findingCount === 1 ? 'issue' : 'issues'}
        </div>
      )}

      {isHighlighted && (
        <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>
          in this flow
        </div>
      )}
    </div>
  )
}

// ─── FileCard ─────────────────────────────────────────────────────────────────

/**
 * Absolutely-positioned file card rendered on the map canvas.
 */
function FileCard({ item, isHighlighted, findingsByFile, onClick }) {
  const [hovered, setHovered] = useState(false)

  const findings = findingsByFile[item.id] || []
  const ext = extFromId(item.id)
  const color = EXT_COLOR[ext] || '#94a3b8'
  const label = item.label || item.id.split('/').pop() || item.id

  return (
    <div
      onClick={e => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        cursor: 'pointer',
        background: isHighlighted ? '#f0fdf4' : '#ffffff',
        border: isHighlighted
          ? '2.5px solid #22c55e'
          : hovered
            ? '2px solid #94a3b8'
            : '1.5px solid #e2e8f0',
        borderRadius: 14,
        padding: '12px 14px',
        boxShadow: hovered
          ? '0 8px 24px rgba(0,0,0,0.10)'
          : isHighlighted
            ? '0 4px 16px rgba(34,197,94,0.15)'
            : '0 1px 6px rgba(0,0,0,0.05)',
        transition: 'box-shadow 0.15s, border-color 0.15s',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: color + '20',
          border: `1px solid ${color}44`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <span style={{ fontSize: 9, fontWeight: 800, color, letterSpacing: '0.03em' }}>
            {ext.slice(0, 3).toUpperCase() || 'FILE'}
          </span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: '#1e293b',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={label}>
            {label}
          </div>
          <div style={{
            fontSize: 10, color: '#94a3b8',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={item.id}>
            {item.id}
          </div>
        </div>
      </div>

      {findings.length > 0 && (
        <div style={{
          fontSize: 10, color: '#ef4444', fontWeight: 600,
          background: '#fef2f2', padding: '2px 7px',
          borderRadius: 999, alignSelf: 'flex-start',
          border: '1px solid #fecaca',
        }}>
          {findings.length} {findings.length === 1 ? 'issue' : 'issues'}
        </div>
      )}

      {isHighlighted && (
        <div style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>
          in this flow
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * FileExplorer — pannable, zoomable 2D map of the repository.
 * Items are scattered organically via a golden-angle spiral with seeded jitter.
 * Pan by dragging, zoom with scroll wheel.
 *
 * @param {{ graphData: {nodes: Array}, findingsByFile: Object, auditId: string, onFileClick: Function }} props
 */
export default function FileExplorer({ graphData, findingsByFile, auditId, onFileClick }) {
  // ── Navigation state ────────────────────────────────────────────────────────
  const [currentPath, setCurrentPath] = useState('')
  const [history, setHistory] = useState([''])
  const [historyIdx, setHistoryIdx] = useState(0)

  // ── Canvas pan/zoom state ───────────────────────────────────────────────────
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const isPanning = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const scaleRef = useRef(scale)           // stable ref for wheel handler
  const canvasRef = useRef(null)

  // Keep scaleRef in sync without re-registering the wheel listener
  useEffect(() => { scaleRef.current = scale }, [scale])

  // ── Search state ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [queryFocused, setQueryFocused] = useState(false)
  const [queryLoading, setQueryLoading] = useState(false)
  const [searchResult, setSearchResult] = useState(null)
  const [highlightedFiles, setHighlightedFiles] = useState(new Set())
  const [highlightedDirs, setHighlightedDirs] = useState(new Set())
  const queryRef = useRef(null)
  const suggestionsRef = useRef(null)

  // ── Dynamic FAQ questions ───────────────────────────────────────────────────
  const [suggestedQueries, setSuggestedQueries] = useState(DEFAULT_QUERIES)
  const [faqLoading, setFaqLoading] = useState(false)

  useEffect(() => {
    if (!auditId) return
    setFaqLoading(true)
    fetch('/api/audit/generate-faq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auditId }),
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setSuggestedQueries(data.questions || DEFAULT_QUERIES))
      .catch(() => setSuggestedQueries(DEFAULT_QUERIES))
      .finally(() => setFaqLoading(false))
  }, [auditId])

  // ── Tour state ──────────────────────────────────────────────────────────────
  const [tour, setTour] = useState({ active: false, steps: [], currentIdx: 0, loading: false })

  // ── Virtual FS tree ─────────────────────────────────────────────────────────
  const tree = useMemo(() => buildTree(graphData?.nodes || []), [graphData?.nodes])

  // ── Current dir contents ────────────────────────────────────────────────────
  const currentEntry = tree.get(currentPath) || { dirs: new Set(), files: [] }
  const sortedDirs = useMemo(() => [...currentEntry.dirs].sort(), [currentEntry.dirs])
  const sortedFiles = useMemo(
    () => [...currentEntry.files].sort((a, b) => a.id.localeCompare(b.id)),
    [currentEntry.files],
  )

  // ── Organic layout ──────────────────────────────────────────────────────────
  // Re-run only when the directory changes (sortedDirs/sortedFiles identity stable per path)
  const layouted = useMemo(
    () => layoutItems(sortedDirs, sortedFiles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentPath],
  )

  // ── Fit viewport to all placed items whenever the path changes ──────────────
  useEffect(() => {
    if (!canvasRef.current || !layouted.length || tour.active) return
    const { offsetWidth: w, offsetHeight: h } = canvasRef.current
    fitToItems(layouted, w, h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, tour.active])

  function fitToItems(items, containerW, containerH) {
    if (!items.length) return
    const pad = 80
    const minX = Math.min(...items.map(n => n.x)) - pad
    const minY = Math.min(...items.map(n => n.y)) - pad
    const maxX = Math.max(...items.map(n => n.x + n.w)) + pad
    const maxY = Math.max(...items.map(n => n.y + n.h)) + pad
    const contentW = maxX - minX
    const contentH = maxY - minY
    const s = Math.min(1.2, Math.min(containerW / contentW, containerH / contentH))
    const ox = (containerW - contentW * s) / 2 - minX * s
    const oy = (containerH - contentH * s) / 2 - minY * s
    setScale(s)
    setOffset({ x: ox, y: oy })
  }

  // ── Wheel zoom (needs passive:false) ────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    function handleWheel(e) {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.12 : 0.89
      setScale(s => Math.max(0.15, Math.min(4, s * factor)))
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, []) // register once; scaleRef handles stale closure

  // ── Pan handlers ────────────────────────────────────────────────────────────
  function onMouseDown(e) {
    if (e.button !== 0) return
    isPanning.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }

  function onMouseMove(e) {
    if (!isPanning.current) return
    const dx = e.clientX - lastMouse.current.x
    const dy = e.clientY - lastMouse.current.y
    lastMouse.current = { x: e.clientX, y: e.clientY }
    setOffset(o => ({ x: o.x + dx, y: o.y + dy }))
  }

  function onMouseUp() { isPanning.current = false }

  // ── Tour handlers ──────────────────────────────────────────────────────────
  async function startTour() {
    setTour(t => ({ ...t, loading: true }))
    try {
      const res = await fetch('/api/audit/tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId }),
      })
      if (!res.ok) throw new Error('Tour generation failed')
      const data = await res.json()
      setTour({ active: true, steps: data.steps || [], currentIdx: 0, loading: false })
    } catch (err) {
      console.error('[Tour] Error:', err.message)
      setTour(t => ({ ...t, loading: false }))
    }
  }

  function nextStep() {
    setTour(t => ({ ...t, currentIdx: Math.min(t.currentIdx + 1, t.steps.length - 1) }))
  }

  function prevStep() {
    setTour(t => ({ ...t, currentIdx: Math.max(t.currentIdx - 1, 0) }))
  }

  function closeTour() {
    setTour({ active: false, steps: [], currentIdx: 0, loading: false })
    setHighlightedFiles(new Set())
    setHighlightedDirs(new Set())
  }

  // Handle tour step transitions
  useEffect(() => {
    if (!tour.active || tour.steps.length === 0) return
    const step = tour.steps[tour.currentIdx]
    if (!step) return

    const target = step.target.replace(/^\//, '')
    const targetParent = step.type === 'folder' && step.action === 'open_folder'
      ? target
      : parentOf(target)

    if (currentPath !== targetParent) {
      navigateTo(targetParent)
    }

    // After path is correct, we need to highlight and zoom
    // We'll use another useEffect that watches layouted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.active, tour.currentIdx])

  useEffect(() => {
    if (!tour.active || tour.steps.length === 0) return
    const step = tour.steps[tour.currentIdx]
    const target = step.target.replace(/^\//, '')
    const targetParent = step.type === 'folder' && step.action === 'open_folder'
      ? target
      : parentOf(target)

    if (currentPath === targetParent) {
      const found = layouted.find(item => item.id.replace(/^\//, '') === target)
      if (found) {
        if (!canvasRef.current) return
        const { offsetWidth: w, offsetHeight: h } = canvasRef.current
        // Targeted fit: zoom closer than fitToItems usually does
        const s = 1.0
        const ox = (w / 2) - (found.x + found.w / 2) * s
        const oy = (h / 2) - (found.y + found.h / 2) * s
        setScale(s)
        setOffset({ x: ox, y: oy })

        if (step.type === 'file') {
          setHighlightedFiles(new Set([target]))
          setHighlightedDirs(new Set())
        } else {
          setHighlightedDirs(new Set([target]))
          setHighlightedFiles(new Set())
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouted, tour.currentIdx, tour.active])

  // ── Navigation ──────────────────────────────────────────────────────────────
  const navigateTo = useCallback((newPath) => {
    setCurrentPath(newPath)
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIdx + 1)
      return [...trimmed, newPath]
    })
    setHistoryIdx(idx => idx + 1)
  }, [historyIdx])

  const canBack = historyIdx > 0
  const canForward = historyIdx < history.length - 1

  function goBack() {
    if (!canBack) return
    const i = historyIdx - 1
    setHistoryIdx(i)
    setCurrentPath(history[i])
  }

  function goForward() {
    if (!canForward) return
    const i = historyIdx + 1
    setHistoryIdx(i)
    setCurrentPath(history[i])
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  function clearSearch() {
    setQuery('')
    setSearchResult(null)
    setHighlightedFiles(new Set())
    setHighlightedDirs(new Set())
  }

  async function runQuery(q) {
    if (!q.trim()) return
    setQueryLoading(true)
    setSearchResult(null)
    setHighlightedFiles(new Set())
    setHighlightedDirs(new Set())
    try {
      const res = await fetch('/api/audit/flow-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId, query: q }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const paths = (data.paths || data.files || []).map(p => p.replace(/^\//, ''))
      const lca = lcaOfPaths(paths)

      const fileSet = new Set(paths)
      const dirSet = new Set()
      for (const p of paths) {
        for (const anc of allAncestorDirs(p)) dirSet.add(anc)
      }

      setSearchResult({ paths, explanation: data.explanation || '', lca })
      setHighlightedFiles(fileSet)
      setHighlightedDirs(dirSet)

      if (tree.has(lca)) navigateTo(lca)
    } catch {
      setSearchResult({ paths: [], explanation: 'Search failed. Try rephrasing.', lca: '' })
    } finally {
      setQueryLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') runQuery(query)
    if (e.key === 'Escape') { clearSearch(); queryRef.current?.blur() }
  }

  // Close suggestions on outside click
  useEffect(() => {
    function handler(e) {
      if (
        queryRef.current && !queryRef.current.contains(e.target) &&
        suggestionsRef.current && !suggestionsRef.current.contains(e.target)
      ) setQueryFocused(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Breadcrumb ──────────────────────────────────────────────────────────────
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [{ label: 'root', path: '' }]
    const parts = currentPath.split('/')
    const segs = [{ label: 'root', path: '' }]
    for (let i = 0; i < parts.length; i++) {
      segs.push({ label: parts[i], path: parts.slice(0, i + 1).join('/') })
    }
    return segs
  }, [currentPath])

  const isEmpty = layouted.length === 0

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
    }}>

      {/* ── Top bar ──────────────────────────────────────────────────────────── */}
      <div style={{
        background: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        padding: '10px 16px',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        position: 'relative',
        zIndex: 20,
      }}>

        {/* Back */}
        <button
          onClick={goBack}
          disabled={!canBack}
          title="Back"
          style={{
            width: 34, height: 34, borderRadius: 8,
            border: '1.5px solid #e2e8f0',
            background: canBack ? '#ffffff' : '#f8fafc',
            color: canBack ? '#475569' : '#cbd5e1',
            cursor: canBack ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, transition: 'all 0.15s',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>

        {/* Forward */}
        <button
          onClick={goForward}
          disabled={!canForward}
          title="Forward"
          style={{
            width: 34, height: 34, borderRadius: 8,
            border: '1.5px solid #e2e8f0',
            background: canForward ? '#ffffff' : '#f8fafc',
            color: canForward ? '#475569' : '#cbd5e1',
            cursor: canForward ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, transition: 'all 0.15s',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>

        {/* Breadcrumb */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2,
          flex: 1, minWidth: 0, overflow: 'hidden', flexWrap: 'nowrap',
        }}>
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1
            return (
              <span key={seg.path + i} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: i === 0 ? 0 : 1, minWidth: 0 }}>
                {i > 0 && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                )}
                <button
                  onClick={() => !isLast && navigateTo(seg.path)}
                  style={{
                    background: 'none', border: 'none',
                    cursor: isLast ? 'default' : 'pointer',
                    padding: '2px 6px', borderRadius: 6,
                    fontSize: 13,
                    fontWeight: isLast ? 700 : 400,
                    color: isLast ? '#0f172a' : '#64748b',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => { if (!isLast) e.currentTarget.style.color = '#0f172a' }}
                  onMouseLeave={e => { if (!isLast) e.currentTarget.style.color = '#64748b' }}
                >
                  {seg.label}
                </button>
              </span>
            )
          })}
        </div>

        {/* Take Tour Button */}
        {!tour.active && (
          <button
            onClick={startTour}
            disabled={tour.loading}
            style={{
              padding: '7px 16px', borderRadius: 999,
              background: tour.loading ? '#f1f5f9' : 'linear-gradient(90deg, #2952ff, #38bdf8)',
              color: tour.loading ? '#94a3b8' : '#ffffff',
              border: 'none', cursor: tour.loading ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 700, flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 8,
              boxShadow: tour.loading ? 'none' : '0 4px 12px rgba(41,82,255,0.2)',
              transition: 'all 0.2s',
            }}
          >
            {tour.loading ? (
              <>
                <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(148,163,184,0.3)', borderTopColor: '#94a3b8', animation: 'ca-spin 0.7s linear infinite' }} />
                Touring...
              </>
            ) : (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
                Take Tour
              </>
            )}
          </button>
        )}

        {/* Search bar */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#f1f5f9', border: '1.5px solid #e2e8f0',
            borderRadius: 999, padding: '7px 14px', width: 300,
            transition: 'all 0.2s',
          }}>
            {queryLoading
              ? <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', animation: 'ca-spin 0.7s linear infinite', flexShrink: 0 }} />
              : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
              )
            }
            <input
              ref={queryRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => { if (!query && !searchResult) setQueryFocused(true) }}
              onKeyDown={handleKeyDown}
              placeholder="Ask about the codebase..."
              style={{
                flex: 1, background: 'none', border: 'none', outline: 'none',
                fontSize: 13, color: '#1e293b',
              }}
            />
            {(query || searchResult) && (
              <button
                onClick={clearSearch}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#94a3b8', display: 'flex', alignItems: 'center' }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Suggestions dropdown */}
          {queryFocused && !query && !searchResult && (
            <div
              ref={suggestionsRef}
              style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                width: 310, background: '#ffffff',
                border: '1.5px solid #e2e8f0', borderRadius: 14,
                boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
                overflow: 'hidden', zIndex: 100,
              }}
            >
              <div style={{ padding: '8px 12px 4px', borderBottom: '1px solid #f1f5f9' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Suggested queries
                </span>
              </div>
              {faqLoading ? (
                <div style={{ padding: '12px 14px', fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #e2e8f0', borderTopColor: '#3b82f6', animation: 'ca-spin 0.7s linear infinite', flexShrink: 0 }} />
                  Generating questions for this project...
                </div>
              ) : suggestedQueries.map(s => (
                <button
                  key={s}
                  onMouseDown={() => { setQuery(s); setQueryFocused(false); runQuery(s) }}
                  style={{
                    width: '100%', textAlign: 'left', background: 'none',
                    border: 'none', cursor: 'pointer', padding: '9px 14px',
                    fontSize: 13, color: '#334155', transition: 'background 0.1s',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                  </svg>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Search result banner ──────────────────────────────────────────────── */}
      {searchResult?.explanation && (
        <div style={{
          padding: '10px 20px',
          background: 'linear-gradient(135deg, #eff6ff, #f0fdf4)',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex', alignItems: 'flex-start', gap: 10,
          flexShrink: 0, zIndex: 15,
        }}>
          <div style={{ width: 20, height: 20, borderRadius: 6, background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#1e40af' }}>
              {searchResult.paths.length} file{searchResult.paths.length !== 1 ? 's' : ''} matched
            </span>
            <span style={{ fontSize: 12, color: '#475569', marginLeft: 8 }}>
              {searchResult.explanation}
            </span>
          </div>
          <button
            onClick={clearSearch}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', flexShrink: 0, display: 'flex', alignItems: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Tour Overlay ────────────────────────────────────────────────────── */}
      {tour.active && tour.steps.length > 0 && (
        <div style={{
          position: 'absolute', bottom: 70, left: 24, right: 24,
          maxWidth: 480, margin: '0 auto',
          background: '#ffffff', border: '2.5px solid #2952ff',
          borderRadius: 20, padding: '24px',
          boxShadow: '0 20px 50px rgba(41,82,255,0.25), 0 4px 12px rgba(0,0,0,0.1)',
          zIndex: 100, display: 'flex', flexDirection: 'column', gap: 16,
          animation: 'ca-fade-up 0.4s ease-out',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                padding: '4px 10px', borderRadius: 999,
                background: '#2952ff', color: '#ffffff',
                fontSize: 11, fontWeight: 800, letterSpacing: '0.05em',
              }}>
                STEP {tour.currentIdx + 1} OF {tour.steps.length}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', opacity: 0.5 }}>
                {tour.steps[tour.currentIdx].target.split('/').pop()}
              </div>
            </div>
            <button
              onClick={closeTour}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#94a3b8', padding: 4, display: 'flex',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>

          <div style={{
            fontSize: 15, lineHeight: 1.6, color: '#1e293b',
            fontWeight: 500, minHeight: 60,
          }}>
            {tour.steps[tour.currentIdx].description}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {tour.steps.map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: i === tour.currentIdx ? 24 : 6,
                    height: 6, borderRadius: 3,
                    background: i === tour.currentIdx ? '#2952ff' : '#e2e8f0',
                    transition: 'all 0.3s ease',
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              {tour.currentIdx > 0 && (
                <button
                  onClick={prevStep}
                  style={{
                    padding: '10px 20px', borderRadius: 12,
                    background: '#f1f5f9', color: '#475569',
                    border: 'none', cursor: 'pointer',
                    fontSize: 14, fontWeight: 700,
                  }}
                >
                  Back
                </button>
              )}
              <button
                onClick={tour.currentIdx === tour.steps.length - 1 ? closeTour : nextStep}
                style={{
                  padding: '10px 28px', borderRadius: 12,
                  background: 'linear-gradient(90deg, #2952ff, #38bdf8)',
                  color: '#ffffff', border: 'none', cursor: 'pointer',
                  fontSize: 14, fontWeight: 700,
                  boxShadow: '0 4px 12px rgba(41,82,255,0.2)',
                }}
              >
                {tour.currentIdx === tour.steps.length - 1 ? 'Finish' : 'Next Step →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Map canvas ───────────────────────────────────────────────────────── */}
      <div
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'hidden',
          background: '#f0f4f8',
          backgroundImage: 'radial-gradient(circle, #c8d6e5 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          cursor: isPanning.current ? 'grabbing' : 'grab',
        }}
      >
        {/* Transformed layer — all cards live here */}
        <div style={{
          position: 'absolute',
          transformOrigin: '0 0',
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          willChange: 'transform',
        }}>
          {isEmpty ? null : layouted.map(item =>
            item.isDir ? (
              <DirCard
                key={item.id}
                item={item}
                isHighlighted={highlightedDirs.has(item.id)}
                tree={tree}
                findingsByFile={findingsByFile}
                onClick={() => navigateTo(item.id)}
              />
            ) : (
              <FileCard
                key={item.id}
                item={item}
                isHighlighted={highlightedFiles.has(item.id)}
                findingsByFile={findingsByFile}
                onClick={() => onFileClick(item)}
              />
            )
          )}
        </div>

        {/* Empty state — shown inside the canvas */}
        {isEmpty && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 12, color: '#94a3b8',
            pointerEvents: 'none',
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            </svg>
            <p style={{ fontSize: 15, margin: 0 }}>This directory is empty</p>
          </div>
        )}

        {/* ── Zoom indicator (bottom-right) ─────────────────────────────────── */}
        <div style={{
          position: 'absolute', bottom: 16, right: 16,
          display: 'flex', alignItems: 'center', gap: 6,
          zIndex: 10, pointerEvents: 'auto',
        }}>
          <button
            onClick={() => setScale(s => Math.max(0.15, s * 0.89))}
            title="Zoom out"
            style={{
              width: 28, height: 28, borderRadius: 8,
              border: '1.5px solid #dde3ea', background: '#ffffff',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#475569', boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14" /></svg>
          </button>

          <button
            onClick={() => {
              if (!canvasRef.current || !layouted.length) return
              const { offsetWidth: w, offsetHeight: h } = canvasRef.current
              fitToItems(layouted, w, h)
            }}
            title="Fit all"
            style={{
              padding: '4px 10px', borderRadius: 8,
              border: '1.5px solid #dde3ea', background: '#ffffff',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              color: '#475569', boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
              minWidth: 48, textAlign: 'center',
            }}
          >
            {Math.round(scale * 100)}%
          </button>

          <button
            onClick={() => setScale(s => Math.min(4, s * 1.12))}
            title="Zoom in"
            style={{
              width: 28, height: 28, borderRadius: 8,
              border: '1.5px solid #dde3ea', background: '#ffffff',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#475569', boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>

        {/* ── Drag hint (shown briefly when hovering over empty canvas area) ── */}
        <div style={{
          position: 'absolute', bottom: 16, left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(255,255,255,0.88)',
          border: '1px solid #e2e8f0',
          borderRadius: 999, padding: '4px 14px',
          fontSize: 11, color: '#94a3b8',
          pointerEvents: 'none',
          backdropFilter: 'blur(6px)',
          zIndex: 10,
        }}>
          Drag to pan  ·  Scroll to zoom
        </div>
      </div>

      <style>{`
        @keyframes ca-spin { to { transform: rotate(360deg) } }
        @keyframes ca-fade-up {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
