import { useCallback, useMemo } from 'react';
import {
  getTaskChaseLine,
  getWeeklyUpdate,
  restoreTask,
  snoozeTask,
  triageTask,
  undoTask,
  updateTask,
  type Task,
  type TriageInput,
  type TriageResult,
} from '@workspace/api-client-react';
import { STATUS_LABELS } from '@workspace/shared';
import { useInvalidateTasks } from '@/lib/task-cache';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const TRIAGE_LABEL: Record<TriageInput['action'], string> = {
  now: 'Moved to Now',
  backlog: 'Moved to Backlog',
  waiting: 'Moved to Waiting on',
  noise: 'Moved to Noise',
};

/**
 * Every task action that changes state in one place, so each one invalidates the same
 * caches and offers the same Undo toast wherever it is triggered.
 */
export function useTaskActions() {
  const invalidate = useInvalidateTasks();

  const fail = useCallback((err: unknown, title = 'That did not save') => {
    reportApiError(err);
    notify(title, errorMessage(err));
  }, []);

  const undo = useCallback(
    async (task: Pick<Task, 'id' | 'title'>) => {
      try {
        const t = await undoTask(task.id);
        invalidate(task.id);
        notify('Undone', `${task.title} is back in ${STATUS_LABELS[t.status]}`);
        return t;
      } catch (err) {
        fail(err, 'Could not undo');
        return null;
      }
    },
    [invalidate, fail],
  );

  const offerUndo = useCallback(
    (title: string, task: Pick<Task, 'id' | 'title'>) => notifyUndo(title, task.title, () => void undo(task)),
    [undo],
  );

  return useMemo(
    () => ({
      undo,

      async markDone(task: Task, opts: { toast?: boolean } = {}) {
        try {
          const t = await updateTask(task.id, { status: 'done' });
          invalidate(task.id);
          if (opts.toast !== false) offerUndo('Marked done', task);
          return t;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      async snooze(task: Task) {
        try {
          const t = await snoozeTask(task.id);
          invalidate(task.id);
          offerUndo('Snoozed to tomorrow', task);
          return t;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      /** Set `toast: false` when the caller shows its own feedback (the triage dialog does). */
      async triage(task: Task, input: TriageInput, opts: { toast?: boolean } = {}): Promise<TriageResult | null> {
        try {
          const res = await triageTask(task.id, input);
          invalidate(task.id);
          if (opts.toast !== false) {
            offerUndo(input.noiseRule && res.noiseRule ? `Moved to Noise. Ignoring ${lowerFirst(res.noiseRule.label)}` : TRIAGE_LABEL[input.action], task);
          }
          return res;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      async restore(task: Task) {
        try {
          const t = await restoreTask(task.id);
          invalidate(task.id);
          offerUndo('Restored to Inbox', task);
          return t;
        } catch (err) {
          fail(err);
          return null;
        }
      },

      async copyChase(task: Task) {
        try {
          const { text } = await getTaskChaseLine(task.id);
          await navigator.clipboard.writeText(text);
          notify('Chase line copied', text);
          return true;
        } catch (err) {
          fail(err, 'Could not copy the chase line');
          return false;
        }
      },

      async copyWeekly(weekStart?: string) {
        try {
          const res = await getWeeklyUpdate(weekStart ? { weekStart } : undefined);
          await navigator.clipboard.writeText(res.text);
          notify('Weekly update copied', res.count === 1 ? '1 item, grouped by project' : `${res.count} items, grouped by project`);
          return true;
        } catch (err) {
          fail(err, 'Could not copy the weekly update');
          return false;
        }
      },
    }),
    [undo, offerUndo, invalidate, fail],
  );
}

export function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
