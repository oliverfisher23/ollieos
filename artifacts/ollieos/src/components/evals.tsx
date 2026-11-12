import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTaskTestCaseQueryKey,
  getListAgentsQueryKey,
  getListFeedbackQueryKey,
  getListTestCasesQueryKey,
  keepTaskTestCase,
  removeTestCase,
  replayTestCases,
  setFeedback,
  useGetTaskTestCase,
  useListFeedback,
  useListTestCases,
  type AgentView,
  type ReplayResult,
  type Task,
} from '@workspace/api-client-react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { formatShort } from '@workspace/shared';
import { Dropdown } from '@/components/dropdown';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

/**
 * Part X: "Keep as a test case" on an item a reader made. Shown when what the reader was given is
 * still kept (30 days). A case kept from an item in Noise or dropped expects nothing to be found.
 */
export function KeepTestCase({ task }: { task: Task }) {
  const qc = useQueryClient();
  const q = useGetTaskTestCase(task.id, { query: { queryKey: getGetTaskTestCaseQueryKey(task.id), staleTime: 60_000, enabled: task.createdBy === 'ollieos' } });
  const [busy, setBusy] = useState(false);
  const a = q.data;
  if (task.createdBy !== 'ollieos' || !a || (!a.available && !a.caseId)) return null;

  const keep = async (expected: 'task' | 'no_task') => {
    setBusy(true);
    try {
      await keepTaskTestCase(task.id, { expected });
      await qc.invalidateQueries({ queryKey: getGetTaskTestCaseQueryKey(task.id) });
      await qc.invalidateQueries({ queryKey: getListTestCasesQueryKey() });
      notify('Kept as a test case', expected === 'task' ? 'Replays will check the reader still finds this.' : 'Replays will check the reader no longer makes this.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oo-source" style={{ gap: 8 }} data-testid="card-test-case">
      <span style={{ fontSize: 13, fontWeight: 500 }}>Test case</span>
      <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>
        {a.caseId
          ? `Kept as a test case: the reader should ${a.expected === 'task' ? 'find this' : 'find nothing here'}.`
          : `Keep what the reader was given here, so a changed prompt or model can be checked against it. It ${a.expected === 'no_task' ? 'should have found nothing' : 'got this right'}?`}
      </span>
      {a.available && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => void keep(a.expected)} data-testid="button-keep-test-case">
            {a.caseId ? 'Update test case' : 'Keep as a test case'}
          </button>
          <button type="button" className="oo-btn oo-btn-quiet" disabled={busy} onClick={() => void keep(a.expected === 'task' ? 'no_task' : 'task')} data-testid="button-keep-test-case-other">
            {a.expected === 'task' ? 'Keep as "should find nothing"' : 'Keep as "should find a task"'}
          </button>
        </div>
      )}
    </div>
  );
}

const MODELS = [
  { value: '', label: 'Its usual model' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
];

/** Part X on the Agents page: a reader's test cases, the last replay, and Replay. */
export function AgentTests({ a }: { a: AgentView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const cases = useListTestCases({ agent: a.key }, { query: { queryKey: getListTestCasesQueryKey({ agent: a.key }), enabled: open } });
  const t = a.tests;
  if (!t) return null;

  const run = async () => {
    setBusy(true);
    try {
      const r = await replayTestCases({ agent: a.key, model: model || null });
      setResult(r);
      setOpen(true);
      await qc.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      await qc.invalidateQueries({ queryKey: getListTestCasesQueryKey({ agent: a.key }) });
    } catch (err) {
      reportApiError(err);
      notify('The replay did not run', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number) => {
    try {
      await removeTestCase(id);
      await qc.invalidateQueries({ queryKey: getListTestCasesQueryKey({ agent: a.key }) });
      await qc.invalidateQueries({ queryKey: getListAgentsQueryKey() });
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    }
  };

  const last = result ?? (t.lastReplay ? { ...t.lastReplay, failed: [] as ReplayResult['failed'] } : null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={'section-agent-tests-' + a.key}>
      <span style={{ fontSize: 13 }}>
        <span className="oo-soft">Test cases: </span>
        {t.cases === 0 ? <span className="oo-muted">none yet. Keep one from an Inbox item it got wrong or right.</span> : <span>{t.cases}</span>}
        {last && (
          <span className="oo-muted" data-testid={'text-last-replay-' + a.key}>
            {`. Last replay: ${last.passed} of ${last.total} passed on ${MODELS.find((m) => m.value === last.model)?.label ?? last.model}, ${formatShort(last.at)}`}
          </span>
        )}
      </span>
      {t.cases > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Dropdown value={model} onChange={setModel} options={MODELS} ariaLabel="Model to replay on" variant="compact" testId={'dropdown-replay-model-' + a.key} />
          <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => void run()} data-testid={'button-replay-' + a.key}>
            {busy ? 'Replaying…' : 'Replay'}
          </button>
          <button type="button" className="oo-btn oo-btn-quiet" onClick={() => setOpen((o) => !o)} data-testid={'button-cases-' + a.key}>
            {open ? 'Hide cases' : 'Show cases'}
          </button>
        </div>
      )}
      {result && result.previous && result.previous.passed / Math.max(1, result.previous.total) > result.passed / Math.max(1, result.total) && (
        <span style={{ fontSize: 13, color: 'var(--oo-danger)' }} data-testid={'text-replay-worse-' + a.key}>
          Worse than the last replay ({result.previous.passed} of {result.previous.total}).
        </span>
      )}
      {open && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={'list-cases-' + a.key}>
          {(cases.data ?? []).map((c) => (
            <li key={c.id} style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }} data-testid={'item-case-' + c.id}>
              {c.lastResult && <span className="oo-pill" data-tone={c.lastResult.passed ? 'done' : 'dropped'}>{c.lastResult.passed ? 'Passed' : 'Failed'}</span>}
              <span>{c.title}</span>
              {c.lastResult && !c.lastResult.passed && (
                <span className="oo-muted">found {c.lastResult.got.length ? c.lastResult.got.join('; ') : 'nothing'}</span>
              )}
              <button type="button" className="oo-btn oo-btn-quiet" style={{ fontSize: 12 }} onClick={() => void remove(c.id)} data-testid={'button-remove-case-' + c.id}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Part Y on the Agents page: a writer's code checks, weekly grade and thumbs. */
export function WriterScores({ a }: { a: AgentView }) {
  const w = a.writing;
  if (!w || (!w.checks.total && !w.grade.count && !w.thumbs.up && !w.thumbs.down)) return null;
  const failed = w.checks.total - w.checks.passed;
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }} data-testid={'list-writer-scores-' + a.key}>
      {w.checks.total > 0 && (
        <li style={{ fontSize: 13 }} data-testid={'text-writer-checks-' + a.key}>
          <span className="oo-soft">Checks passed: </span>
          <span style={{ fontWeight: 600, color: failed ? 'var(--oo-danger)' : undefined }}>{w.checks.passed} of {w.checks.total}</span>
          {w.checks.lastIssues.length > 0 && <span className="oo-muted"> ({w.checks.lastIssues.join('; ')})</span>}
        </li>
      )}
      {w.grade.count > 0 && (
        <li style={{ fontSize: 13 }} data-testid={'text-writer-grade-' + a.key}>
          <span className="oo-soft">Graded: </span>
          <span style={{ fontWeight: 600 }}>{w.grade.average} out of 5</span>
          <span className="oo-muted"> on {w.grade.count}</span>
          {w.grade.lowest && w.grade.lowest.score <= 3 && <span className="oo-muted">. Lowest {w.grade.lowest.score}: {w.grade.lowest.reason}</span>}
        </li>
      )}
      {w.thumbs.up + w.thumbs.down > 0 && (
        <li style={{ fontSize: 13 }} data-testid={'text-writer-thumbs-' + a.key}>
          <span className="oo-soft">Your thumbs: </span>
          {w.thumbs.up} up, <span style={{ color: w.thumbs.down ? 'var(--oo-danger)' : undefined }}>{w.thumbs.down} down</span>
        </li>
      )}
    </ul>
  );
}

/** Part Y: thumbs up or down on an Ask answer, a meeting brief or a digest. A second press clears it. */
export function Thumbs({ subject, label = 'Was this useful?', dark = false }: { subject: string; label?: string; dark?: boolean }) {
  const qc = useQueryClient();
  const params = { subjects: subject };
  const q = useListFeedback(params, { query: { queryKey: getListFeedbackQueryKey(params), staleTime: 60_000 } });
  const current = q.data?.[0]?.thumb ?? null;
  const [busy, setBusy] = useState(false);
  const press = async (t: 'up' | 'down') => {
    setBusy(true);
    try {
      const next = await setFeedback({ subject, thumb: current === t ? null : t });
      qc.setQueryData(getListFeedbackQueryKey(params), [next]);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} data-testid={'thumbs-' + subject}>
      <span className={dark ? undefined : 'oo-muted'} style={{ fontSize: 12, color: dark ? 'var(--oo-text-on-dark-2)' : undefined }}>{label}</span>
      <button type="button" className={dark ? 'oo-btn oo-btn-ghost' : 'oo-btn oo-btn-quiet'} aria-pressed={current === 'up'} aria-label="Thumbs up" disabled={busy} onClick={() => void press('up')} data-active={current === 'up' ? 'true' : undefined} style={{ padding: '2px 8px' }} data-testid={'button-thumb-up-' + subject}>
        <ThumbsUp size={14} fill={current === 'up' ? 'currentColor' : 'none'} />
      </button>
      <button type="button" className={dark ? 'oo-btn oo-btn-ghost' : 'oo-btn oo-btn-quiet'} aria-pressed={current === 'down'} aria-label="Thumbs down" disabled={busy} onClick={() => void press('down')} data-active={current === 'down' ? 'true' : undefined} style={{ padding: '2px 8px' }} data-testid={'button-thumb-down-' + subject}>
        <ThumbsDown size={14} fill={current === 'down' ? 'currentColor' : 'none'} />
      </button>
    </span>
  );
}
