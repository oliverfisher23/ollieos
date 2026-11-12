import { useEffect, useState } from 'react';
import { WeekCheckCard } from '@/components/time-and-meetings';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  dismissClearOut,
  getGetClearOutQueryKey,
  getGetHomeQueryKey,
  useGetClearOut,
  useGetHome,
  type CalendarEvent,
  type DoNextItem,
  type HomeSummary,
  type WaitingItem,
} from '@workspace/api-client-react';
import { SOURCE_LABELS, WAITING_AMBER_DAYS, formatLong, formatShort, formatTime, greeting, todayLondon } from '@workspace/shared';
import { AddBox } from '@/components/add-box';
import { DayPlanCard } from '@/components/day-plan';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';
import { Avatar, PriorityPill, Skel } from '@/components/bits';
import { IconArrowOut, IconCheck, IconLock, IconSettings } from '@/components/icons';
import { requestItemName, useAccessActions, whenLabel } from '@/lib/access';
import { useSession } from '@/lib/auth-context';
import { useTaskActions } from '@/lib/task-actions';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';

function breakdown(home: HomeSummary): string {
  if (!home.inbox.count) return 'Inbox clear';
  return home.inbox.bySource
    .filter((s) => s.count > 0)
    .map((s) => s.count + ' ' + (s.source === 'slack' ? 'Slack' : SOURCE_LABELS[s.source].toLowerCase()))
    .join(' · ');
}

/** Access requests from AI tools, answered straight from the status line (PRD 10, rule 3). */
function AccessStatus({ access }: { access: HomeSummary['access'] }) {
  const actions = useAccessActions();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const req = access.pending[0];
  const more = access.pending.length - 1;
  const open = access.open[0];

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) setNote(done);
  };

  let content;
  if (req) {
    const name = requestItemName(req);
    content = (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }} data-testid={'status-request-' + req.id}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconLock size={13} className="oo-req-lock" />
          {req.client.name} asked to read <b style={{ fontWeight: 600 }}>{name}</b>
        </span>
        {req.item ? (
          <button type="button" className="oo-req-btn" data-tone="accent" disabled={busy}
            onClick={() => act(() => actions.approve(req), `${name} open to ${req.client.name} for 1 hour`)} data-testid={'button-home-allow-' + req.id}>
            Allow 1 hour
          </button>
        ) : (
          <Link href="/settings/connectors#access-requests" className="oo-req-btn" data-tone="accent" data-testid={'link-home-review-' + req.id}>Choose item</Link>
        )}
        <button type="button" className="oo-req-btn" disabled={busy}
          onClick={() => act(() => actions.decline(req), 'Request declined')} data-testid={'button-home-decline-' + req.id}>
          Decline
        </button>
        {more > 0 && (
          <Link href="/settings/connectors#access-requests" className="oo-t2" style={{ fontSize: 12 }} data-testid="link-home-more-requests">
            {more === 1 ? '1 more request' : `${more} more requests`}
          </Link>
        )}
      </span>
    );
  } else if (open) {
    content = (
      <Link href="/settings/connectors#access-requests" style={{ color: 'inherit' }} data-testid="text-home-open-access">
        {requestItemName(open)} open to {open.client.name} until {formatTime(open.expiresAt!)}
        {access.open.length > 1 ? ` · ${access.open.length - 1} more` : ''}
      </Link>
    );
  } else if (note) {
    content = <span data-testid="text-home-access-note">{note}</span>;
  } else {
    return null;
  }
  return (
    <>
      <span aria-hidden="true" className="oo-t4">·</span>
      {content}
    </>
  );
}

function daysLabel(d: number) {
  return d <= 0 ? 'today' : d === 1 ? '1 day' : d + ' days';
}

export default function HomePage() {
  const { user } = useSession();
  const phone = useMedia(PHONE_QUERY);
  // Shorter than the app's 30 seconds: the status line carries Claude's access requests, so coming back
  // to the app re-checks them. 5 seconds still lets the start-up prefetch count.
  const home = useGetHome({ query: { queryKey: getGetHomeQueryKey(), staleTime: 5_000 } });
  const now = new Date();
  const name = user?.firstName || 'Ollie';


  const statusLine = home.data ? (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} data-testid="text-last-sweep">
        <span aria-hidden="true" className="oo-dot" data-off={!home.data.lastSweepAt} />
        {home.data.lastSweepAt ? 'Last sweep ' + sweepWhen(home.data.lastSweepAt) : 'No sweep has run yet'}
      </span>
      {home.data.connectorWarnings.length > 0 && (
        <>
          <span aria-hidden="true" className="oo-t4">·</span>
          <Link href="/settings/connectors" title={home.data.connectorWarnings.map((w) => w.text).join('\n')}
            style={{ color: 'inherit', textUnderlineOffset: 2, display: 'inline-flex', alignItems: 'center', gap: 6 }} data-testid="link-connector-warning">
            <span aria-hidden="true" className="oo-dot" data-warn="true" />
            {home.data.connectorWarnings.length === 1 ? `${home.data.connectorWarnings[0].text.split(':')[0]} needs a look` : `${home.data.connectorWarnings.length} connectors need a look`}
          </Link>
        </>
      )}
      <span aria-hidden="true" className="oo-t4">·</span>
      <span data-testid="text-inbox-new">{home.data.inbox.count} new</span>
      {home.data.knowledgeInbox.total > 0 && (
        <>
          <span aria-hidden="true" className="oo-t4">·</span>
          <Link href="/knowledge/inbox" style={{ color: 'inherit', textUnderlineOffset: 2 }} data-testid="link-knowledge-review">
            {home.data.knowledgeInbox.total} to review
          </Link>
        </>
      )}
      {home.data.digestDate && (
        <>
          <span aria-hidden="true" className="oo-t4">·</span>
          <Link href="/digest" style={{ color: 'inherit', textUnderlineOffset: 2 }} data-testid="link-digest">
            Today's digest
          </Link>
        </>
      )}
      <span aria-hidden="true" className="oo-t4">·</span>
      <Link href="/digest/week" className="oo-tap" style={{ color: 'inherit', textUnderlineOffset: 2 }} data-testid="link-roundup">
        Weekly round-up
      </Link>
      <span aria-hidden="true" className="oo-t4">·</span>
      <Link href="/digest/friday" style={{ color: 'inherit', textUnderlineOffset: 2 }} data-testid="link-friday-update">
        Friday update
      </Link>
      <AccessStatus access={home.data.access} />
    </>
  ) : (
    <span className="oo-t2">Loading your morning</span>
  );

  const header = phone ? (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <p className="oo-serif" style={{ margin: 0, fontSize: 16, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-date">{formatLong(now)}</p>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500 }} data-testid="text-greeting">{greeting(now)}, {name}</h1>
        <p role="status" className="oo-t2" style={{ margin: 0, fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{statusLine}</p>
      </div>
      <Link href="/settings" aria-label="Settings" className="oo-btn oo-btn-ghost" style={{ width: 44, padding: 0, flex: 'none' }} data-testid="link-settings-phone">
        <IconSettings />
      </Link>
    </div>
  ) : (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <p className="oo-serif" style={{ margin: 0, fontSize: 17, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-date">{formatLong(now)}</p>
      <h1 style={{ margin: 0, fontSize: 34, fontWeight: 500, letterSpacing: '-0.01em' }} data-testid="text-greeting">{greeting(now)}, {name}</h1>
      <div role="status" className="oo-status">{statusLine}</div>
    </div>
  );

  let body;
  if (home.isLoading) {
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, width: '100%' }} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="oo-dark-card oo-glass"><Skel h={12} w={90} /><Skel h={28} w="70%" /><Skel h={12} /><Skel h={36} w={140} /></div>
        ))}
      </div>
    );
  } else if (home.error || !home.data) {
    body = (
      <div className="oo-dark-card oo-glass" style={{ width: '100%', alignItems: 'flex-start' }} data-testid="state-home-error">
        <h2 className="oo-label">Could not load Home</h2>
        <p className="oo-t2" style={{ margin: 0, fontSize: 14 }}>Something went wrong reaching OllieOS.</p>
        <button type="button" className="oo-btn oo-btn-white" onClick={() => home.refetch()} data-testid="button-retry-home">Try again</button>
      </div>
    );
  } else if (phone) {
    const d = home.data;
    body = (
      <>
        <DoNextCard items={d.doNext} phone />
        <DayPlanCard phone />
        <WeekCheckCard phone />
        <Link href={d.inbox.count ? '/triage' : '/tasks?tab=inbox'} className="oo-dark-card oo-glass" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', textDecoration: 'none', padding: 16 }} data-testid="link-inbox-phone">
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="oo-label" style={{ fontSize: 12 }}>Inbox</span>
            <span className="oo-t2" style={{ fontSize: 13 }}>{breakdown(d)}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="oo-serif-roman" style={{ fontSize: 34, lineHeight: 1 }} data-testid="text-inbox-count">{d.inbox.count}</span>
            <span className="oo-btn oo-btn-white" style={{ borderRadius: 999, minHeight: 40 }}>{d.inbox.count ? 'Triage' : 'Open'}</span>
          </span>
        </Link>
        {d.slackToAnswer + d.emailToAnswer > 0 && <MessagesWaitingLink emails={d.emailToAnswer} slack={d.slackToAnswer} phone />}
        <ClearOutCard phone />
        <TodayPhone events={d.today} />
        <WaitingCard items={d.waitingOn} phone />
        <PromisesCard home={d} />
        {d.ideasDue.length > 0 && <IdeasCard home={d} />}
        <DoneCard home={d} />
        <Link href="/strategy" className="oo-dark-card oo-glass-quiet" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', textDecoration: 'none', padding: 16 }} data-testid="link-strategy-phone">
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="oo-label" style={{ fontSize: 12 }}>Strategy and ideas</span>
            <span className="oo-t2" style={{ fontSize: 13 }}>Your strategy, and ideas to come back to</span>
          </span>
          <IconArrowOut size={18} />
        </Link>
      </>
    );
  } else {
    const d = home.data;
    body = (
      <>
        <TodayStrip events={d.today} />
        <DayPlanCard />
        <WeekCheckCard />
        <ClearOutCard />
        <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, alignItems: 'stretch' }}>
          <DoNextCard items={d.doNext} />
          <section aria-labelledby="h-inbox" className="oo-dark-card oo-glass" data-testid="card-inbox">
            <h2 id="h-inbox" className="oo-label">Inbox</h2>
            <p className="oo-serif-roman" style={{ margin: 0, fontSize: 48, lineHeight: 1 }} data-testid="text-inbox-count">{d.inbox.count}</p>
            <p className="oo-t2" style={{ margin: 0, fontSize: 13 }} data-testid="text-inbox-breakdown">{breakdown(d)}</p>
            {d.slackToAnswer + d.emailToAnswer > 0 && <MessagesWaitingLink emails={d.emailToAnswer} slack={d.slackToAnswer} />}
            <div style={{ marginTop: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {d.inbox.count ? (
                <Link href="/triage" className="oo-btn oo-btn-white" data-testid="link-triage">Triage {d.inbox.count}</Link>
              ) : (
                <Link href="/tasks?tab=inbox" className="oo-btn oo-btn-white" data-testid="link-inbox">Open Inbox</Link>
              )}
            </div>
          </section>
          <WaitingCard items={d.waitingOn} />
        </div>
        <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
          <PromisesCard home={d} />
          {d.ideasDue.length > 0 && <IdeasCard home={d} />}
          <DoneCard home={d} />
        </div>
      </>
    );
  }

  return (
    <main
      className="oo-fade-in"
      style={phone
        ? { display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 40, paddingBottom: 20 }
        : { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, padding: '48px 0', maxWidth: 900, margin: '0 auto' }}
    >
      {header}
      {!phone && <div style={{ width: '100%' }}><AddBox idPrefix="home" /></div>}
      {body}
    </main>
  );
}

function DoNextCard({ items, phone = false }: { items: DoNextItem[]; phone?: boolean }) {
  const actions = useTaskActions();
  const [busy, setBusy] = useState(false);
  const top = items[0];

  if (!top) {
    return (
      <section aria-labelledby="h-next" className="oo-dark-card oo-white-card" data-testid="card-do-next">
        <h2 id="h-next" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Do next</h2>
        <p style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>Nothing queued.</p>
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Add a task or triage your Inbox and the next thing to do shows here.</p>
      </section>
    );
  }
  const t = top.task;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const done = () => run(() => actions.markDone(t));
  const later = () => run(() => actions.snooze(t));

  return (
    <section aria-labelledby="h-next" className="oo-dark-card oo-white-card" style={phone ? { padding: 16, gap: 10 } : undefined} data-testid="card-do-next">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 id="h-next" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Do next</h2>
        <span className="oo-muted oo-num" style={{ fontSize: 12 }} data-testid="text-next-position">1 of {items.length}</span>
      </div>
      <p style={{ margin: 0, fontSize: phone ? 17 : 19, fontWeight: 500, lineHeight: 1.35, letterSpacing: '-0.005em' }} data-testid="text-next-title">{t.title}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <PriorityPill priority={t.priority} />
        {t.dueDate && <span className="oo-pill">Due {formatShort(t.dueDate)}</span>}
        {t.project && <span className="oo-pill">{t.project.name}</span>}
      </div>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid="text-next-reason">{top.reason}</p>
      <div style={phone ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } : { display: 'flex', gap: 8, marginTop: 'auto', flexWrap: 'wrap' }}>
        <button type="button" className="oo-btn oo-btn-ink" onClick={done} disabled={busy} data-testid="button-next-done">Done</button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={later} disabled={busy} data-testid="button-next-snooze">{phone ? 'Snooze' : 'Snooze to tomorrow'}</button>
      </div>
    </section>
  );
}

/** Every other Monday: a nudge to go through Backlog tasks nobody has touched for 30 days. */
function ClearOutCard({ phone = false }: { phone?: boolean }) {
  const qc = useQueryClient();
  const clearOut = useGetClearOut();
  const [busy, setBusy] = useState(false);
  const d = clearOut.data;
  if (!d?.show || !d.count) return null;
  const dismiss = async () => {
    setBusy(true);
    try {
      await dismissClearOut();
      await qc.invalidateQueries({ queryKey: getGetClearOutQueryKey() });
      notify('Put off until the next clear-out', 'You can start it any time from the Backlog tab.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="h-clear-out" className="oo-dark-card oo-glass" style={{ width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: phone ? 16 : 18 }} data-testid="card-clear-out">
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <h2 id="h-clear-out" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Clear out your Backlog</h2>
        <span className="oo-t2" style={{ fontSize: 13 }} data-testid="text-clear-out-home">
          {d.count === 1 ? '1 task untouched' : `${d.count} tasks untouched`} for 30 days or more
        </span>
      </span>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link href="/clear-out" className="oo-btn oo-btn-white" data-testid="link-clear-out-start">Start</Link>
        <button type="button" className="oo-btn oo-btn-ghost" disabled={busy} onClick={dismiss} data-testid="button-clear-out-dismiss">Not this time</button>
      </span>
    </section>
  );
}

function nextEventId(events: CalendarEvent[]): number | null {
  const now = Date.now();
  return events.find((e) => new Date(e.startsAt).getTime() > now)?.id ?? null;
}

const EMPTY_CAL = 'Nothing on your calendar yet. The sweep fills this in.';

/** The time alone when the last sweep was today, otherwise the day as well. */
function sweepWhen(at: string): string {
  const label = whenLabel(at);
  return label.endsWith(' today') ? formatTime(at) : label;
}

/** Work meetings with someone or something OllieOS knows about open their brief (build plan 28). */
function BriefLink({ e, phone = false }: { e: CalendarEvent; phone?: boolean }) {
  if (!e.hasBrief) return null;
  return (
    <>
    {e.notPrepped && <span className="oo-pill" data-tone="high" style={{ fontSize: 11 }} data-testid={'pill-not-prepped-' + e.id}>Not prepped</span>}
    <Link
      href={'/briefs/' + e.id}
      className="oo-amber"
      style={{ color: 'var(--oo-accent)', fontSize: phone ? 13 : 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      aria-label={'Brief me on ' + e.title}
      data-testid={'link-brief-' + e.id}
    >
      Brief me{!phone && <IconArrowOut size={12} />}
    </Link>
    </>
  );
}

function TodayStrip({ events }: { events: CalendarEvent[] }) {
  const nextId = nextEventId(events);
  return (
    <section aria-labelledby="h-today" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-today">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, margin: '0 4px' }}>
        <h2 id="h-today" className="oo-label oo-t2" style={{ fontWeight: 500 }}>Today</h2>
        <Link href="/meetings" className="oo-t2 oo-tap" style={{ fontSize: 12, textUnderlineOffset: 2 }} data-testid="link-all-meetings">All meetings this week</Link>
      </div>
      {events.length === 0 ? (
        <div className="oo-today" data-testid="text-today-empty"><span className="oo-t2" style={{ fontSize: 13 }}>{EMPTY_CAL}</span></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {events.map((e) => (
            <div key={e.id} className="oo-today" data-next={e.id === nextId} data-testid={'card-event-' + e.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span className="oo-num oo-t2" style={{ fontSize: 12 }}>{formatTime(e.startsAt)} to {formatTime(e.endsAt)}</span>
                {e.id === nextId && <span className="oo-next-badge">Next</span>}
              </div>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{e.title}</span>
              <span className="oo-t2" style={{ fontSize: 12 }}>{e.personal ? 'Personal' : e.location ?? ''}</span>
              {e.id === nextId && <BriefLink e={e} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TodayPhone({ events }: { events: CalendarEvent[] }) {
  const nextId = nextEventId(events);
  return (
    <section aria-labelledby="h-today-p" className="oo-dark-card oo-glass" style={{ padding: 16 }} data-testid="section-today">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 id="h-today-p" className="oo-label" style={{ fontSize: 12 }}>Today</h2>
        <Link href="/meetings" className="oo-t2 oo-tap" style={{ fontSize: 13, textUnderlineOffset: 2, padding: '6px 0' }} data-testid="link-all-meetings">All meetings</Link>
      </div>
      {events.length === 0 ? (
        <p className="oo-t2" style={{ margin: 0, fontSize: 13 }} data-testid="text-today-empty">{EMPTY_CAL}</p>
      ) : events.map((e) => (
        <div key={e.id} style={{ display: 'flex', gap: 12 }} data-testid={'row-event-' + e.id}>
          <span className={'oo-num ' + (e.id === nextId ? 'oo-amber' : 'oo-t2')} style={{ flex: 'none', width: 46, fontSize: 13 }}>{formatTime(e.startsAt)}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 14, fontWeight: e.id === nextId ? 500 : 400 }}>{e.title}{e.location ? ' · ' + e.location : ''}</span>
            {e.id === nextId && <BriefLink e={e} phone />}
          </span>
        </div>
      ))}
    </section>
  );
}

function WaitingCard({ items, phone = false }: { items: WaitingItem[]; phone?: boolean }) {
  return (
    <section aria-labelledby="h-wait" className={'oo-dark-card ' + (phone ? 'oo-glass-quiet' : 'oo-glass')} style={phone ? { padding: 16, gap: 10 } : undefined} data-testid="card-waiting">
      <h2 id="h-wait" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Waiting on</h2>
      {items.length === 0 && <p className="oo-t2" style={{ margin: 0, fontSize: 13 }}>Nobody owes you anything right now.</p>}
      {items.map(({ task, daysWaiting }) => {
        const who = task.waitingOn?.name ?? task.fromName ?? 'Someone';
        const amber = daysWaiting >= WAITING_AMBER_DAYS;
        return (
          <div key={task.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }} data-testid={'row-waiting-' + task.id}>
            {!phone && <Avatar name={who} id={task.waitingOn?.id ?? who} />}
            <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: phone ? 14 : 13, fontWeight: 500 }}>
                {who} <span className={amber ? 'oo-amber' : 'oo-t3'} style={{ fontWeight: amber ? 600 : 400 }} data-testid={'text-waiting-days-' + task.id}>· {daysLabel(daysWaiting)}</span>
              </span>
              <span className="oo-t3" style={{ fontSize: 12 }}>{task.title}</span>
            </div>
            <ChaseButton task={task} who={who} />
          </div>
        );
      })}
    </section>
  );
}

function ChaseButton({ task, who }: { task: WaitingItem['task']; who: string }) {
  const actions = useTaskActions();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button type="button" className="oo-btn-chase" data-copied={copied}
      aria-label={copied ? 'Chase line copied' : 'Copy a chase line for ' + who}
      onClick={async () => { if (await actions.copyChase(task)) setCopied(true); }}
      data-testid={'button-chase-' + task.id}>
      {copied ? 'Copied' : 'Chase'}
    </button>
  );
}

function PromisesCard({ home }: { home: HomeSummary }) {
  return (
    <section aria-labelledby="h-prom" className="oo-dark-card oo-glass-quiet" style={{ gap: 10 }} data-testid="card-promises">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 id="h-prom" className="oo-label">Promises</h2>
        <span className="oo-t3" style={{ fontSize: 12 }}>Things you said you'd do</span>
      </div>
      {home.promises.length === 0 ? (
        <p className="oo-t2" style={{ margin: 0, fontSize: 13 }}>No promises logged yet</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
          {home.promises.map((p) => {
            const who = p.person?.name ?? p.fromName;
            const when = p.dueDate ?? p.capturedAt ?? p.createdAt;
            return (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }} data-testid={'row-promise-' + p.id}>
                <span style={{ minWidth: 0 }}>{p.title}</span>
                <span className="oo-t3 oo-num" style={{ flex: 'none' }}>{who ? who + ' · ' : ''}{formatShort(when)}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Ideas Ollie picked a day to come back to, from that day until he moves them on (Part H). */
function IdeasCard({ home }: { home: HomeSummary }) {
  const ideas = home.ideasDue;
  const today = todayLondon();
  return (
    <section aria-labelledby="h-ideas-due" className="oo-dark-card oo-glass-quiet" style={{ gap: 10 }} data-testid="card-ideas-due">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 id="h-ideas-due" className="oo-label">Ideas to come back to</h2>
        <span className="oo-serif-roman" style={{ fontSize: 28, lineHeight: 1 }} data-testid="text-ideas-due-count">{ideas.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
        {ideas.slice(0, 5).map((i) => (
          <Link key={i.id} href={'/strategy?idea=' + i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'inherit', textDecoration: 'none' }} data-testid={'row-idea-due-' + i.id}>
            <span style={{ minWidth: 0 }}>{i.title}</span>
            <span className="oo-t3 oo-num" style={{ flex: 'none' }}>{i.comeBackOn === today ? 'Today' : 'Since ' + formatShort(i.comeBackOn!)}</span>
          </Link>
        ))}
      </div>
      <div style={{ marginTop: 'auto' }}>
        <Link href="/strategy?tab=come_back" className="oo-btn oo-btn-white" data-testid="link-ideas-due">Open ideas</Link>
      </div>
    </section>
  );
}

function WeeklyCopyButton() {
  const actions = useTaskActions();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="oo-btn-chase" disabled={busy}
      onClick={async () => { setBusy(true); await actions.copyWeekly(); setBusy(false); }}
      data-testid="button-copy-weekly">
      Copy for weekly update
    </button>
  );
}

function DoneCard({ home }: { home: HomeSummary }) {
  const d = home.doneThisWeek;
  return (
    <section aria-labelledby="h-done" className="oo-dark-card oo-glass-quiet" style={{ gap: 10 }} data-testid="card-done">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 id="h-done" className="oo-label">Done this week</h2>
        <span className="oo-serif-roman" style={{ fontSize: 28, lineHeight: 1 }} data-testid="text-done-count">{d.count}</span>
      </div>
      {d.latest.length === 0 ? (
        <p className="oo-t2" style={{ margin: 0, fontSize: 13 }}>Nothing finished yet this week</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--oo-text-on-dark-2)' }}>
          {d.latest.map((t) => (
            <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} data-testid={'text-done-' + t.id}>
              <IconCheck size={14} className="oo-tick" />{t.title}
            </span>
          ))}
        </div>
      )}
      <div style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <WeeklyCopyButton />
        <Link href="/tasks?tab=done" className="oo-tap" style={{ fontSize: 13 }} data-testid="link-done-all">See everything done</Link>
      </div>
    </section>
  );
}

/** Messages to answer: emails and Slack messages that need a reply and have waited over a working day. */
function MessagesWaitingLink({ emails, slack, phone = false }: { emails: number; slack: number; phone?: boolean }) {
  const parts = [emails ? (emails === 1 ? '1 email' : `${emails} emails`) : '', slack ? (slack === 1 ? '1 Slack message' : `${slack} Slack messages`) : ''].filter(Boolean);
  const label = `${parts.join(' and ')} to answer`;
  const href = emails && slack ? '/messages' : emails ? '/messages?tab=to-answer&from=email' : '/messages?tab=to-answer&from=slack';
  if (phone) {
    return (
      <Link href={href} className="oo-dark-card oo-glass-quiet" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', textDecoration: 'none', padding: 16 }} data-testid="link-slack-to-answer">
        <span className="oo-t2" style={{ fontSize: 13 }}>{label}, waiting over a working day</span>
        <IconArrowOut size={18} />
      </Link>
    );
  }
  return (
    <Link href={href} className="oo-t2" style={{ fontSize: 13, color: 'inherit', textUnderlineOffset: 2 }} data-testid="link-slack-to-answer">
      {label}
    </Link>
  );
}
