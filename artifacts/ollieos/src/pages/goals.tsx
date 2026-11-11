import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import {
  createGoal,
  updateGoal,
  updateTask,
  useListGoals,
  type GoalUpdate,
  type GoalView,
  type SubGoal,
  type UnlinkedTask,
} from '@workspace/api-client-react';
import { STATUS_LABELS, formatShort } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { InlineText } from '@/components/inline-text';
import { LockMark, PageProblem } from '@/components/knowledge/parts';
import { useKnowledgeWrite } from '@/lib/knowledge';

const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export default function GoalsPage() {
  const q = useListGoals();
  const [adding, setAdding] = useState(false);

  return (
    <main className="oo-panel oo-kmain oo-fade-in" style={{ maxWidth: 'none' }} data-testid="page-goals">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-eyebrow">Next 12 months</p>
          <h1 className="oo-h1">Goals</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-goals-line">
            {q.data ? (
              <>
                <span className="oo-serif" style={{ fontSize: 18, color: 'var(--oo-ink)' }}>{q.data.supporting} of {q.data.thisWeekTotal}</span> open tasks support a goal this week
              </>
            ) : (
              'Where this week’s work is going.'
            )}
          </p>
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link href="/strategy" className="oo-btn oo-btn-outline" data-testid="link-goals-strategy">Strategy and ideas</Link>
          <button type="button" className="oo-btn oo-btn-ink" onClick={() => setAdding(true)} data-testid="button-new-goal">New goal</button>
        </span>
      </div>

      {adding && <NewGoalForm onDone={() => setAdding(false)} />}

      {q.isLoading ? (
        <div aria-busy="true" className="oo-kgrid">{[0, 1, 2].map((i) => <Skel key={i} h={220} />)}</div>
      ) : !q.data ? (
        <PageProblem notFound={false} what="page" onRetry={() => q.refetch()} back={{ href: '/', label: 'Home' }} />
      ) : (
        <>
          {q.data.goals.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0 }} data-testid="state-goals-empty">No goals yet. Add the few things the next year is for, then link projects to them.</p>
          ) : (
            <div className="oo-kgrid" data-testid="list-goals">
              {q.data.goals.map((g) => <GoalCard key={g.id} goal={g} />)}
            </div>
          )}
          <UnlinkedWork tasks={q.data.unlinked} goals={q.data.goals} />
        </>
      )}
    </main>
  );
}

function GoalCard({ goal: g }: { goal: GoalView }) {
  const write = useKnowledgeWrite();
  const [addingSub, setAddingSub] = useState(false);
  const save = (patch: GoalUpdate, done?: string) => write(() => updateGoal(g.id, patch), { done });
  const projects = [...g.projects, ...g.subGoals.flatMap((s) => s.projects)];

  return (
    <article className="oo-kcard oo-goal" aria-labelledby={`goal-${g.id}-name`} data-testid={'card-goal-' + g.id}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <p className="oo-eyebrow" id={`goal-${g.id}-name`} style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <span className="oo-num">{pad(g.number)}</span>
          <InlineText inline value={g.name} label="Goal name" required maxLength={200} testId={`goal-${g.id}-name`} onSave={(v) => save({ name: v ?? g.name })} />
        </p>
        {g.confidential && (
          <span className="oo-pill" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} data-testid={`text-goal-${g.id}-confidential`}>
            <LockMark /> Confidential
          </span>
        )}
      </div>

      <h2 className="oo-goal-statement">
        <InlineText value={g.statement} label="Goal statement" multiline maxLength={2000} placeholder="What this goal is, in a sentence" testId={`goal-${g.id}-statement`} onSave={(v) => save({ statement: v })} />
      </h2>

      <div className="oo-goal-target">
        <span className="oo-muted" style={{ fontSize: 12 }}>Target</span>
        <InlineText value={g.targetText} label="Target" multiline maxLength={2000} placeholder="Add a target, for example a revenue figure" testId={`goal-${g.id}-target`} onSave={(v) => save({ targetText: v })} />
        {/* marginTop clears the switch's 10px tap area from the Target field above, so taps on the field never flip the switch. */}
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, marginTop: 10 }} className="oo-muted">
          <span data-testid={`text-goal-${g.id}-target-ai`}>{g.confidential ? 'Targets are hidden from AI' : 'AI can read this target'}</span>
          <button
            type="button"
            role="switch"
            className="oo-switch"
            data-tone="danger"
            aria-checked={g.confidential}
            aria-label={`Keep the ${g.name} target confidential`}
            onClick={() => save({ confidential: !g.confidential }, g.confidential ? 'AI can now read this target' : 'Target hidden from AI')}
            data-testid={`switch-goal-${g.id}-confidential`}
          />
        </span>
      </div>

      {(g.subGoals.length > 0 || addingSub) && (
        <ul className="oo-goal-subs" aria-label="Sub-goals">
          {g.subGoals.map((s) => <SubGoalRow key={s.id} sub={s} />)}
        </ul>
      )}
      {addingSub ? (
        <NewGoalForm parentId={g.id} onDone={() => setAddingSub(false)} />
      ) : (
        <div><button type="button" className="oo-textbtn" onClick={() => setAddingSub(true)} data-testid={`button-add-subgoal-${g.id}`}>Add a sub-goal</button></div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Linked projects">
        {projects.length === 0 ? (
          <span className="oo-muted" style={{ fontSize: 13 }}>No projects linked. Link one from its project page.</span>
        ) : (
          projects.map((p) => (
            <Link key={p.id} href={'/knowledge/projects/' + p.slug} className="oo-pchip" data-plain="true" style={{ textDecoration: 'none', color: 'inherit' }} data-testid={`chip-goal-${g.id}-project-${p.id}`}>
              {p.name}
            </Link>
          ))
        )}
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10, borderTop: '1px solid var(--oo-line-soft)' }}>
        <span style={{ fontSize: 14 }} data-testid={`text-goal-${g.id}-counts`}>
          <span className="oo-num">{plural(g.openTasks, 'open task')}</span> · <span className="oo-num">{g.dueThisWeek}</span> due this week
        </span>
        {g.openTasks === 0 && (
          <span className="oo-goal-warn" role="note" data-testid={`text-goal-${g.id}-warning`}>Nothing you’re doing this week moves this goal</span>
        )}
      </div>
    </article>
  );
}

function SubGoalRow({ sub }: { sub: SubGoal }) {
  const write = useKnowledgeWrite();
  return (
    <li data-testid={'row-subgoal-' + sub.id}>
      <InlineText inline value={sub.name} label="Sub-goal name" required maxLength={200} testId={`subgoal-${sub.id}-name`} onSave={(v) => write(() => updateGoal(sub.id, { name: v ?? sub.name }))} />
      {sub.projects.length > 0 && <span className="oo-muted"> · {sub.projects.map((p) => p.name).join(', ')}</span>}
    </li>
  );
}

function NewGoalForm({ parentId, onDone }: { parentId?: number; onDone: () => void }) {
  const write = useKnowledgeWrite();
  const [name, setName] = useState('');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const what = parentId ? 'sub-goal' : 'goal';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await write(
      () => createGoal({ name: name.trim(), statement: statement.trim() || null, parentId: parentId ?? null }),
      { done: parentId ? 'Sub-goal added' : 'Goal added. Its target is hidden from AI until you change that.', fail: `Could not add that ${what}` },
    );
    setBusy(false);
    if (ok) onDone();
  };
  const idp = parentId ? `subgoal-${parentId}` : 'goal';
  return (
    <form onSubmit={submit} className={parentId ? undefined : 'oo-kcard'} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={'form-new-' + idp}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <span>{parentId ? 'Sub-goal' : 'Goal name'}</span>
        <input className="oo-input" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} placeholder={parentId ? 'A part of this goal' : 'A broad goal'} data-testid={`input-new-${idp}-name`} />
      </label>
      {!parentId && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Statement <span className="oo-muted">(optional, AI can read it)</span></span>
          <textarea className="oo-textarea" rows={2} value={statement} maxLength={2000} onChange={(e) => setStatement(e.target.value)} data-testid="input-new-goal-statement" />
        </label>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="oo-btn oo-btn-ink" disabled={!name.trim() || busy} data-testid={`button-save-new-${idp}`}>Add {what}</button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onDone} data-testid={`button-cancel-new-${idp}`}>Cancel</button>
      </div>
    </form>
  );
}

function UnlinkedWork({ tasks, goals }: { tasks: UnlinkedTask[]; goals: GoalView[] }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState<number | null>(null);
  const assign = async (t: UnlinkedTask, goal: GoalView | null) => {
    setBusy(t.id);
    await write(() => updateTask(t.id, goal ? { goalId: goal.id } : { notGoalWork: true }), {
      done: goal ? `Linked to ${goal.name}` : 'Marked as not goal work. You won’t be asked about it again.',
    });
    setBusy(null);
  };

  return (
    <section aria-labelledby="unlinked-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="section-unlinked">
      <h2 id="unlinked-h" className="oo-h2">Work not linked to a goal</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Open tasks in Now or due this week with no goal, directly or through their project.</p>
      {tasks.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '8px 0' }} data-testid="state-unlinked-empty">Everything this week is linked to a goal or marked as not goal work.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {tasks.map((t) => (
            <li key={t.id} className="oo-krow" data-testid={'row-unlinked-' + t.id}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 260px' }}>
                <Link href={'/tasks?task=' + t.id} className="oo-krow-link" style={{ fontWeight: 500 }} data-testid={'link-unlinked-' + t.id}>{t.title}</Link>
                <span className="oo-muted" style={{ fontSize: 13 }}>
                  {[STATUS_LABELS[t.status as keyof typeof STATUS_LABELS] ?? t.status, t.project?.name, t.dueDate ? `due ${formatShort(t.dueDate)}` : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label={`Link ${t.title} to a goal`}>
                {goals.map((g) => (
                  <button key={g.id} type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy === t.id} onClick={() => assign(t, g)} data-testid={`button-assign-${t.id}-goal-${g.id}`}>
                    {g.name}
                  </button>
                ))}
                <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={busy === t.id} onClick={() => assign(t, null)} data-testid={`button-not-goal-${t.id}`}>
                  Not goal work
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
