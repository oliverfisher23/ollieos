/** Relationship cadence (feature 05): the status pill, the cadence picker and the check-in draft, shared by Contacts and the person page. */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'wouter';
import { draftCheckIn, updatePerson, type Cadence, type CheckInDraft } from '@workspace/api-client-react';
import { CADENCES, CADENCE_LABELS } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { copyText, firstName, useKnowledgeWrite } from '@/lib/knowledge';
import { Dropdown } from '@/components/dropdown';
import { errorMessage, notify } from '@/lib/notify';

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** "Overdue 4 days", "Due in 3 days", "On track", "Paused". */
export function cadenceStatusLabel(c: { status: string; daysOverdue: number | null; daysLeft: number | null; daysSince: number | null }): string {
  if (c.status === 'overdue') return c.daysOverdue != null ? `Overdue ${days(c.daysOverdue)}` : 'Overdue, no contact on file';
  if (c.status === 'due_soon') return c.daysLeft === 0 ? 'Due today' : `Due in ${days(c.daysLeft ?? 0)}`;
  if (c.status === 'on_track') return 'On track';
  if (c.status === 'paused') return 'Paused';
  return 'No cadence';
}

export function CadencePill({ c, testId }: { c: Parameters<typeof cadenceStatusLabel>[0]; testId?: string }) {
  return <span className="oo-pill oo-cad-pill" data-status={c.status} data-testid={testId}>{cadenceStatusLabel(c)}</span>;
}

/** A small select that saves straight away. Used on Contacts and the person page. */
export function CadenceSelect({ personSlug, name, value, label, testId }: { personSlug: string; name: string; value: Cadence; label: string; testId: string }) {
  const write = useKnowledgeWrite();
  return (
    <Dropdown
      variant="compact"
      ariaLabel={`${label} for ${name}`}
      value={value}
      onChange={(v) => {
        const next = v as Cadence;
        void write(() => updatePerson(personSlug, { cadence: next }), { done: next === 'none' ? `${firstName(name)} has no cadence now` : `Cadence set to ${CADENCE_LABELS[next].toLowerCase()}` });
      }}
      options={CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }))}
      align="end"
      testId={testId}
    />
  );
}

/** Drafts a check-in from the person page and their project. OllieOS shows it to copy; it never sends anything. */
export function CheckInDialog({ person, onClose }: { person: { slug: string; name: string }; onClose: () => void }) {
  const [state, setState] = useState<{ draft?: CheckInDraft; error?: string; loading: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const first = firstName(person.name);

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    draftCheckIn(person.slug)
      .then((draft) => live && setState({ draft, loading: false }))
      .catch((err) => live && setState({ error: errorMessage(err, 'The draft could not be written just now. Try again in a moment.'), loading: false }));
    return () => {
      live = false;
    };
  }, [person.slug, attempt]);

  const copy = async () => {
    if (!state.draft) return;
    if (await copyText(state.draft.text)) notify('Draft copied', 'Paste it into your email or Slack.');
    else notify('Could not copy', 'Your browser blocked the clipboard.');
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 600 }} aria-describedby="checkin-desc" data-testid="dialog-checkin">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Check in with {first}</Dialog.Title>
            <p id="checkin-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              Built from {first}’s page and your shared project. OllieOS never sends this; copy it and send it yourself.
            </p>
            {state.loading ? (
              <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="state-checkin-loading">
                <Skel h={14} w="90%" /><Skel h={14} w="80%" /><Skel h={14} w="60%" />
              </div>
            ) : state.error ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p role="alert" style={{ margin: 0, fontSize: 14 }} data-testid="text-checkin-error">{state.error}</p>
                <div><button type="button" className="oo-btn oo-btn-outline" onClick={() => setAttempt((n) => n + 1)} data-testid="button-checkin-retry">Try again</button></div>
              </div>
            ) : state.draft ? (
              <>
                <pre className="oo-draft-box" data-testid="text-checkin-draft">{state.draft.text}</pre>
                {state.draft.threads.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="oo-muted" style={{ fontSize: 12 }}>Open threads it mentions</span>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="list-checkin-threads">
                      {state.draft.threads.map((t) => (
                        <li key={t.ref}><Link href={t.path} className="oo-link" onClick={onClose}>{t.title}</Link></li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : null}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Dialog.Close asChild>
                <button type="button" className="oo-btn oo-btn-outline" data-testid="button-close-checkin">Close</button>
              </Dialog.Close>
              <button type="button" className="oo-btn oo-btn-ink" disabled={!state.draft} onClick={copy} data-testid="button-copy-checkin">Copy draft</button>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
