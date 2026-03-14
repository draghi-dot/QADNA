import { useCallback, useEffect } from 'react';
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import CardNode from './CardNode';
import GroupNode from './GroupNode';

const nodeTypes = {
  card: CardNode,
  groupNode: GroupNode,
};

function getLayoutedElements(nodes, edges, direction = 'TB') {
  const dagreGraph = new dagre.graphlib.Graph({ compound: true });
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction, nodesep: 100, ranksep: 200 });

  // Group nodes by domain (file extension group)
  const domains = new Set();
  nodes.forEach((node) => {
    domains.add(node.data.domain || 'core');
  });

  // Add domain group nodes to dagre
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

  // Add group nodes
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
          backgroundColor: 'rgba(39, 39, 42, 0.2)',
          border: '2px dashed rgba(63, 63, 70, 0.5)',
          borderRadius: '16px',
        },
        data: { label: domain.toUpperCase() },
      });
    }
  });

  // Add child nodes
  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const domain = node.data.domain || 'core';
    const parentNode = dagreGraph.node(domain);
    const padding = 40;

    newNodes.push({
      ...node,
      parentId: domain,
      extent: 'parent',
      targetPosition: isHorizontal ? Position.Left : Position.Top,
      sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      position: {
        x: nodeWithPosition.x - 256 / 2 - (parentNode.x - parentNode.width / 2) + padding,
        y: nodeWithPosition.y - 150 / 2 - (parentNode.y - parentNode.height / 2) + padding,
      },
    });
  });

  return { nodes: newNodes, edges };
}

export default function GraphFlow({ graphData, onNodeClick }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => {
    if (!graphData || graphData.nodes.length === 0) return;

    const initialNodes = graphData.nodes.map((node) => ({
      id: node.id,
      type: 'card',
      data: {
        ...node,
        domain: node.group || 'core',
      },
      position: { x: 0, y: 0 },
    }));

    const initialEdges = (graphData.links || graphData.edges || []).map((link, idx) => ({
      id: `e${idx}-${link.source}-${link.target}`,
      source: link.source,
      target: link.target,
      type: 'smoothstep',
      animated: true,
      style: { stroke: '#3b82f6', strokeWidth: 2, opacity: 0.5 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 20,
        height: 20,
        color: '#3b82f6',
      },
    }));

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      initialNodes,
      initialEdges
    );

    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [graphData, setNodes, setEdges]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: '#09090b', color: '#71717a' }}>
        <p>No graph data available.</p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: '#09090b' }}>
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
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        minZoom={0.05}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={24} size={2} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
