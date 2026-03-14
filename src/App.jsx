import { useState, useCallback } from 'react'
import LandingScreen from './components/LandingScreen'
import LoadingScreen from './components/LoadingScreen'
import AuditComplete from './components/AuditComplete'

/**
 * Application states:
 *  'landing'  — user has not yet submitted a repo
 *  'loading'  — Phase 1 clone+scan in progress, then Phase 2 SSE AI stream
 *  'complete' — audit finished, results shown
 */

export default function App() {
  const [screen, setScreen] = useState('landing')
  const [repoUrl, setRepoUrl] = useState('')
  const [auditId, setAuditId] = useState(null)
  const [repoName, setRepoName] = useState('')
  const [findings, setFindings] = useState([])
  const [scanSummary, setScanSummary] = useState(null)
  const [auditData, setAuditData] = useState(null)
  const [auditError, setAuditError] = useState(null)

  /**
   * Called by LandingScreen when the user submits a valid GitHub URL.
   * Kicks off Phase 1: POST /api/audit/start — clone + scan.
   * Phase 2 (SSE AI stream) is handled inside LoadingScreen.
   * @param {string} url
   */
  const handleSubmit = useCallback(async (url) => {
    setRepoUrl(url)
    setAuditId(null)
    setRepoName('')
    setFindings([])
    setScanSummary(null)
    setAuditData(null)
    setAuditError(null)
    setScreen('loading')

    try {
      const response = await fetch('/api/audit/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: url }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
        throw new Error(errData.error || `Request failed with status ${response.status}`)
      }

      const data = await response.json()

      // Hand off to LoadingScreen — it opens the SSE connection and calls onComplete
      setAuditId(data.auditId)
      setRepoName(data.repoName)
      setFindings(data.findings || [])
      setScanSummary(data.summary || null)
    } catch (err) {
      setAuditError(err.message || 'An unexpected error occurred. Is the server running?')
      setScreen('landing')
    }
  }, [])

  /**
   * Called by LoadingScreen when the SSE stream emits the "complete" event.
   * Merges the AI report with the scan data and transitions to the results screen.
   * @param {object|null} aiReport  Parsed AI report from the SSE stream, or null on error.
   */
  const handleAnalysisComplete = useCallback((aiReport) => {
    const fullAuditData = {
      auditId,
      repoUrl,
      repoName,
      findings,
      scanSummary,
      aiReport: aiReport || {
        overallRating: 'Unknown',
        executiveSummary: 'AI analysis unavailable.',
        riskScore: 0,
        categories: [],
      },
    }
    setAuditData(fullAuditData)
    setScreen('complete')
  }, [auditId, repoUrl, repoName, findings, scanSummary])

  /** Reset to landing screen. */
  const handleReset = useCallback(() => {
    setRepoUrl('')
    setAuditId(null)
    setRepoName('')
    setFindings([])
    setScanSummary(null)
    setAuditData(null)
    setAuditError(null)
    setScreen('landing')
  }, [])

  return (
    <div className="app">
      {screen === 'landing' && (
        <LandingScreen
          key="landing"
          onSubmit={handleSubmit}
          errorMessage={auditError}
        />
      )}
      {screen === 'loading' && (
        <LoadingScreen
          key="loading"
          repoUrl={repoUrl}
          repoName={repoName}
          auditId={auditId}
          findings={findings}
          onComplete={handleAnalysisComplete}
        />
      )}
      {screen === 'complete' && (
        <AuditComplete
          key="complete"
          repoUrl={repoUrl}
          auditData={auditData}
          onReset={handleReset}
        />
      )}
    </div>
  )
}
