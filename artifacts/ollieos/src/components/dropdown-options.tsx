import { BUSINESS_FUNCTIONS, BUSINESS_FUNCTION_LABELS } from '@workspace/shared';
import type { DropdownOption } from './dropdown';

/** Option lists for the pickers that appear in several places. */

/** Projects, with the four functions first under their own heading when the list has them. */
export function projectOptions(projects: { id: number; name: string; isFunction?: boolean }[] | undefined): DropdownOption[] {
  const list = projects ?? [];
  if (!list.some((p) => p.isFunction)) return list.map((p) => ({ value: String(p.id), label: p.name }));
  return [
    ...list.filter((p) => p.isFunction).map((p) => ({ value: String(p.id), label: p.name, group: 'Functions' })),
    ...list.filter((p) => !p.isFunction).map((p) => ({ value: String(p.id), label: p.name, group: 'Projects' })),
  ];
}

/** The parts of the business, with Not set first. */
export const FUNCTION_OPTIONS: DropdownOption[] = [
  { value: '', label: 'Not set' },
  ...BUSINESS_FUNCTIONS.map((f) => ({ value: f, label: BUSINESS_FUNCTION_LABELS[f] })),
];

/** People, with their organisation as a hint so two people with similar names are easy to tell apart. */
export function personOptions(people: { id: number; name: string; organisation?: { name: string } | null }[] | undefined): DropdownOption[] {
  return (people ?? []).map((p) => ({ value: String(p.id), label: p.name, hint: p.organisation?.name }));
}

/** Goals in the order given, with sub-goals one step in. */
export function goalOptions(goals: { id: number; name: string; parentId?: number | null }[] | undefined): DropdownOption[] {
  return (goals ?? []).map((g) => ({ value: String(g.id), label: g.name, indent: g.parentId != null }));
}

/** Organisations under External and Internal headings, once there is an internal one. */
export function orgOptions(orgs: { id: number; name: string; internal: boolean }[] | undefined): DropdownOption[] {
  const list = orgs ?? [];
  const grouped = list.some((o) => o.internal);
  const row = (o: { id: number; name: string; internal: boolean }): DropdownOption => ({
    value: String(o.id),
    label: o.name,
    group: grouped ? (o.internal ? 'Internal' : 'External') : undefined,
  });
  return [...list.filter((o) => !o.internal).map(row), ...list.filter((o) => o.internal).map(row)];
}
