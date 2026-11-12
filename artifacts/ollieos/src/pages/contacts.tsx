/**
 * Contacts: Ollie's contact list. People and organisations in one place, with relationship cadence
 * (feature 05) built in: who needs attention, cadence suggestions from how often he is actually in
 * touch, and a cadence on every row. Replaces the separate People (cadence) page and the People and
 * Organisations lists in Knowledge.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  bulkUpdatePeople,
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
import { CADENCES, CADENCE_LABELS, isClientOrgType } from '@workspace/shared';
import { Avatar, Skel } from '@/components/bits';
import { IconMore, IconRight, IconSearch } from '@/components/icons';
import { Dropdown } from '@/components/dropdown';
import { ScrollRow } from '@/components/scroll-row';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { HiddenFromAi, LockMark, PageProblem } from '@/components/knowledge/parts';
import { CadencePill, CadenceSelect, CheckInDialog } from '@/components/cadence';
import { PossibleDuplicates } from '@/components/knowledge/person-identity';
import { LinkedInImportDialog } from '@/components/linkedin-import';
import { AutoAddedMark } from '@/components/contact-finder';
import { ContactNoteDialog, StrengthPill, contactDate, contactLinks } from '@/components/contact-bits';
import { ContactPanel } from '@/components/contact-panel';
import { MissingFromContacts } from '@/components/contact-missing';
import { firstName, useKnowledgeWrite } from '@/lib/knowledge';

type View = 'people' | 'organisations';
type Filter = 'all' | 'keep' | 'overdue' | 'due' | 'clients' | 'colleagues' | 'no-org' | 'archive' | 'archived';
type Sort = 'name' | 'recent' | 'overdue' | 'strength';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'keep', label: 'Keep in touch' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'due', label: 'Due soon' },
  { id: 'clients', label: 'Clients and partners' },
  { id: 'colleagues', label: 'Colleagues' },
  { id: 'no-org', label: 'No organisation' },
  { id: 'archive', label: 'Could archive' },
  { id: 'archived', label: 'Archived' },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Last contact' },
  { value: 'overdue', label: 'Most overdue' },
  { value: 'strength', label: 'Strength' },
];

/** Rows shown before "Show all", so a long list stays quick. */
const PAGE = 100;
const STATUS_ORDER: Record<string, number> = { overdue: 0, due_soon: 1, on_track: 2, paused: 3, none: 4 };
const STRENGTH_ORDER: Record<string, number> = { strong: 0, warm: 1, cooling: 2, cold: 3 };

const isClient = (p: PersonListItem) => !p.internal && isClientOrgType(p.organisationType);
const needsCheckIn = (p: PersonListItem) => p.cadence.status === 'overdue' || p.cadence.status === 'due_soon';
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function matchFilter(p: PersonListItem, f: Filter): boolean {
  // Archived people are only in their own view.
  if (f === 'archived') return p.archived;
  if (p.archived) return false;
  switch (f) {
    case 'archive':
      return p.archiveCandidate;
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
  if (sort === 'strength') return [...list].sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] || time(b.lastContactAt) - time(a.lastContactAt) || byName(a, b));
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
  const [tag, setTag] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);

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

  const everyone = useMemo(() => (peopleQ.data ?? []).filter((p) => !p.isSelf), [peopleQ.data]);
  // Archived people only show in their own view.
  const people = useMemo(() => everyone.filter((p) => !p.archived), [everyone]);
  const allTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of everyone) for (const t of p.tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en-GB'));
  }, [everyone]);
  const orgs = orgsQ.data ?? [];
  const q = text.trim().toLowerCase();
  const overdue = people.filter((p) => p.cadence.status === 'overdue').length;
  const couldArchive = people.filter((p) => p.archiveCandidate).length;
  // The quick view follows the list, so a change made in it shows straight away.
  const open = openId != null ? (everyone.find((p) => p.id === openId) ?? null) : null;
  const attentionOrgs = (pulses.data ?? []).filter((p) => p.needsAttention);

  return (
    <>
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
      {!q && view === 'people' && filter === 'all' && <MissingFromContacts />}
      {!q && view === 'people' && filter === 'all' && <PossibleDuplicates />}
      {!q && view === 'people' && filter === 'all' && couldArchive > 0 && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-could-archive">
          {plural(couldArchive, 'person', 'people')} you have not spoken to in a year, with no project and nothing open.{' '}
          <button type="button" className="oo-textbtn" onClick={() => setParams({ filter: 'archive' })} data-testid="button-review-archive">Review</button>
        </p>
      )}

      <ScrollRow className="-mx-4 px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Contacts view" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {(['people', 'organisations'] as const).map((v) => (
            <button key={v} type="button" role="tab" className="oo-tab" aria-selected={view === v} onClick={() => setParams({ view: v })} data-testid={'tab-contacts-' + v}>
              {v === 'people' ? 'People' : 'Organisations'}{' '}
              <span className="oo-count oo-num">{v === 'people' ? (peopleQ.data ? people.length : '') : orgsQ.data ? orgs.length : ''}</span>
            </button>
          ))}
        </div>
      </ScrollRow>

      <div role="tabpanel" aria-label={view === 'people' ? 'People' : 'Organisations'} style={{ marginTop: -10, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {view === 'people' ? (
          peopleQ.isLoading ? (
            <Loading />
          ) : !peopleQ.data ? (
            <PageProblem notFound={false} what="list" onRetry={() => peopleQ.refetch()} back={{ href: '/', label: 'Home' }} />
          ) : (
            <PeopleView
              people={everyone}
              orgs={orgs}
              filter={filter}
              sort={sort}
              tag={allTags.includes(tag) ? tag : ''}
              allTags={allTags}
              q={q}
              onFilter={(f) => setParams({ filter: f })}
              onSort={setSort}
              onTag={setTag}
              onOpen={(p) => setOpenId(p.id)}
              onDraft={setDrafting}
            />
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
    {open && <ContactPanel p={open} allTags={allTags} onClose={() => setOpenId(null)} onDraft={() => setDrafting(open)} />}
    </>
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

/** Clicks on a control inside a row (a link, a button, a picker's list) are not a click on the row. */
const onControl = (e: { target: EventTarget }) => !!(e.target as HTMLElement).closest('a, button, input, select, label, [role="option"], [cmdk-root], [role="dialog"]');

function PeopleView({
  people,
  orgs,
  filter,
  sort,
  tag,
  allTags,
  q,
  onFilter,
  onSort,
  onTag,
  onOpen,
  onDraft,
}: {
  people: PersonListItem[];
  orgs: OrganisationListItem[];
  filter: Filter;
  sort: Sort;
  tag: string;
  allTags: string[];
  q: string;
  onFilter: (f: Filter) => void;
  onSort: (s: Sort) => void;
  onTag: (t: string) => void;
  onOpen: (p: PersonListItem) => void;
  onDraft: (p: PersonListItem) => void;
}) {
  const write = useKnowledgeWrite();
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [noting, setNoting] = useState<{ kind: 'task' | 'point'; p: PersonListItem } | null>(null);
  useEffect(() => {
    setAll(false);
    setPicked(new Set());
  }, [filter, q, tag]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, people.filter((p) => matchFilter(p, f.id)).length])) as Record<Filter, number>, [people]);
  const tagKey = tag.toLowerCase();
  const list = sortPeople(
    people.filter((p) => matchFilter(p, filter) && (!tag || p.tags.some((t) => t.toLowerCase() === tagKey)) && (!q || matchesText(q, p.name, p.role, p.organisation?.name, p.email, ...p.tags))),
    sort,
  );
  const shown = all ? list : list.slice(0, PAGE);
  const pickedHere = shown.filter((p) => picked.has(p.id));
  const allPicked = shown.length > 0 && pickedHere.length === shown.length;
  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const archive = (p: PersonListItem) => void write(() => updatePerson(p.slug, { archived: !p.archived }), { done: p.archived ? `${firstName(p.name)} is back in Contacts` : `${firstName(p.name)} archived` });
  const archiveAll = () => void write(() => bulkUpdatePeople({ ids: list.map((p) => p.id), archived: true }), { done: `${plural(list.length, 'person', 'people')} archived` });
  // Chips for the two archive views appear only when there is someone in them.
  const chips = FILTERS.filter((f) => (f.id !== 'archive' && f.id !== 'archived') || counts[f.id] > 0 || filter === f.id);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', paddingTop: 12 }}>
        <div role="group" aria-label="Filter people" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((f) => (
            <button key={f.id} type="button" className="oo-chip-toggle" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)} data-testid={'filter-contacts-' + f.id}>
              {f.label} <span className="oo-num" style={{ fontSize: 12 }}>{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {allTags.length > 0 && (
            <Dropdown
              variant="compact"
              ariaLabel="Filter by tag"
              value={tag}
              onChange={onTag}
              options={[{ value: '', label: 'Tag: any' }, ...allTags.map((t) => ({ value: t, label: `Tag: ${t}` }))]}
              align="end"
              testId="select-contacts-tag"
            />
          )}
          <Dropdown variant="compact" ariaLabel="Sort people" value={sort} onChange={(v) => onSort(v as Sort)} options={SORTS.map((s) => ({ value: s.value, label: `Sort: ${s.label}` }))} align="end" testId="select-contacts-sort" />
        </div>
      </div>

      {filter === 'archive' && list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }} data-testid="banner-could-archive">
          <p className="oo-muted" style={{ margin: 0, fontSize: 13, maxWidth: '64ch' }}>
            No contact in a year (or none on file), no cadence, no active project and nothing open between you. Archiving takes someone out of this list; they come back by themselves if you are in touch again.
          </p>
          <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={archiveAll} data-testid="button-archive-all">Archive all {list.length}</button>
        </div>
      )}

      {!list.length ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '8px 0' }} data-testid="state-contacts-empty">
          {q ? `Nobody matches "${q}".` : tag ? `Nobody here has the tag ${tag}.` : emptyFor(filter)}
        </p>
      ) : (
        <>
          <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="oo-table oo-table-light" data-testid="table-contacts">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      className="oo-rv-select"
                      checked={allPicked}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((p) => p.id)))}
                      aria-label="Select everyone shown"
                      data-testid="checkbox-contacts-all"
                    />
                  </th>
                  <th scope="col">Person</th>
                  <th scope="col">Strength</th>
                  <th scope="col">Last contact</th>
                  <th scope="col">Keep in touch</th>
                  <th scope="col">Status</th>
                  <th scope="col">Open</th>
                  <th scope="col"><span className="oo-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="oo-contact-row" onClick={(e) => !onControl(e) && onOpen(p)} data-testid={'row-contact-' + p.slug}>
                    <td>
                      <input type="checkbox" className="oo-rv-select" checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.name}`} data-testid={'checkbox-contact-' + p.slug} />
                    </td>
                    <td><PersonCell p={p} onOpen={() => onOpen(p)} /></td>
                    <td><StrengthPill strength={p.strength} testId={'pill-strength-' + p.slug} /></td>
                    <td data-testid={'text-last-contact-' + p.slug}>{p.lastContactAt ? contactDate(p.lastContactAt) : <span className="oo-muted">None on file</span>}</td>
                    <td><CadenceSelect personSlug={p.slug} name={p.name} value={p.cadence.cadence} label="Cadence" testId={'select-cadence-' + p.slug} /></td>
                    <td>{p.cadence.cadence === 'none' ? <span className="oo-muted">–</span> : <CadencePill c={p.cadence} testId={'pill-cadence-' + p.slug} />}</td>
                    <td><Owes p={p} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {needsCheckIn(p) && (
                          <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => onDraft(p)} data-testid={'button-row-checkin-' + p.slug}>Check in</button>
                        )}
                        <RowMenu p={p} onDraft={() => onDraft(p)} onNote={(kind) => setNoting({ kind, p })} onArchive={() => archive(p)} />
                      </span>
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
                  <PersonCell p={p} onOpen={() => onOpen(p)} />
                  <RowMenu p={p} onDraft={() => onDraft(p)} onNote={(kind) => setNoting({ kind, p })} onArchive={() => archive(p)} />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <StrengthPill strength={p.strength} />
                  {p.cadence.cadence !== 'none' && <CadencePill c={p.cadence} />}
                  <span className="oo-muted" style={{ fontSize: 13 }}>{p.lastContactAt ? `Last contact ${contactDate(p.lastContactAt)}` : 'No contact on file'}</span>
                </div>
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

      {pickedHere.length > 0 && <BulkBar people={pickedHere} orgs={orgs} allTags={allTags} archivedView={filter === 'archived'} onDone={() => setPicked(new Set())} />}
      {noting && <ContactNoteDialog kind={noting.kind} person={noting.p} onClose={() => setNoting(null)} />}
    </>
  );
}

/** The ⋯ menu on a row: email, Slack and LinkedIn open in their own apps; the rest happen here. */
function RowMenu({ p, onDraft, onNote, onArchive }: { p: PersonListItem; onDraft: () => void; onNote: (kind: 'task' | 'point') => void; onArchive: () => void }) {
  const [, navigate] = useLocation();
  const l = contactLinks(p);
  const options = [
    l.email && { value: 'email', label: 'Email' },
    l.slack && { value: 'slack', label: 'Message on Slack' },
    l.linkedin && { value: 'linkedin', label: 'Open LinkedIn' },
    l.phone && { value: 'phone', label: `Call ${p.phone}` },
    { value: 'point', label: 'Add a talking point' },
    { value: 'task', label: 'Add a task' },
    needsCheckIn(p) && { value: 'checkin', label: 'Draft a check-in' },
    { value: 'page', label: 'Open full page' },
    { value: 'archive', label: p.archived ? 'Bring back from the archive' : 'Archive' },
  ].filter((o): o is { value: string; label: string } => !!o);
  const act = (v: string) => {
    if (v === 'email' && l.email) window.location.href = l.email;
    else if (v === 'phone' && l.phone) window.location.href = l.phone;
    else if (v === 'slack' && l.slack) window.open(l.slack, '_blank', 'noopener');
    else if (v === 'linkedin' && l.linkedin) window.open(l.linkedin, '_blank', 'noopener');
    else if (v === 'point' || v === 'task') onNote(v);
    else if (v === 'checkin') onDraft();
    else if (v === 'page') navigate('/knowledge/people/' + p.slug);
    else if (v === 'archive') onArchive();
  };
  return <Dropdown variant="bare" ariaLabel={`Actions for ${p.name}`} value="" onChange={act} options={options} searchable={false} align="end" trigger={<span style={{ display: 'inline-flex', flex: 'none' }}><IconMore size={18} /></span>} style={{ color: 'var(--oo-ink-soft)' }} testId={'menu-contact-' + p.slug} />;
}

/** One change to everyone selected. */
function BulkBar({ people, orgs, allTags, archivedView, onDone }: { people: PersonListItem[]; orgs: OrganisationListItem[]; allTags: string[]; archivedView: boolean; onDone: () => void }) {
  const write = useKnowledgeWrite();
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = people.map((p) => p.id);
  const n = plural(ids.length, 'person', 'people');
  const run = async (patch: Omit<Parameters<typeof bulkUpdatePeople>[0], 'ids'>, done: string, clear = false) => {
    setBusy(true);
    const r = await write(() => bulkUpdatePeople({ ids, ...patch }), { done });
    setBusy(false);
    if (r && clear) onDone();
  };
  return (
    <div className="oo-bulk-bar" role="region" aria-label="Change the selected people" data-testid="bar-contacts-bulk">
      <span className="oo-num" style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-contacts-selected">{ids.length} selected</span>
      <Dropdown
        variant="compact"
        ariaLabel="Set a cadence for the selected people"
        value=""
        placeholder="Set cadence"
        disabled={busy}
        onChange={(v) => void run({ cadence: v as Cadence }, `Cadence set for ${n}`)}
        options={CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }))}
        testId="select-bulk-cadence"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = tag.trim();
          if (!t) return;
          setTag('');
          void run({ addTag: t }, `${t} added to ${n}`);
        }}
        style={{ display: 'inline-flex', gap: 6 }}
      >
        <label className="oo-sr" htmlFor="bulk-tag">Tag to add to the selected people</label>
        <input id="bulk-tag" className="oo-input oo-input-sm" style={{ width: 130 }} list="bulk-tags" maxLength={40} placeholder="Add a tag" value={tag} onChange={(e) => setTag(e.target.value)} disabled={busy} data-testid="input-bulk-tag" />
        <datalist id="bulk-tags">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
        <button type="submit" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy || !tag.trim()} data-testid="button-bulk-tag">Tag</button>
      </form>
      <Dropdown
        variant="compact"
        ariaLabel="Set the organisation for the selected people"
        value=""
        placeholder="Set organisation"
        searchPlaceholder="Search organisations"
        disabled={busy}
        onChange={(v) => void run({ organisationId: v === 'none' ? null : Number(v) }, `Organisation set for ${n}`)}
        options={[{ value: 'none', label: 'No organisation' }, ...orgs.map((o) => ({ value: String(o.id), label: o.name, hint: o.type ?? undefined }))]}
        testId="select-bulk-organisation"
      />
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={() => void run({ archived: !archivedView }, archivedView ? `${n} back in Contacts` : `${n} archived`, true)} data-testid="button-bulk-archive">
        {archivedView ? 'Bring back' : 'Archive'}
      </button>
      <button type="button" className="oo-textbtn" onClick={onDone} data-testid="button-bulk-clear">Clear</button>
    </div>
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
    case 'archive':
      return 'Nobody to archive: everyone here is someone you have spoken to in the last year, or has something open.';
    case 'archived':
      return 'Nobody is archived.';
    default:
      return 'Nobody here yet. People are added from email, meetings and Slack, or with New person.';
  }
}

function PersonCell({ p, onOpen }: { p: PersonListItem; onOpen?: () => void }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Avatar name={p.name} id={p.id} size={32} />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {onOpen ? (
            <button type="button" className="oo-contact-name oo-tap" onClick={onOpen} data-testid={'button-open-contact-' + p.slug}>{p.name}</button>
          ) : (
            <Link href={'/knowledge/people/' + p.slug} className="oo-krow-link" style={{ fontWeight: 500 }} data-testid={'link-contact-' + p.slug}>{p.name}</Link>
          )}
          {p.confidential ? <LockMark /> : !p.aiAccess && <HiddenFromAi confidential={false} />}
          {p.internal && <span className="oo-pill" data-tone="internal" data-testid={'pill-internal-' + p.slug}>Internal</span>}
          {p.tags.slice(0, 3).map((t) => <span key={t} className="oo-tag">{t}</span>)}
          {p.tags.length > 3 && <span className="oo-muted" style={{ fontSize: 12 }}>+{p.tags.length - 3}</span>}
          <AutoAddedMark p={p} />
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
            style={{ minWidth: 44, minHeight: 44, padding: 0 }}
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
          <span>{o.lastContactAt ? `Last contact ${contactDate(o.lastContactAt)}` : 'No contact on file'}</span>
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
