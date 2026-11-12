import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { getGetMeetingQueryKey, getListMeetingsQueryKey, setMeetingPersonal, useGetMeeting, type MeetingView } from '@workspace/api-client-react';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';
import { formatLong, formatTime } from '@workspace/shared';
import { Avatar } from '@/components/bits';
import { IconLeft } from '@/components/icons';
import { LazyMeetingAgenda as MeetingAgenda } from '@/components/meeting-agenda-lazy';
import { FromGranola } from '@/components/from-granola';
import { AddToContactsButton, nameFromInvite } from '@/components/add-to-contacts';
import { ScopePill } from '@/components/research';
import { PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { isNotFound } from '@/lib/knowledge';

/**
 * A work meeting without a prep page: who is coming, a way to add them to Contacts, and Ollie's
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
  const hasPrep = m.prep !== 'none';
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  // Personal events leave Meetings and are kept from AI. Undo brings it straight back.
  const markPersonal = async () => {
    try {
      await setMeetingPersonal(m.id, { personal: true });
      void qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() });
      navigate('/meetings');
      notifyUndo('Marked as personal', 'It has left Meetings and is kept from AI, along with the rest of its series.', () => {
        void setMeetingPersonal(m.id, { personal: false })
          .then(() => qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() }))
          .catch((err) => notify('Could not undo that', errorMessage(err)));
      });
    } catch (err) {
      notify('That did not save', errorMessage(err));
    }
  };
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <ScopePill scope={m.scope} companies={m.companies} testId="pill-meeting-scope" />
            {!hasPrep && <button type="button" className="oo-textbtn" onClick={markPersonal} data-testid="button-mark-personal">This is personal</button>}
          </div>
        </div>

        {hasPrep ? (
          <div role="note" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderRadius: 'var(--oo-r-card-sm)', background: 'var(--oo-banner-bg)', border: '1px solid var(--oo-banner-border)', color: 'var(--oo-banner-fg)', fontSize: 14 }} data-testid="banner-has-prep">
            <span>Someone on this meeting is in Contacts now, so it gets a brief.</span>
            <Link href={'/briefs/' + m.id} className="oo-btn oo-btn-ink" data-testid="link-open-prep">Open the prep page</Link>
          </div>
        ) : (
          <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, maxWidth: '64ch' }} data-testid="text-no-prep">
            {m.attendees.length === 0
              ? 'Nobody else is on the invite, so there is no brief. Your agenda and notes are still kept here.'
              : 'There is no brief yet because nobody on the invite is in Contacts. Add the people you know and OllieOS will write one.'}
          </p>
        )}

        <section aria-labelledby="m-who" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-who">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h2 id="m-who" className="oo-h2">Who's coming</h2>
            {unknown > 1 && (
              <AddToContactsButton
                people={m.attendees.filter((a) => !a.person).map((a) => ({ name: a.name, email: a.email, suggestion: a.suggestedOrganisation ?? null }))}
                testId="all"
                primary={!hasPrep}
              />
            )}
          </div>
          {m.attendees.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No one else on the invite.</p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {m.attendees.map((a, i) => <Attendee key={(a.email ?? a.name) + i} a={a} index={i} />)}
            </ul>
          )}
          {!hasPrep && unknown > 1 && <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Adding one person is enough for a brief.</p>}
        </section>
      </main>

      <FromGranola eventId={m.id} endsAt={m.endsAt} />
      <MeetingAgenda eventId={m.id} />
    </>
  );
}

function Attendee({ a, index }: { a: MeetingView['attendees'][number]; index: number }) {
  const p = a.person;
  const nameIsEmail = !!a.email && a.name.trim().toLowerCase() === a.email.toLowerCase();
  const title = p ? p.name : nameIsEmail ? nameFromInvite(a.name) : a.name;
  const s = a.suggestedOrganisation;
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--oo-line-soft)', flexWrap: 'wrap' }} data-testid={'row-attendee-' + index}>
      <Avatar name={title} id={p?.slug ?? a.email ?? a.name} size={32} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: '1 1 220px' }}>
        {p ? (
          <Link href={'/knowledge/people/' + p.slug} className="oo-attendee-name" style={{ fontSize: 14, fontWeight: 600 }} data-testid={'link-attendee-' + index}>{title}</Link>
        ) : (
          <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>{title}</span>
        )}
        <span style={{ fontSize: 12, color: 'var(--oo-ink-muted)', overflowWrap: 'anywhere' }}>
          {p?.organisation ? (
            <Link href={'/knowledge/organisations/' + p.organisation.slug} className="oo-attendee-org" data-testid={'link-attendee-org-' + index}>{p.organisation.name}</Link>
          ) : null}
          {p?.organisation && a.email ? ' · ' : ''}
          {a.email}
          {!p && s && (s.existing || s.newName) ? ` · ${s.existing ? s.existing.name : `${s.newName} (new)`}` : ''}
        </span>
      </span>
      {p ? (
        <span className="oo-pill" data-tone="done">In Contacts</span>
      ) : (
        <AddToContactsButton people={[{ name: a.name, email: a.email, suggestion: s ?? null }]} testId={String(index)} />
      )}
    </li>
  );
}
