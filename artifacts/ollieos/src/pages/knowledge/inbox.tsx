import { useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  approveSuggestion,
  bulkDecideSuggestions,
  mergeSuggestion,
  rejectSuggestion,
  rejectSuggestionsFromSource,
  resolveFactReview,
  useListKnowledgeInbox,
  useListProjects,
  useListSuggestionMergeOptions,
  type FactReviewResolve,
  type KnowledgeInboxItem,
  type KnowledgeInboxItemKind,
  type KnowledgeInboxPlaybook,
} from '@workspace/api-client-react';
import { daysBetween, formatDayMonth, formatLong, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { CharCount, Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { projectOptions } from '@/components/dropdown-options';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { entityPath, useKnowledgeWrite } from '@/lib/knowledge';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

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
  new_document: { label: 'New document', tone: 'fact' },
  document_link: { label: 'Link document', tone: 'fact' },
  new_rule: { label: 'New rule', tone: 'decision' },
  new_playbook: { label: 'Playbook', tone: 'decision' },
  playbook_change: { label: 'Playbook change', tone: 'decision' },
  new_product: { label: 'Product', tone: 'fact' },
  cadence_change: { label: 'Suggested cadence', tone: 'person' },
  new_relationship: { label: 'Relationship', tone: 'person' },
  conflict: { label: 'Conflict', tone: 'conflict' },
  stale_fact: { label: 'Stale fact', tone: 'stale' },
  contradiction: { label: 'Contradicts', tone: 'conflict' },
  out_of_date: { label: 'May be out of date', tone: 'stale' },
};

const APPROVED: Partial<Record<KnowledgeInboxItemKind, string>> = {
  new_document: 'Added to the Library',
  document_link: 'Linked to the project',
  new_rule: 'Added to rules and switched on',
  new_playbook: 'Added to playbooks',
  playbook_change: 'Playbook updated and marked as checked',
  new_product: 'Added to products',
  cadence_change: 'Cadence set',
  new_relationship: 'Relationship added',
};

const EMPTY: Record<Tab, string> = {
  suggested: 'Nothing waiting. When Claude or the sweep wants to add or change something, it lands here first.',
  conflicts: 'No conflicts. When two facts disagree, or a new card disagrees with something already approved, you choose here.',
  stale: 'Nothing needs a check. The weekly check looks for facts nobody has confirmed in a while, and anything a newer card contradicts shows here too.',
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
  const from = tab === 'suggested' ? new URLSearchParams(search).get('from') : null;
  const lookBackOnly = from === 'look-back';
  const documentsOnly = from === 'documents';
  const inbox = useListKnowledgeInbox({ tab, origin: lookBackOnly ? 'look_back' : documentsOnly ? 'documents' : 'all' });
  const [done, setDone] = useState<Record<string, Done>>({});

  const counts = inbox.data?.counts;
  const live = inbox.data?.items ?? [];
  const liveKeys = new Set(live.map((i) => i.key));
  const kept = Object.values(done).filter((d) => d.item.group === tab && !liveKeys.has(d.item.key)).map((d) => d.item);
  const all = [...live, ...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));

  // Bulk review on Suggested: filter by kind and by who proposed it, tick cards, then approve or reject them together.
  const bulk = tab === 'suggested';
  const [kindFilter, setKindFilter] = useState('');
  const [byFilter, setByFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const items = bulk ? all.filter((i) => (!kindFilter || i.kind === kindFilter) && (!byFilter || i.by === byFilter)) : all;
  const pickable = items.filter((i) => i.group === 'suggested' && !done[i.key]);
  const pickedHere = pickable.filter((i) => selected.has(i.id));
  const allPicked = pickable.length > 0 && pickedHere.length === pickable.length;
  const tally = (key: (i: KnowledgeInboxItem) => string, label: (i: KnowledgeInboxItem) => string) => {
    const m = new Map<string, { label: string; n: number }>();
    for (const i of live) if (i.group === 'suggested') m.set(key(i), { label: label(i), n: (m.get(key(i))?.n ?? 0) + 1 });
    return [...m].sort((a, b) => b[1].n - a[1].n).map(([value, v]) => ({ value, label: v.label, hint: String(v.n) }));
  };
  const kindOptions = useMemo(() => tally((i) => i.kind, (i) => KIND[i.kind].label), [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const byOptions = useMemo(() => tally((i) => i.by, (i) => i.by), [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(pickable.map((i) => i.id)));

  const decideSelected = async (action: 'approve' | 'reject') => {
    const ids = pickedHere.map((i) => i.id);
    if (!ids.length) return;
    setBulkBusy(true);
    setConfirming(null);
    let approved = 0;
    let rejected = 0;
    const reasons = new Map<string, number>();
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const r = await bulkDecideSuggestions({ action, ids: ids.slice(i, i + 500) });
        approved += r.approved;
        rejected += r.rejected;
        for (const k of r.skipped) reasons.set(k.reason, (reasons.get(k.reason) ?? 0) + 1);
      }
    } catch (err) {
      reportApiError(err);
      notify('Not all of them saved', errorMessage(err));
    }
    const skipped = [...reasons.values()].reduce((a, b) => a + b, 0);
    const doneText = action === 'approve' ? `Approved ${approved}` : `Rejected ${rejected}`;
    setBulkResult(skipped ? `${doneText}. ${skipped} left to review one by one: ${[...reasons].map(([r, n]) => `${r} (${n})`).join('; ')}` : `${doneText}.`);
    setSelected(new Set());
    setBulkBusy(false);
    await inbox.refetch();
  };

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
              {t.label} <span className="oo-count oo-num">{counts ? (t.id === 'stale' ? counts.stale + (counts.outOfDate ?? 0) : counts[t.id]) : ''}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === 'suggested' && (lookBackOnly || documentsOnly || (counts?.lookBack ?? 0) > 0 || (counts?.documents ?? 0) > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -4 }}>
          <Dropdown
            variant="control"
            ariaLabel="Show suggestions from"
            value={lookBackOnly ? 'look-back' : documentsOnly ? 'documents' : ''}
            onChange={(v) => navigate(v ? `/knowledge/inbox?from=${v}` : '/knowledge/inbox', { replace: true })}
            options={[
              { value: '', label: 'All suggestions' },
              ...(lookBackOnly || (counts?.lookBack ?? 0) > 0 ? [{ value: 'look-back', label: 'From look back', hint: String(counts?.lookBack ?? 0) }] : []),
              ...(documentsOnly || (counts?.documents ?? 0) > 0 ? [{ value: 'documents', label: 'From documents', hint: String(counts?.documents ?? 0) }] : []),
            ]}
            testId="select-inbox-origin"
          />
        </div>
      )}

      {bulk && live.length > 0 && (
        <div className="oo-inbox-bulk" data-testid="bar-inbox-bulk">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Dropdown variant="control" ariaLabel="Show one kind" value={kindFilter} onChange={(v) => { setKindFilter(v); setConfirming(null); }} options={[{ value: '', label: 'Every kind' }, ...kindOptions]} testId="select-inbox-kind" />
            <Dropdown variant="control" ariaLabel="Show what one source proposed" value={byFilter} onChange={(v) => { setByFilter(v); setConfirming(null); }} options={[{ value: '', label: 'From anyone' }, ...byOptions]} searchable testId="select-inbox-by" />
            {(counts?.suggested ?? 0) > live.length && (
              <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-inbox-showing">
                Showing the oldest {live.length} of {counts!.suggested}. The next ones load as you clear these.
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" className="oo-rv-select" checked={allPicked} disabled={!pickable.length || bulkBusy} onChange={toggleAll} data-testid="checkbox-inbox-all" />
              {allPicked ? 'Clear selection' : `Select all ${pickable.length} shown`}
            </label>
            {pickedHere.length > 0 && <span className="oo-num" style={{ fontSize: 14, fontWeight: 600 }} data-testid="text-inbox-selected">{pickedHere.length} selected</span>}
            {pickedHere.length > 0 && !confirming && (
              <>
                <button type="button" className="oo-btn oo-btn-ink" disabled={bulkBusy} onClick={() => setConfirming('approve')} data-testid="button-bulk-approve">Approve {pickedHere.length}</button>
                <button type="button" className="oo-btn oo-btn-danger" disabled={bulkBusy} onClick={() => setConfirming('reject')} data-testid="button-bulk-reject">Reject {pickedHere.length}</button>
              </>
            )}
            {confirming && (
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }} data-testid="confirm-bulk">
                <span style={{ fontSize: 14 }}>
                  {confirming === 'approve' ? `Approve ${pickedHere.length} as they stand?` : `Reject ${pickedHere.length}?`}
                  <span className="oo-muted"> Each is saved as if you pressed the button on it.</span>
                </span>
                <button type="button" className={confirming === 'approve' ? 'oo-btn oo-btn-ink' : 'oo-btn oo-btn-danger'} onClick={() => void decideSelected(confirming)} data-testid="button-bulk-confirm">
                  Yes, {confirming} {pickedHere.length}
                </button>
                <button type="button" className="oo-btn oo-btn-outline" onClick={() => setConfirming(null)} data-testid="button-bulk-cancel">Cancel</button>
              </span>
            )}
            {bulkBusy && <span className="oo-muted" style={{ fontSize: 14 }} role="status">Saving…</span>}
          </div>
          {bulkResult && !bulkBusy && <p role="status" style={{ margin: 0, fontSize: 13 }} data-testid="text-bulk-result">{bulkResult}</p>}
        </div>
      )}

      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: -6 }}>
        {inbox.isLoading ? (
          [0, 1, 2].map((i) => <Skel key={i} h={150} />)
        ) : inbox.error ? (
          <div className="oo-kcard" data-testid="state-inbox-error">
            <p style={{ margin: 0, fontSize: 14 }}>The Knowledge Inbox did not load.</p>
            <div><button type="button" className="oo-btn oo-btn-outline" onClick={() => inbox.refetch()}>Try again</button></div>
          </div>
        ) : items.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '8px 0' }} data-testid="text-inbox-empty">
            {bulk && (kindFilter || byFilter) && live.length > 0
              ? 'Nothing waiting matches these filters.'
              : lookBackOnly
              ? 'Nothing from a look back is waiting. Start one from Settings, Connectors, Granola.'
              : documentsOnly
                ? 'Nothing from documents is waiting. Use Build knowledge from this on a document in the Library.'
                : EMPTY[tab]}
          </p>
        ) : (
          items.map((it) => (
            <InboxCard
              key={it.key}
              item={it}
              done={done[it.key]}
              onDone={(result, ok) => setDone((d) => ({ ...d, [it.key]: { item: it, result, ok } }))}
              picked={bulk && it.group === 'suggested' && !done[it.key] ? selected.has(it.id) : undefined}
              onPick={() => toggle(it.id)}
            />
          ))
        )}
      </div>
    </KnowledgeLayout>
  );
}

function byLine(it: KnowledgeInboxItem): string {
  if (it.kind === 'out_of_date') return 'Contradiction check';
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

function InboxCard({ item: it, done, onDone, picked, onPick }: { item: KnowledgeInboxItem; done?: Done; onDone: (result: string, ok: boolean) => void; picked?: boolean; onPick?: () => void }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit' | 'own' | 'same'>('view');
  const kind = KIND[it.kind];
  const testKey = it.key.replace(':', '-');
  // A decision with no project: file it under one, a new one, or none.
  const [project, setProject] = useState('');
  const [newName, setNewName] = useState(it.projectHint ?? '');
  const filing = it.needsProject && !done ? (project === NEW ? { newProjectName: newName.trim() } : project ? { projectId: Number(project) } : {}) : {};
  const filingBlocked = project === NEW && !newName.trim();

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
  const contradiction = it.kind === 'contradiction';
  const outOfDate = it.kind === 'out_of_date';
  const source =
    it.group === 'stale' && !outOfDate
      ? [it.source === 'You' ? 'Added by you' : it.source, staleDays != null ? `${staleDays} ${staleDays === 1 ? 'day' : 'days'} since anyone confirmed it` : null].filter(Boolean).join('. ') + '.'
      : it.source;

  return (
    <article className="oo-icard" data-done={done ? 'true' : 'false'} aria-label={`${kind.label}${it.target ? ' on ' + (it.target.isSelf ? 'your profile' : it.target.name) : ''}`} data-testid={'card-' + testKey}>
      <div className="oo-icard-meta">
        {picked !== undefined && (
          <input type="checkbox" className="oo-rv-select" checked={picked} onChange={onPick} aria-label={`Select: ${(it.text ?? kind.label).slice(0, 80)}`} data-testid={'checkbox-' + testKey} />
        )}
        <span className="oo-kind" data-tone={kind.tone}>{kind.label}</span>
        <Target it={it} />
        <span>· {byLine(it)}</span>
        {it.lookBack && <span className="oo-pill" data-testid={'pill-look-back-' + testKey}>From look back</span>}
        {it.fromDocument && <span className="oo-pill" data-testid={'pill-document-' + testKey}>{it.fromDocument.startsWith('session:') ? 'From a Cowork session' : 'From a document'}</span>}
        {it.attribute && it.group !== 'conflicts' && <span className="oo-pill">{it.attribute}</span>}
      </div>

      {contradiction ? (
        <ContradictionSides it={it} testKey={testKey} />
      ) : outOfDate ? (
        <>
          <p className="oo-icard-text">{it.text}</p>
          {(it.contradicts ?? []).map((c) => (
            <p key={c.ref} style={{ margin: 0, fontSize: 13 }} className="oo-soft" data-testid={'text-out-of-date-why-' + testKey}>
              <span className="oo-muted">Why:</span> {c.why}
            </p>
          ))}
        </>
      ) : it.group === 'conflicts' ? (
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
          blocked={filingBlocked}
          onSave={(fields) =>
            it.group === 'stale'
              ? resolve({ action: 'edit', text: fields.text ?? '' }, 'Updated and confirmed today', true)
              : run(() => approveSuggestion(it.id, { fields, ...filing }), approvedText(it, project, newName) + ', with your edits', true)
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
          {it.playbook && <StepsDiff pb={it.playbook} change={it.kind === 'playbook_change'} testKey={testKey} />}
          {it.replaces && (
            <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
              <span className="oo-muted">Replaces:</span> {it.replaces}
            </p>
          )}
        </>
      )}

      {!contradiction && <SaidBy it={it} testKey={testKey} />}
      {source && !contradiction && (
        <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
          <span className="oo-muted">Source:</span>{' '}
          {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer">{source}</a> : source}
        </p>
      )}
      {it.fromDocument && !done && <RejectFromSource sourceRef={it.fromDocument} testKey={testKey} />}

      {it.needsProject && !done && mode !== 'own' && (
        <ProjectPicker testKey={testKey} hint={it.projectHint} value={project} onChange={setProject} newName={newName} onNewName={setNewName} />
      )}

      {mode === 'same' && !done && (
        <SameAsExisting
          it={it}
          testKey={testKey}
          busy={busy}
          onCancel={() => setMode('view')}
          onPick={(itemType, itemId) => run(() => mergeSuggestion(it.id, { itemType, itemId }), SAME_DONE[itemType], true)}
        />
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
              <button type="button" className="oo-btn oo-btn-ink" disabled={busy || filingBlocked} onClick={() => run(() => approveSuggestion(it.id, filing), approvedText(it, project, newName), true)} data-testid={'button-approve-' + testKey}>Approve</button>
              {it.fields.some((f) => f.editable) && (
                <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => setMode('edit')} data-testid={'button-edit-' + testKey}>Edit, then approve</button>
              )}
              {MERGEABLE[it.kind] && (
                <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => setMode('same')} data-testid={'button-same-' + testKey}>Same as existing</button>
              )}
              <button type="button" className="oo-btn oo-btn-danger" disabled={busy} onClick={() => run(() => rejectSuggestion(it.id), 'Rejected', false)} data-testid={'button-reject-' + testKey}>Reject</button>
            </>
          )}
          {contradiction && (
            <>
              <button type="button" className="oo-btn oo-btn-ink" disabled={busy} onClick={() => resolve({ action: 'new_right' }, 'New one approved. The old one is kept in history.', true)} data-testid={'button-new-right-' + testKey}>New one is right</button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => resolve({ action: 'old_stands' }, 'The approved one stands. The new card was rejected.', false)} data-testid={'button-old-stands-' + testKey}>Old one stands</button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => resolve({ action: 'both_true' }, 'Both kept. The new one was approved too.', true)} data-testid={'button-both-true-' + testKey}>Both are true</button>
            </>
          )}
          {outOfDate && (
            <Link href="/knowledge/inbox?tab=conflicts" className="oo-btn oo-btn-outline" data-testid={'link-decide-' + testKey}>Decide under Conflicts</Link>
          )}
          {it.group === 'conflicts' && !contradiction && (
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
          {it.group === 'stale' && !outOfDate && (
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

/** Who said it and when, linked to their page when they are in People. */
function Claimant({ by, at, fallback }: { by: KnowledgeInboxItem['saidBy']; at: string | null; fallback: string }) {
  const path = by && by.personId != null && !by.isSelf ? entityPath('person', by.slug, by.personId) : null;
  const name = by ? (by.isSelf ? 'You' : by.name) : fallback;
  return (
    <>
      {path ? <Link href={path}>{name}</Link> : name}
      {at ? `, ${formatDayMonth(at)}` : ''}
    </>
  );
}

/** A new card beside each approved item it disagrees with, who said each and when, and which looks stronger. */
function ContradictionSides({ it, testKey }: { it: KnowledgeInboxItem; testKey: string }) {
  const sides = it.contradicts ?? [];
  const newStronger = sides.some((c) => c.stronger === 'new');
  return (
    <>
      <div className="oo-icard-sides">
        <div className="oo-icard-side" data-stronger={newStronger ? 'true' : 'false'} data-testid={'side-new-' + testKey}>
          <span className="oo-icard-side-label">New card</span>
          <span className="oo-icard-side-text">{it.text}</span>
          <span className="oo-icard-side-meta">
            Said by <Claimant by={it.saidBy} at={it.saidAt ?? it.createdAt} fallback={it.by} />
            {it.source ? <>. {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noreferrer">{it.source}</a> : it.source}</> : null}
          </span>
        </div>
        {sides.map((c) => (
          <div key={c.ref} className="oo-icard-side" data-stronger={c.stronger === 'old' ? 'true' : 'false'} data-testid={`side-old-${testKey}-${c.ref.replace(':', '-')}`}>
            <span className="oo-icard-side-label">Approved {c.label.toLowerCase()}</span>
            <span className="oo-icard-side-text">{c.text}</span>
            <span className="oo-icard-side-meta">
              Said by <Claimant by={c.saidBy} at={c.saidAt} fallback="You" />
              {c.source && !(c.source === 'You' && (c.saidBy?.isSelf ?? true)) ? `. ${c.source}` : ''}
            </span>
          </div>
        ))}
      </div>
      {sides.map((c) => (
        <p key={c.ref} style={{ margin: 0, fontSize: 13 }} className="oo-soft" data-testid={`text-weighing-${testKey}-${c.ref.replace(':', '-')}`}>
          {sides.length > 1 && <span className="oo-muted">Against “{c.text}”: </span>}
          {c.why} {c.weighing}
        </p>
      ))}
    </>
  );
}

/** "Said by Sam Lee, 3rd November": who made the claim, linked to their page when they are in People. */
function SaidBy({ it, testKey }: { it: KnowledgeInboxItem; testKey: string }) {
  const s = it.saidBy;
  if (!s) {
    // No speaker known (such as a look-back meeting card): still say when it was discussed or said.
    if (!it.saidAt) return null;
    return (
      <p style={{ margin: 0, fontSize: 13 }} className="oo-soft" data-testid={'text-said-at-' + testKey}>
        <span className="oo-muted">{it.lookBack ? 'Discussed:' : 'Said:'}</span> {formatLong(it.saidAt)}
      </p>
    );
  }
  const path = s.personId != null ? entityPath('person', s.slug, s.personId) : null;
  const name = s.isSelf ? 'You' : s.name;
  return (
    <p style={{ margin: 0, fontSize: 13 }} className="oo-soft" data-testid={'text-said-by-' + testKey}>
      <span className="oo-muted">Said by:</span>{' '}
      {path && !s.isSelf ? <Link href={path}>{name}</Link> : name}
      {it.saidAt ? `, ${formatDayMonth(it.saidAt)}` : ''}
    </p>
  );
}

type MergeType = 'fact' | 'decision' | 'rule';
const MERGEABLE: Partial<Record<KnowledgeInboxItemKind, MergeType>> = { new_fact: 'fact', proposed_decision: 'decision', new_rule: 'rule' };
const SAME_DONE: Record<MergeType, string> = {
  fact: 'Same as an existing fact. Marked as checked today.',
  decision: 'Same as an existing decision. Nothing added.',
  rule: 'Same as an existing rule. Nothing added.',
};

/** Picks the approved fact, decision or rule this card already says. */
function SameAsExisting({ it, testKey, busy, onPick, onCancel }: { it: KnowledgeInboxItem; testKey: string; busy: boolean; onPick: (type: MergeType, id: number) => void; onCancel: () => void }) {
  const q = useListSuggestionMergeOptions(it.id);
  const what = MERGEABLE[it.kind] ?? 'fact';
  const options = (q.data ?? []).map((o) => ({
    value: `${o.itemType}:${o.id}`,
    label: o.text,
    hint: o.detail ?? undefined,
    group: o.likely ? 'Close matches' : 'Others',
  }));
  return (
    <div role="group" aria-label="Same as an existing one" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
      {q.error ? (
        <span role="alert">Could not load the existing ones.</span>
      ) : !q.isLoading && options.length === 0 ? (
        <span className="oo-muted" data-testid={'text-same-none-' + testKey}>There is no approved {what} {what === 'fact' ? 'on this yet' : 'yet'} to match it to.</span>
      ) : (
        <Dropdown
          variant="control"
          ariaLabel={`Existing ${what}`}
          value=""
          defaultOpen
          disabled={busy || q.isLoading}
          onChange={(v) => {
            const [type, id] = v.split(':');
            onPick(type as MergeType, Number(id));
          }}
          placeholder={q.isLoading ? 'Loading…' : `Choose the existing ${what}`}
          searchPlaceholder={`Search ${what}s`}
          options={options}
          testId={'select-same-' + testKey}
          style={{ flex: '1 1 260px', minWidth: 0, maxWidth: 520 }}
        />
      )}
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={onCancel} data-testid={'button-same-cancel-' + testKey}>Cancel</button>
    </div>
  );
}

const LONG = new Set(['text', 'summary', 'relationship_summary', 'rule', 'when_to_use']);
const REQUIRED = new Set(['text', 'name', 'title', 'applies_when', 'rule', 'when_to_use']);
const MAX: Record<string, number> = { rule: 400 };

const NEW = '__new';

function approvedText(it: KnowledgeInboxItem, project: string, newName: string): string {
  if (!it.needsProject) return APPROVED[it.kind] ?? 'Added to knowledge';
  if (project === NEW) return `Added to knowledge, under the new project ${newName.trim()}`;
  return project ? 'Added to knowledge, under that project' : 'Added to knowledge, with no project';
}

const CHANGE_WORD: Record<string, string> = { added: 'New step', changed: 'Changed', removed: 'Removed' };

/** A Playbook card's steps, with what a change adds, changes or removes marked. */
function StepsDiff({ pb, change, testKey }: { pb: KnowledgeInboxPlaybook; change: boolean; testKey: string }) {
  if (!pb.steps.length) return null;
  const counts = pb.steps.reduce<Record<string, number>>((c, s) => ({ ...c, [s.change]: (c[s.change] ?? 0) + 1 }), {});
  const summary = change
    ? [counts.added && `${counts.added} added`, counts.changed && `${counts.changed} changed`, counts.removed && `${counts.removed} removed`].filter(Boolean).join(', ') || 'Steps unchanged'
    : null;
  let n = 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={'steps-' + testKey}>
      <span className="oo-muted" style={{ fontSize: 12 }}>Steps{summary ? ` · ${summary}` : ''}</span>
      <ol className="oo-isteps">
        {pb.steps.map((s, i) => {
          if (s.change !== 'removed') n += 1;
          const meta = [s.person, s.afterDays != null ? `day ${s.afterDays}` : null].filter(Boolean).join(', ');
          return (
            <li key={i} data-change={s.change} data-testid={`step-${testKey}-${i}`}>
              <span className="oo-isteps-n oo-num" aria-hidden="true">{s.change === 'removed' ? '–' : n}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span>
                  {CHANGE_WORD[s.change] && <span className="oo-isteps-mark">{CHANGE_WORD[s.change]}: </span>}
                  <span className="oo-isteps-text">{s.text}</span>
                  {meta && <span className="oo-muted"> · {meta}</span>}
                </span>
                {s.before && <span className="oo-muted" style={{ fontSize: 12 }}>Was: {s.before}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** For a decision that matched no project: file it under one, start a new one, or leave it on its own. */
function ProjectPicker({ testKey, hint, value, onChange, newName, onNewName }: { testKey: string; hint: string | null; value: string; onChange: (v: string) => void; newName: string; onNewName: (v: string) => void }) {
  const projects = useListProjects();
  const id = 'decision-project-' + testKey;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={'picker-project-' + testKey}>
      <label htmlFor={id} className="oo-muted" style={{ fontSize: 12 }}>
        File under a project (optional){hint ? ` · looks to be about ${hint}` : ''}
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Dropdown
          id={id}
          variant="compact"
          value={value}
          onChange={onChange}
          searchPlaceholder="Search projects"
          options={[{ value: '', label: 'No project' }, ...projectOptions(projects.data), { value: NEW, label: 'New project…' }]}
          testId={'select-project-' + testKey}
        />
        {value === NEW && (
          <input
            className="oo-input"
            style={{ width: 'auto', flex: '1 1 200px', minHeight: 32, padding: '3px 8px' }}
            aria-label="New project name"
            placeholder="Project name"
            autoFocus
            value={newName}
            maxLength={200}
            onChange={(e) => onNewName(e.target.value)}
            data-testid={'input-new-project-' + testKey}
          />
        )}
      </div>
    </div>
  );
}

function EditForm({ it, busy, blocked, onSave, onCancel }: { it: KnowledgeInboxItem; busy: boolean; blocked?: boolean; onSave: (fields: Record<string, string>) => void; onCancel: () => void }) {
  const editable = it.fields.filter((f) => f.editable);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((f) => [f.key, f.value ?? ''])));
  const missing = !!blocked || editable.some((f) => (REQUIRED.has(f.key) && !values[f.key]?.trim()) || (MAX[f.key] !== undefined && (values[f.key] ?? '').trim().length > MAX[f.key]));
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
              <>
                <textarea id={id} className="oo-textarea" rows={3} autoFocus={i === 0} value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} onKeyDown={(e) => e.key === 'Escape' && onCancel()} data-testid={'input-' + id} />
                {MAX[f.key] !== undefined && <CharCount n={(values[f.key] ?? '').trim().length} max={MAX[f.key]} />}
              </>
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

/** Rejects everything still waiting from the same document or Dropbox file, after a second click. */
function RejectFromSource({ sourceRef, testKey }: { sourceRef: string; testKey: string }) {
  const write = useKnowledgeWrite();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const what = sourceRef.startsWith('session:') ? 'session' : 'document';
  if (!asking) {
    return (
      <div>
        <button type="button" className="oo-textbtn" onClick={() => setAsking(true)} data-testid={'button-reject-source-' + testKey}>Reject everything from this {what}</button>
      </div>
    );
  }
  const go = async () => {
    setBusy(true);
    const r = await write(() => rejectSuggestionsFromSource({ sourceRef }), { fail: 'Could not reject them' });
    setBusy(false);
    setAsking(false);
    if (r) notify(r.rejected === 1 ? 'Rejected 1 suggestion' : `Rejected ${r.rejected} suggestions`, `Conflicts from this ${what} stay on the Conflicts tab.`);
  };
  return (
    <div role="group" aria-label={`Reject everything from this ${what}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
      <span>Reject every suggestion still waiting from this {what}?</span>
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={busy} onClick={go} data-testid={'button-reject-source-yes-' + testKey}>{busy ? 'Rejecting…' : 'Reject them all'}</button>
      <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={busy} onClick={() => setAsking(false)}>Keep them</button>
    </div>
  );
}
