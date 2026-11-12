import type { Task } from '@workspace/api-client-react';
import { REPEAT_SHORT, SOURCE_LABELS, repeatLabel, type RepeatRule, type TaskSource } from '@workspace/shared';
import { IconRepeat } from '@/components/icons';

/**
 * The small marks after a task title on lists: how it repeats, how far through its checklist it is,
 * and (section 26) where else the same work came up.
 */
export function TaskMarks({ task }: { task: Pick<Task, 'id' | 'repeat' | 'steps' | 'alsoFrom'> }) {
  const steps = task.steps ?? [];
  const done = steps.filter((s) => s.done).length;
  const also = (task.alsoFrom ?? []).map((s) => SOURCE_LABELS[s as TaskSource] ?? s);
  if (!task.repeat && !steps.length && !also.length) return null;
  return (
    <span className="oo-marks">
      {also.length > 0 && (
        <span className="oo-mark-steps" title="The same work came up here too. Open the task to see where." data-testid={'mark-also-' + task.id}>
          Also in {also.join(', ')}
        </span>
      )}
      {task.repeat && (
        <span className="oo-mark-repeat" title={repeatLabel(task.repeat as RepeatRule)} data-testid={'mark-repeat-' + task.id}>
          <IconRepeat size={12} />
          {REPEAT_SHORT[task.repeat.every]}
          <span className="oo-sr">: {repeatLabel(task.repeat as RepeatRule)}</span>
        </span>
      )}
      {steps.length > 0 && (
        <span className="oo-mark-steps oo-num" data-complete={done === steps.length} data-testid={'mark-steps-' + task.id}>
          {done} of {steps.length}
          <span className="oo-sr"> steps done</span>
        </span>
      )}
    </span>
  );
}
