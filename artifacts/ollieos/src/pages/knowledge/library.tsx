import { useEffect, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation, useSearch } from 'wouter';
import {
  useListUnusedRulesAndPlaybooks,
  buildDocumentKnowledge,
  createRule,
  updateRule,
  useListDocuments,
  useListOrganisations,
  useListProducts,
  useListRules,
  useListProjects,
  type LibraryDocument,
  type Rule,
  type RuleUpdate,
} from '@workspace/api-client-react';
import { DOC_LOCATION_LABELS, RULE_MAX, formatDayMonthShort } from '@workspace/shared';
import { CharCount, Skel } from '@/components/bits';
import { IconArrowOut } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { HiddenFromAi, OutOfDateMark, PageProblem, TriStateAccess } from '@/components/knowledge/parts';
import { useKnowledgeWrite } from '@/lib/knowledge';
import { DocumentDialog, MultiPick } from '@/components/knowledge/document-dialog';
import { PlaybookDialog, PlaybooksTab } from '@/pages/knowledge/playbooks';

export { DocumentDialog };

type Tab = 'documents' | 'rules' | 'playbooks';
const TABS: { tab: Tab; label: string; line: string; add: string; addTestId: string }[] = [
  {
    tab: 'documents',
    label: 'Documents',
    line: 'Where the important files live, with a line on each, so you and Claude can find them. Build knowledge from a document and what it finds waits in your Knowledge Inbox.',
    add: 'Add a document',
    addTestId: 'button-add-document',
  },
  {
    tab: 'rules',
    label: 'Rules',
    line: 'Short rules every AI tool reads from OllieOS before drafting anything for you. Pause one and no AI sees it.',
    add: 'New rule',
    addTestId: 'button-new-rule',
  },
  {
    tab: 'playbooks',
    label: 'Playbooks',
    line: 'How things are done, step by step. Playbooks In use are there for you and for Claude when the moment comes.',
    add: 'New playbook',
    addTestId: 'button-new-playbook',
  },
];

export function libraryTab(raw: string | null): Tab {
  return raw === 'rules' || raw === 'playbooks' ? raw : 'documents';
}

export default function LibraryPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const tab = libraryTab(params.get('tab'));
  const current = TABS.find((t) => t.tab === tab)!;
  const openDoc = Number(params.get('document')) || null;
  const [adding, setAdding] = useState(false);

  return (
    <KnowledgeLayout testId="page-library">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-eyebrow">Library</p>
          <h1 className="oo-h1">{current.label}</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>{current.line}</p>
        </div>
        <button type="button" className="oo-btn oo-btn-ink" onClick={() => setAdding(true)} data-testid={current.addTestId}>
          {current.add}
        </button>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Library" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {TABS.map((t) => (
            <button
              key={t.tab}
              type="button"
              role="tab"
              className="oo-tab"
              aria-selected={t.tab === tab}
              onClick={() => navigate(t.tab === 'documents' ? '/knowledge/library' : '/knowledge/library?tab=' + t.tab, { replace: true })}
              data-testid={'tab-library-' + t.tab}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={current.label} style={{ marginTop: -10 }}>
        {tab === 'documents' ? <DocumentsTab openId={openDoc} onCloseDoc={() => navigate('/knowledge/library', { replace: true })} /> : tab === 'rules' ? <RulesTab /> : <PlaybooksTab />}
      </div>

      {adding && tab === 'documents' && <DocumentDialog onClose={() => setAdding(false)} />}
      {adding && tab === 'rules' && <RuleDialog onClose={() => setAdding(false)} />}
      {adding && tab === 'playbooks' && <PlaybookDialog onClose={() => setAdding(false)} />}
    </KnowledgeLayout>
  );
}

/* ---------- Documents ---------- */

function DocumentsTab({ openId, onCloseDoc }: { openId: number | null; onCloseDoc: () => void }) {
  const [watching, setWatching] = useState(false);
  // While a document is waiting or being read, check every few seconds so its line updates.
  const q = useListDocuments(undefined, { query: { refetchInterval: watching ? 4000 : false } as never });
  useEffect(() => {
    setWatching(!!q.data?.some((d) => d.knowledge && (d.knowledge.status === 'queued' || d.knowledge.status === 'reading')));
  }, [q.data]);
  const [editing, setEditing] = useState<LibraryDocument | null>(null);
  const opened = openId ? q.data?.find((d) => d.id === openId) ?? null : null;
  const current = editing ?? opened;

  useEffect(() => {
    if (!opened) return;
    document.getElementById('doc-row-' + opened.id)?.scrollIntoView({ block: 'center' });
  }, [opened]);

  if (q.isLoading) return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={48} />)}</div>;
  if (!q.data) return <PageProblem notFound={false} what="list" onRetry={() => q.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {q.data.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '16px 0' }} data-testid="state-documents-empty">
          No documents yet. Add a link, paste text or upload a file with Add a document.
        </p>
      ) : (
        <>
          <div className="oo-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="oo-table oo-table-light" data-testid="table-documents">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Where it lives</th>
                  <th scope="col">Project</th>
                  <th scope="col">Updated</th>
                  <th scope="col"><span className="oo-sr">Edit</span></th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((d) => (
                  <tr key={d.id} id={'doc-row-' + d.id} className="oo-doc" data-highlight={d.id === openId} data-testid={'row-document-' + d.id}>
                    <td style={{ maxWidth: 420 }}><DocTitle d={d} /></td>
                    <td><span className="oo-loc" data-loc={d.location}>{DOC_LOCATION_LABELS[d.location]}</span></td>
                    <td><DocProjects d={d} /></td>
                    <td className="oo-num" style={{ whiteSpace: 'nowrap' }}>{formatDayMonthShort(d.lastConfirmedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={() => setEditing(d)} aria-label={`Edit ${d.title}`} data-testid={'button-edit-document-' + d.id}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="oo-cards">
            {q.data.map((d) => (
              <div key={d.id} className="oo-card-row oo-doc" style={{ flexDirection: 'column', gap: 6 }} data-highlight={d.id === openId} data-testid={'card-document-' + d.id}>
                <DocTitle d={d} />
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span className="oo-loc" data-loc={d.location}>{DOC_LOCATION_LABELS[d.location]}</span>
                  <DocProjects d={d} />
                  <span className="oo-muted">Updated {formatDayMonthShort(d.lastConfirmedAt)}</span>
                </span>
                <div><button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" onClick={() => setEditing(d)}>Edit</button></div>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }} data-testid="text-library-footnote">
        OllieOS keeps links and summaries, and the text of documents you paste or upload, never the files. Confidential documents, and documents on confidential projects, are hidden from AI and never read for knowledge. Updated is when you or the sweep last confirmed the document, not the file’s own date.
      </p>
      {current && (
        <DocumentDialog
          doc={current}
          onClose={() => {
            setEditing(null);
            if (opened) onCloseDoc();
          }}
        />
      )}
    </div>
  );
}

const KEPT_WORDS: Record<string, string> = {
  pasted: 'Pasted',
  upload: 'Uploaded',
  claude: 'Saved by Claude',
  email: 'From an email',
};

function DocTitle({ d }: { d: LibraryDocument }) {
  const kept = d.textOrigin ? KEPT_WORDS[d.textOrigin] : undefined;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {d.url ? (
          <a href={d.url} target="_blank" rel="noreferrer" className="oo-krow-link" style={{ fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }} data-testid={'link-document-' + d.id}>
            {d.title}
            <IconArrowOut size={12} style={{ flex: 'none' }} aria-hidden="true" />
            <span className="oo-sr"> (opens in a new tab)</span>
          </a>
        ) : (
          <span style={{ fontWeight: 500 }} data-testid={'text-document-title-' + d.id}>{d.title}</span>
        )}
        {d.hiddenFromAi && <HiddenFromAi confidential={d.confidential === true} />}
      </span>
      {d.summary && <span className="oo-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{d.summary}</span>}
      {kept ? (
        <span className="oo-muted" style={{ fontSize: 12 }} data-testid={'text-contents-read-' + d.id}>{kept} {d.contentsReadAt ? formatDayMonthShort(d.contentsReadAt) : ''}, text kept in OllieOS</span>
      ) : (
        d.contentsReadAt && <span className="oo-muted" style={{ fontSize: 12 }} data-testid={'text-contents-read-' + d.id}>OllieOS read the contents {formatDayMonthShort(d.contentsReadAt)}</span>
      )}
      <KnowledgeLine d={d} />
    </span>
  );
}

/** Where reading this document for knowledge has got, and the button to start or repeat it. */
function KnowledgeLine({ d }: { d: LibraryDocument }) {
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState(false);
  if (d.hiddenFromAi) return null;
  const k = d.knowledge;
  const waiting = k?.status === 'queued' || k?.status === 'reading';
  let line: string | null = null;
  if (k?.status === 'queued') line = 'Waiting to be read for knowledge';
  else if (k?.status === 'reading') line = 'Reading for knowledge…';
  else if (k?.status === 'failed') line = k.error ?? 'Could not be read for knowledge';
  else if (k?.lastReadAt) line = `Read for knowledge ${formatDayMonthShort(k.lastReadAt)}: ${k.lastResult ?? 'nothing new'}`;
  const found = k?.status === 'idle' && !!k.lastResult && k.lastResult !== 'nothing new';

  const start = async () => {
    setBusy(true);
    await write(() => buildDocumentKnowledge(d.id), { done: 'Reading it for knowledge now', fail: 'Could not start reading it' });
    setBusy(false);
  };

  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, fontSize: 12 }} data-testid={'knowledge-document-' + d.id}>
      {line && (
        <span role="status" className={k?.status === 'failed' ? undefined : 'oo-muted'} style={k?.status === 'failed' ? { color: 'var(--oo-danger)' } : undefined} data-testid={'text-knowledge-' + d.id}>
          {line}
        </span>
      )}
      {found && <Link href="/knowledge/inbox?from=documents" className="oo-krow-link" style={{ fontSize: 12 }} data-testid={'link-knowledge-inbox-' + d.id}>Review in the Knowledge Inbox</Link>}
      {!waiting && (
        <button type="button" className="oo-textbtn" style={{ fontSize: 12 }} disabled={busy} onClick={start} data-testid={'button-build-knowledge-' + d.id}>
          {k?.lastReadAt ? 'Read again for changes' : k?.status === 'failed' ? 'Try again' : 'Build knowledge from this'}
        </button>
      )}
    </span>
  );
}

function DocProjects({ d }: { d: LibraryDocument }) {
  if (!d.projects.length) return <span className="oo-muted">None</span>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      {d.projects.map((p) => <Link key={p.id} href={'/knowledge/projects/' + p.slug} className="oo-krow-link">{p.name}</Link>)}
    </span>
  );
}

/* ---------- Rules ---------- */

function RulesTab() {
  const q = useListRules();
  if (q.isLoading) return <div aria-busy="true" className="oo-kgrid" style={{ paddingTop: 12 }}>{[0, 1, 2, 3].map((i) => <Skel key={i} h={200} />)}</div>;
  if (!q.data) return <PageProblem notFound={false} what="list" onRetry={() => q.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />;
  if (!q.data.length) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '16px 0' }} data-testid="state-rules-empty">No rules yet. Add the rules you find yourself repeating to Claude.</p>;
  }
  return (
    <div className="oo-kgrid" style={{ paddingTop: 16 }} data-testid="list-rules">
      {q.data.map((p) => <RuleCard key={p.id} p={p} />)}
    </div>
  );
}

export function RuleCard({ p, compact }: { p: Rule; compact?: boolean }) {
  const write = useKnowledgeWrite();
  const save = async (patch: RuleUpdate, done?: string) => (await write(() => updateRule(p.id, patch), { done })) ?? false;
  const scope = [...p.projects, ...p.organisations, ...(p.products ?? [])];
  // Part L: rules no AI has used in 90 days are marked so they can be paused or removed.
  const unused = useListUnusedRulesAndPlaybooks({ query: { staleTime: 300_000 } });

  return (
    <article className="oo-kcard oo-rule" data-enabled={p.enabled} aria-labelledby={`pb-${p.id}-title`} data-testid={'card-rule-' + p.id}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <h3 id={`pb-${p.id}-title`} style={{ margin: 0, fontSize: 16, fontWeight: 600, minWidth: 0 }}>
          {compact ? p.title : <InlineText value={p.title} label="Rule title" required maxLength={200} testId={`rule-${p.id}-title`} onSave={(v) => save({ title: v ?? p.title })} />}
        </h3>
        <button
          type="button"
          role="switch"
          className="oo-switch"
          aria-checked={p.enabled}
          aria-label={`Claude follows ${p.title}`}
          title={`Claude follows ${p.title}`}
          onClick={() => save({ enabled: !p.enabled }, p.enabled ? `Paused. No AI sees ${p.title} now.` : `${p.title} is on again`)}
          data-testid={`switch-rule-${p.id}`}
        />
      </div>
      <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
        <span className="oo-muted">Applies when: </span>
        {compact ? p.appliesWhen : <InlineText inline value={p.appliesWhen} label="Applies when" required maxLength={300} testId={`rule-${p.id}-applies`} onSave={(v) => save({ appliesWhen: v ?? p.appliesWhen })} />}
      </p>
      <div className="oo-rule-rule">
        {compact ? p.rule : <InlineText value={p.rule} label="Rule" multiline required maxLength={RULE_MAX} testId={`rule-${p.id}-rule`} onSave={(v) => save({ rule: v ?? p.rule })} />}
      </div>
      {scope.length > 0 && (
        <span className="oo-muted" style={{ fontSize: 12 }}>Only for {scope.map((s) => s.name).join(', ')}</span>
      )}
      <span className="oo-rule-state" data-enabled={p.sentToAi} role="status" data-testid={`text-rule-${p.id}-state`}>
        {!p.enabled ? 'Paused: Claude ignores this' : p.sentToAi ? 'Claude reads this before drafting' : 'Linked only to items hidden from AI, so no AI sees it'}
      </span>
      {p.outOfDate && <span><OutOfDateMark testId={`mark-out-of-date-rule-${p.id}`} /></span>}
      {unused.data?.rules.includes(p.id) && <span><span className="oo-pill" data-tone="stale" data-testid={`pill-unused-rule-${p.id}`}>Not used in 90 days</span></span>}
    </article>
  );
}

export function RuleDialog({ presetProjectId, presetProductId, onClose }: { presetProjectId?: number; presetProductId?: number; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const projects = useListProjects();
  const orgs = useListOrganisations();
  const products = useListProducts();
  const [productIds, setProductIds] = useState<number[]>(presetProductId ? [presetProductId] : []);
  const [title, setTitle] = useState('');
  const [appliesWhen, setAppliesWhen] = useState('');
  const [rule, setRule] = useState('');
  const [projectIds, setProjectIds] = useState<number[]>(presetProjectId ? [presetProjectId] : []);
  const [organisationIds, setOrganisationIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const ruleLen = rule.trim().length;
  const valid = !!title.trim() && !!appliesWhen.trim() && ruleLen > 0 && ruleLen <= RULE_MAX;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = await write(
      () => createRule({ title: title.trim(), appliesWhen: appliesWhen.trim(), rule: rule.trim(), projectIds, organisationIds, productIds }),
      { done: 'Rule added and switched on', fail: 'Could not add that rule' },
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 560 }} aria-describedby="pb-desc" data-testid="dialog-new-rule">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>New rule</Dialog.Title>
            <p id="pb-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              A short rule every AI tool reads before drafting. With no projects, organisations or products it applies everywhere.
            </p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label>
                <span>Title</span>
                <input className="oo-input" required autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="House style for a client" data-testid="input-rule-title" />
              </label>
              <label>
                <span>Applies when</span>
                <input className="oo-input" required value={appliesWhen} maxLength={300} onChange={(e) => setAppliesWhen(e.target.value)} placeholder="Writing anything for or about that client" data-testid="input-rule-applies" />
              </label>
              <label>
                <span>Rule</span>
                <textarea className="oo-textarea" required rows={4} value={rule} onChange={(e) => setRule(e.target.value)} aria-describedby="pb-rule-count" data-testid="input-rule-rule" />
                <CharCount id="pb-rule-count" n={ruleLen} max={RULE_MAX} />
              </label>
              <MultiPick label="Projects" items={projects.data ?? []} value={projectIds} onChange={setProjectIds} testId="pick-rule-projects" />
              <MultiPick label="Organisations" items={orgs.data ?? []} value={organisationIds} onChange={setOrganisationIds} testId="pick-rule-organisations" />
              {(products.data?.length ?? 0) > 0 && <MultiPick label="Products" items={products.data ?? []} value={productIds} onChange={setProductIds} testId="pick-rule-products" />}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" data-testid="button-cancel-rule">Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={!valid || busy} data-testid="button-save-rule">{busy ? 'Saving…' : 'Add rule'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
