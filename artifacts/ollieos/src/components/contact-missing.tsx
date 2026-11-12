/**
 * "Missing from Contacts": people on two or more work meetings in the calendar who have no record
 * yet. Add puts them in Contacts under the organisation that owns their email domain; Not now
 * stops them being listed (and the contact finder leaves them alone too).
 */
import { useState } from 'react';
import { addMissingContact, dismissMissingContact, useListMissingContacts, type MissingContact } from '@workspace/api-client-react';
import { formatDayMonthShort } from '@workspace/shared';
import { Avatar } from '@/components/bits';
import { firstName, useKnowledgeWrite } from '@/lib/knowledge';

const LIMIT = 3;

export function MissingFromContacts() {
  const q = useListMissingContacts();
  const [all, setAll] = useState(false);
  const list = q.data?.people ?? [];
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, LIMIT);
  return (
    <section aria-labelledby="missing-h" style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="section-missing-contacts">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 id="missing-h" className="oo-h2">Missing from Contacts</h2>
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>People on two or more work meetings in your calendar who are not in Contacts yet.</p>
      </div>
      {shown.map((m) => <MissingRow key={m.email} m={m} />)}
      {list.length > LIMIT && (
        <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setAll((v) => !v)} data-testid="button-missing-all">
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

function MissingRow({ m }: { m: MissingContact }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    await write(fn, { done });
    setBusy(false);
  };
  const when = [
    `${m.meetings} meetings`,
    m.lastMetAt ? `last ${formatDayMonthShort(m.lastMetAt)}` : null,
    m.nextMeetingAt ? `next ${formatDayMonthShort(m.nextMeetingAt)}` : null,
  ].filter(Boolean).join(' · ');
  const key = m.email.replace(/[^a-z0-9]+/g, '-');
  return (
    <div className="oo-krow" data-testid={'row-missing-' + key}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 320px' }}>
        <Avatar name={m.name} id={m.email} size={32} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{m.name}</span>
          <span className="oo-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{[m.organisation?.name, m.email].filter(Boolean).join(' · ')}</span>
          <span style={{ fontSize: 13 }}>{when}{m.titles.length ? `: ${m.titles.join(', ')}` : ''}</span>
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="oo-btn oo-btn-ink oo-btn-sm"
          disabled={busy}
          onClick={() => void run(() => addMissingContact({ email: m.email }), `${firstName(m.name)} added${m.organisation ? ` at ${m.organisation.name}` : ''}`)}
          data-testid={'button-missing-add-' + key}
        >
          Add
        </button>
        <button type="button" className="oo-textbtn" disabled={busy} onClick={() => void run(() => dismissMissingContact({ email: m.email }), `${firstName(m.name)} will not be listed again`)} data-testid={'button-missing-dismiss-' + key}>
          Not now
        </button>
      </span>
    </div>
  );
}
