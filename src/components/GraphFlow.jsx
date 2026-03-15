import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  ConnectionLineType,
  Position,
  BackgroundVariant,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import CardNode from './CardNode';
import GroupNode from './GroupNode';
import { Search, X } from 'lucide-react';

const nodeTypes = {
  card: CardNode,
  groupNode: GroupNode,
};

// ─── Dagre layout ─────────────────────────────────────────────────────────────

function getLayoutedElements(nodes, edges, direction = 'TB') {
  const dagreGraph = new dagre.graphlib.Graph({ compound: true });
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 100, ranksep: 200 });

  const domains = new Set();
  nodes.forEach((node) => domains.add(node.data.domain || 'core'));

  domains.forEach((domain) => {
    dagreGraph.setNode(domain, { label: domain, clusterLabelPos: 'top' });
  });

  nodes.forEach((node) => {
    const domain = node.data.domain || 'core';
    dagreGraph.setNode(node.id, { width: 256, height: 150 });
    dagreGraph.setParent(node.id, domain);
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = [];

  domains.forEach((domain) => {
    const nodeWithPosition = dagreGraph.node(domain);
    if (nodeWithPosition) {
      const padding = 40;
      newNodes.push({
        id: domain,
        type: 'groupNode',
        position: {
          x: nodeWithPosition.x - nodeWithPosition.width / 2 - padding,
          y: nodeWithPosition.y - nodeWithPosition.height / 2 - padding,
        },
        style: {
          width: nodeWithPosition.width + padding * 2,
          height: nodeWithPosition.height + padding * 2,
          backgroundColor: 'rgba(26,107,255,0.03)',
          border: '1.5px dashed rgba(26,107,255,0.18)',
          borderRadius: '16px',
        },
        data: { label: domain.toUpperCase() },
      });
    }
  });

  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const domain = node.data.domain || 'core';
    const parentNode = dagreGraph.node(domain);
    const padding = 40;

    newNodes.push({
      ...node,
      parentId: domain,
      extent: 'parent',
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
      position: {
        x: nodeWithPosition.x - 256 / 2 - (parentNode.x - parentNode.width / 2) + padding,
        y: nodeWithPosition.y - 150 / 2 - (parentNode.y - parentNode.height / 2) + padding,
      },
    });
  });

  return { nodes: newNodes, edges };
}

// ─── Transitive impact BFS ────────────────────────────────────────────────────

/**
 * Compute the set of node IDs that transitively depend on `nodeId`.
 * Edge direction: source imports target — so "who depends on target" = reverse BFS.
 * @param {string} nodeId
 * @param {{ source: string, target: string }[]} links
 * @returns {string[]}
 */
function computeTransitiveImpact(nodeId, links) {
  const reverseAdj = {};
  links.forEach((l) => {
    if (!reverseAdj[l.target]) reverseAdj[l.target] = [];
    reverseAdj[l.target].push(l.source);
  });

  const visited = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const curr = queue.shift();
    for (const dep of (reverseAdj[curr] || [])) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...visited];
}

// ─── Tour zoomer — auto-pans to the current tour node ─────────────────────────

function TourZoomer({ tourNodeId, nodes }) {
  const { fitView } = useReactFlow();
  const prevTourNodeId = useRef(null);

  useEffect(() => {
    if (!tourNodeId) return;
    prevTourNodeId.current = tourNodeId;

    const match = nodes.find(
      (n) =>
        n.id === tourNodeId ||
        n.id.endsWith('/' + tourNodeId) ||
        tourNodeId.endsWith('/' + n.id)
    );

    if (match) {
      // Wait for layout to settle before zooming
      const t = setTimeout(() => {
        fitView({ nodes: [{ id: match.id }], duration: 800, padding: 0.5 });
      }, 200);
      return () => clearTimeout(t);
    }
  }, [tourNodeId, nodes, fitView]);

  return null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GraphFlow({
  graphData,
  onNodeClick,
  entryPointId,
  readingPath,
  entryPointReasoning,
  cardSummaries,
  tourNodeId,
  tourRelatesTo,   // string[] — files related to current tour step
  tourMode,        // boolean — hides query bar and banner during tour
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Impact highlight state
  const [impactHighlight, setImpactHighlight] = useState(null); // { nodeId, affectedNodes }

  // Query bar state
  const [queryText, setQueryText]       = useState('');
  const [queryResult, setQueryResult]   = useState(null); // { path, explanation }
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError]     = useState('');
  const [queryFocused, setQueryFocused] = useState(false);
  const queryInputRef = useRef(null);

  const [suggestedQueries, setSuggestedQueries] = useState([]);
  const [faqLoading, setFaqLoading] = useState(false);

  // Fetch project-specific FAQ questions
  useEffect(() => {
    const auditId = graphData?.auditId;
    if (!auditId) return;
    setFaqLoading(true);
    fetch('/api/audit/generate-faq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auditId }),
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setSuggestedQueries(data.questions || []))
      .catch(() => setSuggestedQueries(['What is the main entry point?', 'How is the project structured?']))
      .finally(() => setFaqLoading(false));
  }, [graphData?.auditId]);

  // Entry point banner dismiss
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Memoize raw links for impact computation
  const rawLinks = useMemo(
    () => graphData?.links || graphData?.edges || [],
    [graphData]
  );

  // Build impact data per node
  const impactData = useMemo(() => {
    if (!graphData?.nodes) return {};
    const result = {};
    graphData.nodes.forEach((node) => {
      const affected = computeTransitiveImpact(node.id, rawLinks);
      result[node.id] = { impactScore: affected.length, affectedNodes: affected };
    });
    return result;
  }, [graphData, rawLinks]);

  // ── Build layouted graph when data/summaries change ────────────────────────
  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0) return;

    const nodeIds = new Set(graphData.nodes.map((n) => n.id));
    const links   = graphData.links || graphData.edges || [];

    const initialNodes = graphData.nodes.map((node) => {
      const isEntry = node.id === entryPointId;
      const impact  = impactData[node.id] || { impactScore: 0, affectedNodes: [] };
      const summary = cardSummaries?.[node.id] || null;

      return {
        id: node.id,
        type: 'card',
        data: {
          ...node,
          domain:          node.group || 'core',
          isEntryPoint:    isEntry,
          impactScore:     impact.impactScore,
          affectedNodes:   impact.affectedNodes,
          intentSummary:   summary,
          isTourHighlight: false,
          onImpactClick:   (nid, affected) => {
            setImpactHighlight((prev) =>
              prev?.nodeId === nid ? null : { nodeId: nid, affectedNodes: affected }
            );
          },
        },
        position: { x: 0, y: 0 },
      };
    });

    // Build edges with type-based styling
    const edgeStyles = {
      import:    { stroke: 'rgba(0,0,0,0.15)', strokeWidth: 1.5, opacity: 0.7 },
      renders:   { stroke: '#16a34a', strokeWidth: 2, opacity: 0.7, strokeDasharray: '4 2' },
      calls_api: { stroke: '#f59e0b', strokeWidth: 2, opacity: 0.8, strokeDasharray: '6 3' },
    }
    const edgeColors = { import: 'rgba(0,0,0,0.2)', renders: '#16a34a', calls_api: '#f59e0b' }

    const baseEdges = links
      .filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target))
      .map((link, idx) => {
        const edgeType = link.type || 'import'
        const style = edgeStyles[edgeType] || edgeStyles.import
        const color = edgeColors[edgeType] || '#94a3b8'
        return {
          id: `e${idx}-${link.source}-${link.target}-${edgeType}`,
          source: link.source,
          target: link.target,
          type: 'smoothstep',
          animated: edgeType === 'calls_api',
          label: edgeType !== 'import' ? edgeType.replace('_', ' ') : undefined,
          labelStyle: { fontSize: 9, fill: color, fontWeight: 600 },
          labelBgStyle: { fill: '#f8fafc', fillOpacity: 0.9 },
          style,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color,
          },
        }
      });

    // Reading path edges (amber, animated, on top)
    const readingPathEdges = [];
    if (readingPath && readingPath.length > 1) {
      for (let i = 0; i < readingPath.length - 1; i++) {
        const src = readingPath[i];
        const tgt = readingPath[i + 1];
        if (nodeIds.has(src) && nodeIds.has(tgt)) {
          readingPathEdges.push({
            id: `rp-${i}-${src}-${tgt}`,
            source: src,
            target: tgt,
            type: 'smoothstep',
            animated: true,
            zIndex: 10,
            style: { stroke: '#f59e0b', strokeWidth: 3 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 18,
              height: 18,
              color: '#f59e0b',
            },
          });
        }
      }
    }

    const allEdges = [...baseEdges, ...readingPathEdges];

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      initialNodes,
      allEdges
    );

    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData, entryPointId, readingPath, cardSummaries, impactData]);

  // ── Apply impact / flow-query / tour highlights ────────────────────────────
  useEffect(() => {
    if (!nodes.length) return;

    const queryPathSet = queryResult ? new Set(queryResult.path) : null;

    setNodes((nds) =>
      nds.map((n) => {
        if (n.type !== 'card') return n;

        let opacity = 1;
        let borderOverride = null;

        if (impactHighlight) {
          const isAffected = impactHighlight.affectedNodes.includes(n.id) || n.id === impactHighlight.nodeId;
          opacity = isAffected ? 1 : 0.25;
          if (n.id === impactHighlight.nodeId) borderOverride = '#f97316';
          else if (isAffected) borderOverride = '#fb923c';
        } else if (queryPathSet) {
          const isInPath = queryPathSet.has(n.id);
          opacity = isInPath ? 1 : 0.25;
          if (isInPath) borderOverride = '#a855f7';
        } else if (tourNodeId) {
          const isTourTarget  = n.id === tourNodeId || n.id.endsWith('/' + tourNodeId) || tourNodeId.endsWith('/' + n.id);
          const isRelated     = (tourRelatesTo || []).some(r => n.id === r || n.id.endsWith('/' + r) || r.endsWith('/' + n.id));
          opacity = (isTourTarget || isRelated) ? 1 : 0.12;
          if (isTourTarget)  borderOverride = '#2952ff';
          else if (isRelated) borderOverride = '#f59e0b';
        }

        const isTourTarget = tourNodeId && (
          n.id === tourNodeId ||
          n.id.endsWith('/' + tourNodeId) ||
          tourNodeId.endsWith('/' + n.id)
        );

        return {
          ...n,
          data: {
            ...n.data,
            isTourHighlight: !!isTourTarget,
          },
          style: {
            ...n.style,
            opacity,
            ...(borderOverride ? { outline: `3px solid ${borderOverride}`, borderRadius: '12px' } : { outline: 'none' }),
          },
        };
      })
    );

    setEdges((eds) =>
      eds.map((e) => {
        if (impactHighlight) {
          const isAffected =
            impactHighlight.affectedNodes.includes(e.source) ||
            impactHighlight.affectedNodes.includes(e.target) ||
            e.source === impactHighlight.nodeId ||
            e.target === impactHighlight.nodeId;
          return {
            ...e,
            style: {
              ...e.style,
              opacity: isAffected ? 1 : 0.1,
              stroke: isAffected ? '#f97316' : '#94a3b8',
            },
            animated: isAffected,
          };
        }
        if (queryPathSet) {
          const isInPath = queryPathSet.has(e.source) && queryPathSet.has(e.target);
          return {
            ...e,
            style: {
              ...e.style,
              opacity: isInPath ? 1 : 0.1,
              stroke: isInPath ? '#a855f7' : '#94a3b8',
              strokeWidth: isInPath ? 3 : 1.5,
            },
            animated: isInPath,
          };
        }
        if (tourNodeId) {
          const matchesNode = id => id === tourNodeId || id.endsWith('/' + tourNodeId) || tourNodeId.endsWith('/' + id);
          const matchesRel  = id => (tourRelatesTo || []).some(r => id === r || id.endsWith('/' + r) || r.endsWith('/' + id));
          const isPrimary   = matchesNode(e.source) && matchesNode(e.target);
          const isBridge    = (matchesNode(e.source) && matchesRel(e.target)) || (matchesRel(e.source) && matchesNode(e.target));
          return {
            ...e,
            style: {
              ...e.style,
              opacity:     (isPrimary || isBridge) ? 1 : 0.06,
              stroke:      isPrimary ? '#2952ff' : isBridge ? '#f59e0b' : '#94a3b8',
              strokeWidth: (isPrimary || isBridge) ? 2.5 : 1.5,
            },
            animated: isPrimary || isBridge,
          };
        }
        // Reset
        const isReadingPath = e.id.startsWith('rp-');
        return {
          ...e,
          style: isReadingPath
            ? { stroke: '#f59e0b', strokeWidth: 3 }
            : { stroke: '#94a3b8', strokeWidth: 1.5, opacity: 0.6 },
          animated: isReadingPath,
        };
      })
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactHighlight, queryResult, tourNodeId, tourRelatesTo]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  // ── Flow query submit ──────────────────────────────────────────────────────
  const handleQuerySubmit = useCallback(async (e) => {
    e.preventDefault();
    const q = queryText.trim();
    if (!q || !graphData?.auditId) return;

    setQueryLoading(true);
    setQueryError('');
    setQueryResult(null);
    setImpactHighlight(null);

    try {
      const res = await fetch('/api/audit/flow-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId: graphData.auditId, query: q }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        setQueryError(err.error || 'Query failed');
        return;
      }
      const data = await res.json();
      setQueryResult(data);
    } catch (err) {
      setQueryError(err.message || 'Network error');
    } finally {
      setQueryLoading(false);
    }
  }, [queryText, graphData]);

  const clearQuery = useCallback(() => {
    setQueryText('');
    setQueryResult(null);
    setQueryError('');
    setImpactHighlight(null);
  }, []);

  // ── Early return for empty graph ───────────────────────────────────────────
  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#fcfcfc', color: '#7a7a8a' }}>
        <p style={{ fontSize: 14, fontFamily: 'Inter, sans-serif' }}>No graph data available.</p>
      </div>
    );
  }

  const showBanner = entryPointId && entryPointReasoning && !bannerDismissed && !tourMode;

  return (
    <div style={{ width: '100%', height: '100%', background: '#fcfcfc', position: 'relative' }}>

      {/* ── "Start here" banner ─────────────────────────────────────────── */}
      {showBanner && (
        <div style={{
          position: 'absolute',
          top: 60,
          left: 16,
          zIndex: 20,
          background: '#ffffff',
          border: '1px solid rgba(26,107,255,0.2)',
          borderRadius: 12,
          padding: '12px 16px',
          maxWidth: 320,
          boxShadow: '0 4px 20px rgba(26,107,255,0.12)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1a6bff', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Start here
              </div>
              <div style={{ fontSize: 12, color: '#4a4a5a', lineHeight: 1.6 }}>
                <strong style={{ fontFamily: 'SF Mono, Fira Code, monospace', color: '#0a0a0a' }}>{entryPointId?.split('/').pop()}</strong>
                <br />
                {entryPointReasoning}
              </div>
            </div>
            <button
              onClick={() => setBannerDismissed(true)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7a7a8a', padding: 0, flexShrink: 0 }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── Flow query bar (hidden during tour) ──────────────────────────── */}
      {!tourMode && <div style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        width: 'min(600px, calc(100% - 200px))',
      }}>
        <form onSubmit={handleQuerySubmit} style={{ display: 'flex', gap: 0, alignItems: 'center' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 999,
            padding: '0 16px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
            gap: 8,
          }}>
            <Search size={14} color="#7a7a8a" style={{ flexShrink: 0 }} />
            <input
              ref={queryInputRef}
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              onFocus={() => setQueryFocused(true)}
              onBlur={() => setTimeout(() => setQueryFocused(false), 150)}
              placeholder="Ask about the codebase..."
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: 13,
                color: '#0a0a0a',
                padding: '10px 0',
                fontFamily: 'Inter, -apple-system, sans-serif',
              }}
            />
            {(queryText || queryResult) && (
              <button
                type="button"
                onClick={clearQuery}
                aria-label="Clear search"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7a7a8a', padding: 0 }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={!queryText.trim() || queryLoading}
            style={{
              marginLeft: 8,
              padding: '8px 18px',
              background: queryLoading ? '#7a7a8a' : '#1a6bff',
              color: '#ffffff',
              border: 'none',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              cursor: queryLoading ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              fontFamily: 'Inter, -apple-system, sans-serif',
              transition: 'background 0.15s',
            }}
          >
            {queryLoading ? 'Searching...' : 'Search'}
          </button>
        </form>

        {/* Suggested queries */}
        {queryFocused && !queryText && !queryResult && (
          <div style={{
            marginTop: 6,
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          }}>
            <div style={{
              padding: '8px 12px 4px', fontSize: 10, fontWeight: 700,
              color: '#7a7a8a', textTransform: 'uppercase', letterSpacing: '0.08em',
              fontFamily: 'Inter, sans-serif',
            }}>
              Suggested
            </div>
            {faqLoading ? (
              <div style={{ padding: '12px 14px', fontSize: 12, color: '#7a7a8a', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Inter, sans-serif' }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(26,107,255,0.15)', borderTopColor: '#1a6bff', animation: 'spin 0.7s linear infinite' }} />
                Generating questions for this project...
              </div>
            ) : suggestedQueries.map((q) => (
              <button
                key={q}
                onMouseDown={() => {
                  setQueryText(q);
                  queryInputRef.current?.focus();
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 14px',
                  fontSize: 13,
                  color: '#4a4a5a',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  borderTop: '1px solid rgba(0,0,0,0.05)',
                  transition: 'background 0.1s',
                  fontFamily: 'Inter, -apple-system, sans-serif',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* Query result explanation */}
        {queryResult?.explanation && (
          <div style={{
            marginTop: 8,
            background: 'rgba(26,107,255,0.04)',
            border: '1px solid rgba(26,107,255,0.18)',
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12,
            color: '#1a6bff',
            lineHeight: 1.6,
            fontFamily: 'Inter, sans-serif',
          }}>
            <strong>Flow found ({queryResult.path?.length || 0} files):</strong>
            {' '}{queryResult.explanation}
          </div>
        )}
        {queryError && (
          <div style={{
            marginTop: 8,
            background: '#fff5f5',
            border: '1px solid rgba(217,48,37,0.2)',
            borderRadius: 10,
            padding: '8px 14px',
            fontSize: 12,
            color: '#d93025',
            fontFamily: 'Inter, sans-serif',
          }}>
            {queryError}
          </div>
        )}
      </div>}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.type === 'card' && onNodeClick) {
            onNodeClick(node.data);
          }
        }}
        onPaneClick={() => {
          setImpactHighlight(null);
        }}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        minZoom={0.05}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <TourZoomer tourNodeId={tourNodeId} nodes={nodes} />
        <Background color="#cbd5e1" gap={24} size={1.5} variant={BackgroundVariant.Dots} />
        <Controls
          style={{
            bottom: 16,
            left: 16,
          }}
        />
      </ReactFlow>
    </div>
  );
}
