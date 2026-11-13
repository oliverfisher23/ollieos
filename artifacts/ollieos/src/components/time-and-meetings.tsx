import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTaskSummaryQueryKey,
  getListMeetingsWorthALookQueryKey,
  keepMeetingSeries,
  useGetTaskSummary,
  useGetTimeReport,
  useGetWeekCheck,
  useListMeetingsWorthALook,
  type TimeSlice,
} from '@workspace/api-client-react';
import { formatShort, todayLondon } from '@workspace/shared';
import { copyText } from '@/lib/knowledge';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const h = (n: number) => (n === 1 ? '1 hour' : `${n} hours`);

/** Part R: meeting hours this week by goal and function, with the four weeks before. */
export function WhereTimeWent() {
  const q = useGetTimeReport();
  const r = q.data;
  if (!r) return null;
  const [cur, ...prev] = r.weeks;
  const bar = (s: TimeSlice, total: number) => (
    <li key={s.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 3fr auto', gap: 10, alignItems: 'center', fontSize: 13 }}>
      <span className="oo-mail-clamp">{s.label}</span>
      <span aria-hidden="true" style={{ height: 8, borderRadius: 999, background: 'var(--oo-line)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${total ? Math.round((s.hours / total) * 100) : 0}%`, background: s.key === 'none' ? 'var(--oo-ink-muted)' : 'var(--oo-ink)' }} />
      </span>
      <span className="oo-num oo-muted">{h(s.hours)}</span>
    </li>
  );
  return (
    <section aria-labelledby="time-h" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }} data-testid="section-where-time-went">
      <h2 id="time-h" className="oo-h2">Where your time went</h2>
      {cur.meetingHours === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No work meetings on record this week yet. Meetings are added as they end.</p>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 14 }} data-testid="text-time-total">
            <strong>{h(cur.meetingHours)}</strong> in meetings this week, {h(cur.externalHours)} with outside people.
            {cur.plannedTaskHours > 0 && <span className="oo-soft"> {h(cur.plannedTaskHours)} of planned task time ticked off (from Plan my day, as planned, not measured).</span>}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
            <div>
              <span className="oo-field-label">By goal</span>
              <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>{cur.byGoal.map((s) => bar(s, cur.meetingHours))}</ul>
            </div>
            <div>
              <span className="oo-field-label">By function</span>
              <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>{cur.byFunction.map((s) => bar(s, cur.meetingHours))}</ul>
            </div>
            <div data-testid="section-time-by-work">
              <span className="oo-field-label">Client or internal</span>
              <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>{cur.byWork.map((s) => bar(s, cur.meetingHours))}</ul>
            </div>
          </div>
          {r.thinGoals.length > 0 && (
            <p className="oo-soft" style={{ margin: 0, fontSize: 13 }} data-testid="text-thin-goals">
              Under a tenth of this week's meeting time went to {r.thinGoals.join(', ')}.
            </p>
          )}
        </>
      )}
      {prev.some((w) => w.meetingHours > 0) && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
          Weeks before: {prev.map((w) => `${formatShort(w.weekStart)} ${h(w.meetingHours)}`).join(', ')}.
        </p>
      )}
    </section>
  );
}

/**
 * Home, when the week has more due than free time (Part R). Section 30, Part B: one line under the
 * queue, with what could move behind it, and nothing at all when the week fits.
 */
export function WeekCheckLine() {
  const q = useGetWeekCheck({ query: { staleTime: 60_000 } });
  const w = q.data;
  if (!w || !w.over) return null;
  const line = (
    <span data-testid="text-week-over">
      This week is over by about {h(w.overBy)}: {h(w.dueHours)} due against {h(w.freeHours)} free outside meetings.
    </span>
  );
  if (!w.movable.length) return <li className="oo-notice" data-testid="card-week-check">{line}</li>;
  return (
    <li className="oo-notice" data-testid="card-week-check">
      <details>
        <summary>{line} <span className="oo-notice-more">What could move</span></summary>
        <ul>
          {w.movable.map((t) => (
            <li key={t.id}><Link href={'/tasks?task=' + t.id}>{t.title}</Link>{t.dueDate && <span className="oo-t3"> · {formatShort(t.dueDate)}</span>}</li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Section 27: a day in the next week with too much due and little of it in Now, and anything overdue. One line each on Home. */
export function BusyDayLines() {
  const q = useGetTaskSummary(undefined, { query: { queryKey: getGetTaskSummaryQueryKey(), staleTime: 30_000 } });
  const load = q.data?.load;
  if (!load || (!load.busiest && !load.overdue)) return null;
  const b = load.busiest;
  return (
    <>
      {load.overdue > 0 && (
        <li className="oo-notice" data-testid="text-overdue">
          <span>{load.overdue} overdue.</span>
          <Link href="/tasks?due=overdue">See {load.overdue === 1 ? 'it' : 'them'}</Link>
        </li>
      )}
      {b && (
        <li className="oo-notice" data-testid="text-busy-day">
          <span>{b.due} tasks due {b.date === todayLondon() ? 'today' : formatShort(b.date)}, {b.inNow === 0 ? 'none' : `only ${b.inNow}`} in Now.</span>
          <Link href={'/tasks?due=' + b.date}>See them</Link>
        </li>
      )}
    </>
  );
}

/** Part R: repeating meetings that keep bringing nothing, on the Meetings page. */
export function WorthALookSection() {
  const qc = useQueryClient();
  const q = useListMeetingsWorthALook();
  const [busy, setBusy] = useState(false);
  const items = q.data ?? [];
  if (!items.length) return null;
  const keep = async (id: string) => {
    setBusy(true);
    try {
      await keepMeetingSeries(id);
      await qc.invalidateQueries({ queryKey: getListMeetingsWorthALookQueryKey() });
      notify('Kept', 'Not asked again for 12 weeks.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="m-worth" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-worth-a-look">
      <h2 id="m-worth" className="oo-h2">Worth a look</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Repeating meetings where three of the last four brought no actions or decisions in their notes. Nothing changes in your calendar.</p>
      {items.map((m) => (
        <div key={m.seriesId} className="oo-source" style={{ gap: 6 }} data-testid={'card-worth-' + m.seriesId}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{m.title}</span>
          <span className="oo-soft" style={{ fontSize: 13 }}>
            {m.howOften[0].toUpperCase() + m.howOften.slice(1)}, about {h(m.hoursAMonth)} a month. Of the last four: {m.lastFour.notes} with notes, {m.lastFour.actions} actions, {m.lastFour.decisions} decisions.
          </span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={() => void keep(m.seriesId)} data-testid={'button-worth-keep-' + m.seriesId}>Keep</button>
            <button
              type="button"
              className="oo-btn oo-btn-outline oo-btn-sm"
              onClick={async () => notify((await copyText(m.note)) ? 'Note copied' : 'Could not copy', m.organiser ? `Paste it into an email to ${m.organiser}. Nothing was sent.` : 'Nothing was sent.')}
              data-testid={'button-worth-note-' + m.seriesId}
            >
              Copy a note to the organiser
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
