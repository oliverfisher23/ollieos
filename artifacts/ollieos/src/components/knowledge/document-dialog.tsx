import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  buildDocumentKnowledge,
  createDocument,
  createTextDocument,
  importDriveDocuments,
  updateDocument,
  uploadDocument,
  useListProjects,
  type DocLocation,
  type LibraryDocument,
} from '@workspace/api-client-react';
import { DOC_LOCATIONS, DOC_LOCATION_LABELS, formatDayMonthShort } from '@workspace/shared';
import { TriStateAccess } from '@/components/knowledge/parts';
import { Dropdown } from '@/components/dropdown';
import { useKnowledgeWrite } from '@/lib/knowledge';
import { notify } from '@/lib/notify';

type Mode = 'link' | 'text' | 'file';

const MODES: { id: Mode; label: string }[] = [
  { id: 'link', label: 'Link' },
  { id: 'text', label: 'Paste text' },
  { id: 'file', label: 'Upload a file' },
];

const MAX_FILE_MB = 15;
const ACCEPT = '.md,.markdown,.txt,.docx,.pdf';

/** A Google Drive folder link, which adds every readable file in it. */
const isDriveFolder = (link: string) => /^https?:\/\/(www\.)?drive\.google\.com\/.*\/folders\/[\w-]{10,}/.test(link.trim());

const ORIGIN_WORDS: Record<string, string> = {
  pasted: 'Text pasted into OllieOS',
  upload: 'Text from an uploaded file',
  claude: 'Saved by Claude',
  gdrive: 'Text read from Google Drive',
  dropbox: 'Text read from Dropbox',
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });
}

/**
 * Adds a document to the Library from a link, pasted text or an uploaded file, or edits one.
 * "Build knowledge from this" reads it in the background and sends what it finds to the
 * Knowledge Inbox.
 */
export function DocumentDialog({ doc, presetProjectId, onClose }: { doc?: LibraryDocument; presetProjectId?: number; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const projects = useListProjects();
  const [mode, setMode] = useState<Mode>('link');
  const [url, setUrl] = useState(doc?.url ?? '');
  const [title, setTitle] = useState(doc?.title ?? '');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState(doc?.summary ?? '');
  const [location, setLocation] = useState<DocLocation | ''>(doc?.location ?? '');
  const [projectIds, setProjectIds] = useState<number[]>(doc?.projects.map((p) => p.id) ?? (presetProjectId ? [presetProjectId] : []));
  const [confidential, setConfidential] = useState<boolean | null>(doc ? doc.confidential : null);
  const [build, setBuild] = useState(true);
  const [busy, setBusy] = useState(false);

  const kept = !!doc && doc.url == null;
  const folder = !doc && mode === 'link' && isDriveFolder(url);
  const tooBig = !!file && file.size > MAX_FILE_MB * 1024 * 1024;
  const valid = doc
    ? title.trim().length > 0 && (kept || url.trim().length > 0)
    : mode === 'link'
      ? url.trim().length > 0
      : mode === 'text'
        ? title.trim().length > 0 && text.trim().length > 0
        : !!file && !tooBig;

  const add = async (): Promise<boolean> => {
    const common = { summary: summary.trim() || null, projectIds, confidential };
    if (mode === 'link' && folder) {
      const r = await write(() => importDriveDocuments({ url: url.trim() }), { fail: 'Could not add that folder' });
      if (!r) return false;
      const parts = [`${r.added} added`, r.alreadyThere ? `${r.alreadyThere} already in the Library` : null, r.skipped ? `${r.skipped} OllieOS cannot read` : null].filter(Boolean);
      notify(`${r.folder ?? 'Folder'}: ${parts.join(', ')}. Reading each for knowledge.`);
      return true;
    }
    if (mode === 'link') {
      const d = await write(() => createDocument({ url: url.trim(), title: title.trim() || null, location: location || undefined, ...common }), { fail: 'Could not add that link' });
      if (!d) return false;
      if (build) await write(() => buildDocumentKnowledge(d.id), { done: 'Added. Reading it for knowledge now.', fail: 'Added, but it could not be read for knowledge' });
      else notify('Added to the Library');
      return true;
    }
    if (mode === 'text') {
      const d = await write(() => createTextDocument({ title: title.trim(), text, buildKnowledge: build, ...common }), {
        done: build ? 'Kept in the Library. Reading it for knowledge now.' : 'Kept in the Library',
        fail: 'Could not keep that text',
      });
      return !!d;
    }
    const f = file!;
    const data = await readAsBase64(f).catch(() => null);
    if (!data) {
      notify('Could not upload that file', 'It could not be read on this device.');
      return false;
    }
    const d = await write(() => uploadDocument({ fileName: f.name, dataBase64: data, title: title.trim() || null, buildKnowledge: build, ...common }), {
      done: build ? 'Kept in the Library. Reading it for knowledge now.' : 'Kept in the Library',
      fail: 'Could not upload that file',
    });
    return !!d;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = doc
      ? !!(await write(
          () =>
            updateDocument(doc.id, {
              ...(kept ? {} : { url: url.trim(), location: location || undefined }),
              title: title.trim(),
              summary: summary.trim() || null,
              projectIds,
              confidential,
            }),
          { done: 'Document saved', fail: 'Could not save that document' },
        ))
      : await add();
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

  const description = doc
    ? `Updated ${formatDayMonthShort(doc.lastConfirmedAt)}. Added by ${doc.createdBy}.${kept && doc.textOrigin ? ` ${ORIGIN_WORDS[doc.textOrigin] ?? ''}.` : ''}`
    : mode === 'link'
      ? 'Paste a Dropbox, Google Drive or Claude project link, or a Drive folder to add every file in it. OllieOS fills the title and where it lives from the link.'
      : mode === 'text'
        ? 'Paste notes, a transcript or anything else. OllieOS keeps the text, so it can read it for knowledge.'
        : `A Markdown, text, Word (.docx) or PDF file up to ${MAX_FILE_MB} MB. OllieOS keeps its text, not the file.`;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 580 }} aria-describedby="doc-desc" data-testid={doc ? 'dialog-edit-document' : 'dialog-add-document'}>
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{doc ? 'Edit document' : 'Add a document'}</Dialog.Title>
            {!doc && (
              <div role="tablist" aria-label="How to add it" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)' }}>
                {MODES.map((m) => (
                  <button key={m.id} type="button" role="tab" className="oo-tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)} data-testid={'tab-add-document-' + m.id}>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            <p id="doc-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>{description}</p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(doc ? !kept : mode === 'link') && (
                <label>
                  <span>Link</span>
                  <input className="oo-input" type="url" inputMode="url" required autoFocus={!doc} value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.dropbox.com/…" data-testid="input-document-url" />
                </label>
              )}
              {!doc && mode === 'file' && (
                <label>
                  <span>File</span>
                  <input className="oo-input" type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="input-document-file" />
                  {tooBig && <span role="alert" style={{ fontSize: 13, color: 'var(--oo-danger)' }}>That file is larger than {MAX_FILE_MB} MB.</span>}
                </label>
              )}
              {folder ? (
                <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid="text-drive-folder">
                  This is a Drive folder. OllieOS adds each file in it that it can read (up to 100, not subfolders), once, and reads each for knowledge. You can add summaries and projects to each afterwards.
                </p>
              ) : (
                <>
                  <label>
                    <span>
                      Title
                      {!doc && mode === 'link' && <span className="oo-muted"> (optional, taken from the link)</span>}
                      {!doc && mode === 'file' && <span className="oo-muted"> (optional, taken from the file name)</span>}
                    </span>
                    <input className="oo-input" value={title} maxLength={300} required={!!doc || mode === 'text'} autoFocus={!doc && mode === 'text'} onChange={(e) => setTitle(e.target.value)} data-testid="input-document-title" />
                  </label>
                  {!doc && mode === 'text' && (
                    <label>
                      <span>Text</span>
                      <textarea className="oo-textarea" required rows={8} value={text} maxLength={400000} onChange={(e) => setText(e.target.value)} data-testid="input-document-text" />
                    </label>
                  )}
                  <label>
                    <span>Summary <span className="oo-muted">(one line on what it is)</span></span>
                    <textarea className="oo-textarea" rows={2} value={summary} maxLength={2000} onChange={(e) => setSummary(e.target.value)} data-testid="input-document-summary" />
                  </label>
                  {(doc ? !kept : mode === 'link') && (
                    <div className="oo-dd-field">
                      <label htmlFor="document-location">Where it lives</label>
                      <Dropdown
                        id="document-location"
                        value={location}
                        onChange={(v) => setLocation(v as DocLocation | '')}
                        options={[
                          ...(doc ? [] : [{ value: '', label: 'Work it out from the link' }]),
                          ...DOC_LOCATIONS.filter((l) => l !== 'ollieos').map((l) => ({ value: l, label: DOC_LOCATION_LABELS[l] })),
                        ]}
                        testId="select-document-location"
                      />
                    </div>
                  )}
                  <MultiPick label="Projects" items={projects.data ?? []} value={projectIds} onChange={setProjectIds} testId="pick-document-projects" />
                  <TriStateAccess wide value={confidential} hidden={false} parent="its projects" onChange={setConfidential} testId="document-access" />
                </>
              )}
              {!doc && !folder && (
                <label style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} style={{ marginTop: 3 }} data-testid="checkbox-build-knowledge" />
                  <span>
                    Build knowledge from this
                    <span className="oo-muted" style={{ display: 'block' }}>Facts, decisions, people and playbooks it finds go to your Knowledge Inbox to approve. Not for documents hidden from AI.</span>
                  </span>
                </label>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                {doc && (
                  <button type="button" className="oo-btn oo-btn-quiet" style={{ marginRight: 'auto' }} disabled={busy} onClick={confirm} data-testid="button-confirm-document">Still current</button>
                )}
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" data-testid="button-cancel-document">Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={!valid || busy} data-testid="button-save-document">
                  {busy ? 'Saving…' : doc ? 'Save' : folder ? 'Add the folder' : mode === 'link' ? 'Add link' : 'Add document'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A checkbox list for linking to several projects or organisations. */
export function MultiPick({ label, items, value, onChange, testId }: { label: string; items: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void; testId: string }) {
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
