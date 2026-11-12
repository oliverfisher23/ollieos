import { useEffect, useRef, useState } from 'react';
import {
  getTaskDraftPrompt,
  useGetTask,
  useListGoalOptions,
  useListPeople,
  useListProjects,
  useUpdateTask,
  type Task,
  type TaskStatus,
  type TaskUpdate,
  type Priority,
} from '@workspace/api-client-react';
import { SOURCE_LABELS, formatDayMonth, formatShort, formatTime, nextRepeatDate, repeatChoiceOf, repeatChoices, todayLondon, type RepeatRule } from '@workspace/shared';
import { Skel, SourceMark } from '@/components/bits';
import { IconClose } from '@/components/icons';
import { NoiseRuleChooser } from '@/components/noise-rule-chooser';
import { TriStateAccess } from '@/components/knowledge/parts';
import { useInvalidateTasks } from '@/lib/task-cache';
import { useTaskActions } from '@/lib/task-actions';
import { notify } from '@/lib/notify';
import { Dropdown } from '@/components/dropdown';
import { ReplyDraftCard } from '@/components/reply-draft';
import { TaskSteps } from '@/components/task-steps';
import { TaskEvidencePanel } from '@/components/task-evidence';
import { KeepTestCase } from '@/components/evals';
import { SlackDm } from '@/components/slack-dm';
import { DropReasonChips, madeByReader } from '@/components/drop-reason';
import { ChaseCard, DueChips, PersonSuggestChips, ProjectSuggestChips, StuckCard } from '@/components/task-nudges';
import { goalOptions, personOptions, projectOptions } from '@/components/dropdown-options';

const STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'now', label: 'Now' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'waiting', label: 'Waiting on' },
  { value: 'done', label: 'Done' },
  { value: 'dropped', label: 'Dropped' },
  { value: 'archived', label: 'Archived' },
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
  const goals = useListGoalOptions();
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
    void run(() => actions.setStatus(task, status));
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

            {task.noiseHint && (
              <div className="oo-source" style={{ gap: 10 }} data-testid="card-noise-hint">
                <span style={{ fontSize: 13, fontWeight: 500 }}>Probably noise</span>
                <span className="oo-soft" style={{ fontSize: 13 }} data-testid="text-detail-noise-hint">{task.noiseHint}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.keep(task))} data-testid="button-detail-keep">Keep</button>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.triage(task, { action: 'noise' }))} data-testid="button-detail-hint-noise">Move to Noise</button>
                </div>
              </div>
            )}

            <ChaseCard task={task} busy={acting} />
            <StuckCard task={task} busy={acting} onDrop={() => setStatus('dropped')} />

            <TaskEvidencePanel task={task} busy={acting} onMarkDone={() => setStatus('done')} />

            {!['done', 'noise', 'dropped', 'archived'].includes(task.status) && <SlackDm task={task} />}

            <KeepTestCase task={task} />

            {task.status === 'dropped' && (
              <div className="oo-source" style={{ gap: 10 }} data-testid="card-dropped">
                <span style={{ fontSize: 13, fontWeight: 500 }}>Dropped. It is off your lists, and AI treats it as closed.</span>
                {madeByReader(task) && <DropReasonChips key={'why' + task.id + (task.dropReason ?? '')} task={task} />}
                <div>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.restore(task))} data-testid="button-detail-restore-dropped">Restore to Inbox</button>
                </div>
              </div>
            )}

            {task.status === 'archived' && (
              <div className="oo-source" style={{ gap: 10 }} data-testid="card-archived">
                <span style={{ fontSize: 13, fontWeight: 500 }}>Archived. Kept for later, and left out of your counts, Do next and the digest.</span>
                <div>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={acting} onClick={() => run(() => actions.restore(task))} data-testid="button-detail-restore-archived">Restore to Backlog</button>
                </div>
              </div>
            )}

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
            <DueChips task={task} />

            <RepeatField task={task} onSave={save} />

            <TaskSteps task={task} onAllDone={() => run(() => actions.markDone(task))} />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-project" className="oo-field-label">Project</label>
                <Dropdown id="td-project" value={String(task.project?.id ?? '')}
                  onChange={(v) => save({ projectId: v ? Number(v) : null })} testId="select-project" searchPlaceholder="Search projects"
                  options={[{ value: '', label: 'No project' }, ...projectOptions(projects.data)]} />
                <ProjectSuggestChips task={task} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-person" className="oo-field-label">For</label>
                <Dropdown id="td-person" value={String(task.person?.id ?? '')}
                  onChange={(v) => save({ personId: v ? Number(v) : null })} testId="select-person" searchPlaceholder="Search people"
                  options={[{ value: '', label: 'Nobody in particular' }, ...personOptions(people.data)]} />
                {task.status !== 'waiting' && <PersonSuggestChips task={task} slot="person" />}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="td-goal" className="oo-field-label">Goal</label>
              <Dropdown id="td-goal"
                value={task.notGoalWork ? 'not' : task.goalId != null ? String(task.goalId) : ''}
                onChange={(v) => {
                  if (v === 'not') save({ goalId: null, notGoalWork: true }, 'Marked as not goal work');
                  else save({ goalId: v ? Number(v) : null, notGoalWork: false });
                }}
                testId="select-task-goal" searchPlaceholder="Search goals"
                options={[
                  { value: '', label: task.goal?.inherited ? `From its project: ${task.goal.name}` : 'No goal' },
                  ...goalOptions(goals.data),
                  { value: 'not', label: 'Not goal work', group: '' },
                ]} />
            </div>

            {task.status === 'waiting' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="td-waiting" className="oo-field-label">Waiting on{task.waitingSince ? ' since ' + formatDayMonth(task.waitingSince) : ''}</label>
                <Dropdown id="td-waiting" value={String(task.waitingOn?.id ?? '')}
                  onChange={(v) => save({ waitingOnPersonId: v ? Number(v) : null })} testId="select-waiting-on" searchPlaceholder="Search people"
                  options={[{ value: '', label: 'Choose a person' }, ...personOptions(people.data)]} />
                <PersonSuggestChips task={task} slot="waitingOn" />
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
                    {sourceLinkLabel(task.source, task.sourceUrl)}
                  </a>
                )}
              </div>
            </div>

            {task.source === 'email' && <ReplyDraftCard key={task.id} taskId={task.id} />}

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

/** How the task repeats. The choices follow its due date, so "the second Tuesday" means the one it is due on. */
function RepeatField({ task, onSave }: { task: Task; onSave: (data: TaskUpdate, message?: string) => void }) {
  const today = todayLondon();
  const anchor = task.dueDate ?? today;
  const rule = task.repeat as RepeatRule | null;
  const closed = task.status === 'done' || task.status === 'dropped' || task.status === 'archived' || task.status === 'noise';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor="td-repeat" className="oo-field-label">Repeats</label>
      <Dropdown id="td-repeat" value={repeatChoiceOf(rule)} searchable={false} testId="select-repeat"
        onChange={(v) => {
          if (!v) return onSave({ repeat: null }, 'Stopped repeating');
          const repeat = v === 'month_weekday' ? { every: 'month' as const, byWeekday: true } : { every: v as RepeatInputEvery };
          onSave({ repeat }, task.dueDate ? 'Repeat set' : 'Repeat set, starting today');
        }}
        options={[{ value: '', label: 'Does not repeat' }, ...repeatChoices(anchor)]} />
      {rule && (
        <span className="oo-muted" style={{ fontSize: 12 }} data-testid="text-repeat-next">
          {task.status === 'done'
            ? 'Ticked off. The next one is in your Backlog.'
            : closed
              ? 'No new copies are made while it is closed.'
              : `When you tick it off, the next one goes in your Backlog, due ${formatShort(nextRepeatDate(rule, task.dueDate, today))}.`}
        </span>
      )}
    </div>
  );
}

type RepeatInputEvery = NonNullable<TaskUpdate['repeat']>['every'];

/** Says where the link goes: Gmail links come from OllieOS's own reader, Superhuman ones from the Claude sweep. */
function sourceLinkLabel(source: string, url: string): string {
  if (url.includes('mail.google.com')) return 'Open in Gmail';
  if (url.includes('superhuman.com')) return 'Open in Superhuman';
  if (source === 'slack' || url.includes('slack.com')) return 'Open in Slack';
  return source === 'email' ? 'Open email' : 'Open source';
}
