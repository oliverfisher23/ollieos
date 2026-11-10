import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetDayPlanQueryKey,
  refitDayPlan,
  saveDayPlan,
  updateTask,
  useGetDayPlan,
  useListTasks,
  type DayPlan,
  type PlannedTask,
  type PlanMeeting,
  type Task,
} from '@workspace/api-client-react';
import { formatTime } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { IconCheck, IconClose } from '@/components/icons';
import { useTaskActions } from '@/lib/task-actions';
import { useInvalidateTasks } from '@/lib/task-cache';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const LENGTHS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
];
const MAX_ITEMS = 12;

type Pick = { task: Task; minutes: number; reason?: string };

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const lengthLabel = (m: number) => LENGTHS.find((l) => l.value === String(m))?.label ?? `${m} min`;

/**
 * Today's plan on Home: pick a few tasks, give each a length, and OllieOS fits them between
 * today's meetings inside working hours. Nothing is written to the calendar.
 */
export function DayPlanCard({ phone = false }: { phone?: boolean }) {
  const plan = useGetDayPlan();
  const [editing, setEditing] = useState(false);

  const shell = (children: React.ReactNode) => (
    <section aria-labelledby="h-plan" className="oo-dark-card oo-white-card" style={{ width: '100%', ...(phone ? { padding: 16, gap: 12 } : { gap: 14 }) }} data-testid="card-day-plan">
      {children}
    </section>
  );

  if (plan.isLoading) {
    return shell(
      <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Skel h={12} w={110} /><Skel h={18} w="60%" /><Skel h={18} w="75%" /><Skel h={18} w="50%" />
      </div>,
    );
  }
  if (plan.error || !plan.data) {
    return shell(
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-plan-error">
        <h2 id="h-plan" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Today's plan</h2>
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Could not load today's plan.</p>
        <button type="button" className="oo-btn oo-btn-outline" onClick={() => plan.refetch()} data-testid="button-retry-plan">Try again</button>
      </div>,
    );
  }

  const d = plan.data;
  return shell(
    !d.made || editing ? (
      <PlanPicker key={d.date + String(d.made)} plan={d} phone={phone} onDone={() => setEditing(false)} onCancel={d.made ? () => setEditing(false) : undefined} />
    ) : (
      <PlanTimeline plan={d} phone={phone} onChange={() => setEditing(true)} />
    ),
  );
}

function hoursLine(plan: DayPlan) {
  return `${plan.workingHours.start} to ${plan.workingHours.end}`;
}

function PlanPicker({ plan, phone, onDone, onCancel }: { plan: DayPlan; phone: boolean; onDone: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const open = useListTasks({ tab: 'open' });
  const [picked, setPicked] = useState<Pick[]>(() => plan.items.filter((i) => i.task.status !== 'done').map((i) => ({ task: i.task, minutes: i.minutes })));
  const [saving, setSaving] = useState(false);

  const pickedIds = new Set(picked.map((p) => p.task.id));
  const suggestions = plan.suggestions.filter((s) => !pickedIds.has(s.task.id));
  const reasons = useMemo(() => new Map(plan.suggestions.map((s) => [s.task.id, s.reason])), [plan.suggestions]);

  const shownIds = new Set([...pickedIds, ...suggestions.map((s) => s.task.id)]);
  const others = (open.data ?? []).filter((t) => (t.status === 'now' || t.status === 'backlog' || t.status === 'waiting') && !shownIds.has(t.id));

  const add = (task: Task) => {
    if (picked.length + plan.items.filter((i) => i.task.status === 'done').length >= MAX_ITEMS) return notify('That is a full day', `A plan holds up to ${MAX_ITEMS} tasks.`);
    setPicked((p) => [...p, { task, minutes: 30 }]);
  };
  const remove = (id: number) => setPicked((p) => p.filter((x) => x.task.id !== id));
  const setMinutes = (id: number, minutes: number) => setPicked((p) => p.map((x) => (x.task.id === id ? { ...x, minutes } : x)));

  const make = async () => {
    setSaving(true);
    try {
      // Ticked-off tasks stay where they were in the plan.
      const kept = plan.items.filter((i) => i.task.status === 'done').map((i) => ({ taskId: i.task.id, minutes: i.minutes }));
      const res = await saveDayPlan({ items: [...kept, ...picked.map((p) => ({ taskId: p.task.id, minutes: p.minutes }))] });
      qc.setQueryData(getGetDayPlanQueryKey(), res);
      const missed = res.items.filter((i) => !i.start).length;
      notify(missed ? 'Plan made, but not everything fits' : 'Plan made', missed ? `${missed} did not fit before ${res.workingHours.end}.` : `Fitted around your meetings, ${hoursLine(res)}.`);
      onDone();
    } catch (err) {
      reportApiError(err);
      notify('Could not make the plan', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const nPicked = picked.length + plan.items.filter((i) => i.task.status === 'done').length;
  const counter = nPicked === 0 ? 'Pick 3 to 5' : nPicked < 3 ? `${nPicked} in the plan. 3 to 5 works best.` : nPicked > 5 ? `${nPicked} in the plan. That is a lot for one day.` : `${nPicked} in the plan`;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 id="h-plan" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>{plan.made ? 'Change today\'s plan' : 'Plan your day'}</h2>
        <span className="oo-muted" style={{ fontSize: 12 }}>
          Fitted between meetings, {hoursLine(plan)}. <Link href="/settings/planning" className="oo-link" data-testid="link-plan-hours">Change hours</Link>
        </span>
      </div>

      {picked.length > 0 && (
        <ol className="oo-plan-list" aria-label="Picked for today" data-testid="list-plan-picked">
          {picked.map((p, i) => (
            <li key={p.task.id} className="oo-plan-pick" data-testid={'plan-picked-' + p.task.id}>
              <span className="oo-plan-order oo-num" aria-hidden="true">{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{p.task.title}</span>
                {reasons.get(p.task.id) && <span className="oo-muted" style={{ fontSize: 12 }}>{reasons.get(p.task.id)}</span>}
              </span>
              <Dropdown variant="compact" ariaLabel={`Length of ${p.task.title}`} value={String(p.minutes)} searchable={false}
                onChange={(v) => setMinutes(p.task.id, Number(v))} options={LENGTHS} testId={'select-plan-length-' + p.task.id} />
              <button type="button" className="oo-icon-btn" aria-label={'Take out: ' + p.task.title} onClick={() => remove(p.task.id)} data-testid={'button-plan-remove-' + p.task.id}>
                <IconClose size={12} />
              </button>
            </li>
          ))}
        </ol>
      )}

      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="oo-field-label">{picked.length ? 'More suggestions' : 'Suggested for today'}</span>
          <ul className="oo-plan-list" aria-label="Suggestions" data-testid="list-plan-suggestions">
            {suggestions.map((s) => (
              <li key={s.task.id}>
                <button type="button" className="oo-plan-suggest" onClick={() => add(s.task)} data-testid={'button-plan-add-' + s.task.id}>
                  <span className="oo-plan-plus" aria-hidden="true">+</span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
                    <span style={{ fontSize: 14 }}><span className="oo-sr">Add to plan: </span>{s.task.title}</span>
                    <span className="oo-muted" style={{ fontSize: 12 }} data-testid={'text-plan-reason-' + s.task.id}>{s.reason}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!picked.length && !suggestions.length && !open.isLoading && others.length === 0 && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-plan-nothing">Nothing open to plan. Add a task and it can go in today's plan.</p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        {others.length > 0 && (
          <div style={{ flex: phone ? '1 1 100%' : '0 1 280px', minWidth: 0 }}>
            <Dropdown value="" placeholder="Add another task" ariaLabel="Add another task to the plan" searchable searchPlaceholder="Search open tasks"
              onChange={(v) => { const t = others.find((x) => String(x.id) === v); if (t) add(t); }}
              options={others.map((t) => ({ value: String(t.id), label: t.title, hint: t.project?.name }))} testId="select-plan-add-other" />
          </div>
        )}
        <span className="oo-muted" style={{ fontSize: 12 }} data-testid="text-plan-counter">{counter}</span>
        <div style={{ flexGrow: 1 }} />
        {onCancel && <button type="button" className="oo-btn oo-btn-outline" onClick={onCancel} disabled={saving} data-testid="button-plan-cancel">Cancel</button>}
        <button type="button" className="oo-btn oo-btn-ink" disabled={!picked.length || saving} onClick={make} data-testid="button-plan-make">
          {saving ? 'Fitting…' : plan.made ? 'Save the plan' : 'Make the plan'}
        </button>
      </div>
    </>
  );
}

type Row =
  | { kind: 'meeting'; at: number; meeting: PlanMeeting }
  | { kind: 'task'; at: number; item: PlannedTask };

function PlanTimeline({ plan, phone, onChange }: { plan: DayPlan; phone: boolean; onChange: () => void }) {
  const qc = useQueryClient();
  const actions = useTaskActions();
  const invalidate = useInvalidateTasks();
  const [busy, setBusy] = useState<number | 'fit' | null>(null);

  const placed = plan.items.filter((i) => i.start);
  const missed = plan.items.filter((i) => !i.start);
  const rows: Row[] = [
    ...plan.meetings.map((m) => ({ kind: 'meeting' as const, at: toMin(formatTime(m.startsAt)), meeting: m })),
    ...placed.map((i) => ({ kind: 'task' as const, at: toMin(i.start!), item: i })),
  ].sort((a, b) => a.at - b.at || (a.kind === 'meeting' ? -1 : 1));
  const clashes = placed.filter((i) => i.clash && i.task.status !== 'done').length;
  const done = plan.items.filter((i) => i.task.status === 'done').length;

  const tick = async (i: PlannedTask) => {
    setBusy(i.task.id);
    if (i.task.status === 'done') {
      try {
        await updateTask(i.task.id, { status: 'now' });
        invalidate(i.task.id);
      } catch (err) {
        reportApiError(err);
        notify('That did not save', errorMessage(err));
      }
    } else {
      await actions.markDone(i.task);
    }
    setBusy(null);
  };

  const fit = async () => {
    setBusy('fit');
    try {
      const res = await refitDayPlan();
      qc.setQueryData(getGetDayPlanQueryKey(), res);
      notify('Fitted again', res.items.some((x) => !x.start && x.task.status !== 'done') ? 'Some tasks no longer fit today.' : 'Everything left fits around your meetings.');
    } catch (err) {
      reportApiError(err);
      notify('Could not fit the plan', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 id="h-plan" className="oo-label" style={{ fontSize: phone ? 12 : 13 }}>Today's plan</h2>
        <span className="oo-muted oo-num" style={{ fontSize: 12 }} data-testid="text-plan-progress">
          {done} of {plan.items.length} done
        </span>
      </div>

      {clashes > 0 && (
        <div className="oo-plan-warn" role="status" data-testid="banner-plan-clash">
          <span>{clashes === 1 ? 'A meeting now overlaps a task.' : `Meetings now overlap ${clashes} tasks.`}</span>
          <button type="button" className="oo-mini" disabled={busy === 'fit'} onClick={fit} data-testid="button-plan-fit-clash">Fit again</button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Nothing fitted today.</p>
      ) : (
        <ol className="oo-plan-list oo-plan-timeline" aria-label="Today, in time order" data-testid="list-plan-timeline">
          {rows.map((r) =>
            r.kind === 'meeting' ? (
              <li key={'m' + r.meeting.id} className="oo-plan-row" data-kind="meeting" data-testid={'plan-meeting-' + r.meeting.id}>
                <span className="oo-plan-time oo-num">{formatTime(r.meeting.startsAt)}</span>
                <span className="oo-plan-bar" aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 14 }}>{r.meeting.title}</span>
                  <span className="oo-muted oo-num" style={{ fontSize: 12 }}>
                    {r.meeting.personal ? 'Personal, ' : 'Meeting, '}until {formatTime(r.meeting.endsAt)}
                  </span>
                </span>
              </li>
            ) : (
              <li key={'t' + r.item.task.id} className="oo-plan-row" data-kind="task" data-done={r.item.task.status === 'done'} data-testid={'plan-task-' + r.item.task.id}>
                <span className="oo-plan-time oo-num">{r.item.start}</span>
                <button type="button" className="oo-check" aria-pressed={r.item.task.status === 'done'} disabled={busy === r.item.task.id}
                  aria-label={(r.item.task.status === 'done' ? 'Mark not done: ' : 'Mark done: ') + r.item.task.title}
                  onClick={() => tick(r.item)} data-testid={'button-plan-tick-' + r.item.task.id}>
                  <IconCheck size={12} strokeWidth={3} />
                </button>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Link href={'/tasks?task=' + r.item.task.id} className="oo-plan-title" data-testid={'link-plan-task-' + r.item.task.id}>{r.item.task.title}</Link>
                  <span className="oo-muted oo-num" style={{ fontSize: 12 }}>
                    {lengthLabel(r.item.minutes)}, until {r.item.end}
                    {r.item.clash && r.item.task.status !== 'done' && <span className="oo-plan-clash" data-testid={'text-plan-clash-' + r.item.task.id}> · Overlaps a meeting</span>}
                  </span>
                </span>
              </li>
            ),
          )}
        </ol>
      )}

      {missed.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="list-plan-missed">
          <span className="oo-field-label">Did not fit before {plan.workingHours.end}</span>
          {missed.map((i) => (
            <div key={i.task.id} className="oo-plan-row" data-kind="task" data-done={i.task.status === 'done'} data-testid={'plan-missed-' + i.task.id}>
              <button type="button" className="oo-check" aria-pressed={i.task.status === 'done'} disabled={busy === i.task.id}
                aria-label={(i.task.status === 'done' ? 'Mark not done: ' : 'Mark done: ') + i.task.title}
                onClick={() => tick(i)} data-testid={'button-plan-tick-' + i.task.id}>
                <IconCheck size={12} strokeWidth={3} />
              </button>
              <span style={{ flex: 1, minWidth: 0 }}>
                <Link href={'/tasks?task=' + i.task.id} className="oo-plan-title">{i.task.title}</Link>
                <span className="oo-muted" style={{ fontSize: 12 }}> · {lengthLabel(i.minutes)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 'auto' }}>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onChange} data-testid="button-plan-change">Change plan</button>
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy === 'fit'} onClick={fit} data-testid="button-plan-fit">
          {busy === 'fit' ? 'Fitting…' : 'Fit again'}
        </button>
        {!phone && <span className="oo-muted" style={{ fontSize: 12, alignSelf: 'center' }}>Fit again after a meeting moves or a task runs over.</span>}
      </div>
    </>
  );
}
