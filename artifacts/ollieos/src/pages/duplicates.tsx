import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  checkTaskDuplicates,
  dismissTaskDuplicate,
  mergeTaskDuplicate,
  useListTaskDuplicates,
  type Task,
  type TaskDuplicatePair,
} from '@workspace/api-client-react';
import { PRIORITY_LABELS, STATUS_LABELS, formatShort } from '@workspace/shared';
import { Skel, SourceLabel } from '@/components/bits';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';
import { useInvalidateTasks } from '@/lib/task-cache';

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + 's'}`;

/**
 * Section 26: pairs of open tasks that look like the same piece of work. Keep one and the other is
 * dropped, with where it came from added to the kept task; or say they are not the same.
 */
export default function DuplicatesPage() {
  const q = useListTaskDuplicates();
  const qc = useQueryClient();
  const invalidate = useInvalidateTasks();
  const [checking, setChecking] = useState(false);
  const pairs = q.data?.pairs ?? [];

  const refresh = async () => {
    await invalidate();
    await qc.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? '').includes('/tasks/duplicates') });
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const r = await checkTaskDuplicates();
      notify(r.found ? `Found ${plural(r.found, 'pair')}` : 'No new duplicates', r.checked ? `Looked at ${plural(r.checked, 'pair')} with similar titles.` : 'No open tasks have similar titles.');
      await refresh();
    } catch (err) {
      reportApiError(err);
      notify('The check did not run', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-duplicates">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <h1 className="oo-h1">Duplicates</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
            Open tasks that look like the same piece of work, from different places. Keep one and the other goes to Dropped, with where it came from shown on the one you keep.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="oo-serif" style={{ fontSize: 22 }} data-testid="text-duplicates-count">{q.data ? plural(pairs.length, 'pair') : '…'}</span>
          <button type="button" className="oo-btn oo-btn-outline" disabled={checking} onClick={() => void checkNow()} data-testid="button-check-duplicates">
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>

      {q.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[0, 1].map((i) => <Skel key={i} h={120} />)}
        </div>
      ) : q.error ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load duplicates.</p>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()}>Try again</button>
        </div>
      ) : pairs.length === 0 ? (
        <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="state-duplicates-empty">
          <p className="oo-serif" style={{ margin: 0, fontSize: 20 }}>No duplicates waiting.</p>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>OllieOS checks your open tasks once a day. New items that match a task you already have are added to it instead.</p>
        </div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {pairs.map((p) => <PairCard key={p.id} pair={p} onDone={refresh} />)}
        </ul>
      )}
    </main>
  );
}

function PairCard({ pair, onDone }: { pair: TaskDuplicatePair; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, title: string, body: string) => {
    setBusy(true);
    try {
      await fn();
      notify(title, body);
      await onDone();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
      setBusy(false);
    }
  };
  const keep = (k: Task, other: Task) =>
    run(() => mergeTaskDuplicate(pair.id, { keep: k.id }), 'Merged', `Kept "${k.title}". "${other.title}" is in Dropped if you need it back.`);

  return (
    <li className="oo-dup" data-testid={'card-duplicate-' + pair.id}>
      {pair.reason && <p className="oo-serif" style={{ margin: 0, fontSize: 17 }} data-testid={'text-duplicate-reason-' + pair.id}>{pair.reason}</p>}
      <div className="oo-dup-pair">
        <Side task={pair.a} busy={busy} onKeep={() => void keep(pair.a, pair.b)} />
        <Side task={pair.b} busy={busy} onKeep={() => void keep(pair.b, pair.a)} />
      </div>
      <div>
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy}
          onClick={() => void run(() => dismissTaskDuplicate(pair.id), 'Kept both', 'OllieOS will not suggest these two again.')} data-testid={'button-not-same-' + pair.id}>
          Not the same
        </button>
      </div>
    </li>
  );
}

function Side({ task, busy, onKeep }: { task: Task; busy: boolean; onKeep: () => void }) {
  const quote = task.sourceQuote ?? task.snippet;
  return (
    <div className="oo-dup-side" data-testid={'dup-side-' + task.id}>
      <SourceLabel source={task.source} />
      <Link href={`/tasks?task=${task.id}`} className="oo-row-title" style={{ fontSize: 15, fontWeight: 500 }}>{task.title}</Link>
      <span className="oo-muted" style={{ fontSize: 13 }}>
        {[STATUS_LABELS[task.status], `${PRIORITY_LABELS[task.priority]} priority`, task.dueDate ? `due ${formatShort(task.dueDate)}` : null, task.fromName ? `from ${task.fromName}` : null]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {quote && <span className="oo-soft oo-mail-clamp" style={{ fontSize: 13, lineHeight: 1.5 }}>"{quote.replace(/\s+/g, ' ').slice(0, 220)}"</span>}
      <div style={{ marginTop: 'auto', paddingTop: 6 }}>
        <button type="button" className="oo-btn oo-btn-ink" disabled={busy} onClick={onKeep} data-testid={'button-keep-' + task.id}>Keep this one</button>
      </div>
    </div>
  );
}
