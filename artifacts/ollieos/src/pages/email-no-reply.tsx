import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  getGetNoReplyScanQueryKey,
  getListReviewQueryKey,
  resumeNoReplyScan,
  setReviewExpectedBy,
  startNoReplyScan,
  stopNoReplyScan,
  useGetNoReplyScan,
  useListReview,
  type NoReplyScan,
  type ReviewDecideInputAction,
  type ReviewItem,
} from '@workspace/api-client-react';
import { formatLong, formatShort, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { dayChoices } from '@/components/later-picker';
import { PageProblem } from '@/components/knowledge/parts';
import { ReplyDraftCard } from '@/components/reply-draft';
import { NOBODY, OWN, WaitingPicker } from '@/components/waiting-picker';
import { whenLabel } from '@/lib/access';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';
import { n, useReviewDecide } from '@/lib/review';

type Action = ReviewDecideInputAction;

const BUTTONS: { action: Action; label: string; testId: string }[] = [
  { action: 'waiting', label: 'Chase…', testId: 'chase' },
  { action: 'done', label: 'Already handled', testId: 'handled' },
  { action: 'dropped', label: 'Dropped', testId: 'dropped' },
];

function doneLine(action: Action, count: number): string {
  if (action === 'waiting') return count === 1 ? 'Added to Waiting on' : `${n(count, 'message')} added to Waiting on`;
  if (action === 'done') return count === 1 ? 'Marked as handled' : `${n(count, 'message')} marked as handled`;
  return count === 1 ? 'Dropped' : `${n(count, 'message')} dropped`;
}

const DAY = 86_400_000;

function waitingFor(at: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / DAY));
  return days === 0 ? 'Sent today' : `No reply for ${n(days, 'day')}`;
}

/** What the look through found, in one or two plain sentences. */
function foundLine(s: NoReplyScan): string {
  const c = s.counts;
  const parts = [`Found ${n(c.found, 'unanswered email')} that asked for something, from ${n(c.threads, 'sent thread')}.`];
  const skipped: string[] = [];
  if (c.answered) skipped.push(`${c.answered} that got a reply`);
  if (c.left_out) skipped.push(`${c.left_out} newsletters, automated emails, invites and thank-yous`);
  if (c.checked - c.found > 0) skipped.push(`${c.checked - c.found} that did not need an answer`);
  if (c.already) skipped.push(`${c.already} already on your lists`);
  if (skipped.length) parts.push(`Left out ${skipped.join(', ')}.`);
  if (c.failed) parts.push(`${n(c.failed, 'email')} could not be checked; the next Gmail check tries again.`);
  return parts.join(' ');
}

/** The look through sent mail: start it once, then each Gmail check keeps the list up to date. */
function ScanPanel() {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const q = useGetNoReplyScan({
    query: {
      queryKey: getGetNoReplyScanQueryKey(),
      refetchInterval: (query) => (query.state.data?.status === 'running' || polling ? 2_000 : false),
    },
  });
  const [busy, setBusy] = useState<'start' | 'stop' | 'resume' | null>(null);
  const s = q.data;

  // When a run ends, the list may have new items.
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  if (s && s.status !== lastStatus) {
    setLastStatus(s.status);
    if (lastStatus === 'running') {
      setPolling(false);
      void qc.invalidateQueries({ queryKey: getListReviewQueryKey() });
    }
  }

  if (q.isLoading) return <Skel h={72} />;
  if (!s) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-no-reply-scan-error">
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Could not load the look through your sent email.</p>
        <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()}>Try again</button>
      </div>
    );
  }

  const act = async (kind: 'start' | 'stop' | 'resume') => {
    setBusy(kind);
    try {
      const next = kind === 'start' ? await startNoReplyScan() : kind === 'stop' ? await stopNoReplyScan() : await resumeNoReplyScan();
      qc.setQueryData(getGetNoReplyScanQueryKey(), next);
      setPolling(kind !== 'stop');
      if (kind === 'stop') {
        notify('Stopped', 'Resume any time to carry on from where it got to.');
        void qc.invalidateQueries({ queryKey: getListReviewQueryKey() });
      }
    } catch (err) {
      reportApiError(err);
      notify('That did not work', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const running = s.status === 'running';
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const progressLabel = s.listing ? 'Finding your sent email…' : `Read ${s.done} of ${n(s.total, 'thread')}`;

  if (s.status === 'idle') {
    return (
      <div className="oo-source" style={{ gap: 10 }} data-testid="panel-no-reply-scan">
        <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          Look through the email you sent in the last 6 months for ones where you wrote last and nobody answered. Newsletters, automated emails, invites and thank-yous are left out, and only emails that asked for something are kept. After that, every Gmail check keeps this list up to date.
        </p>
        <div>
          <button type="button" className="oo-btn oo-btn-ink" disabled={busy !== null} onClick={() => act('start')} data-testid="button-no-reply-start">
            {busy === 'start' ? 'Starting…' : 'Look through sent email'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="oo-source" style={{ gap: 8 }} data-testid="panel-no-reply-scan">
      {s.status !== 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="oo-progress" role="progressbar" aria-label="Look through progress" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={s.listing ? undefined : pct} aria-valuetext={progressLabel} data-listing={s.listing ? 'true' : 'false'} data-testid="progress-no-reply">
            <span style={{ width: s.listing ? '100%' : `${pct}%` }} />
          </div>
          <span className="oo-muted" style={{ fontSize: 12 }} data-testid="text-no-reply-progress">
            {running ? progressLabel : `Stopped. ${progressLabel}.`}
          </span>
        </div>
      )}

      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} aria-live="polite" data-testid="text-no-reply-found">
        {s.status === 'done' && s.finishedAt && (
          <span className="oo-muted">
            Looked through 6 months of sent email {whenLabel(s.finishedAt)}.{' '}
            {s.refreshedAt && s.refreshedAt > s.finishedAt ? `Last brought up to date by a Gmail check ${whenLabel(s.refreshedAt)}. ` : 'Each Gmail check keeps it up to date. '}
          </span>
        )}
        {foundLine(s)}
      </p>

      {s.error && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--oo-danger)' }} data-testid="text-no-reply-error">{s.error}</p>}

      {(running || s.status === 'stopped' || s.status === 'failed') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {running ? (
            <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={() => act('stop')} data-testid="button-no-reply-stop">
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button type="button" className="oo-btn oo-btn-ink" disabled={busy !== null} onClick={() => act('resume')} data-testid="button-no-reply-resume">
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Newest sent first. */
const newestFirst = (items: ReviewItem[]) => [...items].sort((a, b) => new Date(b.meetingAt).getTime() - new Date(a.meetingAt).getTime());

interface Chased {
  taskId: number;
  title: string;
  name: string;
}

/** "Change date": the day a reply is expected by, when it turns due. */
function ChangeDate({ it }: { it: ReviewItem }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async (date: string) => {
    if (!date || date === it.expectedBy) return;
    setSaving(true);
    try {
      await setReviewExpectedBy(it.id, { date });
      await qc.invalidateQueries({ queryKey: getListReviewQueryKey() });
      notify('Date changed', `A reply is now expected by ${formatLong(date)}.`);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dropdown
      variant="compact"
      ariaLabel={`Change the date a reply to "${it.text}" is expected by`}
      value={it.expectedBy ?? ''}
      onChange={(v) => void save(v)}
      searchable={false}
      disabled={saving}
      options={dayChoices(todayLondon())}
      trigger={<span>Change date</span>}
      footer={(close) => (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Pick a date</span>
          <input
            type="date"
            className="oo-input"
            style={{ minHeight: 34, fontSize: 13 }}
            defaultValue={it.expectedBy ?? ''}
            onChange={(e) => {
              // Typing a year fires changes for 0002, 0020 and so on; wait for a real one.
              if (!e.target.value || Number(e.target.value.slice(0, 4)) < 2000) return;
              void save(e.target.value);
              close();
            }}
            data-testid={'input-waiting-date-' + it.id}
          />
        </label>
      )}
      testId={'button-waiting-date-' + it.id}
    />
  );
}

/** Waiting for a reply: emails and Slack messages Ollie sent that asked for something and nobody has answered yet. */
export function NoReplyTab() {
  const q = useListReview();
  const items = useMemo(() => newestFirst((q.data?.items ?? []).filter((i) => i.kind === 'no_reply')), [q.data]);
  const { selected, setSelected, waitingFor: open, setWaitingFor: setOpen, busy, toggle, decide } = useReviewDecide((c) => (c === 1 ? 'message' : 'messages'), doneLine);
  const [writeEmail, setWriteEmail] = useState(false);
  const [chased, setChased] = useState<Chased[]>([]);
  const picked = items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const allPicked = items.length > 0 && picked.length === items.length;

  const choose = (ids: number[], action: Action, key: number | 'bulk') => {
    if (action === 'waiting') {
      setWriteEmail(false);
      setOpen(open === key ? null : key);
    } else void decide(ids, action);
  };

  const chase = async (it: ReviewItem, personId: number | null | undefined) => {
    const done = await decide([it.id], 'waiting', personId);
    const taskId = done?.[0]?.taskId;
    if (writeEmail && it.via !== 'slack' && taskId != null) setChased((list) => [{ taskId, title: it.text, name: it.person?.name ?? it.owner }, ...list.filter((c) => c.taskId !== taskId)]);
  };

  return (
    <>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Emails and Slack messages you sent that asked for something and nobody has answered yet. Each turns due on the day a reply is expected by, 3 working days later unless you change it. Chase makes a Waiting on task, and for an email can write a follow-up for you to save to Gmail. Slack messages are picked up by the Slack check, from direct messages and group DMs. Nothing is sent.
      </p>

      <ScanPanel />

      {chased.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="Chase emails" data-testid="section-chase-emails">
          {chased.map((c) => (
            <div key={c.taskId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={'chase-email-' + c.taskId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14 }}>
                  <span style={{ fontWeight: 600 }}>{c.title}</span>{' '}
                  <Link href={`/tasks?tab=waiting&task=${c.taskId}`} className="oo-link" style={{ fontSize: 13 }}>Open task</Link>
                </span>
                <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setChased((list) => list.filter((x) => x.taskId !== c.taskId))}
                  data-testid={'button-chase-close-' + c.taskId}>
                  Close
                </button>
              </div>
              <ReplyDraftCard taskId={c.taskId} chase />
            </div>
          ))}
        </section>
      )}

      {q.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map((i) => <Skel key={i} h={96} />)}</div>
      ) : !q.data ? (
        <PageProblem notFound={false} what="review list" onRetry={() => q.refetch()} back={{ href: '/tasks', label: 'Tasks' }} />
      ) : items.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-no-reply-empty">
          Nobody owes you a reply.
        </p>
      ) : (
        <>
          <div className="oo-rv-bulk" data-testid="bar-no-reply-bulk">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" className="oo-rv-select" checked={allPicked}
                ref={(el) => {
                  if (el) el.indeterminate = picked.length > 0 && !allPicked;
                }}
                onChange={() => setSelected(allPicked ? new Set() : new Set(items.map((i) => i.id)))} data-testid="checkbox-no-reply-all" />
              <span>{picked.length ? `${picked.length} selected` : 'Select all'}</span>
            </label>
            {picked.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {BUTTONS.map((b) => (
                  <button key={b.action} type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} aria-expanded={b.action === 'waiting' ? open === 'bulk' : undefined}
                    onClick={() => choose(picked, b.action, 'bulk')} data-testid={'button-no-reply-bulk-' + b.testId}>
                    {b.label}
                  </button>
                ))}
              </div>
            )}
            {picked.length > 0 && open === 'bulk' && (
              <WaitingPicker bulk busy={busy} initial={OWN} confirmLabel="Chase" onCancel={() => setOpen(null)} onConfirm={(v) => void decide(picked, 'waiting', v)} testKey="no-reply-bulk" />
            )}
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }} aria-label="Messages waiting for a reply">
            {items.map((it) => (
              <Row
                key={it.id}
                it={it}
                busy={busy}
                checked={selected.has(it.id)}
                onToggle={() => toggle(it.id)}
                chaseOpen={open === it.id}
                onChoose={(a) => choose([it.id], a, it.id)}
                onChase={(v) => void chase(it, v)}
                onCancelChase={() => setOpen(null)}
                writeEmail={writeEmail}
                onWriteEmail={setWriteEmail}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Row({ it, busy, checked, onToggle, chaseOpen, onChoose, onChase, onCancelChase, writeEmail, onWriteEmail }: {
  it: ReviewItem;
  busy: boolean;
  checked: boolean;
  onToggle: () => void;
  chaseOpen: boolean;
  onChoose: (a: Action) => void;
  onChase: (personId: number | null) => void;
  onCancelChase: () => void;
  writeEmail: boolean;
  onWriteEmail: (v: boolean) => void;
}) {
  const titleId = 'nr-title-' + it.id;
  const name = it.person?.name ?? it.owner;
  return (
    <li className="oo-rv-row" data-selected={checked ? 'true' : 'false'} aria-labelledby={titleId} data-testid={'row-no-reply-' + it.id}>
      <input type="checkbox" className="oo-rv-select" checked={checked} onChange={onToggle} aria-labelledby={titleId} data-testid={'checkbox-no-reply-' + it.id} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'baseline' }} data-testid={'text-no-reply-person-' + it.id}>
          <span style={{ fontWeight: 600 }}>{it.person?.slug ? <Link href={'/knowledge/people/' + it.person.slug} className="oo-link">{name}</Link> : name}</span>
          {it.email && it.email !== name && <span className="oo-muted">{it.email}</span>}
        </span>
        <span id={titleId} style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }} data-testid={'text-no-reply-ask-' + it.id}>{it.text}</span>
        <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
          <span data-testid={'text-no-reply-subject-' + it.id}>
            {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer">{it.meetingTitle}</a> : it.meetingTitle}, sent {formatLong(it.meetingAt)}
          </span>
          {it.via === 'slack' && <span className="oo-pill" data-testid={'pill-no-reply-slack-' + it.id}>Slack</span>}
          <span data-testid={'text-no-reply-age-' + it.id}>{waitingFor(it.meetingAt)}</span>
          {it.expectedBy && (
            <span data-testid={'text-waiting-expected-' + it.id}>
              {it.due ? (it.expectedBy < todayLondon() ? `Reply expected by ${formatShort(it.expectedBy)}` : 'Reply expected today') : `Reply expected by ${formatShort(it.expectedBy)}`}
            </span>
          )}
          {it.due && <span className="oo-pill" data-tone="now" data-testid={'pill-waiting-due-' + it.id}>Due</span>}
          {it.project && <span>{it.project.name}</span>}
          {it.priority === 'high' && <span className="oo-pill" data-tone="now">High</span>}
          {it.confidential && <span className="oo-pill">Confidential</span>}
        </span>
        {it.reason && <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }} data-testid={'text-no-reply-reason-' + it.id}>{it.reason}</span>}
        {it.quote && <blockquote className="oo-rv-quote" data-testid={'text-no-reply-quote-' + it.id}>{it.quote}</blockquote>}
        {it.action && (
          <span className="oo-soft" style={{ fontSize: 13 }}><span className="oo-muted">Chase:</span> {it.action}</span>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
          {BUTTONS.map((b) => (
            <button key={b.action} type="button" className={'oo-btn oo-btn-sm ' + (b.action === 'waiting' ? 'oo-btn-ink' : 'oo-btn-outline')} disabled={busy}
              aria-expanded={b.action === 'waiting' ? chaseOpen : undefined}
              onClick={() => onChoose(b.action)} data-testid={`button-no-reply-${b.testId}-${it.id}`}>
              {b.label}
            </button>
          ))}
          <ChangeDate it={it} />
        </div>
        {chaseOpen && (
          <WaitingPicker busy={busy} initial={it.person ? String(it.person.id) : NOBODY} hint={it.person ? undefined : it.owner} confirmLabel="Chase"
            onCancel={onCancelChase} onConfirm={(v) => onChase(v ?? null)} testKey={'no-reply-' + it.id}>
            {it.via !== 'slack' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', alignSelf: 'center' }}>
                <input type="checkbox" className="oo-rv-select" checked={writeEmail} onChange={(e) => onWriteEmail(e.target.checked)} data-testid={'checkbox-chase-email-' + it.id} />
                Write a chase email
              </label>
            )}
          </WaitingPicker>
        )}
      </div>
    </li>
  );
}
