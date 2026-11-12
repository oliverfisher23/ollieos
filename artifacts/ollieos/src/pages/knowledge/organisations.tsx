import { useState } from 'react';
import { ClientPulseCard } from '@/components/client-pulse';
import { useParams } from 'wouter';
import {
  updateOrganisation,
  updatePerson,
  useGetOrganisation,
  useListPeople,
  type OrganisationUpdate,
} from '@workspace/api-client-react';
import { ResearchList } from '@/components/research';
import { InlineText } from '@/components/inline-text';
import { ContextPackButton } from '@/components/knowledge/context-pack';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { InternalSwitch } from '@/components/knowledge/org-options';
import { Dropdown } from '@/components/dropdown';
import { personOptions } from '@/components/dropdown-options';
import {
  AccessPanel,
  AddNote,
  EntityChipLink,
  FactsSection,
  LinkPicker,
  PageProblem,
  PageSkeleton,
  PersonChipLink,
  Timeline,
  useUnlink,
} from '@/components/knowledge/parts';
import { RelationshipsSection, WhoDecides } from '@/components/knowledge/relationships';
import { OrgChart, OrgDomains, SameOrganisationAs } from '@/components/knowledge/org-extras';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';
import { PlaybooksSection } from '@/pages/knowledge/playbooks';
import { ProductsSection } from '@/pages/knowledge/products';

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
        <PageProblem notFound={isNotFound(q.error)} what="organisation" onRetry={() => q.refetch()} back={{ href: '/contacts?view=organisations', label: 'All organisations' }} />
      </KnowledgeLayout>
    );
  }
  const { organisation: o, people, projects, playbooks, products, facts, timeline, research, reportsTo } = q.data;

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
          <div style={{ fontSize: 13 }}>
            <WhoDecides type="organisation" id={o.id} name={o.name} />
          </div>
          <OrgDomains org={o} />
          <ContextPackButton type="organisation" id={o.id} />
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

      {!o.internal && ['customer', 'client', 'partner'].includes((o.type ?? '').trim().toLowerCase()) && <ClientPulseCard slug={o.slug} />}

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
          <ProductsSection fromType="organisation" fromId={o.id} products={products} />
        </section>
        <FactsSection entityType="organisation" entityId={o.id} facts={facts} />
      </div>
      <OrgChart people={people} reportsTo={reportsTo} name={o.name} />
      <PlaybooksSection playbooks={playbooks} preset={{ organisationId: o.id }} empty={`No playbooks linked to ${o.name}.`} />
      <RelationshipsSection type="organisation" id={o.id} name={o.name} />

      {!o.internal && (
        <section aria-labelledby="ors-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="section-org-research">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h2 id="ors-h" className="oo-h2">Research</h2>
            <p className="oo-muted" style={{ margin: 0, fontSize: 13, maxWidth: '72ch' }}>
              From the web and your email with them. Runs before meetings with them, and when you ask. Nothing here is added to your knowledge unless you add it.
            </p>
          </div>
          <ResearchList items={research} organisationId={o.id} testId="org-research" />
        </section>
      )}

      <section aria-labelledby="otl-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 id="otl-h" className="oo-h2">Timeline</h2>
        <Timeline items={timeline} empty="Nothing yet. Notes and facts show up here." />
      </section>

      <AddNote entityType="organisation" entityId={o.id} placeholder={`Anything worth remembering about ${o.name}`} />
      <SameOrganisationAs org={o} />
    </KnowledgeLayout>
  );
}
