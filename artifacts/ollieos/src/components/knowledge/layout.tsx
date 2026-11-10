import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useListKnowledgeInbox, useListProjects, useSearchKnowledge, type SearchHit } from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { IconSearch } from '@/components/icons';
import { HiddenFromAi } from '@/components/knowledge/parts';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { TYPE_LABELS, entityPath } from '@/lib/knowledge';

const LIBRARY = [
  { href: '/knowledge/library', label: 'Documents' },
  { href: '/knowledge/library?tab=playbooks', label: 'Playbooks' },
  { href: '/knowledge/sessions', label: 'Sessions' },
  { href: '/knowledge/people', label: 'People' },
  { href: '/knowledge/organisations', label: 'Organisations' },
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

function KnowledgeSidebar() {
  const [location] = useLocation();
  const params = new URLSearchParams(useSearch());
  const libraryTab = params.get('tab') === 'playbooks' ? 'playbooks' : 'documents';
  const libraryCurrent = (href: string) => {
    if (!href.startsWith('/knowledge/library')) return location === href || location.startsWith(href + '/');
    return location === '/knowledge/library' && (href.includes('playbooks') ? libraryTab === 'playbooks' : libraryTab === 'documents');
  };
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const projects = useListProjects();
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
          </nav>
          <nav aria-label="Projects">
            <span className="oo-side-label">Projects</span>
            {projects.isLoading ? (
              [0, 1, 2].map((i) => <Skel key={i} h={30} />)
            ) : projects.error ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 10px' }}>Could not load projects.</p>
            ) : (
              (projects.data ?? []).map((p) => {
                const href = '/knowledge/projects/' + p.slug;
                const hidden = p.confidential || !p.aiAccess;
                return (
                  <Link key={p.id} href={href} aria-current={location === href ? 'page' : undefined} data-testid={'link-project-' + p.slug}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{p.name}</span>
                    {hidden ? <HiddenFromAi confidential={p.confidential} /> : <span className="oo-count oo-num" aria-label={`${p.openTaskCount} open tasks`}>{p.openTaskCount}</span>}
                  </Link>
                );
              })
            )}
            {projects.data && projects.data.length === 0 && (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, padding: '0 10px 4px' }}>No projects yet.</p>
            )}
            <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', margin: '4px 10px 0' }} onClick={() => setCreating(true)} data-testid="button-new-project-side">
              New project
            </button>
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
