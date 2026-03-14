/**
 * Navbar — centered blue pill capsule with QADNA brand, nav links, and CTA.
 * @param {{ onStartAudit?: () => void }} props
 */

import { Link, useNavigate } from 'react-router-dom'

export default function Navbar({ onStartAudit }) {
  const navigate = useNavigate()

  function handleStartAudit() {
    if (onStartAudit) {
      onStartAudit()
    } else {
      navigate('/')
    }
  }

  return (
    <nav className="navbar" aria-label="Main navigation">
      <div className="navbar-pill">
        {/* Brand */}
        <Link className="navbar-brand" to="/" aria-label="QADNA home">
          <span className="navbar-brand-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="5" height="5" rx="1" fill="#2952ff" />
              <rect x="8" y="1" width="5" height="5" rx="1" fill="#2952ff" />
              <rect x="1" y="8" width="5" height="5" rx="1" fill="#2952ff" />
              <rect x="8" y="8" width="5" height="5" rx="1" fill="#2952ff" opacity="0.4" />
            </svg>
          </span>
          <span className="navbar-brand-name">QADNA</span>
        </Link>

        {/* Nav links */}
        <div className="navbar-links">
          <button className="navbar-link" type="button">Features</button>
          <button className="navbar-link" type="button">Docs</button>
          <button className="navbar-link" type="button">About</button>
        </div>

        {/* CTA */}
        <button
          className="navbar-cta"
          type="button"
          onClick={handleStartAudit}
          aria-label="Start a new audit"
        >
          Start Audit
        </button>
      </div>
    </nav>
  )
}
