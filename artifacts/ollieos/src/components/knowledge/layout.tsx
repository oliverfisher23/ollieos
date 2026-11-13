import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { suggestProjectFunctions, useListKnowledgeInbox, useListProjects, useSearchKnowledge, type ProjectListItem } from '@workspace/api-client-react';
import { BUSINESS_FUNCTIONS, BUSINESS_FUNCTION_LABELS } from '@workspace/shared';
import { notify } from '@/lib/notify';
import { Skel } from '@/components/bits';
import { IconLeft, IconSearch } from '@/components/icons';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';
import { HiddenFromAi } from '@/components/knowledge/parts';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { TYPE_LABELS, entityPath, searchHitPath, useKnowledgeWrite } from '@/lib/knowledge';

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
  const phone = useMedia(PHONE_QUERY);
  const [location] = useLocation();
  if (phone) {
    // Phones (docs/mobile-plan.md, Part D): /knowledge is the menu itself; every other page is shown
    // alone, with a way back to the menu, instead of under a long side menu.
    if (location === '/knowledge') {
      return (
        <div className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-knowledge-menu">
          <KnowledgeSidebar />
          {children && <main className="oo-panel oo-kmain" data-testid={testId}>{children}</main>}
        </div>
      );
    }
    return (
      <div className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Link href="/knowledge" className="oo-back" style={{ alignSelf: 'flex-start' }} data-testid="link-knowledge-menu">
          <IconLeft size={14} />
          Knowledge
        </Link>
        <main className="oo-panel oo-kmain" data-testid={testId}>{children}</main>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }} className="oo-fade-in">
      <KnowledgeSidebar />
      <main className="oo-panel oo-kmain" data-testid={testId}>{children}</main>
    </div>
  );
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
  const phone = useMedia(PHONE_QUERY);
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
  // Client work, grouped by client; internal work, grouped by function; then anything not sorted yet.
  const clientWork = plain.filter((p) => p.workType === 'client');
  const internalWork = plain.filter((p) => p.workType === 'internal');
  const unsorted = plain.filter((p) => !p.workType);
  const clientNames = [...new Set(clientWork.map((p) => p.clients[0] ?? ''))].sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1));
  const clientGroups = clientNames.map((c) => ({ key: 'client-' + (c || 'none'), label: c || 'Client not named yet', items: clientWork.filter((p) => (p.clients[0] ?? '') === c) }));
  const internalGroups = [
    ...BUSINESS_FUNCTIONS.map((f) => ({ key: f, label: BUSINESS_FUNCTION_LABELS[f] as string, items: internalWork.filter((p) => p.function === f) })),
    { key: 'none', label: 'No function yet', items: internalWork.filter((p) => !p.function) },
  ].filter((g) => g.items.length);
  const sections = [
    { key: 'clients', label: 'Clients', groups: clientGroups },
    { key: 'internal', label: 'Internal', groups: internalGroups },
    { key: 'unsorted', label: 'Not sorted yet', groups: unsorted.length ? [{ key: 'unsorted', label: '', items: unsorted }] : [] },
  ].filter((s) => s.groups.length);
  const unfiled = plain.filter((p) => !p.function || !p.workType || (p.workType === 'client' && !p.clients.length)).length;
  const suggest = async () => {
    setSuggesting(true);
    const r = await write(() => suggestProjectFunctions(), { fail: 'Could not suggest functions and clients' });
    setSuggesting(false);
    if (!r) return;
    if (!r.checked) return notify('Nothing to check', 'Every project AI may read is sorted, or has a suggestion waiting.');
    const made = r.functions + r.clients + r.workTypes;
    notify(
      made ? `${made === 1 ? '1 suggestion' : `${made} suggestions`} in your Knowledge Inbox` : 'No new suggestions',
      [
        r.functions ? `${r.functions === 1 ? '1 function' : `${r.functions} functions`}` : null,
        r.clients ? `${r.clients === 1 ? '1 client' : `${r.clients} clients`}` : null,
        r.workTypes ? `${r.workTypes === 1 ? '1 client or internal' : `${r.workTypes} client or internal`}` : null,
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
              const path = searchHitPath(h);
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
          {sections.map((sec) => (
            <nav key={sec.key} aria-label={sec.label} data-testid={'nav-projects-' + sec.key}>
              <span className="oo-side-label">{sec.label}</span>
              {sec.groups.map((g) => (
                <Fragment key={g.key}>
                  {g.label && <span className="oo-muted" style={{ fontSize: 12, padding: '6px 10px 0' }} data-testid={'text-project-group-' + g.key}>{g.label}</span>}
                  {g.items.map((p) => <ProjectLink key={p.id} p={p} current={location === '/knowledge/projects/' + p.slug} />)}
                </Fragment>
              ))}
            </nav>
          ))}
          <nav aria-label="Projects">
            {!sections.length && <span className="oo-side-label">Projects</span>}
            {projects.isLoading ? (
              [0, 1, 2].map((i) => <Skel key={i} h={30} />)
            ) : projects.error ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 10px' }}>Could not load projects.</p>
            ) : null}
            {projects.data && plain.length === 0 && (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 10px 4px' }}>No projects yet.</p>
            )}
            <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', margin: '4px 10px 0' }} onClick={() => setCreating(true)} data-testid="button-new-project-side">
              New project
            </button>
            {unfiled > 0 && (
              <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', margin: `${phone ? 14 : 2}px 10px 0`, textAlign: 'left' }} onClick={suggest} disabled={suggesting} data-testid="button-suggest-project-functions">
                {suggesting ? 'Suggesting…' : 'Sort projects: client or internal, function'}
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
