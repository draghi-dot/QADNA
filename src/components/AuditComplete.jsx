import Navbar from './Navbar'
import AuditBoard from './AuditBoard'

/**
 * Extracts "owner/repo" from a GitHub URL.
 * @param {string} url
 * @returns {string}
 */
function extractRepoSlug(url) {
  try {
    const { pathname } = new URL(url)
    return pathname.replace(/^\//, '').replace(/\/$/, '')
  } catch {
    return url
  }
}

const ACTION_CARDS = [
  {
    id: 'map',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="10" cy="10" r="2.5" fill="#2952ff" />
        <circle cx="3" cy="5" r="2" stroke="#2952ff" strokeWidth="1.5" />
        <circle cx="17" cy="5" r="2" stroke="#2952ff" strokeWidth="1.5" />
        <circle cx="3" cy="15" r="2" stroke="#2952ff" strokeWidth="1.5" />
        <circle cx="17" cy="15" r="2" stroke="#2952ff" strokeWidth="1.5" />
        <line x1="4.8" y1="6.2" x2="8.2" y2="8.8" stroke="#2952ff" strokeWidth="1.2" />
        <line x1="15.2" y1="6.2" x2="11.8" y2="8.8" stroke="#2952ff" strokeWidth="1.2" />
        <line x1="4.8" y1="13.8" x2="8.2" y2="11.2" stroke="#2952ff" strokeWidth="1.2" />
        <line x1="15.2" y1="13.8" x2="11.8" y2="11.2" stroke="#2952ff" strokeWidth="1.2" />
      </svg>
    ),
    title: 'Create Visual Map',
    desc: 'Generate an interactive, force-directed graph of every module, dependency, and data flow. Navigate the entire architecture in your browser.',
    tag: 'CodeAtlas',
  },
  {
    id: 'ctf',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M10 2 L17 5.5 V10.5 Q17 15.5 10 18 Q3 15.5 3 10.5 V5.5 Z" stroke="#2952ff" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        <polyline points="7,10 9.5,12.5 13,8" stroke="#2952ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: 'CTF Testing',
    desc: 'Automatically generate Capture-The-Flag challenges derived from real vulnerabilities found in the repository. Train against live targets.',
    tag: 'Security',
  },
  {
    id: 'fix',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M14.5 2.5 L17.5 5.5 L7 16 L3 17 L4 13 Z" stroke="#2952ff" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
        <line x1="12" y1="5" x2="15" y2="8" stroke="#2952ff" strokeWidth="1.5" />
      </svg>
    ),
    title: 'Fix Problems',
    desc: 'AI-generated, context-aware patches for every flagged issue — circular deps, missing tests, exposed secrets, and high-coupling hotspots.',
    tag: 'AutoFix',
  },
]

/**
 * Step 3 — Audit complete screen.
 * Shows the AuditBoard with real scan results and AI report,
 * followed by the next-steps action cards.
 *
 * @param {{
 *   repoUrl: string,
 *   auditData: object | null,
 *   onReset: () => void
 * }} props
 */
export default function AuditComplete({ repoUrl, auditData, onReset }) {
  const slug = extractRepoSlug(repoUrl)

  // Build real stats from auditData if available
  const stats = auditData
    ? [
        { value: String(auditData.totalFiles ?? 'x'), label: 'files found' },
        { value: String(auditData.scannedFiles ?? 'x'), label: 'files scanned' },
        { value: String(auditData.findings?.length ?? 'x'), label: 'issues found' },
        { value: String(auditData.scanSummary?.critical ?? 'x'), label: 'critical' },
      ]
    : [
        { value: 'x', label: 'files scanned' },
        { value: 'x', label: 'issues found' },
      ]

  return (
    <div className="screen complete-screen">
      <Navbar onStartAudit={onReset} />

      <div className="complete-body">
        {/* Back button */}
        <button className="back-btn" onClick={onReset} type="button">
          &larr; New Audit
        </button>

        {/* Header */}
        <div className="complete-header">
          <h1 className="complete-headline">Audit complete.</h1>
          <p className="complete-repo">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="#9b9b9b" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <a href={repoUrl} target="_blank" rel="noopener noreferrer">{slug}</a>
          </p>
        </div>

        {/* Real stats row */}
        <div className="stats-row">
          {stats.map((s) => (
            <div className="stat-chip" key={s.label}>
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          ))}
        </div>

        {/* Audit board — main results */}
        {auditData && (
          <AuditBoard
            auditData={auditData}
            onTerminate={onReset}
          />
        )}

        {/* Next-steps label */}
        <p
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: '#aaa',
            marginBottom: 14,
            marginTop: 4,
          }}
        >
          Next Steps
        </p>

        {/* Action cards */}
        <div className="action-cards">
          {ACTION_CARDS.map((card) => (
            <button
              key={card.id}
              className="action-card"
              aria-label={card.title}
              type="button"
            >
              <div className="card-icon-wrap">
                {card.icon}
              </div>
              <div className="card-body">
                <p className="card-title">{card.title}</p>
                <p className="card-desc">{card.desc}</p>
              </div>
              <div className="card-footer">
                <span className="card-tag">{card.tag}</span>
                <span className="card-arrow">&#8599;</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
