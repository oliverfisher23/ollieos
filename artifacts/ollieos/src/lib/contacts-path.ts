/** Old links (/people?tab=…, /knowledge/people, /knowledge/organisations) land on the matching Contacts view. */
export function contactsPathFor(location: string, search: string): string {
  if (location === '/knowledge/organisations') return '/contacts?view=organisations';
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'overdue') return '/contacts?filter=overdue';
  if (tab === 'due-soon') return '/contacts?filter=due';
  if (tab === 'on-track' || tab === 'all') return '/contacts?filter=keep';
  return '/contacts';
}
