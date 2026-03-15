import { useEffect, useState, useMemo, useCallback } from 'react'
import GraphFlow from './GraphFlow'
import FileModal from './FileModal'

// ─── Helper ───────────────────────────────────────────────────────────────────

function groupFromId(id) {
  const dot = id.lastIndexOf('.')
  if (dot < 0) return 'other'
  const ext = id.slice(dot + 1).toLowerCase()
  const MAP = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
    ts: 'ts', tsx: 'tsx', py: 'py', go: 'go',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', json: 'json', md: 'md',
  }
  return MAP[ext] || 'other'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingOverlay({ loadPct, loadStep, LOAD_STEPS }) {
  return (
    <div className="vm-overlay" style={{ background: '#ffffff' }}>
      <p style={{ color: '#0f172a', fontSize: 15, fontWeight: 600, marginBottom: 24, letterSpacing: '-0.01em' }}>
        Building Dependency Graph
      </p>
      <div style={{ width: 280, height: 4, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{
          height: '100%', width: `${loadPct}%`,
          background: 'linear-gradient(90deg, #2952ff, #38bdf8)',
          borderRadius: 999, transition: 'width 0.4s ease',
        }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 280 }}>
        {LOAD_STEPS.map((step, i) => (
          <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
              background: i < loadStep ? '#2952ff' : i === loadStep ? 'rgba(41,82,255,0.15)' : '#f1f5f9',
              border: i === loadStep ? '2px solid #2952ff' : '2px solid #e2e8f0',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.4s ease',
            }}>
              {i < loadStep && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              {i === loadStep && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#2952ff' }} />}
            </div>
            <span style={{ fontSize: 13, color: i <= loadStep ? '#0f172a' : '#94a3b8', fontWeight: i === loadStep ? 500 : 400, transition: 'color 0.3s' }}>
              {step}
            </span>
          </div>
        ))}
      </div>
      <p style={{ color: '#94a3b8', fontSize: 11, marginTop: 24 }}>{Math.round(loadPct)}% complete</p>
    </div>
  )
}

function ErrorOverlay({ errMsg }) {
  return (
    <div className="vm-overlay" style={{ background: '#ffffff' }}>
      <p style={{ color: '#ef4444', fontSize: 13, textAlign: 'center', maxWidth: 340, lineHeight: 1.6 }}>
        {errMsg}
      </p>
    </div>
  )
}

function WelcomeOverlay({ repoName, onTour, onExplore, keyFilesReady }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 50,
      background: 'rgba(10,14,20,0.72)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: 12,
        padding: '36px 36px 32px',
        maxWidth: 440,
        width: 'calc(100% - 40px)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.30)',
        textAlign: 'center',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 44, height: 44, borderRadius: 10,
          background: 'rgba(26,107,255,0.08)',
          border: '1px solid rgba(26,107,255,0.18)',
          marginBottom: 18,
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" fill="#1a6bff"/>
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" stroke="#1a6bff" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>

        <h1 style={{
          fontSize: 20, fontWeight: 700, color: '#0a0a0a',
          marginBottom: 8, letterSpacing: '-0.025em', lineHeight: 1.2,
          fontFamily: 'IBM Plex Sans, sans-serif',
        }}>
          {repoName}
        </h1>
        <p style={{
          fontSize: 13, color: '#4a4a5a', lineHeight: 1.7,
          maxWidth: 340, margin: '0 auto 28px',
          fontFamily: 'IBM Plex Sans, sans-serif',
        }}>
          New to this codebase? Let AI guide you through the architecture, or explore freely.
        </p>

        <button
          onClick={keyFilesReady ? onTour : undefined}
          disabled={!keyFilesReady}
          style={{
            display: 'block', width: '100%',
            padding: '12px 20px',
            background: keyFilesReady ? '#1a6bff' : 'rgba(0,0,0,0.07)',
            color: keyFilesReady ? '#ffffff' : '#7a7a8a',
            border: 'none', borderRadius: 8,
            fontSize: 13, fontWeight: 600,
            fontFamily: 'IBM Plex Sans, sans-serif',
            cursor: keyFilesReady ? 'pointer' : 'default',
            marginBottom: 8,
            boxShadow: keyFilesReady ? '0 2px 10px rgba(26,107,255,0.28)' : 'none',
            transition: 'background 0.15s, transform 0.15s, box-shadow 0.15s',
            letterSpacing: '-0.01em',
          }}
          onMouseEnter={e => { if (keyFilesReady) { e.currentTarget.style.background = '#0050e6'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(26,107,255,0.38)' }}}
          onMouseLeave={e => { if (keyFilesReady) { e.currentTarget.style.background = '#1a6bff'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(26,107,255,0.28)' }}}
        >
          {keyFilesReady ? 'Take the Tour' : 'Analyzing key files...'}
        </button>
        <p style={{
          fontSize: 10, color: '#aaa', marginBottom: 14, marginTop: 5,
          fontFamily: 'IBM Plex Mono, monospace', letterSpacing: '0.04em',
        }}>
          Powered by AI
        </p>

        <button
          onClick={onExplore}
          style={{
            display: 'block', width: '100%',
            padding: '10px 20px',
            background: 'transparent',
            color: '#4a4a5a',
            border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8,
            fontSize: 13, fontWeight: 500,
            fontFamily: 'IBM Plex Sans, sans-serif',
            cursor: 'pointer',
            transition: 'border-color 0.15s, background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#f7f7f8'; e.currentTarget.style.borderColor = 'rgba(0,0,0,0.16)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'rgba(0,0,0,0.10)' }}
        >
          Explore freely &#8594;
        </button>
      </div>
    </div>
  )
}

function TourLoadingOverlay() {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

  const tips = [
    'Analyzing import graphs and data flows...',
    'Building a narrative tour through the codebase...',
    'Tracing connections between modules...',
    'Crafting step-by-step explanations...',
  ]
  const tipIdx = Math.floor(elapsed / 6) % tips.length

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 60,
      background: 'rgba(15,23,42,0.82)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 16,
    }}>
      <style>{`
        @keyframes vmSpin { to { transform: rotate(360deg); } }
      `}</style>
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        border: '3px solid rgba(41,82,255,0.25)',
        borderTopColor: '#2952ff',
        animation: 'vmSpin 0.85s linear infinite',
      }} />
      <p style={{ color: '#f8fafc', fontSize: 15, fontWeight: 600 }}>
        AI is generating your tour...
      </p>
      <p style={{ color: '#94a3b8', fontSize: 13, transition: 'opacity 0.3s' }}>
        {tips[tipIdx]}
      </p>
      <p style={{ color: '#475569', fontSize: 12, fontFamily: 'monospace' }}>
        {timeStr}
      </p>
    </div>
  )
}

function TourSidebar({ steps, currentIdx, onStepClick, onExit, repoName }) {
  return (
    <div style={{
      width: 256, flexShrink: 0,
      background: '#ffffff',
      display: 'flex', flexDirection: 'column',
      borderRight: '1px solid rgba(0,0,0,0.07)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
        <div style={{
          fontSize: 9, fontWeight: 700, color: '#1a6bff',
          letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: 5, fontFamily: 'IBM Plex Mono, monospace',
        }}>
          Guided Tour
        </div>
        <div style={{
          fontSize: 12, fontWeight: 600, color: '#4a4a5a',
          marginBottom: 10, lineHeight: 1.4, wordBreak: 'break-all',
          fontFamily: 'IBM Plex Mono, monospace',
        }}>
          {repoName}
        </div>

        {/* Progress bar */}
        <div style={{ height: 2, background: 'rgba(0,0,0,0.06)', borderRadius: 999, marginBottom: 7, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${steps.length > 0 ? ((currentIdx + 1) / steps.length) * 100 : 0}%`,
            background: '#1a6bff',
            borderRadius: 999,
            transition: 'width 0.4s ease',
          }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{
            fontSize: 10, color: '#7a7a8a',
            fontFamily: 'IBM Plex Mono, monospace',
          }}>
            {currentIdx + 1} / {steps.length}
          </span>
          <button
            onClick={onExit}
            style={{
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid rgba(0,0,0,0.07)',
              color: '#7a7a8a', borderRadius: 4, padding: '2px 9px',
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >
            Exit
          </button>
        </div>
      </div>

      {/* Step list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {steps.map((step, idx) => {
          const isDone    = idx < currentIdx
          const isCurrent = idx === currentIdx
          const fileName  = step.title || (step.target || '').split('/').pop() || 'Step'

          return (
            <button
              key={idx}
              onClick={() => onStepClick(idx)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                width: '100%', textAlign: 'left',
                padding: '8px 16px',
                background: isCurrent ? 'rgba(26,107,255,0.14)' : 'transparent',
                border: 'none',
                borderLeft: isCurrent ? '2px solid #1a6bff' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'rgba(0,0,0,0.03)' }}
              onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
            >
              {/* Step number circle */}
              <div style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 700,
                fontFamily: 'IBM Plex Mono, monospace',
                background: isDone ? '#1a6bff' : 'transparent',
                border: isDone ? 'none' : isCurrent ? '1.5px solid #1a6bff' : '1px solid rgba(0,0,0,0.12)',
                color: isDone ? '#fff' : isCurrent ? '#1a6bff' : '#7a7a8a',
              }}>
                {isDone ? (
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                    <path d="M2 5l2.5 2.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : idx + 1}
              </div>

              <div style={{ overflow: 'hidden' }}>
                <div style={{
                  fontSize: 11.5, fontWeight: isCurrent ? 600 : 400,
                  fontFamily: 'IBM Plex Sans, sans-serif',
                  color: isCurrent ? '#0a0a0a' : isDone ? '#7a7a8a' : '#4a4a5a',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {fileName}
                </div>
                <div style={{
                  fontSize: 10, color: '#7a7a8a',
                  marginTop: 1, fontFamily: 'IBM Plex Mono, monospace',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {(step.target || '').split('/').pop()}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TourStepCard({ step, stepIdx, totalSteps, onPrev, onNext, onExit }) {
  const isLast    = stepIdx === totalSteps - 1
  const relatesTo = step.relatesTo || []

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      zIndex: 40,
      background: '#ffffff',
      borderTop: '1px solid rgba(0,0,0,0.07)',
      boxShadow: '0 -4px 20px rgba(0,0,0,0.06)',
    }}>
      {/* Progress bar */}
      <div style={{ height: 2, background: 'rgba(0,0,0,0.05)' }}>
        <div style={{
          height: '100%',
          width: `${((stepIdx + 1) / totalSteps) * 100}%`,
          background: 'linear-gradient(90deg, #1a6bff, #38bdf8)',
          transition: 'width 0.4s ease',
        }} />
      </div>

      <div style={{ padding: '18px 28px', display: 'flex', alignItems: 'flex-start', gap: 28 }}>
        {/* Left: content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Step counter + title */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#1a6bff', letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0 }}>
              {stepIdx + 1} / {totalSteps}
            </span>
            {step.title && (
              <span style={{ fontSize: 15, fontWeight: 700, color: '#0a0a0a', letterSpacing: '-0.01em' }}>
                {step.title}
              </span>
            )}
            <code style={{
              fontSize: 11, color: '#7a7a8a', fontFamily: 'monospace',
              background: 'rgba(0,0,0,0.04)', borderRadius: 4,
              padding: '1px 6px', marginLeft: 'auto', flexShrink: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220,
            }}>
              {step.target || ''}
            </code>
          </div>

          {/* Description */}
          <p style={{ fontSize: 13, color: '#4a4a5a', lineHeight: 1.7, margin: '0 0 10px' }}>
            {step.description || ''}
          </p>

          {/* Relates-to badges */}
          {relatesTo.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#7a7a8a', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 2 }}>
                connects to
              </span>
              {relatesTo.map(rel => (
                <span key={rel} style={{
                  fontSize: 11, fontFamily: 'monospace',
                  background: 'rgba(26,107,255,0.08)', color: '#1a6bff',
                  border: '1px solid rgba(26,107,255,0.2)',
                  borderRadius: 4, padding: '1px 7px',
                }}>
                  {rel.split('/').pop()}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Right: navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 2 }}>
          <button
            onClick={onPrev}
            disabled={stepIdx === 0}
            style={{
              padding: '8px 16px', borderRadius: 8,
              background: stepIdx === 0 ? 'transparent' : 'rgba(0,0,0,0.04)',
              border: '1px solid rgba(0,0,0,0.07)',
              color: stepIdx === 0 ? '#c0c0c8' : '#4a4a5a',
              fontSize: 13, fontWeight: 600,
              cursor: stepIdx === 0 ? 'default' : 'pointer',
            }}
          >
            ← Prev
          </button>
          {isLast ? (
            <button
              onClick={onExit}
              style={{
                padding: '8px 22px', borderRadius: 8,
                background: '#16a34a', border: 'none',
                color: '#ffffff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(22,163,74,0.35)',
              }}
            >
              Finish ✓
            </button>
          ) : (
            <button
              onClick={onNext}
              style={{
                padding: '8px 22px', borderRadius: 8,
                background: 'linear-gradient(135deg, #2952ff, #38bdf8)', border: 'none',
                color: '#ffffff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 4px 12px rgba(41,82,255,0.35)',
              }}
            >
              Next Step →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function RiskFlagsPanel({ riskyNodes, onNodeClick }) {
  const [expanded, setExpanded] = useState(false)

  if (!riskyNodes.length) return null

  const highCount = riskyNodes.filter(n => n.maxSeverity === 'high').length

  return (
    <div style={{
      position: 'absolute', bottom: 20, left: 20, zIndex: 30,
      fontFamily: 'IBM Plex Sans, sans-serif',
    }}>
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '9px 16px',
            background: '#ffffff',
            color: '#0a0a0a',
            border: '1px solid rgba(0,0,0,0.07)',
            borderRadius: 8,
            fontSize: 12, fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            transition: 'background 0.15s, transform 0.15s',
            letterSpacing: '-0.01em',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#fcfcfc'; e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={e => { e.currentTarget.style.background = '#ffffff'; e.currentTarget.style.transform = 'translateY(0)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={highCount > 0 ? '#ef4444' : '#f59e0b'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          {riskyNodes.length} Risk Flag{riskyNodes.length !== 1 ? 's' : ''}
        </button>
      ) : (
        <div style={{
          background: '#ffffff',
          border: '1px solid rgba(0,0,0,0.07)',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
          width: 280,
          maxHeight: 360,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid rgba(0,0,0,0.06)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0a0a0a', letterSpacing: '-0.01em' }}>
              Risk Flags ({riskyNodes.length})
            </span>
            <button
              onClick={() => setExpanded(false)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#7a7a8a', fontSize: 16, lineHeight: 1, padding: '2px 4px',
              }}
            >
              ×
            </button>
          </div>

          {/* List */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {riskyNodes.map(node => (
              <button
                key={node.id}
                onClick={() => onNodeClick(node)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  width: '100%', textAlign: 'left',
                  padding: '10px 14px',
                  background: 'transparent',
                  border: 'none', borderBottom: '1px solid rgba(0,0,0,0.04)',
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.02)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Severity dot */}
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', marginTop: 4, flexShrink: 0,
                  background: node.maxSeverity === 'high' ? '#ef4444' : '#f59e0b',
                }} />

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600, color: '#0a0a0a',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {node.label}
                  </div>
                  <div style={{
                    fontSize: 10, color: '#7a7a8a', marginTop: 2,
                    fontFamily: 'IBM Plex Mono, monospace',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {node.flags.map(f => f.label).join(' · ')}
                  </div>
                </div>

                {/* Flag count */}
                <span style={{
                  fontSize: 10, fontWeight: 600, flexShrink: 0,
                  padding: '2px 6px', borderRadius: 999,
                  background: node.maxSeverity === 'high' ? '#fef2f2' : '#fffbeb',
                  color: node.maxSeverity === 'high' ? '#ef4444' : '#d97706',
                  border: `1px solid ${node.maxSeverity === 'high' ? '#fecaca' : '#fde68a'}`,
                }}>
                  {node.flags.length}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FloatingTourButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: 'absolute', bottom: 20, right: 20,
        zIndex: 30,
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '9px 16px',
        background: '#ffffff',
        color: '#0a0a0a',
        border: '1px solid rgba(0,0,0,0.07)',
        borderRadius: 8,
        fontFamily: 'IBM Plex Sans, sans-serif',
        fontSize: 12, fontWeight: 600,
        cursor: 'pointer',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        transition: 'background 0.15s, transform 0.15s',
        letterSpacing: '-0.01em',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = '#fcfcfc'; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.background = '#ffffff'; e.currentTarget.style.transform = 'translateY(0)' }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <polygon points="1,1 9,5 1,9" fill="#1a6bff" />
      </svg>
      Take Tour
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function VisualMap({ auditData, repoUrl }) {
  const auditId  = auditData?.auditId
  const repoName = auditData?.repoName
    || repoUrl?.replace(/\/$/, '').split('/').slice(-2).join('/')
    || 'Repository'

  // Graph phase
  const [phase,     setPhase]     = useState('loading')
  const [errMsg,    setErrMsg]    = useState('')
  const [graphData, setGraphData] = useState({ nodes: [], links: [] })
  const [panel,     setPanel]     = useState(null)

  // Loading progress simulation
  const [loadStep, setLoadStep] = useState(0)
  const [loadPct,  setLoadPct]  = useState(0)

  const LOAD_STEPS = [
    'Scanning repository files...',
    'Parsing import statements...',
    'Resolving dependencies...',
    'Building dependency graph...',
  ]

  // AI metadata
  const [entryPointId,        setEntryPointId]        = useState(null)
  const [readingPath,         setReadingPath]          = useState(null)
  const [entryPointReasoning, setEntryPointReasoning]  = useState(null)
  const [cardSummaries,       setCardSummaries]        = useState(null)
  const [keyFileIds,          setKeyFileIds]           = useState(null) // null = loading

  // Welcome overlay
  const [showWelcome, setShowWelcome] = useState(false)

  // Tour state
  const [tourActive,  setTourActive]  = useState(false)
  const [tourLoading, setTourLoading] = useState(false)
  const [tourSteps,   setTourSteps]   = useState([])
  const [tourIdx,     setTourIdx]     = useState(0)

  const currentTourStep    = tourActive && tourSteps.length > 0 ? tourSteps[tourIdx] : null
  const currentTourRelates = currentTourStep?.relatesTo || []

  // ── Loading progress animation ─────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'loading') return
    setLoadStep(0)
    setLoadPct(0)
    const pctInterval = setInterval(() => {
      setLoadPct(p => p < 88 ? Math.min(p + (Math.random() * 4 + 1), 88) : p)
    }, 400)
    const stepInterval = setInterval(() => {
      setLoadStep(s => Math.min(s + 1, LOAD_STEPS.length - 1))
    }, 1800)
    return () => { clearInterval(pctInterval); clearInterval(stepInterval) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  useEffect(() => {
    if (phase === 'ready') setLoadPct(100)
  }, [phase])

  // ── Fetch graph data ───────────────────────────────────────────────────────
  useEffect(() => {
    const localFindingsByFile = {}
    for (const f of (auditData?.findings || [])) {
      const key = (f.file || 'unknown').replace(/^\//, '')
      ;(localFindingsByFile[key] = localFindingsByFile[key] || []).push(f)
    }

    const buildFromFindings = () => {
      const paths = Object.keys(localFindingsByFile)
      if (!paths.length) {
        setErrMsg('No file data available for this audit.')
        setPhase('error')
        return
      }
      const nodes = paths.map((id) => ({
        id,
        label:        id.split('/').pop(),
        group:        groupFromId(id),
        size:         localFindingsByFile[id].length,
        findings:     localFindingsByFile[id],
        findingCount: localFindingsByFile[id].length,
      }))
      setGraphData({ nodes, links: [], auditId })
      setPhase('ready')
      setShowWelcome(true)
    }

    if (!auditId) { buildFromFindings(); return }

    setPhase('loading')
    fetch(`/api/audit/${auditId}/graph`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || r.statusText))))
      .then(data => {
        const nodes = (data.nodes || []).map(n => {
          const fileFindings = localFindingsByFile[n.id] || []
          const riskFlags = [...(n.riskFlags || [])]
          if (fileFindings.length > 0) {
            const hasCritical = fileFindings.some(f => f.severity === 'critical' || f.severity === 'high')
            riskFlags.push({
              type: 'audit-findings',
              label: `${fileFindings.length} security ${fileFindings.length === 1 ? 'issue' : 'issues'}`,
              severity: hasCritical ? 'high' : 'medium',
            })
          }
          return {
            ...n,
            label:        n.label || n.id.split('/').pop(),
            group:        n.group || groupFromId(n.id),
            findings:     fileFindings,
            findingCount: fileFindings.length,
            riskFlags,
          }
        })
        const links = (data.edges || data.links || []).map(e => ({
          source: e.source,
          target: e.target,
          type: e.type || 'import',
        }))
        setGraphData({ nodes, links, auditId })
        setPhase('ready')
        setShowWelcome(true)
      })
      .catch(() => buildFromFindings())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditId])

  // ── Fetch AI metadata SEQUENTIALLY (Featherless concurrency limit = 1 for large models)
  useEffect(() => {
    if (phase !== 'ready' || !auditId) return

    const headers = { 'Content-Type': 'application/json' }
    const body = JSON.stringify({ auditId })

    ;(async () => {
      try {
        // 1. Key files first — needed for Welcome overlay "Take Tour" button
        try {
          const kfRes = await fetch('/api/audit/key-files', { method: 'POST', headers, body })
          const kf = kfRes.ok ? await kfRes.json() : null
          if (kf?.ids?.length) setKeyFileIds(kf.ids)
          else setKeyFileIds([])
        } catch { setKeyFileIds([]) }

        // 2. Entry point
        try {
          const epRes = await fetch('/api/audit/entry-point', { method: 'POST', headers, body })
          const ep = epRes.ok ? await epRes.json() : null
          if (ep) {
            setEntryPointId(ep.entryPoint || null)
            setReadingPath(ep.readingPath || null)
            setEntryPointReasoning(ep.reasoning || null)
          }
        } catch {}

        // 3. Card summaries last (least critical)
        try {
          const csRes = await fetch('/api/audit/card-summaries', { method: 'POST', headers, body })
          const cs = csRes.ok ? await csRes.json() : null
          if (cs) setCardSummaries(cs)
        } catch {}
      } catch {
        setKeyFileIds([])
      }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, auditId])

  // ── Tour actions ──────────────────────────────────────────────────────────
  const startTour = async () => {
    setShowWelcome(false)
    setTourLoading(true)
    try {
      const res = await fetch('/api/audit/tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId }),
      })
      const contentType = res.headers.get('content-type') || ''
      if (!res.ok || !contentType.includes('json')) {
        throw new Error(`Server error (${res.status})`)
      }
      const data = await res.json()
      console.log('[VisualMap] Tour response:', data.isFallback ? 'FALLBACK' : 'OK', `${(data.steps || []).length} steps`)
      setTourSteps(data.steps || [])
      setTourIdx(0)
      setTourActive(true)
    } catch (err) {
      console.error('[VisualMap] Tour fetch failed:', err)
    } finally {
      setTourLoading(false)
    }
  }

  const exitTour = () => {
    setTourActive(false)
    setTourSteps([])
    setTourIdx(0)
  }

  // ── Filter graph ───────────────────────────────────────────────────────────
  const filteredGraphData = useMemo(() => {
    if (!graphData) return graphData

    let visibleIds

    if (tourActive && tourSteps.length > 0) {
      // Tour mode: show ONLY the tour files + their relatesTo so the graph
      // perfectly mirrors the narrative — nothing extra clutters the view
      visibleIds = new Set()
      tourSteps.forEach(s => {
        if (s.target) visibleIds.add(s.target)
        ;(s.relatesTo || []).forEach(r => visibleIds.add(r))
      })
    } else if (keyFileIds && keyFileIds.length > 0) {
      // Free-explore mode: show AI-selected key files
      visibleIds = new Set(keyFileIds)
      if (entryPointId) visibleIds.add(entryPointId)
    } else {
      // Fallback: show everything (key-files not loaded yet)
      return graphData
    }

    // Fuzzy match: Kimi may return "server.ts" while node id is "backend/server.ts"
    const pathMatches = (nodeId, visId) =>
      nodeId === visId ||
      nodeId.endsWith('/' + visId) ||
      visId.endsWith('/' + nodeId)

    const filteredNodes = graphData.nodes.filter(n =>
      [...visibleIds].some(vid => pathMatches(n.id, vid))
    )
    const nodeIds = new Set(filteredNodes.map(n => n.id))
    const filteredLinks = (graphData.links || []).filter(
      l => nodeIds.has(l.source) && nodeIds.has(l.target)
    )
    return { ...graphData, nodes: filteredNodes, links: filteredLinks }
  }, [graphData, keyFileIds, entryPointId, tourActive, tourSteps])

  // ── Risky nodes for RiskFlagsPanel ─────────────────────────────────────────
  const riskyNodes = useMemo(() => {
    if (!filteredGraphData?.nodes) return []
    return filteredGraphData.nodes
      .filter(n => n.riskFlags && n.riskFlags.length > 0)
      .map(n => ({
        id: n.id,
        label: n.label || n.id.split('/').pop(),
        flags: n.riskFlags,
        maxSeverity: n.riskFlags.some(f => f.severity === 'high') ? 'high' : 'medium',
      }))
      .sort((a, b) => {
        if (a.maxSeverity === 'high' && b.maxSeverity !== 'high') return -1
        if (b.maxSeverity === 'high' && a.maxSeverity !== 'high') return 1
        return b.flags.length - a.flags.length
      })
  }, [filteredGraphData])

  const handleRiskNodeClick = useCallback((node) => {
    setPanel({ id: node.id, label: node.label })
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="vm-root" style={{ display: 'flex' }}>

      {/* Tour sidebar — slides in when tour is active */}
      {tourActive && tourSteps.length > 0 && (
        <TourSidebar
          steps={tourSteps}
          currentIdx={tourIdx}
          onStepClick={setTourIdx}
          onExit={exitTour}
          repoName={repoName}
        />
      )}

      {/* Main area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>

        {phase === 'ready' && (
          <GraphFlow
            graphData={filteredGraphData}
            onNodeClick={node => setPanel(node)}
            entryPointId={entryPointId}
            readingPath={readingPath}
            entryPointReasoning={entryPointReasoning}
            cardSummaries={cardSummaries}
            tourNodeId={currentTourStep?.target || null}
            tourRelatesTo={currentTourRelates}
            tourMode={tourActive}
          />
        )}

        {phase === 'loading' && (
          <LoadingOverlay loadPct={loadPct} loadStep={loadStep} LOAD_STEPS={LOAD_STEPS} />
        )}

        {phase === 'error' && (
          <ErrorOverlay errMsg={errMsg} />
        )}

        {phase === 'ready' && showWelcome && (
          <WelcomeOverlay
            repoName={repoName}
            onTour={startTour}
            onExplore={() => setShowWelcome(false)}
            keyFilesReady={keyFileIds !== null}
          />
        )}

        {tourLoading && <TourLoadingOverlay />}

        {currentTourStep && (
          <TourStepCard
            step={currentTourStep}
            stepIdx={tourIdx}
            totalSteps={tourSteps.length}
            onPrev={() => setTourIdx(i => Math.max(0, i - 1))}
            onNext={() => setTourIdx(i => Math.min(tourSteps.length - 1, i + 1))}
            onExit={exitTour}
          />
        )}

        {phase === 'ready' && !showWelcome && !tourActive && !tourLoading && (
          <RiskFlagsPanel riskyNodes={riskyNodes} onNodeClick={handleRiskNodeClick} />
        )}

        {phase === 'ready' && !showWelcome && !tourActive && !tourLoading && (
          <FloatingTourButton onClick={() => setShowWelcome(true)} />
        )}
      </div>

      {panel && (
        <FileModal
          node={panel}
          auditId={auditId}
          onClose={() => setPanel(null)}
        />
      )}

      {/* ChatPanel removed for now */}
    </div>
  )
}
