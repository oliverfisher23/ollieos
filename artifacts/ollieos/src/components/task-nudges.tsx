import { useState } from 'react';
import {
  chaseTaskLater,
  createPerson,
  dismissTaskStuckHint,
  getGetTaskPersonSuggestionsQueryKey,
  undoTaskAutoSet,
  updatePerson,
  updateTask,
  useGetTaskPersonSuggestions,
  useGetTaskProjectSuggestions,
  getGetTaskProjectSuggestionsQueryKey,
  type Task,
} from '@workspace/api-client-react';
import { CHASE_AFTER_DAYS, addDays, formatDayMonth, formatShort, todayLondon, weekStartOf } from '@workspace/shared';
import { useInvalidateTasks } from '@/lib/task-cache';
import { useTaskActions } from '@/lib/task-actions';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

type AutoField = 'project' | 'due' | 'person' | 'waitingOn';

/**
 * Section 30, Part H: under a field OllieOS filled in by itself. Undo clears it, and OllieOS does not
 * fill that field on this task again. Changing the field by hand makes the note go: it is Ollie's then.
 */
export function AutoSetNote({ task, field }: { task: Pick<Task, 'id' | 'autoSet'>; field: AutoField }) {
  const invalidate = useInvalidateTasks();
  const [busy, setBusy] = useState(false);
  if (task.autoSet?.[field] !== 'set') return null;
  const undo = async () => {
    setBusy(true);
    try {
      await undoTaskAutoSet(task.id, { field });
      invalidate(task.id);
      notify('Undone', 'OllieOS will not fill this in again on this task.');
    } catch (err) {
      reportApiError(err);
      notify('That did not undo', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="oo-muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 8 }} data-testid={`note-auto-${field}-${task.id}`}>
      Set by OllieOS
      <button type="button" className="oo-link" style={{ font: 'inherit', background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
        disabled={busy} onClick={() => void undo()} data-testid={`button-auto-undo-${field}-${task.id}`}>
        Undo
      </button>
    </span>
  );
}

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

/**
 * Section 28: closing the gaps name matching leaves on a task. "Which Paul?" when the name fits
 * several contacts, "Add Kevin to Contacts" when it fits none, and "Remember Volodymyr as another
 * name for Vova" when the title names the Waiting on person differently.
 */
export function PersonSuggestChips({ task, slot }: { task: Pick<Task, 'id' | 'status' | 'person' | 'waitingOn'>; slot: 'person' | 'waitingOn' }) {
  const invalidate = useInvalidateTasks();
  const open = ['inbox', 'now', 'backlog', 'waiting'].includes(task.status);
  const key = getGetTaskPersonSuggestionsQueryKey(task.id);
  const q = useGetTaskPersonSuggestions(task.id, { query: { queryKey: [...key, task.person?.id ?? 0, task.waitingOn?.id ?? 0], enabled: open, staleTime: 60_000 } });
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [remembered, setRemembered] = useState(false);
  const s = open ? q.data : undefined;
  if (!s) return null;
  const run = async (fn: () => Promise<unknown>, done: string, detail?: string) => {
    setBusy(true);
    try {
      await fn();
      invalidate(task.id);
      notify(done, detail);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const link = (personId: number) => updateTask(task.id, slot === 'waitingOn' ? { waitingOnPersonId: personId } : { personId });

  // The title names who Ollie waits on in a way their contact does not know yet.
  if (slot === 'waitingOn' && s.remember && !remembered) {
    const r = s.remember;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} data-testid={'chips-remember-' + task.id}>
        <button type="button" className="oo-tapchip" disabled={busy}
          onClick={() => void run(() => updatePerson(r.person.slug, { otherNames: [...r.otherNames, r.name] }), 'Remembered', `"${r.name}" now finds ${r.person.name}.`).then(() => setRemembered(true))}
          data-testid="button-remember-name">
          Remember "{r.name}" as another name for {r.person.name.split(/\s+/)[0]}
        </button>
      </div>
    );
  }
  if (s.slot !== slot || !s.name) return null;
  const first = s.name.split(/\s+/)[0];
  return (
    <div role="group" aria-label={`Who is ${s.name}?`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} data-testid={'chips-person-' + task.id}>
      {s.people.length > 0 && (
        <>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{s.people.length > 1 ? `Which ${first}?` : `${first}?`}</span>
          {s.people.map((p) => (
            <button key={p.id} type="button" className="oo-tapchip" disabled={busy} onClick={() => void run(() => link(p.id), slot === 'waitingOn' ? 'Waiting on set' : 'Person set', p.name)} data-testid={`button-suggest-person-${p.id}`}>
              {p.name}
            </button>
          ))}
        </>
      )}
      {s.canAdd && !adding && (
        <button type="button" className="oo-tapchip" disabled={busy} onClick={() => { setName(s.name ?? ''); setAdding(true); }} data-testid="button-add-contact">
          Add {s.name} to Contacts
        </button>
      )}
      {adding && (
        <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%' }}
          onSubmit={(e) => {
            e.preventDefault();
            const full = name.trim();
            if (!full) return;
            void run(async () => { const p = await createPerson({ name: full }); await link(p.id); }, 'Added to Contacts', full).then(() => setAdding(false));
          }}>
          <label htmlFor={'add-contact-' + task.id} className="oo-sr">Their full name</label>
          <input id={'add-contact-' + task.id} className="oo-input" autoFocus value={name} maxLength={200} placeholder="Full name" onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} style={{ flex: '1 1 160px', minWidth: 0 }} data-testid="input-add-contact" />
          <button type="submit" className="oo-btn oo-btn-ink oo-btn-sm" disabled={busy || !name.trim()} data-testid="button-save-contact">Add</button>
          <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

/** The one-tap dates offered for a task with none: the reader's guess first, then the usual ones. */
export function dueChoices(suggested: string | null | undefined, today = todayLondon()): { date: string; label: string; suggested?: boolean }[] {
  const monday = weekStartOf(today);
  const friday = addDays(monday, 4);
  const out: { date: string; label: string; suggested?: boolean }[] = [];
  if (suggested && suggested >= today) out.push({ date: suggested, label: `${formatShort(suggested)} (suggested)`, suggested: true });
  out.push({ date: today, label: 'Today' }, { date: addDays(today, 1), label: 'Tomorrow' });
  // Friday only when it is still ahead and not already Tomorrow.
  if (friday > addDays(today, 1)) out.push({ date: friday, label: 'Friday' });
  out.push({ date: addDays(monday, 7), label: 'Next week' });
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.date) && !!seen.add(c.date));
}

/** Section 28: one-tap due dates for an open task with none. */
export function DueChips({ task }: { task: Pick<Task, 'id' | 'dueDate' | 'suggestedDue' | 'status'> }) {
  const invalidate = useInvalidateTasks();
  const [busy, setBusy] = useState(false);
  if (task.dueDate || !['inbox', 'now', 'backlog', 'waiting'].includes(task.status)) return null;
  const pick = async (date: string) => {
    setBusy(true);
    try {
      await updateTask(task.id, { dueDate: date });
      invalidate(task.id);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="group" aria-label="Set a due date" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} data-testid={'chips-due-' + task.id}>
      <span style={{ fontSize: 12, opacity: 0.75 }}>Due?</span>
      {dueChoices(task.suggestedDue).map((c) => (
        <button key={c.date} type="button" className="oo-tapchip" data-suggested={c.suggested ? 'true' : undefined} disabled={busy} onClick={() => void pick(c.date)} data-testid={`button-due-${c.suggested ? 'suggested' : c.label.toLowerCase().replace(' ', '-')}-${task.id}`}>
          {c.label}
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
      await dismissTaskStuckHint(task.id, { used: true });
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
        {h.kind === 'drop' && (
          <button type="button" className="oo-btn oo-btn-ink" disabled={busy || acting}
            onClick={() => void run(() => dismissTaskStuckHint(task.id, { used: true })).then(onDrop)} data-testid="button-stuck-drop">Drop it</button>
        )}
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy || acting} onClick={() => void run(() => dismissTaskStuckHint(task.id, {}))} data-testid="button-stuck-dismiss">Not stuck</button>
      </div>
    </div>
  );
}
