import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  useExploreGraph,
  useFindGraphConnection,
  useGetGraphOverview,
  type GraphEdge,
  type GraphNode,
  type GraphNodeType,
  type GraphResult,
} from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { GraphCanvas } from '@/components/knowledge/graph-canvas';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { HiddenFromAi, PageProblem } from '@/components/knowledge/parts';
import { useItemOptions } from '@/components/knowledge/relationships';
import { NODE_LABELS, NODE_PLURALS, NODE_TYPES, capitalise, edgeKey, nodePath, otherEnd, phraseFrom, sentence } from '@/lib/graph';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';

type View = 'map' | 'list';

/** The knowledge graph: the whole picture, or one item and what is around it (?item=person:3&depth=2). */
export default function MapPage() {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const item = params.get('item');
  const depth = params.get('depth') === '2' ? 2 : 1;
  const phone = useMedia(PHONE_QUERY);
  const [view, setView] = useState<View>('map');
  const [hiddenTypes, setHiddenTypes] = useState<Set<GraphNodeType>>(new Set());
  const [statedOnly, setStatedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(item);
  const [path, setPath] = useState<{ nodes: Set<string>; edges: Set<string> } | null>(null);
  const items = useItemOptions();

  useEffect(() => {
    setSelected(item);
    setPath(null);
  }, [item, depth]);

  const go = (next: { item?: string | null; depth?: number }) => {
    const p = new URLSearchParams();
    const it = next.item === undefined ? item : next.item;
    const d = next.depth ?? depth;
    if (it) p.set('item', it);
    if (it && d === 2) p.set('depth', '2');
    navigate('/knowledge/map' + (p.toString() ? '?' + p.toString() : ''));
  };

  const overview = useGetGraphOverview({ query: { enabled: !item } as never });
  const explore = useExploreGraph({ ref: item ?? '', depth }, { query: { enabled: !!item, retry: false } as never });
  const q = item ? explore : overview;
  const data = q.data as GraphResult | undefined;

  const shown = useMemo(() => {
    if (!data) return null;
    const keepNode = (n: GraphNode) => n.ref === item || !hiddenTypes.has(n.type);
    let nodes = data.nodes.filter(keepNode);
    const refs = new Set(nodes.map((n) => n.ref));
    let edges = data.edges.filter((e) => refs.has(e.from) && refs.has(e.to) && (!statedOnly || e.stated));
    if (statedOnly) {
      const used = new Set(edges.flatMap((e) => [e.from, e.to]));
      nodes = nodes.filter((n) => n.ref === item || used.has(n.ref));
      edges = edges.filter((e) => used.has(e.from) && used.has(e.to));
    }
    return { nodes, edges, names: new Map(data.nodes.map((n) => [n.ref, n])) };
  }, [data, hiddenTypes, statedOnly, item]);

  const present = useMemo(() => new Set((data?.nodes ?? []).map((n) => n.type)), [data]);
  const centreNode = item && data ? data.nodes.find((n) => n.ref === item) ?? null : null;
  const selectedNode = selected && shown ? shown.names.get(selected) ?? null : null;
  const listView = phone || view === 'list';

  const toggleType = (t: GraphNodeType) =>
    setHiddenTypes((s) => {
      const next = new Set(s);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  return (
    <KnowledgeLayout testId="page-map">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <p className="oo-eyebrow">Knowledge</p>
        <h1 className="oo-h1">Map</h1>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '68ch' }}>
          How your people, organisations, projects and goals connect. Choose anything to see what is around it. Claude can explore the same map, apart from anything hidden from AI.
        </p>
      </div>

      <div className="oo-map-controls">
        <Dropdown
          variant="control"
          ariaLabel="Centre the map on"
          value={item ?? ''}
          onChange={(v) => go({ item: v || null })}
          placeholder={items.loading ? 'Loading…' : 'Whole map'}
          searchPlaceholder="Search people, organisations and projects"
          options={[{ value: '', label: 'Whole map' }, ...items.options, ...(item && !items.options.some((o) => o.value === item) && centreNode ? [{ value: item, label: centreNode.name }] : [])]}
          testId="select-map-centre"
          style={{ minWidth: 240 }}
        />
        {item && (
          <span role="group" aria-label="How far out" className="oo-seg" style={{ display: 'inline-flex' }}>
            <button type="button" aria-pressed={depth === 1} onClick={() => go({ depth: 1 })} data-testid="button-depth-1">One step</button>
            <button type="button" aria-pressed={depth === 2} onClick={() => go({ depth: 2 })} data-testid="button-depth-2">Two steps</button>
          </span>
        )}
        {!phone && (
          <span role="group" aria-label="Show as" className="oo-seg" style={{ display: 'inline-flex' }}>
            <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')} data-testid="button-view-map">Map</button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')} data-testid="button-view-list">List</button>
          </span>
        )}
        <button type="button" className="oo-chip-toggle" aria-pressed={statedOnly} onClick={() => setStatedOnly((s) => !s)} data-testid="button-stated-only">
          Only relationships you stated
        </button>
      </div>

      {present.size > 1 && (
        <div className="oo-map-legend" role="group" aria-label="Show or hide kinds of item">
          {NODE_TYPES.filter((t) => present.has(t)).map((t) => (
            <button key={t} type="button" className="oo-chip-toggle" data-type={t} aria-pressed={!hiddenTypes.has(t)} onClick={() => toggleType(t)} data-testid={'button-type-' + t}>
              <span className="oo-gdot" data-type={t} aria-hidden="true" />
              {NODE_PLURALS[t]}
            </button>
          ))}
        </div>
      )}

      {q.isLoading ? (
        <Skel h={phone ? 240 : 520} />
      ) : q.error ? (
        <PageProblem notFound={(q.error as { status?: number }).status === 404} what="map" onRetry={() => q.refetch()} back={{ href: '/knowledge/map', label: 'Back to the whole map' }} />
      ) : !shown || shown.nodes.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-map-empty">
          {statedOnly ? 'No stated relationships here yet. Add them on a person, organisation or project page.' : 'Nothing on the map yet. Add people, organisations and projects, and they appear here.'}
        </p>
      ) : (
        <>
          {data?.truncated && (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-map-truncated">
              {item ? 'Showing the closest items only.' : 'Showing the most connected items only.'} Choose something to see everything around it.
            </p>
          )}
          <div className="oo-map-body">
            {listView ? (
              <GraphList nodes={shown.nodes} edges={shown.edges} centre={item} onCentre={(ref) => go({ item: ref })} />
            ) : (
              <GraphCanvas
                nodes={shown.nodes}
                edges={shown.edges}
                centre={item}
                selected={selected}
                highlight={path}
                onSelect={(ref) => {
                  setSelected(ref);
                  setPath(null);
                }}
                label={centreNode ? `Map around ${centreNode.name}` : 'Map of your knowledge'}
              />
            )}
            {!listView && selectedNode && (
              <NodePanel
                node={selectedNode}
                edges={shown.edges}
                names={shown.names}
                isCentre={selectedNode.ref === item}
                onCentre={() => go({ item: selectedNode.ref })}
                onPath={setPath}
              />
            )}
          </div>
        </>
      )}
    </KnowledgeLayout>
  );
}

/* ---------- The selected point ---------- */

function NodePanel({
  node,
  edges,
  names,
  isCentre,
  onCentre,
  onPath,
}: {
  node: GraphNode;
  edges: GraphEdge[];
  names: Map<string, GraphNode>;
  isCentre: boolean;
  onCentre: () => void;
  onPath: (p: { nodes: Set<string>; edges: Set<string> } | null) => void;
}) {
  const href = nodePath(node);
  const mine = edges.filter((e) => e.from === node.ref || e.to === node.ref);
  const canConnect = node.type === 'person' || node.type === 'organisation' || node.type === 'project';
  return (
    <aside className="oo-map-panel" aria-label={node.name} data-testid="panel-map-node">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="oo-hit-type">
          {NODE_LABELS[node.type]}
          {node.hidden && <HiddenFromAi confidential={false} />}
        </span>
        <h2 className="oo-h2" style={{ overflowWrap: 'anywhere' }} data-testid="text-map-node-name">{node.name}</h2>
        {node.detail && <span className="oo-muted" style={{ fontSize: 13 }}>{node.detail}</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {href && <Link href={href} className="oo-btn oo-btn-outline oo-btn-sm" data-testid="link-map-open">Open</Link>}
        {!isCentre && <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={onCentre} data-testid="button-map-centre">Centre here</button>}
      </div>
      {node.hidden && <p className="oo-muted" style={{ margin: 0, fontSize: 12 }}>Hidden from AI. Claude cannot see it or anything reached only through it.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="oo-side-label" style={{ padding: 0 }}>Connections shown ({mine.length})</span>
        <ul className="oo-map-links">
          {mine.slice(0, 40).map((e) => (
            <li key={edgeKey(e)} data-stated={e.stated || undefined}>
              {capitalise(phraseFrom(e, node.ref))} <strong>{names.get(otherEnd(e, node.ref))?.name ?? 'something'}</strong>
              {e.note && <span className="oo-muted"> · {e.note}</span>}
            </li>
          ))}
          {mine.length > 40 && <li className="oo-muted">and {mine.length - 40} more</li>}
        </ul>
      </div>
      {canConnect && <ConnectionFinder node={node} onPath={onPath} />}
    </aside>
  );
}

function ConnectionFinder({ node, onPath }: { node: GraphNode; onPath: (p: { nodes: Set<string>; edges: Set<string> } | null) => void }) {
  const [to, setTo] = useState('');
  const items = useItemOptions(true, node.ref);
  const r = useFindGraphConnection({ from: node.ref, to }, { query: { enabled: !!to, retry: false } as never });
  useEffect(() => {
    setTo('');
    onPath(null);
  }, [node.ref]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const first = r.data?.paths[0];
    onPath(first ? { nodes: new Set(r.data!.paths.flatMap((p) => p.nodes.map((n) => n.ref))), edges: new Set(r.data!.paths.flatMap((p) => p.edges.map(edgeKey))) } : null);
  }, [r.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="section-connection">
      <span className="oo-side-label" style={{ padding: 0 }}>How is {node.name} connected to…</span>
      <Dropdown
        variant="control"
        ariaLabel={`How is ${node.name} connected to`}
        value={to}
        onChange={setTo}
        placeholder="Choose someone or something"
        searchPlaceholder="Search people, organisations and projects"
        options={items.options}
        testId="select-connection-to"
      />
      {to && (r.isLoading ? (
        <Skel h={40} />
      ) : r.error ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Could not work that out. Try again.</p>
      ) : r.data && !r.data.paths.length ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-no-connection">No connection within three steps.</p>
      ) : r.data ? (
        <ol className="oo-map-paths" data-testid="list-connection-paths">
          {r.data.paths.map((p, i) => {
            const names = new Map(p.nodes.map((n) => [n.ref, n]));
            return (
              <li key={i}>
                {p.edges.map((e) => <span key={edgeKey(e)}>{sentence(e, names)}.</span>)}
              </li>
            );
          })}
        </ol>
      ) : null)}
    </div>
  );
}

/* ---------- As a list (phones, and anyone who prefers it) ---------- */

function GraphList({ nodes, edges, centre, onCentre }: { nodes: GraphNode[]; edges: GraphEdge[]; centre: string | null; onCentre: (ref: string) => void }) {
  const names = useMemo(() => new Map(nodes.map((n) => [n.ref, n])), [nodes]);
  if (centre && names.has(centre)) {
    const groups = new Map<string, GraphNode[]>();
    for (const e of edges) {
      if (e.from !== centre && e.to !== centre) continue;
      const other = names.get(otherEnd(e, centre));
      if (!other) continue;
      const head = capitalise(phraseFrom(e, centre));
      const list = groups.get(head) ?? [];
      if (!list.some((n) => n.ref === other.ref)) list.push(other);
      groups.set(head, list);
    }
    const further = nodes.filter((n) => n.ref !== centre && ![...groups.values()].some((l) => l.includes(n)));
    return (
      <div className="oo-map-list" data-testid="graph-list">
        <h2 className="oo-h2">{names.get(centre)!.name}</h2>
        {[...groups.entries()].map(([head, list]) => (
          <section key={head} aria-label={head}>
            <span className="oo-side-label" style={{ padding: 0 }}>{head}</span>
            <ul>{list.map((n) => <ListItem key={n.ref} node={n} onCentre={onCentre} />)}</ul>
          </section>
        ))}
        {further.length > 0 && (
          <section aria-label="One step further">
            <span className="oo-side-label" style={{ padding: 0 }}>One step further</span>
            <ul>{further.slice(0, 60).map((n) => <ListItem key={n.ref} node={n} onCentre={onCentre} />)}</ul>
          </section>
        )}
        {groups.size === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Nothing connected yet.</p>}
      </div>
    );
  }
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const top = [...nodes].sort((a, b) => (degree.get(b.ref) ?? 0) - (degree.get(a.ref) ?? 0)).slice(0, 40);
  return (
    <div className="oo-map-list" data-testid="graph-list">
      <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>The most connected. Choose one to see what is around it.</p>
      <ul>
        {top.map((n) => (
          <ListItem key={n.ref} node={n} onCentre={onCentre} count={degree.get(n.ref) ?? 0} />
        ))}
      </ul>
    </div>
  );
}

function ListItem({ node, onCentre, count }: { node: GraphNode; onCentre: (ref: string) => void; count?: number }) {
  const href = nodePath(node);
  return (
    <li>
      <span className="oo-gdot" data-type={node.type} aria-hidden="true" />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style={{ overflowWrap: 'anywhere' }}>
          {node.name}
          {node.hidden && <HiddenFromAi confidential={false} />}
        </span>
        <span className="oo-muted" style={{ fontSize: 12 }}>
          {[NODE_LABELS[node.type], node.detail, count !== undefined ? `${count} ${count === 1 ? 'connection' : 'connections'}` : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span style={{ display: 'inline-flex', gap: 10, flexShrink: 0 }}>
        {(node.type === 'person' || node.type === 'organisation' || node.type === 'project' || node.type === 'goal') && (
          <button type="button" className="oo-textbtn" style={{ fontSize: 13 }} onClick={() => onCentre(node.ref)} data-testid={'button-list-centre-' + node.ref.replace(':', '-')}>Centre</button>
        )}
        {href && <Link href={href} className="oo-textbtn" style={{ fontSize: 13 }}>Open</Link>}
      </span>
    </li>
  );
}
