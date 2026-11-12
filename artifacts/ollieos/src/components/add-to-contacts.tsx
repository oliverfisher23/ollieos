import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
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

/** Someone on a meeting who is not in Contacts yet. */
export interface ContactCandidate {
  name: string;
  email: string | null;
  suggestion: OrgSuggestion | null;
}

const NEW = 'new';
const NONE = 'none';

interface Row {
  include: boolean;
  name: string;
  email: string | null;
  org: string;
  newOrg: string;
  internal: boolean;
}

const rowFor = (c: ContactCandidate): Row => ({
  include: true,
  name: nameFromInvite(c.name),
  email: c.email,
  org: c.suggestion?.existing ? String(c.suggestion.existing.id) : c.suggestion?.newName ? NEW : NONE,
  newOrg: c.suggestion?.newName ?? '',
  internal: !!c.suggestion?.internal,
});

/** A button that opens Add to Contacts for one person ("Add to Contacts") or several ("Add 3 to Contacts"). */
export function AddToContactsButton({ people, testId, primary }: { people: ContactCandidate[]; testId: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!people.length) return null;
  return (
    <>
      <button
        type="button"
        className={'oo-btn oo-btn-sm ' + (primary ? 'oo-btn-ink' : 'oo-btn-outline')}
        style={{ whiteSpace: 'nowrap' }}
        onClick={() => setOpen(true)}
        data-testid={'button-add-contact-' + testId}
      >
        {people.length === 1 ? 'Add to Contacts' : `Add ${people.length} to Contacts`}
      </button>
      {open && <AddToContactsDialog people={people} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Adds people from a meeting to Contacts, each with an organisation: the one colleagues at the same
 * email domain belong to, or a new one named after the domain. New organisations are created once,
 * however many people share them. Refreshes the meeting and its prep page afterwards.
 */
function AddToContactsDialog({ people, onClose }: { people: ContactCandidate[]; onClose: () => void }) {
  const qc = useQueryClient();
  const write = useKnowledgeWrite();
  const orgs = useListOrganisations({ query: {} as never });
  const [rows, setRows] = useState<Row[]>(() => people.map(rowFor));
  const [busy, setBusy] = useState(false);
  const many = rows.length > 1;
  const chosen = rows.filter((r) => r.include);
  const valid = chosen.length > 0 && chosen.every((r) => r.name.trim() && (r.org !== NEW || r.newOrg.trim()));

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const baseOptions = orgOptions(orgs.data);
  const optionsFor = (r: Row, c: ContactCandidate) => {
    const opts = [{ value: NEW, label: r.newOrg.trim() ? `New: ${r.newOrg.trim()}` : 'New organisation' }, ...baseOptions, { value: NONE, label: 'No organisation' }];
    // The suggested organisation is offered even before the list has loaded.
    const s = c.suggestion?.existing;
    if (s && !opts.some((o) => o.value === String(s.id))) opts.splice(1, 0, { value: String(s.id), label: s.name });
    return opts;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const done = await write(
      async () => {
        // One new organisation per name, shared by everyone who belongs to it.
        const created = new Map<string, number>();
        for (const r of chosen) {
          if (r.org !== NEW) continue;
          const key = r.newOrg.trim().toLowerCase();
          if (!created.has(key)) created.set(key, (await createOrganisation({ name: r.newOrg.trim(), internal: r.internal })).id);
        }
        for (const r of chosen) {
          const organisationId = r.org === NEW ? created.get(r.newOrg.trim().toLowerCase())! : r.org === NONE ? null : Number(r.org);
          await createPerson({ name: r.name.trim(), email: r.email, organisationId });
        }
        return chosen.length;
      },
      { done: chosen.length === 1 ? `${chosen[0].name.trim()} added to Contacts` : `${chosen.length} people added to Contacts`, fail: 'Could not add everyone' },
    );
    // Some may have been added before a failure, so refresh either way.
    await Promise.all([
      qc.invalidateQueries({ predicate: (q) => /\/(meetings|briefs)\b/.test(String(q.queryKey[0] ?? '')) }),
      qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() }),
    ]);
    setBusy(false);
    if (done) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: many ? 640 : 460 }} aria-describedby={undefined} data-testid="dialog-add-contacts">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{many ? 'Add people to Contacts' : 'Add to Contacts'}</Dialog.Title>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: many ? 0 : 14 }}>
                {rows.map((r, i) => (
                  <div
                    key={i}
                    className={many ? 'oo-contact-row' : undefined}
                    style={many ? undefined : { display: 'flex', flexDirection: 'column', gap: 14 }}
                    data-included={r.include || undefined}
                    data-testid={'row-add-contact-' + i}
                  >
                    {many && (
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) => update(i, { include: e.target.checked })}
                        aria-label={`Add ${r.name || r.email || 'this person'}`}
                        className="oo-contact-check"
                        data-testid={'check-add-contact-' + i}
                      />
                    )}
                    <div className="oo-dd-field" style={{ minWidth: 0 }}>
                      <label htmlFor={'contact-name-' + i}>Name</label>
                      <input id={'contact-name-' + i} className="oo-input" value={r.name} maxLength={200} disabled={!r.include} onChange={(e) => update(i, { name: e.target.value })} autoFocus={i === 0} data-testid={'input-contact-name-' + i} />
                      {r.email && <span className="oo-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{r.email}</span>}
                    </div>
                    <div className="oo-dd-field" style={{ minWidth: 0 }}>
                      <label htmlFor={'contact-org-' + i}>Organisation</label>
                      <Dropdown id={'contact-org-' + i} value={r.org} onChange={(org) => update(i, { org })} options={optionsFor(r, people[i])} searchable disabled={!r.include} ariaLabel="Organisation" testId={'select-contact-org-' + i} />
                      {r.org === NEW && (
                        <input className="oo-input" value={r.newOrg} maxLength={200} disabled={!r.include} onChange={(e) => update(i, { newOrg: e.target.value })} placeholder="Organisation name" aria-label="New organisation name" data-testid={'input-contact-new-org-' + i} />
                      )}
                      {r.org !== NEW && r.org !== NONE && people[i].suggestion?.existing && String(people[i].suggestion!.existing!.id) === r.org && (
                        <span className="oo-muted" style={{ fontSize: 12 }}>From their email address</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" disabled={busy}>Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={busy || !valid} data-testid="button-contact-save">
                  {busy ? 'Adding…' : chosen.length > 1 ? `Add ${chosen.length} people` : 'Add'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
