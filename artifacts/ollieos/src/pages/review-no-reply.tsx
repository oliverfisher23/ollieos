import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  getGetNoReplyScanQueryKey,
  getListReviewQueryKey,
  resumeNoReplyScan,
  startNoReplyScan,
  stopNoReplyScan,
  useGetNoReplyScan,
  useListReview,
  type NoReplyScan,
  type ReviewDecideInputAction,
  type ReviewItem,
} from '@workspace/api-client-react';
import { formatLong } from '@workspace/shared';
import { Skel } from '@/components/bits';
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
  if (action === 'waiting') return count === 1 ? 'Added to Waiting on' : `${n(count, 'email')} added to Waiting on`;
  if (action === 'done') return count === 1 ? 'Marked as handled' : `${n(count, 'email')} marked as handled`;
  return count === 1 ? 'Dropped' : `${n(count, 'email')} dropped`;
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
  if (c.recent) parts.push(`${n(c.recent, 'email')} sent in the last 3 working days will be checked once they are old enough.`);
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

interface Group {
  key: string;
  name: string;
  email: string | null;
  slug: string | null;
  items: ReviewItem[];
}

/** One group per person, the person with the newest unanswered email first. */
function groupByPerson(items: ReviewItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const it of items) {
    const key = it.person ? 'p' + it.person.id : 'e' + (it.email ?? it.owner);
    let g = groups.get(key);
    if (!g) {
      g = { key, name: it.person?.name ?? it.owner, email: it.email, slug: it.person?.slug ?? null, items: [] };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  return [...groups.values()];
}

interface Chased {
  taskId: number;
  title: string;
  name: string;
}

/** No reply yet: emails Ollie sent that asked for something and nobody answered. */
export function NoReplyTab() {
  const q = useListReview();
  const items = useMemo(() => (q.data?.items ?? []).filter((i) => i.kind === 'no_reply'), [q.data]);
  const groups = useMemo(() => groupByPerson(items), [items]);
  const { selected, setSelected, waitingFor: open, setWaitingFor: setOpen, busy, toggle, decide } = useReviewDecide((c) => (c === 1 ? 'email' : 'emails'), doneLine);
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
    if (writeEmail && taskId != null) setChased((list) => [{ taskId, title: it.text, name: it.person?.name ?? it.owner }, ...list.filter((c) => c.taskId !== taskId)]);
  };

  return (
    <>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Emails you sent where you wrote last and nobody has answered, once 3 working days have passed. Chase makes a Waiting on task, and can write a follow-up for you to save to Gmail. Nothing is sent.
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
          No unanswered emails to review.
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {groups.map((g) => (
              <section key={g.key} aria-labelledby={'nr-group-' + g.key} data-testid={'group-no-reply-' + g.key}>
                <h2 id={'nr-group-' + g.key} style={{ margin: 0, fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  {g.slug ? <Link href={'/knowledge/people/' + g.slug} className="oo-link">{g.name}</Link> : g.name}
                  {g.email && g.email !== g.name && <span className="oo-muted" style={{ fontSize: 13, fontWeight: 400 }}>{g.email}</span>}
                  <span className="oo-count oo-num">{g.items.length}</span>
                </h2>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
                  {g.items.map((it) => (
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
              </section>
            ))}
          </div>
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
  return (
    <li className="oo-rv-row" data-selected={checked ? 'true' : 'false'} aria-labelledby={titleId} data-testid={'row-no-reply-' + it.id}>
      <input type="checkbox" className="oo-rv-select" checked={checked} onChange={onToggle} aria-labelledby={titleId} data-testid={'checkbox-no-reply-' + it.id} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
        <span id={titleId} style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }} data-testid={'text-no-reply-ask-' + it.id}>{it.text}</span>
        <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
          <span data-testid={'text-no-reply-subject-' + it.id}>
            {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer">{it.meetingTitle}</a> : it.meetingTitle}, sent {formatLong(it.meetingAt)}
          </span>
          <span data-testid={'text-no-reply-age-' + it.id}>{waitingFor(it.meetingAt)}</span>
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
        </div>
        {chaseOpen && (
          <WaitingPicker busy={busy} initial={it.person ? String(it.person.id) : NOBODY} hint={it.person ? undefined : it.owner} confirmLabel="Chase"
            onCancel={onCancelChase} onConfirm={(v) => onChase(v ?? null)} testKey={'no-reply-' + it.id}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', alignSelf: 'center' }}>
              <input type="checkbox" className="oo-rv-select" checked={writeEmail} onChange={(e) => onWriteEmail(e.target.checked)} data-testid={'checkbox-chase-email-' + it.id} />
              Write a chase email
            </label>
          </WaitingPicker>
        )}
      </div>
    </li>
  );
}
