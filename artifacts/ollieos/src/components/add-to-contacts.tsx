import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createOrganisation, createPerson, getListMeetingsQueryKey, useListOrganisations, type OrgSuggestion } from '@workspace/api-client-react';
import { Dropdown } from '@/components/dropdown';
import { orgOptions } from '@/components/dropdown-options';
import { useKnowledgeWrite } from '@/lib/knowledge';

/** "andy.dillow@example.com" becomes "Andy Dillow", as a starting point Ollie can change. */
export function nameFromInvite(name: string): string {
  if (!name.includes('@')) return name;
  return name
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const NEW = 'new';
const NONE = 'none';

/**
 * Add someone on a meeting to Contacts, with their organisation: the one colleagues at the same email
 * domain belong to, or a new one named after the domain, which is created in the same step.
 * Refreshes the meeting and its prep page so the person shows as known straight away.
 */
export function AddToContacts({
  name,
  email,
  suggestion,
  testId,
  onDone,
}: {
  name: string;
  email: string | null;
  suggestion: OrgSuggestion | null;
  testId: string;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const write = useKnowledgeWrite();
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState(() => nameFromInvite(name));
  const [org, setOrg] = useState(() => (suggestion?.existing ? String(suggestion.existing.id) : suggestion?.newName ? NEW : NONE));
  const [newOrg, setNewOrg] = useState(suggestion?.newName ?? '');
  const [busy, setBusy] = useState(false);
  const orgs = useListOrganisations({ query: { enabled: open } as never });

  if (!open) {
    return (
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)} data-testid={'button-add-contact-' + testId}>
        Add to Contacts
      </button>
    );
  }

  const options = [
    { value: NEW, label: newOrg.trim() ? `New organisation: ${newOrg.trim()}` : 'New organisation' },
    ...orgOptions(orgs.data),
    { value: NONE, label: 'No organisation' },
  ];
  // The suggested organisation is offered even before the list has loaded.
  if (suggestion?.existing && !options.some((o) => o.value === String(suggestion.existing!.id))) {
    options.splice(1, 0, { value: String(suggestion.existing.id), label: suggestion.existing.name });
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = person.trim();
    if (!n || busy || (org === NEW && !newOrg.trim())) return;
    setBusy(true);
    const created = await write(
      async () => {
        let organisationId: number | null = org === NONE || org === NEW ? null : Number(org);
        if (org === NEW) organisationId = (await createOrganisation({ name: newOrg.trim(), internal: !!suggestion?.internal })).id;
        return createPerson({ name: n, email, organisationId });
      },
      { done: `${n} added to Contacts`, fail: 'Could not add that person' },
    );
    setBusy(false);
    if (!created) return;
    setOpen(false);
    await Promise.all([
      qc.invalidateQueries({ predicate: (q) => /\/(meetings|briefs)\b/.test(String(q.queryKey[0] ?? '')) }),
      qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() }),
    ]);
    onDone?.();
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }} data-testid={'form-add-contact-' + testId}>
      <label className="oo-field-label" htmlFor={'contact-name-' + testId}>Name</label>
      <input id={'contact-name-' + testId} className="oo-input" value={person} maxLength={200} onChange={(e) => setPerson(e.target.value)} autoFocus data-testid={'input-contact-name-' + testId} />
      <label className="oo-field-label" htmlFor={'contact-org-' + testId}>Organisation</label>
      <Dropdown id={'contact-org-' + testId} value={org} onChange={setOrg} options={options} searchable ariaLabel="Organisation" testId={'select-contact-org-' + testId} />
      {org === NEW && (
        <input className="oo-input" value={newOrg} maxLength={200} onChange={(e) => setNewOrg(e.target.value)} placeholder="Organisation name" aria-label="New organisation name" data-testid={'input-contact-new-org-' + testId} />
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="oo-btn oo-btn-ink oo-btn-sm" disabled={busy || !person.trim() || (org === NEW && !newOrg.trim())} data-testid={'button-contact-save-' + testId}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
