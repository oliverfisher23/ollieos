import { useState } from 'react';
import { applyTaskStuckHint, dismissTaskStuckHint, type Task } from '@workspace/api-client-react';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const TITLE: Record<string, string> = {
  break_down: 'Break it into steps',
  delegate: 'Hand it on',
  drop: 'Drop it',
  repeat: 'Make it repeat',
  next_step: 'Start with one small step',
};
const DO: Record<string, string> = {
  break_down: 'Add these steps',
  drop: 'Drop it',
  repeat: 'Make it repeat',
  next_step: 'Add it as the first step',
};
const DONE: Record<string, string> = {
  break_down: 'Steps added to the checklist',
  drop: 'Dropped. It is off your lists.',
  repeat: 'It now repeats',
  next_step: 'Added as the first step',
};
const EVERY: Record<string, string> = { week: 'every week', fortnight: 'every fortnight', month: 'every month', quarter: 'every quarter' };

/**
 * Section 26: on the task panel, why a task looks stuck and the coach's way out. Do this makes the
 * change; Not now keeps it off the stuck list for 30 days. Handing it on uses the Slack draft below.
 */
export function StuckCoach({ task }: { task: Task }) {
  const invalidate = useInvalidateTasks();
  const [busy, setBusy] = useState(false);
  const s = task.stuck;
  if (!s) return null;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await invalidate(task.id);
      notify(done);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const way = s.wayOut ?? null;
  return (
    <div className="oo-source" style={{ gap: 8 }} data-testid="card-stuck">
      <span style={{ fontSize: 13 }}>
        <span style={{ fontWeight: 500 }}>Looks stuck.</span> <span className="oo-soft">{s.signals}.</span>
      </span>
      {way ? (
        <>
          <span style={{ fontSize: 14, fontWeight: 500 }} data-testid="text-stuck-way">
            {TITLE[way]}
            {way === 'repeat' && s.repeatEvery ? `, ${EVERY[s.repeatEvery]}` : ''}
          </span>
          {s.why && <span className="oo-soft" style={{ fontSize: 13 }}>{s.why}</span>}
          {way === 'break_down' && s.steps.length > 0 && (
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="list-stuck-steps">
              {s.steps.map((st, i) => <li key={i}>{st}</li>)}
            </ol>
          )}
          {way === 'delegate' && task.delegateHint && (
            <span className="oo-soft" style={{ fontSize: 13 }}>{task.delegateHint.personName} could take it: use Message {task.delegateHint.personName.split(' ')[0]} below, which has the draft ready.</span>
          )}
          {s.nextStep && way !== 'break_down' && (
            <span style={{ fontSize: 13 }}><span className="oo-muted">First:</span> {s.nextStep}</span>
          )}
        </>
      ) : (
        <span className="oo-soft" style={{ fontSize: 13 }}>Break it into steps, hand it on or drop it. This one is hidden from AI, so there is no suggestion.</span>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {way && way !== 'delegate' && (
          <button type="button" className={way === 'drop' ? 'oo-btn oo-btn-danger oo-btn-sm' : 'oo-btn oo-btn-ink oo-btn-sm'} disabled={busy} onClick={() => void run(() => applyTaskStuckHint(task.id), DONE[way])} data-testid="button-stuck-apply">
            {DO[way]}
          </button>
        )}
        <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={busy} onClick={() => void run(() => dismissTaskStuckHint(task.id), 'Off the stuck list for 30 days')} data-testid="button-stuck-dismiss">
          Not now
        </button>
      </div>
    </div>
  );
}
