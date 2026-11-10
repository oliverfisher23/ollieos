import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import {
  checkConnector,
  previewDropboxFolder,
  retryDropboxFiles,
  setDropboxFolder,
  type ConnectorService,
  type DropboxFolderInputExisting,
  type DropboxFolderPreview,
  type DropboxSetup,
} from '@workspace/api-client-react';
import { whenLabel } from '@/lib/access';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';
import { RecentRuns, plural, runLine, useConnectorsCache } from './settings-connectors';

/** Roughly what reading one file for knowledge costs in Replit credits, from the trial run. */
const PENCE_PER_FILE = 2;

function costLine(files: number): string {
  const pence = files * PENCE_PER_FILE;
  return pence < 100 ? `under £1` : `about £${Math.round(pence / 100)}`;
}

/**
 * Claude's folder in Dropbox. OllieOS lists it on each check, read-only, and reads new and changed
 * files for knowledge. Nothing from Dropbox joins the Library; suggestions go to the Knowledge Inbox.
 */
export function DropboxCard({ s, setup }: { s: ConnectorService; setup: DropboxSetup }) {
  const cache = useConnectorsCache();
  const [editing, setEditing] = useState(setup.folder == null);
  const [busy, setBusy] = useState<'check' | 'retry' | null>(null);
  const last = s.runs[0];
  const p = setup.progress;
  const working = p.waiting + p.reading > 0;

  useEffect(() => {
    if (setup.folder == null) setEditing(true);
  }, [setup.folder]);

  const st = setup.folder == null
    ? { label: 'Choose a folder', tone: 'waiting' }
    : last && !last.ok
      ? { label: 'Needs attention', tone: 'high' }
      : working
        ? { label: 'Reading files', tone: 'waiting' }
        : { label: 'Working', tone: 'done' };

  const check = async () => {
    setBusy('check');
    try {
      const r = await checkConnector(s.key);
      if (r.ok) notify('Dropbox checked', r.found ? `Looked at ${plural(r.found, 'file')}. New and changed ones are being read for knowledge.` : 'Nothing to read.');
      else notify('Dropbox check failed', r.error ?? 'Something went wrong.');
    } catch (err) {
      reportApiError(err);
      notify('That check did not run', errorMessage(err));
    } finally {
      await cache.refreshAll();
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy('retry');
    try {
      cache.put(await retryDropboxFiles());
      notify('Trying those files again');
    } catch (err) {
      reportApiError(err);
      notify('That did not start', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="oo-source" style={{ gap: 10, padding: '16px 18px' }} aria-labelledby="con-dropbox-h" data-testid="card-connector-dropbox">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 id="con-dropbox-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{s.name}</h3>
        <span className="oo-pill" data-tone={st.tone} data-testid="status-connector-dropbox">{st.label}</span>
        {s.account && <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-connector-account-dropbox">{s.account}</span>}
      </div>
      <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
        Claude’s folder in your Dropbox. New and changed Markdown, text, Word and PDF files are read for knowledge: facts, decisions, people, organisations and rules go to your Knowledge Inbox for you to approve. For a changed file only what changed is read. Files stay in Dropbox and are not added to your Library.
      </p>
      <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }} data-testid="text-connector-ai-dropbox">
        Read-only: OllieOS never adds, moves or changes anything in Dropbox. Files are read by Claude Sonnet through Replit, billed to your Replit credits, roughly {PENCE_PER_FILE}p a file. Files about a company sale, the board, pay or HR only bring decisions, and those are marked confidential.
      </p>

      {editing ? (
        <FolderForm setup={setup} onDone={() => setEditing(false)} onCancel={setup.folder ? () => setEditing(false) : undefined} />
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span><span className="oo-muted">Folder: </span><span style={{ fontWeight: 500 }} data-testid="text-dropbox-folder">{setup.folder}</span></span>
            <button type="button" className="oo-textbtn" onClick={() => setEditing(true)} data-testid="button-change-dropbox-folder">Change</button>
          </p>
          <Progress setup={setup} busy={busy === 'retry'} onRetry={retry} />
          {last && (
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: last.ok ? undefined : 'var(--oo-danger)' }} data-testid="text-connector-last-dropbox">
              <span className="oo-muted">Last check {whenLabel(last.startedAt)}{last.trigger === 'manual' ? ' (by you)' : ''}: </span>
              {runLine(s.key, last)}
            </p>
          )}
          {last && !last.ok && (
            <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} data-testid="text-connector-fix-dropbox">
              If this keeps happening, reconnect Dropbox in Replit under Integrations, then press Check now.
            </p>
          )}
          {!last && <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Not checked yet. Press Check now, or wait for the timer.</p>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={check} data-testid="button-check-dropbox">
              {busy === 'check' ? 'Checking…' : 'Check now'}
            </button>
          </div>
          {s.runs.length > 1 && <RecentRuns runs={s.runs} keyName={s.key} />}
        </>
      )}
    </article>
  );
}

function Progress({ setup, busy, onRetry }: { setup: DropboxSetup; busy: boolean; onRetry: () => void }) {
  const p = setup.progress;
  if (!setup.listed) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-dropbox-progress">OllieOS lists the folder on the next check.</p>;
  }
  const parts = [
    `${plural(p.read, 'file')} read for knowledge`,
    p.waiting ? `${p.waiting} waiting` : '',
    p.reading ? `${p.reading} being read now` : '',
  ].filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }} data-testid="text-dropbox-progress">
      <span role="status">
        {parts.join(', ')}
        {p.lastReadAt ? <span className="oo-muted">. Last read {whenLabel(p.lastReadAt)}</span> : null}.{' '}
        {p.read > 0 && <Link href="/knowledge/inbox?from=documents" className="oo-krow-link" data-testid="link-dropbox-inbox">Review in the Knowledge Inbox</Link>}
      </span>
      {setup.existing === 'new' && p.read + p.waiting + p.reading + p.failed === 0 && (
        <span className="oo-muted">Files already in the folder were left as they are. Only files added or changed from now on are read.</span>
      )}
      {p.failed > 0 && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ color: 'var(--oo-danger)' }} data-testid="text-dropbox-failed">{plural(p.failed, 'file')} could not be read.</span>
          <button type="button" className="oo-textbtn" disabled={busy} onClick={onRetry} data-testid="button-dropbox-retry">
            {busy ? 'Starting…' : 'Try the failed ones again'}
          </button>
        </span>
      )}
    </div>
  );
}

function FolderForm({ setup, onDone, onCancel }: { setup: DropboxSetup; onDone: () => void; onCancel?: () => void }) {
  const cache = useConnectorsCache();
  const [folder, setFolder] = useState(setup.folder ?? '');
  const [existing, setExisting] = useState<DropboxFolderInputExisting>(setup.folder ? setup.existing : 'new');
  const [preview, setPreview] = useState<DropboxFolderPreview | null>(null);
  const [busy, setBusy] = useState<'look' | 'save' | null>(null);
  const looked = preview && preview.folder.toLowerCase() === normalise(folder).toLowerCase();

  const look = async () => {
    if (!folder.trim()) return;
    setBusy('look');
    try {
      setPreview(await previewDropboxFolder({ folder: folder.trim() }));
    } catch (err) {
      reportApiError(err);
      setPreview(null);
      notify('Could not open that folder', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!looked) return void look();
    setBusy('save');
    try {
      cache.put(await setDropboxFolder({ folder: folder.trim(), existing }));
      notify(
        'Dropbox folder saved',
        existing === 'all' ? 'OllieOS lists it now and reads each file for knowledge in the background.' : 'OllieOS lists it now. Files added or changed from here on are read for knowledge.',
      );
      onDone();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="form-dropbox-folder">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, flex: '1 1 260px' }}>
          <span className="oo-field-label">Folder in Dropbox</span>
          <input className="oo-input" required value={folder} maxLength={500} placeholder="/Folder/Subfolder" onChange={(e) => setFolder(e.target.value)} data-testid="input-dropbox-folder" />
        </label>
        <button type="button" className="oo-btn oo-btn-outline" disabled={!folder.trim() || busy !== null} onClick={look} data-testid="button-dropbox-look">
          {busy === 'look' ? 'Looking…' : 'Look in the folder'}
        </button>
      </div>

      {looked && preview && (
        <>
          <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} role="status" data-testid="text-dropbox-preview">
            {preview.folder} has {plural(preview.readable, 'file')} OllieOS can read
            {preview.other ? `, and ${preview.other} of other kinds it leaves alone` : ''}. Subfolders are included.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="oo-field-label" id="dropbox-existing-l">Files already there</span>
            <div role="group" aria-labelledby="dropbox-existing-l" className="oo-seg" style={{ maxWidth: 520 }}>
              <button type="button" aria-pressed={existing === 'all'} onClick={() => setExisting('all')} data-testid="button-dropbox-existing-all">Read everything once</button>
              <button type="button" aria-pressed={existing === 'new'} onClick={() => setExisting('new')} data-testid="button-dropbox-existing-new">Only new and changed files</button>
            </div>
            <span className="oo-muted" style={{ fontSize: 12, lineHeight: 1.5 }} data-testid="text-dropbox-existing-hint">
              {existing === 'all'
                ? `Reads all ${plural(preview.readable, 'file')} in the background, which costs ${costLine(preview.readable)} of Replit credits and fills your Knowledge Inbox with suggestions.`
                : 'Leaves what is there today alone. Files added or changed after this are read for knowledge.'}
            </span>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {onCancel && <button type="button" className="oo-btn oo-btn-outline" onClick={onCancel} data-testid="button-cancel-dropbox-folder">Cancel</button>}
        <button type="submit" className="oo-btn oo-btn-ink" disabled={!looked || busy !== null} data-testid="button-save-dropbox-folder">
          {busy === 'save' ? 'Saving…' : 'Use this folder'}
        </button>
      </div>
    </form>
  );
}

/** Matches how the server writes a folder: a leading slash and no trailing one. */
function normalise(folder: string): string {
  const t = folder.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return t.startsWith('/') ? t : '/' + t;
}
