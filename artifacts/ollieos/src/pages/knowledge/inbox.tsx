import { useState, type FormEvent } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  approveSuggestion,
  rejectSuggestion,
  resolveFactReview,
  useListKnowledgeInbox,
  type FactReviewResolve,
  type KnowledgeInboxItem,
  type KnowledgeInboxItemKind,
} from '@workspace/api-client-react';
import { daysBetween, formatDayMonth, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { entityPath, useKnowledgeWrite } from '@/lib/knowledge';

type Tab = 'suggested' | 'conflicts' | 'stale';

const TABS: { id: Tab; label: string }[] = [
  { id: 'suggested', label: 'Suggested' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'stale', label: 'Needs a check' },
];

const KIND: Record<KnowledgeInboxItemKind, { label: string; tone: string }> = {
  new_fact: { label: 'New fact', tone: 'fact' },
  new_person: { label: 'New person', tone: 'person' },
  new_organisation: { label: 'New organisation', tone: 'fact' },
  new_project: { label: 'New project', tone: 'fact' },
  proposed_decision: { label: 'Proposed decision', tone: 'decision' },
  changed_summary: { label: 'Changed summary', tone: 'person' },
  changed_details: { label: 'Changed details', tone: 'person' },
  conflict: { label: 'Conflict', tone: 'conflict' },
  stale_fact: { label: 'Stale fact', tone: 'stale' },
};

const EMPTY: Record<Tab, string> = {
  suggested: 'Nothing waiting. When Claude or the sweep wants to add or change something, it lands here first.',
  conflicts: 'No conflicts. When two facts disagree about the same thing, you choose between them here.',
  stale: 'Nothing needs a check. The weekly check looks for facts nobody has confirmed in a while.',
};

/** What happened to a card, shown in place until the page is left. */
interface Done {
  item: KnowledgeInboxItem;
  result: string;
  ok: boolean;
}

export default function KnowledgeInboxPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = new URLSearchParams(search).get('tab');
  const tab: Tab = raw === 'conflicts' || raw === 'stale' ? raw : 'suggested';
  const inbox = useListKnowledgeInbox({ tab });
  const [done, setDone] = useState<Record<string, Done>>({});

  const counts = inbox.data?.counts;
  const live = inbox.data?.items ?? [];
  const liveKeys = new Set(live.map((i) => i.key));
  const kept = Object.values(done).filter((d) => d.item.group === tab && !liveKeys.has(d.item.key)).map((d) => d.item);
  const items = [...live, ...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));

  return (
    <KnowledgeLayout testId="page-knowledge-inbox">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <h1 className="oo-h1">Knowledge Inbox</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            What AI wants to add or change in your knowledge base. Nothing becomes a fact until you approve it.
          </p>
        </div>
        <span className="oo-serif" style={{ fontSize: 22 }} data-testid="text-inbox-open">
          {counts ? `${counts.total} to review` : '…'}
        </span>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Review type" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="oo-tab"
              aria-selected={t.id === tab}
              onClick={() => navigate(t.id === 'suggested' ? '/knowledge/inbox' : `/knowledge/inbox?tab=${t.id}`, { replace: true })}
              data-testid={'tab-inbox-' + t.id}
            >
              {t.label} <span className="oo-count oo-num">{counts ? counts[t.id] : ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: -6 }}>
        {inbox.isLoading ? (
          [0, 1, 2].map((i) => <Skel key={i} h={150} />)
        ) : inbox.error ? (
          <div className="oo-kcard" data-testid="state-inbox-error">
            <p style={{ margin: 0, fontSize: 14 }}>The Knowledge Inbox did not load.</p>
            <div><button type="button" className="oo-btn oo-btn-outline" onClick={() => inbox.refetch()}>Try again</button></div>
          </div>
        ) : items.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '8px 0' }} data-testid="text-inbox-empty">{EMPTY[tab]}</p>
        ) : (
          items.map((it) => (
            <InboxCard key={it.key} item={it} done={done[it.key]} onDone={(result, ok) => setDone((d) => ({ ...d, [it.key]: { item: it, result, ok } }))} />
          ))
        )}
      </div>
    </KnowledgeLayout>
  );
}

function byLine(it: KnowledgeInboxItem): string {
  if (it.group === 'stale') return it.lastConfirmedAt ? `Last confirmed ${formatDayMonth(it.lastConfirmedAt)}` : 'Weekly check';
  const day = londonDate(it.createdAt);
  return `${it.by}, ${day === todayLondon() ? formatTime(it.createdAt) : formatDayMonth(it.createdAt)}`;
}

function Target({ it }: { it: KnowledgeInboxItem }) {
  const t = it.target;
  if (!t) return null;
  const name = t.isSelf ? 'Your profile' : t.name;
  const path = t.id != null ? entityPath(t.type, t.slug, t.id) : null;
  return (
    <>
      <span>on</span>
      {path ? <Link href={path} data-testid={`link-inbox-target-${it.key}`}>{name}</Link> : <span style={{ color: 'var(--oo-ink)', fontWeight: 500 }}>{name}</span>}
    </>
  );
}

function InboxCard({ item: it, done, onDone }: { item: KnowledgeInboxItem; done?: Done; onDone: (result: string, ok: boolean) => void }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit' | 'own'>('view');
  const kind = KIND[it.kind];
  const testKey = it.key.replace(':', '-');

  const run = async (fn: () => Promise<unknown>, result: string, ok: boolean) => {
    if (busy) return;
    setBusy(true);
    const res = await write(fn, { fail: 'That did not save' });
    setBusy(false);
    if (res !== undefined) {
      setMode('view');
      onDone(result, ok);
    }
  };
  const resolve = (body: FactReviewResolve, result: string, ok: boolean) => run(() => resolveFactReview(it.id, body), result, ok);

  const staleDays = it.lastConfirmedAt ? daysBetween(londonDate(it.lastConfirmedAt), todayLondon()) : null;
  const source =
    it.group === 'stale'
      ? [it.source === 'You' ? 'Added by you' : it.source, staleDays != null ? `${staleDays} ${staleDays === 1 ? 'day' : 'days'} since anyone confirmed it` : null].filter(Boolean).join('. ') + '.'
      : it.source;

  return (
    <article className="oo-icard" data-done={done ? 'true' : 'false'} aria-label={`${kind.label}${it.target ? ' on ' + (it.target.isSelf ? 'your profile' : it.target.name) : ''}`} data-testid={'card-' + testKey}>
      <div className="oo-icard-meta">
        <span className="oo-kind" data-tone={kind.tone}>{kind.label}</span>
        <Target it={it} />
        <span>· {byLine(it)}</span>
        {it.attribute && it.group !== 'conflicts' && <span className="oo-pill">{it.attribute}</span>}
      </div>

      {it.group === 'conflicts' ? (
        <div className="oo-icard-sides">
          {it.options.map((o) => (
            <div key={o.ref} className="oo-icard-side" data-testid={`option-${testKey}-${o.ref.replace(':', '-')}`}>
              <span>{o.label}</span>
              <span>{o.text}</span>
            </div>
          ))}
        </div>
      ) : mode === 'edit' && !done ? (
        <EditForm
          it={it}
          busy={busy}
          onCancel={() => setMode('view')}
          onSave={(fields) =>
            it.group === 'stale'
              ? resolve({ action: 'edit', text: fields.text ?? '' }, 'Updated and confirmed today', true)
              : run(() => approveSuggestion(it.id, { fields }), 'Added to knowledge, with your edits', true)
          }
        />
      ) : (
        <>
          <p className="oo-icard-text">{it.text}</p>
          {it.fields.some((f) => f.before !== null) && (
            <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
              <span className="oo-muted">Was:</span> {it.fields.filter((f) => f.before !== null).map((f) => `${f.label}: ${f.before}`).join('; ')}
            </p>
          )}
          {it.replaces && (
            <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
              <span className="oo-muted">Replaces:</span> {it.replaces}
            </p>
          )}
        </>
      )}

      {source && (
        <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
          <span className="oo-muted">Source:</span>{' '}
          {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer">{source}</a> : source}
        </p>
      )}

      {mode === 'own' && !done && (
        <OwnForm
          busy={busy}
          initial={it.options[0]?.text ?? ''}
          onCancel={() => setMode('view')}
          onSave={(text) => resolve({ action: 'write_own', text }, 'Replaced with your version', true)}
        />
      )}

      {done ? (
        <p role="status" className="oo-icard-result" data-tone={done.ok ? 'yes' : 'no'} data-testid={'result-' + testKey}>{done.result}</p>
      ) : mode === 'view' ? (
        <div className="oo-icard-actions">
          {it.group === 'suggested' && (
            <>
              <button type="button" className="oo-btn oo-btn-ink" disabled={busy} onClick={() => run(() => approveSuggestion(it.id, {}), 'Added to knowledge', true)} data-testid={'button-approve-' + testKey}>Approve</button>
              {it.fields.some((f) => f.editable) && (
                <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => setMode('edit')} data-testid={'button-edit-' + testKey}>Edit, then approve</button>
              )}
              <button type="button" className="oo-btn oo-btn-danger" disabled={busy} onClick={() => run(() => rejectSuggestion(it.id), 'Rejected', false)} data-testid={'button-reject-' + testKey}>Reject</button>
            </>
          )}
          {it.group === 'conflicts' && (
            <>
              {it.options.map((o, i) => (
                <button
                  key={o.ref}
                  type="button"
                  className={i === 0 ? 'oo-btn oo-btn-ink' : 'oo-btn oo-btn-outline'}
                  disabled={busy}
                  onClick={() => resolve({ action: 'keep', ref: o.ref }, o.label === 'You' ? 'Kept yours' : `Kept ${o.label}`, true)}
                  data-testid={`button-keep-${testKey}-${o.ref.replace(':', '-')}`}
                >
                  {o.label === 'You' ? 'Keep yours' : `Keep ${o.label}`}
                </button>
              ))}
              <button type="button" className="oo-btn oo-btn-danger" disabled={busy} onClick={() => setMode('own')} data-testid={'button-own-' + testKey}>Neither, I’ll write it</button>
            </>
          )}
          {it.group === 'stale' && (
            <>
              <button type="button" className="oo-btn oo-btn-ink" disabled={busy} onClick={() => resolve({ action: 'still_true' }, 'Confirmed today', true)} data-testid={'button-still-true-' + testKey}>Still true</button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => setMode('edit')} data-testid={'button-edit-' + testKey}>Edit</button>
              <button type="button" className="oo-btn oo-btn-danger" disabled={busy} onClick={() => resolve({ action: 'no_longer_true' }, 'Marked out of date', false)} data-testid={'button-no-longer-' + testKey}>No longer true</button>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

const LONG = new Set(['text', 'summary', 'relationship_summary']);

function EditForm({ it, busy, onSave, onCancel }: { it: KnowledgeInboxItem; busy: boolean; onSave: (fields: Record<string, string>) => void; onCancel: () => void }) {
  const editable = it.fields.filter((f) => f.editable);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((f) => [f.key, f.value ?? ''])));
  const missing = editable.some((f) => (f.key === 'text' || f.key === 'name') && !values[f.key]?.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing || busy) return;
    const changed = Object.fromEntries(editable.filter((f) => (values[f.key] ?? '').trim() !== (f.value ?? '')).map((f) => [f.key, values[f.key].trim()]));
    onSave(changed);
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={'form-edit-' + it.key.replace(':', '-')}>
      {editable.map((f, i) => {
        const id = `edit-${it.key.replace(':', '-')}-${f.key}`;
        return (
          <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor={id} style={{ fontSize: 12 }} className="oo-muted">{f.label}{f.before !== null ? ` (was: ${f.before})` : ''}</label>
            {LONG.has(f.key) ? (
              <textarea id={id} className="oo-textarea" rows={3} autoFocus={i === 0} value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} onKeyDown={(e) => e.key === 'Escape' && onCancel()} data-testid={'input-' + id} />
            ) : (
              <input id={id} className="oo-input" autoFocus={i === 0} value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} onKeyDown={(e) => e.key === 'Escape' && onCancel()} data-testid={'input-' + id} />
            )}
          </div>
        );
      })}
      <div className="oo-icard-actions">
        <button type="submit" className="oo-btn oo-btn-ink" disabled={busy || missing} data-testid={'button-save-edit-' + it.key.replace(':', '-')}>
          {it.group === 'stale' ? 'Save' : 'Approve'}
        </button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function OwnForm({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !busy) onSave(text.trim());
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <label className="oo-muted" style={{ fontSize: 12 }} htmlFor="own-fact">The fact as it now stands</label>
      <textarea id="own-fact" className="oo-textarea" rows={2} autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} data-testid="input-own-fact" />
      <div className="oo-icard-actions">
        <button type="submit" className="oo-btn oo-btn-ink" disabled={busy || !text.trim()} data-testid="button-save-own-fact">Save, replacing both</button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
