/**
 * One person across every tool (Part N): their other email addresses, their Slack account,
 * "Same person as…" (merging two records) and the "Possible duplicates" list on the People page.
 */
import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'wouter';
import {
  markPeopleNotSame,
  mergePerson,
  updatePerson,
  useFindSlackAccounts,
  useListPeople,
  useListPossibleDuplicates,
  type DuplicatePair,
  type Person,
} from '@workspace/api-client-react';
import { Dropdown } from '@/components/dropdown';
import { firstName, useKnowledgeWrite } from '@/lib/knowledge';
import { notify } from '@/lib/notify';

/** "Other emails": addresses this person also uses. Mail from any of them is matched to them. */
export function OtherEmails({ person }: { person: Person }) {
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const list = person.otherEmails ?? [];
  const save = (otherEmails: string[], done: string) => write(() => updatePerson(person.slug, { otherEmails }), { done, fail: 'Could not save that' });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim().toLowerCase();
    if (!v) return;
    if (await save([...list, v], `${v} added`)) {
      setValue('');
      setAdding(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }} data-testid="section-other-emails">
      {list.length === 0 && !adding && <span className="oo-muted">None</span>}
      {list.map((e) => (
        <span key={e} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 6, alignItems: 'baseline', maxWidth: '100%' }} data-testid={`text-other-email-${e}`}>
          <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{e}</span>
          <button
            type="button"
            className="oo-textbtn"
            style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}
            aria-label={`Remove ${e}`}
            onClick={() => save(list.filter((x) => x !== e), `${e} removed`)}
            data-testid={`button-remove-email-${e}`}
          >
            Remove
          </button>
        </span>
      ))}
      {adding ? (
        <form onSubmit={add} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%' }}>
          <label htmlFor="other-email" className="oo-sr">Another email address</label>
          <input
            id="other-email"
            type="email"
            className="oo-input"
            autoFocus
            placeholder="name@example.com"
            value={value}
            maxLength={320}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
            style={{ flex: '1 1 160px', minWidth: 0 }}
            data-testid="input-other-email"
          />
          <button type="submit" className="oo-btn oo-btn-ink oo-btn-sm" disabled={!value.trim()} data-testid="button-save-other-email">Add</button>
          <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="oo-textbtn" onClick={() => setAdding(true)} data-testid="button-add-other-email">Add another address</button>
      )}
    </div>
  );
}

/** "Also known as" (section 28): other names this person goes by, so a task that says "Volodymyr" finds "Vova". */
export function OtherNames({ person }: { person: Person }) {
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const list = person.otherNames ?? [];
  const save = (otherNames: string[], done: string) => write(() => updatePerson(person.slug, { otherNames }), { done, fail: 'Could not save that' });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (await save([...list, v], `${v} added`)) {
      setValue('');
      setAdding(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }} data-testid="section-other-names">
      {list.length === 0 && !adding && <span className="oo-muted">None</span>}
      {list.map((n) => (
        <span key={n} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 6, alignItems: 'baseline', maxWidth: '100%' }} data-testid={`text-other-name-${n}`}>
          <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{n}</span>
          <button type="button" className="oo-textbtn" style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }} aria-label={`Remove ${n}`}
            onClick={() => save(list.filter((x) => x !== n), `${n} removed`)} data-testid={`button-remove-name-${n}`}>Remove</button>
        </span>
      ))}
      {adding ? (
        <form onSubmit={add} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%' }}>
          <label htmlFor="other-name" className="oo-sr">Another name</label>
          <input id="other-name" className="oo-input" autoFocus placeholder="A nickname or full first name" value={value} maxLength={100}
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} style={{ flex: '1 1 160px', minWidth: 0 }} data-testid="input-other-name" />
          <button type="submit" className="oo-btn oo-btn-ink oo-btn-sm" disabled={!value.trim()} data-testid="button-save-other-name">Add</button>
          <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="oo-textbtn" onClick={() => setAdding(true)} data-testid="button-add-other-name">Add another name</button>
      )}
    </div>
  );
}

/** "Slack": which Slack account is this person. Messages from it are matched to them. */
export function SlackAccount({ person }: { person: Person }) {
  const write = useKnowledgeWrite();
  const [picking, setPicking] = useState(false);
  const linked = person.slackUserId ?? null;
  const accounts = useFindSlackAccounts({ q: '' }, { query: { enabled: picking || !!linked, staleTime: 10 * 60_000 } as never });
  const current = linked ? accounts.data?.find((a) => a.id === linked) : undefined;
  const set = (slackUserId: string | null, done: string) =>
    write(() => updatePerson(person.slug, { slackUserId }), { done, fail: 'Could not save that' }).then((r) => {
      if (r) setPicking(false);
    });

  if (picking) {
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', width: '100%' }}>
        {accounts.error ? (
          <span className="oo-muted" style={{ fontSize: 13 }} role="alert">Could not reach Slack. Check the Slack connection in Settings.</span>
        ) : (
          <Dropdown
            variant="compact"
            ariaLabel="Slack account"
            value={linked ?? ''}
            defaultOpen
            onChange={(v) => {
              const a = accounts.data?.find((x) => x.id === v);
              if (a) void set(a.id, `Linked to ${a.name} on Slack`);
            }}
            placeholder={accounts.isLoading ? 'Loading Slack…' : 'Choose their Slack account'}
            searchPlaceholder="Search Slack"
            disabled={accounts.isLoading}
            options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name, hint: a.email ?? '@' + a.handle }))}
            testId="select-slack-account"
            style={{ width: '100%' }}
          />
        )}
        <button type="button" className="oo-textbtn" style={{ fontSize: 12 }} onClick={() => setPicking(false)}>Cancel</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }} data-testid="section-slack-account">
      {linked ? (
        <span data-testid="text-slack-account">{current ? current.name : accounts.isLoading ? 'Linked' : 'Linked account'}</span>
      ) : (
        <span className="oo-muted">Not linked</span>
      )}
      <button type="button" className="oo-textbtn" onClick={() => setPicking(true)} data-testid="button-pick-slack">{linked ? 'Change' : 'Link'}</button>
      {linked && (
        <button type="button" className="oo-textbtn" onClick={() => set(null, 'Slack account unlinked')} data-testid="button-unlink-slack">Unlink</button>
      )}
    </span>
  );
}

/** "Same person as…": merge another record into this one. */
export function SamePersonAs({ person }: { person: Person }) {
  const people = useListPeople();
  const [otherId, setOtherId] = useState<number | null>(null);
  const other = people.data?.find((p) => p.id === otherId);
  const options = (people.data ?? []).filter((p) => p.id !== person.id).map((p) => ({ value: String(p.id), label: p.name, hint: p.organisation?.name ?? undefined }));
  return (
    <>
      <Dropdown
        variant="compact"
        ariaLabel="Same person as"
        value=""
        onChange={(v) => setOtherId(Number(v))}
        placeholder="Same person as…"
        searchPlaceholder="Search people"
        disabled={people.isLoading}
        options={options}
        testId="select-same-person"
      />
      {other && <MergeDialog keep={{ slug: person.slug, name: person.name }} gone={{ id: other.id, name: other.name }} onClose={() => setOtherId(null)} />}
    </>
  );
}

/** Confirms a merge: everything on `gone` moves onto `keep`, and `gone` is removed. */
function MergeDialog({ keep, gone, onClose }: { keep: { slug: string; name: string }; gone: { id: number; name: string }; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    const r = await write(() => mergePerson(keep.slug, { otherId: gone.id }), { fail: 'Could not merge them' });
    setBusy(false);
    if (r) {
      const moved = [
        r.moved.facts && `${r.moved.facts} ${r.moved.facts === 1 ? 'fact' : 'facts'}`,
        r.moved.tasks && `${r.moved.tasks} ${r.moved.tasks === 1 ? 'task' : 'tasks'}`,
        r.moved.meetings && `${r.moved.meetings} ${r.moved.meetings === 1 ? 'meeting' : 'meetings'}`,
      ].filter(Boolean);
      notify(`Merged into ${keep.name}`, moved.length ? `Moved ${moved.join(', ')}.` : undefined);
      onClose();
    }
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 480 }} aria-describedby="merge-desc" data-testid="dialog-merge-person">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Merge {gone.name} into {keep.name}?</Dialog.Title>
            <p id="merge-desc" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              Everything on {gone.name} moves to {keep.name}: facts, notes, tasks, meetings, links, relationships and email addresses. {keep.name}’s details win where both have one. {gone.name} is then removed. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="oo-btn oo-btn-outline" onClick={onClose} disabled={busy} data-testid="button-merge-cancel">Cancel</button>
              <button type="button" className="oo-btn oo-btn-ink" onClick={merge} disabled={busy} data-testid="button-merge-confirm">
                {busy ? 'Merging…' : 'Merge'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "Possible duplicates" on the People page: pairs with the same name or a matching email. */
export function PossibleDuplicates() {
  const q = useListPossibleDuplicates();
  const write = useKnowledgeWrite();
  const [merging, setMerging] = useState<DuplicatePair | null>(null);
  const pairs = q.data ?? [];
  if (!pairs.length) return null;
  return (
    <section className="oo-kcard" aria-labelledby="dupes-h" data-testid="section-possible-duplicates">
      <h2 id="dupes-h" className="oo-h2">Possible duplicates</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>These look like the same person. Merge them so everything is in one place, or say they are different people.</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pairs.map((d) => (
          <li key={`${d.a.id}-${d.b.id}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }} data-testid={`row-duplicate-${d.a.id}-${d.b.id}`}>
            <span style={{ minWidth: 0 }}>
              <Link href={'/knowledge/people/' + d.a.slug} className="oo-krow-link">{d.a.name}</Link>
              <span className="oo-muted"> and </span>
              <Link href={'/knowledge/people/' + d.b.slug} className="oo-krow-link">{d.b.name}</Link>
              <span className="oo-muted" style={{ fontSize: 13 }}> · {d.reason}</span>
            </span>
            <span style={{ display: 'inline-flex', gap: 10 }}>
              <button type="button" className="oo-textbtn" onClick={() => setMerging(d)} data-testid={`button-merge-${d.a.id}-${d.b.id}`}>Merge</button>
              <button
                type="button"
                className="oo-textbtn"
                onClick={() => write(() => markPeopleNotSame({ aId: d.a.id, bId: d.b.id }), { done: `${firstName(d.a.name)} and ${firstName(d.b.name)} kept apart`, fail: 'Could not save that' })}
                data-testid={`button-not-same-${d.a.id}-${d.b.id}`}
              >
                Different people
              </button>
            </span>
          </li>
        ))}
      </ul>
      {merging && <MergeDialog keep={{ slug: merging.a.slug, name: merging.a.name }} gone={{ id: merging.b.id, name: merging.b.name }} onClose={() => setMerging(null)} />}
    </section>
  );
}
