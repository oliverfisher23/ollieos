import { useQueryClient } from '@tanstack/react-query';
import { dismissTaskEvidence, getListTaskEvidenceQueryKey, useListTaskEvidence, type Task, type TaskEvidence } from '@workspace/api-client-react';
import { formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const when = (at: string) => (londonDate(at) === todayLondon() ? formatTime(at) + ' today' : formatShort(at));
const SOURCE: Record<string, string> = { slack: 'Slack', email: 'Email', meeting: 'Meeting' };

function label(e: TaskEvidence): string {
  if (e.applied) return 'Closed the task';
  if (e.shows === 'progress') return 'Progress';
  if (e.dismissed) return 'You said not done';
  return 'Looks done';
}

/**
 * Part U: "Looks done" with Mark done and Not done, when evidence from elsewhere says an open task
 * is finished; and "What OllieOS has seen", the later messages that moved or closed it.
 */
export function TaskEvidencePanel({ task, busy, onMarkDone }: { task: Task; busy: boolean; onMarkDone: () => void }) {
  const qc = useQueryClient();
  const invalidate = useInvalidateTasks();
  const q = useListTaskEvidence(task.id, { query: { queryKey: getListTaskEvidenceQueryKey(task.id), staleTime: 15_000 } });
  const items = q.data ?? [];
  const marker = task.looksDone ? items.find((e) => e.shows === 'done' && !e.applied && !e.dismissed) : undefined;

  const notDone = async () => {
    if (!marker) return;
    try {
      const next = await dismissTaskEvidence(task.id, marker.id);
      qc.setQueryData(getListTaskEvidenceQueryKey(task.id), next);
      await invalidate();
      notify('Kept open', 'OllieOS will not mark it done from that message again.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    }
  };

  if (!task.looksDone && !items.length) return null;
  return (
    <>
      {task.looksDone && (
        <div className="oo-source" style={{ gap: 10 }} data-testid="card-looks-done">
          <span style={{ fontSize: 13, fontWeight: 500 }}>Looks done</span>
          <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }} data-testid="text-looks-done">{task.looksDone}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="oo-btn oo-btn-ink" disabled={busy} onClick={onMarkDone} data-testid="button-looks-done-mark">Mark done</button>
            <button type="button" className="oo-btn oo-btn-outline" disabled={busy || !marker} onClick={() => void notDone()} data-testid="button-looks-done-not">Not done</button>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="list-task-evidence">
          <span className="oo-field-label">What OllieOS has seen</span>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((e) => (
              <li key={e.id} className="oo-source" style={{ gap: 4 }} data-testid={'item-evidence-' + e.id}>
                <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12 }}>
                  <span className="oo-pill" data-tone={e.applied ? 'done' : undefined}>{label(e)}</span>
                  <span className="oo-muted">
                    {e.saidBy ?? 'Someone'}, {e.place ?? SOURCE[e.source] ?? e.source}, {when(e.saidAt)}
                  </span>
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.5 }}>"{e.quote}"</span>
                {e.url && (
                  <a href={e.url} target="_blank" rel="noreferrer" className="oo-link" style={{ fontSize: 12 }}>
                    Open in {SOURCE[e.source] === 'Meeting' ? 'Granola' : (SOURCE[e.source] ?? 'source')}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
