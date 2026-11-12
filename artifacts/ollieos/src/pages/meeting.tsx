import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  createPerson,
  getGetMeetingQueryKey,
  getListMeetingsQueryKey,
  useGetMeeting,
  type MeetingView,
} from '@workspace/api-client-react';
import { formatLong, formatTime } from '@workspace/shared';
import { Avatar } from '@/components/bits';
import { IconLeft } from '@/components/icons';
import { MeetingNotes } from '@/components/meeting-notes';
import { ScopePill } from '@/components/research';
import { PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';

/**
 * A work meeting without a prep page: who is coming, a way to add them to People, and Ollie's
 * agenda and notes. Once anyone on it is known the meeting gets a brief, and this page says so.
 */
export default function MeetingPage({ eventId }: { eventId: string }) {
  const id = Number(eventId);
  const q = useGetMeeting(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getGetMeetingQueryKey(id) } });
  return (
    <div className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-meeting">
      <Link href="/meetings" className="oo-back" style={{ color: 'var(--oo-ink-muted)' }} data-testid="link-back-meetings"><IconLeft size={14} />Meetings</Link>
      {q.isLoading ? (
        <main className="oo-panel oo-kmain"><PageSkeleton /></main>
      ) : !q.data ? (
        <main className="oo-panel oo-kmain">
          {isNotFound(q.error) ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-meeting-missing">That meeting is no longer on your calendar, or it is a personal event.</p>
          ) : (
            <PageProblem notFound={false} what="meeting" onRetry={() => q.refetch()} back={{ href: '/meetings', label: 'Meetings' }} />
          )}
        </main>
      ) : (
        <Meeting m={q.data} />
      )}
    </div>
  );
}

function Meeting({ m }: { m: MeetingView }) {
  const qc = useQueryClient();
  const hasPrep = m.prep !== 'none';
  const unknown = m.attendees.filter((a) => !a.person).length;
  return (
    <>
      <main className="oo-panel oo-kmain" style={{ gap: 18, flex: 'none' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-meeting-when">
            {formatLong(m.startsAt)}, {formatTime(m.startsAt)} to {formatTime(m.endsAt)}{m.platform ? ' · ' + m.platform : ''}
            {m.location && m.location !== m.platform ? ' · ' + m.location : ''}
          </p>
          <h1 className="oo-h1" style={{ overflowWrap: 'anywhere' }} data-testid="text-meeting-title">{m.title}</h1>
          <div><ScopePill scope={m.scope} companies={m.companies} testId="pill-meeting-scope" /></div>
        </div>

        {hasPrep ? (
          <div role="note" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderRadius: 'var(--oo-r-card-sm)', background: 'var(--oo-banner-bg)', border: '1px solid var(--oo-banner-border)', color: 'var(--oo-banner-fg)', fontSize: 14 }} data-testid="banner-has-prep">
            <span>Someone on this meeting is in People now, so it gets a brief.</span>
            <Link href={'/briefs/' + m.id} className="oo-btn oo-btn-ink" data-testid="link-open-prep">Open the prep page</Link>
          </div>
        ) : (
          <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, maxWidth: '64ch' }} data-testid="text-no-prep">
            {m.attendees.length === 0
              ? 'Nobody else is on the invite, so there is no brief. Your agenda and notes are still kept here.'
              : 'There is no brief yet because nobody on the invite is in People. Add the people you know and OllieOS will write one.'}
          </p>
        )}

        <section aria-labelledby="m-who" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-who">
          <h2 id="m-who" className="oo-h2">Who's coming</h2>
          {m.attendees.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No one else on the invite.</p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {m.attendees.map((a, i) => <Attendee key={(a.email ?? a.name) + i} a={a} index={i} eventId={m.id} />)}
            </ul>
          )}
          {!hasPrep && unknown > 1 && <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Adding one person is enough for a brief.</p>}
        </section>
      </main>

      <MeetingNotes
        eventId={m.id}
        initial={m.notes}
        placeholder="What you want to cover, questions to ask, anything to capture."
        onSaved={(notes) => qc.setQueryData(getGetMeetingQueryKey(m.id), (old: MeetingView | undefined) => (old ? { ...old, notes } : old))}
      />
    </>
  );
}

/** "andy.dillow@example.com" becomes "Andy Dillow", as a starting point Ollie can change. */
function nameFrom(a: MeetingView['attendees'][number]): string {
  if (!a.name.includes('@')) return a.name;
  return a.name
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function Attendee({ a, index, eventId }: { a: MeetingView['attendees'][number]; index: number; eventId: number }) {
  const qc = useQueryClient();
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(() => nameFrom(a));
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v || busy) return;
    setBusy(true);
    const p = await write(() => createPerson({ name: v, email: a.email }), { done: v + ' added to People', fail: 'Could not add that person' });
    setBusy(false);
    if (!p) return;
    setAdding(false);
    await Promise.all([
      qc.invalidateQueries({ queryKey: getGetMeetingQueryKey(eventId) }),
      qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() }),
    ]);
  };

  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--oo-line-soft)' }} data-testid={'row-attendee-' + index}>
      <Avatar name={a.person?.name ?? nameFrom(a)} id={a.person?.slug ?? a.email ?? a.name} size={28} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 200px' }}>
        {a.person ? (
          <Link href={'/knowledge/people/' + a.person.slug} className="oo-link" style={{ fontSize: 14, fontWeight: 600 }} data-testid={'link-attendee-' + index}>{a.person.name}</Link>
        ) : (
          <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>{a.name}</span>
        )}
        {a.email && a.email !== a.name && <span className="oo-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{a.email}</span>}
      </span>
      {a.person ? (
        <span className="oo-pill" data-tone="done">In People</span>
      ) : adding ? (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flex: '1 1 280px' }}>
          <label htmlFor={'attendee-name-' + index} className="sr-only">Their name</label>
          <input id={'attendee-name-' + index} className="oo-input" style={{ flex: '1 1 160px' }} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus data-testid={'input-attendee-name-' + index} />
          <button type="submit" className="oo-btn oo-btn-ink" disabled={busy || !name.trim()} data-testid={'button-attendee-save-' + index}>{busy ? 'Adding…' : 'Add'}</button>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => setAdding(false)} disabled={busy}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="oo-btn oo-btn-outline" onClick={() => setAdding(true)} data-testid={'button-attendee-add-' + index}>Add to People</button>
      )}
    </li>
  );
}
