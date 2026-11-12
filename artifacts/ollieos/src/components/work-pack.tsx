import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  buildTaskWorkPack,
  dismissTaskWorkPack,
  getGetTaskWorkPackQueryKey,
  markTaskWorkPackUsed,
  saveTaskWorkPackDraft,
  undoTaskLinks,
  useGetTaskWorkPack,
  type Task,
} from '@workspace/api-client-react';
import { copyText } from '@/lib/knowledge';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const OPEN = ['inbox', 'now', 'backlog', 'waiting'];
const STATUS: Record<string, { label: string; tone?: string }> = {
  ready_to_send: { label: 'Ready to send', tone: 'done' },
  needs_work: { label: 'Something to build on', tone: 'waiting' },
};

/**
 * Section 27: on the task panel, what the task linker linked (with Undo), and the task's work pack:
 * what OllieOS already holds for it, the next step, and a message to copy or save to Gmail drafts.
 * Nothing here sends anything.
 */
export function WorkPackPanel({ task }: { task: Task }) {
  const invalidate = useInvalidateTasks();
  const qc = useQueryClient();
  const open = OPEN.includes(task.status);
  const q = useGetTaskWorkPack(task.id, { query: { queryKey: getGetTaskWorkPackQueryKey(task.id), enabled: open, staleTime: 30_000 } });
  const [busy, setBusy] = useState<string | null>(null);
  const pack = q.data?.pack ?? null;
  const shown = pack && !pack.dismissedAt && pack.status !== 'nothing_found' ? pack : null;

  const run = async (key: string, fn: () => Promise<unknown>, done?: string, detail?: string) => {
    setBusy(key);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: getGetTaskWorkPackQueryKey(task.id) });
      await invalidate(task.id);
      if (done) notify(done, detail);
    } catch (err) {
      reportApiError(err);
      notify('That did not work', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!shown?.draft) return;
    const text = [shown.draft.subject ? `Subject: ${shown.draft.subject}` : null, shown.draft.body].filter(Boolean).join('\n\n');
    if (await copyText(text)) await run('copy', () => markTaskWorkPackUsed(task.id), 'Copied');
    else notify('Could not copy', 'Your browser blocked the clipboard.');
  };

  const l = task.linked;
  const links = l ? [l.person && `for ${l.person.name}`, l.waitingOn && `waiting on ${l.waitingOn.name}`, l.project && `project ${l.project.name}`].filter(Boolean) : [];

  if (!open && !l) return null;
  return (
    <>
      {l && links.length > 0 && (
        <div className="oo-source" style={{ gap: 6 }} data-testid="card-task-links">
          <span style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 500 }}>Linked by OllieOS:</span> {links.join(', ')}. <span className="oo-soft">{l.why}</span>
          </span>
          <div>
            <button type="button" className="oo-textbtn" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => void run('undo', () => undoTaskLinks(task.id), 'Links removed', 'OllieOS will leave this task alone.')} data-testid="button-links-undo">
              {busy === 'undo' ? 'Undoing…' : 'Undo'}
            </button>
          </div>
        </div>
      )}

      {open && shown && (
        <div className="oo-source" style={{ gap: 8 }} data-testid="card-work-pack">
          <span style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontWeight: 500 }}>Work pack</span>
            <span className="oo-pill" data-tone={STATUS[shown.status]?.tone} data-testid="pill-pack-status">{STATUS[shown.status]?.label}</span>
          </span>
          <span style={{ fontSize: 13 }} data-testid="text-pack-have">{shown.have}</span>
          {shown.next && (
            <span style={{ fontSize: 13 }}><span className="oo-muted">Next:</span> {shown.next}</span>
          )}
          {shown.sources.length > 0 && (
            <span className="oo-muted" style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              From:
              {shown.sources.map((s) =>
                s.path ? (
                  <Link key={s.ref} href={s.path} className="oo-link" data-testid={'link-pack-source-' + s.ref.replace(':', '-')}>{s.label}</Link>
                ) : (
                  <span key={s.ref}>{s.label}</span>
                ),
              )}
            </span>
          )}
          {shown.outline.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="list-pack-outline">
              {shown.outline.map((o, i) => <li key={i}>{o}</li>)}
            </ul>
          )}
          {shown.questions.length > 0 && (
            <span className="oo-soft" style={{ fontSize: 13 }}>
              <span className="oo-muted">Not known yet:</span> {shown.questions.join(' ')}
            </span>
          )}
          {shown.draft && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="pack-draft">
              <span className="oo-muted" style={{ fontSize: 12 }}>
                Message{shown.draft.to ? ` to ${shown.draft.to}` : ''}{shown.draft.subject ? ` · ${shown.draft.subject}` : ''}
              </span>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, padding: '8px 10px', borderRadius: 'var(--oo-r-input)', background: 'var(--oo-panel)', border: '1px solid var(--oo-line)' }}>{shown.draft.body}</pre>
            </div>
          )}
          {task.source === 'email' && (
            <span className="oo-muted" style={{ fontSize: 12 }}>For the reply itself, use Draft a reply on this task.</span>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {shown.draft && (
              <>
                <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" disabled={!!busy} onClick={() => void copy()} data-testid="button-pack-copy">Copy message</button>
                <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={!!busy} onClick={() => void run('gmail', () => saveTaskWorkPackDraft(task.id), shown.savedToGmail ? 'Gmail draft updated' : 'Saved to Gmail drafts', 'Nothing was sent.')} data-testid="button-pack-gmail">
                  {busy === 'gmail' ? 'Saving…' : shown.savedToGmail ? 'Update the Gmail draft' : 'Save to Gmail drafts'}
                </button>
              </>
            )}
            <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={!!busy} onClick={() => void run('build', () => buildTaskWorkPack(task.id), 'Work pack built again')} data-testid="button-pack-rebuild">
              {busy === 'build' ? 'Building…' : 'Build again'}
            </button>
            <button type="button" className="oo-btn oo-btn-quiet oo-btn-sm" disabled={!!busy} onClick={() => void run('dismiss', () => dismissTaskWorkPack(task.id), 'Work pack removed')} data-testid="button-pack-dismiss">Not useful</button>
          </div>
        </div>
      )}

      {open && !shown && !task.hiddenFromAi && !q.isLoading && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <button type="button" className="oo-btn oo-btn-outline" disabled={!!busy} onClick={() => void run('build', () => buildTaskWorkPack(task.id))} data-testid="button-pack-build">
            {busy === 'build' ? 'Looking through what OllieOS holds…' : 'Build a work pack'}
          </button>
          {pack?.status === 'nothing_found' && !pack.dismissedAt && (
            <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-pack-nothing">Nothing OllieOS holds bears on this yet.</span>
          )}
        </div>
      )}
    </>
  );
}
