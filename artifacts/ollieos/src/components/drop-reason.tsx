import { useState } from 'react';
import { updateTask, type DropReason, type Task } from '@workspace/api-client-react';
import { DROP_REASON_LABELS } from '@workspace/shared';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

/** Sources a reader or an AI made the item from; only these are asked "why" when dropped. */
export const madeByReader = (t: Pick<Task, 'source'>) => t.source === 'email' || t.source === 'slack' || t.source === 'meeting' || t.source === 'session';

/** The reasons offered with one tap, most common first. */
export const QUICK_REASONS: DropReason[] = ['not_mine', 'already_done', 'fyi', 'duplicate', 'arranging'];

/**
 * Section 27: "Why?" after dropping an item or sending it to Noise. One tap; the Reader coach
 * learns from the answer. Works on the dark triage glass and the light panel.
 */
export function DropReasonChips({ task, onSaved }: { task: Pick<Task, 'id' | 'dropReason'>; onSaved?: (r: DropReason) => void }) {
  const invalidate = useInvalidateTasks();
  const [chosen, setChosen] = useState<DropReason | null>((task.dropReason as DropReason | null) ?? null);
  const pick = async (r: DropReason) => {
    const prev = chosen;
    setChosen(r);
    try {
      await updateTask(task.id, { dropReason: r });
      invalidate(task.id);
      onSaved?.(r);
    } catch (err) {
      setChosen(prev);
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    }
  };
  return (
    <div role="group" aria-label="Why did you drop it?" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} data-testid={'chips-drop-reason-' + task.id}>
      <span style={{ fontSize: 12, opacity: 0.75 }}>Why?</span>
      {QUICK_REASONS.map((r) => (
        <button key={r} type="button" className="oo-tapchip" aria-pressed={chosen === r} onClick={() => void pick(r)} data-testid={`button-reason-${r}-${task.id}`}>
          {DROP_REASON_LABELS[r]}
        </button>
      ))}
    </div>
  );
}
