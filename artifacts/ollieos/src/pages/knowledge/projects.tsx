import { useState } from 'react';
import { Link, Redirect, useParams } from 'wouter';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';
import { PhoneFold } from '@/components/phone-fold';
import { updateProject, useGetProject, useListGoalOptions, useListProjects, type BusinessFunction, type FunctionProject, type ProjectLifecycle, type ProjectUpdate } from '@workspace/api-client-react';
import { BUSINESS_FUNCTION_LABELS, LIFECYCLE_LABELS, PROJECT_LIFECYCLES, formatDayMonth, formatDayMonthShort, DOC_LOCATION_LABELS } from '@workspace/shared';
import { FUNCTION_OPTIONS } from '@/components/dropdown-options';
import { ContextPackButton } from '@/components/knowledge/context-pack';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { InlineText } from '@/components/inline-text';
import { Dropdown } from '@/components/dropdown';
import {
  AccessPanel,
  AddNote,
  DecisionsSection,
  EntityChipLink,
  FactsSection,
  LinkPicker,
  PageProblem,
  PageSkeleton,
  PersonChipLink,
  TaskRows,
  Timeline,
  useUnlink,
} from '@/components/knowledge/parts';
import { RelationshipsSection, WhoDecides } from '@/components/knowledge/relationships';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';
import { Skel } from '@/components/bits';
import { DocumentDialog, RuleCard, RuleDialog } from '@/pages/knowledge/library';
import { PlaybooksSection } from '@/pages/knowledge/playbooks';
import { ProductsSection } from '@/pages/knowledge/products';
import { HiddenFromAi } from '@/components/knowledge/parts';

/** /knowledge: the most recently updated project, or an empty state. On phones, the Knowledge menu. */
export function KnowledgeIndexPage() {
  const projects = useListProjects();
  const [creating, setCreating] = useState(false);
  const phone = useMedia(PHONE_QUERY);
  // On phones /knowledge is the Knowledge menu (see KnowledgeLayout); the menu shows its own loading state.
  if (phone && (projects.isLoading || projects.data?.length)) return <KnowledgeLayout testId="page-knowledge">{null}</KnowledgeLayout>;
  if (projects.data?.length) {
    const latest = [...projects.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return <Redirect to={'/knowledge/projects/' + latest.slug} replace />;
  }
  return (
    <KnowledgeLayout testId="page-knowledge">
      {projects.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><Skel h={34} w="40%" /><Skel h={14} w="70%" /></div>
      ) : projects.error ? (
        <PageProblem notFound={false} what="page" onRetry={() => projects.refetch()} back={{ href: '/', label: 'Home' }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }} data-testid="state-knowledge-empty">
          <p className="oo-eyebrow">Knowledge</p>
          <h1 className="oo-h1">No projects yet</h1>
          <p className="oo-soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
            A project holds the summary, key facts, decisions and people behind a piece of work. Claude reads from here when you ask it something, unless you mark the project confidential.
          </p>
          <div><button type="button" className="oo-btn oo-btn-ink" onClick={() => setCreating(true)} data-testid="button-new-project">New project</button></div>
        </div>
      )}
      {creating && <CreateDialog kind="project" onClose={() => setCreating(false)} />}
    </KnowledgeLayout>
  );
}

export function ProjectPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useGetProject(slug);
  const write = useKnowledgeWrite();
  const unlink = useUnlink();
  const goals = useListGoalOptions();
  const [addingDoc, setAddingDoc] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const save = (patch: ProjectUpdate, done?: string) => write(() => updateProject(slug, patch), { done });

  if (q.isLoading) return <KnowledgeLayout testId="page-project"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-project">
        <PageProblem notFound={isNotFound(q.error)} what="project" onRetry={() => q.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />
      </KnowledgeLayout>
    );
  }
  const { project, goal, documents, rules, playbooks, products, facts, decisions, openTasks, people, organisations, clientIds, functionProjects, activity } = q.data;
  const topGoals = (goals.data ?? []).filter((g) => g.parentId == null);
  const isFn = project.isFunction;
  const fnLabel = project.function ? BUSINESS_FUNCTION_LABELS[project.function] : null;
  const clients = organisations.filter((o) => clientIds.includes(o.id));

  return (
    <KnowledgeLayout testId="page-project">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          {isFn ? (
            <>
              <p className="oo-eyebrow" data-testid="text-function-eyebrow">Function</p>
              <h1 className="oo-h1" data-testid="text-function-name">{project.name}</h1>
              <p className="oo-soft" style={{ margin: 0, fontSize: 14 }}>Documents and knowledge for {project.name} as a whole. Work for one client goes on its project, filed under {project.name}.</p>
            </>
          ) : (
            <>
              <p className="oo-eyebrow">
                Project ·{' '}
                <InlineText inline value={project.area} label="Area" placeholder="Add an area" testId="project-area" onSave={(v) => save({ area: v })} />
              </p>
              <h1 className="oo-h1">
                <InlineText value={project.name} label="Project name" required maxLength={200} testId="project-name" onSave={(v) => save({ name: v ?? project.name })} />
              </h1>
            </>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="oo-pill" data-tone="now" style={{ padding: 0 }}>
              <InlineText inline value={project.status} label="Status" placeholder="Add a status" testId="project-status" style={{ padding: '3px 8px', margin: 0 }} onSave={(v) => save({ status: v })} />
            </span>
            <span className="oo-pill" data-testid="text-project-updated">Updated {formatDayMonth(project.updatedAt)}</span>
            {project.archived && <span className="oo-pill" data-tone="noise">Archived</span>}
          </div>
          {!isFn && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 13 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="project-function" className="oo-muted">Function</label>
                <Dropdown
                  id="project-function"
                  variant="compact"
                  value={project.function ?? ''}
                  onChange={(v) => void save({ function: (v || null) as BusinessFunction | null }, v ? `Filed under ${BUSINESS_FUNCTION_LABELS[v as BusinessFunction]}` : 'No function now')}
                  options={FUNCTION_OPTIONS}
                  testId="select-project-function"
                />
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} data-testid="text-project-clients">
                <span className="oo-muted">{clients.length > 1 ? 'Clients' : 'Client'}</span>
                {clients.length ? (
                  clients.map((c, i) => (
                    <span key={c.id}>
                      <Link href={'/knowledge/organisations/' + c.slug} className="oo-link" data-testid={'link-project-client-' + c.id}>{c.name}</Link>
                      {i < clients.length - 1 ? ',' : ''}
                    </span>
                  ))
                ) : (
                  <span className="oo-muted">None. Link an organisation typed customer or partner below.</span>
                )}
              </span>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 13 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <label htmlFor="project-goal" className="oo-muted">Goal</label>
              <Dropdown
                id="project-goal"
                variant="compact"
                style={{ maxWidth: 280 }}
                value={String(project.goalId ?? '')}
                onChange={(v) => {
                  const id = v ? Number(v) : null;
                  const name = goals.data?.find((g) => g.id === id)?.name;
                  void save({ goalId: id }, id ? `Linked to ${name}` : 'No goal now');
                }}
                searchPlaceholder="Search goals"
                options={[
                  { value: '', label: 'No goal' },
                  ...topGoals.flatMap((g) => [
                    { value: String(g.id), label: g.name },
                    ...(goals.data ?? []).filter((x) => x.parentId === g.id).map((x) => ({ value: String(x.id), label: x.name, indent: true })),
                  ]),
                  ...(goal && !goals.data?.some((g) => g.id === goal.id) ? [{ value: String(goal.id), label: goal.name }] : []),
                ]}
                testId="select-project-goal"
              />
            </span>
            {!isFn && <span role="group" aria-label="Lifecycle" className="oo-seg" style={{ display: 'inline-flex', padding: 3 }} data-testid="seg-project-lifecycle">
              {PROJECT_LIFECYCLES.map((l: ProjectLifecycle) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={project.lifecycle === l}
                  style={{ minHeight: 28, padding: '3px 10px' }}
                  onClick={() => project.lifecycle !== l && save({ lifecycle: l }, l === 'active' ? 'Project active again' : `Project ${l}. Check-ins with its people pause too.`)}
                  data-testid={'radio-lifecycle-' + l}
                >
                  {LIFECYCLE_LABELS[l]}
                </button>
              ))}
            </span>}
            {goal && (
              <Link href="/goals" className="oo-link" data-testid="link-project-goal">
                Counts towards {goal.parentName ? `${goal.parentName}: ${goal.name}` : goal.name}
              </Link>
            )}
          </div>
          <div style={{ fontSize: 13 }}>
            <WhoDecides type="project" id={project.id} name={project.name} />
          </div>
          <ContextPackButton type="project" id={project.id} />
        </div>
        <AccessPanel
          kind="project"
          itemId={project.id}
          confidential={project.confidential}
          aiAccess={project.aiAccess}
          testPrefix="project"
          onChange={(patch) =>
            save(
              patch,
              patch.confidential === true ? 'Marked confidential. Hidden from AI.' : patch.confidential === false ? 'No longer confidential' : patch.aiAccess === false ? 'Hidden from AI' : 'Readable by AI',
            )
          }
        />
      </div>

      <section aria-labelledby="sum-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
        <h2 id="sum-h" className="oo-h2">Summary</h2>
        <div style={{ fontSize: 15, lineHeight: 1.6 }} className="oo-soft">
          <InlineText
            value={project.summary}
            label="Summary"
            multiline
            placeholder={isFn ? `What ${project.name} does and how it works, in a few sentences` : 'What this project is, in a few sentences'}
            testId="project-summary"
            onSave={(v) => save({ summary: v })}
          />
        </div>
      </section>

      {isFn && fnLabel && <FunctionProjects label={fnLabel} projects={functionProjects} />}

      <div className="oo-kgrid">
        <FactsSection entityType="project" entityId={project.id} facts={facts} />
        <DecisionsSection projectId={project.id} decisions={decisions} />
      </div>
      <RelationshipsSection type="project" id={project.id} name={project.name} />

      <section aria-labelledby="ot-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="ot-h" className="oo-h2">Open tasks</h2>
          <Link href="/tasks" className="oo-link" style={{ fontSize: 13 }} data-testid="link-all-tasks">All tasks</Link>
        </div>
        <TaskRows tasks={openTasks} empty="No open tasks on this project. Add @project to a task to file it here." />
      </section>

      <section aria-labelledby="docs-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="section-project-documents">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 id="docs-h" className="oo-h2">Documents</h2>
          <button type="button" className="oo-textbtn" onClick={() => setAddingDoc(true)} data-testid="button-project-add-link">Add a document</button>
        </div>
        {documents.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>
            {isFn ? `No documents yet. Add guides, processes and plans for ${project.name} as a whole; client documents go on their projects.` : 'No documents linked. Add the proposal, the brief or the shared folder.'}
          </p>
        ) : (
          <div>
            {documents.map((d) => (
              <div key={d.id} className="oo-krow" data-testid={'row-project-document-' + d.id}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 260px' }}>
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className="oo-krow-link" style={{ fontWeight: 500 }} data-testid={'link-project-document-' + d.id}>{d.title}<span className="oo-sr"> (opens in a new tab)</span></a>
                    ) : (
                      <Link href={'/knowledge/library?document=' + d.id} className="oo-krow-link" style={{ fontWeight: 500 }} data-testid={'link-project-document-' + d.id}>{d.title}</Link>
                    )}
                    {d.hiddenFromAi && <HiddenFromAi confidential={d.confidential === true} />}
                  </span>
                  {d.summary && <span className="oo-muted" style={{ fontSize: 13 }}>{d.summary}</span>}
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }} className="oo-muted">
                  <span className="oo-loc" data-loc={d.location}>{DOC_LOCATION_LABELS[d.location]}</span>
                  <Link href={'/knowledge/library?document=' + d.id} className="oo-link">Updated {formatDayMonthShort(d.lastConfirmedAt)}</Link>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="pbs-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-project-rules">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 id="pbs-h" className="oo-h2">Rules</h2>
          <span style={{ display: 'flex', gap: 12 }}>
            <Link href="/knowledge/library?tab=rules" className="oo-link" style={{ fontSize: 13 }} data-testid="link-all-rules">All rules</Link>
            <button type="button" className="oo-textbtn" onClick={() => setAddingRule(true)} data-testid="button-project-new-rule">New rule</button>
          </span>
        </div>
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>What Claude follows when drafting for this project: global rules and any linked to it, its organisations or its products.</p>
        {rules.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No rules apply.</p>
        ) : (
          <PhoneFold label={rules.length === 1 ? 'Show the rule that applies' : `Show the ${rules.length} rules that apply`} testId="button-show-project-rules">
            <div className="oo-kgrid">{rules.map((p) => <RuleCard key={p.id} p={p} compact />)}</div>
          </PhoneFold>
        )}
      </section>

      <PlaybooksSection playbooks={playbooks} preset={{ projectId: project.id }} empty="No playbooks linked to this project." />

      <div className="oo-kgrid">
        <section aria-labelledby="pp-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 id="pp-h" className="oo-h2">People</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {people.length === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Nobody linked yet.</p>}
            {people.map((p) => (
              <PersonChipLink
                key={p.id}
                person={p}
                sub={p.organisationName}
                onUnlink={p.linked ? () => unlink('project', project.id, 'person', p.id) : undefined}
              />
            ))}
          </div>
          <div><LinkPicker fromType="project" fromId={project.id} toType="person" exclude={people.filter((p) => p.linked).map((p) => p.id)} /></div>
          <h3 className="oo-h2" style={{ fontSize: 14, marginTop: 6 }}>Organisations</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {organisations.length === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None linked.</p>}
            {organisations.map((o) => (
              <EntityChipLink key={o.id} entity={o} base="/knowledge/organisations" testId={'chip-org-' + o.id} onUnlink={() => unlink('project', project.id, 'organisation', o.id)} />
            ))}
          </div>
          <div><LinkPicker fromType="project" fromId={project.id} toType="organisation" exclude={organisations.map((o) => o.id)} /></div>
          <ProductsSection fromType="project" fromId={project.id} products={products} />
        </section>
        <section aria-labelledby="act-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 id="act-h" className="oo-h2">Recent activity</h2>
          <Timeline items={activity.slice(0, 8)} empty="Nothing yet. Captures, notes and finished tasks show up here." compact />
        </section>
      </div>

      {addingDoc && <DocumentDialog presetProjectId={project.id} onClose={() => setAddingDoc(false)} />}
      {addingRule && <RuleDialog presetProjectId={project.id} onClose={() => setAddingRule(false)} />}

      <AddNote entityType="project" entityId={project.id} placeholder={`Anything worth remembering about ${project.name}`} />

      {!isFn && (
        <div>
          <button
            type="button"
            className="oo-textbtn"
            onClick={() => save({ archived: !project.archived }, project.archived ? 'Project restored' : 'Project archived')}
            data-testid="button-archive-project"
          >
            {project.archived ? 'Restore this project' : 'Archive this project'}
          </button>
        </div>
      )}
    </KnowledgeLayout>
  );
}

/** On a function's page: the projects filed under it, with their clients. */
function FunctionProjects({ label, projects }: { label: string; projects: FunctionProject[] }) {
  return (
    <section aria-labelledby="fp-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="section-function-projects">
      <h2 id="fp-h" className="oo-h2">Projects in {label}</h2>
      {projects.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None yet. Choose {label} as the function on a project to file it here.</p>
      ) : (
        <div>
          {projects.map((p) => (
            <Link key={p.id} href={'/knowledge/projects/' + p.slug} className="oo-krow oo-krow-link" style={{ textDecoration: 'none' }} data-testid={'row-function-project-' + p.slug}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 260px' }}>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                <span className="oo-muted" style={{ fontSize: 13 }}>{p.clients.length ? `For ${p.clients.join(', ')}` : 'No client linked'}</span>
              </span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }} className="oo-muted">
                {p.confidential && <HiddenFromAi confidential />}
                {p.lifecycle !== 'active' && <span className="oo-pill">{LIFECYCLE_LABELS[p.lifecycle]}</span>}
                <span className="oo-num">{p.documentCount === 1 ? '1 document' : `${p.documentCount} documents`}</span>
                <span className="oo-num">{p.openTaskCount === 1 ? '1 open task' : `${p.openTaskCount} open tasks`}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
