import { useState } from 'react';
import { Link } from 'wouter';
import {
  runPlaybook,
  useGetPlaybookUsage,
  useListOrganisations,
  useListPeople,
  useListProjects,
  type Playbook,
} from '@workspace/api-client-react';
import { formatShort, todayLondon } from '@workspace/shared';
import { Dropdown } from '@/components/dropdown';
import { orgOptions, personOptions, projectOptions } from '@/components/dropdown-options';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

type TargetType = 'person' | 'organisation' | 'project';

/** Part L: "Run this playbook" for a person, organisation or project. */
export function RunPlaybook({ playbook }: { playbook: Playbook }) {
  const invalidate = useInvalidateTasks();
  const people = useListPeople();
  const orgs = useListOrganisations();
  const projects = useListProjects();
  const [type, setType] = useState<TargetType>('project');
  const [targetId, setTargetId] = useState('');
  const [mode, setMode] = useState<'tasks' | 'checklist'>('tasks');
  const [start, setStart] = useState(todayLondon());
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<number[] | null>(null);

  const options =
    type === 'person'
      ? personOptions(people.data)
      : type === 'organisation'
        ? orgOptions(orgs.data)
        : projectOptions(projects.data);

  const run = async () => {
    if (!targetId) return;
    setBusy(true);
    try {
      const r = await runPlaybook(playbook.id, { target: { type, id: Number(targetId) }, mode, start });
      setMade(r.taskIds);
      await invalidate();
      notify(mode === 'checklist' ? 'Task made' : `${r.taskIds.length} tasks made`, `From "${playbook.title}".`);
    } catch (err) {
      reportApiError(err);
      notify('Could not run it', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!playbook.steps.length) return null;
  return (
    <section aria-labelledby="pbk-run-h" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '72ch' }} data-testid="section-run-playbook">
      <h2 id="pbk-run-h" className="oo-h2">Run this playbook</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Makes the steps into tasks for who or what it is for, dated from the start day by each step's days after starting. A step someone else does becomes a Waiting on task.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Dropdown value={type} onChange={(v) => { setType(v as TargetType); setTargetId(''); }} options={[{ value: 'project', label: 'A project' }, { value: 'person', label: 'A person' }, { value: 'organisation', label: 'An organisation' }]} ariaLabel="Run it for" variant="compact" testId="select-run-type" />
        <Dropdown value={targetId} onChange={setTargetId} options={options} placeholder="Choose…" ariaLabel="Which one" variant="compact" searchable={options.length >= 8} testId="select-run-target" />
        <Dropdown value={mode} onChange={(v) => setMode(v as 'tasks' | 'checklist')} options={[{ value: 'tasks', label: 'Separate tasks' }, { value: 'checklist', label: 'One task with a checklist' }]} ariaLabel="How" variant="compact" testId="select-run-mode" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span className="oo-muted">Starting</span>
          <input type="date" className="oo-input" style={{ width: 'auto' }} value={start} onChange={(e) => setStart(e.target.value)} data-testid="input-run-start" />
        </label>
        <button type="button" className="oo-btn oo-btn-ink" disabled={busy || !targetId} onClick={() => void run()} data-testid="button-run-playbook">{busy ? 'Running…' : 'Run'}</button>
      </div>
      {made && made.length > 0 && (
        <p className="oo-soft" style={{ margin: 0, fontSize: 13 }} data-testid="text-run-made">
          Made {made.length === 1 ? 'a task' : `${made.length} tasks`}. <Link href={'/tasks?task=' + made[0]} className="oo-link">Open the first</Link>
        </p>
      )}
    </section>
  );
}

/** Part L: how often a playbook reached an AI, and the last 10 times. */
export function PlaybookUsage({ id }: { id: number }) {
  const q = useGetPlaybookUsage(id);
  const u = q.data;
  if (!u) return null;
  return (
    <section aria-labelledby="pbk-use-h" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '72ch' }} data-testid="section-playbook-usage">
      <h2 id="pbk-use-h" className="oo-h2">Where it was used</h2>
      <p style={{ margin: 0, fontSize: 14 }}>
        {u.count === 0 ? 'Not used by any AI yet.' : `Used ${u.count === 1 ? 'once' : `${u.count} times`}, last on ${formatShort(u.lastUsedAt!)}.`}
        {u.unused && <span className="oo-pill" data-tone="stale" style={{ marginLeft: 8 }}>Not used in 90 days</span>}
      </p>
      {u.recent.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }} className="oo-soft">
          {u.recent.map((r, i) => <li key={i}>{formatShort(r.at)}: {r.via ?? 'read'} by {r.by}</li>)}
        </ul>
      )}
    </section>
  );
}
