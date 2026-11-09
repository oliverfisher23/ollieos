import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  useGetTaskSummary,
  useListTasks,
  useUpdateTask,
  type ListTasksParams,
  type Task,
  type TaskSource,
  type TaskTab,
} from '@workspace/api-client-react';
import { SOURCE_LABELS, TASK_SOURCES, addDays, formatShort, formatWeekRange, todayLondon, weekStartOf } from '@workspace/shared';
import { PriorityPill, Skel, SourceLabel, SourceMark, StatusPill } from '@/components/bits';
import { IconCheck, IconLeft, IconRight, IconSearch } from '@/components/icons';
import { TaskDetailPanel } from '@/components/task-detail';
import { useInvalidateTasks } from '@/lib/task-cache';
import { notify } from '@/lib/notify';

const TABS: { value: TaskTab; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'open', label: 'All open' },
  { value: 'now', label: 'Now' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'waiting', label: 'Waiting on' },
  { value: 'done', label: 'Done' },
  { value: 'noise', label: 'Noise' },
];
const TAB_VALUES = TABS.map((t) => t.value) as string[];

const EMPTY: Record<TaskTab, string> = {
  inbox: 'Inbox is clear. New captures land here.',
  open: 'Nothing open. Add a task from Home.',
  now: 'Nothing in Now.',
  backlog: 'Backlog is empty.',
  waiting: 'Nobody is holding anything up.',
  done: 'Nothing done in this view yet.',
  noise: 'No noise filtered out.',
};

function useQueryState() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    setLocation('/tasks' + (qs ? '?' + qs : ''), { replace: true });
  };
  return { sp, set };
}

export default function TasksPage() {
  const { sp, set } = useQueryState();
  const rawTab = sp.get('tab') ?? 'open';
  const tab = (TAB_VALUES.includes(rawTab) ? rawTab : 'open') as TaskTab;
  const rawSource = sp.get('source');
  const source = rawSource && (TASK_SOURCES as readonly string[]).includes(rawSource) ? (rawSource as TaskSource) : undefined;
  const week = sp.get('week') || undefined;
  const undated = sp.get('undated') === '1';
  const q = sp.get('q') ?? '';
  const taskId = Number(sp.get('task')) || null;
  const openTab = tab !== 'done' && tab !== 'noise';

  const [search, setSearch] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setRef = useRef(set);
  setRef.current = set;
  useEffect(() => setSearch(q), [q]);
  const onSearch = (v: string) => {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRef.current({ q: v.trim() || null }), 300);
  };

  const params: ListTasksParams = { tab };
  if (source) params.source = source;
  if (week) {
    params.weekStart = week;
    if (openTab && undated) params.includeUndated = true;
  }
  if (q) params.q = q;

  const list = useListTasks(params);
  const summary = useGetTaskSummary(week ? { weekStart: week } : undefined);
  const thisWeek = weekStartOf(todayLondon());

  const rows = list.data ?? [];
  const tabs = summary.data?.tabs;
  const stats = summary.data?.stats;

  return (
    <section className={'oo-split'} data-open={taskId ? 'true' : 'false'}>
      <div className="oo-list oo-panel flex flex-col gap-[22px] px-4 py-6 sm:px-10 sm:pt-9 sm:pb-7">
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: '-0.015em' }}>Tasks</h1>

        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <div role="tablist" aria-label="Task views" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
            {TABS.map((t) => (
              <button key={t.value} type="button" role="tab" className="oo-tab" aria-selected={t.value === tab}
                onClick={() => set({ tab: t.value === 'open' ? null : t.value, task: null })} data-testid={'tab-' + t.value}>
                {t.label} <span className="oo-count oo-num">{tabs ? tabs[t.value] : ''}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span className="oo-serif" style={{ fontSize: 22, marginRight: 6 }} data-testid="text-shown-count">
            {list.isLoading ? '…' : rows.length} {rows.length === 1 ? 'task' : 'tasks'}
          </span>
          <label htmlFor="filter-source" className="oo-sr">Source</label>
          <select id="filter-source" className="oo-control" value={source ?? ''} onChange={(e) => set({ source: e.target.value || null })} data-testid="select-source">
            <option value="">All sources</option>
            {TASK_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
          </select>
          <button type="button" className="oo-control" aria-pressed={week === thisWeek}
            onClick={() => set({ week: week === thisWeek ? null : thisWeek })} data-testid="button-this-week">This week</button>
          <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--oo-control-border)', borderRadius: 'var(--oo-r-input)', background: 'var(--oo-panel)' }}>
            <button type="button" aria-label="Previous week" className="oo-control" style={{ border: 0, display: 'flex' }}
              onClick={() => set({ week: addDays(week ?? thisWeek, -7) })} data-testid="button-prev-week"><IconLeft size={14} /></button>
            <span className="oo-num" style={{ fontSize: 14, padding: '0 4px' }} data-testid="text-week-range">{week ? formatWeekRange(week) : 'Any date'}</span>
            <button type="button" aria-label="Next week" className="oo-control" style={{ border: 0, display: 'flex' }}
              onClick={() => set({ week: addDays(week ?? thisWeek, 7) })} data-testid="button-next-week"><IconRight size={14} /></button>
          </div>
          {week && openTab && (
            <button type="button" className="oo-control" aria-pressed={undated} onClick={() => set({ undated: undated ? null : '1' })} data-testid="button-include-undated">No date</button>
          )}
          {week && (
            <button type="button" className="oo-btn oo-btn-danger" style={{ color: 'var(--oo-ink-muted)' }} onClick={() => set({ week: null, undated: null })} data-testid="button-clear-week">Any date</button>
          )}
          <div style={{ flexGrow: 1 }} />
          <label htmlFor="task-search" className="oo-sr">Search tasks</label>
          <div className="oo-search" style={{ flex: '1 1 220px', maxWidth: 320 }}>
            <IconSearch size={15} />
            <input id="task-search" type="search" placeholder="Search anything" value={search} onChange={(e) => onSearch(e.target.value)} data-testid="input-search" />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3.5">
          {[
            ['Inbox to triage', stats?.inboxToTriage, 'inbox'],
            ['Due this week', stats?.dueThisWeek, 'due'],
            ['Waiting on others', stats?.waitingOnOthers, 'waiting'],
            ['Done this week', stats?.doneThisWeek, 'done'],
          ].map(([label, value, id]) => (
            <div key={id as string} className="oo-stat" data-testid={'stat-' + id}>
              <span style={{ fontSize: 14, textAlign: 'center' }}>{label}</span>
              {value === undefined ? <Skel h={40} w={48} /> : <span className="oo-num" style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</span>}
            </div>
          ))}
        </div>

        {list.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 8 }}>
            {[0, 1, 2, 3, 4].map((i) => <Skel key={i} h={18} w={i % 2 ? '72%' : '88%'} />)}
          </div>
        ) : list.error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-tasks-error">
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load tasks.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => list.refetch()} data-testid="button-retry-tasks">Try again</button>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '28px 0', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="state-tasks-empty">
            <p className="oo-serif" style={{ margin: 0, fontSize: 20 }}>{q || source || week ? 'Nothing matches these filters.' : EMPTY[tab]}</p>
            {(q || source || week) && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Try another week or clear the search.</p>}
          </div>
        ) : (
          <TaskRows rows={rows} selected={taskId} onOpen={(id) => set({ task: String(id) })} />
        )}
      </div>

      {taskId && <TaskDetailPanel id={taskId} onClose={() => set({ task: null })} />}
    </section>
  );
}

function TaskRows({ rows, selected, onOpen }: { rows: Task[]; selected: number | null; onOpen: (id: number) => void }) {
  const update = useUpdateTask();
  const invalidate = useInvalidateTasks();
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const mutateRef = useRef(update.mutate);
  mutateRef.current = update.mutate;

  const toggle = (t: Task) => {
    const isDone = pending[t.id] ?? t.status === 'done';
    const next = isDone ? 'now' : 'done';
    setPending((p) => ({ ...p, [t.id]: !isDone }));
    mutateRef.current(
      { id: t.id, data: { status: next } },
      {
        onSuccess: () => {
          notify(next === 'done' ? 'Marked done' : 'Back in Now', t.title);
          setTimeout(() => {
            invalidate(t.id);
            setTimeout(() => setPending((p) => { const c = { ...p }; delete c[t.id]; return c; }), 400);
          }, 2000);
        },
        onError: () => {
          setPending((p) => { const c = { ...p }; delete c[t.id]; return c; });
          notify('That did not save', 'Try again in a moment.');
        },
      },
    );
  };

  const doneOf = (t: Task) => pending[t.id] ?? t.status === 'done';
  const leaving = (t: Task) => t.id in pending && doneOf(t) !== (t.status === 'done');

  const check = (t: Task) => (
    <button type="button" className="oo-check" aria-pressed={doneOf(t)} aria-label={(doneOf(t) ? 'Mark not done: ' : 'Mark done: ') + t.title}
      onClick={(e) => { e.stopPropagation(); toggle(t); }} data-testid={'button-toggle-done-' + t.id}>
      <IconCheck size={12} strokeWidth={3} />
    </button>
  );

  return (
    <>
      <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="oo-table">
          <thead>
            <tr>
              <th scope="col">Task</th><th scope="col">Source</th><th scope="col">From</th>
              <th scope="col">Priority</th><th scope="col">Due</th><th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="oo-row" data-selected={t.id === selected} data-leaving={leaving(t)} onClick={() => onOpen(t.id)} data-testid={'row-task-' + t.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {check(t)}
                    <button type="button" className="oo-row-title" data-done={doneOf(t)} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} data-testid={'button-open-task-' + t.id}>{t.title}</button>
                  </div>
                </td>
                <td><SourceLabel source={t.source} /></td>
                <td className="oo-soft">{t.fromName ?? t.person?.name ?? ''}</td>
                <td><PriorityPill priority={t.priority} /></td>
                <td className="oo-num">{t.dueDate ? formatShort(t.dueDate) : <span className="oo-muted">No date</span>}</td>
                <td><StatusPill status={doneOf(t) ? 'done' : t.status === 'done' ? 'now' : t.status} testId={'status-task-' + t.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="oo-cards">
        {rows.map((t) => (
          <div key={t.id} className="oo-card-row" data-leaving={leaving(t)} data-testid={'card-task-' + t.id}>
            <div style={{ paddingTop: 2 }}>{check(t)}</div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button type="button" className="oo-row-title" data-done={doneOf(t)} style={{ fontSize: 15, minHeight: 24 }} onClick={() => onOpen(t.id)} data-testid={'button-open-task-mobile-' + t.id}>{t.title}</button>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <SourceMark source={t.source} size={20} />
                <PriorityPill priority={t.priority} />
                <StatusPill status={doneOf(t) ? 'done' : t.status === 'done' ? 'now' : t.status} />
                <span className="oo-muted oo-num" style={{ fontSize: 12 }}>{t.dueDate ? formatShort(t.dueDate) : 'No date'}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
