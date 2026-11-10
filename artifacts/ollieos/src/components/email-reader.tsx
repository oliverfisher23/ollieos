import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  briefReplyDraft,
  dismissEmailDraft,
  getGetReplyDraftQueryKey,
  getGetTaskThreadQueryKey,
  getGetTaskThreadSummaryQueryKey,
  getListEmailDraftsQueryKey,
  saveEmailAttachment,
  useGetTask,
  useGetTaskThread,
  useGetTaskThreadSummary,
  type EmailAttachment,
  type EmailThreadMessage,
  type Task,
} from '@workspace/api-client-react';
import { STATUS_LABELS, formatShort, formatTime } from '@workspace/shared';
import { Avatar, Skel } from '@/components/bits';
import { IconArrowOut, IconLeft } from '@/components/icons';
import { NoiseRuleChooser } from '@/components/noise-rule-chooser';
import { ReplyDraftCard } from '@/components/reply-draft';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';
import { useTaskActions } from '@/lib/task-actions';

const nameOf = (m: Pick<EmailThreadMessage, 'fromName' | 'fromEmail' | 'fromOllie'>) => (m.fromOllie ? 'You' : (m.fromName ?? m.fromEmail ?? 'Unknown sender'));
const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** No runs of empty lines, and no trailing spaces. */
const tidy = (text: string) => text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** Threads this long get a summary at the top */
const SUMMARY_FROM = 4;

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An attachment on a message: PDF, Word and text files under 10 MB can go to the Library. */
function Attachment({ taskId, messageId, a }: { taskId: number; messageId: string; a: EmailAttachment }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await saveEmailAttachment(taskId, { messageId, partId: a.partId });
      await qc.invalidateQueries({ queryKey: getGetTaskThreadQueryKey(taskId) });
      notify('Saved to the Library', 'OllieOS is reading it for knowledge. Anything it finds waits for you to look at.');
    } catch (err) {
      reportApiError(err);
      notify('Could not save it', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="oo-mail-file" data-testid={'row-attachment-' + messageId + '-' + a.partId}>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span className="oo-mail-clamp" style={{ fontSize: 13, fontWeight: 500 }}>{a.filename}</span>
        <span className="oo-muted" style={{ fontSize: 12 }}>{fileSize(a.size)}{!a.canSave && !a.documentId ? '. OllieOS cannot read this kind of file, or it is over 10 MB.' : ''}</span>
      </span>
      {a.documentId ? (
        <Link href={'/knowledge/library?document=' + a.documentId} className="oo-link" style={{ fontSize: 13, whiteSpace: 'nowrap' }} data-testid={'link-attachment-library-' + a.partId}>In the Library</Link>
      ) : a.canSave ? (
        <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={saving} onClick={() => void save()} data-testid={'button-attachment-save-' + a.partId}>
          {saving ? 'Saving…' : 'Save to Library'}
        </button>
      ) : null}
    </li>
  );
}

/** A few lines on a long thread, written when it is first opened and kept until a new message arrives. */
function ThreadSummary({ taskId, count }: { taskId: number; count: number }) {
  const q = useGetTaskThreadSummary(taskId, { query: { queryKey: getGetTaskThreadSummaryQueryKey(taskId), enabled: count >= SUMMARY_FROM, staleTime: 5 * 60_000, retry: false } });
  if (count < SUMMARY_FROM) return null;
  if (q.isLoading) {
    return (
      <div className="oo-source" style={{ gap: 6 }} aria-busy="true">
        <span className="oo-field-label">Summary</span>
        <Skel h={14} w="85%" /><Skel h={14} w="70%" />
      </div>
    );
  }
  if (q.isError) return <span className="oo-muted" style={{ fontSize: 12 }}>{errorMessage(q.error, 'The thread could not be summarised just now.')}</span>;
  const summary = q.data?.summary;
  if (!summary) return null;
  const lines = summary.split('\n').map((l) => l.replace(/^\s*[-•]\s*/, '').trim()).filter(Boolean);
  return (
    <div className="oo-source" style={{ gap: 6 }} data-testid="card-thread-summary">
      <span className="oo-field-label">Summary of {q.data!.messages} messages</span>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, lineHeight: 1.5 }}>
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}

/** One message in the thread: older ones start folded to a line, the newest is open. */
function Message({ taskId, m, open, onToggle }: { taskId: number; m: EmailThreadMessage; open: boolean; onToggle: () => void }) {
  const name = nameOf(m);
  return (
    <article className="oo-mail-msg" data-testid={'card-email-message-' + m.id}>
      <button type="button" aria-expanded={open} onClick={onToggle}>
        <span style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
          <Avatar name={name} id={m.fromEmail ?? name} size={30} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{name}</span>
              <span className="oo-muted oo-mail-clamp" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{m.fromEmail && !m.fromOllie ? m.fromEmail : ''}</span>
              <span className="oo-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatShort(m.at)}, {formatTime(m.at)}</span>
            </span>
            {open ? (
              (m.to || m.cc) && (
                <span className="oo-muted" style={{ fontSize: 12, overflowWrap: 'anywhere', lineHeight: 1.45 }}>
                  {m.to && <>To {m.to}</>}
                  {m.cc && <>{m.to ? '; ' : ''}Cc {m.cc}</>}
                </span>
              )
            ) : (
              <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>
                {m.attachments.length > 0 && `${m.attachments.length === 1 ? '1 attachment' : `${m.attachments.length} attachments`}. `}
                {firstLine(m.text)}
              </span>
            )}
          </span>
        </span>
      </button>
      {open && <p className="oo-mail-body">{tidy(m.text)}</p>}
      {open && m.attachments.length > 0 && (
        <ul className="oo-mail-files" aria-label="Attachments">
          {m.attachments.map((a) => <Attachment key={a.partId} taskId={taskId} messageId={m.id} a={a} />)}
        </ul>
      )}
    </article>
  );
}

/**
 * The reading pane on the Email page: the email thread from Gmail, a summary of long threads,
 * attachments, what OllieOS made of it, and Brief a reply, Reply, Done and Noise. Drafts are
 * written and edited here; nothing is ever sent.
 */
export function EmailReader({
  taskId,
  mode,
  chase = false,
  hasDraft = false,
  onBack,
  onNext,
  onBriefed,
}: {
  taskId: number;
  /** Answer: an email waiting on Ollie. Draft: a draft on the Drafts list. */
  mode: 'answer' | 'draft';
  chase?: boolean;
  hasDraft?: boolean;
  onBack: () => void;
  /** Moves on once this email is dealt with */
  onNext: () => void;
  /** After Brief a reply: the email is on Drafts now */
  onBriefed?: () => void;
}) {
  const task = useGetTask(taskId);
  const thread = useGetTaskThread(taskId, { query: { staleTime: 60_000, retry: false } });
  const actions = useTaskActions();
  const qc = useQueryClient();
  const [replying, setReplying] = useState(mode === 'draft' || hasDraft);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [briefing, setBriefing] = useState(false);
  const [brief, setBrief] = useState('');
  const composer = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setReplying(mode === 'draft' || hasDraft);
    setOpened(new Set());
    setBriefing(false);
    setBrief('');
  }, [taskId, mode, hasDraft]);
  // A new email starts at the top of the reading pane.
  useEffect(() => {
    top.current?.closest('.oo-mail-read')?.scrollTo(0, 0);
  }, [taskId, task.isLoading]);

  const t = task.data?.task;
  const messages = thread.data?.messages ?? [];
  const gmailUrl = thread.data?.gmailUrl ?? t?.sourceUrl ?? null;

  const reply = () => {
    setReplying(true);
    setTimeout(() => composer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const sendBrief = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!brief.trim()) return;
    setBusy(true);
    try {
      const d = await briefReplyDraft(taskId, { brief: brief.trim() });
      qc.setQueryData(getGetReplyDraftQueryKey(taskId), { draft: d });
      await qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
      notify('Writing the draft', 'It is on Drafts. Once written it is saved to Gmail as a draft. Nothing is sent.');
      setBriefing(false);
      setBrief('');
      onBriefed?.();
    } catch (err) {
      reportApiError(err);
      notify('Could not start the draft', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const done = async (x: Task) => {
    setBusy(true);
    const res = await actions.markDone(x);
    setBusy(false);
    if (res) onNext();
  };

  const noise = async (x: Task) => {
    setBusy(true);
    await actions.triage(x, { action: 'noise' });
    setBusy(false);
  };

  const removeDraft = async () => {
    setBusy(true);
    try {
      await dismissEmailDraft(taskId);
      await qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
      notify('Taken off Drafts', 'The draft stays on the task.');
      onNext();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (task.isLoading) {
    return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><Skel h={28} w="60%" /><Skel h={16} w="40%" /><Skel h={160} /></div>;
  }
  if (!t) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>This email could not be loaded. It may have been deleted.</p>;
  }

  const closed = t.status === 'done' || t.status === 'dropped' || t.status === 'noise' || t.status === 'archived';
  const subject = t.sourceSubject ?? t.title;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }} data-testid={'reader-email-' + t.id}>
      <button type="button" className="oo-mail-back oo-btn oo-btn-outline oo-btn-sm" style={{ alignSelf: 'flex-start', gap: 4 }} onClick={onBack} data-testid="button-email-back">
        <IconLeft size={14} /> All emails
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 ref={top} style={{ margin: 0, fontSize: 21, fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }} data-testid="text-email-subject">{subject}</h2>
        <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'baseline' }}>
          <span>
            In OllieOS: <Link href={'/tasks?task=' + t.id} className="oo-link" data-testid="link-email-task">{t.title}</Link>
          </span>
          <span className="oo-pill">{STATUS_LABELS[t.status]}</span>
          {t.confidential && <span className="oo-pill">Confidential</span>}
        </span>
        {t.suggestedAction && <span className="oo-soft" style={{ fontSize: 13 }}><span className="oo-muted">Next step:</span> {t.suggestedAction}</span>}
      </div>

      {!closed && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="toolbar" aria-label="Email actions">
          {mode === 'answer' && !replying && !briefing && (
            <>
              <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" onClick={() => setBriefing(true)} data-testid="button-email-brief">Brief a reply</button>
              <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" onClick={reply} data-testid="button-email-reply">Reply</button>
            </>
          )}
          {mode === 'answer' ? (
            <>
              <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void done(t)} data-testid="button-email-done">Done</button>
              <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void noise(t)} data-testid="button-email-noise">Noise</button>
            </>
          ) : chase ? (
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void removeDraft()} data-testid="button-email-remove-draft">Remove from Drafts</button>
          ) : (
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void done(t)} data-testid="button-email-done">Done</button>
          )}
          {gmailUrl && (
            <a href={gmailUrl} target="_blank" rel="noreferrer" className="oo-btn oo-btn-sm oo-btn-outline" style={{ gap: 4 }} data-testid="link-email-gmail">
              Open in Gmail <IconArrowOut size={12} />
            </a>
          )}
        </div>
      )}

      {briefing && !closed && (
        <form className="oo-source" style={{ gap: 8 }} onSubmit={(e) => void sendBrief(e)} data-testid="form-email-brief">
          <label htmlFor={'brief-' + taskId} style={{ fontSize: 14, fontWeight: 600 }}>What should the reply say?</label>
          <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>
            One line is enough. OllieOS writes the reply in the background, in the way you write, and saves it to Gmail as a draft. Nothing is sent.
          </span>
          <input id={'brief-' + taskId} className="oo-input" autoFocus value={brief} maxLength={500} onChange={(e) => setBrief(e.target.value)}
            placeholder="For example: yes to Tuesday, ask for the budget first" data-testid="input-email-brief" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="submit" className="oo-btn oo-btn-sm oo-btn-ink" disabled={busy || !brief.trim()} data-testid="button-email-brief-send">Write the draft</button>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" onClick={() => setBriefing(false)} data-testid="button-email-brief-cancel">Cancel</button>
          </div>
        </form>
      )}

      {t.status === 'noise' && (
        <div className="oo-source" style={{ gap: 10 }} role="status" data-testid="state-email-noise">
          <span style={{ fontSize: 14, fontWeight: 600 }}>Moved to Noise</span>
          <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>
            It is off your lists. To keep emails like this out of your Inbox from now on, pick a rule. It stays in Gmail; OllieOS cannot mark email as spam there.
          </span>
          <NoiseRuleChooser task={t} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" onClick={() => void actions.undo(t)} data-testid="button-email-undo-noise">Undo</button>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" onClick={onNext} data-testid="button-email-next">Next email</button>
          </div>
        </div>
      )}
      {(t.status === 'done' || t.status === 'dropped') && (
        <div className="oo-source" style={{ gap: 10 }} role="status">
          <span style={{ fontSize: 14 }}>{t.status === 'done' ? 'Marked done.' : 'Dropped.'}</span>
          <div><button type="button" className="oo-btn oo-btn-sm oo-btn-outline" onClick={() => void actions.undo(t)}>Undo</button></div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Email thread">
        {thread.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><Skel h={56} /><Skel h={180} /></div>
        ) : thread.isError ? (
          <div className="oo-source" style={{ gap: 6 }}>
            <span style={{ fontSize: 13 }} role="alert">{errorMessage(thread.error, 'The email could not be read from Gmail just now.')}</span>
            {(t.sourceQuote || t.snippet) && <p className="oo-mail-body">{[t.sourceQuote, t.snippet].filter(Boolean).join('\n\n')}</p>}
          </div>
        ) : messages.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>OllieOS has no copy of this email, only the task. A reply can still be drafted from the task.</p>
        ) : (
          <>
            {thread.data?.fromGmail && <ThreadSummary taskId={taskId} count={messages.length} />}
            {!thread.data?.fromGmail && (
              <span className="oo-muted" style={{ fontSize: 12 }}>This email is not in Gmail any more, so this is the part OllieOS kept.</span>
            )}
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              const open = isLast || opened.has(m.id);
              return (
                <Message key={m.id} taskId={taskId} m={m} open={open} onToggle={() => {
                  if (isLast) return;
                  setOpened((s) => {
                    const next = new Set(s);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  });
                }} />
              );
            })}
          </>
        )}
      </div>

      {replying && !closed && (
        <div ref={composer} style={{ scrollMarginTop: 12 }}>
          <ReplyDraftCard key={taskId} taskId={taskId} chase={chase} />
        </div>
      )}
    </div>
  );
}
