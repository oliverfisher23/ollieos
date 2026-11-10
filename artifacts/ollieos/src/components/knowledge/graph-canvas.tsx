import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { GraphEdge, GraphNode } from '@workspace/api-client-react';
import { NODE_LABELS, edgeKey, nodeRadius } from '@/lib/graph';

interface SimNode extends SimulationNodeDatum {
  ref: string;
  r: number;
}

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  r: number;
}

const HUBS = new Set(['person', 'organisation', 'project', 'goal']);

/** Lays the points out once with a force simulation, so the picture is still and the same each time. */
function useLayout(nodes: GraphNode[], edges: GraphEdge[], centre: string | null) {
  return useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const sim: SimNode[] = nodes.map((n) => ({ ref: n.ref, r: nodeRadius(n, degree.get(n.ref) ?? 0), ...(n.ref === centre ? { fx: 0, fy: 0 } : {}) }));
    const byRef = new Map(sim.map((s) => [s.ref, s]));
    const links: SimulationLinkDatum<SimNode>[] = edges.filter((e) => byRef.has(e.from) && byRef.has(e.to)).map((e) => ({ source: e.from, target: e.to }));
    const big = nodes.length > 120;
    const s = forceSimulation(sim)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.ref).distance(big ? 46 : 70).strength(0.5))
      .force('charge', forceManyBody().strength(big ? -70 : -180))
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 6))
      .force('x', forceX(0).strength(0.05))
      .force('y', forceY(0).strength(0.05))
      .stop();
    for (let i = 0; i < 320; i++) s.tick();
    const placed = new Map<string, Placed>();
    for (const n of nodes) {
      const p = byRef.get(n.ref)!;
      placed.set(n.ref, { node: n, x: p.x ?? 0, y: p.y ?? 0, r: p.r });
    }
    const xs = [...placed.values()].map((p) => p.x);
    const ys = [...placed.values()].map((p) => p.y);
    const pad = 90;
    const box = xs.length
      ? { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 }
      : { x: -200, y: -150, w: 400, h: 300 };
    return { placed, degree, box };
  }, [nodes, edges, centre]);
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  centre: string | null;
  selected: string | null;
  /** Points and links to pick out, such as a path between two points */
  highlight: { nodes: Set<string>; edges: Set<string> } | null;
  onSelect: (ref: string | null) => void;
  label: string;
}

export function GraphCanvas({ nodes, edges, centre, selected, highlight, onSelect, label }: GraphCanvasProps) {
  const { placed, degree, box } = useLayout(nodes, edges, centre);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  // A new picture starts fitted.
  useEffect(() => setView({ k: 1, x: 0, y: 0 }), [box]);

  // Wheel zooms the map rather than scrolling the page (React's wheel handler cannot prevent that).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => ({ ...v, k: Math.min(4, Math.max(0.35, v.k * Math.exp(-e.deltaY * 0.0015))) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const neighbours = useMemo(() => {
    const focus = hover ?? selected;
    if (!focus) return null;
    const set = new Set<string>([focus]);
    const es = new Set<string>();
    for (const e of edges) {
      if (e.from === focus || e.to === focus) {
        set.add(e.from);
        set.add(e.to);
        es.add(edgeKey(e));
      }
    }
    return { nodes: set, edges: es };
  }, [hover, selected, edges]);
  const lit = highlight ?? neighbours;

  const scale = () => {
    const el = svgRef.current;
    return el ? box.w / Math.max(1, el.clientWidth) : 1;
  };
  const down = (e: PointerEvent<SVGRectElement>) => {
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<SVGRectElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const f = scale();
    const dx = (e.clientX - d.sx) * f;
    const dy = (e.clientY - d.sy) * f;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const up = (e: PointerEvent<SVGRectElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const key = (ref: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(ref);
    }
  };
  const zoom = (f: number) => setView((v) => ({ ...v, k: Math.min(4, Math.max(0.35, v.k * f)) }));

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const transform = `translate(${cx + view.x} ${cy + view.y}) scale(${view.k}) translate(${-cx} ${-cy})`;
  const showLabel = (n: GraphNode) =>
    n.ref === centre ||
    n.ref === selected ||
    n.ref === hover ||
    (lit ? lit.nodes.has(n.ref) : false) ||
    view.k >= 1.6 ||
    (HUBS.has(n.type) && (nodes.length <= 70 || (degree.get(n.ref) ?? 0) >= 3));

  return (
    <div className="oo-graph" data-testid="graph-canvas">
      <svg
        ref={svgRef}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={label}
      >
        <rect x={box.x - box.w} y={box.y - box.h} width={box.w * 3} height={box.h * 3} className="oo-graph-bg" onPointerDown={down} onPointerMove={move} onPointerUp={up} />
        <g transform={transform}>
          <g aria-hidden="true">
            {edges.map((e) => {
              const a = placed.get(e.from);
              const b = placed.get(e.to);
              if (!a || !b) return null;
              const k = edgeKey(e);
              const on = lit?.edges.has(k);
              return (
                <line
                  key={k}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="oo-gedge"
                  data-stated={e.stated || undefined}
                  data-lit={on || undefined}
                  data-dim={(lit && !on) || undefined}
                />
              );
            })}
          </g>
          {[...placed.values()].map(({ node: n, x, y, r }) => {
            const dim = lit && !lit.nodes.has(n.ref);
            return (
              <g
                key={n.ref}
                className="oo-gnode"
                data-type={n.type}
                data-hidden={n.hidden || undefined}
                data-dim={dim || undefined}
                data-selected={n.ref === selected || undefined}
                data-centre={n.ref === centre || undefined}
                transform={`translate(${x} ${y})`}
                tabIndex={0}
                role="button"
                aria-label={`${n.name}, ${NODE_LABELS[n.type]}${n.hidden ? ', hidden from AI' : ''}`}
                aria-pressed={n.ref === selected}
                onClick={() => onSelect(n.ref)}
                onKeyDown={key(n.ref)}
                onPointerEnter={() => setHover(n.ref)}
                onPointerLeave={() => setHover((h) => (h === n.ref ? null : h))}
                onFocus={() => setHover(n.ref)}
                onBlur={() => setHover((h) => (h === n.ref ? null : h))}
                data-testid={'graph-node-' + n.ref.replace(':', '-')}
              >
                <circle r={r} />
                {showLabel(n) && (
                  <text y={r + 13} textAnchor="middle" className="oo-glabel">
                    {n.name.length > 34 ? n.name.slice(0, 33) + '…' : n.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="oo-graph-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoom(1.3)} aria-label="Zoom in" data-testid="button-zoom-in">+</button>
        <button type="button" onClick={() => zoom(1 / 1.3)} aria-label="Zoom out" data-testid="button-zoom-out">−</button>
        <button type="button" onClick={() => setView({ k: 1, x: 0, y: 0 })} data-testid="button-zoom-fit">Fit</button>
      </div>
    </div>
  );
}
