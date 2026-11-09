import { useState } from 'react';
import { Link, useParams } from 'wouter';
import {
  updateDecision,
  updateNote,
  useGetDecision,
  useGetNote,
  useListDecisions,
  useListNotes,
  useListProjects,
  type Decision,
  type Note,
} from '@workspace/api-client-react';
import { formatDayMonth, formatDayMonthShort, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { InlineText } from '@/components/inline-text';
import { KnowledgeLayout, ListHeader } from '@/components/knowledge/layout';
import { CreateDialog } from '@/components/knowledge/create-dialog';
import { HiddenFromAi, PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { entityPath, isNotFound, TYPE_LABELS, useKnowledgeWrite } from '@/lib/knowledge';

/* ---------- Shared ---------- */

/** Confidential switch for things that otherwise follow their parent. Off means "follow", not "public". */
function InheritSwitch({ value, hidden, parent, onChange, testId }: { value: boolean | null; hidden: boolean; parent: string; onChange: (v: boolean | null) => void; testId: string }) {
  const on = value === true;
  const note = on
    ? 'Confidential: hidden from AI unless you approve a request.'
    : hidden
      ? `Follows ${parent}, which is hidden from AI.`
      : `Follows ${parent}. Claude can read it.`;
  return (
    <section className="oo-access" aria-label="AI access" data-testid={testId}>
      <div className="oo-access-row">
        <span id={testId + '-label'}>Confidential</span>
        <button type="button" role="switch" className="oo-switch" data-tone="danger" aria-checked={on} aria-labelledby={testId + '-label'} onClick={() => onChange(on ? null : true)} data-testid={'switch-' + testId} />
      </div>
      <span style={{ fontSize: 12 }} className="oo-muted" role="status" data-testid={'text-' + testId + '-note'}>{note}</span>
    </section>
  );
}

function ListState({ loading, error, empty, emptyText, onRetry }: { loading: boolean; error: unknown; empty: boolean; emptyText: string; onRetry: () => void }) {
  if (loading) return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={40} />)}</div>;
  if (error) return <PageProblem notFound={false} what="list" onRetry={onRetry} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />;
  if (empty) return <p className="oo-muted" style={{ margin: 0 }} data-testid="state-list-empty">{emptyText}</p>;
  return null;
}

/* ---------- Decisions ---------- */

export function DecisionsListPage() {
  const list = useListDecisions();
  const [creating, setCreating] = useState(false);
  const rows: Decision[] = list.data ?? [];
  return (
    <KnowledgeLayout testId="page-decisions">
      <ListHeader
        title="Decisions"
        line="What was decided, when, and on which project. Newest first."
        action={<button type="button" className="oo-btn oo-btn-ink" onClick={() => setCreating(true)} data-testid="button-new-decision">New decision</button>}
      />
      <ListState loading={list.isLoading} error={list.error} empty={!rows.length} emptyText="No decisions yet. Record them on a project page or with New decision." onRetry={() => list.refetch()} />
      {rows.length > 0 && (
        <div>
          {rows.map((d) => (
            <Link key={d.id} href={'/knowledge/decisions/' + d.id} className="oo-krow oo-krow-link" style={{ textDecoration: 'none', alignItems: 'flex-start', justifyContent: 'flex-start', flexWrap: 'nowrap' }} data-testid={'row-decision-' + d.id}>
              <span className="oo-tl-date" style={{ paddingTop: 2 }}>{formatDayMonthShort(d.decidedAt)}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
                <span style={{ overflowWrap: 'anywhere' }}>{d.text}</span>
                <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  {d.project.name}
                  {d.hiddenFromAi && <HiddenFromAi confidential={d.confidential === true || d.project.confidential} />}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
      {creating && <CreateDialog kind="decision" onClose={() => setCreating(false)} />}
    </KnowledgeLayout>
  );
}

export function DecisionPage() {
  const id = Number(useParams<{ id: string }>().id);
  const q = useGetDecision(id);
  const projects = useListProjects();
  const write = useKnowledgeWrite();

  if (q.isLoading) return <KnowledgeLayout testId="page-decision"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-decision">
        <PageProblem notFound={isNotFound(q.error) || !Number.isInteger(id)} what="decision" onRetry={() => q.refetch()} back={{ href: '/knowledge/decisions', label: 'All decisions' }} />
      </KnowledgeLayout>
    );
  }
  const d = q.data;
  const save = (patch: Parameters<typeof updateDecision>[1], done?: string) => write(() => updateDecision(d.id, patch), { done });

  return (
    <KnowledgeLayout testId="page-decision">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          <p className="oo-eyebrow">
            Decision ·{' '}
            <Link href={'/knowledge/projects/' + d.project.slug} style={{ color: 'inherit' }} data-testid="link-decision-project">{d.project.name}</Link>
          </p>
          <h1 className="oo-h1" style={{ fontSize: 26, lineHeight: 1.3 }}>
            <InlineText value={d.text} label="Decision" multiline required testId="decision-text" onSave={(v) => save({ text: v ?? d.text })} />
          </h1>
        </div>
        <InheritSwitch value={d.confidential} hidden={d.hiddenFromAi} parent="its project" testId="decision-access" onChange={(v) => save({ confidential: v }, v ? 'Marked confidential. Hidden from AI.' : 'Now follows its project')} />
      </div>
      <dl className="oo-dl" style={{ maxWidth: 560 }}>
        <dt><label htmlFor="decision-date">Decided on</label></dt>
        <dd>
          <input
            id="decision-date"
            type="date"
            className="oo-input"
            style={{ width: 'auto', minHeight: 32, padding: '3px 8px' }}
            value={d.decidedAt.slice(0, 10)}
            max={todayLondon()}
            onChange={(e) => e.target.value && save({ decidedAt: e.target.value })}
            data-testid="input-decision-date"
          />
        </dd>
        <dt>Decided by</dt>
        <dd><InlineText value={d.decidedBy} label="Decided by" placeholder="Add who decided" testId="decision-by" onSave={(v) => save({ decidedBy: v })} /></dd>
        <dt>Source</dt>
        <dd><InlineText value={d.source} label="Source" placeholder="Where it was decided, such as a meeting or email" testId="decision-source" onSave={(v) => save({ source: v })} /></dd>
        <dt><label htmlFor="decision-project">Project</label></dt>
        <dd>
          <select id="decision-project" className="oo-input" style={{ width: 'auto', minHeight: 32, padding: '3px 8px' }} value={d.project.id} onChange={(e) => save({ projectId: Number(e.target.value) }, 'Moved to another project')} data-testid="select-decision-project">
            {!(projects.data ?? []).some((p) => p.id === d.project.id) && <option value={d.project.id}>{d.project.name}</option>}
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </dd>
        <dt>Recorded</dt>
        <dd>{formatDayMonth(d.createdAt)} by {d.createdBy === 'ollie' ? 'you' : d.createdBy.charAt(0).toUpperCase() + d.createdBy.slice(1)}</dd>
      </dl>
    </KnowledgeLayout>
  );
}

/* ---------- Notes ---------- */

function aboutLabel(n: Note): string {
  return `${TYPE_LABELS[n.entity.type] ?? n.entity.type} · ${n.entity.name}`;
}

export function NotesListPage() {
  const list = useListNotes();
  const [creating, setCreating] = useState(false);
  const rows: Note[] = list.data ?? [];
  return (
    <KnowledgeLayout testId="page-notes">
      <ListHeader
        title="Notes"
        line="Everything you have written down about a project, person or organisation."
        action={<button type="button" className="oo-btn oo-btn-ink" onClick={() => setCreating(true)} data-testid="button-new-note">New note</button>}
      />
      <ListState loading={list.isLoading} error={list.error} empty={!rows.length} emptyText="No notes yet. Add one from any project or person page, or with New note." onRetry={() => list.refetch()} />
      {rows.length > 0 && (
        <div>
          {rows.map((n) => (
            <Link key={n.id} href={'/knowledge/notes/' + n.id} className="oo-krow oo-krow-link" style={{ textDecoration: 'none', alignItems: 'flex-start' }} data-testid={'row-note-' + n.id}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 300px' }}>
                <span style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{n.title ?? (n.body.length > 80 ? n.body.slice(0, 79) + '…' : n.body)}</span>
                <span className="oo-muted" style={{ fontSize: 13 }}>{aboutLabel(n)}</span>
              </span>
              <span className="oo-muted" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                {n.hiddenFromAi && <HiddenFromAi confidential={n.confidential === true} />}
                {formatDayMonthShort(n.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
      {creating && <CreateDialog kind="note" onClose={() => setCreating(false)} />}
    </KnowledgeLayout>
  );
}

export function NotePage() {
  const id = Number(useParams<{ id: string }>().id);
  const q = useGetNote(id);
  const write = useKnowledgeWrite();

  if (q.isLoading) return <KnowledgeLayout testId="page-note"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-note">
        <PageProblem notFound={isNotFound(q.error) || !Number.isInteger(id)} what="note" onRetry={() => q.refetch()} back={{ href: '/knowledge/notes', label: 'All notes' }} />
      </KnowledgeLayout>
    );
  }
  const n = q.data;
  const about = entityPath(n.entity.type, n.entity.slug, n.entity.id);
  const save = (patch: Parameters<typeof updateNote>[1], done?: string) => write(() => updateNote(n.id, patch), { done });
  const parentNoun = n.entity.type === 'person' ? 'this person' : `its ${TYPE_LABELS[n.entity.type]?.toLowerCase() ?? 'parent'}`;

  return (
    <KnowledgeLayout testId="page-note">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          <p className="oo-eyebrow">
            Note ·{' '}
            {about ? <Link href={about} style={{ color: 'inherit' }} data-testid="link-note-about">{n.entity.name}</Link> : n.entity.name}
          </p>
          <h1 className="oo-h1" style={{ fontSize: 28 }}>
            <InlineText value={n.title} label="Title" placeholder="Add a title" testId="note-title" onSave={(v) => save({ title: v })} />
          </h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
            Written {formatDayMonth(n.createdAt)}
            {n.updatedAt !== n.createdAt ? ` · edited ${formatDayMonth(n.updatedAt)}` : ''}
          </p>
        </div>
        <InheritSwitch value={n.confidential} hidden={n.hiddenFromAi} parent={parentNoun} testId="note-access" onChange={(v) => save({ confidential: v }, v ? 'Marked confidential. Hidden from AI.' : `Now follows ${parentNoun}`)} />
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.65, maxWidth: '72ch', whiteSpace: 'pre-wrap' }}>
        <InlineText value={n.body} label="Note" multiline required testId="note-body" onSave={(v) => save({ body: v ?? n.body })} />
      </div>
    </KnowledgeLayout>
  );
}
