import { useState, useCallback } from 'react'
import Navbar from './Navbar'

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
 * Simple shield + code SVG illustration for the hero section.
 */
function HeroIllustration() {
  return (
    <svg
      width="480"
      height="160"
      viewBox="0 0 480 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      role="img"
    >
      {/* Code lines — left block */}
      <rect x="0" y="20" width="140" height="12" rx="6" fill="#e5e5e5" />
      <rect x="0" y="40" width="100" height="12" rx="6" fill="#eef1ff" />
      <rect x="0" y="60" width="120" height="12" rx="6" fill="#e5e5e5" />
      <rect x="0" y="80" width="80" height="12" rx="6" fill="#eef1ff" />
      <rect x="0" y="100" width="130" height="12" rx="6" fill="#e5e5e5" />
      <rect x="0" y="120" width="90" height="12" rx="6" fill="#eef1ff" />

      {/* Connector line */}
      <line x1="155" y1="80" x2="185" y2="80" stroke="#d0d0d0" strokeWidth="1.5" strokeDasharray="4 3" />

      {/* Center shield */}
      <path
        d="M240 20 L270 35 L270 80 Q270 108 240 118 Q210 108 210 80 L210 35 Z"
        fill="#eef1ff"
        stroke="#2952ff"
        strokeWidth="1.5"
      />
      <path
        d="M240 44 L255 52 L255 79 Q255 96 240 102 Q225 96 225 79 L225 52 Z"
        fill="#2952ff"
        opacity="0.15"
      />
      {/* Shield checkmark */}
      <polyline
        points="230,73 237,81 252,64"
        stroke="#2952ff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Connector line */}
      <line x1="295" y1="80" x2="325" y2="80" stroke="#d0d0d0" strokeWidth="1.5" strokeDasharray="4 3" />

      {/* Code lines — right block */}
      <rect x="340" y="20" width="140" height="12" rx="6" fill="#e5e5e5" />
      <rect x="340" y="40" width="110" height="12" rx="6" fill="#eef1ff" />
      <rect x="340" y="60" width="130" height="12" rx="6" fill="#e5e5e5" />
      <rect x="340" y="80" width="90" height="12" rx="6" fill="#eef1ff" />
      <rect x="340" y="100" width="120" height="12" rx="6" fill="#e5e5e5" />
      <rect x="340" y="120" width="80" height="12" rx="6" fill="#eef1ff" />

      {/* Blue accent dots at nodes */}
      <circle cx="155" cy="80" r="4" fill="#2952ff" />
      <circle cx="325" cy="80" r="4" fill="#2952ff" />
    </svg>
  )
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

  // Scroll to the form when the navbar CTA is clicked
  const scrollToForm = () => {
    document.getElementById('repo-input')?.focus()
  }

  return (
    <div className="screen landing-screen">
      <Navbar onStartAudit={scrollToForm} />

      <div className="landing-hero">
        <h1 className="hero-headline">
          Audit any GitHub repo.<br />
          <span className="blue">Find vulnerabilities fast.</span>
        </h1>

        <p className="hero-subtitle">
          Paste a repository URL and CodeAtlas maps every dependency, flags security
          risks, and generates an interactive visual blueprint — powered by AI.
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
            disabled={loading}
          />

          {error && !loading && (
            <p className="error-msg" id="url-error" role="alert">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="6" stroke="#d93025" strokeWidth="1" />
                <line x1="6.5" y1="3.5" x2="6.5" y2="7" stroke="#d93025" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="6.5" cy="9.25" r="0.75" fill="#d93025" />
              </svg>
              {error}
            </p>
          )}

          {loading ? (
            <div className="clone-loading-state" role="status" aria-live="polite">
              <div className="spinner-dots spinner-dots--inline">
                <span className="spinner-dot" style={{ background: '#2952ff' }} />
                <span className="spinner-dot" style={{ background: '#2952ff' }} />
                <span className="spinner-dot" style={{ background: '#2952ff' }} />
              </div>
              <span className="clone-loading-text">Cloning repository...</span>
            </div>
          ) : (
            <button className="submit-btn" type="submit">
              Start Audit &rarr;
            </button>
          )}
        </form>

        {errorMessage && !loading && (
          <div className="server-error" role="alert">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{marginRight: 6, flexShrink: 0}}>
              <circle cx="7" cy="7" r="6.5" stroke="#c0392b" strokeWidth="1" />
              <line x1="7" y1="3.5" x2="7" y2="7.5" stroke="#c0392b" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="7" cy="10" r="0.75" fill="#c0392b" />
            </svg>
            {errorMessage}
          </div>
        )}

        <div className="hero-illustration">
          <HeroIllustration />
        </div>
      </div>
    </div>
  )
}
