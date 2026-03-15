/**
 * HubPage — route: /hub
 *
 * Renders the 4-card hub.
 * - "Visual Map" card → /hub/visual-map (graph view)
 * - "Dashboard" card  → /hub/dashboard  (repo dashboard)
 * If no repoId in context, redirects to /.
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AuditComplete from '../components/AuditComplete'
import { useRepo } from '../context/RepoContext'

export default function HubPage() {
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
    <AuditComplete
      repoId={repoId}
      repoName={repoName}
      repoUrl={repoUrl}
      onReset={handleReset}
      onOpenMap={() => navigate('/hub/visual-map')}
      onOpenDashboard={() => navigate('/hub/dashboard')}
      onOpenWhatToFix={() => navigate('/hub/what-to-fix')}
    />
  )
}
