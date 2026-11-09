import { useEffect, useRef, useState } from 'react';
import {
  getTaskDraftPrompt,
  useGetTask,
  useListPeople,
  useListProjects,
  useUpdateTask,
  type TaskStatus,
  type TaskUpdate,
  type Priority,
} from '@workspace/api-client-react';
import { SOURCE_LABELS, formatDayMonth, formatShort, formatTime } from '@workspace/shared';
import { Skel, SourceMark } from '@/components/bits';
import { IconClose } from '@/components/icons';
import { NoiseRuleChooser } from '@/components/noise-rule-chooser';
import { TriStateAccess } from '@/components/knowledge/parts';
import { useInvalidateTasks } from '@/lib/task-cache';
import { useTaskActions } from '@/lib/task-actions';
import { notify } from '@/lib/notify';

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'now', label: 'Now' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'waiting', label: 'Waiting on' },
  { value: 'done', label: 'Done' },
];
const PRIOS: { value: Priority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

function actorName(a: string) {
  if (a === 'ollie') return 'Ollie';
  if (a === 'claude') return 'Claude';
  if (a === 'ingest') return 'the sweep';
  return a;
}

export function TaskDetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const detail = useGetTask(id);
  const people = useListPeople();
  const projects = useListProjects();
  const update = useUpdateTask();
  const invalidate = useInvalidateTasks();
  const actions = useTaskActions();
  const [acting, setActing] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [copying, setCopying] = useState(false);
  const initFor = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const task = detail.data?.task;

  useEffect(() => {
    if (task && initFor.current !== task.id) {
      initFor.current = task.id;
      setTitle(task.title);
      setNotes(task.notes ?? '');
    }
  }, [task]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id]);

  const save = (data: TaskUpdate, message?: string) => {
    update.mutate({ id, data }, {
      onSuccess: () => { invalidate(id); if (message) notify(message); },
      onError: () => notify('That did not save', 'Try again in a moment.'),
    });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setActing(true);
    await fn();
    setActing(false);
  };

  const setStatus = (status: TaskStatus) => {
    if (!task) return;
    if (status === 'done') return void run(() => actions.markDone(task));
    if (status === 'inbox') return save({ status }, 'Moved to Inbox');
    void run(() => actions.triage(task, { action: status }));
  };

  const copyDraft = async () => {
    setCopying(true);
    try {
      const res = await getTaskDraftPrompt(id);
      await navigator.clipboard.writeText(res.text);
      notify('Prompt copied');
    } catch {
      notify('Could not copy the prompt', 'Try again in a moment.');
    } finally {
      setCopying(false);
    }
  };

  return (
    <>
      <div className="oo-detail-scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={panelRef} tabIndex={-1} className="oo-detail oo-fade-in" aria-labelledby="td-title" data-testid="panel-task-detail" style={{ outline: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span className="oo-serif oo-muted" style={{ fontSize: 16 }}>Task</span>
          <button type="button" className="oo-close" aria-label="Close" onClick={onClose} data-testid="button-close-detail"><IconClose size={14} /></button>
        </div>

        {detail.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Skel h={26} w="85%" /><Skel h={40} /><Skel h={40} /><Skel h={90} /><Skel h={70} />
          </div>
        ) : detail.error || !task ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }} data-testid="state-detail-error">
            <p className="oo-muted" style={{ margin: 0 }}>Could not load this task.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => detail.refetch()} data-testid="button-retry-detail">Try again</button>
          </div>
        ) : (
          <>
            <h2 id="td-title" style={{ margin: 0 }}>
              <label htmlFor="td-title-input" className="oo-sr">Title</label>
              <textarea id="td-title-input" rows={2} className="oo-title-input" value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
                onBlur={() => {
                  const v = title.trim();
                  if (!v) setTitle(task.title);
                  else if (v !== task.title) save({ title: v });
                }}
                data-testid="input-task-title" />
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="oo-field-label" id="td-status-l">Status</span>
              <div role="group" aria-labelledby="td-status-l" className="oo-seg">
                {STATUSES.map((s) => (
                  <button key={s.value} type="button" aria-pressed={task.status === s.value}
                    onClick={() => task.status !== s.value && setStatus(s.value)} data-testid={'button-status-' + s.value}>{s.label}</button>
                ))}
              </div>
            </div>

            {task.status === 'noise' && (
              <div className="oo-source" style={{ gap: 10 }} data-testid="card-noise">
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  In Noise{task.noiseRule ? '' : ', moved there by hand'}
                </span>
                {task.noiseRule ? (
                  <span className="oo-soft" style={{ fontSize: 13 }} data-testid="text-detail-rule">Caught by the rule: {task.noiseRule.label}</span>
                ) : (
                  <NoiseRuleChooser task={task} />
                )}
                <div>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.restore(task))} data-testid="button-detail-restore">Restore to Inbox</button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="oo-field-label" id="td-prio-l">Priority</span>
                <div role="group" aria-labelledby="td-prio-l" style={{ display: 'flex', gap: 4 }}>
                  {PRIOS.map((p) => (
                    <button key={p.value} type="button" className="oo-prio" aria-pressed={task.priority === p.value} data-high={p.value === 'high'}
                      onClick={() => task.priority !== p.value && save({ priority: p.value })} data-testid={'button-priority-' + p.value}>{p.label}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-due" className="oo-field-label">Due{task.dueDate ? ' · ' + formatShort(task.dueDate) : ''}</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input id="td-due" type="date" className="oo-input" value={task.dueDate ?? ''}
                    onChange={(e) => save({ dueDate: e.target.value || null })} data-testid="input-due-date" />
                  {task.dueDate && <button type="button" className="oo-btn oo-btn-outline" style={{ padding: '0 10px' }} onClick={() => save({ dueDate: null })} data-testid="button-clear-due">Clear</button>}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-project" className="oo-field-label">Project</label>
                <select id="td-project" className="oo-input" value={task.project?.id ?? ''}
                  onChange={(e) => save({ projectId: e.target.value ? Number(e.target.value) : null })} data-testid="select-project">
                  <option value="">No project</option>
                  {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-person" className="oo-field-label">For</label>
                <select id="td-person" className="oo-input" value={task.person?.id ?? ''}
                  onChange={(e) => save({ personId: e.target.value ? Number(e.target.value) : null })} data-testid="select-person">
                  <option value="">Nobody in particular</option>
                  {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>

            {task.status === 'waiting' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-waiting" className="oo-field-label">Waiting on{task.waitingSince ? ' since ' + formatDayMonth(task.waitingSince) : ''}</label>
                <select id="td-waiting" className="oo-input" value={task.waitingOn?.id ?? ''}
                  onChange={(e) => save({ waitingOnPersonId: e.target.value ? Number(e.target.value) : null })} data-testid="select-waiting-on">
                  <option value="">Choose a person</option>
                  {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.copyChase(task))} data-testid="button-detail-chase">Copy chase line</button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="oo-field-label">Source</span>
              <div className="oo-source" data-testid="card-source">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, flexWrap: 'wrap' }}>
                  <SourceMark source={task.source} size={22} />
                  {SOURCE_LABELS[task.source]}
                  {task.sourceSubject ? ' · "' + task.sourceSubject + '"' : ''}
                  {' · ' + formatDayMonth(task.capturedAt ?? task.createdAt)}
                </span>
                {task.fromName && <span className="oo-muted" style={{ fontSize: 12 }}>From {task.fromName}</span>}
                {task.sourceQuote && <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>"{task.sourceQuote}"</span>}
                {task.sourceUrl && (
                  <a className="oo-link" href={task.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13 }} data-testid="link-source">
                    {task.source === 'email' ? 'Open in Superhuman' : 'Open source'}
                  </a>
                )}
              </div>
            </div>

            <TriStateAccess
              value={task.confidential ?? null}
              hidden={task.hiddenFromAi}
              parent="its project and people"
              testId="task-access"
              wide
              itemRef={'task:' + task.id}
              onChange={(v) =>
                save({ confidential: v }, v === true ? 'Marked confidential. Hidden from AI.' : v === false ? 'Readable by AI, whatever its links say' : 'Now follows its project and people')
              }
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="td-notes" className="oo-field-label">Notes</label>
              <textarea id="td-notes" rows={3} placeholder="Add notes" className="oo-input" style={{ resize: 'vertical', borderRadius: 'var(--oo-r-input-lg)', padding: '10px 12px' }}
                value={notes} onChange={(e) => setNotes(e.target.value)}
                onBlur={() => { if ((notes || null) !== (task.notes || null)) save({ notes: notes || null }, 'Notes saved'); }}
                data-testid="input-notes" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="oo-field-label">History</span>
              {detail.data!.history.length === 0 ? (
                <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>No history yet</p>
              ) : (
                <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }} className="oo-soft">
                  {detail.data!.history.map((h, i) => (
                    <li key={h.id} data-testid={'text-history-' + h.id}>
                      <span style={i === 0 ? { fontWeight: 500, color: 'var(--oo-ink)' } : undefined}>{h.summary}</span>
                      {' by ' + actorName(h.actor) + ' · '}
                      <span className="oo-num">{formatShort(h.createdAt)}, {formatTime(h.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 14, borderTop: '1px solid var(--oo-line-soft)' }}>
              <button type="button" className="oo-btn oo-btn-ink" disabled={task.status === 'done' || update.isPending || acting}
                onClick={() => run(() => actions.markDone(task))} data-testid="button-mark-done">{task.status === 'done' ? 'Done' : 'Mark done'}</button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={copying} onClick={copyDraft} data-testid="button-draft-prompt">Ask Claude to draft</button>
              {task.status === 'now' && (
                <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.snooze(task))} data-testid="button-detail-snooze">Snooze to tomorrow</button>
              )}
              <button type="button" className="oo-btn oo-btn-danger" disabled={task.status === 'noise' || acting}
                onClick={() => run(() => actions.triage(task, { action: 'noise' }))} data-testid="button-move-noise">Move to Noise</button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
