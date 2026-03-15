import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { useRepo } from '../context/RepoContext'

export default function WhatToFixPage() {
  const navigate = useNavigate()
  const { repoId, repoName } = useRepo()
  const [state, setState] = useState('idle')
  const [recommendations, setRecommendations] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const [statusMsg, setStatusMsg] = useState('')

  async function load() {
    setState('loading')
    setStatusMsg('Analysing structure...')
    try {
      const res = await fetch('/api/audit/what-to-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId: repoId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Server error (${res.status})`)
      }
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setRecommendations(data.recommendations || [])
      setState('done')
    } catch (err) {
      setErrorMsg(err.message || 'Analysis failed')
      setState('error')
    }
  }

  return (
    <div className="screen complete-screen">
      <Navbar />

      <div className="complete-body">
        <button className="back-btn" onClick={() => navigate('/hub')} type="button">
          &#x2190; Hub
        </button>

        <div className="complete-header">
          <h1 className="complete-headline">What to Fix</h1>
          {repoName && (
            <p style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: '#7a7a8a', margin: 0 }}>{repoName}</p>
          )}
        </div>

        {state === 'idle' && (
          <div className="report-idle">
            <div className="report-idle-icon">
              <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
                <circle cx="15" cy="15" r="12" stroke="#1a6bff" strokeWidth="1.5" fill="rgba(26,107,255,0.06)" />
                <line x1="15" y1="8" x2="15" y2="16" stroke="#1a6bff" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="15" cy="20" r="1.3" fill="#1a6bff" />
              </svg>
            </div>
            <h2 className="report-idle-title">Improvement Analysis</h2>
            <p className="report-idle-desc">
              AI will review the structure of <strong>{repoName || 'this repo'}</strong> and suggest what to improve,
              refactor, or add — based on the visual map already generated.
            </p>
            <button className="report-start-btn" type="button" onClick={load}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
              </svg>
              Analyse
            </button>
          </div>
        )}

        {state === 'loading' && (
          <div className="loading-body report-loading-body">
            <h2 className="loading-headline">Analysing structure...</h2>
            <p className="loading-repo"><strong>{repoName}</strong></p>
            <div className="spinner-dots" role="status" aria-label="Loading">
              <span className="spinner-dot" />
              <span className="spinner-dot" />
              <span className="spinner-dot" />
            </div>
            {statusMsg && (
              <p style={{ fontSize: 12, color: '#7a7a8a', fontFamily: 'var(--font-mono)', marginTop: 12 }}>{statusMsg}</p>
            )}
          </div>
        )}

        {state === 'done' && (
          <div className="wtf-results">
            {recommendations.length === 0 ? (
              <div className="wtf-empty">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
                  <circle cx="20" cy="20" r="16" fill="rgba(34,197,94,0.08)" stroke="#22c55e" strokeWidth="1.5" />
                  <polyline points="11,21 18,27 29,14" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="wtf-empty-title">Nothing to modify</p>
                <p className="wtf-empty-desc">Just add new things.</p>
              </div>
            ) : (
              <>
                <p className="wtf-count">{recommendations.length} suggestion{recommendations.length !== 1 ? 's' : ''} found</p>
                <ul className="wtf-list">
                  {recommendations.map((r, i) => (
                    <li key={i} className="wtf-item">
                      <div className="wtf-item-header">
                        <span className="wtf-item-file">{r.file}</span>
                        <span className="wtf-item-title">{r.title}</span>
                      </div>
                      <p className="wtf-item-desc">{r.description}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="doc-card-regen-btn"
              type="button"
              onClick={() => { setState('idle'); setRecommendations([]) }}
            >
              Regenerate
            </button>
          </div>
        )}

        {state === 'error' && (
          <div className="report-error">
            <p className="report-error-msg">{errorMsg || 'Analysis failed.'} Please try again.</p>
            <button className="report-start-btn" type="button" onClick={() => setState('idle')}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
