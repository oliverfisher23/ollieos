import { useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  deleteSession,
  readSessionKnowledge,
  updateSession,
  useGetSession,
  useListSessions,
  type SessionDetail,
  type SessionListItem,
} from '@workspace/api-client-react';
import { formatDayMonthShort, formatLong, formatTime } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { IconSearch } from '@/components/icons';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { HiddenFromAi, PageProblem, PageSkeleton, TriStateAccess } from '@/components/knowledge/parts';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Cowork sessions Claude saved with save_session, newest first; ?session=id opens one. */
export default function SessionsPage() {
  const params = new URLSearchParams(useSearch());
  const open = Number(params.get('session')) || null;
  return <KnowledgeLayout testId="page-sessions">{open ? <SessionView key={open} id={open} /> : <SessionList />}</KnowledgeLayout>;
}

/* ---------- List ---------- */

function SessionList() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useListSessions(q.length >= 2 ? { q } : undefined);
  const rows = list.data ?? [];
  const searching = q.length >= 2;
  const current = searching ? rows : rows.filter((s) => !s.archived);
  const archived = searching ? [] : rows.filter((s) => s.archived);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-eyebrow">Library</p>
          <h1 className="oo-h1">Sessions</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            Your Cowork sessions, saved by Claude at the end of each one. Tasks from a session go to your Inbox; facts and decisions wait in your Knowledge Inbox.
          </p>
        </div>
        <div role="search" style={{ flex: '0 1 280px', minWidth: 200 }}>
          <label htmlFor="session-search" className="oo-sr">Search sessions</label>
          <div className="oo-search">
            <IconSearch size={15} />
            <input
              id="session-search"
              type="search"
              placeholder="Search sessions"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setText('')}
              data-testid="input-session-search"
            />
          </div>
        </div>
      </div>

      {list.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map((i) => <Skel key={i} h={64} />)}</div>
      ) : list.error ? (
        <PageProblem notFound={false} what="list" onRetry={() => list.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />
      ) : !rows.length ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-sessions-empty">
          {searching ? `No sessions match "${q}".` : 'No sessions yet. Copy the instructions for Cowork from Settings, Connectors into Cowork and Claude will save each session here.'}
        </p>
      ) : (
        <div aria-live="polite">
          {current.length === 0 && !searching && <p className="oo-muted" style={{ margin: '0 0 8px', fontSize: 14 }}>Every session is archived.</p>}
          {current.map((s) => <SessionRow key={s.id} s={s} />)}
          {archived.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start' }} aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)} data-testid="button-show-archived-sessions">
                {showArchived ? 'Hide archived sessions' : `Show ${plural(archived.length, 'archived session', 'archived sessions')}`}
              </button>
              {showArchived && (
                <>
                  <p className="oo-muted" style={{ margin: 0, fontSize: 12 }}>Older than 90 days with nothing from them still open. Kept here and in search, but left out of briefs.</p>
                  {archived.map((s) => <SessionRow key={s.id} s={s} />)}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SessionRow({ s }: { s: SessionListItem }) {
  const bits = [
    s.taskCount ? plural(s.taskCount, 'task', 'tasks') : null,
    s.decisionCount ? plural(s.decisionCount, 'decision', 'decisions') : null,
    s.documentCount ? plural(s.documentCount, 'document', 'documents') : null,
    s.waitingCount ? `${s.waitingCount} to review` : null,
  ].filter(Boolean);
  const about = [...s.projects, ...s.people].map((x) => x.name);
  return (
    <Link
      href={'/knowledge/sessions?session=' + s.id}
      className="oo-krow oo-krow-link"
      style={{ textDecoration: 'none', alignItems: 'flex-start', justifyContent: 'flex-start', flexWrap: 'nowrap' }}
      data-testid={'row-session-' + s.id}
    >
      <span className="oo-tl-date" style={{ paddingTop: 2 }}>{formatDayMonthShort(s.happenedAt)}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{s.title}</span>
          {s.archived && <span className="oo-pill" data-tone="noise">Archived</span>}
          {s.hiddenFromAi && <HiddenFromAi confidential={s.confidential === true} />}
        </span>
        <span className="oo-muted oo-clamp-2" style={{ fontSize: 13 }}>{s.summary}</span>
        {(about.length > 0 || bits.length > 0) && (
          <span className="oo-muted" style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {about.length > 0 && <span>{about.join(', ')}</span>}
            {bits.length > 0 && <span className="oo-num">{bits.join(' · ')}</span>}
          </span>
        )}
      </span>
    </Link>
  );
}

/* ---------- One session ---------- */

function SessionView({ id }: { id: number }) {
  const q = useGetSession(id);
  const [, navigate] = useLocation();
  if (q.isLoading) return <PageSkeleton />;
  if (!q.data) {
    return <PageProblem notFound={isNotFound(q.error)} what="session" onRetry={() => q.refetch()} back={{ href: '/knowledge/sessions', label: 'All sessions' }} />;
  }
  return <SessionBody s={q.data} onDeleted={() => navigate('/knowledge/sessions', { replace: true })} />;
}

function SessionBody({ s, onDeleted }: { s: SessionDetail; onDeleted: () => void }) {
  const write = useKnowledgeWrite();
  const parent = 'its projects and people';
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 360px' }}>
          <Link href="/knowledge/sessions" className="oo-link" style={{ fontSize: 13 }} data-testid="link-all-sessions">All sessions</Link>
          <p className="oo-eyebrow">Cowork session</p>
          <h1 className="oo-h1" style={{ overflowWrap: 'anywhere' }} data-testid="text-session-title">{s.title}</h1>
          <span className="oo-muted" style={{ fontSize: 14, display: 'inline-flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span data-testid="text-session-date">{formatLong(s.happenedAt)}, {formatTime(s.happenedAt)}</span>
            {s.archived && <span className="oo-pill" data-tone="noise" title="Older than 90 days with nothing from it still open">Archived</span>}
            {s.hiddenFromAi && <HiddenFromAi confidential={s.confidential === true} />}
          </span>
        </div>
        <TriStateAccess
          value={s.confidential ?? null}
          hidden={s.hiddenFromAi}
          parent={parent}
          itemRef={'session:' + s.id}
          testId="session-access"
          onChange={(v) =>
            write(() => updateSession(s.id, { confidential: v }), {
              done: v === true ? 'Marked confidential. Hidden from AI.' : v === false ? 'Readable by AI, whatever its projects and people say' : `Now follows ${parent}`,
            })
          }
        />
      </div>

      <section aria-labelledby="ss-sum" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
        <h2 id="ss-sum" className="oo-h2">Summary</h2>
        <p className="oo-soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.6, whiteSpace: 'pre-wrap' }} data-testid="text-session-summary">{s.summary}</p>
      </section>

      {s.outcomes.length > 0 && (
        <section aria-labelledby="ss-out" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
          <h2 id="ss-out" className="oo-h2">What was done</h2>
          <ul style={{ margin: 0, paddingLeft: 20, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, lineHeight: 1.5 }} data-testid="list-session-outcomes">
            {s.outcomes.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </section>
      )}

      {(s.projects.length > 0 || s.people.length > 0) && (
        <section aria-labelledby="ss-about" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="ss-about" className="oo-h2">Touched</h2>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 14 }} data-testid="list-session-touched">
            {s.projects.map((p) => <Link key={'p' + p.id} href={'/knowledge/projects/' + p.slug} className="oo-pill" data-tone="now">{p.name}</Link>)}
            {s.people.map((p) => <Link key={'pe' + p.id} href={'/knowledge/people/' + p.slug} className="oo-pill">{p.name}</Link>)}
          </span>
        </section>
      )}

      <div className="oo-kgrid">
        <section aria-labelledby="ss-tasks" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h2 id="ss-tasks" className="oo-h2">Tasks created</h2>
          {s.tasks.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None.</p>
          ) : (
            <div>
              {s.tasks.map((t) => (
                <Link key={t.id} href={'/tasks?task=' + t.id} className="oo-krow oo-krow-link" style={{ textDecoration: 'none' }} data-testid={'link-session-task-' + t.id}>
                  <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{t.kind === 'promise' ? 'Promise: ' : ''}{t.title}</span>
                  <span className="oo-pill" data-tone={t.status}>{t.status === 'done' ? 'Done' : t.status === 'dropped' ? 'Dropped' : 'Open'}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section aria-labelledby="ss-dec" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h2 id="ss-dec" className="oo-h2">Decisions</h2>
          {s.decisions.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{s.waitingCount ? 'None approved yet.' : 'None.'}</p>
          ) : (
            <div>
              {s.decisions.map((d) => (
                <Link key={d.id} href={'/knowledge/decisions/' + d.id} className="oo-krow oo-krow-link" style={{ textDecoration: 'none' }} data-testid={'link-session-decision-' + d.id}>
                  <span style={{ overflowWrap: 'anywhere' }}>{d.text}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section aria-labelledby="ss-docs" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h2 id="ss-docs" className="oo-h2">Documents produced</h2>
          {s.documents.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None.</p>
          ) : (
            <div>
              {s.documents.map((d) => (
                <Link key={d.id} href={'/knowledge/library?document=' + d.id} className="oo-krow oo-krow-link" style={{ textDecoration: 'none' }} data-testid={'link-session-document-' + d.id}>
                  <span style={{ overflowWrap: 'anywhere' }}>{d.title}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <KnowledgeStatus s={s} />

      {s.transcript && (
        <details data-testid="details-session-transcript">
          <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>Transcript</summary>
          <pre className="oo-soft" style={{ margin: '10px 0 0', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '80ch' }}>{s.transcript}</pre>
        </details>
      )}

      <DeleteSession id={s.id} onDeleted={onDeleted} />
    </>
  );
}

/** Where reading this session for knowledge has got. */
function KnowledgeStatus({ s }: { s: SessionDetail }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState(false);
  const watching = s.knowledge.state === 'waiting' || s.knowledge.state === 'reading';
  const q = useGetSession(s.id, { query: { refetchInterval: watching ? 4000 : false } as never });
  const k = (q.data ?? s).knowledge;
  if (s.hiddenFromAi) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-session-knowledge">Hidden from AI, so OllieOS does not read it for knowledge.</p>;
  }
  const line =
    k.state === 'waiting'
      ? 'Waiting to be read for knowledge'
      : k.state === 'reading'
        ? 'Reading for knowledge…'
        : k.state === 'failed'
          ? (k.error ?? 'Could not be read for knowledge')
          : k.lastReadAt
            ? `Read for knowledge ${formatDayMonthShort(k.lastReadAt)}: ${k.found ?? 'nothing new'}`
            : 'Not read for knowledge yet';
  const again = async () => {
    setBusy(true);
    await write(() => readSessionKnowledge(s.id), { done: 'Reading it for knowledge now', fail: 'Could not start reading it' });
    setBusy(false);
  };
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4, fontSize: 13 }} data-testid="session-knowledge">
      <span role="status" className={k.state === 'failed' ? undefined : 'oo-muted'} style={k.state === 'failed' ? { color: 'var(--oo-danger)' } : undefined} data-testid="text-session-knowledge">{line}</span>
      {s.waitingCount > 0 && (
        <Link href="/knowledge/inbox?from=documents" className="oo-krow-link" data-testid="link-session-inbox">Review {s.waitingCount} in the Knowledge Inbox</Link>
      )}
      {k.state !== 'waiting' && k.state !== 'reading' && (
        <button type="button" className="oo-textbtn" disabled={busy} onClick={again} data-testid="button-session-read-again">
          {k.state === 'failed' ? 'Try again' : k.lastReadAt ? 'Read again' : 'Read it for knowledge'}
        </button>
      )}
    </span>
  );
}

function DeleteSession({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const write = useKnowledgeWrite();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <div style={{ borderTop: '1px solid var(--oo-line)', paddingTop: 12 }}>
        <button type="button" className="oo-textbtn" onClick={() => setAsking(true)} data-testid="button-delete-session">Delete this session</button>
      </div>
    );
  }
  const go = async () => {
    setBusy(true);
    const ok = await write(() => deleteSession(id).then(() => true), { done: 'Session deleted', fail: 'Could not delete it' });
    setBusy(false);
    if (ok) onDeleted();
  };
  return (
    <div role="group" aria-label="Delete this session" style={{ borderTop: '1px solid var(--oo-line)', paddingTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
      <span>Delete this session? Tasks, decisions and documents from it stay.</span>
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={go} data-testid="button-delete-session-yes">{busy ? 'Deleting…' : 'Delete it'}</button>
      <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={busy} onClick={() => setAsking(false)}>Keep it</button>
    </div>
  );
}
