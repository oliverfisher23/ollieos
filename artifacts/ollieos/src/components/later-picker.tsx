import { addDays, formatShort, todayLondon, weekday } from '@workspace/shared';
import { Dropdown, type DropdownOption } from '@/components/dropdown';

/** Working days on from a date, skipping weekends. */
export function workingDaysOn(date: string, days: number): string {
  let d = date;
  let counted = 0;
  while (counted < days) {
    d = addDays(d, 1);
    const w = weekday(d);
    if (w !== 0 && w !== 6) counted++;
  }
  return d;
}

/** Quick choices for a day ahead, without repeats when two land on the same day. */
export function dayChoices(today: string): DropdownOption[] {
  const dow = weekday(today);
  const toMonday = (1 - dow + 7) % 7 || 7;
  const raw = [
    { label: 'Tomorrow', date: addDays(today, 1) },
    { label: 'In 3 working days', date: workingDaysOn(today, 3) },
    { label: 'Next Monday', date: addDays(today, toMonday) },
    { label: 'In a week', date: addDays(today, 7) },
    { label: 'In 2 weeks', date: addDays(today, 14) },
  ];
  const seen = new Set<string>();
  return raw.filter((r) => !seen.has(r.date) && seen.add(r.date)).map((r) => ({ value: r.date, label: r.label, hint: formatShort(r.date) }));
}

/** "Later": hides a message until the day picked. */
export function LaterPicker({ what, disabled, onPick, testId }: { what: string; disabled?: boolean; onPick: (date: string) => void; testId: string }) {
  const today = todayLondon();
  return (
    <Dropdown
      variant="compact"
      ariaLabel={`Hide ${what} until a later day`}
      value=""
      onChange={(v) => v && onPick(v)}
      searchable={false}
      disabled={disabled}
      options={dayChoices(today)}
      trigger={<span>Later</span>}
      footer={(close) => (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Pick a date</span>
          <input
            type="date"
            className="oo-input"
            style={{ minHeight: 34, fontSize: 13 }}
            min={addDays(today, 1)}
            onChange={(e) => {
              // Typing a year fires changes for 0002, 0020 and so on; wait for a real one after today.
              if (!e.target.value || e.target.value <= today) return;
              onPick(e.target.value);
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
