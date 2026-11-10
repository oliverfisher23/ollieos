import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useSearch } from 'wouter';
import {
  dismissEmailDraft,
  getListEmailDraftsQueryKey,
  useListEmailDrafts,
  useListReview,
  useListTasks,
  type EmailDraftItem,
  type Task,
} from '@workspace/api-client-react';
import { STATUS_LABELS, formatLong, formatShort } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { PageProblem } from '@/components/knowledge/parts';
import { ReplyDraftCard } from '@/components/reply-draft';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';
import { useTaskActions } from '@/lib/task-actions';
import { NoReplyTab } from '@/pages/email-no-reply';

type Tab = 'to-answer' | 'drafts' | 'no-reply';
const TABS: Tab[] = ['to-answer', 'drafts', 'no-reply'];

/** Open email tasks Ollie still has to deal with; Waiting on ones are with someone else. */
const TO_ANSWER: Task['status'][] = ['inbox', 'now', 'backlog'];

function savedState(d: EmailDraftItem['draft']): string {
  if (d.savedAt) return `Saved to Gmail ${formatShort(d.savedAt)}`;
  return d.canSaveToGmail ? 'Not saved to Gmail yet' : 'Copy it to send; not in Gmail';
}

/**
 * Email: everything about email in one place. Emails waiting on Ollie, the replies and chase emails
 * OllieOS has drafted, and emails Ollie sent that nobody answered. Tasks stay the record; this is a
 * view of them. OllieOS never sends email.
 */
export default function EmailPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const asked = new URLSearchParams(search).get('tab') as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : 'to-answer';

  const tasks = useListTasks({ tab: 'open', source: 'email' });
  const drafts = useListEmailDrafts();
  const review = useListReview();
  const toAnswer = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => TO_ANSWER.includes(t.status))
        .sort((a, b) => new Date(b.capturedAt ?? b.createdAt).getTime() - new Date(a.capturedAt ?? a.createdAt).getTime()),
    [tasks.data],
  );

  const tabs: { id: Tab; label: string; count: number | undefined }[] = [
    { id: 'to-answer', label: 'To answer', count: tasks.data ? toAnswer.length : undefined },
    { id: 'drafts', label: 'Drafts', count: drafts.data?.items.length },
    { id: 'no-reply', label: 'No reply yet', count: review.data?.noReply },
  ];

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-email">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <h1 className="oo-h1">Email</h1>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
          Emails waiting on you, the replies OllieOS has drafted, and emails you sent that nobody answered. Nothing is ever sent for you.
        </p>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Email views" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="oo-tab" aria-selected={t.id === tab}
              onClick={() => navigate(`/email?tab=${t.id}`, { replace: true })} data-testid={'tab-email-' + t.id}>
              {t.label} <span className="oo-count oo-num">{t.count ?? ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: -6 }}>
        {tab === 'to-answer' ? (
          <ToAnswerTab items={toAnswer} loading={tasks.isLoading} failed={!tasks.data && !tasks.isLoading} retry={() => tasks.refetch()} drafts={drafts.data?.items ?? []} />
        ) : tab === 'drafts' ? (
          <DraftsTab items={drafts.data?.items ?? []} loading={drafts.isLoading} failed={!drafts.data && !drafts.isLoading} retry={() => drafts.refetch()} />
        ) : (
          <NoReplyTab />
        )}
      </div>
    </main>
  );
}

function Loading() {
  return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2].map((i) => <Skel key={i} h={88} />)}</div>;
}

/** Email tasks still with Ollie: in the Inbox, Now or Backlog. */
function ToAnswerTab({ items, loading, failed, retry, drafts }: { items: Task[]; loading: boolean; failed: boolean; retry: () => void; drafts: EmailDraftItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const actions = useTaskActions();
  const draftFor = useMemo(() => new Map(drafts.map((d) => [d.task.id, d.draft])), [drafts]);

  return (
    <>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Emails that came in as tasks and are still with you, newest first. Draft a reply, then save it to Gmail and send it from there. Emails you are waiting on someone about are in Tasks, Waiting on.
      </p>
      {loading ? (
        <Loading />
      ) : failed ? (
        <PageProblem notFound={false} what="emails to answer" onRetry={retry} back={{ href: '/tasks', label: 'Tasks' }} />
      ) : items.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-to-answer-empty">
          Nothing to answer. Emails that need something from you show here once a Gmail check brings them in.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
          {items.map((t) => {
            const d = draftFor.get(t.id);
            const isOpen = open === t.id;
            const titleId = 'em-title-' + t.id;
            return (
              <li key={t.id} className="oo-rv-row" aria-labelledby={titleId} data-testid={'row-to-answer-' + t.id}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
                  <span id={titleId} style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>{t.title}</span>
                  <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                    {(t.fromName || t.fromAddress) && <span style={{ overflowWrap: 'anywhere' }}>From {t.fromName ?? t.fromAddress}</span>}
                    {t.sourceSubject && (
                      <span style={{ overflowWrap: 'anywhere' }}>
                        {t.sourceUrl ? <a href={t.sourceUrl} target="_blank" rel="noreferrer">{t.sourceSubject}</a> : t.sourceSubject}
                      </span>
                    )}
                    <span>{formatLong(t.capturedAt ?? t.createdAt)}</span>
                    <span>{STATUS_LABELS[t.status]}</span>
                    {t.confidential && <span className="oo-pill">Confidential</span>}
                  </span>
                  {d && <span className="oo-muted" style={{ fontSize: 12 }} data-testid={'text-to-answer-draft-' + t.id}>Draft written · {savedState(d)}</span>}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                    <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.id)} data-testid={'button-to-answer-draft-' + t.id}>
                      {isOpen ? 'Close' : d ? 'Edit draft' : 'Draft reply'}
                    </button>
                    <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" onClick={() => void actions.markDone(t)} data-testid={'button-to-answer-done-' + t.id}>Done</button>
                    <Link href={'/tasks?task=' + t.id} className="oo-btn oo-btn-sm oo-btn-outline" data-testid={'link-to-answer-task-' + t.id}>Open task</Link>
                  </div>
                  {isOpen && <div style={{ marginTop: 6 }}><ReplyDraftCard taskId={t.id} /></div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Every reply and chase email OllieOS drafted that has not gone yet. */
function DraftsTab({ items, loading, failed, retry }: { items: EmailDraftItem[]; loading: boolean; failed: boolean; retry: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const dismiss = async (it: EmailDraftItem) => {
    setBusy(it.task.id);
    try {
      await dismissEmailDraft(it.task.id);
      await qc.invalidateQueries({ queryKey: getListEmailDraftsQueryKey() });
      if (open === it.task.id) setOpen(null);
      notify('Taken off Drafts', 'The draft stays on the task.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Replies and chase emails OllieOS has written, newest first. A draft leaves this list when a Gmail check sees you send an email in its thread, when its task is closed, or when you mark it done.
      </p>
      {loading ? (
        <Loading />
      ) : failed ? (
        <PageProblem notFound={false} what="drafts" onRetry={retry} back={{ href: '/tasks', label: 'Tasks' }} />
      ) : items.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-drafts-empty">
          No drafts waiting. Draft a reply from To answer, or chase an email from No reply yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
          {items.map((it) => {
            const d = it.draft;
            const isOpen = open === it.task.id;
            const titleId = 'em-draft-' + it.task.id;
            return (
              <li key={it.task.id} className="oo-rv-row" aria-labelledby={titleId} data-testid={'row-draft-' + it.task.id}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 10px' }}>
                    <span id={titleId} style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>{d.subject || it.task.title}</span>
                    <span className="oo-pill">{it.chase ? 'Chase' : 'Reply'}</span>
                    {it.task.confidential && <span className="oo-pill">Confidential</span>}
                  </span>
                  <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                    {d.to && <span style={{ overflowWrap: 'anywhere' }}>To {d.to}</span>}
                    <span data-testid={'text-draft-state-' + it.task.id}>{savedState(d)}</span>
                    <span>Written {formatShort(d.updatedAt)}</span>
                  </span>
                  {!isOpen && (
                    <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>
                      {d.body.replace(/\s+/g, ' ').trim()}
                    </span>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                    <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : it.task.id)} data-testid={'button-draft-edit-' + it.task.id}>
                      {isOpen ? 'Close' : 'Edit'}
                    </button>
                    {d.gmailUrl && (
                      <a href={d.gmailUrl} target="_blank" rel="noreferrer" className="oo-btn oo-btn-sm oo-btn-outline" data-testid={'link-draft-gmail-' + it.task.id}>Open in Gmail</a>
                    )}
                    <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy === it.task.id} onClick={() => void dismiss(it)} data-testid={'button-draft-done-' + it.task.id}>Done</button>
                    <Link href={'/tasks?task=' + it.task.id} className="oo-btn oo-btn-sm oo-btn-outline" data-testid={'link-draft-task-' + it.task.id}>Open task</Link>
                  </div>
                  {isOpen && <div style={{ marginTop: 6 }}><ReplyDraftCard taskId={it.task.id} chase={it.chase} /></div>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
