import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { FileCode, AlertTriangle, ChevronDown, ChevronUp, ArrowRight, ArrowLeft } from 'lucide-react';

export default memo(({ data, selected }) => {
  const [expanded, setExpanded] = useState(false);

  const getRiskColor = (complexity) => {
    if (complexity >= 8) return 'text-red-400 border-red-400/30 bg-red-400/10';
    if (complexity >= 5) return 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10';
    return 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10';
  };

  const riskColor = getRiskColor(data.complexity || 0);

  return (
    <div
      className={`relative bg-zinc-900 border-2 rounded-xl shadow-xl transition-all duration-200 ${
        selected ? 'border-blue-500 shadow-blue-500/20' : 'border-zinc-700 hover:border-zinc-500'
      } ${expanded ? 'w-96 z-50' : 'w-64 z-10'}`}
      style={{ zIndex: expanded ? 50 : (selected ? 40 : 10) }}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-blue-500 border-2 border-zinc-900" />

      <div
        className="p-4 cursor-pointer flex flex-col gap-3"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 overflow-hidden">
            <FileCode className="w-5 h-5 text-blue-400 shrink-0" />
            <div className="flex flex-col overflow-hidden">
              <span className="font-semibold text-zinc-100 truncate" title={data.label}>
                {data.label}
              </span>
              <span className="text-xs text-zinc-400 truncate" title={data.id}>
                {data.id}
              </span>
            </div>
          </div>
          <div className={`shrink-0 px-2 py-1 rounded-md text-xs font-bold border ${riskColor}`}>
            C: {data.complexity || 0}/10
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          <span className="px-2 py-0.5 bg-zinc-800 text-zinc-300 text-xs rounded-full border border-zinc-700">
            {data.domain || data.group || 'core'}
          </span>
          <span className="px-2 py-0.5 bg-zinc-800 text-zinc-300 text-xs rounded-full border border-zinc-700">
            {data.type || data.group || 'file'}
          </span>
        </div>

        {data.riskFlags && data.riskFlags.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-yellow-400">
            <AlertTriangle className="w-3 h-3" />
            <span>{data.riskFlags.length} risk flags</span>
          </div>
        )}

        <div className="flex items-center justify-center mt-1 text-zinc-500">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {expanded && (
        <div className="p-4 pt-0 border-t border-zinc-800 flex flex-col gap-4 bg-zinc-900/95 rounded-b-xl">
          {data.summary && (
            <div className="mt-4 text-sm text-zinc-300 leading-relaxed">
              {data.summary}
            </div>
          )}

          {data.riskFlags && data.riskFlags.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Risk Flags</span>
              <div className="flex flex-col gap-1">
                {data.riskFlags.map((flag, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-sm text-yellow-400 bg-yellow-400/10 p-2 rounded-lg border border-yellow-400/20">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{flag}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.exports && data.exports.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                <ArrowRight className="w-3 h-3" /> Exports
              </span>
              <div className="flex flex-wrap gap-1">
                {data.exports.map((exp, idx) => (
                  <span key={idx} className="px-2 py-1 bg-blue-500/10 text-blue-400 text-xs rounded-md border border-blue-500/20 font-mono">
                    {exp}
                  </span>
                ))}
              </div>
            </div>
          )}

          {data.imports && data.imports.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                <ArrowLeft className="w-3 h-3" /> Imports
              </span>
              <div className="flex flex-wrap gap-1">
                {data.imports.slice(0, 10).map((imp, idx) => (
                  <span key={idx} className="px-2 py-1 bg-emerald-500/10 text-emerald-400 text-xs rounded-md border border-emerald-500/20 font-mono truncate max-w-full">
                    {imp}
                  </span>
                ))}
                {data.imports.length > 10 && (
                  <span className="px-2 py-1 bg-zinc-800 text-zinc-400 text-xs rounded-md border border-zinc-700">
                    +{data.imports.length - 10} more
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-blue-500 border-2 border-zinc-900" />
    </div>
  );
});
