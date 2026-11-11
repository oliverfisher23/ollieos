import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PlaybookUsage, RunPlaybook } from '@/components/playbook-run';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation, useParams } from 'wouter';
import {
  createPlaybook,
  deletePlaybook,
  updatePlaybook,
  useGetPlaybook,
  useListDocuments,
  useListOrganisations,
  useListPeople,
  useListPlaybooks,
  useListProducts,
  useListProjects,
  useListUnusedRulesAndPlaybooks,
  type Playbook,
  type PlaybookState,
  type PlaybookStep,
  type PlaybookStepInput,
  type PlaybookUpdate,
} from '@workspace/api-client-react';
import { PLAYBOOK_STATE_LABELS, PLAYBOOK_STATES, PLAYBOOK_STEPS_MAX, formatDayMonth } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { IconClose, IconDown, IconUp } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { Dropdown, type DropdownOption } from '@/components/dropdown';
import { personOptions } from '@/components/dropdown-options';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { HiddenFromAi, PageProblem, PageSkeleton, TriStateAccess } from '@/components/knowledge/parts';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';
import { notify } from '@/lib/notify';

const STEP_MAX = 600;
const STATE_TONE: Record<PlaybookState, string> = { in_use: 'done', draft: 'backlog', retired: 'archived' };
const STATE_ORDER: Record<PlaybookState, number> = { in_use: 0, draft: 1, retired: 2 };

export function PlaybookStatePill({ state }: { state: PlaybookState }) {
  return <span className="oo-pill" data-tone={STATE_TONE[state]}>{PLAYBOOK_STATE_LABELS[state]}</span>;
}

const stepsWord = (n: number) => (n === 1 ? '1 step' : `${n} steps`);

/* ---------- List (Library tab, and the pages a playbook links to) ---------- */

function PlaybookRow({ p }: { p: Playbook }) {
  const unused = useListUnusedRulesAndPlaybooks({ query: { staleTime: 300_000 } });
  return (
    <Link href={'/knowledge/playbooks/' + p.id} className="oo-krow oo-krow-link" style={{ textDecoration: 'none', alignItems: 'flex-start' }} data-testid={'row-playbook-' + p.id}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 300px' }}>
        <span style={{ fontWeight: 500 }}>{p.title}</span>
        <span className="oo-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>When {lowerFirst(p.whenToUse)}</span>
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }} className="oo-muted">
        {p.hiddenFromAi && p.state === 'in_use' && <HiddenFromAi confidential={p.confidential === true} />}
        <PlaybookStatePill state={p.state} />
        {unused.data?.playbooks.includes(p.id) && <span className="oo-pill" data-tone="stale" data-testid={'pill-unused-' + p.id}>Not used in 90 days</span>}
        <span className="oo-num">{stepsWord(p.steps.length)}</span>
        {p.owner && <span>{p.owner.name}</span>}
      </span>
    </Link>
  );
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

export function PlaybooksTab() {
  const q = useListPlaybooks();
  if (q.isLoading) return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={48} />)}</div>;
  if (!q.data) return <PageProblem notFound={false} what="list" onRetry={() => q.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />;
  if (!q.data.length) {
    return (
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '16px 0' }} data-testid="state-playbooks-empty">
        No playbooks yet. Add how something is done, step by step, or read a document that describes a process and approve the Playbook card.
      </p>
    );
  }
  const sorted = [...q.data].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div data-testid="list-playbooks">{sorted.map((p) => <PlaybookRow key={p.id} p={p} />)}</div>
      <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
        Only playbooks In use reach AI tools, and not when they are confidential or linked to a project or product hidden from AI.
      </p>
    </div>
  );
}

/** "Playbooks" on a project, organisation or product page. */
export function PlaybooksSection({ playbooks, preset, empty }: { playbooks: Playbook[]; preset: { projectId?: number; organisationId?: number; productId?: number }; empty: string }) {
  const [adding, setAdding] = useState(false);
  return (
    <section aria-labelledby="pbk-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="section-playbooks">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 id="pbk-h" className="oo-h2">Playbooks</h2>
        <button type="button" className="oo-textbtn" onClick={() => setAdding(true)} data-testid="button-add-playbook-here">New playbook</button>
      </div>
      {playbooks.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{empty}</p>
      ) : (
        <div>{playbooks.map((p) => <PlaybookRow key={p.id} p={p} />)}</div>
      )}
      {adding && <PlaybookDialog preset={preset} onClose={() => setAdding(false)} />}
    </section>
  );
}

/* ---------- New playbook ---------- */

export function PlaybookDialog({ preset = {}, onClose }: { preset?: { projectId?: number; organisationId?: number; productId?: number }; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const [, navigate] = useLocation();
  const [title, setTitle] = useState('');
  const [whenToUse, setWhenToUse] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = !!title.trim() && !!whenToUse.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const made = await write(
      () =>
        createPlaybook({
          title: title.trim(),
          whenToUse: whenToUse.trim(),
          purpose: purpose.trim() || null,
          state: 'draft',
          projectIds: preset.projectId ? [preset.projectId] : [],
          organisationIds: preset.organisationId ? [preset.organisationId] : [],
          productIds: preset.productId ? [preset.productId] : [],
        }),
      { done: 'Playbook added as a draft. Add its steps.', fail: 'Could not add that playbook' },
    );
    setBusy(false);
    if (made) {
      onClose();
      navigate('/knowledge/playbooks/' + made.id);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 560 }} aria-describedby="pbk-desc" data-testid="dialog-new-playbook">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>New playbook</Dialog.Title>
            <p id="pbk-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              How something is done, step by step. It starts as a draft; set it to In use when it is ready.
            </p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label>
                <span>Title</span>
                <input className="oo-input" required autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Onboarding a new partner" data-testid="input-playbook-title" />
              </label>
              <label>
                <span>When to use it</span>
                <input className="oo-input" required value={whenToUse} maxLength={500} onChange={(e) => setWhenToUse(e.target.value)} placeholder="A new partner signs" data-testid="input-playbook-when" />
              </label>
              <label>
                <span>What it is for <span className="oo-muted">(optional)</span></span>
                <input className="oo-input" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} placeholder="One line on the outcome" data-testid="input-playbook-purpose" />
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" data-testid="button-cancel-playbook">Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={!valid || busy} data-testid="button-save-playbook">{busy ? 'Saving…' : 'Add playbook'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------- Playbook page ---------- */

export function PlaybookPage() {
  const id = Number(useParams<{ id: string }>().id);
  const q = useGetPlaybook(id, { query: { enabled: Number.isInteger(id) } as never });
  const people = useListPeople();
  const write = useKnowledgeWrite();
  const [, navigate] = useLocation();

  if (q.isLoading) return <KnowledgeLayout testId="page-playbook"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-playbook">
        <PageProblem notFound={isNotFound(q.error) || !Number.isInteger(id)} what="playbook" onRetry={() => q.refetch()} back={{ href: '/knowledge/library?tab=playbooks', label: 'All playbooks' }} />
      </KnowledgeLayout>
    );
  }
  const p = q.data;
  const save = (patch: PlaybookUpdate, done?: string) => write(() => updatePlaybook(p.id, patch), { done });
  const accessNote = (v: boolean | null) =>
    v === true ? 'Marked confidential. Hidden from AI.' : v === false ? 'Readable by AI while In use, whatever it is linked to' : 'Now follows what it is linked to';

  return (
    <KnowledgeLayout testId="page-playbook">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          <p className="oo-eyebrow" style={{ margin: 0 }}>
            <Link href="/knowledge/library?tab=playbooks" style={{ color: 'inherit' }} data-testid="link-all-playbooks">Playbook</Link>
          </p>
          <h1 className="oo-h1">
            <InlineText value={p.title} label="Playbook title" required maxLength={200} testId="playbook-title" onSave={(v) => save({ title: v ?? p.title })} />
          </h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <Dropdown
              ariaLabel="State"
              variant="compact"
              value={p.state}
              onChange={(v) => save({ state: v as PlaybookState }, v === 'in_use' ? 'In use. AI tools can follow it now.' : v === 'retired' ? 'Retired. AI tools no longer see it.' : 'Back to draft. AI tools no longer see it.')}
              options={PLAYBOOK_STATES.map((s) => ({ value: s, label: PLAYBOOK_STATE_LABELS[s] }))}
              testId="select-playbook-state"
            />
            <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-playbook-checked">Last checked {formatDayMonth(p.lastCheckedAt)}</span>
            <button type="button" className="oo-textbtn" onClick={() => save({ checked: true }, 'Marked as checked today')} data-testid="button-playbook-checked">Still how it is done</button>
          </div>
        </div>
        <TriStateAccess
          value={p.confidential}
          hidden={p.hiddenFromAi}
          parent="its projects and products"
          testId="playbook-access"
          onChange={(v) => save({ confidential: v }, accessNote(v))}
        />
      </div>
      {p.state !== 'in_use' && (
        <p className="oo-muted" role="status" style={{ margin: 0, fontSize: 13 }} data-testid="text-playbook-not-in-use">
          {p.state === 'draft' ? 'A draft: AI tools do not see it until it is In use.' : 'Retired: AI tools no longer see it.'}
        </p>
      )}

      <dl className="oo-dl" style={{ maxWidth: 680 }}>
        <dt>When to use it</dt>
        <dd><InlineText value={p.whenToUse} label="When to use it" required maxLength={500} testId="playbook-when" onSave={(v) => save({ whenToUse: v ?? p.whenToUse })} /></dd>
        <dt>What it is for</dt>
        <dd><InlineText value={p.purpose} label="What it is for" placeholder="Add one line on the outcome" maxLength={300} testId="playbook-purpose" onSave={(v) => save({ purpose: v })} /></dd>
        <dt><label htmlFor="playbook-owner">Owner</label></dt>
        <dd>
          <Dropdown
            id="playbook-owner"
            variant="compact"
            value={p.ownerId ? String(p.ownerId) : ''}
            onChange={(v) => save({ ownerId: v ? Number(v) : null })}
            searchPlaceholder="Search people"
            options={[{ value: '', label: 'No owner' }, ...withCurrent(personOptions(people.data), p.owner)]}
            testId="select-playbook-owner"
          />
        </dd>
        {p.source && (
          <>
            <dt>From</dt>
            <dd data-testid="text-playbook-source">{p.source}</dd>
          </>
        )}
      </dl>

      <PlaybookSteps playbook={p} />

      <PlaybookLinks playbook={p} />

      <RunPlaybook playbook={p} />

      <PlaybookUsage id={p.id} />

      <section aria-labelledby="pbk-notes-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
        <h2 id="pbk-notes-h" className="oo-h2">Notes</h2>
        <div style={{ fontSize: 15, lineHeight: 1.6 }} className="oo-soft">
          <InlineText value={p.notes} label="Notes" multiline maxLength={20000} placeholder="Anything else worth knowing when running it" testId="playbook-notes" onSave={(v) => save({ notes: v })} />
        </div>
      </section>

      <DeletePlaybook id={p.id} title={p.title} onDeleted={() => navigate('/knowledge/library?tab=playbooks')} />
    </KnowledgeLayout>
  );
}

/** Keeps the current choice in the list even when the list does not include it. */
function withCurrent(options: DropdownOption[], current: { id: number; name: string } | null): DropdownOption[] {
  if (!current || options.some((o) => o.value === String(current.id))) return options;
  return [{ value: String(current.id), label: current.name }, ...options];
}

/* ---------- Steps ---------- */

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

const toInput = (s: PlaybookStep): PlaybookStepInput => ({ id: s.id, text: s.text, personId: s.personId, afterDays: s.afterDays, status: s.status ?? null });

/** The steps in order. Every change saves the whole list. */
function PlaybookSteps({ playbook }: { playbook: Playbook }) {
  const write = useKnowledgeWrite();
  const people = useListPeople();
  const [steps, setSteps] = useState<PlaybookStep[]>(playbook.steps);
  const [adding, setAdding] = useState('');
  const saved = useRef(JSON.stringify(playbook.steps));
  const addRef = useRef<HTMLTextAreaElement>(null);

  // Follow the server when it changes underneath, such as an approved Playbook card.
  useEffect(() => {
    const incoming = JSON.stringify(playbook.steps);
    if (incoming !== saved.current) {
      saved.current = incoming;
      setSteps(playbook.steps);
    }
  }, [playbook.steps]);

  const commit = async (next: PlaybookStep[], done?: string) => {
    const before = steps;
    setSteps(next);
    saved.current = JSON.stringify(next);
    const ok = await write(() => updatePlaybook(playbook.id, { steps: next.map(toInput) }), { done, fail: 'That step did not save' });
    if (!ok) {
      setSteps(before);
      saved.current = JSON.stringify(before);
    }
  };

  const change = (id: string, patch: Partial<PlaybookStep>) => {
    const step = steps.find((s) => s.id === id);
    if (!step) return;
    const next = { ...step, ...patch };
    if (next.text === step.text && next.personId === step.personId && next.afterDays === step.afterDays && (next.status ?? null) === (step.status ?? null)) return;
    if (patch.personId !== undefined) {
      const person = people.data?.find((x) => x.id === patch.personId);
      next.personName = person?.name ?? null;
      next.personSlug = person?.slug ?? null;
    }
    void commit(steps.map((s) => (s.id === id ? next : s)));
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    void commit(next);
    setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="button-pstep-${by < 0 ? 'up' : 'down'}-${steps[i].id}"]`)?.focus(), 0);
  };
  const remove = (s: PlaybookStep, i: number) => {
    void commit(steps.filter((x) => x.id !== s.id), `Step ${i + 1} removed`);
    setTimeout(() => addRef.current?.focus(), 0);
  };
  const add = () => {
    const v = adding.trim();
    if (!v) return;
    if (steps.length >= PLAYBOOK_STEPS_MAX) return notify('That is the most steps a playbook can have', `A playbook can have up to ${PLAYBOOK_STEPS_MAX}.`);
    setAdding('');
    void commit([...steps, { id: newId(), text: v.slice(0, STEP_MAX), personId: null, afterDays: null, personName: null, personSlug: null }]);
    addRef.current?.focus();
  };

  return (
    <section aria-labelledby="pbk-steps-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-playbook-steps">
      <h2 id="pbk-steps-h" className="oo-h2">Steps{steps.length ? <span className="oo-muted oo-num" style={{ fontWeight: 400 }}> · {steps.length}</span> : null}</h2>
      {steps.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No steps yet. Add the first one below.</p>
      ) : (
        <ol className="oo-psteps" aria-labelledby="pbk-steps-h">
          {steps.map((s, i) => (
            <li key={s.id} className="oo-pstep" data-testid={'pstep-' + s.id}>
              <span className="oo-pstep-n oo-num" aria-hidden="true">{i + 1}</span>
              <div className="oo-pstep-body">
                <StepText step={s} n={i + 1} onSave={(text) => (text ? change(s.id, { text }) : remove(s, i))} />
                <div className="oo-pstep-meta">
                  <Dropdown
                    ariaLabel={`Who does step ${i + 1}`}
                    variant="compact"
                    value={s.personId ? String(s.personId) : ''}
                    onChange={(v) => change(s.id, { personId: v ? Number(v) : null })}
                    searchPlaceholder="Search people"
                    placeholder="Anyone"
                    options={[{ value: '', label: 'Anyone' }, ...withCurrent(personOptions(people.data), s.personId && s.personName ? { id: s.personId, name: s.personName } : null)]}
                    testId={'select-pstep-person-' + s.id}
                  />
                  <AfterDays step={s} n={i + 1} onSave={(afterDays) => change(s.id, { afterDays })} />
                  <Dropdown value={s.status === 'now' ? 'now' : 'backlog'} onChange={(v) => change(s.id, { status: v as 'now' | 'backlog' })} options={[{ value: 'backlog', label: 'Backlog' }, { value: 'now', label: 'Now' }]} ariaLabel={`Where step ${i + 1} goes when run`} variant="compact" testId={'select-pstep-status-' + s.id} />
                </div>
              </div>
              <span className="oo-step-tools">
                <button type="button" className="oo-icon-btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} data-testid={'button-pstep-up-' + s.id}><IconUp size={13} /></button>
                <button type="button" className="oo-icon-btn" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)} data-testid={'button-pstep-down-' + s.id}><IconDown size={13} /></button>
                <button type="button" className="oo-icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => remove(s, i)} data-testid={'button-pstep-remove-' + s.id}><IconClose size={12} /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', maxWidth: 680 }}>
        <label htmlFor="pstep-add" className="oo-sr">Add a step</label>
        <textarea
          id="pstep-add"
          ref={addRef}
          rows={1}
          className="oo-textarea"
          style={{ minHeight: 40 }}
          placeholder="Add a step"
          value={adding}
          maxLength={STEP_MAX}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
          data-testid="input-pstep-add"
        />
        <button type="button" className="oo-btn oo-btn-outline" disabled={!adding.trim()} onClick={add} data-testid="button-pstep-add">Add</button>
      </div>
    </section>
  );
}

/** A step's text, edited in place. Clearing it removes the step. */
function StepText({ step, n, onSave }: { step: PlaybookStep; n: number; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(step.text);
  const cancelled = useRef(false);
  useEffect(() => setDraft(step.text), [step.text]);
  return (
    <>
      <label htmlFor={'pstep-text-' + step.id} className="oo-sr">Step {n}</label>
      <textarea
        id={'pstep-text-' + step.id}
        className="oo-step-title oo-pstep-text"
        rows={1}
        value={draft}
        maxLength={STEP_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancelled.current = true;
            setDraft(step.text);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          onSave(draft.trim());
        }}
        data-testid={'input-pstep-text-' + step.id}
      />
    </>
  );
}

function AfterDays({ step, n, onSave }: { step: PlaybookStep; n: number; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState(step.afterDays == null ? '' : String(step.afterDays));
  useEffect(() => setDraft(step.afterDays == null ? '' : String(step.afterDays)), [step.afterDays]);
  const commit = () => {
    const t = draft.trim();
    if (!t) return onSave(null);
    const v = Number(t);
    if (!Number.isInteger(v) || v < 0 || v > 3650) {
      setDraft(step.afterDays == null ? '' : String(step.afterDays));
      return notify('Days after starting must be a whole number', 'From 0 to 3650.');
    }
    onSave(v);
  };
  return (
    <label className="oo-pstep-days">
      <span className="oo-sr">Days after starting for step {n}</span>
      <span aria-hidden="true" className="oo-muted">Day</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={3650}
        className="oo-input oo-num"
        placeholder="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        data-testid={'input-pstep-days-' + step.id}
      />
    </label>
  );
}

/* ---------- Links ---------- */

type LinkKey = 'projectIds' | 'organisationIds' | 'productIds' | 'documentIds';

function PlaybookLinks({ playbook: p }: { playbook: Playbook }) {
  const write = useKnowledgeWrite();
  const projects = useListProjects();
  const orgs = useListOrganisations();
  const products = useListProducts();
  const docs = useListDocuments();
  const set = (key: LinkKey, ids: number[], done: string) => write(() => updatePlaybook(p.id, { [key]: ids }), { done, fail: 'Could not change that link' });

  const groups: { key: LinkKey; title: string; noun: string; base: string | null; items: { id: number; name: string; slug?: string }[]; all: { id: number; name: string }[] }[] = [
    { key: 'projectIds', title: 'Projects', noun: 'a project', base: '/knowledge/projects/', items: p.projects, all: projects.data ?? [] },
    { key: 'organisationIds', title: 'Organisations', noun: 'an organisation', base: '/knowledge/organisations/', items: p.organisations, all: orgs.data ?? [] },
    { key: 'productIds', title: 'Products', noun: 'a product', base: '/knowledge/products/', items: p.products, all: products.data ?? [] },
    { key: 'documentIds', title: 'Documents', noun: 'a document', base: null, items: p.documents.map((d) => ({ id: d.id, name: d.title })), all: (docs.data ?? []).map((d) => ({ id: d.id, name: d.title })) },
  ];

  return (
    <section aria-labelledby="pbk-links-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="section-playbook-links">
      <h2 id="pbk-links-h" className="oo-h2">Linked to</h2>
      <div className="oo-kgrid">
        {groups.map((g) => {
          const ids = g.items.map((i) => i.id);
          const choices = g.all.filter((x) => !ids.includes(x.id));
          return (
            <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={'links-' + g.key}>
              <span className="oo-field-label">{g.title}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {g.items.length === 0 && <span className="oo-muted" style={{ fontSize: 14 }}>None</span>}
                {g.items.map((i) => (
                  <span key={i.id} className="oo-pchip" data-plain="true" data-testid={`chip-${g.key}-${i.id}`}>
                    {g.base && i.slug ? (
                      <Link href={g.base + i.slug} style={{ color: 'inherit', textDecoration: 'none' }}>{i.name}</Link>
                    ) : (
                      <Link href={'/knowledge/library?document=' + i.id} style={{ color: 'inherit', textDecoration: 'none' }}>{i.name}</Link>
                    )}
                    <button type="button" className="oo-pchip-x" aria-label={`Unlink ${i.name}`} onClick={() => set(g.key, ids.filter((x) => x !== i.id), 'Unlinked')} data-testid={`button-unlink-${g.key}-${i.id}`}>
                      <IconClose size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <Dropdown
                ariaLabel={'Link ' + g.noun}
                variant="compact"
                value=""
                onChange={(v) => v && set(g.key, [...ids, Number(v)], 'Linked')}
                disabled={!choices.length}
                placeholder={choices.length ? `Link ${g.noun}…` : 'Nothing more to link'}
                options={choices.map((x) => ({ value: String(x.id), label: x.name }))}
                testId={'select-link-' + g.key}
                style={{ alignSelf: 'flex-start' }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DeletePlaybook({ id, title, onDeleted }: { id: number; title: string; onDeleted: () => void }) {
  const write = useKnowledgeWrite();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <div style={{ borderTop: '1px solid var(--oo-line)', paddingTop: 12 }}>
        <button type="button" className="oo-textbtn" onClick={() => setAsking(true)} data-testid="button-delete-playbook">Delete this playbook</button>
      </div>
    );
  }
  const go = async () => {
    setBusy(true);
    const ok = await write(() => deletePlaybook(id).then(() => true), { done: `${title} deleted`, fail: 'Could not delete it' });
    setBusy(false);
    if (ok) onDeleted();
  };
  return (
    <div role="group" aria-label="Delete this playbook" style={{ borderTop: '1px solid var(--oo-line)', paddingTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
      <span>Delete this playbook? Retiring it keeps it for reference instead.</span>
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={go} data-testid="button-delete-playbook-yes">{busy ? 'Deleting…' : 'Delete it'}</button>
      <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={busy} onClick={() => setAsking(false)}>Keep it</button>
    </div>
  );
}
