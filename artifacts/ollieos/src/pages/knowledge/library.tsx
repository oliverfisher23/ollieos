import { useEffect, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation, useSearch } from 'wouter';
import {
  createDocument,
  createPlaybook,
  updateDocument,
  updatePlaybook,
  useListDocuments,
  useListOrganisations,
  useListPlaybooks,
  useListProjects,
  type DocLocation,
  type LibraryDocument,
  type Playbook,
  type PlaybookUpdate,
} from '@workspace/api-client-react';
import { DOC_LOCATIONS, DOC_LOCATION_LABELS, PLAYBOOK_RULE_MAX, formatDayMonthShort } from '@workspace/shared';
import { CharCount, Skel } from '@/components/bits';
import { IconArrowOut } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { KnowledgeLayout } from '@/components/knowledge/layout';
import { HiddenFromAi, PageProblem, TriStateAccess } from '@/components/knowledge/parts';
import { useKnowledgeWrite } from '@/lib/knowledge';

type Tab = 'documents' | 'playbooks';

export default function LibraryPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const tab: Tab = params.get('tab') === 'playbooks' ? 'playbooks' : 'documents';
  const openDoc = Number(params.get('document')) || null;
  const [adding, setAdding] = useState(false);

  return (
    <KnowledgeLayout testId="page-library">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-eyebrow">Library</p>
          <h1 className="oo-h1">{tab === 'documents' ? 'Documents' : 'Playbooks'}</h1>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
            {tab === 'documents'
              ? 'Where the important files live, with a line on each, so you and Claude can find them. OllieOS keeps the link, never the file.'
              : 'Short rules every AI tool reads from OllieOS before drafting anything for you. Pause one and no AI sees it.'}
          </p>
        </div>
        <button type="button" className="oo-btn oo-btn-ink" onClick={() => setAdding(true)} data-testid={tab === 'documents' ? 'button-add-link' : 'button-new-playbook'}>
          {tab === 'documents' ? 'Add a link' : 'New playbook'}
        </button>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Library" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {(['documents', 'playbooks'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              className="oo-tab"
              aria-selected={t === tab}
              onClick={() => navigate(t === 'documents' ? '/knowledge/library' : '/knowledge/library?tab=playbooks', { replace: true })}
              data-testid={'tab-library-' + t}
            >
              {t === 'documents' ? 'Documents' : 'Playbooks'}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={tab === 'documents' ? 'Documents' : 'Playbooks'} style={{ marginTop: -10 }}>
        {tab === 'documents' ? <DocumentsTab openId={openDoc} onCloseDoc={() => navigate('/knowledge/library', { replace: true })} /> : <PlaybooksTab />}
      </div>

      {adding && tab === 'documents' && <DocumentDialog onClose={() => setAdding(false)} />}
      {adding && tab === 'playbooks' && <PlaybookDialog onClose={() => setAdding(false)} />}
    </KnowledgeLayout>
  );
}

/* ---------- Documents ---------- */

function DocumentsTab({ openId, onCloseDoc }: { openId: number | null; onCloseDoc: () => void }) {
  const q = useListDocuments();
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
          No documents yet. Paste a Dropbox, Google Drive or Claude project link with Add a link.
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
        OllieOS stores links and summaries only, never the files. Confidential documents, and documents on confidential projects, are hidden from AI. Updated is when you or the sweep last confirmed the link, not the file’s own date.
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

function DocTitle({ d }: { d: LibraryDocument }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <a href={d.url} target="_blank" rel="noreferrer" className="oo-krow-link" style={{ fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }} data-testid={'link-document-' + d.id}>
          {d.title}
          <IconArrowOut size={12} style={{ flex: 'none' }} aria-hidden="true" />
          <span className="oo-sr"> (opens in a new tab)</span>
        </a>
        {d.hiddenFromAi && <HiddenFromAi confidential={d.confidential === true} />}
      </span>
      {d.summary && <span className="oo-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{d.summary}</span>}
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

/** Adds a document from a pasted link, or edits one. Title and location fill from the link when left blank. */
export function DocumentDialog({ doc, presetProjectId, onClose }: { doc?: LibraryDocument; presetProjectId?: number; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const projects = useListProjects();
  const [url, setUrl] = useState(doc?.url ?? '');
  const [title, setTitle] = useState(doc?.title ?? '');
  const [summary, setSummary] = useState(doc?.summary ?? '');
  const [location, setLocation] = useState<DocLocation | ''>(doc?.location ?? '');
  const [projectIds, setProjectIds] = useState<number[]>(doc?.projects.map((p) => p.id) ?? (presetProjectId ? [presetProjectId] : []));
  const [confidential, setConfidential] = useState<boolean | null>(doc ? doc.confidential : null);
  const [busy, setBusy] = useState(false);
  const valid = url.trim().length > 0 && (!doc || title.trim().length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = doc
      ? await write(
          () => updateDocument(doc.id, { url: url.trim(), title: title.trim(), summary: summary.trim() || null, location: location || undefined, projectIds, confidential }),
          { done: 'Document saved', fail: 'Could not save that document' },
        )
      : await write(
          () => createDocument({ url: url.trim(), title: title.trim() || null, summary: summary.trim() || null, location: location || undefined, projectIds, confidential }),
          { done: 'Added to the Library', fail: 'Could not add that link' },
        );
    setBusy(false);
    if (ok) onClose();
  };

  const confirm = async () => {
    if (!doc || busy) return;
    setBusy(true);
    const ok = await write(() => updateDocument(doc.id, { confirm: true }), { done: 'Marked as still current' });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 560 }} aria-describedby="doc-desc" data-testid={doc ? 'dialog-edit-document' : 'dialog-add-link'}>
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{doc ? 'Edit document' : 'Add a link'}</Dialog.Title>
            <p id="doc-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              {doc ? `Updated ${formatDayMonthShort(doc.lastConfirmedAt)}. Added by ${doc.createdBy}.` : 'Paste a Dropbox, Google Drive or Claude project link. OllieOS fills the title and where it lives from the link; you can change both.'}
            </p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label>
                <span>Link</span>
                <input className="oo-input" type="url" inputMode="url" required autoFocus={!doc} value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.dropbox.com/…" data-testid="input-document-url" />
              </label>
              <label>
                <span>Title{doc ? '' : <span className="oo-muted"> (optional, taken from the link)</span>}</span>
                <input className="oo-input" value={title} maxLength={300} required={!!doc} onChange={(e) => setTitle(e.target.value)} data-testid="input-document-title" />
              </label>
              <label>
                <span>Summary <span className="oo-muted">(one line on what it is)</span></span>
                <textarea className="oo-textarea" rows={2} value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} data-testid="input-document-summary" />
              </label>
              <label>
                <span>Where it lives</span>
                <select className="oo-input" value={location} onChange={(e) => setLocation(e.target.value as DocLocation | '')} data-testid="select-document-location">
                  {!doc && <option value="">Work it out from the link</option>}
                  {DOC_LOCATIONS.map((l) => <option key={l} value={l}>{DOC_LOCATION_LABELS[l]}</option>)}
                </select>
              </label>
              <MultiPick label="Projects" items={projects.data ?? []} value={projectIds} onChange={setProjectIds} testId="pick-document-projects" />
              <TriStateAccess wide value={confidential} hidden={false} parent="its projects" onChange={setConfidential} testId="document-access" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                {doc && (
                  <button type="button" className="oo-btn oo-btn-quiet" style={{ marginRight: 'auto' }} disabled={busy} onClick={confirm} data-testid="button-confirm-document">Still current</button>
                )}
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" data-testid="button-cancel-document">Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={!valid || busy} data-testid="button-save-document">{busy ? 'Saving…' : doc ? 'Save' : 'Add link'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A checkbox list for linking to several projects or organisations. */
function MultiPick({ label, items, value, onChange, testId }: { label: string; items: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void; testId: string }) {
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }} data-testid={testId}>
      <legend style={{ padding: 0, marginBottom: 6 }}>{label} <span className="oo-muted">(optional)</span></legend>
      {items.length === 0 ? (
        <span className="oo-muted">None to choose from yet.</span>
      ) : (
        <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, border: '1px solid var(--oo-line)', borderRadius: 'var(--oo-r-input)', padding: '6px 10px' }}>
          {items.map((it) => (
            <label key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={value.includes(it.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))}
                data-testid={`${testId}-${it.id}`}
              />
              <span>{it.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/* ---------- Playbooks ---------- */

function PlaybooksTab() {
  const q = useListPlaybooks();
  if (q.isLoading) return <div aria-busy="true" className="oo-kgrid" style={{ paddingTop: 12 }}>{[0, 1, 2, 3].map((i) => <Skel key={i} h={200} />)}</div>;
  if (!q.data) return <PageProblem notFound={false} what="list" onRetry={() => q.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />;
  if (!q.data.length) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 14, padding: '16px 0' }} data-testid="state-playbooks-empty">No playbooks yet. Add the rules you find yourself repeating to Claude.</p>;
  }
  return (
    <div className="oo-kgrid" style={{ paddingTop: 16 }} data-testid="list-playbooks">
      {q.data.map((p) => <PlaybookCard key={p.id} p={p} />)}
    </div>
  );
}

export function PlaybookCard({ p, compact }: { p: Playbook; compact?: boolean }) {
  const write = useKnowledgeWrite();
  const save = async (patch: PlaybookUpdate, done?: string) => (await write(() => updatePlaybook(p.id, patch), { done })) ?? false;
  const scope = [...p.projects, ...p.organisations];

  return (
    <article className="oo-kcard oo-playbook" data-enabled={p.enabled} aria-labelledby={`pb-${p.id}-title`} data-testid={'card-playbook-' + p.id}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <h3 id={`pb-${p.id}-title`} style={{ margin: 0, fontSize: 16, fontWeight: 600, minWidth: 0 }}>
          {compact ? p.title : <InlineText value={p.title} label="Playbook title" required maxLength={200} testId={`playbook-${p.id}-title`} onSave={(v) => save({ title: v ?? p.title })} />}
        </h3>
        <button
          type="button"
          role="switch"
          className="oo-switch"
          aria-checked={p.enabled}
          aria-label={`Claude follows ${p.title}`}
          title={`Claude follows ${p.title}`}
          onClick={() => save({ enabled: !p.enabled }, p.enabled ? `Paused. No AI sees ${p.title} now.` : `${p.title} is on again`)}
          data-testid={`switch-playbook-${p.id}`}
        />
      </div>
      <p style={{ margin: 0, fontSize: 13 }} className="oo-soft">
        <span className="oo-muted">Applies when: </span>
        {compact ? p.appliesWhen : <InlineText inline value={p.appliesWhen} label="Applies when" required maxLength={300} testId={`playbook-${p.id}-applies`} onSave={(v) => save({ appliesWhen: v ?? p.appliesWhen })} />}
      </p>
      <div className="oo-playbook-rule">
        {compact ? p.rule : <InlineText value={p.rule} label="Rule" multiline required maxLength={PLAYBOOK_RULE_MAX} testId={`playbook-${p.id}-rule`} onSave={(v) => save({ rule: v ?? p.rule })} />}
      </div>
      {scope.length > 0 && (
        <span className="oo-muted" style={{ fontSize: 12 }}>Only for {scope.map((s) => s.name).join(', ')}</span>
      )}
      <span className="oo-playbook-state" data-enabled={p.sentToAi} role="status" data-testid={`text-playbook-${p.id}-state`}>
        {!p.enabled ? 'Paused: Claude ignores this' : p.sentToAi ? 'Claude reads this before drafting' : 'Linked only to items hidden from AI, so no AI sees it'}
      </span>
    </article>
  );
}

export function PlaybookDialog({ presetProjectId, onClose }: { presetProjectId?: number; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const projects = useListProjects();
  const orgs = useListOrganisations();
  const [title, setTitle] = useState('');
  const [appliesWhen, setAppliesWhen] = useState('');
  const [rule, setRule] = useState('');
  const [projectIds, setProjectIds] = useState<number[]>(presetProjectId ? [presetProjectId] : []);
  const [organisationIds, setOrganisationIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const ruleLen = rule.trim().length;
  const valid = !!title.trim() && !!appliesWhen.trim() && ruleLen > 0 && ruleLen <= PLAYBOOK_RULE_MAX;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = await write(
      () => createPlaybook({ title: title.trim(), appliesWhen: appliesWhen.trim(), rule: rule.trim(), projectIds, organisationIds }),
      { done: 'Playbook added and switched on', fail: 'Could not add that playbook' },
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 560 }} aria-describedby="pb-desc" data-testid="dialog-new-playbook">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>New playbook</Dialog.Title>
            <p id="pb-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              A short rule every AI tool reads before drafting. With no projects or organisations it applies everywhere.
            </p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label>
                <span>Title</span>
                <input className="oo-input" required autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="PwC terminology" data-testid="input-playbook-title" />
              </label>
              <label>
                <span>Applies when</span>
                <input className="oo-input" required value={appliesWhen} maxLength={300} onChange={(e) => setAppliesWhen(e.target.value)} placeholder="Writing anything for or about PwC" data-testid="input-playbook-applies" />
              </label>
              <label>
                <span>Rule</span>
                <textarea className="oo-textarea" required rows={4} value={rule} onChange={(e) => setRule(e.target.value)} aria-describedby="pb-rule-count" data-testid="input-playbook-rule" />
                <CharCount id="pb-rule-count" n={ruleLen} max={PLAYBOOK_RULE_MAX} />
              </label>
              <MultiPick label="Projects" items={projects.data ?? []} value={projectIds} onChange={setProjectIds} testId="pick-playbook-projects" />
              <MultiPick label="Organisations" items={orgs.data ?? []} value={organisationIds} onChange={setOrganisationIds} testId="pick-playbook-organisations" />
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
