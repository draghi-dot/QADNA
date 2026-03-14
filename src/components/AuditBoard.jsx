import { useState, useCallback } from 'react'

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

const SEVERITY_COLORS = {
  critical: { bg: '#fff0f0', text: '#c0392b', border: '#f5a5a5' },
  high:     { bg: '#fff4ec', text: '#c0622b', border: '#f5c89a' },
  medium:   { bg: '#fffbe6', text: '#946a00', border: '#f5e09a' },
  low:      { bg: '#f0f7ff', text: '#2952ff', border: '#b0c8ff' },
  info:     { bg: '#f6f6f6', text: '#555',    border: '#ddd'    },
}

const RATING_CONFIG = {
  'Critical':       { bg: '#c0392b', text: '#fff', label: 'Critical' },
  'Vulnerable':     { bg: '#d35400', text: '#fff', label: 'Vulnerable' },
  'Needs Attention':{ bg: '#f0a500', text: '#fff', label: 'Needs Attention' },
  'Secure':         { bg: '#27ae60', text: '#fff', label: 'Secure' },
  'Unknown':        { bg: '#888',    text: '#fff', label: 'Unknown' },
}

/**
 * Inline severity badge.
 * @param {{ severity: string }} props
 */
function SeverityBadge({ severity }) {
  const s = severity?.toLowerCase() || 'info'
  const colors = SEVERITY_COLORS[s] || SEVERITY_COLORS.info
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        background: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
      }}
    >
      {s}
    </span>
  )
}

/**
 * Overall rating badge (colored pill).
 * @param {{ rating: string }} props
 */
function RatingBadge({ rating }) {
  const config = RATING_CONFIG[rating] || RATING_CONFIG['Unknown']
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 14px',
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 700,
        background: config.bg,
        color: config.text,
        letterSpacing: '0.03em',
      }}
    >
      {config.label}
    </span>
  )
}

/**
 * Compact count chip for critical/high/medium/low.
 * @param {{ label: string, count: number, severity: string }} props
 */
function CountChip({ label, count, severity }) {
  if (count === 0) return null
  const colors = SEVERITY_COLORS[severity] || SEVERITY_COLORS.info
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        background: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
      }}
    >
      {count} {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Individual findings table
// ---------------------------------------------------------------------------

/**
 * Paginated table of raw scanner findings.
 * @param {{ findings: object[] }} props
 */
function FindingsTable({ findings }) {
  const PAGE_SIZE = 20
  const [page, setPage] = useState(0)

  if (!findings || findings.length === 0) {
    return <p style={{ color: '#999', fontSize: 13, marginTop: 8 }}>No findings in this category.</p>
  }

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  )

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const pageFindings = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid #e8e8e8', background: '#fafafa' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#444', whiteSpace: 'nowrap' }}>Severity</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#444' }}>File</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#444', whiteSpace: 'nowrap' }}>Line</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#444' }}>Description</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#444' }}>Snippet</th>
            </tr>
          </thead>
          <tbody>
            {pageFindings.map((f, i) => (
              <tr
                key={i}
                style={{
                  borderBottom: '1px solid #f0f0f0',
                  background: i % 2 === 0 ? '#fff' : '#fafbff',
                }}
              >
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <SeverityBadge severity={f.severity} />
                </td>
                <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, color: '#2952ff', maxWidth: 200, wordBreak: 'break-all' }}>
                  {f.file}
                </td>
                <td style={{ padding: '6px 10px', color: '#888', whiteSpace: 'nowrap' }}>
                  {f.line > 0 ? f.line : '—'}
                </td>
                <td style={{ padding: '6px 10px', color: '#333', maxWidth: 260 }}>
                  {f.description}
                </td>
                <td style={{ padding: '6px 10px', maxWidth: 240 }}>
                  {f.snippet && (
                    <code
                      style={{
                        display: 'block',
                        background: '#f5f5f5',
                        border: '1px solid #e8e8e8',
                        borderRadius: 3,
                        padding: '2px 6px',
                        fontFamily: 'monospace',
                        fontSize: 10,
                        color: '#c0392b',
                        wordBreak: 'break-all',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {f.snippet}
                    </code>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{
              padding: '4px 12px',
              border: '1px solid #ddd',
              borderRadius: 4,
              background: page === 0 ? '#f5f5f5' : '#fff',
              cursor: page === 0 ? 'not-allowed' : 'pointer',
              fontSize: 12,
              color: page === 0 ? '#aaa' : '#333',
            }}
          >
            Previous
          </button>
          <span style={{ fontSize: 12, color: '#666' }}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page === totalPages - 1}
            style={{
              padding: '4px 12px',
              border: '1px solid #ddd',
              borderRadius: 4,
              background: page === totalPages - 1 ? '#f5f5f5' : '#fff',
              cursor: page === totalPages - 1 ? 'not-allowed' : 'pointer',
              fontSize: 12,
              color: page === totalPages - 1 ? '#aaa' : '#333',
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Category sub-card
// ---------------------------------------------------------------------------

/**
 * Expandable sub-card for a single finding category from the AI report.
 * @param {{ category: object, findings: object[] }} props
 */
function CategoryCard({ category, findings }) {
  const [open, setOpen] = useState(false)
  const relatedFindings = findings.filter(
    (f) => f.category.toLowerCase() === category.name.toLowerCase(),
  )

  return (
    <div
      style={{
        border: '1px solid #e8e8e8',
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 8,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          background: open ? '#fafbff' : '#fff',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          gap: 12,
        }}
        type="button"
        aria-expanded={open}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <SeverityBadge severity={category.severity} />
          <span style={{ fontWeight: 600, fontSize: 14, color: '#1a1a1a', whiteSpace: 'nowrap' }}>
            {category.name}
          </span>
          <span style={{ fontSize: 12, color: '#888' }}>
            {category.count} finding{category.count !== 1 ? 's' : ''}
          </span>
        </div>
        <span style={{ color: '#aaa', fontSize: 16, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #f0f0f0' }}>
          <div style={{ paddingTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Risk Explanation
              </p>
              <p style={{ fontSize: 13, color: '#333', lineHeight: 1.6, margin: 0 }}>
                {category.explanation}
              </p>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Remediation
              </p>
              <p style={{ fontSize: 13, color: '#333', lineHeight: 1.6, margin: 0 }}>
                {category.remediation}
              </p>
            </div>
          </div>

          {relatedFindings.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 0 }}>
                Flagged Locations ({relatedFindings.length})
              </p>
              <FindingsTable findings={relatedFindings} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main AuditBoard
// ---------------------------------------------------------------------------

/**
 * The primary audit results board.
 * Shows repo name, overall rating, risk score, finding counts, and an
 * expandable full report with AI-generated category analysis and raw findings.
 *
 * @param {{
 *   auditData: object,
 *   onTerminate: () => void
 * }} props
 */
export default function AuditBoard({ auditData, onTerminate }) {
  const [reportOpen, setReportOpen] = useState(false)
  const [terminating, setTerminating] = useState(false)

  const handleTerminate = useCallback(async () => {
    setTerminating(true)
    try {
      await fetch(`/api/audit/${auditData.auditId}`, {
        method: 'DELETE',
      })
    } catch (err) {
      console.error('[AuditBoard] Terminate request failed:', err)
    } finally {
      onTerminate()
    }
  }, [auditData.auditId, onTerminate])

  const { repoName, repoUrl, aiReport, findings = [], scanSummary = {}, totalFiles, scannedFiles, clonedAt } = auditData
  const rating = aiReport?.overallRating ?? 'Unknown'
  const ratingConfig = RATING_CONFIG[rating] || RATING_CONFIG['Unknown']

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #e0e0e0',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        marginBottom: 32,
      }}
    >
      {/* Header row */}
      <div
        style={{
          padding: '20px 24px',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          borderBottom: reportOpen ? '1px solid #f0f0f0' : 'none',
        }}
      >
        {/* Left: repo + stats */}
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="#555" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontWeight: 700, fontSize: 17, color: '#1a1a1a', textDecoration: 'none' }}
            >
              {repoName}
            </a>
            <RatingBadge rating={rating} />
          </div>

          {/* Risk score bar */}
          {typeof aiReport?.riskScore === 'number' && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#666' }}>Risk Score</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: ratingConfig.bg }}>
                  {aiReport.riskScore} / 100
                </span>
              </div>
              <div style={{ height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${aiReport.riskScore}%`,
                    background: ratingConfig.bg,
                    borderRadius: 3,
                    transition: 'width 0.6s ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* Finding count chips */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <CountChip label="critical" count={scanSummary.critical ?? 0} severity="critical" />
            <CountChip label="high" count={scanSummary.high ?? 0} severity="high" />
            <CountChip label="medium" count={scanSummary.medium ?? 0} severity="medium" />
            <CountChip label="low" count={scanSummary.low ?? 0} severity="low" />
          </div>

          {/* Scan stats */}
          <p style={{ fontSize: 12, color: '#999', margin: 0 }}>
            {scannedFiles} files scanned of {totalFiles} total
            {clonedAt && ` · ${new Date(clonedAt).toLocaleString()}`}
          </p>
        </div>

        {/* Right: actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <button
            onClick={handleTerminate}
            disabled={terminating}
            type="button"
            style={{
              padding: '8px 16px',
              background: terminating ? '#f5f5f5' : '#fff0f0',
              color: terminating ? '#999' : '#c0392b',
              border: '1px solid',
              borderColor: terminating ? '#ddd' : '#f5a5a5',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: terminating ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {terminating ? 'Terminating...' : 'Terminate'}
          </button>

          <button
            onClick={() => setReportOpen((v) => !v)}
            type="button"
            style={{
              padding: '8px 16px',
              background: reportOpen ? '#eef1ff' : '#f7f8ff',
              color: '#2952ff',
              border: '1px solid #c8d4ff',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {reportOpen ? '▲ Hide Report' : '▼ View Full Report'}
          </button>
        </div>
      </div>

      {/* Expanded report */}
      {reportOpen && (
        <div style={{ padding: '20px 24px' }}>
          {/* Executive summary */}
          {aiReport?.executiveSummary && (
            <div style={{ marginBottom: 24 }}>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: '#666',
                  marginBottom: 8,
                }}
              >
                Executive Summary
              </p>
              <p
                style={{
                  fontSize: 14,
                  color: '#333',
                  lineHeight: 1.7,
                  background: '#fafbff',
                  border: '1px solid #e8ecff',
                  borderRadius: 8,
                  padding: '12px 16px',
                  margin: 0,
                }}
              >
                {aiReport.executiveSummary}
              </p>
              {aiReport.generatedByFallback && (
                <p style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
                  AI analysis unavailable — showing computed summary.
                </p>
              )}
            </div>
          )}

          {/* Finding categories */}
          {aiReport?.categories?.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: '#666',
                  marginBottom: 12,
                }}
              >
                Finding Categories ({aiReport.categories.length})
              </p>
              {aiReport.categories
                .slice()
                .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
                .map((cat, i) => (
                  <CategoryCard key={i} category={cat} findings={findings} />
                ))}
            </div>
          )}

          {/* All findings fallback if no categories */}
          {(!aiReport?.categories || aiReport.categories.length === 0) && findings.length > 0 && (
            <div>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: '#666',
                  marginBottom: 12,
                }}
              >
                All Findings ({findings.length})
              </p>
              <FindingsTable findings={findings} />
            </div>
          )}

          {findings.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '32px 16px',
                color: '#27ae60',
              }}
            >
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true" style={{ marginBottom: 12 }}>
                <circle cx="20" cy="20" r="19" stroke="#27ae60" strokeWidth="1.5" />
                <polyline points="12,20 18,26 28,14" stroke="#27ae60" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ fontWeight: 600, fontSize: 15, margin: 0 }}>No security issues detected</p>
              <p style={{ fontSize: 13, color: '#888', marginTop: 4 }}>Static analysis found no flagged patterns in this repository.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
