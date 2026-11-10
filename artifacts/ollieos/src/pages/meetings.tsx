import { Link } from 'wouter';
import { useListMeetings, type MeetingRow } from '@workspace/api-client-react';
import { addDays, formatLong, formatShort, formatTime } from '@workspace/shared';
import { ScopePill } from '@/components/research';
import { Avatar, Skel } from '@/components/bits';
import { PageProblem } from '@/components/knowledge/parts';

const PREP: Record<MeetingRow['prep'], { label: string; tone?: string }> = {
  ready: { label: 'Brief ready', tone: 'done' },
  not_much: { label: 'Brief written, little on file' },
  failed: { label: 'Brief failed, open to try again', tone: 'stale' },
  not_written: { label: 'Brief written when you open it', tone: 'inbox' },
  none: { label: 'No prep: nobody you know is on it' },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  return formatLong(day);
}

/** Up to three names, then "and 4 more". */
function who(attendees: MeetingRow['attendees']): string {
  if (!attendees.length) return 'No one else on the invite';
  const names = attendees.slice(0, 3).map((a) => a.name);
  const more = attendees.length - names.length;
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

export default function MeetingsPage() {
  const q = useListMeetings();
  const now = Date.now();

  const upcoming = q.data?.upcoming ?? [];
  const days: { day: string; rows: MeetingRow[] }[] = [];
  for (const r of upcoming) {
    const last = days[days.length - 1];
    if (last?.day === r.day) last.rows.push(r);
    else days.push({ day: r.day, rows: [r] });
  }
  const ahead = upcoming.filter((r) => new Date(r.endsAt).getTime() > now).length;

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-meetings">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <h1 className="oo-h1">Meetings</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            Your work meetings for the next seven days and how ready each one is. Open one for its prep.
          </p>
        </div>
        <span className="oo-serif" style={{ fontSize: 22 }} data-testid="text-meetings-ahead">{q.data ? plural(ahead, 'meeting ahead', 'meetings ahead') : '…'}</span>
      </div>

      {q.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skel key={i} h={64} />)}</div>
      ) : !q.data ? (
        <PageProblem notFound={false} what="meetings" onRetry={() => q.refetch()} back={{ href: '/', label: 'Home' }} />
      ) : (
        <>
          {days.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-meetings-empty">
              No work meetings in the next seven days. Your calendar is read on each sweep.
            </p>
          ) : (
            days.map(({ day, rows }) => (
              <section key={day} aria-labelledby={'d-' + day} style={{ display: 'flex', flexDirection: 'column' }} data-testid={'section-day-' + day}>
                <h2 id={'d-' + day} className="oo-mt-day">
                  {dayLabel(day, q.data.today)}
                  {day === q.data.today || day === addDays(q.data.today, 1) ? <span className="oo-muted" style={{ fontWeight: 400 }}> · {formatLong(day)}</span> : null}
                </h2>
                {rows.map((r) => <Row key={r.id} r={r} finished={new Date(r.endsAt).getTime() <= now} />)}
              </section>
            ))
          )}

          <section aria-labelledby="m-past" style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="section-past">
            <h2 id="m-past" className="oo-h2">Last two weeks</h2>
            {q.data.past.length === 0 ? (
              <p className="oo-muted" style={{ margin: '6px 0 0', fontSize: 14 }} data-testid="state-past-empty">No work meetings in the last two weeks.</p>
            ) : (
              q.data.past.map((r) => <Row key={r.id} r={r} past />)
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Row({ r, past = false, finished = false }: { r: MeetingRow; past?: boolean; finished?: boolean }) {
  const prep = PREP[r.prep];
  const body = (
    <>
      <span className="oo-mt-when oo-num" data-testid={'text-meeting-time-' + r.id}>
        {past && <span style={{ display: 'block' }}>{formatShort(r.day)}</span>}
        {formatTime(r.startsAt)} to {formatTime(r.endsAt)}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }} data-testid={'text-meeting-title-' + r.id}>
          {r.title}
          {r.platform && <span className="oo-muted" style={{ fontWeight: 400 }}> · {r.platform}</span>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {r.attendees.length > 0 && (
            <span aria-hidden="true" style={{ display: 'inline-flex', flex: 'none' }}>
              {r.attendees.slice(0, 3).map((a, i) => (
                <span key={i} style={{ marginLeft: i ? -6 : 0 }}><Avatar name={a.name} id={a.slug ?? a.name} size={22} /></span>
              ))}
            </span>
          )}
          <span className="oo-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }} data-testid={'text-meeting-who-' + r.id}>{who(r.attendees)}</span>
        </span>
        {past && (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <ScopePill scope={r.scope} companies={r.companies} testId={'pill-scope-' + r.id} />
          </span>
        )}
        {past ? (
          r.granolaSnippet ? (
            <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--oo-ink-soft)', overflowWrap: 'anywhere' }} data-testid={'text-meeting-granola-' + r.id}>
              <b style={{ fontWeight: 600 }}>Granola: </b>{r.granolaSnippet}
            </span>
          ) : (
            <span className="oo-muted" style={{ fontSize: 13 }} data-testid={'text-meeting-granola-' + r.id}>No Granola notes</span>
          )
        ) : (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} data-testid={'readiness-' + r.id}>
            <ScopePill scope={r.scope} companies={r.companies} testId={'pill-scope-' + r.id} />
            {finished && <span className="oo-pill">Finished</span>}
            <span className="oo-pill" data-tone={prep.tone} data-testid={'pill-prep-' + r.id}>{prep.label}</span>
            {r.promises > 0 && <span className="oo-pill" data-tone="now" data-testid={'pill-promises-' + r.id}>{plural(r.promises, 'open promise', 'open promises')}</span>}
            {r.waiting > 0 && <span className="oo-pill" data-tone="waiting" data-testid={'pill-waiting-' + r.id}>{plural(r.waiting, 'item', 'items')} waiting on them</span>}
          </span>
        )}
      </span>
    </>
  );
  return r.prep === 'none' ? (
    <div className="oo-mt-row" data-finished={finished || undefined} data-testid={'row-meeting-' + r.id}>{body}</div>
  ) : (
    <Link href={'/briefs/' + r.id} className="oo-mt-row" data-link="true" data-finished={finished || undefined} data-testid={'row-meeting-' + r.id}>
      {body}
    </Link>
  );
}
