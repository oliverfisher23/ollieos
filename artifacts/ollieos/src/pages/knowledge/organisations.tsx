import { useState } from 'react';
import { Link, useParams } from 'wouter';
import {
  updateOrganisation,
  updatePerson,
  useGetOrganisation,
  useListOrganisations,
  useListPeople,
  type OrganisationListItem,
  type OrganisationUpdate,
} from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { InlineText } from '@/components/inline-text';
import { KnowledgeLayout, ListHeader } from '@/components/knowledge/layout';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { InternalSwitch } from '@/components/knowledge/org-options';
import { Dropdown } from '@/components/dropdown';
import { personOptions } from '@/components/dropdown-options';
import {
  AccessPanel,
  AddNote,
  EntityChipLink,
  FactsSection,
  HiddenFromAi,
  LinkPicker,
  PageProblem,
  PageSkeleton,
  PersonChipLink,
  Timeline,
  useUnlink,
} from '@/components/knowledge/parts';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';

export function OrganisationsListPage() {
  const orgs = useListOrganisations();
  const [creating, setCreating] = useState(false);
  return (
    <KnowledgeLayout testId="page-organisations">
      <ListHeader
        title="Organisations"
        line="Clients, partners and suppliers, then your own company, and who you know at each."
        action={<button type="button" className="oo-btn oo-btn-ink" onClick={() => setCreating(true)} data-testid="button-new-organisation">New organisation</button>}
      />
      {orgs.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={40} />)}</div>
      ) : orgs.error ? (
        <PageProblem notFound={false} what="list" onRetry={() => orgs.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />
      ) : !orgs.data?.length ? (
        <p className="oo-muted" style={{ margin: 0 }} data-testid="state-organisations-empty">No organisations yet. Add one, then set it on the people who work there.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <OrgGroup title="External" orgs={orgs.data.filter((o) => !o.internal)} empty="No clients, partners or suppliers yet." testId="group-orgs-external" />
          <OrgGroup title="Internal" orgs={orgs.data.filter((o) => o.internal)} empty="Add your own company as an internal organisation, then add your colleagues to it." testId="group-orgs-internal" />
        </div>
      )}
      {creating && <CreateDialog kind="organisation" onClose={() => setCreating(false)} />}
    </KnowledgeLayout>
  );
}

function OrgGroup({ title, orgs, empty, testId }: { title: string; orgs: OrganisationListItem[]; empty: string; testId: string }) {
  const id = testId + '-h';
  return (
    <section aria-labelledby={id} data-testid={testId}>
      <h2 id={id} className="oo-h2" style={{ marginBottom: 6 }}>{title}</h2>
      {orgs.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{empty}</p>
      ) : (
        orgs.map((o) => (
          <Link key={o.id} href={'/knowledge/organisations/' + o.slug} className="oo-krow oo-krow-link" style={{ textDecoration: 'none' }} data-testid={'row-org-' + o.slug}>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{o.name}</span>
              {o.type && <span className="oo-muted" style={{ fontSize: 13 }}>{o.type}</span>}
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }} className="oo-muted">
              {(o.confidential || !o.aiAccess) && <HiddenFromAi confidential={o.confidential} />}
              <span>{o.peopleCount === 1 ? '1 person' : `${o.peopleCount} people`}</span>
            </span>
          </Link>
        ))
      )}
    </section>
  );
}

/** Adds someone already in Knowledge to this organisation, or a new person. */
function AddPersonToOrg({ orgId, orgName, internal }: { orgId: number; orgName: string; internal: boolean }) {
  const people = useListPeople();
  const write = useKnowledgeWrite();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = (people.data ?? []).filter((p) => p.organisation?.id !== orgId);
  const add = async (personId: string) => {
    const p = others.find((x) => String(x.id) === personId);
    if (!p || busy) return;
    setBusy(true);
    const moved = p.organisation ? ` (moved from ${p.organisation.name})` : '';
    await write(() => updatePerson(p.slug, { organisationId: orgId }), { done: `${p.name} added to ${orgName}${moved}`, fail: 'Could not add that person' });
    setBusy(false);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Dropdown
        ariaLabel={`Add someone you already know to ${orgName}`}
        variant="control"
        value=""
        onChange={add}
        disabled={busy || !others.length}
        placeholder={others.length ? (internal ? 'Add a colleague…' : 'Add someone you know…') : 'Everyone is already here'}
        searchPlaceholder="Search people"
        options={personOptions(others)}
        testId="select-add-person-to-org"
        style={{ maxWidth: 260 }}
      />
      <button type="button" className="oo-btn oo-btn-outline" onClick={() => setCreating(true)} data-testid="button-new-person-in-org">New person</button>
      {creating && <CreateDialog kind="person" presetOrganisationId={orgId} stay onClose={() => setCreating(false)} />}
    </div>
  );
}

export function OrganisationPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useGetOrganisation(slug);
  const write = useKnowledgeWrite();
  const unlink = useUnlink();
  const save = (patch: OrganisationUpdate, done?: string) => write(() => updateOrganisation(slug, patch), { done });

  if (q.isLoading) return <KnowledgeLayout testId="page-organisation"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-organisation">
        <PageProblem notFound={isNotFound(q.error)} what="organisation" onRetry={() => q.refetch()} back={{ href: '/knowledge/organisations', label: 'All organisations' }} />
      </KnowledgeLayout>
    );
  }
  const { organisation: o, people, projects, facts, timeline } = q.data;

  return (
    <KnowledgeLayout testId="page-organisation">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <p className="oo-eyebrow" style={{ margin: 0 }}>
              Organisation ·{' '}
              <InlineText inline value={o.type} label="Type" placeholder="Add a type" testId="org-type" onSave={(v) => save({ type: v })} />
            </p>
            <InternalSwitch
              compact
              value={o.internal}
              testId="seg-org-internal"
              onChange={(internal) => save({ internal }, internal ? `${o.name} is internal. People here are your colleagues.` : `${o.name} is external.`)}
            />
          </div>
          <h1 className="oo-h1">
            <InlineText value={o.name} label="Organisation name" required maxLength={200} testId="org-name" onSave={(v) => save({ name: v ?? o.name })} />
          </h1>
        </div>
        <AccessPanel
          kind="organisation"
          itemId={o.id}
          confidential={o.confidential}
          aiAccess={o.aiAccess}
          testPrefix="org"
          onChange={(patch) => save(patch, patch.confidential === true ? 'Marked confidential. Hidden from AI.' : undefined)}
        />
      </div>

      <section aria-labelledby="osum-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
        <h2 id="osum-h" className="oo-h2">Summary</h2>
        <div style={{ fontSize: 15, lineHeight: 1.6 }} className="oo-soft">
          <InlineText value={o.summary} label="Summary" multiline placeholder="Who they are and how you work with them" testId="org-summary" onSave={(v) => save({ summary: v })} />
        </div>
      </section>

      <div className="oo-kgrid">
        <section aria-labelledby="opp-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 id="opp-h" className="oo-h2">People</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {people.length === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{o.internal ? 'No colleagues yet.' : 'Nobody yet.'}</p>}
            {people.map((p) => <PersonChipLink key={p.id} person={p} sub={p.role} />)}
          </div>
          <AddPersonToOrg orgId={o.id} orgName={o.name} internal={o.internal} />
          <h2 className="oo-h2" style={{ marginTop: 8 }}>Projects</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {projects.length === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None linked.</p>}
            {projects.map((p) => (
              <EntityChipLink key={p.id} entity={p} base="/knowledge/projects" testId={'chip-project-' + p.id} onUnlink={p.linked ? () => unlink('organisation', o.id, 'project', p.id) : undefined} />
            ))}
          </div>
          <div><LinkPicker fromType="organisation" fromId={o.id} toType="project" exclude={projects.filter((p) => p.linked).map((p) => p.id)} /></div>
        </section>
        <FactsSection entityType="organisation" entityId={o.id} facts={facts} />
      </div>

      <section aria-labelledby="otl-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 id="otl-h" className="oo-h2">Timeline</h2>
        <Timeline items={timeline} empty="Nothing yet. Notes and facts show up here." />
      </section>

      <AddNote entityType="organisation" entityId={o.id} placeholder={`Anything worth remembering about ${o.name}`} />
    </KnowledgeLayout>
  );
}
