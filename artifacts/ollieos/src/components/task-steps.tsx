import { useEffect, useRef, useState } from 'react';
import { updateTask, type Task, type TaskStep } from '@workspace/api-client-react';
import { IconCheck, IconClose, IconDown, IconUp } from '@/components/icons';
import { useInvalidateTasks } from '@/lib/task-cache';
import { notify } from '@/lib/notify';

const MAX_STEPS = 50;

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * The checklist on a task. Every change saves the whole list. Ticking the last open step
 * asks whether the task itself is done.
 */
export function TaskSteps({ task, onAllDone }: { task: Task; onAllDone: () => void }) {
  const invalidate = useInvalidateTasks();
  const [steps, setSteps] = useState<TaskStep[]>(task.steps ?? []);
  const [adding, setAdding] = useState('');
  const [askDone, setAskDone] = useState(false);
  const saved = useRef(JSON.stringify(task.steps ?? []));
  const addRef = useRef<HTMLInputElement>(null);

  // Follow the server when it changes underneath (another tab, Claude, an Undo).
  useEffect(() => {
    const incoming = JSON.stringify(task.steps ?? []);
    if (incoming !== saved.current) {
      saved.current = incoming;
      setSteps(task.steps ?? []);
    }
  }, [task.steps]);
  useEffect(() => setAskDone(false), [task.id]);

  const commit = async (next: TaskStep[]) => {
    const before = steps;
    setSteps(next);
    saved.current = JSON.stringify(next);
    try {
      await updateTask(task.id, { steps: next });
      invalidate(task.id);
    } catch {
      setSteps(before);
      saved.current = JSON.stringify(before);
      notify('That did not save', 'Try again in a moment.');
    }
  };

  const toggle = (id: string) => {
    const next = steps.map((s) => (s.id === id ? { ...s, done: !s.done } : s));
    const ticked = next.find((s) => s.id === id)?.done;
    void commit(next);
    setAskDone(Boolean(ticked && next.every((s) => s.done) && task.status !== 'done'));
  };
  const rename = (id: string, title: string) => {
    const v = title.trim();
    const step = steps.find((s) => s.id === id);
    if (!step || v === step.title) return;
    if (!v) return void commit(steps.filter((s) => s.id !== id));
    void commit(steps.map((s) => (s.id === id ? { ...s, title: v } : s)));
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    void commit(next);
    // Keep focus on the same button as the row moves.
    setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="button-step-${by < 0 ? 'up' : 'down'}-${steps[i].id}"]`)?.focus(), 0);
  };
  const remove = (id: string) => void commit(steps.filter((s) => s.id !== id));
  const add = () => {
    const v = adding.trim();
    if (!v) return;
    if (steps.length >= MAX_STEPS) return notify('That is the most steps a task can have', `A task can have up to ${MAX_STEPS}.`);
    setAdding('');
    void commit([...steps, { id: newId(), title: v, done: false }]);
    setAskDone(false);
    addRef.current?.focus();
  };

  const done = steps.filter((s) => s.done).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="section-steps">
      <span className="oo-field-label" id="td-steps-l">
        Checklist{steps.length ? <span className="oo-num" data-testid="text-steps-count"> · {done} of {steps.length}</span> : null}
      </span>
      {steps.length > 0 && (
        <ol aria-labelledby="td-steps-l" className="oo-steps">
          {steps.map((s, i) => (
            <li key={s.id} className="oo-step" data-done={s.done} data-testid={'step-' + s.id}>
              <button type="button" className="oo-check" aria-pressed={s.done} aria-label={(s.done ? 'Mark not done: ' : 'Mark done: ') + s.title}
                onClick={() => toggle(s.id)} data-testid={'button-step-toggle-' + s.id}>
                <IconCheck size={11} strokeWidth={3} />
              </button>
              <StepTitle step={s} onSave={(v) => rename(s.id, v)} />
              <span className="oo-step-tools">
                <button type="button" className="oo-icon-btn" aria-label={'Move up: ' + s.title} disabled={i === 0} onClick={() => move(i, -1)} data-testid={'button-step-up-' + s.id}><IconUp size={13} /></button>
                <button type="button" className="oo-icon-btn" aria-label={'Move down: ' + s.title} disabled={i === steps.length - 1} onClick={() => move(i, 1)} data-testid={'button-step-down-' + s.id}><IconDown size={13} /></button>
                <button type="button" className="oo-icon-btn" aria-label={'Delete step: ' + s.title} onClick={() => remove(s.id)} data-testid={'button-step-delete-' + s.id}><IconClose size={12} /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {askDone && (
        <div className="oo-source" role="status" style={{ gap: 8 }} data-testid="card-steps-all-done">
          <span style={{ fontSize: 13, fontWeight: 500 }}>Every step is ticked. Mark the task done?</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="oo-btn oo-btn-ink" onClick={() => { setAskDone(false); onAllDone(); }} data-testid="button-steps-mark-done">Mark done</button>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => setAskDone(false)} data-testid="button-steps-not-yet">Not yet</button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <label htmlFor="td-step-add" className="oo-sr">Add a step</label>
        <input id="td-step-add" ref={addRef} className="oo-input" placeholder="Add a step" value={adding} maxLength={300}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          data-testid="input-step-add" />
        <button type="button" className="oo-btn oo-btn-outline" style={{ padding: '0 12px' }} disabled={!adding.trim()} onClick={add} data-testid="button-step-add">Add</button>
      </div>
    </div>
  );
}

/** A step's title, editable in place. Clearing it deletes the step. */
function StepTitle({ step, onSave }: { step: TaskStep; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(step.title);
  const cancelled = useRef(false);
  useEffect(() => setDraft(step.title), [step.title]);
  return (
    <>
      <label htmlFor={'step-title-' + step.id} className="oo-sr">Step</label>
      <input id={'step-title-' + step.id} className="oo-step-title" value={draft} maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setDraft(step.title); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={() => {
          if (cancelled.current) { cancelled.current = false; return; }
          onSave(draft);
        }}
        data-testid={'input-step-title-' + step.id} />
    </>
  );
}
