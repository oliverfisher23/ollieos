import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { suggestProjectFunctions, useListKnowledgeInbox, useListProjects, useSearchKnowledge, type ProjectListItem, type SearchHit } from '@workspace/api-client-react';
import { BUSINESS_FUNCTIONS, BUSINESS_FUNCTION_LABELS } from '@workspace/shared';
import { notify } from '@/lib/notify';
import { Skel } from '@/components/bits';
import { IconSearch } from '@/components/icons';
import { HiddenFromAi } from '@/components/knowledge/parts';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { TYPE_LABELS, entityPath, useKnowledgeWrite } from '@/lib/knowledge';

const LIBRARY = [
  { href: '/knowledge/library', label: 'Documents' },
  { href: '/knowledge/library?tab=rules', label: 'Rules' },
  { href: '/knowledge/library?tab=playbooks', label: 'Playbooks' },
  { href: '/knowledge/sessions', label: 'Sessions' },
  { href: '/knowledge/products', label: 'Products' },
  { href: '/knowledge/decisions', label: 'Decisions' },
  { href: '/knowledge/notes', label: 'Notes' },
];

export function KnowledgeLayout({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }} className="oo-fade-in">
      <KnowledgeSidebar />
      <main className="oo-panel oo-kmain" data-testid={testId}>{children}</main>
    </div>
  );
}

function hitPath(h: SearchHit): string | null {
  if (h.type === 'document') return '/knowledge/library?document=' + h.id;
  if (h.type === 'fact') return h.parent ? entityPath(h.parent.type, h.parent.slug, h.parent.id) : null;
  return entityPath(h.type, h.slug, h.id);
}

function ProjectLink({ p, current }: { p: ProjectListItem; current: boolean }) {
  const hidden = p.confidential || !p.aiAccess;
  return (
    <Link href={'/knowledge/projects/' + p.slug} aria-current={current ? 'page' : undefined} data-testid={'link-project-' + p.slug}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{p.name}</span>
      {hidden ? <HiddenFromAi confidential={p.confidential} /> : <span className="oo-count oo-num" aria-label={`${p.openTaskCount} open tasks`}>{p.openTaskCount}</span>}
    </Link>
  );
}

function KnowledgeSidebar() {
  const [location] = useLocation();
  const params = new URLSearchParams(useSearch());
  const libraryTab = params.get('tab') === 'rules' || params.get('tab') === 'playbooks' ? params.get('tab') : 'documents';
  const libraryCurrent = (href: string) => {
    if (href === '/knowledge/library?tab=playbooks' && location.startsWith('/knowledge/playbooks/')) return true;
    if (!href.startsWith('/knowledge/library')) return location === href || location.startsWith(href + '/');
    return location === '/knowledge/library' && (new URLSearchParams(href.split('?')[1] ?? '').get('tab') ?? 'documents') === libraryTab;
  };
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const projects = useListProjects();
  const write = useKnowledgeWrite();
  const [suggesting, setSuggesting] = useState(false);
  const all = projects.data ?? [];
  const functions = BUSINESS_FUNCTIONS.map((f) => all.find((p) => p.isFunction && p.function === f)).filter((p): p is ProjectListItem => !!p);
  const plain = all.filter((p) => !p.isFunction);
  const groups = [
    ...BUSINESS_FUNCTIONS.map((f) => ({ key: f, label: BUSINESS_FUNCTION_LABELS[f] as string | null, items: plain.filter((p) => p.function === f) })),
    { key: 'none', label: 'No function yet' as string | null, items: plain.filter((p) => !p.function) },
  ].filter((g) => g.items.length);
  const unfiled = plain.filter((p) => !p.function || !p.clients.length).length;
  const suggest = async () => {
    setSuggesting(true);
    const r = await write(() => suggestProjectFunctions(), { fail: 'Could not suggest functions and clients' });
    setSuggesting(false);
    if (!r) return;
    if (!r.checked) return notify('Nothing to check', 'Every project AI may read has a function and a client, or a suggestion waiting.');
    const made = r.functions + r.clients;
    notify(
      made ? `${made === 1 ? '1 suggestion' : `${made} suggestions`} in your Knowledge Inbox` : 'No new suggestions',
      [
        r.functions ? `${r.functions === 1 ? '1 function' : `${r.functions} functions`}` : null,
        r.clients ? `${r.clients === 1 ? '1 client' : `${r.clients} clients`}` : null,
        r.unclear ? `${r.unclear === 1 ? '1 project' : `${r.unclear} projects`} not settled by what OllieOS knows` : null,
      ].filter(Boolean).join('. ') || undefined,
    );
  };
  const inbox = useListKnowledgeInbox({ tab: 'suggested' });
  const toReview = inbox.data?.counts.total;
  const search = useSearchKnowledge({ q }, { query: { enabled: q.length > 0 } as never });

  return (
    <aside className="oo-panel oo-kside" aria-label="Knowledge">
      <div role="search">
        <label htmlFor="k-search" className="oo-sr">Search knowledge</label>
        <div className="oo-search">
          <IconSearch size={15} />
          <input
            id="k-search"
            type="search"
            placeholder="Search knowledge"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setText('')}
            data-testid="input-knowledge-search"
          />
        </div>
      </div>

      {q ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-live="polite" data-testid="list-search-results">
          <span className="oo-side-label">Results</span>
          {search.isLoading ? (
            [0, 1, 2].map((i) => <Skel key={i} h={30} />)
          ) : search.error ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 12px' }}>Search did not work. Try again.</p>
          ) : !search.data?.hits.length ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 12px' }} data-testid="text-search-empty">Nothing matches "{q}".</p>
          ) : (
            search.data.hits.map((h) => {
              const path = hitPath(h);
              const body = (
                <>
                  <span className="oo-hit-type">
                    {TYPE_LABELS[h.type]}
                    {h.parent && h.type !== 'project' ? ` · ${h.parent.name}` : ''}
                    {h.hiddenFromAi && <HiddenFromAi confidential />}
                  </span>
                  <span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{h.title}</span>
                </>
              );
              return path ? (
                <Link key={h.type + h.id} href={path} className="oo-hit" onClick={() => setText('')} data-testid={`link-hit-${h.type}-${h.id}`}>{body}</Link>
              ) : (
                <div key={h.type + h.id} className="oo-hit">{body}</div>
              );
            })
          )}
        </div>
      ) : (
        <>
          <nav aria-label="Review">
            <Link href="/knowledge/inbox" aria-current={location === '/knowledge/inbox' ? 'page' : undefined} data-testid="link-knowledge-inbox">
              Knowledge Inbox
              {toReview !== undefined && <span className="oo-count oo-num" aria-label={`${toReview} to review`} data-testid="text-knowledge-inbox-count">{toReview}</span>}
            </Link>
            <Link href="/knowledge/map" aria-current={location === '/knowledge/map' ? 'page' : undefined} data-testid="link-knowledge-map">
              Map
            </Link>
          </nav>
          {!!functions.length && (
            <nav aria-label="Functions">
              <span className="oo-side-label">Functions</span>
              {functions.map((p) => <ProjectLink key={p.id} p={p} current={location === '/knowledge/projects/' + p.slug} />)}
            </nav>
          )}
          <nav aria-label="Projects">
            <span className="oo-side-label">Projects</span>
            {projects.isLoading ? (
              [0, 1, 2].map((i) => <Skel key={i} h={30} />)
            ) : projects.error ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 10px' }}>Could not load projects.</p>
            ) : (
              groups.map((g) => (
                <Fragment key={g.key}>
                  {g.label && groups.length > 1 && <span className="oo-muted" style={{ fontSize: 12, padding: '6px 10px 0' }} data-testid={'text-project-group-' + g.key}>{g.label}</span>}
                  {g.items.map((p) => <ProjectLink key={p.id} p={p} current={location === '/knowledge/projects/' + p.slug} />)}
                </Fragment>
              ))
            )}
            {projects.data && plain.length === 0 && (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 10px 4px' }}>No projects yet.</p>
            )}
            <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', margin: '4px 10px 0' }} onClick={() => setCreating(true)} data-testid="button-new-project-side">
              New project
            </button>
            {unfiled > 0 && (
              <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', margin: '2px 10px 0', textAlign: 'left' }} onClick={suggest} disabled={suggesting} data-testid="button-suggest-project-functions">
                {suggesting ? 'Suggesting…' : 'Suggest functions and clients'}
              </button>
            )}
          </nav>
          <nav aria-label="Library">
            <span className="oo-side-label">Library</span>
            {LIBRARY.map((l) => (
              <Link key={l.href} href={l.href} aria-current={libraryCurrent(l.href) ? 'page' : undefined} data-testid={'link-library-' + l.label.toLowerCase()}>
                {l.label}
              </Link>
            ))}
          </nav>
        </>
      )}
      {creating && <CreateDialog kind="project" onClose={() => setCreating(false)} />}
    </aside>
  );
}

/** Header row for library list pages: title, a line of context, and a create button. */
export function ListHeader({ title, line, action }: { title: string; line: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <p className="oo-eyebrow">Library</p>
        <h1 className="oo-h1">{title}</h1>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{line}</p>
      </div>
      {action}
    </div>
  );
}
