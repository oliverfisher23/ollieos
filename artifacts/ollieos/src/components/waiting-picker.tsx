import { useState, type ReactNode } from 'react';
import { useListPeople } from '@workspace/api-client-react';
import { Dropdown } from '@/components/dropdown';
import { personOptions } from '@/components/dropdown-options';

/** "Keep each item's own person" for a bulk Waiting on, otherwise a person id or "none". */
export const OWN = 'own';
export const NOBODY = 'none';

/** Who Ollie is waiting on, for a Review item. In bulk, the default keeps each item's own person. */
export function WaitingPicker({ bulk = false, busy, initial, hint, onConfirm, onCancel, testKey, confirmLabel = 'Add to Waiting on', children }: {
  bulk?: boolean;
  busy: boolean;
  initial: string;
  hint?: string;
  onConfirm: (personId: number | null | undefined) => void;
  onCancel: () => void;
  testKey: string;
  confirmLabel?: string;
  /** Extra choices shown before the buttons */
  children?: ReactNode;
}) {
  const people = useListPeople();
  const [value, setValue] = useState(initial);
  const id = 'rv-waiting-' + testKey;
  const options = [
    ...(bulk ? [{ value: OWN, label: "Each one's own person" }] : []),
    { value: NOBODY, label: hint ? `${hint} (not in Contacts)` : 'Someone not in Contacts' },
    ...personOptions(people.data),
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', flexBasis: '100%' }} data-testid={'picker-waiting-' + testKey}>
      <div className="oo-dd-field" style={{ minWidth: 220 }}>
        <label htmlFor={id}>Waiting on</label>
        <Dropdown id={id} variant="compact" value={value} onChange={setValue} options={options} searchPlaceholder="Search people" testId={'select-waiting-' + testKey} />
      </div>
      {children}
      <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" disabled={busy}
        onClick={() => onConfirm(value === OWN ? undefined : value === NOBODY ? null : Number(value))} data-testid={'button-waiting-confirm-' + testKey}>
        {confirmLabel}
      </button>
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}
