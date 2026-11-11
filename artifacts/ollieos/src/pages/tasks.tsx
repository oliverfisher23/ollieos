import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  useGetClearOut,
  useGetTaskSummary,
  useListReview,
  useListTasks,
  updateTask,
  useUpdateTask,
  type ListTasksParams,
  type Priority,
  type TaskStatus,
  type TaskUpdate,
  type Task,
  type TaskSource,
  type TaskTab,
  type TriageInputAction,
} from '@workspace/api-client-react';
import { SOURCE_LABELS, TASK_SOURCES, addDays, formatWeekRange, todayLondon, weekStartOf } from '@workspace/shared';
import { Skel, SourceLabel, SourceMark } from '@/components/bits';
import { DueCell, PriorityCell, StatusCell } from '@/components/task-cell-editors';
import { IconCheck, IconLeft, IconRight, IconSearch } from '@/components/icons';
import { TaskMarks } from '@/components/task-marks';
import { useInvalidateTasks } from '@/lib/task-cache';
import { notify, notifyUndo } from '@/lib/notify';
import { useTaskActions } from '@/lib/task-actions';
import { Dot, Dropdown } from '@/components/dropdown';
import { lazyPage } from '@/lib/lazy-page';
import { ScrollRow } from '@/components/scroll-row';

/** Opens on a tap, so its code (with reply drafting and checklists) loads after the list is on screen. */
const TaskDetailPanel = lazyPage(() => import('@/components/task-detail'), 'TaskDetailPanel');

const TABS: { value: TaskTab; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'open', label: 'All open' },
  { value: 'now', label: 'Now' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'waiting', label: 'Waiting on' },
  { value: 'done', label: 'Done' },
  { value: 'noise', label: 'Noise' },
  { value: 'dropped', label: 'Dropped' },
  { value: 'archived', label: 'Archive' },
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
  dropped: 'Nothing dropped.',
  archived: 'Nothing archived. Archive keeps a task for later without it counting as open.',
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
  // Fetch the detail panel's code once the list is up, so opening a task is instant.
  useEffect(() => {
    const t = window.setTimeout(() => void TaskDetailPanel.preload().catch(() => {}), 1500);
    return () => window.clearTimeout(t);
  }, []);
  const rawTab = sp.get('tab') ?? 'open';
  const tab = (TAB_VALUES.includes(rawTab) ? rawTab : 'open') as TaskTab;
  const rawSource = sp.get('source');
  const source = rawSource && (TASK_SOURCES as readonly string[]).includes(rawSource) ? (rawSource as TaskSource) : undefined;
  const week = sp.get('week') || undefined;
  const undated = sp.get('undated') === '1';
  const q = sp.get('q') ?? '';
  const taskId = Number(sp.get('task')) || null;
  const openTab = tab !== 'done' && tab !== 'noise' && tab !== 'dropped' && tab !== 'archived';

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

  const review = useListReview();
  const reviewCount = review.data?.actions ?? 0;

  const rows = list.data ?? [];
  const tabs = summary.data?.tabs;
  const stats = summary.data?.stats;

  return (
    <section className={'oo-split'} data-open={taskId ? 'true' : 'false'}>
      <div className="oo-list oo-panel flex flex-col gap-[22px] px-4 py-6 sm:px-10 sm:pt-9 sm:pb-7">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 600, letterSpacing: '-0.015em' }}>Tasks</h1>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
            {reviewCount > 0 && (
              <Link href="/review" className="oo-link" style={{ fontSize: 14 }} data-testid="link-review">Review {reviewCount}</Link>
            )}
            <Link href="/email" className="oo-link sm:hidden" style={{ fontSize: 14 }} data-testid="link-email">Email</Link>
            <Link href="/meetings" className="oo-link sm:hidden" style={{ fontSize: 14 }} data-testid="link-meetings">Meetings</Link>
          </span>
        </div>

        <ScrollRow className="-mx-4 px-4 sm:mx-0 sm:px-0">
          <div role="tablist" aria-label="Task views" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
            {TABS.map((t) => (
              <button key={t.value} type="button" role="tab" className="oo-tab" aria-selected={t.value === tab}
                onClick={() => set({ tab: t.value === 'open' ? null : t.value, task: null })} data-testid={'tab-' + t.value}>
                {t.label} <span className="oo-count oo-num">{tabs ? tabs[t.value] : ''}</span>
              </button>
            ))}
          </div>
        </ScrollRow>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span className="oo-serif" style={{ fontSize: 22, marginRight: 6 }} data-testid="text-shown-count">
            {list.isLoading ? '…' : rows.length} {rows.length === 1 ? 'task' : 'tasks'}
          </span>
          <label htmlFor="filter-source" className="oo-sr">Source</label>
          <Dropdown
            id="filter-source"
            variant="control"
            value={source ?? ''}
            onChange={(v) => set({ source: v || null })}
            options={[
              { value: '', label: 'All sources' },
              ...TASK_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s], leading: <Dot color={`var(--oo-src-${s}-fg)`} /> })),
            ]}
            testId="select-source"
          />
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

        {tab === 'inbox' && rows.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <Link href="/triage" className="oo-btn oo-btn-ink" data-testid="link-triage-all">Triage one at a time</Link>
            <p className="oo-kbd-hint" style={{ margin: 0 }} id="inbox-keys">
              Keys: <kbd>J</kbd> <kbd>K</kbd> to move, <kbd>N</kbd> Now, <kbd>B</kbd> Backlog, <kbd>W</kbd> Waiting, <kbd>D</kbd> Drop, <kbd>X</kbd> Noise, <kbd>E</kbd> to open
            </p>
          </div>
        )}
        {tab === 'done' && <WeeklyCopy weekStart={week ?? thisWeek} />}
        {tab === 'backlog' && <ClearOutStart />}

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
          <TaskRows tab={tab} rows={rows} selected={taskId} onOpen={(id) => set({ task: String(id) })} />
        )}
      </div>

      {taskId && (
        <Suspense fallback={null}>
          <TaskDetailPanel id={taskId} onClose={() => set({ task: null })} />
        </Suspense>
      )}
    </section>
  );
}

/** Starts the Backlog clear-out from the Backlog tab, whenever there is something untouched. */
function ClearOutStart() {
  const clearOut = useGetClearOut();
  const count = clearOut.data?.count ?? 0;
  if (!count) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <Link href="/clear-out?from=backlog" className="oo-btn oo-btn-ink" data-testid="link-clear-out">Clear out the Backlog</Link>
      <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-clear-out-count">
        {count === 1 ? '1 task' : `${count} tasks`} untouched for 30 days or more.
      </span>
    </div>
  );
}

function WeeklyCopy({ weekStart }: { weekStart: string }) {
  const actions = useTaskActions();
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <button type="button" className="oo-btn oo-btn-ink" disabled={busy}
        onClick={async () => { setBusy(true); await actions.copyWeekly(weekStart); setBusy(false); }} data-testid="button-copy-weekly">
        Copy for weekly update
      </button>
      <span className="oo-muted" style={{ fontSize: 13 }}>Done items from {formatWeekRange(weekStart)}, grouped by project.</span>
    </div>
  );
}

const TRIAGE_BUTTONS: { action: TriageInputAction; label: string; key: string }[] = [
  { action: 'now', label: 'Now', key: 'N' },
  { action: 'backlog', label: 'Backlog', key: 'B' },
  { action: 'waiting', label: 'Waiting', key: 'W' },
  { action: 'dropped', label: 'Drop', key: 'D' },
  { action: 'noise', label: 'Noise', key: 'X' },
];
const KEY_ACTION: Record<string, TriageInputAction> = { n: 'now', b: 'backlog', w: 'waiting', d: 'dropped', x: 'noise' };

function isTyping(el: EventTarget | null) {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
}

function TaskRows({ tab, rows: allRows, selected, onOpen }: { tab: TaskTab; rows: Task[]; selected: number | null; onOpen: (id: number) => void }) {
  let rows = allRows;
  const update = useUpdateTask();
  const invalidate = useInvalidateTasks();
  const actions = useTaskActions();
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [acting, setActing] = useState<Record<number, boolean>>({});
  const mutateRef = useRef(update.mutate);
  mutateRef.current = update.mutate;
  const inbox = tab === 'inbox';
  const noise = tab === 'noise';
  const dropped = tab === 'dropped';
  const archived = tab === 'archived';
  const extraCol = inbox || noise || dropped || archived;

  // On the Inbox tab, items the noise check flagged sit in their own group below the rest.
  const real = inbox ? rows.filter((t) => !t.noiseHint) : rows;
  const hinted = inbox ? rows.filter((t) => t.noiseHint) : [];
  rows = inbox ? [...real, ...hinted] : rows;
  const [clearing, setClearing] = useState(false);
  const noiseAll = async () => {
    setClearing(true);
    await actions.noiseAll(hinted);
    setClearing(false);
  };

  // Keyboard triage on the Inbox tab. The cursor follows a row id; when that row leaves,
  // it stays at the same position so the next item is ready.
  const [cursor, setCursor] = useState<number | null>(null);
  const cursorIndex = useRef(0);
  const idx = rows.findIndex((t) => t.id === cursor);
  if (idx >= 0) cursorIndex.current = idx;
  const cursorTask = idx >= 0 ? rows[idx] : rows[Math.min(cursorIndex.current, rows.length - 1)] ?? null;

  const runRow = async (t: Task, fn: () => Promise<unknown>) => {
    setActing((a) => ({ ...a, [t.id]: true }));
    await fn();
    setActing((a) => { const c = { ...a }; delete c[t.id]; return c; });
  };
  const triage = (t: Task, action: TriageInputAction) => runRow(t, () => actions.triage(t, { action }));

  const stateRef = useRef({ rows, cursorTask, selected, onOpen, triage });
  stateRef.current = { rows, cursorTask, selected, onOpen, triage };

  useEffect(() => {
    if (!inbox) return;
    const onKey = (e: KeyboardEvent) => {
      const st = stateRef.current;
      if (st.selected || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      const list = st.rows;
      if (!list.length) return;
      const i = st.cursorTask ? list.findIndex((t) => t.id === st.cursorTask!.id) : -1;
      let target: Task | null = null;
      if (k === 'j') target = list[Math.min(i + 1, list.length - 1)];
      else if (k === 'k') target = list[Math.max(i - 1, 0)];
      if (target) {
        e.preventDefault();
        setCursor(target.id);
        // Table on desktop, cards on a phone: focus whichever is visible.
        const els = document.querySelectorAll<HTMLElement>(`[data-testid="row-task-${target.id}"] .oo-row-title, [data-testid="card-task-${target.id}"] .oo-row-title`);
        [...els].find((el) => el.offsetParent !== null)?.focus();
        return;
      }
      const current = st.cursorTask;
      if (!current) return;
      if (KEY_ACTION[k]) {
        e.preventDefault();
        setCursor(current.id);
        void st.triage(current, KEY_ACTION[k]);
      } else if (k === 'e') {
        e.preventDefault();
        st.onOpen(current.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inbox]);

  const toggle = (t: Task) => {
    const isDone = pending[t.id] ?? t.status === 'done';
    const next = isDone ? 'now' : 'done';
    setPending((p) => ({ ...p, [t.id]: !isDone }));
    mutateRef.current(
      { id: t.id, data: { status: next } },
      {
        onSuccess: () => {
          notifyUndo(next === 'done' ? 'Marked done' : 'Back in Now', next === 'done' && t.repeat ? `${t.title}. The next one is in your Backlog.` : t.title, () => {
            setPending((p) => { const c = { ...p }; delete c[t.id]; return c; });
            void actions.undo(t);
          });
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

  // Quick edits from the row, the same as the detail panel.
  const saveRow = async (t: Task, data: TaskUpdate) => {
    try {
      await updateTask(t.id, data);
      invalidate(t.id);
    } catch {
      notify('That did not save', 'Try again in a moment.');
    }
  };
  const setStatus = (t: Task, status: TaskStatus) => {
    if (status === t.status) return;
    void runRow(t, () => actions.setStatus(t, status));
  };
  const shownStatus = (t: Task): TaskStatus => (doneOf(t) ? 'done' : t.status === 'done' ? 'now' : t.status);
  const statusCell = (t: Task, testId: string) => (
    <StatusCell title={t.title} status={t.status} shown={shownStatus(t)} onChange={(s) => setStatus(t, s)} testId={testId} />
  );
  const priorityCell = (t: Task, testId: string) => (
    <PriorityCell title={t.title} priority={t.priority} onChange={(p: Priority) => saveRow(t, { priority: p })} testId={testId} />
  );
  const dueCell = (t: Task, testId: string, compact?: boolean) => (
    <DueCell title={t.title} due={t.dueDate} compact={compact} onChange={(d) => saveRow(t, { dueDate: d })} testId={testId} />
  );

  const doneOf = (t: Task) => pending[t.id] ?? t.status === 'done';
  const leaving = (t: Task) => t.id in pending && doneOf(t) !== (t.status === 'done');

  const check = (t: Task) => (
    <button type="button" className="oo-check" aria-pressed={doneOf(t)} aria-label={(doneOf(t) ? 'Mark not done: ' : 'Mark done: ') + t.title}
      onClick={(e) => { e.stopPropagation(); toggle(t); }} data-testid={'button-toggle-done-' + t.id}>
      <IconCheck size={12} strokeWidth={3} />
    </button>
  );

  const rowActions = (t: Task) =>
    inbox && t.noiseHint ? (
      <div role="group" aria-label={'Probably noise: ' + t.title} style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <button type="button" className="oo-mini" disabled={!!acting[t.id]} onClick={() => runRow(t, () => actions.keep(t))} data-testid={'button-row-keep-' + t.id}>Keep</button>
        <button type="button" className="oo-mini" disabled={!!acting[t.id]} aria-keyshortcuts="X" onClick={() => triage(t, 'noise')} data-testid={'button-row-noise-' + t.id}>Noise</button>
      </div>
    ) : inbox ? (
      <div role="group" aria-label={'Triage: ' + t.title} style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {TRIAGE_BUTTONS.map((b) => (
          <button key={b.action} type="button" className="oo-mini" disabled={!!acting[t.id]} aria-keyshortcuts={b.key}
            onClick={() => triage(t, b.action)} data-testid={`button-row-${b.action}-${t.id}`}>
            {b.label}
          </button>
        ))}
      </div>
    ) : (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {noise && <span className="oo-soft" style={{ fontSize: 12 }} data-testid={'text-row-rule-' + t.id}>{t.noiseRule ? t.noiseRule.label : 'Moved by hand'}</span>}
        <button type="button" className="oo-mini" disabled={!!acting[t.id]} aria-label={(archived ? 'Restore to Backlog: ' : 'Restore to Inbox: ') + t.title}
          onClick={() => runRow(t, () => actions.restore(t))} data-testid={'button-restore-' + t.id}>Restore</button>
      </div>
    );

  const hint = (t: Task) =>
    t.noiseHint ? (
      <span className="oo-soft" style={{ fontSize: 12 }} data-testid={'text-noise-hint-' + t.id}>Probably noise: {t.noiseHint}</span>
    ) : null;

  const table = (list: Task[], label: string) => (
    <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
      <table className="oo-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Task</th><th scope="col">Source</th><th scope="col">From</th>
            <th scope="col">Priority</th><th scope="col">Due</th><th scope="col">Status</th>
            {extraCol && <th scope="col">{inbox ? 'Triage' : noise ? 'Caught by' : <span className="oo-sr">Restore</span>}</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className="oo-row" data-selected={t.id === selected} data-cursor={inbox && cursorTask?.id === t.id && cursor !== null} data-leaving={leaving(t)} onClick={() => onOpen(t.id)} data-testid={'row-task-' + t.id}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {check(t)}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <button type="button" className="oo-row-title" data-done={doneOf(t)} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}
                      onFocus={() => inbox && setCursor(t.id)} aria-describedby={inbox ? 'inbox-keys' : undefined} data-testid={'button-open-task-' + t.id}>{t.title}</button>
                    {hint(t)}
                    <TaskMarks task={t} />
                  </div>
                  {t.stale && <StalePill id={t.id} />}
                </div>
              </td>
              <td><SourceLabel source={t.source} /></td>
              <td className="oo-soft">{t.fromName ?? t.person?.name ?? ''}</td>
              <td onClick={(e) => e.stopPropagation()}>{priorityCell(t, 'select-row-priority-' + t.id)}</td>
              <td onClick={(e) => e.stopPropagation()}>{dueCell(t, 'select-row-due-' + t.id)}</td>
              <td onClick={(e) => e.stopPropagation()} data-testid={'status-task-' + t.id}>{statusCell(t, 'select-row-status-' + t.id)}</td>
              {extraCol && <td onClick={(e) => e.stopPropagation()}>{rowActions(t)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const cards = (list: Task[]) => (
    <div className="oo-cards">
      {list.map((t) => (
        <div key={t.id} className="oo-card-row oo-card-open" data-leaving={leaving(t)} data-testid={'card-task-' + t.id}>
          <div style={{ paddingTop: 2 }}>{check(t)}</div>
          <div className="oo-card-body">
            <button type="button" className="oo-row-title" data-done={doneOf(t)} style={{ fontSize: 15, minHeight: 24 }} onClick={() => onOpen(t.id)}
              onFocus={() => inbox && setCursor(t.id)} data-testid={'button-open-task-mobile-' + t.id}>{t.title}</button>
            {hint(t)}
            <TaskMarks task={t} />
            <div className="oo-card-pills">
              <SourceMark source={t.source} size={20} />
              {priorityCell(t, 'select-card-priority-' + t.id)}
              {statusCell(t, 'select-card-status-' + t.id)}
              {dueCell(t, 'select-card-due-' + t.id, true)}
              {t.stale && <StalePill id={t.id} />}
            </div>
            {extraCol && rowActions(t)}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {real.length > 0 && (
        <>
          {table(real, 'Tasks')}
          {cards(real)}
        </>
      )}
      {hinted.length > 0 && (
        <section aria-labelledby="noise-group-title" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: real.length ? 12 : 0 }} data-testid="group-probably-noise">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <h2 id="noise-group-title" className="oo-serif" style={{ margin: 0, fontSize: 20, fontWeight: 400 }}>
              Probably noise <span className="oo-count oo-num" data-testid="text-noise-group-count">{hinted.length}</span>
            </h2>
            <button type="button" className="oo-btn oo-btn-outline" disabled={clearing} onClick={noiseAll} data-testid="button-noise-all">
              {clearing ? 'Moving…' : 'Move all to Noise'}
            </button>
            <span className="oo-muted" style={{ fontSize: 13 }}>Keep anything that matters. Open one to make a rule from it.</span>
          </div>
          {table(hinted, 'Probably noise')}
          {cards(hinted)}
        </section>
      )}
    </>
  );
}

function StalePill({ id }: { id: number }) {
  return (
    <span className="oo-pill" data-tone="stale" title="Not touched for 30 days or more" data-testid={'pill-stale-' + id}>
      Stale<span className="oo-sr">: not touched for 30 days or more</span>
    </span>
  );
}
