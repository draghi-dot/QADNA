import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileCode, AlertTriangle } from 'lucide-react';

// Inject tour pulse keyframe once
if (typeof document !== 'undefined' && !document.getElementById('tour-pulse-style')) {
  const style = document.createElement('style');
  style.id = 'tour-pulse-style';
  style.textContent = `
    @keyframes tourPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(26,107,255,0.5), 0 1px 4px rgba(0,0,0,0.06); }
      50% { box-shadow: 0 0 0 8px rgba(26,107,255,0), 0 1px 4px rgba(0,0,0,0.06); }
    }
  `;
  document.head.appendChild(style);
}

export default memo(({ data, selected }) => {
  const impactScore     = data.impactScore || 0;
  const isTourHighlight = data.isTourHighlight || false;
  const riskFlags       = data.riskFlags || [];
  const hasHighRisk     = riskFlags.some(f => f.severity === 'high');
  const hasMediumRisk   = riskFlags.some(f => f.severity === 'medium');

  const impactColor =
    impactScore >= 10 ? 'text-red-600 border-red-200 bg-red-50' :
    impactScore >= 5  ? 'text-orange-600 border-orange-200 bg-orange-50' :
    impactScore >= 1  ? 'text-[#4a4a5a] border-black/[0.07] bg-[#fcfcfc]' :
                        'text-[#7a7a8a] border-black/[0.07] bg-[#fcfcfc]';

  const handleImpactClick = (e) => {
    e.stopPropagation();
    if (data.onImpactClick && impactScore > 0) {
      data.onImpactClick(data.id, data.affectedNodes || []);
    }
  };

  const baseBorder = isTourHighlight
    ? '2.5px solid #1a6bff'
    : data.isEntryPoint
      ? '2.5px solid #f59e0b'
      : selected
        ? '2px solid #1a6bff'
        : '1px solid rgba(0,0,0,0.07)';

  const hasRiskBorder = !isTourHighlight && !data.isEntryPoint && riskFlags.length > 0;
  const borderLeftStyle = hasRiskBorder
    ? `3px solid ${hasHighRisk ? '#ef4444' : '#f59e0b'}`
    : baseBorder;

  const shadowStyle = isTourHighlight
    ? undefined
    : data.isEntryPoint
      ? '0 0 16px rgba(245,158,11,0.24)'
      : selected
        ? '0 0 0 3px rgba(26,107,255,0.1)'
        : '0 1px 4px rgba(0,0,0,0.05), 0 2px 8px rgba(0,0,0,0.04)';

  return (
    <div
      className="relative rounded-xl w-56 cursor-pointer select-none transition-all duration-150"
      style={{
        background: '#ffffff',
        borderTop: baseBorder,
        borderRight: baseBorder,
        borderBottom: baseBorder,
        borderLeft: borderLeftStyle,
        boxShadow: shadowStyle,
        animation: isTourHighlight ? 'tourPulse 1.5s ease-in-out infinite' : 'none',
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ width: 8, height: 8, background: '#1a6bff', border: '2px solid #fff' }}
      />

      <div className="p-3 flex flex-col gap-1.5">
        {/* Filename + icon */}
        <div className="flex items-center gap-2 overflow-hidden">
          <FileCode className="w-4 h-4 shrink-0" style={{ color: '#1a6bff' }} />
          <span
            className="font-semibold truncate text-sm leading-tight"
            style={{ color: '#0a0a0a' }}
            title={data.label}
          >
            {data.label}
          </span>
        </div>

        {/* File path */}
        <span
          className="text-xs truncate leading-tight"
          style={{ color: '#7a7a8a', fontFamily: 'SF Mono, Fira Code, monospace' }}
          title={data.id}
        >
          {data.id}
        </span>

        {/* Intent summary */}
        {data.intentSummary && (
          <p className="text-xs italic leading-snug mt-0.5" style={{ color: '#4a4a5a' }}>
            {data.intentSummary}
          </p>
        )}

        {/* Tags + impact row */}
        <div className="flex items-center justify-between gap-1 mt-1 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            <span
              className="px-1.5 py-0.5 text-xs rounded-full border"
              style={{
                background: 'rgba(0,0,0,0.04)',
                color: '#7a7a8a',
                borderColor: 'rgba(0,0,0,0.07)',
              }}
            >
              {data.domain || data.group || 'file'}
            </span>
            {data.isEntryPoint && (
              <span className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-xs rounded-full border border-amber-200 font-medium">
                entry
              </span>
            )}
            {isTourHighlight && (
              <span
                className="px-1.5 py-0.5 text-xs rounded-full border font-medium"
                style={{
                  background: 'rgba(26,107,255,0.07)',
                  color: '#1a6bff',
                  borderColor: 'rgba(26,107,255,0.18)',
                }}
              >
                on tour
              </span>
            )}
            {data.findingCount > 0 && (
              <span className="px-1.5 py-0.5 bg-red-50 text-red-500 text-xs rounded-full border border-red-200 font-medium">
                {data.findingCount} {data.findingCount === 1 ? 'issue' : 'issues'}
              </span>
            )}
            {riskFlags.length > 0 && (
              <span
                className={`px-1.5 py-0.5 text-xs rounded-full border font-medium ${
                  hasHighRisk ? 'bg-red-50 text-red-600 border-red-200' : 'bg-amber-50 text-amber-600 border-amber-200'
                }`}
                title={riskFlags.map(f => f.label).join(', ')}
              >
                {riskFlags.length} risk{riskFlags.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Impact badge */}
          {impactScore > 0 && (
            <button
              onClick={handleImpactClick}
              title={`${impactScore} file${impactScore !== 1 ? 's' : ''} depend on this — click to highlight`}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-semibold border shrink-0 hover:opacity-75 transition-opacity ${impactColor}`}
            >
              {impactScore >= 10 && <AlertTriangle className="w-3 h-3" />}
              {impactScore} deps
            </button>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ width: 8, height: 8, background: '#1a6bff', border: '2px solid #fff' }}
      />
    </div>
  );
});
