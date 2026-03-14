/**
 * ExplorePage — route: /hub/explore
 *
 * Project explorer: Project Structure → Frameworks & Languages → Contributors.
 * No generation step — starts immediately on section 1 (Project Structure).
 * If no repoId in context, redirects to /.
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import ExplorerSections from '../components/ExplorerSections'
import { useRepo } from '../context/RepoContext'

export default function ExplorePage() {
  const navigate = useNavigate()
  const { repoId, repoUrl, repoName, clearRepo } = useRepo()

  useEffect(() => {
    if (!repoId) navigate('/', { replace: true })
  }, [repoId, navigate])

  if (!repoId) return null

  function handleReset() {
    clearRepo()
    navigate('/')
  }

  return (
    <div className="screen generating-screen">
      <Navbar onStartAudit={handleReset} />
      <div className="generating-body">
        <button className="back-btn" onClick={() => navigate('/hub')} type="button">
          &#x2190; Back to Hub
        </button>
        <div className="generating-repo-badge">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="#9b9b9b" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <a href={repoUrl} target="_blank" rel="noopener noreferrer">{repoName}</a>
        </div>
        <ExplorerSections repoId={repoId} />
      </div>
    </div>
  )
}
