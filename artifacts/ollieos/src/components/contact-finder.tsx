import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  findContacts,
  getGetContactFinderSettingsQueryKey,
  getListPeopleQueryKey,
  setContactFinderSettings,
  undoAutoAddedContact,
  useGetContactFinderSettings,
  type PersonListItem,
} from '@workspace/api-client-react';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const H2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;

/**
 * Section 25: the contact finder on Settings, Knowledge. It proposes people you are in real two-way
 * contact with who are not in Contacts; "Add automatically when sure" (off until you turn it on)
 * adds the clearest ones itself.
 */
export function ContactFinderPanel() {
  const q = useGetContactFinderSettings();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const autoAdd = q.data?.autoAdd ?? false;

  const toggle = async () => {
    setBusy('save');
    try {
      const r = await setContactFinderSettings({ autoAdd: !autoAdd });
      qc.setQueryData(getGetContactFinderSettingsQueryKey(), r);
      notify(r.autoAdd ? 'The clearest people are now added to Contacts by themselves' : 'New people now come as cards in the Knowledge Inbox');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const run = async () => {
    setBusy('run');
    try {
      const r = await findContacts();
      await qc.invalidateQueries({ queryKey: getListPeopleQueryKey() });
      const parts = [
        r.people && `${r.people} ${r.people === 1 ? 'person' : 'people'}`,
        r.organisations && `${r.organisations} ${r.organisations === 1 ? 'organisation' : 'organisations'}`,
        r.emails && `${r.emails} ${r.emails === 1 ? 'email' : 'emails'} for people you have`,
      ].filter(Boolean);
      notify(
        r.failed ? 'The contact finder stopped early' : parts.length || r.added ? 'Done' : 'Nobody new',
        [parts.length ? `${parts.join(', ')} in the Knowledge Inbox.` : '', r.added ? `${r.added} added to Contacts.` : ''].filter(Boolean).join(' ') || 'No one else you are in two-way contact with is missing from Contacts.',
      );
    } catch (err) {
      reportApiError(err);
      notify('The contact finder did not run', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="ks-contacts-h" data-testid="section-contact-finder">
      <h2 id="ks-contacts-h" style={H2}>New people and organisations</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
        The contact finder looks for people you are in real two-way contact with (you both wrote in email threads, a Slack conversation, or a meeting) who are not in Contacts. Each comes to the <Link href="/knowledge/inbox">Knowledge Inbox</Link> with their organisation, role and how you know them. A new company comes as one organisation card with its people under it. Shared inboxes, automated senders and anything hidden from AI are left out.
      </p>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, marginTop: 8, maxWidth: '64ch', cursor: 'pointer' }}>
        <input type="checkbox" checked={autoAdd} disabled={q.isLoading || busy === 'save'} onChange={() => void toggle()} style={{ marginTop: 3 }} data-testid="checkbox-contact-auto-add" />
        <span>
          <strong style={{ fontWeight: 500 }}>Add automatically when sure.</strong>{' '}
          <span className="oo-soft">
            Someone you have both written to more than once (or met and written to) at an organisation already in Contacts is added straight away, marked "Added by OllieOS" with Undo. Everyone else still comes as a card. Off until you turn it on; the Agents page shows how often you keep its cards.
          </span>
        </span>
      </label>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="oo-btn oo-btn-outline" disabled={!!busy} onClick={() => void run()} data-testid="button-find-contacts">
          {busy === 'run' ? 'Looking…' : 'Look for new people now'}
        </button>
      </div>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, maxWidth: '64ch' }}>
        To start from the last six months of email, run the relationship look back below: it also records who you have been writing to.
      </p>
    </section>
  );
}

/** On Contacts: "Added by OllieOS" on someone the contact finder added by itself, with Undo. */
export function AutoAddedMark({ p }: { p: PersonListItem }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!p.autoAddedAt) return null;
  const undo = async () => {
    setBusy(true);
    try {
      await undoAutoAddedContact(p.id);
      await qc.invalidateQueries({ queryKey: getListPeopleQueryKey() });
      notify(`Removed ${p.name}`, 'They will not be suggested again.');
    } catch (err) {
      reportApiError(err);
      notify('Not removed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="oo-pill" data-testid={'pill-auto-added-' + p.slug}>Added by OllieOS</span>
      <button type="button" className="oo-textbtn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void undo()} data-testid={'button-undo-auto-add-' + p.slug}>
        {busy ? 'Undoing…' : 'Undo'}
      </button>
    </span>
  );
}
