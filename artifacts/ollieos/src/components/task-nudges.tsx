import { useState } from 'react';
import {
  chaseTaskLater,
  dismissTaskStuckHint,
  updateTask,
  useGetTaskProjectSuggestions,
  getGetTaskProjectSuggestionsQueryKey,
  type Task,
} from '@workspace/api-client-react';
import { CHASE_AFTER_DAYS, formatDayMonth } from '@workspace/shared';
import { useInvalidateTasks } from '@/lib/task-cache';
import { useTaskActions } from '@/lib/task-actions';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

/** Section 27: up to three projects a task with none probably belongs to; one tap sets it. */
export function ProjectSuggestChips({ task }: { task: Pick<Task, 'id' | 'project' | 'status'> }) {
  const invalidate = useInvalidateTasks();
  const open = !task.project && ['inbox', 'now', 'backlog', 'waiting'].includes(task.status);
  const q = useGetTaskProjectSuggestions(task.id, { query: { queryKey: getGetTaskProjectSuggestionsQueryKey(task.id), enabled: open, staleTime: 60_000 } });
  const [busy, setBusy] = useState(false);
  const projects = open ? (q.data?.projects ?? []) : [];
  if (!projects.length) return null;
  const pick = async (id: number, name: string) => {
    setBusy(true);
    try {
      await updateTask(task.id, { projectId: id });
      invalidate(task.id);
      notify('Project set', name);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" aria-label="Suggested projects" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} data-testid={'chips-project-' + task.id}>
      <span style={{ fontSize: 12, opacity: 0.75 }}>Project?</span>
      {projects.map((p) => (
        <button key={p.id} type="button" className="oo-tapchip" disabled={busy} onClick={() => void pick(p.id, p.name)} data-testid={`button-suggest-project-${p.id}`}>
          {p.name}
        </button>
      ))}
    </div>
  );
}

/** Section 27: a Waiting on task that has waited long enough. Chase it, or leave it a few more days. */
export function ChaseCard({ task, busy, onMessage }: { task: Task; busy: boolean; onMessage?: () => void }) {
  const invalidate = useInvalidateTasks();
  const actions = useTaskActions();
  const [acting, setActing] = useState(false);
  if (task.status !== 'waiting' || !task.chaseDue) return null;
  const who = task.waitingOn?.name.split(/\s+/)[0] ?? 'them';
  const later = async (after?: () => Promise<unknown>) => {
    setActing(true);
    try {
      if (after) await after();
      await chaseTaskLater(task.id);
      invalidate(task.id);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setActing(false);
    }
  };
  return (
    <div className="oo-source" style={{ gap: 10 }} data-testid="card-chase">
      <span style={{ fontSize: 13, fontWeight: 500 }}>Time to chase {who}?</span>
      <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>
        You have been waiting{task.waitingSince ? ` since ${formatDayMonth(task.waitingSince)}` : ` over ${CHASE_AFTER_DAYS} days`}.
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="oo-btn oo-btn-ink" disabled={busy || acting} onClick={() => void later(() => actions.copyChase(task))} data-testid="button-chase-copy">Copy a chase line</button>
        {onMessage && <button type="button" className="oo-btn oo-btn-outline" disabled={busy || acting} onClick={onMessage} data-testid="button-chase-slack">Message on Slack</button>}
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy || acting} onClick={() => void later()} data-testid="button-chase-later">Not yet</button>
      </div>
    </div>
  );
}

const STUCK_TITLE: Record<string, string> = { first_step: 'Try a first step', split: 'Try splitting it', delegate: 'Try handing it on', drop: 'Could this be dropped?' };

/** Section 27: the stuck-task coach's line on a task that keeps slipping. */
export function StuckCard({ task, busy, onDrop }: { task: Task; busy: boolean; onDrop: () => void }) {
  const invalidate = useInvalidateTasks();
  const [acting, setActing] = useState(false);
  const h = task.stuckHint;
  if (!h) return null;
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setActing(true);
    try {
      await fn();
      invalidate(task.id);
      if (done) notify(done);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setActing(false);
    }
  };
  const addStep = () =>
    run(async () => {
      const step = { id: 's' + Date.now().toString(36), title: h.step!, done: false };
      await updateTask(task.id, { steps: [step, ...(task.steps ?? [])] });
      await dismissTaskStuckHint(task.id);
    }, 'Added to its checklist');
  return (
    <div className="oo-source" style={{ gap: 10 }} data-testid="card-stuck">
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <span className="oo-pill" data-tone="stale">Stuck</span>
        <span className="oo-muted" style={{ fontSize: 12 }} data-testid="text-stuck-why">{h.why}</span>
      </span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{STUCK_TITLE[h.kind] ?? 'Something to try'}</span>
      <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }} data-testid="text-stuck-suggestion">{h.suggestion}</span>
      {h.step && <span style={{ fontSize: 13 }}>First step: {h.step}</span>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {h.step && <button type="button" className="oo-btn oo-btn-ink" disabled={busy || acting} onClick={() => void addStep()} data-testid="button-stuck-add-step">Add as first step</button>}
        {h.kind === 'drop' && <button type="button" className="oo-btn oo-btn-ink" disabled={busy || acting} onClick={onDrop} data-testid="button-stuck-drop">Drop it</button>}
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy || acting} onClick={() => void run(() => dismissTaskStuckHint(task.id))} data-testid="button-stuck-dismiss">Not stuck</button>
      </div>
    </div>
  );
}
