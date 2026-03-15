/**
 * RepoDashboardPage — route: /hub/dashboard
 *
 * Repository overview: commit count, contributors, mapped nodes, languages.
 */

import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { useRepo } from '../context/RepoContext'

// ─── Commit activity bar (mini sparkline per contributor) ────────────────────

function CommitBar({ commits, max }) {
  const pct = max > 0 ? (commits / max) * 100 : 0
  return (
    <div className="rd-commit-bar">
      <div className="rd-commit-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

// ─── Language bar chart ──────────────────────────────────────────────────────

function LanguageChart({ languages }) {
  if (!languages || languages.length === 0) return null

  const total = languages.reduce((s, l) => s + l.bytes, 0)

  return (
    <div className="rd-lang">
      {/* Stacked bar */}
      <div className="rd-lang-bar">
        {languages.map(l => {
          const pct = total > 0 ? (l.bytes / total) * 100 : 0
          if (pct < 0.5) return null
          return (
            <div
              key={l.name}
              className="rd-lang-bar-seg"
              style={{ width: `${pct}%`, background: l.color }}
              title={`${l.name} ${l.percentage}%`}
            />
          )
        })}
      </div>

      {/* Legend */}
      <div className="rd-lang-legend">
        {languages.map(l => (
          <div key={l.name} className="rd-lang-item">
            <span className="rd-lang-dot" style={{ background: l.color }} />
            <span className="rd-lang-name">{l.name}</span>
            <span className="rd-lang-pct">{l.percentage}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function RepoDashboardPage() {
  const navigate = useNavigate()
  const { repoId, repoUrl, repoName, clearRepo } = useRepo()

  const [contributors, setContributors] = useState([])
  const [totalCommits, setTotalCommits] = useState(0)
  const [graphNodes, setGraphNodes]     = useState(null)
  const [contribStatus, setContribStatus] = useState('loading')
  const [graphStatus, setGraphStatus]     = useState('loading')
  const [contribError, setContribError]   = useState('')

  const [languages, setLanguages]       = useState([])
  const [langStatus, setLangStatus]     = useState('loading')

  useEffect(() => {
    if (!repoId) navigate('/', { replace: true })
  }, [repoId, navigate])

  // Fetch contributors
  function fetchContributors() {
    if (!repoId) return
    setContribStatus('loading')
    setContribError('')
    fetch(`/api/repo/${repoId}/contributors`)
      .then(r => r.ok ? r.json() : r.json().catch(() => ({})).then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => {
        setContributors(d.contributors || [])
        setTotalCommits(d.totalCommits || 0)
        setContribStatus('ready')
      })
      .catch(e => { setContribError(e.message); setContribStatus('error') })
  }

  // Fetch graph node count
  function fetchGraph() {
    if (!repoId) return
    setGraphStatus('loading')
    fetch(`/api/audit/${repoId}/graph`)
      .then(r => r.ok ? r.json() : r.json().catch(() => ({})).then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => {
        const nodes = d.nodes || d.graph?.nodes || []
        setGraphNodes(nodes.length)
        setGraphStatus('ready')
      })
      .catch(() => { setGraphNodes(null); setGraphStatus('error') })
  }

  // Fetch languages
  function fetchLanguages() {
    if (!repoId) return
    setLangStatus('loading')
    fetch(`/api/repo/${repoId}/github-languages`)
      .then(r => r.ok ? r.json() : r.json().catch(() => ({})).then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(d => {
        setLanguages(d.languages || [])
        setLangStatus('ready')
      })
      .catch(() => { setLanguages([]); setLangStatus('ready') })
  }

  useEffect(() => { fetchContributors() }, [repoId])
  useEffect(() => { fetchGraph() }, [repoId])
  useEffect(() => { fetchLanguages() }, [repoId])

  const maxCommits = useMemo(
    () => Math.max(...contributors.map(c => c.commits || 0), 1),
    [contributors]
  )

  if (!repoId) return null

  function handleReset() { clearRepo(); navigate('/') }

  const isLoading = contribStatus === 'loading' || graphStatus === 'loading'

  return (
    <div className="screen rd-screen">
      <Navbar onStartAudit={handleReset} />

      <div className="rd-body">
        <button className="back-btn" onClick={() => navigate('/hub')} type="button">
          &#x2190; Hub
        </button>

        {/* Header */}
        <div className="rd-header">
          <h1 className="rd-title">Repository Overview</h1>
          <a className="rd-repo-link" href={repoUrl} target="_blank" rel="noopener noreferrer">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {repoName}
          </a>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="rd-loading">
            <div className="spinner-dots" aria-label="Loading" role="status">
              <span className="spinner-dot" /><span className="spinner-dot" /><span className="spinner-dot" />
            </div>
            <span className="rd-loading-label">Fetching repository data...</span>
          </div>
        )}

        {!isLoading && (
          <>
            {/* ─── Stat strip ─── */}
            <div className="rd-stats">
              <div className="rd-stat">
                <span className="rd-stat-num">{totalCommits}</span>
                <span className="rd-stat-label">commits</span>
              </div>
              <div className="rd-stat-divider" />
              <div className="rd-stat">
                <span className="rd-stat-num">{contributors.length}</span>
                <span className="rd-stat-label">contributors</span>
              </div>
              <div className="rd-stat-divider" />
              <div className="rd-stat">
                <span className="rd-stat-num">{graphNodes ?? '—'}</span>
                <span className="rd-stat-label">nodes mapped</span>
                {graphStatus === 'error' && (
                  <button className="rd-retry-btn rd-retry-btn--inline" type="button" onClick={fetchGraph}>
                    retry
                  </button>
                )}
              </div>
              <div className="rd-stat-divider" />
              <div className="rd-stat">
                <span className="rd-stat-num">{languages.length}</span>
                <span className="rd-stat-label">languages</span>
              </div>
            </div>

            {/* ─── Two-column content ─── */}
            <div className="rd-columns">

              {/* Contributors log */}
              <div className="rd-panel">
                <div className="rd-panel-header">
                  <span className="rd-panel-title">Contributors</span>
                  <span className="rd-panel-meta">{contributors.length} authors</span>
                </div>

                {contribStatus === 'error' && (
                  <div className="rd-panel-error">
                    <p>{contribError}</p>
                    <button className="rd-retry-btn" type="button" onClick={fetchContributors}>
                      Retry
                    </button>
                  </div>
                )}

                {contribStatus === 'ready' && contributors.length === 0 && (
                  <p className="rd-panel-empty">No contributor data found.</p>
                )}

                {contribStatus === 'ready' && contributors.length > 0 && (
                  <div className="rd-contrib-list">
                    {contributors.map((c, i) => {
                      const hasLink = c.profileUrl && c.profileUrl !== '#'
                      const Tag = hasLink ? 'a' : 'div'
                      const linkProps = hasLink
                        ? { href: c.profileUrl, target: '_blank', rel: 'noopener noreferrer' }
                        : {}
                      return (
                        <Tag
                          key={c.email || i}
                          {...linkProps}
                          className={`rd-contrib-row${hasLink ? '' : ' rd-contrib-row--no-link'}`}
                        >
                          <span className="rd-contrib-rank">{i + 1}</span>
                          <img
                            className="rd-contrib-avatar"
                            src={c.avatarUrl}
                            alt=""
                            width={28}
                            height={28}
                            onError={ev => {
                              ev.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&size=56&background=f0f0f5&color=4a4a5a&bold=true&format=svg`
                            }}
                          />
                          <div className="rd-contrib-id">
                            <span className="rd-contrib-name">{c.name}</span>
                            <span className="rd-contrib-email">{c.email}</span>
                          </div>
                          <CommitBar commits={c.commits} max={maxCommits} />
                          <span className="rd-contrib-count">{c.commits}</span>
                        </Tag>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Languages */}
              <div className="rd-panel">
                <div className="rd-panel-header">
                  <span className="rd-panel-title">Languages</span>
                  <span className="rd-panel-meta">{languages.length} detected</span>
                </div>

                {langStatus === 'loading' && (
                  <div className="rd-panel-loading">
                    <div className="spinner-dots" aria-label="Loading" role="status">
                      <span className="spinner-dot" /><span className="spinner-dot" /><span className="spinner-dot" />
                    </div>
                  </div>
                )}

                {langStatus === 'ready' && languages.length === 0 && (
                  <p className="rd-panel-empty">No language data available.</p>
                )}

                {langStatus === 'ready' && languages.length > 0 && (
                  <LanguageChart languages={languages} />
                )}
              </div>

            </div>
          </>
        )}
      </div>
    </div>
  )
}
