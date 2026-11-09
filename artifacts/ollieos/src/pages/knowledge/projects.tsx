import { useState } from 'react';
import { Link, Redirect, useParams } from 'wouter';
import { updateProject, useGetProject, useListProjects, type ProjectUpdate } from '@workspace/api-client-react';
import { formatDayMonth } from '@workspace/shared';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { InlineText } from '@/components/inline-text';
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
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';
import { Skel } from '@/components/bits';

/** /knowledge: the most recently updated project, or an empty state. */
export function KnowledgeIndexPage() {
  const projects = useListProjects();
  const [creating, setCreating] = useState(false);
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
  const save = (patch: ProjectUpdate, done?: string) => write(() => updateProject(slug, patch), { done });

  if (q.isLoading) return <KnowledgeLayout testId="page-project"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-project">
        <PageProblem notFound={isNotFound(q.error)} what="project" onRetry={() => q.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />
      </KnowledgeLayout>
    );
  }
  const { project, facts, decisions, openTasks, people, organisations, activity } = q.data;

  return (
    <KnowledgeLayout testId="page-project">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          <p className="oo-eyebrow">
            Project ·{' '}
            <InlineText inline value={project.area} label="Area" placeholder="Add an area" testId="project-area" onSave={(v) => save({ area: v })} />
          </p>
          <h1 className="oo-h1">
            <InlineText value={project.name} label="Project name" required maxLength={200} testId="project-name" onSave={(v) => save({ name: v ?? project.name })} />
          </h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="oo-pill" data-tone="now" style={{ padding: 0 }}>
              <InlineText inline value={project.status} label="Status" placeholder="Add a status" testId="project-status" style={{ padding: '3px 8px', margin: 0 }} onSave={(v) => save({ status: v })} />
            </span>
            <span className="oo-pill" data-testid="text-project-updated">Updated {formatDayMonth(project.updatedAt)}</span>
            {project.archived && <span className="oo-pill" data-tone="noise">Archived</span>}
          </div>
        </div>
        <AccessPanel
          kind="project"
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
          <InlineText value={project.summary} label="Summary" multiline placeholder="What this project is, in a few sentences" testId="project-summary" onSave={(v) => save({ summary: v })} />
        </div>
      </section>

      <div className="oo-kgrid">
        <FactsSection entityType="project" entityId={project.id} facts={facts} />
        <DecisionsSection projectId={project.id} decisions={decisions} />
      </div>

      <section aria-labelledby="ot-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="ot-h" className="oo-h2">Open tasks</h2>
          <Link href="/tasks" className="oo-link" style={{ fontSize: 13 }} data-testid="link-all-tasks">All tasks</Link>
        </div>
        <TaskRows tasks={openTasks} empty="No open tasks on this project. Add @project to a task to file it here." />
      </section>

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
        </section>
        <section aria-labelledby="act-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 id="act-h" className="oo-h2">Recent activity</h2>
          <Timeline items={activity.slice(0, 8)} empty="Nothing yet. Captures, notes and finished tasks show up here." compact />
        </section>
      </div>

      <AddNote entityType="project" entityId={project.id} placeholder={`Anything worth remembering about ${project.name}`} />

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
    </KnowledgeLayout>
  );
}
