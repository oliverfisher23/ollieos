import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  checkConnector,
  getGetConnectorsQueryKey,
  setConnectorReadBy,
  updateConnectorSchedule,
  useGetConnectors,
  type ConnectorRun,
  type ConnectorScheduleInput,
  type ConnectorService,
  type Connectors,
} from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { whenLabel } from '@/lib/access';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';
import { Activity, ClaudeOverview, Requests, Tools } from './settings-ai-access';
import { ClaudeSweep } from './settings-sweep';
import { LookBackPanel } from './settings-look-back';
import { DropboxCard } from './settings-dropbox';

const H1 = { margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' } as const;
const H2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;

/** What each service brings in, in Ollie's words. */
const WHAT: Record<string, string> = {
  calendar: 'Your meetings for today and the next 7 days, for the calendar strip, briefs and the digest.',
  gmail: 'Email that needs a reply or an action, promises you make by email, and replies you are waiting for. Newsletters, notifications and invites are left out.',
  slack: 'Direct messages, group DMs and @mentions: what people ask of you, what you promise and what you are waiting for.',
  drive: 'Files you open that clearly belong to a project are suggested for your Library, for you to approve. OllieOS also reads what is inside the Drive documents in your Library, so briefs and Ask OllieOS can use them, and keeps their names up to date.',
  granola: 'Notes from meetings you were in: your actions, promises and what others owe you go to your Inbox, decisions to the Knowledge Inbox, and the notes are added to the meeting brief. Colleagues\' notes from meetings you were not in are left out.',
};

/** When OllieOS reading it itself arrives, for services that are not ready yet. */
const LATER: Record<string, string> = {};

export function useConnectorsCache() {
  const qc = useQueryClient();
  return {
    put: (c: Connectors) => qc.setQueryData(getGetConnectorsQueryKey(), c),
    /** A check can change the calendar, briefs and the digest, so everything is refreshed. */
    refreshAll: () => qc.invalidateQueries(),
  };
}

export default function ConnectorsSettings() {
  // While Dropbox files are being read, refresh often enough for the progress line to move.
  const q = useGetConnectors({
    query: {
      queryKey: getGetConnectorsQueryKey(),
      refetchInterval: (query) => {
        const p = query.state.data?.dropbox.progress;
        return p && p.waiting + p.reading > 0 ? 10_000 : 60_000;
      },
    },
  });
  const c = q.data;
  const direct = c ? c.services.filter((s) => s.readBy === 'ollieos') : [];
  const readByOllieos = new Set(direct.map((s) => s.key));
  const lastCheck = c ? latestRun(c.services) : undefined;

  // Links from Home and Knowledge land on the access requests further down.
  const loaded = !!c;
  useEffect(() => {
    if (!loaded || !window.location.hash) return;
    const t = setTimeout(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [loaded]);

  const stats: [string, string | undefined, string][] = [
    ['Read by OllieOS', c ? `${direct.length} of ${c.services.length}` : undefined, 'direct'],
    ['Last check', c ? (lastCheck ? whenLabel(lastCheck.startedAt) : 'Not yet') : undefined, 'last'],
    ['Next check', c ? (c.schedule.nextRunAt ? nextLabel(c.schedule.nextRunAt) : 'Timer off') : undefined, 'next'],
  ];

  return (
    <>
      <section className="oo-panel flex flex-col gap-1.5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="con-h" data-testid="page-settings-connectors">
        <h1 id="con-h" style={H1}>Connectors</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          Where OllieOS gets your work from. Services OllieOS reads itself are checked on a timer and no longer wait for Claude. Everything else still comes in through the Claude sweep.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ marginTop: 14 }}>
          {stats.map(([label, value, id]) => (
            <div key={id} className="oo-stat" style={{ alignItems: 'flex-start', padding: 18, gap: 8 }} data-testid={'stat-connectors-' + id}>
              <span style={{ fontSize: 13 }}>{label}</span>
              {value === undefined ? <Skel h={28} w={90} /> : <span className="oo-num" style={{ fontSize: 20, fontWeight: 500, lineHeight: '30px' }}>{value}</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="oo-panel flex flex-col gap-3 px-5 py-6 sm:px-8" aria-labelledby="con-services-h">
        <h2 id="con-services-h" style={H2}>Services</h2>
        {q.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[0, 1, 2].map((i) => <Skel key={i} h={88} />)}
          </div>
        ) : q.error || !c ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-connectors-error">
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load your connectors.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()} data-testid="button-retry-connectors">Try again</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {c.services.map((s) => (s.key === 'dropbox' ? <DropboxCard key={s.key} s={s} setup={c.dropbox} /> : <ServiceCard key={s.key} s={s} />))}
          </div>
        )}
      </section>

      {c && <ScheduleCard c={c} />}

      <ClaudeOverview />
      <Requests />
      <Tools />
      <ClaudeSweep readByOllieos={readByOllieos} />
      <Activity />
    </>
  );
}

function latestRun(services: ConnectorService[]): ConnectorRun | null {
  let best: ConnectorRun | null = null;
  for (const s of services) for (const r of s.runs) if (!best || r.startedAt > best.startedAt) best = r;
  return best;
}

/** "Due now" when the timer is about to run, otherwise "10:30 today". */
function nextLabel(at: string): string {
  return new Date(at).getTime() - Date.now() < 90_000 ? 'Due now' : whenLabel(at);
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

/** Sorting by AI uses a small model; it is said once, on the cards it applies to. */
const SORTED_BY_AI: Record<string, string> = {
  gmail: 'Read-only. Messages are sorted by Claude Haiku through Replit, billed to your Replit credits. Everything lands in your Inbox for you to triage.',
  slack: 'Read-only. Messages are sorted by Claude Haiku through Replit, billed to your Replit credits. Everything lands in your Inbox for you to triage.',
  drive: 'Read-only. Files are matched to projects by Claude Haiku through Replit, billed to your Replit credits. Files in confidential projects are never sent to it, and nothing joins your Library until you approve it.',
  granola: 'Read-only. Notes are sorted by Claude Haiku through Replit, billed to your Replit credits. Everything lands in your Inbox and Knowledge Inbox for you to triage.',
};

/** What a check found, in words: one line per run. */
export function runLine(key: string, r: ConnectorRun): string {
  if (!r.ok) return r.error ?? (r.finishedAt ? 'The check failed.' : 'Still running, or stopped early.');
  const c = r.counts;
  if (key === 'calendar') {
    const out = c.left_out ?? 0;
    return `Found ${plural(r.found, 'event')}: kept ${plural(c.kept ?? 0, 'meeting')}${out ? `, left out ${out} (all-day, declined or not a meeting)` : ''}.`;
  }
  if (key === 'drive') {
    const parts = [
      c.suggested ? `${plural(c.suggested, 'file')} suggested for your Library` : 'nothing new to suggest',
      c.read ? `read ${plural(c.read, 'Library document')}` : '',
      c.missing ? `${plural(c.missing, 'Library link')} Drive could not open` : '',
      c.changed ? `${plural(c.changed, 'document')} changed by someone else, for your digest` : '',
    ].filter(Boolean);
    return `Looked at ${plural(c.recent ?? r.found, 'file')} you opened: ${parts.join(', ')}.`;
  }
  if (key === 'dropbox') {
    if (!c.files && !r.found) return 'No folder chosen yet, or the folder is empty.';
    const parts = [
      c.added ? `${c.added} new` : '',
      c.changed ? `${c.changed} changed` : '',
      c.removed ? `${c.removed} removed` : '',
    ].filter(Boolean);
    const queued = c.queued ? ` ${plural(c.queued, 'file')} queued to read for knowledge.` : '';
    const out = c.left_out ? ` ${c.left_out} of other kinds left alone.` : '';
    return `Looked at ${plural(c.files ?? r.found, 'file')}: ${parts.length ? parts.join(', ') : 'nothing new or changed'}.${queued}${out}`;
  }
  if (key === 'granola') {
    const added = (c.inbox ?? 0) + (c.promises ?? 0) + (c.waiting ?? 0);
    const parts = [
      added ? `${added} to your Inbox` : 'nothing new for your Inbox',
      c.decisions ? `${plural(c.decisions, 'decision')} to the Knowledge Inbox` : '',
      c.attached ? `notes added to ${plural(c.attached, 'brief')}` : '',
      c.looks_done ? `${plural(c.looks_done, 'task')} that looks done` : '',
      c.left_out ? `${c.left_out} left out (meetings you were not in)` : '',
    ].filter(Boolean);
    const more = c.more ? ' More is waiting; the next check carries on.' : '';
    return `Read ${plural(r.found, 'new note')}, ${c.meetings ?? 0} from your meetings: ${parts.join(', ')}.${more}`;
  }
  const noun = key === 'gmail' ? 'email' : 'message';
  const added = (c.inbox ?? 0) + (c.promises ?? 0) + (c.waiting ?? 0);
  const parts = [
    added
      ? `${added} to your Inbox${c.promises || c.waiting ? ` (${[c.promises ? plural(c.promises, 'promise') : '', c.waiting ? `${c.waiting} waiting on` : ''].filter(Boolean).join(', ')})` : ''}`
      : 'nothing new for your Inbox',
    c.noise ? `${c.noise} to Noise` : '',
    c.noise_rule ? `${c.noise_rule} skipped by your noise rules` : '',
    c.left_out ? `${c.left_out} left out (${key === 'gmail' ? 'newsletters, notifications and invites' : 'bots and system messages'})` : '',
    c.no_reply_found ? `${plural(c.no_reply_found, 'unanswered email')} to Email, Waiting for a reply` : '',
    c.drafts_sent ? `${plural(c.drafts_sent, 'draft')} sent, so off your Drafts list` : '',
    c.no_reply_failed ? 'Waiting for a reply could not be updated; the next check tries again' : '',
    c.to_answer ? `${plural(c.to_answer, 'conversation')} to Email, Slack` : '',
    c.closed ? `${plural(c.closed, 'task')} marked done from your replies` : '',
    c.looks_done ? `${plural(c.looks_done, 'task')} that looks done` : '',
    c.answered ? `${c.answered} answered, so off Email, Slack` : '',
  ].filter(Boolean);
  const more = c.more ? ' More is waiting; the next check carries on.' : '';
  return `Read ${plural(r.found, noun)}: ${parts.join(', ')}.${more}`;
}

/** The toast after Check now. */
function checkedLine(key: string, found: number): string {
  if (key === 'calendar') return `Found ${plural(found, 'event')}.`;
  if (key === 'drive') return `Looked at ${plural(found, 'file')} you opened. Suggestions are in your Knowledge Inbox.`;
  if (key === 'granola') return `Read ${plural(found, 'new note')}. New items are in your Inbox.`;
  return `Read ${plural(found, key === 'gmail' ? 'email' : 'message')}. New items are in your Inbox.`;
}

/** A failure the next check usually gets past by itself: the service could not be reached, or a restart cut the check off. */
function passing(r: ConnectorRun | undefined): boolean {
  return !!r && !r.ok && /^(Could not reach|Stopped when OllieOS restarted|.* is already being checked|.* asked OllieOS to slow down)/.test(r.error ?? '');
}

/** One brief failure after a good check is not worth Ollie's attention; two in a row are. */
function onlyABlip(s: ConnectorService): boolean {
  const [last, before] = s.runs;
  return passing(last) && (!before || before.ok);
}

function status(s: ConnectorService): { label: string; tone?: string } {
  if (!s.canReadDirect) return { label: 'Read by Claude' };
  const last = s.runs[0];
  if (s.readBy === 'claude') return { label: 'Read by Claude', tone: 'waiting' };
  if (!last) return { label: 'First check due' , tone: 'waiting' };
  if (!last.ok && onlyABlip(s)) return { label: 'Will try again', tone: 'waiting' };
  if (!last.ok) return { label: 'Needs attention', tone: 'high' };
  return { label: 'Working', tone: 'done' };
}

function ServiceCard({ s }: { s: ConnectorService }) {
  const cache = useConnectorsCache();
  const [busy, setBusy] = useState<'check' | 'switch' | null>(null);
  const st = status(s);
  const last = s.runs[0];
  const direct = s.readBy === 'ollieos';

  const check = async () => {
    setBusy('check');
    try {
      const r = await checkConnector(s.key);
      if (r.ok) notify(`${s.name} checked`, checkedLine(s.key, r.found));
      else notify(`${s.name} check failed`, r.error ?? 'Something went wrong.');
    } catch (err) {
      reportApiError(err);
      notify('That check did not run', errorMessage(err));
    } finally {
      await cache.refreshAll();
      setBusy(null);
    }
  };

  const switchReader = async () => {
    const next = direct ? 'claude' : 'ollieos';
    setBusy('switch');
    try {
      cache.put(await setConnectorReadBy(s.key, { readBy: next }));
      notify(next === 'ollieos' ? `OllieOS reads ${s.name} now` : `Claude reads ${s.name} again`,
        next === 'ollieos' ? 'Anything Claude sends for it is ignored from now on.' : 'OllieOS stops checking it on the timer.');
      setBusy(null);
      if (next === 'ollieos') await check();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <article className="oo-source" style={{ gap: 10, padding: '16px 18px' }} aria-labelledby={'con-' + s.key + '-h'} data-testid={'card-connector-' + s.key}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 id={'con-' + s.key + '-h'} style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{s.name}</h3>
        <span className="oo-pill" data-tone={st.tone} data-testid={'status-connector-' + s.key}>{st.label}</span>
        {s.account && <span className="oo-muted" style={{ fontSize: 13 }} data-testid={'text-connector-account-' + s.key}>{s.account}</span>}
      </div>
      <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{WHAT[s.key]}</p>
      {s.canReadDirect && SORTED_BY_AI[s.key] && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }} data-testid={'text-connector-ai-' + s.key}>
          {SORTED_BY_AI[s.key]}
        </p>
      )}

      {s.canReadDirect ? (
        <>
          {direct && last && (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: last.ok ? undefined : 'var(--oo-danger)' }} data-testid={'text-connector-last-' + s.key}>
              <span className="oo-muted">Last check {whenLabel(last.startedAt)}{last.trigger === 'manual' ? ' (by you)' : ''}: </span>
              {runLine(s.key, last)}
            </p>
          )}
          {direct && last && !last.ok && (
            <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid={'text-connector-fix-' + s.key}>
              {onlyABlip(s)
                ? 'Usually brief. The next check will try again, or press Check now.'
                : `If this keeps happening, reconnect ${s.name} in Replit under Integrations, then press Check now.`}
            </p>
          )}
          {direct && s.warning && (
            <div className="oo-source" style={{ gap: 4 }} role="status" data-testid={'text-connector-warning-' + s.key}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Needs a look</span>
              <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>{s.warning}</span>
            </div>
          )}
          {direct && !last && (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Not checked yet. Press Check now, or wait for the timer.</p>
          )}
          {!direct && s.key === 'granola' && !s.chosen && last && (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid="text-connector-granola-waiting">
              OllieOS last checked Granola {whenLabel(last.startedAt)}: {runLine(s.key, last)} It takes over from Claude once it finds notes from one of your own meetings.
            </p>
          )}
          {!direct && (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              Claude reads this through the sweep{s.lastFromClaudeAt ? `, last at ${whenLabel(s.lastFromClaudeAt)}` : ''}. OllieOS can read it itself: switch it on below.
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <button type="button" role="switch" className="oo-switch" aria-checked={direct} disabled={busy !== null}
                onClick={switchReader} data-testid={'switch-connector-' + s.key} />
              <span>{direct ? 'Read by OllieOS' : 'Read by Claude'}</span>
            </label>
            {direct && (
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={check} data-testid={'button-check-' + s.key}>
                {busy === 'check' ? 'Checking…' : 'Check now'}
              </button>
            )}
          </div>
          {direct && s.runs.length > 1 && <RecentRuns runs={s.runs} keyName={s.key} />}
          {s.key === 'granola' && <LookBackPanel />}
        </>
      ) : (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid={'text-connector-later-' + s.key}>
          {s.lastFromClaudeAt ? `Last from Claude ${whenLabel(s.lastFromClaudeAt)}. ` : 'Nothing from Claude yet. '}
          {LATER[s.key]}
        </p>
      )}
    </article>
  );
}

export function RecentRuns({ runs, keyName }: { runs: ConnectorRun[]; keyName: string }) {
  return (
    <details data-testid={'details-runs-' + keyName}>
      <summary className="oo-soft" style={{ fontSize: 13, cursor: 'pointer' }}>Recent checks</summary>
      <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {runs.map((r) => (
          <li key={r.id} style={{ fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span className="oo-num oo-muted" style={{ flex: '0 0 120px' }}>{whenLabel(r.startedAt)}</span>
            <span style={{ flex: '1 1 240px', color: r.ok ? undefined : 'var(--oo-danger)' }}>{runLine(keyName, r)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ScheduleCard({ c }: { c: Connectors }) {
  const cache = useConnectorsCache();
  const sch = c.schedule;
  const [start, setStart] = useState(sch.start);
  const [end, setEnd] = useState(sch.end);
  const [busy, setBusy] = useState(false);
  useEffect(() => setStart(sch.start), [sch.start]);
  useEffect(() => setEnd(sch.end), [sch.end]);
  const changed = start !== sch.start || end !== sch.end;

  const save = async (patch: ConnectorScheduleInput, done: string) => {
    setBusy(true);
    try {
      cache.put(await updateConnectorSchedule(patch));
      notify(done);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="oo-panel flex flex-col gap-3 px-5 py-6 sm:px-8" aria-labelledby="con-sch-h" data-testid="panel-connector-schedule">
      <h2 id="con-sch-h" style={H2}>When OllieOS checks</h2>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 14 }}>
        <span>
          Check on a timer
          <span className="oo-muted" style={{ display: 'block', fontSize: 12 }}>Weekdays only, London time. Check now on a service still works when this is off.</span>
        </span>
        <button type="button" role="switch" className="oo-switch" aria-checked={sch.enabled} disabled={busy}
          onClick={() => save({ enabled: !sch.enabled }, sch.enabled ? 'Timed checks off' : 'Timed checks on')} data-testid="switch-connector-timer" />
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="oo-field-label" id="con-every-l">How often</span>
        <div role="group" aria-labelledby="con-every-l" className="oo-seg" style={{ maxWidth: 360 }}>
          {([30, 60] as const).map((m) => (
            <button key={m} type="button" aria-pressed={sch.everyMinutes === m} disabled={busy}
              onClick={() => sch.everyMinutes !== m && save({ everyMinutes: m }, m === 30 ? 'Checking every 30 minutes' : 'Checking every hour')}
              data-testid={'button-every-' + m}>
              {m === 30 ? 'Every 30 minutes' : 'Every hour'}
            </button>
          ))}
        </div>
      </div>

      <form
        style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) void save({ start, end }, `Checking between ${start} and ${end}`);
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span className="oo-field-label">From</span>
          <input type="time" className="oo-input" style={{ width: 130 }} value={start} required onChange={(e) => setStart(e.target.value)} data-testid="input-connector-start" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span className="oo-field-label">Until</span>
          <input type="time" className="oo-input" style={{ width: 130 }} value={end} required onChange={(e) => setEnd(e.target.value)} data-testid="input-connector-end" />
        </label>
        <button type="submit" className="oo-btn oo-btn-ink" disabled={!changed || busy} data-testid="button-save-window">Save times</button>
      </form>

      <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.6, maxWidth: '70ch' }} data-testid="text-connector-next">
        {!sch.nextRunAt ? 'Timed checks are off.' : nextLabel(sch.nextRunAt) === 'Due now' ? 'The next check is due now.' : `Next check ${nextLabel(sch.nextRunAt)}.`}{' '}
        Checks only happen while OllieOS is running, so the published app needs to stay switched on all the time. After each check OllieOS refreshes your meeting briefs, and from 07:40 it writes the day's digest.
      </p>
    </section>
  );
}
