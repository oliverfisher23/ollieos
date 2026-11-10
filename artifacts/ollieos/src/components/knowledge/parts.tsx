import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import {
  createDecision,
  createFact,
  createLink,
  createNote,
  removeLink,
  supersedeFact,
  updateDecision,
  useListAccessRequests,
  useListOrganisations,
  useListPeople,
  useListProjects,
  type Decision,
  type Fact,
  type FactInputAttribute,
  type FactInputEntityType,
  type Linkable,
  type Note,
  type Task,
  type TimelineItem,
} from '@workspace/api-client-react';
import { formatDayMonthShort, formatShort, formatTime, PRIORITY_LABELS, todayLondon } from '@workspace/shared';
import { Avatar } from '@/components/bits';
import { IconClose, IconLock } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { refPath, useKnowledgeWrite } from '@/lib/knowledge';
import { Dropdown } from '@/components/dropdown';

/* ---------- Access ---------- */

export function HiddenFromAi({ confidential }: { confidential: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {confidential && <IconLock size={13} className="oo-lock" aria-hidden={false} aria-label="Confidential" role="img" />}
      <span className="oo-hidden-ai">Hidden from AI</span>
    </span>
  );
}

export function LockMark() {
  return <IconLock size={13} className="oo-lock" aria-hidden={false} role="img" aria-label="Confidential" />;
}

const NOUN: Record<string, string> = { project: 'project', person: 'person', organisation: 'organisation' };

/** "Open to Claude until 14:05" for approvals that are still live on this item. */
export function OpenGrantsNote({ itemRef }: { itemRef: string }) {
  const list = useListAccessRequests();
  const open = (list.data?.open ?? []).filter((r) => r.item?.ref === itemRef);
  if (!open.length) return null;
  return (
    <span style={{ fontSize: 12 }} className="oo-soft" data-testid="text-open-grants">
      {open.map((r) => `Open to ${r.client.name} until ${formatTime(r.expiresAt!)}`).join('. ')}.{' '}
      <Link href="/settings/connectors#access-requests">Manage</Link>
    </span>
  );
}

const TRI: { value: boolean | null; label: (parent: string) => string; tone?: string }[] = [
  { value: null, label: () => 'Follows parent' },
  { value: true, label: () => 'Confidential', tone: 'danger' },
  { value: false, label: () => 'Always readable' },
];

/**
 * AI access for things that otherwise follow their parent: follow it, always hide, or always allow
 * (build plan question 11). A radio group, so arrow keys move between the three.
 */
export function TriStateAccess({
  value,
  hidden,
  parent,
  onChange,
  testId,
  itemRef,
  bare,
  wide,
}: {
  wide?: boolean;
  value: boolean | null;
  hidden: boolean;
  parent: string;
  onChange: (v: boolean | null) => void;
  testId: string;
  itemRef?: string;
  bare?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const note =
    value === true
      ? 'Confidential: hidden from AI unless you approve a request.'
      : value === false
        ? 'Always readable by AI, even if what it belongs to is hidden.'
        : hidden
          ? `Hidden from AI because it follows ${parent}.`
          : `Follows ${parent}. AI can read it.`;
  const idx = TRI.findIndex((o) => o.value === value);
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (idx + step + TRI.length) % TRI.length;
    onChange(TRI[next].value);
    refs.current[next]?.focus();
  };
  return (
    <section className="oo-access" data-bare={bare} aria-label="AI access" style={wide ? { maxWidth: 'none' } : undefined} data-testid={testId}>
      <span style={{ fontSize: 12, fontWeight: 600 }} id={testId + '-label'}>AI access</span>
      <div role="radiogroup" aria-labelledby={testId + '-label'} className="oo-seg" onKeyDown={onKey}>
        {TRI.map((o, i) => (
          <button
            key={String(o.value)}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            data-tone={o.tone}
            onClick={() => o.value !== value && onChange(o.value)}
            data-testid={`radio-${testId}-${o.value === null ? 'follow' : o.value ? 'confidential' : 'readable'}`}
          >
            {o.label(parent)}
          </button>
        ))}
      </div>
      <span style={{ fontSize: 12 }} className="oo-muted" role="status" data-testid={'text-' + testId + '-note'}>{note}</span>
      {itemRef && <OpenGrantsNote itemRef={itemRef} />}
    </section>
  );
}

export function AccessPanel({
  kind,
  confidential,
  aiAccess,
  onChange,
  testPrefix,
  bare,
  itemId,
}: {
  bare?: boolean;
  itemId?: number;
  kind: 'project' | 'person' | 'organisation';
  confidential: boolean;
  aiAccess: boolean;
  onChange: (patch: { confidential?: boolean; aiAccess?: boolean }) => void;
  testPrefix: string;
}) {
  const readable = aiAccess && !confidential;
  const note = confidential
    ? 'Confidential: hidden from AI unless you approve a request.'
    : readable
      ? `Claude can read and update this ${NOUN[kind]}.`
      : 'Hidden from AI.';
  return (
    <section className="oo-access" data-bare={bare} aria-label="AI access" data-testid={testPrefix + '-access'}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>AI access</span>
      <div className="oo-access-row">
        <span id={testPrefix + '-ai-label'}>Readable by Claude and other AI</span>
        <button
          type="button"
          role="switch"
          className="oo-switch"
          aria-checked={readable}
          aria-labelledby={testPrefix + '-ai-label'}
          disabled={confidential}
          onClick={() => onChange({ aiAccess: !aiAccess })}
          data-testid={'switch-' + testPrefix + '-ai'}
        />
      </div>
      <div className="oo-access-row">
        <span id={testPrefix + '-conf-label'}>Confidential</span>
        <button
          type="button"
          role="switch"
          className="oo-switch"
          data-tone="danger"
          aria-checked={confidential}
          aria-labelledby={testPrefix + '-conf-label'}
          onClick={() => onChange({ confidential: !confidential })}
          data-testid={'switch-' + testPrefix + '-confidential'}
        />
      </div>
      <span style={{ fontSize: 12 }} className="oo-muted" role="status" data-testid={'text-' + testPrefix + '-access-note'}>{note}</span>
      {itemId != null && <OpenGrantsNote itemRef={`${kind}:${itemId}`} />}
    </section>
  );
}

/* ---------- Facts ---------- */

const FACT_ATTRIBUTES: { value: NonNullable<FactInputAttribute>; label: string }[] = [
  { value: 'job_title', label: 'Job title' },
  { value: 'organisation', label: 'Organisation' },
  { value: 'status', label: 'Status' },
  { value: 'next_step', label: 'Next step' },
  { value: 'decision_date', label: 'Decision date' },
];
const ATTRIBUTE_LABEL = Object.fromEntries(FACT_ATTRIBUTES.map((a) => [a.value, a.label])) as Record<string, string>;

export function FactsSection({ entityType, entityId, facts, title = 'Key facts' }: { entityType: FactInputEntityType; entityId: number; facts: Fact[]; title?: string }) {
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const [attribute, setAttribute] = useState<FactInputAttribute>(null);
  const id = 'facts-' + entityType;
  return (
    <section className="oo-kcard" aria-labelledby={id}>
      <h2 id={id} className="oo-h2">{title}</h2>
      {facts.length === 0 && !adding && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No facts yet.</p>}
      {facts.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.5 }}>
          {facts.map((f) => <FactItem key={f.id} fact={f} />)}
        </ul>
      )}
      {adding ? (
        <InlineAdd
          label="New fact"
          placeholder="Something true about this, in one line"
          testId="fact"
          extra={
            <Dropdown
              variant="compact"
              ariaLabel="What the fact is about"
              title="A fact about a job title, status and so on replaces the current fact of that kind"
              value={attribute ?? ''}
              onChange={(v) => setAttribute((v || null) as FactInputAttribute)}
              options={[{ value: '', label: 'General fact' }, ...FACT_ATTRIBUTES.map((a) => ({ value: a.value, label: a.label }))]}
              testId="select-fact-attribute"
            />
          }
          onCancel={() => {
            setAdding(false);
            setAttribute(null);
          }}
          onSave={async (text) => {
            const ok = await write(() => createFact({ entityType, entityId, text, attribute }), { fail: 'Could not add that fact' });
            if (ok) {
              setAdding(false);
              setAttribute(null);
            }
          }}
        />
      ) : (
        <div><button type="button" className="oo-textbtn" onClick={() => setAdding(true)} data-testid="button-add-fact">Add a fact</button></div>
      )}
    </section>
  );
}

function FactItem({ fact }: { fact: Fact }) {
  const write = useKnowledgeWrite();
  const [replacing, setReplacing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  return (
    <li data-testid={'fact-' + fact.id}>
      {replacing ? (
        <InlineAdd
          label="Replace fact"
          initial={fact.text}
          placeholder="The fact as it now stands"
          testId={'replace-fact-' + fact.id}
          submitLabel="Replace"
          onCancel={() => setReplacing(false)}
          onSave={async (text) => {
            const ok = await write(() => supersedeFact(fact.id, { text }), { done: 'Fact replaced', fail: 'Could not replace that fact' });
            if (ok) setReplacing(false);
          }}
        />
      ) : (
        <>
          {fact.attribute && <span className="oo-muted" style={{ fontSize: 12, marginRight: 6 }}>{ATTRIBUTE_LABEL[fact.attribute]}:</span>}
          <span>{fact.text}</span>
          {fact.needsCheck && (
            <Link href="/knowledge/inbox?tab=stale" className="oo-check-mark" style={{ textDecoration: 'none' }} title="Nobody has confirmed this in a while. Check it in the Knowledge Inbox." data-testid={'mark-needs-check-' + fact.id}>
              Needs a check
            </Link>
          )}{' '}
          <span style={{ display: 'inline-flex', gap: 10, marginLeft: 4 }}>
            <button type="button" className="oo-textbtn" style={{ fontSize: 12 }} onClick={() => setReplacing(true)} data-testid={'button-replace-fact-' + fact.id}>Replace</button>
            {fact.history.length > 0 && (
              <button type="button" className="oo-textbtn" style={{ fontSize: 12 }} aria-expanded={showHistory} onClick={() => setShowHistory((s) => !s)} data-testid={'button-fact-history-' + fact.id}>
                {showHistory ? 'Hide earlier' : `Earlier (${fact.history.length})`}
              </button>
            )}
          </span>
          {showHistory && (
            <div className="oo-history" data-testid={'list-fact-history-' + fact.id}>
              {fact.history.map((h) => (
                <span key={h.id}><s>{h.text}</s> · replaced, first noted {formatDayMonthShort(h.createdAt)}</span>
              ))}
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** A small one-line form used for facts, decisions and links. */
export function InlineAdd({
  label,
  placeholder,
  initial = '',
  submitLabel = 'Add',
  testId,
  onSave,
  onCancel,
  extra,
}: {
  label: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  testId: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSave(text.trim());
    setBusy(false);
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }} data-testid={'form-' + testId}>
      <input
        className="oo-input"
        style={{ flex: '1 1 220px' }}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        data-testid={'input-' + testId}
      />
      {extra}
      <button type="submit" className="oo-btn oo-btn-ink" disabled={!text.trim() || busy} data-testid={'button-save-' + testId}>{submitLabel}</button>
      <button type="button" className="oo-btn oo-btn-outline" onClick={onCancel} data-testid={'button-cancel-' + testId}>Cancel</button>
    </form>
  );
}

/* ---------- Decisions ---------- */

export function DecisionsSection({ projectId, decisions }: { projectId: number; decisions: Decision[] }) {
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(todayLondon());
  return (
    <section className="oo-kcard" aria-labelledby="decisions-h">
      <h2 id="decisions-h" className="oo-h2">Decisions</h2>
      {decisions.length === 0 && !adding && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No decisions recorded.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14, lineHeight: 1.5 }}>
        {decisions.map((d) => (
          <div key={d.id} style={{ display: 'flex', gap: 12 }} data-testid={'decision-' + d.id}>
            <Link href={'/knowledge/decisions/' + d.id} className="oo-tl-date" style={{ width: 76, textDecoration: 'none' }} data-testid={'link-decision-' + d.id}>
              {formatDayMonthShort(d.decidedAt)}
            </Link>
            <div style={{ minWidth: 0, flex: 1 }}>
              <InlineText
                value={d.text}
                label="Decision"
                multiline
                required
                testId={'decision-' + d.id}
                onSave={(text) => write(() => updateDecision(d.id, { text: text ?? '' }))}
              />
              {d.confidential === true && <span style={{ marginLeft: 0 }}><HiddenFromAi confidential /></span>}
            </div>
          </div>
        ))}
      </div>
      {adding ? (
        <InlineAdd
          label="New decision"
          placeholder="What was decided"
          testId="decision"
          extra={
            <input
              type="date"
              className="oo-input"
              style={{ width: 'auto' }}
              aria-label="Decided on"
              value={date}
              max={todayLondon()}
              onChange={(e) => setDate(e.target.value)}
              data-testid="input-decision-date"
            />
          }
          onCancel={() => setAdding(false)}
          onSave={async (text) => {
            const ok = await write(() => createDecision({ projectId, text, decidedAt: date || todayLondon() }), { fail: 'Could not add that decision' });
            if (ok) setAdding(false);
          }}
        />
      ) : (
        <div><button type="button" className="oo-textbtn" onClick={() => setAdding(true)} data-testid="button-add-decision">Add a decision</button></div>
      )}
    </section>
  );
}

/* ---------- Tasks ---------- */

export function TaskRows({ tasks, empty }: { tasks: Task[]; empty: string }) {
  if (!tasks.length) return <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '6px 0' }}>{empty}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {tasks.map((t) => (
        <div key={t.id} className="oo-krow" data-testid={'row-task-' + t.id}>
          <Link href={'/tasks?task=' + t.id} className="oo-krow-link" data-testid={'link-task-' + t.id}>{t.title}</Link>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="oo-pill" data-tone={t.priority === 'high' ? 'high' : undefined}>{PRIORITY_LABELS[t.priority]}</span>
            {t.dueDate && <span className="oo-muted oo-num">{formatShort(t.dueDate)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Timeline ---------- */

export function Timeline({ items, empty, compact }: { items: TimelineItem[]; empty: string; compact?: boolean }) {
  if (!items.length) return <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{empty}</p>;
  if (compact) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }} className="oo-soft">
        {items.map((i) => {
          const path = refPath(i.ref);
          const body = <><b style={{ fontWeight: 500, color: 'var(--oo-ink)' }}>{i.label}</b> · {i.text} · {formatDayMonthShort(i.at)}</>;
          return path ? (
            <Link key={i.key} href={path} className="oo-krow-link" style={{ color: 'inherit' }} data-testid={'link-activity-' + i.key}>{body}</Link>
          ) : (
            <span key={i.key}>{body}</span>
          );
        })}
      </div>
    );
  }
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
      {items.map((i) => {
        const path = refPath(i.ref);
        return (
          <li key={i.key} style={{ display: 'flex', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--oo-line-soft)' }} data-testid={'timeline-' + i.key}>
            <span className="oo-tl-date">{formatDayMonthShort(i.at)}</span>
            <span style={{ fontSize: 14, lineHeight: 1.5, minWidth: 0, overflowWrap: 'anywhere' }}>
              <b style={{ fontWeight: 500 }}>{i.label}</b> ·{' '}
              {path ? <Link href={path} className="oo-krow-link">{i.text}</Link> : i.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- Notes ---------- */

export function AddNote({ entityType, entityId, placeholder }: { entityType: 'project' | 'person' | 'organisation'; entityId: number; placeholder: string }) {
  const write = useKnowledgeWrite();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const id = 'note-box-' + entityType;
  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    const ok = await write(() => createNote({ entityType, entityId, body: body.trim() }), { done: 'Note saved', fail: 'Could not save that note' });
    setBusy(false);
    if (ok) setBody('');
  };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor={id} className="oo-h2">Add a note</label>
      <textarea
        id={id}
        rows={3}
        className="oo-textarea"
        placeholder={placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
        data-testid="input-note"
      />
      <div><button type="button" className="oo-btn oo-btn-ink" disabled={!body.trim() || busy} onClick={save} data-testid="button-save-note">Save note</button></div>
    </section>
  );
}

export function NotesList({ notes }: { notes: Note[] }) {
  if (!notes.length) return null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-labelledby="notes-h">
      <h2 id="notes-h" className="oo-h2">Notes</h2>
      <div>
        {notes.map((n) => (
          <div key={n.id} className="oo-krow" style={{ alignItems: 'flex-start' }} data-testid={'row-note-' + n.id}>
            <Link href={'/knowledge/notes/' + n.id} className="oo-krow-link" style={{ minWidth: 0, flex: '1 1 300px' }} data-testid={'link-note-' + n.id}>
              {n.title ? <b style={{ fontWeight: 500 }}>{n.title}. </b> : null}
              <span className="oo-soft">{n.body.length > 160 ? n.body.slice(0, 159) + '…' : n.body}</span>
            </Link>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {n.hiddenFromAi && <HiddenFromAi confidential={n.confidential === true} />}
              <span className="oo-muted" style={{ fontSize: 13 }}>{formatDayMonthShort(n.updatedAt)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- Links ---------- */

export function PersonChipLink({
  person,
  sub,
  onUnlink,
}: {
  person: { id: number; name: string; slug: string; confidential: boolean };
  sub?: string | null;
  onUnlink?: () => void;
}) {
  return (
    <span className="oo-pchip" data-testid={'chip-person-' + person.id}>
      <Link href={'/knowledge/people/' + person.slug} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'inherit', textDecoration: 'none' }}>
        <Avatar name={person.name} id={person.id} size={24} />
        {person.name}{sub ? ` · ${sub}` : ''}
        {person.confidential && <LockMark />}
      </Link>
      {onUnlink && (
        <button type="button" className="oo-pchip-x" aria-label={`Unlink ${person.name}`} onClick={onUnlink} data-testid={'button-unlink-person-' + person.id}>
          <IconClose size={12} />
        </button>
      )}
    </span>
  );
}

export function EntityChipLink({
  entity,
  base,
  onUnlink,
  testId,
}: {
  entity: { id: number; name: string; slug: string; confidential: boolean };
  base: string;
  onUnlink?: () => void;
  testId: string;
}) {
  return (
    <span className="oo-pchip" data-plain="true" data-testid={testId}>
      <Link href={`${base}/${entity.slug}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'inherit', textDecoration: 'none' }}>
        {entity.name}
        {entity.confidential && <LockMark />}
      </Link>
      {onUnlink && (
        <button type="button" className="oo-pchip-x" aria-label={`Unlink ${entity.name}`} onClick={onUnlink} data-testid={'button-unlink-' + testId}>
          <IconClose size={12} />
        </button>
      )}
    </span>
  );
}

type LinkTarget = 'person' | 'project' | 'organisation';
const TARGET_LABEL: Record<LinkTarget, string> = { person: 'a person', project: 'a project', organisation: 'an organisation' };
const SEARCH_LABEL: Record<LinkTarget, string> = { person: 'Search people', project: 'Search projects', organisation: 'Search organisations' };

/** "Link a person" and friends: pick from a list, then POST /links. */
export function LinkPicker({ fromType, fromId, toType, exclude }: { fromType: Linkable; fromId: number; toType: LinkTarget; exclude: number[] }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const write = useKnowledgeWrite();
  const people = useListPeople({ query: { enabled: open && toType === 'person' } as never });
  const projects = useListProjects(undefined, { query: { enabled: open && toType === 'project' } as never });
  const orgs = useListOrganisations({ query: { enabled: open && toType === 'organisation' } as never });
  const list: { id: number; name: string }[] =
    (toType === 'person' ? people.data : toType === 'project' ? projects.data : orgs.data)?.filter((x) => !exclude.includes(x.id)) ?? [];

  if (!open) {
    return (
      <button type="button" className="oo-textbtn" onClick={() => setOpen(true)} data-testid={'button-link-' + toType}>
        Link {TARGET_LABEL[toType]}
      </button>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const toId = Number(choice);
    if (!toId) return;
    const ok = await write(() => createLink({ fromType, fromId, toType, toId }), { fail: 'Could not link that' });
    if (ok) {
      setOpen(false);
      setChoice('');
    }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }} data-testid={'form-link-' + toType}>
      <Dropdown
        variant="control"
        style={{ minWidth: 220 }}
        ariaLabel={'Choose ' + TARGET_LABEL[toType]}
        value={choice}
        onChange={setChoice}
        disabled={!list.length}
        placeholder={list.length ? `Choose ${TARGET_LABEL[toType]}…` : 'Nothing to link'}
        searchPlaceholder={SEARCH_LABEL[toType]}
        defaultOpen={list.length > 0}
        options={list.map((x) => ({ value: String(x.id), label: x.name }))}
        testId={'select-link-' + toType}
      />
      <button type="submit" className="oo-btn oo-btn-ink" disabled={!choice} data-testid={'button-save-link-' + toType}>Link</button>
      <button type="button" className="oo-btn oo-btn-outline" onClick={() => setOpen(false)} data-testid={'button-cancel-link-' + toType}>Cancel</button>
    </form>
  );
}

export function useUnlink() {
  const write = useKnowledgeWrite();
  return (fromType: Linkable, fromId: number, toType: Linkable, toId: number) =>
    write(() => removeLink({ fromType, fromId, toType, toId }), { done: 'Unlinked', fail: 'Could not unlink that' });
}

/* ---------- Page states ---------- */

export function PageSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="state-loading">
      <span className="oo-skel" style={{ height: 18, width: 140 }} />
      <span className="oo-skel" style={{ height: 34, width: '55%' }} />
      <span className="oo-skel" style={{ height: 14, width: '80%' }} />
      <span className="oo-skel" style={{ height: 14, width: '70%' }} />
      <span className="oo-skel" style={{ height: 120, width: '100%' }} />
    </div>
  );
}

export function PageProblem({ notFound, what, onRetry, back }: { notFound: boolean; what: string; onRetry: () => void; back: { href: string; label: string } }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={notFound ? 'state-not-found' : 'state-error'}>
      <p className="oo-serif" style={{ margin: 0, fontSize: 22 }}>{notFound ? `That ${what} does not exist.` : `Could not load this ${what}.`}</p>
      <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{notFound ? 'It may have been renamed or the link is wrong.' : 'Check your connection and try again.'}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {!notFound && <button type="button" className="oo-btn oo-btn-outline" onClick={onRetry} data-testid="button-retry">Try again</button>}
        <Link href={back.href} className="oo-btn oo-btn-outline" data-testid="link-back">{back.label}</Link>
      </div>
    </div>
  );
}
