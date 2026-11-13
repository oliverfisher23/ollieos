import { useEffect, useState, type ReactNode } from 'react';
import { TasksPage } from '@/routes';
import { BusyDayLines, WeekCheckLine } from '@/components/time-and-meetings';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  dismissClearOut,
  getGetClearOutQueryKey,
  getGetHomeQueryKey,
  getGetMessageCountsQueryKey,
  useGetClearOut,
  useGetHome,
  useGetMessageCounts,
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
import { IconArrowOut, IconCheck, IconDown, IconLock, IconRight, IconSearch, IconSettings } from '@/components/icons';
import { openCommandBar } from '@/lib/command-bar';
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
  return d <= 0 ? 'Asked today' : d === 1 ? 'Waiting 1 day' : `Waiting ${d} days`;
}

export default function HomePage() {
  const { user } = useSession();
  // Tasks is its own file; fetch it once Home is up, so opening Tasks stays instant.
  useEffect(() => {
    const t = window.setTimeout(() => void TasksPage.preload().catch(() => {}), 1500);
    return () => window.clearTimeout(t);
  }, []);
  const phone = useMedia(PHONE_QUERY);
  // Shorter than the app's 30 seconds: the status line carries Claude's access requests, so coming back
  // to the app re-checks them. 5 seconds still lets the start-up prefetch count.
  // A brief hiccup (the server restarting, a dropped connection) is retried quietly, with growing waits,
  // before Home says it could not load; what is already on screen stays while it retries.
  const home = useGetHome({
    query: {
      queryKey: getGetHomeQueryKey(),
      staleTime: 5_000,
      retry: (count, err) => (err as { status?: number } | null)?.status !== 401 && (err as { status?: number } | null)?.status !== 403 && count < 4,
      retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
    },
  });
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
      <Link href="/digest" style={{ color: 'inherit', textUnderlineOffset: 2 }} data-testid="link-updates">
        Updates
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
      <span style={{ display: 'flex', gap: 8, flex: 'none' }}>
        <button type="button" aria-label="Search, add or go to a page" className="oo-btn oo-btn-ghost" style={{ width: 44, padding: 0 }} onClick={openCommandBar} data-testid="button-search-phone">
          <IconSearch size={18} />
        </button>
        <Link href="/settings" aria-label="Settings" className="oo-btn oo-btn-ghost" style={{ width: 44, padding: 0 }} data-testid="link-settings-phone">
          <IconSettings />
        </Link>
      </span>
    </div>
  ) : (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <p className="oo-serif" style={{ margin: 0, fontSize: 17, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-date">{formatLong(now)}</p>
      <h1 style={{ margin: 0, fontSize: 34, fontWeight: 500, letterSpacing: '-0.01em' }} data-testid="text-greeting">{greeting(now)}, {name}</h1>
      <div role="status" className="oo-status">{statusLine}</div>
    </div>
  );

  let body;
  if (home.isLoading || (!home.data && home.isFetching)) {
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, width: '100%' }} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="oo-dark-card oo-glass"><Skel h={12} w={90} /><Skel h={28} w="70%" /><Skel h={12} /><Skel h={36} w={140} /></div>
        ))}
      </div>
    );
  } else if (!home.data) {
    body = (
      <div className="oo-dark-card oo-glass" style={{ width: '100%', alignItems: 'flex-start' }} data-testid="state-home-error">
        <h2 className="oo-label">Could not load Home</h2>
        <p className="oo-t2" style={{ margin: 0, fontSize: 14 }}>Something went wrong reaching OllieOS.</p>
        <button type="button" className="oo-btn oo-btn-white" onClick={() => home.refetch()} data-testid="button-retry-home">Try again</button>
      </div>
    );
  } else {
    // Section 30, Part B: the queue first (next meeting, do next, to answer, triage), then anything
    // worth a line, and the rest of the day behind "More today".
    const d = home.data;
    body = phone ? (
      <>
        <DoNextCard items={d.doNext} phone />
        <NextMeeting events={d.today} phone />
        <QueueCard home={d} phone />
        <Notices />
        <MoreToday home={d} phone>
          <TodayPhone events={d.today} />
          <DayPlanCard phone />
          <WaitingCard items={d.waitingOn} phone />
          <PromisesCard home={d} />
          {d.ideasDue.length > 0 && <IdeasCard home={d} />}
          <DoneCard home={d} />
        </MoreToday>
      </>
    ) : (
      <>
        <NextMeeting events={d.today} />
        <div className="oo-home-grid">
          <DoNextCard items={d.doNext} />
          <QueueCard home={d} />
        </div>
        <Notices />
        <MoreToday home={d}>
          <TodayStrip events={d.today} />
          <DayPlanCard />
          <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
            <WaitingCard items={d.waitingOn} />
            <PromisesCard home={d} />
            {d.ideasDue.length > 0 && <IdeasCard home={d} />}
            <DoneCard home={d} />
          </div>
        </MoreToday>
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
      <p style={{ margin: 0, fontSize: phone ? 17 : 21, fontWeight: 500, lineHeight: 1.3, letterSpacing: '-0.01em' }}>
        <Link href={'/tasks?task=' + t.id} className="oo-next-title" data-testid="text-next-title">{t.title}</Link>
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <PriorityPill priority={t.priority} />
        {t.dueDate && <span className="oo-pill">Due {formatShort(t.dueDate)}</span>}
        {t.project && <span className="oo-pill">{t.project.name}</span>}
      </div>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid="text-next-reason">{top.reason}</p>
      <div style={phone ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } : { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" className="oo-btn oo-btn-ink" onClick={done} disabled={busy} data-testid="button-next-done">Done</button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={later} disabled={busy} data-testid="button-next-snooze">{phone ? 'Snooze' : 'Snooze to tomorrow'}</button>
      </div>
      <AfterThat items={items.slice(1)} phone={phone} />
    </section>
  );
}

/** The rest of the Do next queue under the top task, so the card shows what is coming without leaving Home. */
function AfterThat({ items, phone }: { items: DoNextItem[]; phone: boolean }) {
  if (!items.length) return null;
  const shown = items.slice(0, phone ? 2 : 5);
  const more = items.length - shown.length;
  return (
    <div className="oo-next-after" style={phone ? { paddingTop: 10 } : undefined} data-testid="list-next-after">
      <div className="oo-next-after-head">
        <h3>After that</h3>
        <Link href="/tasks?tab=open" className="oo-tap" data-testid="link-next-all">{more > 0 ? `${more} more in Tasks` : 'All open tasks'}</Link>
      </div>
      <ol className="oo-next-list">
        {shown.map(({ task }, i) => (
          <li key={task.id}>
            <Link href={'/tasks?task=' + task.id} className="oo-next-row" data-testid={'link-next-after-' + task.id}>
              <span className="oo-next-pos oo-num" aria-hidden="true">{i + 2}</span>
              <span className="oo-next-name">{task.title}</span>
              {task.dueDate ? (
                <span className="oo-next-meta oo-num" data-high={task.priority === 'high'}>{formatShort(task.dueDate)}</span>
              ) : task.priority === 'high' ? (
                <span className="oo-next-meta" data-high="true">High</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What is waiting on Ollie, one row each: messages to answer, the Inbox to triage and, when there are
 * any, Knowledge Inbox cards to review. Each row is one tap to the place it is dealt with.
 */
function QueueCard({ home: d, phone = false }: { home: HomeSummary; phone?: boolean }) {
  // The same count as the Messages badge, so Home and the rail never disagree.
  const counts = useGetMessageCounts({ query: { queryKey: getGetMessageCountsQueryKey(), refetchInterval: 120_000, staleTime: 60_000, retry: false } });
  const toAnswer = counts.data?.needsReply ?? 0;
  const late = d.emailToAnswer + d.slackToAnswer;
  const review = d.knowledgeInbox.total;
  return (
    <section aria-labelledby="h-queue" className="oo-dark-card oo-glass" style={phone ? { padding: 16 } : undefined} data-testid="card-queue">
      <h2 id="h-queue" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Waiting on you</h2>
      <ul className="oo-queue">
        <QueueRow
          href="/messages"
          count={counts.data ? toAnswer : null}
          label="To answer"
          line={counts.data && toAnswer === 0 ? 'Nothing to answer' : late > 0 ? `${late} waiting over a working day` : 'Emails and Slack messages'}
          amber={late > 0}
          testId="messages"
        />
        <QueueRow
          href={d.inbox.count ? '/triage' : '/tasks?tab=inbox'}
          count={d.inbox.count}
          label="Triage"
          line={breakdown(d)}
          testId="inbox"
        />
        {review > 0 && (
          <QueueRow href="/knowledge/inbox" count={review} label="To review" line="Knowledge Inbox cards" testId="knowledge" />
        )}
      </ul>
    </section>
  );
}

function QueueRow({ href, count, label, line, amber = false, testId }: { href: string; count: number | null; label: string; line: string; amber?: boolean; testId: string }) {
  const clear = count === 0;
  return (
    <li>
      <Link href={href} className="oo-queue-row" aria-label={`${label}: ${count ?? ''} ${line}`} data-testid={'link-queue-' + testId}>
        <span className="oo-serif-roman oo-queue-count oo-num" data-clear={clear} data-testid={'text-queue-count-' + testId}>{count ?? ''}</span>
        <span className="oo-queue-text">
          <span className="oo-queue-label">{label}</span>
          <span className={amber ? 'oo-amber' : 'oo-t2'} style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }} data-testid={'text-queue-line-' + testId}>
            {clear && <IconCheck size={14} className="oo-tick" />}
            {line}
          </span>
        </span>
        <IconRight size={16} className="oo-queue-chev" />
      </Link>
    </li>
  );
}

/** Lines under the queue, each shown only when it has something to say: overdue, a full day, a week that does not fit, the Backlog clear-out. */
function Notices() {
  return (
    <ul className="oo-notices" data-testid="list-notices">
      <BusyDayLines />
      <WeekCheckLine />
      <ClearOutLine />
    </ul>
  );
}

/** Every other Monday: a nudge to go through Backlog tasks nobody has touched for 30 days. */
function ClearOutLine() {
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
    <li className="oo-notice" data-testid="card-clear-out">
      <span data-testid="text-clear-out-home">
        {d.count === 1 ? '1 Backlog task untouched' : `${d.count} Backlog tasks untouched`} for 30 days or more.
      </span>
      <Link href="/clear-out" data-testid="link-clear-out-start">Clear out</Link>
      <button type="button" disabled={busy} onClick={dismiss} data-testid="button-clear-out-dismiss">Not this time</button>
    </li>
  );
}

const MORE_KEY = 'oo-home-more';

/** The rest of the day, closed until asked for and remembered on this device. The heading says what is inside. */
function MoreToday({ home: d, phone = false, children }: { home: HomeSummary; phone?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(MORE_KEY) === 'open';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(MORE_KEY, next ? 'open' : 'closed');
    } catch {
      // Private windows may refuse storage; the fold still works for this visit.
    }
  };
  const inside = [
    d.today.length ? (d.today.length === 1 ? '1 meeting' : `${d.today.length} meetings`) : '',
    d.waitingOn.length ? `${d.waitingOn.length} waiting on others` : '',
    d.promises.length ? (d.promises.length === 1 ? '1 promise' : `${d.promises.length} promises`) : '',
    d.ideasDue.length ? (d.ideasDue.length === 1 ? '1 idea to come back to' : `${d.ideasDue.length} ideas to come back to`) : '',
    `${d.doneThisWeek.count} done this week`,
  ].filter(Boolean).join(' · ');
  return (
    <section aria-labelledby="h-more" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: phone ? 14 : 22 }} data-testid="section-more-today">
      <h2 id="h-more" style={{ margin: 0 }}>
        <button type="button" className="oo-more-toggle" aria-expanded={open} aria-controls="more-today" onClick={toggle} data-testid="button-more-today">
          <span className="oo-label">More today</span>
          <span className="oo-t2 oo-more-inside" data-testid="text-more-inside">{inside}</span>
          <IconDown size={16} className="oo-more-chev" />
        </button>
      </h2>
      {open && (
        <div id="more-today" className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: phone ? 14 : 22, width: '100%' }}>
          {children}
        </div>
      )}
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
  if (e.personal) return null;
  // No brief (nobody on it is in Contacts): its own page, for the agenda.
  if (!e.hasBrief) {
    return (
      <Link href={'/meetings/' + e.id} style={{ color: 'inherit', opacity: 0.75, fontSize: phone ? 13 : 12, textUnderlineOffset: 2 }} aria-label={'Agenda for ' + e.title} data-testid={'link-meeting-' + e.id}>
        Agenda
      </Link>
    );
  }
  return (
    <>
    {e.notPrepped && <span className="oo-pill" data-tone="high" style={{ fontSize: 11, alignSelf: 'flex-start' }} data-testid={'pill-not-prepped-' + e.id}>Not prepped</span>}
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

/** The next meeting today on one line, with its prep link; the full day is under More today. */
function NextMeeting({ events, phone = false }: { events: CalendarEvent[]; phone?: boolean }) {
  const nextId = nextEventId(events);
  const e = events.find((x) => x.id === nextId);
  const after = e ? events.filter((x) => new Date(x.startsAt).getTime() > new Date(e.startsAt).getTime()) : [];
  const unprepped = after.filter((x) => x.notPrepped).length;
  const rest = after.length ? `${after.length} more today${unprepped ? `, ${unprepped} not prepped` : ''}` : 'All meetings';
  return (
    <section aria-label="Next meeting" className="oo-today oo-next-meeting" data-next={!!e} style={phone ? { padding: '14px 16px' } : undefined} data-testid="section-next-meeting">
      {e ? (
        <>
          <span className="oo-next-badge">Next</span>
          <span className="oo-num oo-t2" style={{ fontSize: 13, flex: 'none' }}>{formatTime(e.startsAt)} to {formatTime(e.endsAt)}</span>
          <span style={{ fontSize: 14, fontWeight: 500, minWidth: 0, flex: '1 1 160px' }} data-testid="text-next-meeting">{e.title}</span>
          <BriefLink e={e} phone={phone} />
        </>
      ) : (
        <span className="oo-t2" style={{ fontSize: 13, flex: '1 1 160px' }} data-testid="text-next-meeting-none">
          {events.length === 0 ? EMPTY_CAL : 'No more meetings today.'}
        </span>
      )}
      <Link href="/meetings" className="oo-t2 oo-tap" style={{ fontSize: 12, textUnderlineOffset: 2, flex: 'none' }} data-testid="link-next-meetings">{e ? rest : 'All meetings'}</Link>
    </section>
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

/** Rows shown before "See all": the rest are one tap away on the Waiting on tab. */
const WAITING_SHOWN = 6;

/**
 * Who the task waits on. A task captured from Ollie's own message carries fromName "You", which is the
 * asker, not the person who owes the reply, so it is left out rather than shown as "You".
 */
function waitingWho(task: WaitingItem['task']): string | null {
  if (task.waitingOn?.name) return task.waitingOn.name;
  const from = task.fromName?.trim();
  return from && from !== 'You' ? from : null;
}

function WaitingCard({ items, phone = false }: { items: WaitingItem[]; phone?: boolean }) {
  // Longest wait first, so the ones worth chasing sit at the top.
  const sorted = [...items].sort((a, b) => b.daysWaiting - a.daysWaiting);
  const shown = sorted.slice(0, WAITING_SHOWN);
  return (
    <section aria-labelledby="h-wait" className={'oo-dark-card ' + (phone ? 'oo-glass-quiet' : 'oo-glass')} style={{ flex: '1 1 auto', ...(phone ? { padding: 16, gap: 10 } : {}) }} data-testid="card-waiting">
      <div className="oo-card-head">
        <h2 id="h-wait" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>
          Waiting on{items.length > 0 && <span className="oo-t4 oo-num" style={{ marginLeft: 8, fontWeight: 400 }}>{items.length}</span>}
        </h2>
        {items.length > shown.length && (
          <Link href="/tasks?tab=waiting" className="oo-tap" data-testid="link-waiting-all">See all {items.length}</Link>
        )}
      </div>
      {items.length === 0 ? (
        <p className="oo-t2" style={{ margin: 0, fontSize: 13 }}>Nobody owes you anything right now.</p>
      ) : (
        <ul className="oo-wait-list">
          {shown.map(({ task, daysWaiting }) => {
            const who = waitingWho(task);
            const amber = daysWaiting >= WAITING_AMBER_DAYS;
            return (
              <li key={task.id} className="oo-wait-row" data-testid={'row-waiting-' + task.id}>
                {who ? <Avatar name={who} id={task.waitingOn?.id ?? who} /> : <span aria-hidden="true" className="oo-wait-mark" />}
                <span className="oo-wait-body">
                  <Link href={'/tasks?task=' + task.id} className="oo-wait-title oo-tap">{task.title}</Link>
                  <span className="oo-wait-meta">
                    {who && <>{who} · </>}
                    <span className={amber ? 'oo-amber' : undefined} data-testid={'text-waiting-days-' + task.id}>{daysLabel(daysWaiting)}</span>
                  </span>
                </span>
                <ChaseButton task={task} who={who ?? task.title} />
              </li>
            );
          })}
        </ul>
      )}
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
