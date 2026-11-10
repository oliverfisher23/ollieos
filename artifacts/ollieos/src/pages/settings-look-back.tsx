import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  getGetLookBackQueryKey,
  resumeLookBack,
  startLookBack,
  stopLookBack,
  useGetLookBack,
  type LookBack,
  type LookBackInputActionsDays,
  type LookBackInputDecisionsDays,
} from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { whenLabel } from '@/lib/access';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const DECISION_OPTIONS = [
  { value: '30', label: '1 month' },
  { value: '91', label: '3 months' },
  { value: '183', label: '6 months' },
  { value: '365', label: '12 months' },
];
const ACTION_OPTIONS = [
  { value: '0', label: 'No actions' },
  { value: '14', label: '2 weeks' },
  { value: '30', label: '1 month' },
  { value: '61', label: '2 months' },
];

const n = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;

/** What the run found so far, in one or two plain sentences. */
function foundLine(lb: LookBack): string {
  const c = lb.counts;
  const parts = [`Found ${n(c.decisions, 'new decision')} and ${n(c.actions, 'new action')} in ${n(c.meetings, 'of your meetings', 'of your meetings')}.`];
  const skipped: string[] = [];
  if (c.left_out) skipped.push(`${n(c.left_out, 'note')} from meetings you were not in`);
  if (c.duplicates) skipped.push(`${c.duplicates} already in OllieOS`);
  if (c.already) skipped.push(`${n(c.already, 'note')} an earlier look back read`);
  if (skipped.length) parts.push(`Left out ${skipped.join(', ')}.`);
  if (c.failed) parts.push(`${n(c.failed, 'note')} could not be read; a rerun tries again.`);
  return parts.join(' ');
}

/**
 * Look back at Granola: a one-off read of older notes, inside the Granola card. Runs in the
 * background on the server, so the page can be closed; it polls while running.
 */
export function LookBackPanel() {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const q = useGetLookBack({
    query: {
      queryKey: getGetLookBackQueryKey(),
      refetchInterval: (query) => (query.state.data?.status === 'running' || polling ? 2_000 : false),
    },
  });
  const lb = q.data;
  const [decisions, setDecisions] = useState<string | null>(null);
  const [actions, setActions] = useState<string | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | 'resume' | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);

  if (q.isLoading) return <Skel h={96} />;
  if (!lb) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-look-back-error">
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Could not load the look back.</p>
        <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()}>Try again</button>
      </div>
    );
  }

  const decisionsDays = decisions ?? String(lb.decisionsDays);
  const actionsDays = actions ?? String(lb.actionsDays);
  const running = lb.status === 'running';
  const hasRun = lb.status !== 'idle';

  const act = async (kind: 'start' | 'stop' | 'resume') => {
    setBusy(kind);
    try {
      const next =
        kind === 'start'
          ? await startLookBack({ decisionsDays: Number(decisionsDays) as LookBackInputDecisionsDays, actionsDays: Number(actionsDays) as LookBackInputActionsDays })
          : kind === 'stop'
            ? await stopLookBack()
            : await resumeLookBack();
      qc.setQueryData(getGetLookBackQueryKey(), next);
      setConfirmNew(false);
      setPolling(kind !== 'stop');
      if (kind === 'stop') notify('Look back stopped', 'Resume any time to carry on from where it got to.');
    } catch (err) {
      reportApiError(err);
      notify('That did not work', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const pct = lb.total ? Math.round((lb.done / lb.total) * 100) : 0;
  const progressLabel = lb.listing ? 'Finding your meetings…' : `Read ${lb.done} of ${n(lb.total, 'note')}`;

  return (
    <div className="oo-lookback" data-testid="panel-look-back">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Look back</h4>
        <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          Read your older Granola notes once, to find what OllieOS missed. Only meetings you were in. Decisions go to the Knowledge Inbox and actions to Review, so your Inbox is not flooded. Anything OllieOS already has is left out.
        </p>
      </div>

      {(!hasRun || (!running && (lb.status === 'done' || confirmNew))) && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div className="oo-dd-field" style={{ minWidth: 150 }}>
            <label htmlFor="look-back-decisions">Decisions from the last</label>
            <Dropdown id="look-back-decisions" value={decisionsDays} onChange={setDecisions} options={DECISION_OPTIONS} searchable={false} testId="select-look-back-decisions" />
          </div>
          <div className="oo-dd-field" style={{ minWidth: 150 }}>
            <label htmlFor="look-back-actions">Actions from the last</label>
            <Dropdown id="look-back-actions" value={actionsDays} onChange={setActions} options={ACTION_OPTIONS} searchable={false} testId="select-look-back-actions" />
          </div>
          <button type="button" className="oo-btn oo-btn-ink" disabled={busy !== null} onClick={() => act('start')} data-testid="button-look-back-start">
            {busy === 'start' ? 'Starting…' : hasRun ? 'Start a new look back' : 'Start look back'}
          </button>
          {confirmNew && (
            <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={() => setConfirmNew(false)}>Cancel</button>
          )}
        </div>
      )}

      {hasRun && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lb.status !== 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                className="oo-progress"
                role="progressbar"
                aria-label="Look back progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={lb.listing ? undefined : pct}
                aria-valuetext={progressLabel}
                data-listing={lb.listing ? 'true' : 'false'}
                data-testid="progress-look-back"
              >
                <span style={{ width: lb.listing ? '100%' : `${pct}%` }} />
              </div>
              <span className="oo-muted" style={{ fontSize: 12 }} data-testid="text-look-back-progress">
                {running ? progressLabel : `Stopped. ${progressLabel}.`}
              </span>
            </div>
          )}

          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} aria-live="polite" data-testid="text-look-back-found">
            {lb.status === 'done' && lb.finishedAt && <span className="oo-muted">Finished {whenLabel(lb.finishedAt)}. </span>}
            {foundLine(lb)}
          </p>

          {lb.error && (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--oo-danger)' }} data-testid="text-look-back-error">{lb.error}</p>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {running && (
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={() => act('stop')} data-testid="button-look-back-stop">
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {(lb.status === 'stopped' || lb.status === 'failed') && !confirmNew && (
              <>
                <button type="button" className="oo-btn oo-btn-ink" disabled={busy !== null} onClick={() => act('resume')} data-testid="button-look-back-resume">
                  {busy === 'resume' ? 'Resuming…' : 'Resume'}
                </button>
                <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={() => setConfirmNew(true)} data-testid="button-look-back-new">
                  Start a new one instead
                </button>
              </>
            )}
            {lb.reviewPending > 0 && (
              <Link href="/review?tab=meetings" className="oo-btn oo-btn-outline" data-testid="link-look-back-review">
                Review {n(lb.reviewPending, 'action')}
              </Link>
            )}
            {lb.counts.decisions > 0 && (
              <Link href="/knowledge/inbox?from=look-back" className="oo-btn oo-btn-outline" data-testid="link-look-back-decisions">
                See decisions
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
