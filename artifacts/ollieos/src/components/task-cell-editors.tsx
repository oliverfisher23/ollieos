import type { Priority, TaskStatus } from '@workspace/api-client-react';
import { PRIORITY_LABELS, STATUS_LABELS, addDays, formatShort, todayLondon, weekday } from '@workspace/shared';
import { PriorityPill, StatusPill } from '@/components/bits';
import { Dot, Dropdown, type DropdownOption } from '@/components/dropdown';

/** Pickers that change a task straight from a table row or a phone card. */

const STATUS_ORDER: TaskStatus[] = ['inbox', 'now', 'backlog', 'waiting', 'done', 'dropped', 'archived'];
const PRIORITY_ORDER: Priority[] = ['high', 'medium', 'low'];

export function StatusCell({ title, status, shown, onChange, testId }: {
  title: string;
  /** The saved status */
  status: TaskStatus;
  /** What the row shows right now, which can run ahead of the save when ticking done */
  shown: TaskStatus;
  onChange: (status: TaskStatus) => void;
  testId: string;
}) {
  return (
    <Dropdown
      variant="bare"
      ariaLabel={`Status: ${STATUS_LABELS[shown]}. Change status of ${title}`}
      value={status}
      onChange={(v) => onChange(v as TaskStatus)}
      options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s], leading: <Dot color={`var(--oo-pill-${s}-fg)`} /> }))}
      trigger={<StatusPill status={shown} />}
      testId={testId}
    />
  );
}

export function PriorityCell({ title, priority, onChange, testId }: { title: string; priority: Priority; onChange: (p: Priority) => void; testId: string }) {
  return (
    <Dropdown
      variant="bare"
      ariaLabel={`Priority: ${PRIORITY_LABELS[priority]}. Change priority of ${title}`}
      value={priority}
      onChange={(v) => onChange(v as Priority)}
      options={PRIORITY_ORDER.map((p) => ({
        value: p,
        label: PRIORITY_LABELS[p],
        leading: <Dot color={p === 'high' ? 'var(--oo-pill-high-fg)' : p === 'medium' ? 'var(--oo-ink-faint)' : 'var(--oo-check-border)'} />,
      }))}
      trigger={<PriorityPill priority={priority} />}
      testId={testId}
    />
  );
}

/** Quick due dates from today, without repeats when two land on the same day. */
function dueChoices(today: string): DropdownOption[] {
  const dow = weekday(today);
  const toFriday = (5 - dow + 7) % 7 || 7;
  const toMonday = (1 - dow + 7) % 7 || 7;
  const raw: { label: string; date: string }[] = [
    { label: 'Today', date: today },
    { label: 'Tomorrow', date: addDays(today, 1) },
    { label: dow === 5 ? 'Next Friday' : 'Friday', date: addDays(today, toFriday) },
    { label: 'Next Monday', date: addDays(today, toMonday) },
    { label: 'In a week', date: addDays(today, 7) },
  ];
  const seen = new Set<string>();
  return raw.filter((r) => !seen.has(r.date) && seen.add(r.date)).map((r) => ({ value: r.date, label: r.label, hint: formatShort(r.date) }));
}

export function DueCell({ title, due, onChange, testId, compact }: { title: string; due: string | null | undefined; onChange: (date: string | null) => void; testId: string; compact?: boolean }) {
  const today = todayLondon();
  const choices = dueChoices(today);
  const options: DropdownOption[] = due ? [...choices, { value: '', label: 'No date', group: '' }] : choices;
  return (
    <Dropdown
      variant="bare"
      ariaLabel={`Due: ${due ? formatShort(due) : 'no date'}. Change due date of ${title}`}
      value={due ?? ''}
      onChange={(v) => onChange(v || null)}
      searchable={false}
      options={options}
      trigger={
        <span className={compact ? 'oo-muted oo-num' : 'oo-num'} style={compact ? { fontSize: 12 } : undefined}>
          {due ? formatShort(due) : <span className="oo-muted">No date</span>}
        </span>
      }
      footer={(close) => (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Pick a date</span>
          <input
            type="date"
            className="oo-input"
            style={{ minHeight: 34, fontSize: 13 }}
            defaultValue={due ?? ''}
            onChange={(e) => {
              // Typing a year fires changes for 0002, 0020 and so on; wait for a real one.
              if (!e.target.value || Number(e.target.value.slice(0, 4)) < 2000) return;
              onChange(e.target.value);
              close();
            }}
            data-testid={testId + '-date'}
          />
        </label>
      )}
      testId={testId}
    />
  );
}
