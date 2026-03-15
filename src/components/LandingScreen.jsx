import { useState, useCallback } from 'react'
import Navbar from './Navbar'
import { useAuth } from '../context/AuthContext'

/**
 * Validates that the input string matches the expected GitHub repo URL format:
 * https://github.com/owner/repo  (no trailing slashes, no extra path segments)
 * @param {string} url
 * @returns {boolean}
 */
function isValidGitHubUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (parsed.hostname !== 'github.com') return false
    const parts = parsed.pathname.replace(/^\/|\/$/g, '').split('/')
    if (parts.length !== 2) return false
    if (!parts[0] || !parts[1]) return false
    return true
  } catch {
    return false
  }
}


/**
 * Step 1 — Landing / Input screen.
 * @param {{
 *   onSubmit: (url: string) => void,
 *   errorMessage?: string,
 *   loading?: boolean,
 * }} props
 */
export default function LandingScreen({ onSubmit, errorMessage, loading = false }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [touched, setTouched] = useState(false)
  const { user, hasPaid, authLoading, openProfile } = useAuth()

  const validate = useCallback((value) => {
    if (!value.trim()) return 'Enter a GitHub repository URL to continue.'
    if (!isValidGitHubUrl(value.trim())) {
      return 'Must be a valid GitHub URL — e.g. https://github.com/owner/repo'
    }
    return ''
  }, [])

  const handleChange = (e) => {
    setUrl(e.target.value)
    if (touched) {
      setError(validate(e.target.value))
    }
  }

  const handleBlur = () => {
    setTouched(true)
    setError(validate(url))
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (loading) return
    setTouched(true)
    const err = validate(url)
    setError(err)
    if (!err) {
      onSubmit(url.trim())
    }
  }

  // Determine which CTA to show based on auth + payment state
  const renderCta = () => {
    if (authLoading) return null

    if (!user) {
      return (
        <button className="submit-btn submit-btn--gate" type="button" onClick={openProfile}>
          Sign in to continue
        </button>
      )
    }

    if (!hasPaid) {
      return (
        <button className="submit-btn submit-btn--gate" type="button" onClick={openProfile}>
          Subscribe to analyze &mdash; $24.99/mo
        </button>
      )
    }

    // Fully authenticated + paid — normal flow
    if (loading) {
      return (
        <div className="clone-loading-state" role="status" aria-live="polite">
          <div className="spinner-dots spinner-dots--inline">
            <span className="spinner-dot" />
            <span className="spinner-dot" />
            <span className="spinner-dot" />
          </div>
          <span className="clone-loading-text">Cloning repository...</span>
        </div>
      )
    }

    return (
      <button className="submit-btn" type="submit">
        Analyse repository &rarr;
      </button>
    )
  }

  return (
    <div className="screen landing-screen">
      <Navbar />

      <div className="landing-hero">
        <span className="hero-eyebrow">CodeAtlas</span>

        <h1 className="hero-headline">
          Navigate any codebase<br />
          <span className="blue">in minutes, not days.</span>
        </h1>

        <p className="hero-subtitle">
          Paste a GitHub repository URL. QADNA maps every dependency,
          traces data flows, and surfaces risk — powered by AI.
        </p>

        <form className="landing-form" onSubmit={handleSubmit} noValidate>
          <input
            id="repo-input"
            className={`input-field${error ? ' is-error' : ''}`}
            type="url"
            value={url}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="https://github.com/owner/repo"
            autoComplete="off"
            spellCheck="false"
            aria-label="GitHub repository URL"
            aria-describedby={error ? 'url-error' : undefined}
            disabled={loading || !user || !hasPaid}
          />

          {error && !loading && (
            <p className="error-msg" id="url-error" role="alert">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <circle cx="6" cy="6" r="5.5" stroke="#f87171" strokeWidth="1" />
                <line x1="6" y1="3.5" x2="6" y2="6.5" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="6" cy="8.5" r="0.65" fill="#f87171" />
              </svg>
              {error}
            </p>
          )}

          {renderCta()}
        </form>

        {errorMessage && !loading && (
          <div className="server-error" role="alert">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{marginRight: 2, flexShrink: 0}}>
              <circle cx="6" cy="6" r="5.5" stroke="#c0392b" strokeWidth="1" />
              <line x1="6" y1="3.5" x2="6" y2="6.5" stroke="#c0392b" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="6" cy="8.5" r="0.65" fill="#c0392b" />
            </svg>
            {errorMessage}
          </div>
        )}

        <p className="landing-social-proof">
          <strong>12,847</strong> repositories mapped
        </p>
      </div>
    </div>
  )
}
