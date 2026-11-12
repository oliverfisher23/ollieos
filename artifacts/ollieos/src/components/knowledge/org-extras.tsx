/**
 * On an organisation page: the email domains that belong to it, merging a duplicate record into it,
 * and a small org chart from the "reports to" relationships between the people who work there.
 */
import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'wouter';
import { mergeOrganisation, setOrganisationDomains, useListOrganisations, type Organisation, type OrganisationDetail } from '@workspace/api-client-react';
import { Avatar } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { useKnowledgeWrite } from '@/lib/knowledge';
import { notify } from '@/lib/notify';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** "acme.com": new people who write from it are placed here, and people with no organisation are moved here now. */
export function OrgDomains({ org }: { org: Organisation }) {
  const write = useKnowledgeWrite();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (domains: string[]) => {
    setBusy(true);
    const r = await write(() => setOrganisationDomains(org.slug, { domains }), { fail: 'That domain was not saved' });
    setBusy(false);
    if (!r) return false;
    if (r.placed.length) notify(`${plural(r.placed.length, 'person', 'people')} placed at ${org.name}`, r.placed.map((p) => p.name).join(', '));
    else notify('Email domains saved');
    return true;
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    if (await save([...org.domains, v])) setText('');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="section-org-domains">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span className="oo-muted" style={{ fontSize: 13 }}>Email domains</span>
        {org.domains.map((d) => (
          <span key={d} className="oo-tag" data-testid={'tag-domain-' + d}>
            @{d}
            <button type="button" aria-label={`Remove ${d} from ${org.name}`} disabled={busy} onClick={() => void save(org.domains.filter((x) => x !== d))}>×</button>
          </span>
        ))}
        <form onSubmit={add} style={{ display: 'inline-flex', gap: 6 }}>
          <label className="oo-sr" htmlFor="org-domain">Add an email domain for {org.name}</label>
          <input id="org-domain" className="oo-input oo-input-sm" style={{ width: 150 }} placeholder="acme.com" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} data-testid="input-org-domain" />
          <button type="submit" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy || !text.trim()} data-testid="button-org-domain-add">Add</button>
        </form>
      </div>
      <span className="oo-muted" style={{ fontSize: 12, maxWidth: '64ch' }}>
        People who write from {org.domains.length ? 'these addresses' : 'an address you add here'} are placed at {org.name}: anyone with no organisation now, and new people as they are added.
      </span>
    </div>
  );
}

/** "Same organisation as…": merge another record into this one. */
export function SameOrganisationAs({ org }: { org: Organisation }) {
  const orgs = useListOrganisations();
  const write = useKnowledgeWrite();
  const [otherId, setOtherId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const other = orgs.data?.find((o) => o.id === otherId);
  const options = (orgs.data ?? []).filter((o) => o.id !== org.id).map((o) => ({ value: String(o.id), label: o.name, hint: plural(o.peopleCount, 'person', 'people') }));
  const merge = async () => {
    if (!other) return;
    setBusy(true);
    const r = await write(() => mergeOrganisation(org.slug, { otherId: other.id }), { fail: 'Could not merge them' });
    setBusy(false);
    if (!r) return;
    const moved = [r.moved.people && plural(r.moved.people, 'person', 'people'), r.moved.facts && plural(r.moved.facts, 'fact'), r.moved.links && plural(r.moved.links, 'link')].filter(Boolean);
    notify(`Merged into ${org.name}`, moved.length ? `Moved ${moved.join(', ')}.` : undefined);
    setOtherId(null);
  };
  return (
    <section aria-labelledby="same-org-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }} data-testid="section-org-merge">
      <h2 id="same-org-h" className="oo-h2">Duplicate record?</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>If another organisation in Contacts is also {org.name}, merge it here so everything is in one place.</p>
      <div>
        <Dropdown
          variant="compact"
          ariaLabel="Same organisation as"
          value=""
          onChange={(v) => setOtherId(Number(v))}
          placeholder="Same organisation as…"
          searchPlaceholder="Search organisations"
          disabled={orgs.isLoading}
          options={options}
          testId="select-same-organisation"
        />
      </div>
      {other && (
        <Dialog.Root open onOpenChange={(o) => !o && !busy && setOtherId(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="oo-modal-scrim">
              <Dialog.Content className="oo-modal" style={{ maxWidth: 480 }} aria-describedby="merge-org-desc" data-testid="dialog-merge-organisation">
                <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Merge {other.name} into {org.name}?</Dialog.Title>
                <p id="merge-org-desc" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                  Everything on {other.name} moves to {org.name}: its people, facts, notes, projects, products, playbooks, relationships, research and email domains. {org.name}’s details win where both have one. {other.name} is then removed. This cannot be undone.
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="oo-btn oo-btn-outline" onClick={() => setOtherId(null)} disabled={busy} data-testid="button-merge-org-cancel">Cancel</button>
                  <button type="button" className="oo-btn oo-btn-ink" onClick={merge} disabled={busy} data-testid="button-merge-org-confirm">{busy ? 'Merging…' : 'Merge'}</button>
                </div>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </section>
  );
}

type ChartPerson = OrganisationDetail['people'][number];

/** Who reports to whom. Drawn only from "reports to" relationships between people who work here. */
export function OrgChart({ people, reportsTo, name }: { people: ChartPerson[]; reportsTo: OrganisationDetail['reportsTo']; name: string }) {
  if (!reportsTo.length) return null;
  const byId = new Map(people.map((p) => [p.id, p]));
  const edges = reportsTo.filter((e) => byId.has(e.personId) && byId.has(e.managerId) && e.personId !== e.managerId);
  if (!edges.length) return null;
  const managerOf = new Map(edges.map((e) => [e.personId, e.managerId]));
  const reports = new Map<number, number[]>();
  for (const e of edges) reports.set(e.managerId, [...(reports.get(e.managerId) ?? []), e.personId]);
  const inChart = new Set(edges.flatMap((e) => [e.personId, e.managerId]));
  const byName = (a: number, b: number) => byId.get(a)!.name.localeCompare(byId.get(b)!.name, 'en-GB');
  // The top of each line: someone in the chart with no manager here. A loop (A reports to B reports to A) starts at its first name.
  let roots = [...inChart].filter((id) => !managerOf.has(id)).sort(byName);
  if (!roots.length) roots = [[...inChart].sort(byName)[0]];
  const unplaced = people.filter((p) => !inChart.has(p.id));

  const node = (id: number, seen: Set<number>) => {
    const p = byId.get(id)!;
    const kids = (reports.get(id) ?? []).filter((k) => !seen.has(k)).sort(byName);
    const next = new Set([...seen, id, ...kids]);
    return (
      <li key={id} data-testid={'chart-person-' + id}>
        <Link href={'/knowledge/people/' + p.slug} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'inherit', textDecoration: 'none' }}>
          <Avatar name={p.name} id={p.id} size={24} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</span>
          {p.role && <span className="oo-muted" style={{ fontSize: 13 }}>{p.role}</span>}
        </Link>
        {kids.length > 0 && <ul>{kids.map((k) => node(k, next))}</ul>}
      </li>
    );
  };
  return (
    <section aria-labelledby="chart-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-org-chart">
      <h2 id="chart-h" className="oo-h2">Who reports to whom</h2>
      <ul className="oo-orgchart">{roots.map((r) => node(r, new Set(roots)))}</ul>
      {unplaced.length > 0 && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 13, maxWidth: '72ch' }}>
          Not placed yet: {unplaced.map((p) => p.name).join(', ')}. Add a “reports to” relationship on someone’s page to place them at {name}.
        </p>
      )}
    </section>
  );
}
