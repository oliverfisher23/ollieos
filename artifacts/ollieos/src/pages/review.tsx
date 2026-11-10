import { useMemo } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useListReview, type ReviewDecideInputAction, type ReviewItem } from '@workspace/api-client-react';
import { formatDayMonth, formatLong } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { PageProblem } from '@/components/knowledge/parts';
import { NOBODY, OWN, WaitingPicker } from '@/components/waiting-picker';
import { n, useReviewDecide } from '@/lib/review';
import { NoReplyTab } from '@/pages/review-no-reply';

type Action = ReviewDecideInputAction;

const BUTTONS: { action: Action; label: string; testId: string }[] = [
  { action: 'now', label: 'Now', testId: 'now' },
  { action: 'backlog', label: 'Backlog', testId: 'backlog' },
  { action: 'waiting', label: 'Waiting on…', testId: 'waiting' },
  { action: 'done', label: 'Already done', testId: 'done' },
  { action: 'dropped', label: 'Dropped', testId: 'dropped' },
];


function doneLine(action: Action, count: number): string {
  const what = count === 1 ? 'Added' : `${n(count, 'action')} added`;
  switch (action) {
    case 'now':
      return `${what} to Now`;
    case 'backlog':
      return `${what} to Backlog`;
    case 'waiting':
      return `${what} to Waiting on`;
    case 'done':
      return count === 1 ? 'Marked as already done' : `${n(count, 'action')} marked as already done`;
    case 'dropped':
      return count === 1 ? 'Dropped' : `${n(count, 'action')} dropped`;
  }
}

const SUGGESTED: Record<string, string> = {
  task: 'Looks like yours',
  promise: 'Looks like a promise you made',
  waiting: 'Looks like you are waiting on someone',
};

type Tab = 'meetings' | 'no-reply';

/**
 * Review: things kept out of the Inbox so weeks of old items do not flood it. Actions an earlier
 * Granola look back found, and emails Ollie sent that nobody answered. Ollie sorts each one, or
 * several at once.
 */
export default function ReviewPage() {
  const q = useListReview();
  const search = useSearch();
  const [, navigate] = useLocation();
  const asked = new URLSearchParams(search).get('tab');
  // With nothing from meetings to review, open on No reply yet.
  const tab: Tab = asked === 'no-reply' || asked === 'meetings' ? asked : q.data && q.data.actions === 0 ? 'no-reply' : 'meetings';
  const tabs: { id: Tab; label: string; count: number | undefined }[] = [
    { id: 'meetings', label: 'From meetings', count: q.data?.actions },
    { id: 'no-reply', label: 'No reply yet', count: q.data?.noReply },
  ];

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-review">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <h1 className="oo-h1">Review</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
            Things kept out of your Inbox so they do not flood it: actions from your older Granola notes, and emails you sent that nobody answered.
          </p>
        </div>
        <span className="oo-serif" style={{ fontSize: 22 }} data-testid="text-review-count">{q.data ? `${q.data.pending} to review` : '…'}</span>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Review type" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="oo-tab" aria-selected={t.id === tab}
              onClick={() => navigate(`/review?tab=${t.id}`, { replace: true })} data-testid={'tab-review-' + t.id}>
              {t.label} <span className="oo-count oo-num">{t.count ?? ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: -6 }}>
        {tab === 'meetings' ? <ActionsTab /> : <NoReplyTab />}
      </div>
    </main>
  );
}

/** Actions from a Granola look back. */
function ActionsTab() {
  const q = useListReview();
  const items = (q.data?.items ?? []).filter((i) => i.kind === 'action');
  const { selected, setSelected, waitingFor, setWaitingFor, busy, toggle, decide } = useReviewDecide((c) => (c === 1 ? 'action' : 'actions'), doneLine);
  const picked = useMemo(() => items.filter((i) => selected.has(i.id)).map((i) => i.id), [items, selected]);
  const allPicked = items.length > 0 && picked.length === items.length;

  const choose = (ids: number[], action: Action, key: number | 'bulk') => {
    if (action === 'waiting') setWaitingFor(waitingFor === key ? null : key);
    else void decide(ids, action);
  };

  return (
    <>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Actions a look back at your older Granola notes found. Make each one a task, or mark it as already done or dropped. Start a look back from{' '}
        <Link href="/settings/connectors" className="oo-link">Settings, Connectors</Link>.
      </p>
      {q.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map((i) => <Skel key={i} h={96} />)}</div>
      ) : !q.data ? (
        <PageProblem notFound={false} what="review list" onRetry={() => q.refetch()} back={{ href: '/tasks', label: 'Tasks' }} />
      ) : items.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-review-empty">
          Nothing from meetings to review. When a look back finds actions, they wait here.
        </p>
      ) : (
        <>
          <div className="oo-rv-bulk" data-testid="bar-review-bulk">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="oo-rv-select"
                checked={allPicked}
                ref={(el) => {
                  if (el) el.indeterminate = picked.length > 0 && !allPicked;
                }}
                onChange={() => setSelected(allPicked ? new Set() : new Set(items.map((i) => i.id)))}
                data-testid="checkbox-review-all"
              />
              <span>{picked.length ? `${picked.length} selected` : 'Select all'}</span>
            </label>
            {picked.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {BUTTONS.map((b) => (
                  <button key={b.action} type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} aria-expanded={b.action === 'waiting' ? waitingFor === 'bulk' : undefined}
                    onClick={() => choose(picked, b.action, 'bulk')} data-testid={'button-bulk-' + b.testId}>
                    {b.label}
                  </button>
                ))}
              </div>
            )}
            {picked.length > 0 && waitingFor === 'bulk' && (
              <WaitingPicker bulk busy={busy} initial={OWN} onCancel={() => setWaitingFor(null)} onConfirm={(v) => decide(picked, 'waiting', v)} testKey="bulk" />
            )}
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {items.map((it) => (
              <Row
                key={it.id}
                it={it}
                busy={busy}
                checked={selected.has(it.id)}
                onToggle={() => toggle(it.id)}
                waitingOpen={waitingFor === it.id}
                onChoose={(a) => choose([it.id], a, it.id)}
                onWaiting={(v) => decide([it.id], 'waiting', v)}
                onCancelWaiting={() => setWaitingFor(null)}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Row({ it, busy, checked, onToggle, waitingOpen, onChoose, onWaiting, onCancelWaiting }: {
  it: ReviewItem;
  busy: boolean;
  checked: boolean;
  onToggle: () => void;
  waitingOpen: boolean;
  onChoose: (a: Action) => void;
  onWaiting: (personId: number | null) => void;
  onCancelWaiting: () => void;
}) {
  const titleId = 'rv-title-' + it.id;
  return (
    <li className="oo-rv-row" data-selected={checked ? 'true' : 'false'} aria-labelledby={titleId} data-testid={'row-review-' + it.id}>
      <input type="checkbox" className="oo-rv-select" checked={checked} onChange={onToggle} aria-labelledby={titleId} data-testid={'checkbox-review-' + it.id} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
        <span id={titleId} style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }} data-testid={'text-review-title-' + it.id}>{it.text}</span>
        <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
          <span data-testid={'text-review-meeting-' + it.id}>
            {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer">{it.meetingTitle}</a> : it.meetingTitle}, {formatLong(it.meetingAt)}
          </span>
          <span data-testid={'text-review-owner-' + it.id}>Owner: {it.owner}</span>
          {it.project && <span>{it.project.name}</span>}
          {it.dueDate && <span>Due {formatDayMonth(it.dueDate)}</span>}
          {it.confidential && <span className="oo-pill">Confidential</span>}
        </span>
        {it.quote && (
          <blockquote className="oo-rv-quote" data-testid={'text-review-quote-' + it.id}>{it.quote}</blockquote>
        )}
        {it.action && it.action !== it.text && (
          <span className="oo-soft" style={{ fontSize: 13 }}><span className="oo-muted">Next step:</span> {it.action}</span>
        )}
        <span className="oo-muted" style={{ fontSize: 12 }}>{SUGGESTED[it.suggestedType] ?? ''}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
          {BUTTONS.map((b) => (
            <button key={b.action} type="button" className={'oo-btn oo-btn-sm ' + (b.action === 'now' ? 'oo-btn-ink' : 'oo-btn-outline')} disabled={busy}
              aria-expanded={b.action === 'waiting' ? waitingOpen : undefined}
              onClick={() => onChoose(b.action)} data-testid={`button-review-${b.testId}-${it.id}`}>
              {b.label}
            </button>
          ))}
        </div>
        {waitingOpen && (
          <WaitingPicker busy={busy} initial={it.person ? String(it.person.id) : NOBODY} hint={it.person ? undefined : it.suggestedType === 'waiting' ? it.owner : undefined}
            onCancel={onCancelWaiting} onConfirm={onWaiting} testKey={String(it.id)} />
        )}
      </div>
    </li>
  );
}
