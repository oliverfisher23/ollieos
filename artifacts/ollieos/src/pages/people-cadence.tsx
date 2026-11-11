import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation, useSearch } from 'wouter';
import {
  draftCheckIn,
  updatePerson,
  useListCadence,
  type Cadence,
  type CadenceRow,
  type CadenceTab,
  type CheckInDraft,
} from '@workspace/api-client-react';
import { CADENCES, CADENCE_LABELS, formatDayMonthShort } from '@workspace/shared';
import { Avatar, Skel } from '@/components/bits';
import { LockMark, PageProblem } from '@/components/knowledge/parts';
import { copyText, firstName, useKnowledgeWrite } from '@/lib/knowledge';
import { Dropdown } from '@/components/dropdown';
import { errorMessage, notify } from '@/lib/notify';
import { ScrollRow } from '@/components/scroll-row';

const TABS: { id: CadenceTab; url: string; label: string }[] = [
  { id: 'all', url: 'all', label: 'All' },
  { id: 'overdue', url: 'overdue', label: 'Overdue' },
  { id: 'due_soon', url: 'due-soon', label: 'Due soon' },
  { id: 'on_track', url: 'on-track', label: 'On track' },
];

const EMPTY: Record<CadenceTab, string> = {
  all: 'Nobody has a cadence yet. Open a person and choose how often you want to be in touch.',
  overdue: 'Nobody is overdue.',
  due_soon: 'Nobody is due soon.',
  on_track: 'Nobody is on track yet.',
};

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

export default function PeopleCadencePage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = new URLSearchParams(search).get('tab');
  const tab = TABS.find((t) => t.url === raw)?.id ?? 'all';
  const q = useListCadence({ tab });
  const [drafting, setDrafting] = useState<CadenceRow | null>(null);
  const counts = q.data?.counts;

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-people-cadence">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <h1 className="oo-h1">People</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            How often you want to be in touch with each key person, and who you have not heard from in a while. Last contact comes from email, meetings and Slack.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <span className="oo-serif" style={{ fontSize: 22 }} data-testid="text-overdue-count">{counts ? `${counts.overdue} overdue` : '…'}</span>
          <Link href="/knowledge/people" className="oo-link" style={{ fontSize: 13 }} data-testid="link-everyone">Everyone</Link>
        </div>
      </div>

      <ScrollRow className="-mx-4 px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Cadence status" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="oo-tab"
              aria-selected={t.id === tab}
              onClick={() => navigate(t.id === 'all' ? '/people' : `/people?tab=${t.url}`, { replace: true })}
              data-testid={'tab-cadence-' + t.url}
            >
              {t.label} <span className="oo-count oo-num">{counts ? counts[t.id] : ''}</span>
            </button>
          ))}
        </div>
      </ScrollRow>

      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} style={{ marginTop: -10 }}>
        {q.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>{[0, 1, 2, 3].map((i) => <Skel key={i} h={44} />)}</div>
        ) : !q.data ? (
          <PageProblem notFound={false} what="list" onRetry={() => q.refetch()} back={{ href: '/', label: 'Home' }} />
        ) : q.data.people.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '16px 0' }} data-testid="state-cadence-empty">{EMPTY[tab]}</p>
        ) : (
          <>
            <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="oo-table oo-table-light" data-testid="table-cadence">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Project</th>
                    <th scope="col">Cadence</th>
                    <th scope="col">Last contact</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span className="oo-sr">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.people.map((p) => (
                    <tr key={p.id} data-testid={'row-cadence-' + p.slug}>
                      <td><PersonCell p={p} /></td>
                      <td>{p.project ? <Link href={'/knowledge/projects/' + p.project.slug} className="oo-krow-link">{p.project.name}</Link> : <span className="oo-muted">None</span>}</td>
                      <td>{p.cadenceLabel}</td>
                      <td data-testid={'text-last-contact-' + p.slug}>{p.lastContactAt ? formatDayMonthShort(p.lastContactAt) : <span className="oo-muted">None on file</span>}</td>
                      <td><CadencePill c={p} testId={'pill-cadence-' + p.slug} /></td>
                      <td style={{ textAlign: 'right' }}><RowAction p={p} onDraft={() => setDrafting(p)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="oo-cards">
              {q.data.people.map((p) => (
                <div key={p.id} className="oo-card-row" style={{ flexDirection: 'column' }} data-testid={'card-cadence-' + p.slug}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%' }}>
                    <PersonCell p={p} />
                    <CadencePill c={p} />
                  </div>
                  <span className="oo-muted" style={{ fontSize: 13 }}>
                    {[p.cadenceLabel, p.project?.name, p.lastContactAt ? `last contact ${formatDayMonthShort(p.lastContactAt)}` : 'no contact on file'].filter(Boolean).join(' · ')}
                  </span>
                  <RowAction p={p} onDraft={() => setDrafting(p)} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, maxWidth: '72ch' }} data-testid="text-cadence-note">
        Dates before the import come from Claude memory and may be out of date. A cadence pauses when every project you share with that person is paused or complete.
      </p>

      {drafting && <CheckInDialog person={drafting} onClose={() => setDrafting(null)} />}
    </main>
  );
}

function PersonCell({ p }: { p: CadenceRow }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Avatar name={p.name} id={p.id} size={32} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Link href={'/knowledge/people/' + p.slug} className="oo-krow-link" style={{ fontWeight: 500, display: 'inline-flex', gap: 6, alignItems: 'center' }} data-testid={'link-cadence-person-' + p.slug}>
          {p.name}
          {p.confidential && <LockMark />}
        </Link>
        {(p.organisation || p.role) && <span className="oo-muted" style={{ fontSize: 13 }}>{[p.organisation?.name, p.role].filter(Boolean).join(' · ')}</span>}
      </span>
    </span>
  );
}

function RowAction({ p, onDraft }: { p: CadenceRow; onDraft: () => void }) {
  if (p.status === 'overdue' || p.status === 'due_soon') {
    return (
      <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={onDraft} data-testid={'button-draft-checkin-' + p.slug}>
        Draft a check-in
      </button>
    );
  }
  return <CadenceSelect personSlug={p.slug} name={p.name} value={p.cadence} label="Change cadence" testId={'select-cadence-' + p.slug} />;
}

/** A small select that saves straight away. Used on the cadence page and the person page. */
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
