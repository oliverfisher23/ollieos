import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  createIdea,
  deleteIdea,
  restoreIdea,
  takeIdeaForward,
  updateIdea,
  useGetIdea,
  useListGoalOptions,
  useListIdeas,
  useListProjects,
  type Idea,
  type IdeaStatus,
  type IdeaUpdate,
} from '@workspace/api-client-react';
import { addDays, formatLong, formatShort, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { IconSearch } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { HiddenFromAi } from '@/components/knowledge/parts';
import { useKnowledgeWrite } from '@/lib/knowledge';
import { notifyUndo } from '@/lib/notify';

const TABS: { value: IdeaStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'come_back', label: 'Come back to' },
  { value: 'taken_forward', label: 'Taken forward' },
  { value: 'dropped', label: 'Dropped' },
];
const isTab = (v: string | null): v is IdeaStatus => TABS.some((t) => t.value === v);

const EMPTY: Record<IdeaStatus, string> = {
  new: 'No new ideas. Jot one down above, or Claude can add them for you.',
  come_back: 'Nothing to come back to. Pick a day on any idea and it will show on Home and in your morning digest from then.',
  taken_forward: 'No ideas taken forward yet. One click turns an idea into a task or a project.',
  dropped: 'Nothing dropped.',
};

const SOURCE_WORDS: Record<Idea['source'], string | null> = { ollie: null, claude: 'From Claude', session: 'From a Cowork session', ollieos: 'Spotted by OllieOS' };

/** The ideas list: quick add, one tab per status, newest first, searchable. ?tab= and ?idea= pick one. */
export function IdeasPanel() {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const ideaParam = Number(params.get('idea')) || null;
  const tabParam = params.get('tab');
  const linked = useGetIdea(ideaParam ?? 0, { query: { enabled: !!ideaParam } as never });
  const tab: IdeaStatus = isTab(tabParam) ? tabParam : (linked.data?.status ?? 'new');

  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useListIdeas({ status: tab, ...(q.length >= 2 ? { q } : {}) });

  useEffect(() => {
    if (!ideaParam || !list.data) return;
    const el = document.getElementById('idea-' + ideaParam);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }, [ideaParam, list.data]);

  const setTab = (t: IdeaStatus) => navigate(t === 'new' ? '/strategy' : '/strategy?tab=' + t, { replace: true });
  const counts = list.data?.counts;

  return (
    <section aria-labelledby="h-ideas" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="section-ideas">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <h2 id="h-ideas" className="oo-h2">Ideas</h2>
        <div role="search" style={{ flex: '0 1 280px', minWidth: 200 }}>
          <label htmlFor="idea-search" className="oo-sr">Search ideas</label>
          <div className="oo-search">
            <IconSearch size={15} />
            <input id="idea-search" type="search" placeholder="Search ideas" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setText('')} data-testid="input-idea-search" />
          </div>
        </div>
      </div>

      <AddIdea onAdded={() => tab !== 'new' && setTab('new')} />

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label="Ideas by status" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {TABS.map((t) => (
            <button key={t.value} type="button" role="tab" className="oo-tab" aria-selected={t.value === tab} onClick={() => setTab(t.value)} data-testid={'tab-ideas-' + t.value}>
              {t.label} {counts && <span className="oo-count">{counts[t.value]}</span>}
              {t.value === 'come_back' && !!list.data?.due && (
                <span className="oo-pill" data-tone="stale" style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px' }} data-testid="text-ideas-due">{list.data.due} due</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)!.label} aria-live="polite">
        {list.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map((i) => <Skel key={i} h={72} />)}</div>
        ) : list.error || !list.data ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load your ideas.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => list.refetch()}>Try again</button>
          </div>
        ) : list.data.ideas.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '8px 0' }} data-testid="state-ideas-empty">
            {q.length >= 2 ? `No ideas here match "${q}".` : EMPTY[tab]}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="list-ideas">
            {list.data.ideas.map((i) => <IdeaRow key={i.id} idea={i} focused={i.id === ideaParam} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

function AddIdea({ onAdded }: { onAdded: () => void }) {
  const write = useKnowledgeWrite();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [withNotes, setWithNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const ok = await write(() => createIdea({ title: title.trim(), notes: notes.trim() || null }), { done: 'Idea added', fail: 'Could not add that idea' });
    setBusy(false);
    if (!ok) return;
    setTitle('');
    setNotes('');
    setWithNotes(false);
    onAdded();
  };
  return (
    <form onSubmit={submit} className="oo-kcard" style={{ gap: 10, padding: '14px 16px' }} data-testid="form-add-idea">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label htmlFor="idea-title" className="oo-sr">Idea</label>
        <input
          id="idea-title"
          className="oo-input"
          style={{ flex: '1 1 260px' }}
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Jot down an idea"
          data-testid="input-idea-title"
        />
        <button type="submit" className="oo-btn oo-btn-ink" disabled={!title.trim() || busy} data-testid="button-add-idea">Add idea</button>
      </div>
      {withNotes ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>Notes <span className="oo-muted">(as long as you like, a whole brainstorm is fine)</span></span>
          <textarea className="oo-textarea" rows={5} value={notes} maxLength={50000} onChange={(e) => setNotes(e.target.value)} autoFocus data-testid="input-idea-notes" />
        </label>
      ) : (
        <div><button type="button" className="oo-textbtn" onClick={() => setWithNotes(true)} data-testid="button-idea-add-notes">Add notes</button></div>
      )}
    </form>
  );
}

function IdeaRow({ idea: i, focused }: { idea: Idea; focused: boolean }) {
  const write = useKnowledgeWrite();
  const goals = useListGoalOptions();
  const projects = useListProjects();
  const [dating, setDating] = useState(false);
  const save = (patch: IdeaUpdate, done?: string) => write(() => updateIdea(i.id, patch), { done });
  const today = todayLondon();

  const forward = (as: string) =>
    write(() => takeIdeaForward(i.id, { as: as as 'task' | 'project' }), {
      done: as === 'task' ? 'Now a task in your Backlog' : 'Now a project',
      fail: 'Could not take that idea forward',
    });
  const remove = async () => {
    const ok = await write(() => deleteIdea(i.id), { fail: 'Could not delete that idea' });
    if (ok === undefined) return;
    notifyUndo('Idea deleted', i.title, () => void write(() => restoreIdea(i.id), { done: 'Idea brought back', fail: 'Could not bring it back' }));
  };

  const meta = [`Added ${formatShort(i.createdAt)}`, SOURCE_WORDS[i.source]].filter(Boolean).join(' · ');
  const open = i.status === 'new' || i.status === 'come_back';

  return (
    <li
      id={'idea-' + i.id}
      tabIndex={-1}
      className="oo-krow"
      style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8, outline: focused ? '2px solid var(--oo-ink)' : undefined, outlineOffset: 2, borderRadius: focused ? 4 : undefined }}
      data-testid={'row-idea-' + i.id}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, width: '100%', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0, fontWeight: 500, fontSize: 15 }}>
          <InlineText inline value={i.title} label="Idea" required maxLength={300} testId={`idea-${i.id}-title`} onSave={(v) => save({ title: v ?? i.title })} />
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }} className="oo-muted">
          {i.status === 'come_back' && i.comeBackOn && (
            <span className="oo-pill" data-tone={i.due ? 'stale' : undefined} data-testid={`text-idea-${i.id}-date`}>
              {i.due ? (i.comeBackOn === today ? 'Come back to today' : `Due since ${formatShort(i.comeBackOn)}`) : `Come back ${formatShort(i.comeBackOn)}`}
            </span>
          )}
          {i.hiddenFromAi && <HiddenFromAi confidential={i.confidential} />}
          <span data-testid={`text-idea-${i.id}-meta`}>
            {meta}
            {i.source === 'ollieos' && i.sourceLabel && (
              <>
                {' · from '}
                {i.sourceUrl ? (
                  <a href={i.sourceUrl} target="_blank" rel="noreferrer" className="oo-link" data-testid={`link-idea-${i.id}-from`}>{i.sourceLabel}</a>
                ) : (
                  i.sourceLabel
                )}
              </>
            )}
          </span>
        </span>
      </div>

      <div style={{ width: '100%', fontSize: 14, lineHeight: 1.55 }} className={i.notes ? undefined : 'oo-muted'}>
        <InlineText value={i.notes} label="Notes" multiline maxLength={50000} placeholder="Add notes" testId={`idea-${i.id}-notes`} onSave={(v) => save({ notes: v })} />
      </div>

      {i.status === 'taken_forward' && (i.takenTask || i.takenProject) && (
        <p style={{ margin: 0, fontSize: 13 }} data-testid={`text-idea-${i.id}-taken`}>
          Became{' '}
          {i.takenTask ? (
            <Link href={'/tasks?task=' + i.takenTask.id} className="oo-krow-link" style={{ textDecoration: 'underline' }}>the task {i.takenTask.title}</Link>
          ) : (
            <Link href={'/knowledge/projects/' + i.takenProject!.slug} className="oo-krow-link" style={{ textDecoration: 'underline' }}>the project {i.takenProject!.name}</Link>
          )}
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, width: '100%' }}>
        <Dropdown
          variant="compact"
          value={i.goal ? String(i.goal.id) : ''}
          onChange={(v) => void save({ goalId: v ? Number(v) : null })}
          options={[{ value: '', label: 'No goal' }, ...(goals.data ?? []).map((g) => ({ value: String(g.id), label: g.name, indent: g.parentId != null }))]}
          placeholder="Goal"
          ariaLabel={`Goal for ${i.title}`}
          testId={`dropdown-idea-${i.id}-goal`}
        />
        <Dropdown
          variant="compact"
          value={i.project ? String(i.project.id) : ''}
          onChange={(v) => void save({ projectId: v ? Number(v) : null })}
          options={[{ value: '', label: 'No project' }, ...(projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))]}
          placeholder="Project"
          ariaLabel={`Project for ${i.title}`}
          searchable
          testId={`dropdown-idea-${i.id}-project`}
        />
        <span style={{ flex: 1 }} />
        {open && (
          <Dropdown
            variant="compact"
            value=""
            onChange={(v) => void forward(v)}
            options={[{ value: 'task', label: 'As a task' }, { value: 'project', label: 'As a project' }]}
            placeholder="Take forward"
            ariaLabel={`Take ${i.title} forward`}
            align="end"
            testId={`dropdown-idea-${i.id}-forward`}
          />
        )}
        {open && !dating && (
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={() => setDating(true)} data-testid={`button-idea-${i.id}-come-back`}>
            {i.status === 'come_back' ? 'Change day' : 'Come back to'}
          </button>
        )}
        {i.status === 'come_back' && (
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={() => save({ status: 'new' }, 'Moved to New')} data-testid={`button-idea-${i.id}-to-new`}>Move to New</button>
        )}
        {open && (
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={() => save({ status: 'dropped' }, 'Idea dropped')} data-testid={`button-idea-${i.id}-drop`}>Drop</button>
        )}
        {i.status === 'dropped' && (
          <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={() => save({ status: 'new' }, 'Back in New')} data-testid={`button-idea-${i.id}-revive`}>Bring back</button>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} className="oo-muted">
          <span aria-hidden="true">Confidential</span>
          <button
            type="button"
            role="switch"
            className="oo-switch"
            data-tone="danger"
            aria-checked={i.confidential}
            aria-label={`Keep ${i.title} confidential`}
            onClick={() => save({ confidential: !i.confidential }, i.confidential ? 'AI can now read this idea' : 'Idea hidden from AI')}
            data-testid={`switch-idea-${i.id}-confidential`}
          />
        </span>
        <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={remove} data-testid={`button-idea-${i.id}-delete`}>Delete</button>
      </div>

      {dating && <ComeBackPicker idea={i} onDone={() => setDating(false)} />}
    </li>
  );
}

function ComeBackPicker({ idea: i, onDone }: { idea: Idea; onDone: () => void }) {
  const write = useKnowledgeWrite();
  const today = todayLondon();
  const [day, setDay] = useState(i.comeBackOn ?? addDays(today, 7));
  const set = async (date: string) => {
    const ok = await write(() => updateIdea(i.id, { status: 'come_back', comeBackOn: date }), { done: `Back on ${formatLong(date)}`, fail: 'Could not set that day' });
    if (ok) onDone();
  };
  const quick: [string, string][] = [
    ['In a week', addDays(today, 7)],
    ['In a month', addDays(today, 28)],
    ['In 3 months', addDays(today, 91)],
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, width: '100%' }} role="group" aria-label={`When to come back to ${i.title}`} data-testid={`picker-idea-${i.id}`}>
      {quick.map(([label, d]) => (
        <button key={label} type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={() => set(d)} data-testid={`button-idea-${i.id}-${label.replace(/\s+/g, '-').toLowerCase()}`}>{label}</button>
      ))}
      <label htmlFor={`idea-${i.id}-day`} className="oo-sr">Day to come back</label>
      <input id={`idea-${i.id}-day`} type="date" className="oo-input" style={{ width: 'auto', minHeight: 30 }} value={day} min={today} onChange={(e) => setDay(e.target.value)} data-testid={`input-idea-${i.id}-day`} />
      <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" disabled={!day} onClick={() => set(day)} data-testid={`button-idea-${i.id}-set-day`}>Set day</button>
      <button type="button" className="oo-textbtn" onClick={onDone} data-testid={`button-idea-${i.id}-cancel-day`}>Cancel</button>
    </div>
  );
}
