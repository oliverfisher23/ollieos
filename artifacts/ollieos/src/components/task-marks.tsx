import type { Task } from '@workspace/api-client-react';
import { REPEAT_SHORT, repeatLabel, type RepeatRule } from '@workspace/shared';
import { IconRepeat } from '@/components/icons';

/** The small marks after a task title on lists: how it repeats, and how far through its checklist it is. */
export function TaskMarks({ task }: { task: Pick<Task, 'id' | 'repeat' | 'steps'> & Partial<Pick<Task, 'stuck'>> }) {
  const steps = task.steps ?? [];
  const done = steps.filter((s) => s.done).length;
  if (!task.repeat && !steps.length && !task.stuck) return null;
  return (
    <span className="oo-marks">
      {task.stuck && (
        <span className="oo-mark-stuck" title={task.stuck.signals} data-testid={'mark-stuck-' + task.id}>
          Stuck
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
