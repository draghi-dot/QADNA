/**
 * LandingPage — route: /
 *
 * Renders the URL input form. On successful clone, stores repo data in
 * RepoContext and navigates to /hub.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import LandingScreen from '../components/LandingScreen'
import { useRepo } from '../context/RepoContext'
import { useAuth } from '../context/AuthContext'

export default function LandingPage() {
  const navigate = useNavigate()
  const { setRepo } = useRepo()
  const { user } = useAuth()

  const [cloneError, setCloneError] = useState(null)
  const [cloning,    setCloning]    = useState(false)

  /**
   * Called by LandingScreen when the user submits a GitHub URL.
   * Clones the repo then navigates to the hub.
   * @param {string} url
   */
  async function handleSubmit(url) {
    setCloneError(null)
    setCloning(true)
    try {
      const res = await fetch('/api/repo/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: url, userEmail: user?.email || '', uid: user?.uid || '' }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setRepo({ id: data.repoId, url, name: data.repoName })
      navigate('/hub')
    } catch (err) {
      setCloneError(err.message)
    } finally {
      setCloning(false)
    }
  }

  return (
    <LandingScreen
      onSubmit={handleSubmit}
      errorMessage={cloneError}
      loading={cloning}
    />
  )
}
