import { useEffect, useState } from 'react';
import { guessTaskDropReason, updateTask, type DropReason, type Task } from '@workspace/api-client-react';
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
 *
 * Section 30, Part H: when no reason has been given, OllieOS's likeliest one is asked for as the chips
 * appear, saved, and shown already chosen ("OllieOS's guess"). A tap on another chip changes it and
 * makes it Ollie's. With no clear guess the chips are as before.
 */
export function DropReasonChips({ task, onSaved, guessed: wasGuessed = false }: { task: Pick<Task, 'id' | 'dropReason'>; onSaved?: (r: DropReason) => void; guessed?: boolean }) {
  const invalidate = useInvalidateTasks();
  const [chosen, setChosen] = useState<DropReason | null>((task.dropReason as DropReason | null) ?? null);
  const [guessed, setGuessed] = useState(wasGuessed);
  const hadReason = task.dropReason != null;
  useEffect(() => {
    if (hadReason) return;
    let gone = false;
    guessTaskDropReason(task.id)
      .then((res) => {
        if (gone || !res.reason) return;
        // Only when Ollie has not already tapped one while the guess was on its way.
        setChosen((c) => {
          if (c) return c;
          setGuessed(true);
          return res.reason as DropReason;
        });
        invalidate(task.id);
      })
      .catch(() => {
        // No guess is not worth a message: the chips are still there to tap.
      });
    return () => {
      gone = true;
    };
  }, [task.id, hadReason, invalidate]);
  const pick = async (r: DropReason) => {
    const prev = chosen;
    setChosen(r);
    setGuessed(false);
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
      <span style={{ fontSize: 12, opacity: 0.75 }} data-testid={'text-reason-lead-' + task.id}>{guessed && chosen ? "OllieOS's guess. Change:" : 'Why?'}</span>
      {QUICK_REASONS.map((r) => (
        <button key={r} type="button" className="oo-tapchip" aria-pressed={chosen === r} onClick={() => void pick(r)} data-testid={`button-reason-${r}-${task.id}`}>
          {DROP_REASON_LABELS[r]}
        </button>
      ))}
    </div>
  );
}
