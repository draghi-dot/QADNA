import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../components/Navbar'
import VisualMap from '../components/VisualMap'
import { useRepo } from '../context/RepoContext'

export default function VisualMapPage() {
  const navigate  = useNavigate()
  const { repoId, repoUrl, repoName, setMapReady, graphJobRef, clearRepo } = useRepo()

  useEffect(() => {
    if (!repoId) navigate('/', { replace: true })
  }, [repoId, navigate])

  useEffect(() => {
    if (!repoId || graphJobRef.current) return
    const job = fetch(`/api/audit/${repoId}/graph`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(() => setMapReady(true))
      .catch(err => {
        console.warn('[VisualMapPage] Graph build error:', err.message)
        setMapReady(true)
      })
    graphJobRef.current = job
  }, [repoId, graphJobRef, setMapReady])

  if (!repoId) return null

  const auditData = { auditId: repoId, repoName, repoUrl, findings: [] }

  return (
    <div className="screen vm-page">
      <Navbar
        onStartAudit={() => { clearRepo(); navigate('/') }}
        leftAction={
          <button
            className="navbar-back-btn"
            onClick={() => navigate('/hub')}
            type="button"
            aria-label="Back to Hub"
          >
            &#x2190; Hub
          </button>
        }
      />
      <div className="vm-page-body">
        <VisualMap auditData={auditData} repoUrl={repoUrl} />
      </div>
    </div>
  )
}
