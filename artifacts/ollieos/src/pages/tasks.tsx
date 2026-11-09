import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  useGetTaskSummary,
  useListTasks,
  useUpdateTask,
  type ListTasksParams,
  type Task,
  type TaskSource,
  type TaskTab,
  type TriageInputAction,
} from '@workspace/api-client-react';
import { SOURCE_LABELS, TASK_SOURCES, addDays, formatShort, formatWeekRange, todayLondon, weekStartOf } from '@workspace/shared';
import { PriorityPill, Skel, SourceLabel, SourceMark, StatusPill } from '@/components/bits';
import { IconCheck, IconLeft, IconRight, IconSearch } from '@/components/icons';
import { TaskDetailPanel } from '@/components/task-detail';
import { useInvalidateTasks } from '@/lib/task-cache';
import { notify, notifyUndo } from '@/lib/notify';
import { useTaskActions } from '@/lib/task-actions';

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

        {tab === 'inbox' && rows.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <Link href="/triage" className="oo-btn oo-btn-ink" data-testid="link-triage-all">Triage one at a time</Link>
            <p className="oo-kbd-hint" style={{ margin: 0 }} id="inbox-keys">
              Keys: <kbd>J</kbd> <kbd>K</kbd> to move, <kbd>N</kbd> Now, <kbd>B</kbd> Backlog, <kbd>W</kbd> Waiting, <kbd>X</kbd> Noise, <kbd>E</kbd> to open
            </p>
          </div>
        )}
        {tab === 'done' && <WeeklyCopy weekStart={week ?? thisWeek} />}

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

      {taskId && <TaskDetailPanel id={taskId} onClose={() => set({ task: null })} />}
    </section>
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
  { action: 'noise', label: 'Noise', key: 'X' },
];
const KEY_ACTION: Record<string, TriageInputAction> = { n: 'now', b: 'backlog', w: 'waiting', x: 'noise' };

function isTyping(el: EventTarget | null) {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
}

function TaskRows({ tab, rows, selected, onOpen }: { tab: TaskTab; rows: Task[]; selected: number | null; onOpen: (id: number) => void }) {
  const update = useUpdateTask();
  const invalidate = useInvalidateTasks();
  const actions = useTaskActions();
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [acting, setActing] = useState<Record<number, boolean>>({});
  const mutateRef = useRef(update.mutate);
  mutateRef.current = update.mutate;
  const inbox = tab === 'inbox';
  const noise = tab === 'noise';
  const extraCol = inbox || noise;

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
          notifyUndo(next === 'done' ? 'Marked done' : 'Back in Now', t.title, () => {
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

  const doneOf = (t: Task) => pending[t.id] ?? t.status === 'done';
  const leaving = (t: Task) => t.id in pending && doneOf(t) !== (t.status === 'done');

  const check = (t: Task) => (
    <button type="button" className="oo-check" aria-pressed={doneOf(t)} aria-label={(doneOf(t) ? 'Mark not done: ' : 'Mark done: ') + t.title}
      onClick={(e) => { e.stopPropagation(); toggle(t); }} data-testid={'button-toggle-done-' + t.id}>
      <IconCheck size={12} strokeWidth={3} />
    </button>
  );

  const rowActions = (t: Task) =>
    inbox ? (
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
        <span className="oo-soft" style={{ fontSize: 12 }} data-testid={'text-row-rule-' + t.id}>{t.noiseRule ? t.noiseRule.label : 'Moved by hand'}</span>
        <button type="button" className="oo-mini" disabled={!!acting[t.id]} aria-label={'Restore to Inbox: ' + t.title}
          onClick={() => runRow(t, () => actions.restore(t))} data-testid={'button-restore-' + t.id}>Restore</button>
      </div>
    );

  return (
    <>
      <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
        <table className="oo-table">
          <thead>
            <tr>
              <th scope="col">Task</th><th scope="col">Source</th><th scope="col">From</th>
              <th scope="col">Priority</th><th scope="col">Due</th><th scope="col">Status</th>
              {extraCol && <th scope="col">{inbox ? 'Triage' : 'Caught by'}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="oo-row" data-selected={t.id === selected} data-cursor={inbox && cursorTask?.id === t.id && cursor !== null} data-leaving={leaving(t)} onClick={() => onOpen(t.id)} data-testid={'row-task-' + t.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {check(t)}
                    <button type="button" className="oo-row-title" data-done={doneOf(t)} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}
                      onFocus={() => inbox && setCursor(t.id)} aria-describedby={inbox ? 'inbox-keys' : undefined} data-testid={'button-open-task-' + t.id}>{t.title}</button>
                    {t.stale && <StalePill id={t.id} />}
                  </div>
                </td>
                <td><SourceLabel source={t.source} /></td>
                <td className="oo-soft">{t.fromName ?? t.person?.name ?? ''}</td>
                <td><PriorityPill priority={t.priority} /></td>
                <td className="oo-num">{t.dueDate ? formatShort(t.dueDate) : <span className="oo-muted">No date</span>}</td>
                <td><StatusPill status={doneOf(t) ? 'done' : t.status === 'done' ? 'now' : t.status} testId={'status-task-' + t.id} /></td>
                {extraCol && <td onClick={(e) => e.stopPropagation()}>{rowActions(t)}</td>}
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
              <button type="button" className="oo-row-title" data-done={doneOf(t)} style={{ fontSize: 15, minHeight: 24 }} onClick={() => onOpen(t.id)}
                onFocus={() => inbox && setCursor(t.id)} data-testid={'button-open-task-mobile-' + t.id}>{t.title}</button>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <SourceMark source={t.source} size={20} />
                <PriorityPill priority={t.priority} />
                <StatusPill status={doneOf(t) ? 'done' : t.status === 'done' ? 'now' : t.status} />
                <span className="oo-muted oo-num" style={{ fontSize: 12 }}>{t.dueDate ? formatShort(t.dueDate) : 'No date'}</span>
                {t.stale && <StalePill id={t.id} />}
              </div>
              {extraCol && rowActions(t)}
            </div>
          </div>
        ))}
      </div>
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
