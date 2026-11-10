import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearch } from 'wouter';
import {
  createStrategySection,
  deleteStrategySection,
  reorderStrategySections,
  restoreStrategySection,
  updateStrategySection,
  useListGoalOptions,
  useListProjects,
  useListStrategySections,
  type StrategySection,
  type StrategySectionUpdate,
} from '@workspace/api-client-react';
import { formatLong } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { Dropdown, type DropdownOption } from '@/components/dropdown';
import { IconClose, IconUp } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { HiddenFromAi, PageProblem } from '@/components/knowledge/parts';
import { IdeasPanel } from '@/components/strategy/ideas';
import { useKnowledgeWrite } from '@/lib/knowledge';
import { notifyUndo } from '@/lib/notify';

/**
 * Strategy and ideas (build plan Part H). Ollie's strategy in sections he names and orders himself,
 * and the ideas he wants to keep, come back to or take forward. ?section=id and ?idea=id open one.
 */
export default function StrategyPage() {
  const params = new URLSearchParams(useSearch());
  const focusSection = Number(params.get('section')) || null;

  return (
    <main className="oo-panel oo-kmain oo-fade-in" style={{ maxWidth: 'none' }} data-testid="page-strategy">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-eyebrow">Direction</p>
          <h1 className="oo-h1">Strategy</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            Your strategy in your own words, and the ideas you want to keep hold of. Claude can read both and add ideas, but never changes them.
          </p>
        </div>
        <Link href="/goals" className="oo-textbtn" data-testid="link-strategy-goals">Goals</Link>
      </div>

      <Sections focus={focusSection} />
      <IdeasPanel />
    </main>
  );
}

/* ---------- Sections ---------- */

function Sections({ focus }: { focus: number | null }) {
  const q = useListStrategySections();
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const goals = useListGoalOptions();
  const projects = useListProjects();

  useEffect(() => {
    if (!focus || !q.data) return;
    const el = document.getElementById('section-' + focus);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }, [focus, q.data]);

  const move = (index: number, by: -1 | 1) => {
    const ids = (q.data ?? []).map((s) => s.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    void write(() => reorderStrategySections({ ids }), { fail: 'Could not move that section' });
  };

  const linkOptions: DropdownOption[] = [
    ...(goals.data ?? []).map((g) => ({ value: 'goal:' + g.id, label: g.name, group: 'Goals', indent: g.parentId != null })),
    ...(projects.data ?? []).map((p) => ({ value: 'project:' + p.id, label: p.name, group: 'Projects' })),
  ];

  return (
    <section aria-labelledby="h-sections" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="section-strategy">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 id="h-sections" className="oo-h2">Your strategy</h2>
        {!adding && (
          <button type="button" className="oo-btn oo-btn-ink" onClick={() => setAdding(true)} data-testid="button-new-section">New section</button>
        )}
      </div>
      {adding && <NewSectionForm onDone={() => setAdding(false)} />}

      {q.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1].map((i) => <Skel key={i} h={140} />)}</div>
      ) : !q.data ? (
        <PageProblem notFound={false} what="strategy" onRetry={() => q.refetch()} back={{ href: '/goals', label: 'Goals' }} />
      ) : q.data.length === 0 ? (
        !adding && (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }} data-testid="state-sections-empty">
            Nothing written yet. Add a section for each part of your strategy, name it however suits you, and link it to the goals and projects it drives.
          </p>
        )
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="Strategy sections" data-testid="list-sections">
          {q.data.map((s, i) => (
            <li key={s.id}>
              <SectionCard
                section={s}
                first={i === 0}
                last={i === q.data.length - 1}
                onMove={(by) => move(i, by)}
                linkOptions={linkOptions}
                focused={focus === s.id}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SectionCard({
  section: s,
  first,
  last,
  onMove,
  linkOptions,
  focused,
}: {
  section: StrategySection;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  linkOptions: DropdownOption[];
  focused: boolean;
}) {
  const write = useKnowledgeWrite();
  const save = (patch: StrategySectionUpdate, done?: string) => write(() => updateStrategySection(s.id, patch), { done });
  const goalIds = s.goals.map((g) => g.id);
  const projectIds = s.projects.map((p) => p.id);
  const taken = new Set([...goalIds.map((id) => 'goal:' + id), ...projectIds.map((id) => 'project:' + id)]);

  const link = (value: string) => {
    const [type, raw] = value.split(':');
    const id = Number(raw);
    if (type === 'goal') void save({ goalIds: [...goalIds, id] });
    else void save({ projectIds: [...projectIds, id] });
  };
  const remove = async () => {
    const ok = await write(() => deleteStrategySection(s.id), { fail: 'Could not delete that section' });
    if (ok === undefined) return;
    notifyUndo('Section deleted', s.name, async () => {
      await write(() => restoreStrategySection(s.id), { done: 'Section brought back', fail: 'Could not bring it back' });
    });
  };

  return (
    <article
      id={'section-' + s.id}
      tabIndex={-1}
      className="oo-kcard"
      data-focused={focused || undefined}
      style={{ gap: 12, outline: focused ? '2px solid var(--oo-ink)' : undefined, outlineOffset: 2 }}
      aria-labelledby={`section-${s.id}-name`}
      data-testid={'card-section-' + s.id}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <h3 id={`section-${s.id}-name`} className="oo-serif" style={{ margin: 0, fontSize: 22, fontWeight: 400, flex: '1 1 240px', minWidth: 0 }}>
          <InlineText inline value={s.name} label="Section name" required maxLength={200} testId={`section-${s.id}-name`} onSave={(v) => save({ name: v ?? s.name })} />
        </h3>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${s.name} up`} data-testid={`button-section-${s.id}-up`}>
            <IconUp size={14} />
          </button>
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={last} onClick={() => onMove(1)} aria-label={`Move ${s.name} down`} data-testid={`button-section-${s.id}-down`}>
            <IconUp size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={remove} data-testid={`button-section-${s.id}-delete`}>Delete</button>
        </span>
      </div>

      <div style={{ fontSize: 15, lineHeight: 1.6 }}>
        <InlineText value={s.body || null} label={`${s.name} text`} multiline maxLength={50000} placeholder="Write this part of your strategy" testId={`section-${s.id}-body`} onSave={(v) => save({ body: v ?? '' })} />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} aria-label="Drives">
        <span className="oo-muted" style={{ fontSize: 12 }}>Drives</span>
        {s.goals.map((g) => (
          <LinkChip key={'g' + g.id} label={g.name} href="/goals" onRemove={() => save({ goalIds: goalIds.filter((x) => x !== g.id) })} testId={`chip-section-${s.id}-goal-${g.id}`} />
        ))}
        {s.projects.map((p) => (
          <LinkChip key={'p' + p.id} label={p.name} href={'/knowledge/projects/' + p.slug} onRemove={() => save({ projectIds: projectIds.filter((x) => x !== p.id) })} testId={`chip-section-${s.id}-project-${p.id}`} />
        ))}
        <Dropdown
          variant="compact"
          value=""
          onChange={link}
          options={linkOptions.filter((o) => !taken.has(o.value))}
          placeholder="Link a goal or project"
          ariaLabel={`Link ${s.name} to a goal or project`}
          searchable
          testId={`dropdown-section-${s.id}-link`}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingTop: 10, borderTop: '1px solid var(--oo-line-soft)', fontSize: 12 }} className="oo-muted">
        <span data-testid={`text-section-${s.id}-changed`}>Last changed {formatLong(s.updatedAt)}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.hiddenFromAi ? <HiddenFromAi confidential={s.confidential} /> : <span>AI can read this</span>}
          <button
            type="button"
            role="switch"
            className="oo-switch"
            data-tone="danger"
            aria-checked={s.confidential}
            aria-label={`Keep ${s.name} confidential`}
            onClick={() => save({ confidential: !s.confidential }, s.confidential ? 'AI can now read this section' : 'Section hidden from AI')}
            data-testid={`switch-section-${s.id}-confidential`}
          />
        </span>
      </div>
    </article>
  );
}

function LinkChip({ label, href, onRemove, testId }: { label: string; href: string; onRemove: () => void; testId: string }) {
  return (
    <span className="oo-pchip" style={{ padding: '4px 6px 4px 12px', gap: 4 }} data-testid={testId}>
      <Link href={href} style={{ color: 'inherit', textDecoration: 'none' }}>{label}</Link>
      <button type="button" className="oo-btn oo-btn-quiet" style={{ minHeight: 0, padding: 2, borderRadius: 999 }} aria-label={`Unlink ${label}`} onClick={onRemove} data-testid={testId + '-remove'}>
        <IconClose size={12} />
      </button>
    </span>
  );
}

function NewSectionForm({ onDone }: { onDone: () => void }) {
  const write = useKnowledgeWrite();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await write(() => createStrategySection({ name: name.trim() }), { done: 'Section added', fail: 'Could not add that section' });
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <form onSubmit={submit} className="oo-kcard" style={{ gap: 10 }} data-testid="form-new-section">
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <span>Section name</span>
        <input className="oo-input" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} placeholder="Name this part of your strategy" data-testid="input-new-section-name" />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="oo-btn oo-btn-ink" disabled={!name.trim() || busy} data-testid="button-save-new-section">Add section</button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onDone} data-testid="button-cancel-new-section">Cancel</button>
      </div>
    </form>
  );
}
