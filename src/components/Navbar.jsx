import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Navbar({ className = '', leftAction = null }) {
  const { user, openProfile } = useAuth()

  return (
    <nav className={`navbar${className ? ' ' + className : ''}`} aria-label="Main navigation">
      <div className="navbar-inner">
        <div className="navbar-left">
          <Link className="navbar-brand" to="/" aria-label="QADNA home">
            <div className="navbar-brand-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            </div>
            <span className="navbar-brand-name">QADNA</span>
          </Link>
          {leftAction}
        </div>

        <button
          className="navbar-profile-btn"
          type="button"
          onClick={openProfile}
          aria-label="Open profile"
        >
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              className="navbar-avatar"
              referrerPolicy="no-referrer"
            />
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          )}
        </button>
      </div>
    </nav>
  )
}
