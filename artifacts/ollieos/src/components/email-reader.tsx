import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  dismissEmailDraft,
  getListEmailDraftsQueryKey,
  useGetTask,
  useGetTaskThread,
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

/** One message in the thread: older ones start folded to a line, the newest is open. */
function Message({ m, open, onToggle }: { m: EmailThreadMessage; open: boolean; onToggle: () => void }) {
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
              <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>{firstLine(m.text)}</span>
            )}
          </span>
        </span>
      </button>
      {open && <p className="oo-mail-body">{tidy(m.text)}</p>}
    </article>
  );
}

/**
 * The reading pane on the Email page: the email thread from Gmail, what OllieOS made of it, and
 * Reply, Done and Noise. The reply is drafted and edited here; nothing is ever sent.
 */
export function EmailReader({
  taskId,
  mode,
  chase = false,
  hasDraft = false,
  onBack,
  onNext,
}: {
  taskId: number;
  /** Answer: an email waiting on Ollie. Draft: a draft on the Drafts list. */
  mode: 'answer' | 'draft';
  chase?: boolean;
  hasDraft?: boolean;
  onBack: () => void;
  /** Moves on once this email is dealt with */
  onNext: () => void;
}) {
  const task = useGetTask(taskId);
  const thread = useGetTaskThread(taskId, { query: { staleTime: 60_000, retry: false } });
  const actions = useTaskActions();
  const qc = useQueryClient();
  const [replying, setReplying] = useState(mode === 'draft' || hasDraft);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const composer = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setReplying(mode === 'draft' || hasDraft);
    setOpened(new Set());
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
          {mode === 'answer' && !replying && (
            <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" onClick={reply} data-testid="button-email-reply">Reply</button>
          )}
          {mode === 'answer' ? (
            <>
              <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void done(t)} data-testid="button-email-done">Done</button>
              <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void noise(t)} data-testid="button-email-noise">Noise</button>
            </>
          ) : (
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy} onClick={() => void removeDraft()} data-testid="button-email-remove-draft">Remove from Drafts</button>
          )}
          {gmailUrl && (
            <a href={gmailUrl} target="_blank" rel="noreferrer" className="oo-btn oo-btn-sm oo-btn-outline" style={{ gap: 4 }} data-testid="link-email-gmail">
              Open in Gmail <IconArrowOut size={12} />
            </a>
          )}
        </div>
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
            {!thread.data?.fromGmail && (
              <span className="oo-muted" style={{ fontSize: 12 }}>This email is not in Gmail any more, so this is the part OllieOS kept.</span>
            )}
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              const open = isLast || opened.has(m.id);
              return (
                <Message key={m.id} m={m} open={open} onToggle={() => {
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
