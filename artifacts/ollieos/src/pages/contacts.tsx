/**
 * Contacts: Ollie's contact list. People and organisations in one place, with relationship cadence
 * (feature 05) built in: who needs attention, cadence suggestions from how often he is actually in
 * touch, and a cadence on every row. Replaces the separate People (cadence) page and the People and
 * Organisations lists in Knowledge.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  dismissCadenceSuggestion,
  restoreCadenceSuggestions,
  updatePerson,
  useListCadenceSuggestions,
  useListClientPulses,
  useListOrganisations,
  useListPeople,
  type Cadence,
  type CadenceSuggestion,
  type ClientPulse,
  type OrganisationListItem,
  type PersonListItem,
} from '@workspace/api-client-react';
import { CADENCES, CADENCE_LABELS, formatDayMonthShort, isClientOrgType } from '@workspace/shared';
import { Avatar, Skel } from '@/components/bits';
import { IconRight, IconSearch } from '@/components/icons';
import { Dropdown } from '@/components/dropdown';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { HiddenFromAi, LockMark, PageProblem } from '@/components/knowledge/parts';
import { CadencePill, CadenceSelect, CheckInDialog } from '@/components/cadence';
import { PossibleDuplicates } from '@/components/knowledge/person-identity';
import { LinkedInImportDialog } from '@/components/linkedin-import';
import { firstName, useKnowledgeWrite } from '@/lib/knowledge';

type View = 'people' | 'organisations';
type Filter = 'all' | 'keep' | 'overdue' | 'due' | 'clients' | 'colleagues' | 'no-org';
type Sort = 'name' | 'recent' | 'overdue';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'keep', label: 'Keep in touch' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'due', label: 'Due soon' },
  { id: 'clients', label: 'Clients and partners' },
  { id: 'colleagues', label: 'Colleagues' },
  { id: 'no-org', label: 'No organisation' },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Last contact' },
  { value: 'overdue', label: 'Most overdue' },
];

/** Rows shown before "Show all", so a long list stays quick. */
const PAGE = 100;
const STATUS_ORDER: Record<string, number> = { overdue: 0, due_soon: 1, on_track: 2, paused: 3, none: 4 };

const isClient = (p: PersonListItem) => !p.internal && isClientOrgType(p.organisationType);
const needsCheckIn = (p: PersonListItem) => p.cadence.status === 'overdue' || p.cadence.status === 'due_soon';
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function matchFilter(p: PersonListItem, f: Filter): boolean {
  switch (f) {
    case 'keep':
      return p.cadence.cadence !== 'none';
    case 'overdue':
      return p.cadence.status === 'overdue';
    case 'due':
      return p.cadence.status === 'due_soon';
    case 'clients':
      return isClient(p);
    case 'colleagues':
      return p.internal;
    case 'no-org':
      return !p.organisation;
    default:
      return true;
  }
}

const time = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

function sortPeople(list: PersonListItem[], sort: Sort): PersonListItem[] {
  const byName = (a: PersonListItem, b: PersonListItem) => a.name.localeCompare(b.name, 'en-GB');
  if (sort === 'recent') return [...list].sort((a, b) => time(b.lastContactAt) - time(a.lastContactAt) || byName(a, b));
  if (sort === 'overdue') {
    return [...list].sort(
      (a, b) =>
        STATUS_ORDER[a.cadence.status] - STATUS_ORDER[b.cadence.status] ||
        (b.cadence.daysOverdue ?? 0) - (a.cadence.daysOverdue ?? 0) ||
        (a.cadence.daysLeft ?? 0) - (b.cadence.daysLeft ?? 0) ||
        byName(a, b),
    );
  }
  return [...list].sort(byName);
}

function matchesText(q: string, ...parts: (string | null | undefined)[]) {
  return parts.some((p) => p?.toLowerCase().includes(q));
}

/** Old links (/people?tab=…, /knowledge/people, /knowledge/organisations) land on the matching Contacts view. */
export function contactsPathFor(location: string, search: string): string {
  if (location === '/knowledge/organisations') return '/contacts?view=organisations';
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'overdue') return '/contacts?filter=overdue';
  if (tab === 'due-soon') return '/contacts?filter=due';
  if (tab === 'on-track' || tab === 'all') return '/contacts?filter=keep';
  return '/contacts';
}

export default function ContactsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const view: View = params.get('view') === 'organisations' ? 'organisations' : 'people';
  const filter: Filter = FILTERS.find((f) => f.id === params.get('filter'))?.id ?? 'all';
  const [sort, setSort] = useState<Sort>('name');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState<null | 'person' | 'organisation'>(null);
  const [drafting, setDrafting] = useState<PersonListItem | null>(null);
  const [importing, setImporting] = useState(false);

  const peopleQ = useListPeople();
  const orgsQ = useListOrganisations();
  const pulses = useListClientPulses();

  const setParams = (next: { view?: View; filter?: Filter }) => {
    const v = next.view ?? view;
    const f = next.filter ?? (next.view ? 'all' : filter);
    const qs = new URLSearchParams();
    if (v !== 'people') qs.set('view', v);
    if (f !== 'all') qs.set('filter', f);
    navigate('/contacts' + (qs.size ? '?' + qs.toString() : ''), { replace: true });
  };

  const people = useMemo(() => (peopleQ.data ?? []).filter((p) => !p.isSelf), [peopleQ.data]);
  const orgs = orgsQ.data ?? [];
  const q = text.trim().toLowerCase();
  const overdue = people.filter((p) => p.cadence.status === 'overdue').length;
  const attentionOrgs = (pulses.data ?? []).filter((p) => p.needsAttention);

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-contacts">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <h1 className="oo-h1">Contacts</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            Everyone you work with and the organisations behind them. Choose how often you want to be in touch with each key person; last contact comes from email, meetings and Slack.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <span className="oo-serif" style={{ fontSize: 22 }} data-testid="text-overdue-count">{peopleQ.data ? `${overdue} overdue` : '…'}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setImporting(true)} data-testid="button-linkedin-open">Import from LinkedIn</button>
            <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => setCreating('organisation')} data-testid="button-new-organisation">New organisation</button>
            <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={() => setCreating('person')} data-testid="button-new-person">New person</button>
          </div>
        </div>
      </div>

      <div role="search">
        <label htmlFor="contacts-search" className="oo-sr">Search contacts</label>
        <div className="oo-search" style={{ maxWidth: 420 }}>
          <IconSearch size={15} />
          <input
            id="contacts-search"
            type="search"
            placeholder="Search people and organisations"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setText('')}
            data-testid="input-contacts-search"
          />
        </div>
      </div>

      {!q && view === 'people' && filter === 'all' && peopleQ.data && (
        <NeedsAttention people={people} orgs={attentionOrgs} onDraft={setDrafting} />
      )}
      {!q && view === 'people' && (filter === 'all' || filter === 'keep') && <Suggestions />}
      {!q && view === 'people' && filter === 'all' && <PossibleDuplicates />}

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Contacts view" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {(['people', 'organisations'] as const).map((v) => (
            <button key={v} type="button" role="tab" className="oo-tab" aria-selected={view === v} onClick={() => setParams({ view: v })} data-testid={'tab-contacts-' + v}>
              {v === 'people' ? 'People' : 'Organisations'}{' '}
              <span className="oo-count oo-num">{v === 'people' ? (peopleQ.data ? people.length : '') : orgsQ.data ? orgs.length : ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={view === 'people' ? 'People' : 'Organisations'} style={{ marginTop: -10, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {view === 'people' ? (
          peopleQ.isLoading ? (
            <Loading />
          ) : !peopleQ.data ? (
            <PageProblem notFound={false} what="list" onRetry={() => peopleQ.refetch()} back={{ href: '/', label: 'Home' }} />
          ) : (
            <PeopleView people={people} filter={filter} sort={sort} q={q} onFilter={(f) => setParams({ filter: f })} onSort={setSort} onDraft={setDrafting} />
          )
        ) : orgsQ.isLoading || peopleQ.isLoading ? (
          <Loading />
        ) : !orgsQ.data ? (
          <PageProblem notFound={false} what="list" onRetry={() => orgsQ.refetch()} back={{ href: '/', label: 'Home' }} />
        ) : (
          <OrganisationsView orgs={orgs} people={people} pulses={pulses.data ?? []} q={q} onDraft={setDrafting} />
        )}
      </div>

      <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, maxWidth: '72ch' }} data-testid="text-cadence-note">
        Dates before the import come from Claude memory and may be out of date. A cadence pauses when every project you share with that person is paused or complete.
      </p>

      {creating && <CreateDialog kind={creating} onClose={() => setCreating(null)} />}
      {drafting && <CheckInDialog person={drafting} onClose={() => setDrafting(null)} />}
      {importing && <LinkedInImportDialog onClose={() => setImporting(false)} />}
    </main>
  );
}

function Loading() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>
      {[0, 1, 2, 3].map((i) => <Skel key={i} h={44} />)}
    </div>
  );
}

/* ---------- Needs attention ---------- */

function NeedsAttention({ people, orgs, onDraft }: { people: PersonListItem[]; orgs: ClientPulse[]; onDraft: (p: PersonListItem) => void }) {
  const [all, setAll] = useState(false);
  const due = sortPeople(people.filter(needsCheckIn), 'overdue');
  const total = due.length + orgs.length;
  if (!total) return null;
  const LIMIT = 5;
  const shownPeople = all ? due : due.slice(0, LIMIT);
  const shownOrgs = all ? orgs : orgs.slice(0, Math.max(0, LIMIT - shownPeople.length));
  return (
    <section aria-labelledby="attention-h" style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="section-needs-attention">
      <h2 id="attention-h" className="oo-h2">Needs attention</h2>
      {shownPeople.map((p) => (
        <div key={p.id} className="oo-krow" data-testid={'row-attention-' + p.slug}>
          <PersonCell p={p} />
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <CadencePill c={p.cadence} testId={'pill-attention-' + p.slug} />
            <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={() => onDraft(p)} data-testid={'button-draft-checkin-' + p.slug}>Draft a check-in</button>
          </span>
        </div>
      ))}
      {shownOrgs.map((o) => (
        <div key={'org' + o.organisationId} className="oo-krow" data-testid={'row-attention-org-' + o.slug}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Link href={'/knowledge/organisations/' + o.slug} className="oo-krow-link" style={{ fontWeight: 500 }}>{o.name}</Link>
            <span className="oo-muted" style={{ fontSize: 13 }}>{o.reasons.join(' · ') || o.line}</span>
          </span>
          <span className="oo-pill" data-tone="waiting">Client needs attention</span>
        </div>
      ))}
      {total > LIMIT && (
        <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setAll((v) => !v)} data-testid="button-attention-all">
          {all ? 'Show fewer' : `Show all ${total}`}
        </button>
      )}
    </section>
  );
}

/* ---------- Suggested cadences ---------- */

function Suggestions() {
  const q = useListCadenceSuggestions();
  const write = useKnowledgeWrite();
  const [all, setAll] = useState(false);
  const list = q.data?.suggestions ?? [];
  const dismissed = q.data?.dismissed ?? 0;
  if (!q.data || (!list.length && !dismissed)) return null;
  const LIMIT = 3;
  const shown = all ? list : list.slice(0, LIMIT);
  const restore = () => write(() => restoreCadenceSuggestions(), { done: 'Hidden suggestions are back' });

  return (
    <section aria-labelledby="suggest-h" style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="section-cadence-suggestions">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h2 id="suggest-h" className="oo-h2">Suggested cadences</h2>
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
          {list.length
            ? 'From how often you have actually been in touch over the last four months, your active projects and your clients.'
            : 'No new suggestions.'}
        </p>
      </div>
      {shown.map((s) => (
        <SuggestionRow key={s.person.id} s={s} />
      ))}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
        {list.length > LIMIT && (
          <button type="button" className="oo-textbtn" onClick={() => setAll((v) => !v)} data-testid="button-suggestions-all">
            {all ? 'Show fewer' : `Show all ${list.length}`}
          </button>
        )}
        {dismissed > 0 && (
          <button type="button" className="oo-textbtn" onClick={restore} data-testid="button-suggestions-restore">
            Bring back {plural(dismissed, 'hidden suggestion')}
          </button>
        )}
      </div>
    </section>
  );
}

function SuggestionRow({ s }: { s: CadenceSuggestion }) {
  const write = useKnowledgeWrite();
  const [cadence, setCadence] = useState<Cadence>(s.cadence);
  const [busy, setBusy] = useState(false);
  const p = s.person;
  const accept = async () => {
    setBusy(true);
    await write(() => updatePerson(p.slug, { cadence }), { done: `${firstName(p.name)}: ${CADENCE_LABELS[cadence].toLowerCase()}` });
    setBusy(false);
  };
  const dismiss = async () => {
    setBusy(true);
    await write(() => dismissCadenceSuggestion({ personId: p.id }), { done: `${firstName(p.name)} will not be suggested again` });
    setBusy(false);
  };
  return (
    <div className="oo-krow" data-testid={'row-suggestion-' + p.slug}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 320px' }}>
        <Avatar name={p.name} id={p.id} size={32} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link href={'/knowledge/people/' + p.slug} className="oo-krow-link" style={{ fontWeight: 500 }}>{p.name}</Link>
            {p.confidential && <LockMark />}
            {p.internal && <span className="oo-pill" data-tone="internal">Internal</span>}
          </span>
          <span className="oo-muted" style={{ fontSize: 13 }}>{[p.organisation?.name, p.role].filter(Boolean).join(' · ')}</span>
          <span style={{ fontSize: 13 }} data-testid={'text-suggestion-reason-' + p.slug}>{s.reason}</span>
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Dropdown
          variant="compact"
          ariaLabel={`Cadence for ${p.name}`}
          value={cadence}
          onChange={(v) => setCadence(v as Cadence)}
          options={CADENCES.filter((c) => c !== 'none').map((c) => ({ value: c, label: CADENCE_LABELS[c] }))}
          align="end"
          testId={'select-suggestion-' + p.slug}
        />
        <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" disabled={busy} onClick={accept} data-testid={'button-accept-suggestion-' + p.slug}>Set</button>
        <button type="button" className="oo-textbtn" disabled={busy} onClick={dismiss} data-testid={'button-dismiss-suggestion-' + p.slug}>Not now</button>
      </span>
    </div>
  );
}

/* ---------- People ---------- */

function PeopleView({
  people,
  filter,
  sort,
  q,
  onFilter,
  onSort,
  onDraft,
}: {
  people: PersonListItem[];
  filter: Filter;
  sort: Sort;
  q: string;
  onFilter: (f: Filter) => void;
  onSort: (s: Sort) => void;
  onDraft: (p: PersonListItem) => void;
}) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [filter, q]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, people.filter((p) => matchFilter(p, f.id)).length])) as Record<Filter, number>, [people]);
  const list = sortPeople(
    people.filter((p) => matchFilter(p, filter) && (!q || matchesText(q, p.name, p.role, p.organisation?.name))),
    sort,
  );
  const shown = all ? list : list.slice(0, PAGE);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', paddingTop: 12 }}>
        <div role="group" aria-label="Filter people" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className="oo-chip-toggle" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)} data-testid={'filter-contacts-' + f.id}>
              {f.label} <span className="oo-num" style={{ fontSize: 12 }}>{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <Dropdown variant="compact" ariaLabel="Sort people" value={sort} onChange={(v) => onSort(v as Sort)} options={SORTS.map((s) => ({ value: s.value, label: `Sort: ${s.label}` }))} align="end" testId="select-contacts-sort" />
      </div>

      {!list.length ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '8px 0' }} data-testid="state-contacts-empty">
          {q ? `Nobody matches "${q}".` : emptyFor(filter)}
        </p>
      ) : (
        <>
          <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="oo-table oo-table-light" data-testid="table-contacts">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Last contact</th>
                  <th scope="col">Keep in touch</th>
                  <th scope="col">Status</th>
                  <th scope="col">Open</th>
                  <th scope="col"><span className="oo-sr">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} data-testid={'row-contact-' + p.slug}>
                    <td><PersonCell p={p} /></td>
                    <td data-testid={'text-last-contact-' + p.slug}>{p.lastContactAt ? formatDayMonthShort(p.lastContactAt) : <span className="oo-muted">None on file</span>}</td>
                    <td><CadenceSelect personSlug={p.slug} name={p.name} value={p.cadence.cadence} label="Cadence" testId={'select-cadence-' + p.slug} /></td>
                    <td>{p.cadence.cadence === 'none' ? <span className="oo-muted">–</span> : <CadencePill c={p.cadence} testId={'pill-cadence-' + p.slug} />}</td>
                    <td><Owes p={p} /></td>
                    <td style={{ textAlign: 'right' }}>
                      {needsCheckIn(p) && (
                        <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => onDraft(p)} data-testid={'button-row-checkin-' + p.slug}>Check in</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="oo-cards">
            {shown.map((p) => (
              <div key={p.id} className="oo-card-row" style={{ flexDirection: 'column', alignItems: 'stretch' }} data-testid={'card-contact-' + p.slug}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <PersonCell p={p} />
                  {p.cadence.cadence !== 'none' && <CadencePill c={p.cadence} />}
                </div>
                <span className="oo-muted" style={{ fontSize: 13 }}>{p.lastContactAt ? `Last contact ${formatDayMonthShort(p.lastContactAt)}` : 'No contact on file'}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <CadenceSelect personSlug={p.slug} name={p.name} value={p.cadence.cadence} label="Cadence" testId={'select-cadence-card-' + p.slug} />
                  {(p.iOweCount > 0 || p.theyOweCount > 0) && <Owes p={p} />}
                  {needsCheckIn(p) && <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => onDraft(p)}>Check in</button>}
                </div>
              </div>
            ))}
          </div>
          {list.length > PAGE && (
            <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start' }} onClick={() => setAll((v) => !v)} data-testid="button-contacts-all">
              {all ? 'Show fewer' : `Show all ${list.length}`}
            </button>
          )}
        </>
      )}
    </>
  );
}

function emptyFor(f: Filter): string {
  switch (f) {
    case 'keep':
      return 'Nobody has a cadence yet. Pick one in the Keep in touch column, or take a suggestion above.';
    case 'overdue':
      return 'Nobody is overdue.';
    case 'due':
      return 'Nobody is due soon.';
    case 'clients':
      return 'Nobody here works at a client or partner. Set the type on the organisation.';
    case 'colleagues':
      return 'No colleagues yet. Mark your own company as internal on its organisation page.';
    case 'no-org':
      return 'Everyone has an organisation.';
    default:
      return 'Nobody here yet. People are added from email, meetings and Slack, or with New person.';
  }
}

function PersonCell({ p }: { p: PersonListItem }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Avatar name={p.name} id={p.id} size={32} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href={'/knowledge/people/' + p.slug} className="oo-krow-link" style={{ fontWeight: 500 }} data-testid={'link-contact-' + p.slug}>{p.name}</Link>
          {p.confidential ? <LockMark /> : !p.aiAccess && <HiddenFromAi confidential={false} />}
          {p.internal && <span className="oo-pill" data-tone="internal" data-testid={'pill-internal-' + p.slug}>Internal</span>}
        </span>
        {(p.organisation || p.role) && <span className="oo-muted" style={{ fontSize: 13 }}>{[p.organisation?.name, p.role].filter(Boolean).join(' · ')}</span>}
      </span>
    </span>
  );
}

function Owes({ p }: { p: PersonListItem }) {
  if (!p.iOweCount && !p.theyOweCount) return <span className="oo-muted">–</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {p.iOweCount > 0 && <span className="oo-pill" data-tone="waiting">I owe {p.iOweCount}</span>}
      {p.theyOweCount > 0 && <span className="oo-pill">Owes me {p.theyOweCount}</span>}
    </span>
  );
}

/* ---------- Organisations ---------- */

function OrganisationsView({
  orgs,
  people,
  pulses,
  q,
  onDraft,
}: {
  orgs: OrganisationListItem[];
  people: PersonListItem[];
  pulses: ClientPulse[];
  q: string;
  onDraft: (p: PersonListItem) => void;
}) {
  const attention = new Map(pulses.filter((p) => p.needsAttention).map((p) => [p.organisationId, p]));
  const byOrg = useMemo(() => {
    const m = new Map<number, PersonListItem[]>();
    for (const p of people) if (p.organisation) m.set(p.organisation.id, [...(m.get(p.organisation.id) ?? []), p]);
    return m;
  }, [people]);
  // An organisation matches by its own name or type, or by someone who works there.
  const visible = orgs.filter((o) => !q || matchesText(q, o.name, o.type) || (byOrg.get(o.id) ?? []).some((p) => matchesText(q, p.name, p.role)));
  const external = visible.filter((o) => !o.internal).sort((a, b) => Number(attention.has(b.id)) - Number(attention.has(a.id)) || a.name.localeCompare(b.name, 'en-GB'));
  const internal = visible.filter((o) => o.internal);

  if (!visible.length) {
    return (
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '16px 0' }} data-testid="state-organisations-empty">
        {q ? `No organisation matches "${q}".` : 'No organisations yet. Add one, then set it on the people who work there.'}
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 12 }}>
      <OrgGroup title="External" orgs={external} byOrg={byOrg} attention={attention} q={q} onDraft={onDraft} testId="group-orgs-external" />
      <OrgGroup title="Internal" orgs={internal} byOrg={byOrg} attention={attention} q={q} onDraft={onDraft} testId="group-orgs-internal" />
    </div>
  );
}

function OrgGroup({
  title,
  orgs,
  byOrg,
  attention,
  q,
  onDraft,
  testId,
}: {
  title: string;
  orgs: OrganisationListItem[];
  byOrg: Map<number, PersonListItem[]>;
  attention: Map<number, ClientPulse>;
  q: string;
  onDraft: (p: PersonListItem) => void;
  testId: string;
}) {
  if (!orgs.length) return null;
  const id = testId + '-h';
  return (
    <section aria-labelledby={id} data-testid={testId}>
      <h2 id={id} className="oo-h2" style={{ marginBottom: 6 }}>{title}</h2>
      {orgs.map((o) => (
        <OrgRow key={o.id} o={o} people={byOrg.get(o.id) ?? []} pulse={attention.get(o.id)} openByDefault={!!q} onDraft={onDraft} />
      ))}
    </section>
  );
}

function OrgRow({ o, people, pulse, openByDefault, onDraft }: { o: OrganisationListItem; people: PersonListItem[]; pulse?: ClientPulse; openByDefault: boolean; onDraft: (p: PersonListItem) => void }) {
  const [open, setOpen] = useState(openByDefault);
  const [adding, setAdding] = useState(false);
  useEffect(() => setOpen(openByDefault), [openByDefault]);
  const keep = people.filter((p) => p.cadence.cadence !== 'none').length;
  const panelId = 'org-people-' + o.slug;
  return (
    <div style={{ borderBottom: '1px solid var(--oo-line-soft)' }} data-testid={'row-org-' + o.slug}>
      <div className="oo-krow" style={{ borderBottom: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <button
            type="button"
            className="oo-btn oo-btn-outline oo-btn-sm"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? 'Hide' : 'Show'} people at ${o.name}`}
            onClick={() => setOpen((v) => !v)}
            style={{ minWidth: 32, padding: '4px 6px' }}
            data-testid={'button-toggle-org-' + o.slug}
          >
            <span aria-hidden="true" style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}><IconRight size={14} /></span>
          </button>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Link href={'/knowledge/organisations/' + o.slug} className="oo-krow-link" style={{ fontWeight: 500 }} data-testid={'link-org-' + o.slug}>{o.name}</Link>
              {(o.confidential || !o.aiAccess) && <HiddenFromAi confidential={o.confidential} />}
            </span>
            <span className="oo-muted" style={{ fontSize: 13 }}>
              {[o.type, plural(o.peopleCount, 'person', 'people'), keep ? `${keep} with a cadence` : null].filter(Boolean).join(' · ')}
            </span>
          </span>
        </span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }} className="oo-muted">
          {pulse && <span className="oo-pill" data-tone="waiting" title={pulse.reasons.join(' · ')}>Needs attention</span>}
          <span>{o.lastContactAt ? `Last contact ${formatDayMonthShort(o.lastContactAt)}` : 'No contact on file'}</span>
        </span>
      </div>
      {open && (
        <div id={panelId} style={{ padding: '0 0 12px 40px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {people.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Nobody linked to {o.name} yet.</p>
          ) : (
            sortPeople(people, 'name').map((p) => (
              <div key={p.id} className="oo-krow" style={{ padding: '8px 0' }} data-testid={'row-org-person-' + p.slug}>
                <PersonCell p={p} />
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {p.cadence.cadence !== 'none' && <CadencePill c={p.cadence} />}
                  <CadenceSelect personSlug={p.slug} name={p.name} value={p.cadence.cadence} label="Cadence" testId={'select-org-cadence-' + p.slug} />
                  {needsCheckIn(p) && <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => onDraft(p)}>Check in</button>}
                </span>
              </div>
            ))
          )}
          <button type="button" className="oo-textbtn" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => setAdding(true)} data-testid={'button-add-person-' + o.slug}>
            Add a person at {o.name}
          </button>
          {adding && <CreateDialog kind="person" presetOrganisationId={o.id} onClose={() => setAdding(false)} />}
        </div>
      )}
    </div>
  );
}
