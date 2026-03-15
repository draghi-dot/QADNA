/**
 * RepoContext — shared state for the active cloned repository.
 *
 * Provides:
 *   repoId, repoUrl, repoName          — identity of the cloned repo
 *   setRepo({ id, url, name })         — set all three at once after a successful clone
 *   mapReady, setMapReady              — whether the graph build has finished
 *   graphJobRef                        — ref that holds the in-flight fetch promise
 *   clearRepo()                        — reset everything (New Audit)
 *   sessionLoading                     — true while checking for a saved session
 */

import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react'

const RepoContext = createContext(null)

export function RepoProvider({ children }) {
  const [repoId,   setRepoId]   = useState(null)
  const [repoUrl,  setRepoUrl]  = useState('')
  const [repoName, setRepoName] = useState('')
  const [mapReady, setMapReady] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(true)
  const graphJobRef             = useRef(null)

  // On mount: check for a saved session in Firestore
  useEffect(() => {
    fetch('/api/session/last')
      .then(r => r.json())
      .then(data => {
        if (data.audit && data.audit.auditId) {
          setRepoId(data.audit.auditId)
          setRepoUrl(data.audit.repoUrl || '')
          setRepoName(data.audit.repoName || '')
        }
      })
      .catch(() => {})
      .finally(() => setSessionLoading(false))
  }, [])

  const setRepo = useCallback(({ id, url, name }) => {
    setRepoId(id)
    setRepoUrl(url)
    setRepoName(name)
    setMapReady(false)
    graphJobRef.current = null
  }, [])

  const clearRepo = useCallback(() => {
    setRepoId(null)
    setRepoUrl('')
    setRepoName('')
    setMapReady(false)
    graphJobRef.current = null
  }, [])

  return (
    <RepoContext.Provider value={{
      repoId, repoUrl, repoName,
      setRepo,
      mapReady, setMapReady,
      graphJobRef,
      clearRepo,
      sessionLoading,
    }}>
      {children}
    </RepoContext.Provider>
  )
}

/** @returns {ReturnType<typeof RepoContext['_currentValue']>} */
export function useRepo() {
  const ctx = useContext(RepoContext)
  if (!ctx) throw new Error('useRepo must be used inside <RepoProvider>')
  return ctx
}
