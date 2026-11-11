import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  getListEmailDraftsQueryKey,
  getListEmailInboxQueryKey,
  useListEmailDrafts,
  useListEmailInbox,
  useListReview,
  type EmailDraftItem,
  type EmailInboxItem,
} from '@workspace/api-client-react';
import { formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { EmailReader } from '@/components/email-reader';
import { Mail } from '@/components/mail-layout';
import { useMedia } from '@/lib/use-media';
import { NoReplyTab } from '@/pages/email-no-reply';
import { SlackTab, useSlackToAnswer } from '@/pages/email-slack';

type Tab = 'to-answer' | 'slack' | 'drafts' | 'waiting';
const TABS: Tab[] = ['to-answer', 'slack', 'drafts', 'waiting'];

/** Where each draft is: the Drafts tab lists them in this order. */
type DraftStage = 'writing' | 'ready' | 'saved';
const STAGES: { id: DraftStage; label: string }[] = [
  { id: 'writing', label: 'Writing' },
  { id: 'ready', label: 'Ready to look at' },
  { id: 'saved', label: 'Saved to Gmail' },
];
const stageOf = (d: EmailDraftItem['draft']): DraftStage => (d.state === 'ready' ? (d.savedAt ? 'saved' : 'ready') : 'writing');

const WIDE = '(min-width: 1024px)';

/** To answer in two groups: emails not read yet, or not read by AI, count as needing a reply. */
type AnswerGroup = 'reply' | 'info';
const ANSWER_GROUPS: { id: AnswerGroup; label: string }[] = [
  { id: 'reply', label: 'Needs a reply' },
  { id: 'info', label: 'For your information' },
];
const groupOf = (e: EmailInboxItem): AnswerGroup => (e.needs === 'info' ? 'info' : 'reply');

/** Today's emails show the time, older ones the date. */
function when(at: string): string {
  return londonDate(at) === todayLondon() ? formatTime(at) : formatShort(at);
}

const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The first person a draft goes to, by name when there is one. */
function firstRecipient(to: string): string {
  const first = to.split(',')[0]?.trim() ?? '';
  return first.replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, '') || first || 'No recipient yet';
}

/**
 * Email: a small email client over OllieOS. To answer is the Gmail inbox, read or unread, where
 * the last message is not from Ollie; then the replies OllieOS has drafted, and emails Ollie sent
 * that nobody answered. OllieOS never sends email.
 */
export default function EmailPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get('tab');
  // Old links to No reply yet open Waiting for a reply.
  const asked = (raw === 'no-reply' ? 'waiting' : raw) as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : 'to-answer';
  const picked = params.get('id') || null;
  const pickedThread = params.get('thread') || null;
  const wide = useMedia(WIDE);

  // The inbox opens from the last look at Gmail; while it is being looked at again or new emails
  // are being read, ask every few seconds, otherwise every minute.
  const inbox = useListEmailInbox({
    query: { queryKey: getListEmailInboxQueryKey(), refetchInterval: (q) => (q.state.data?.updating ? 4_000 : 60_000), staleTime: 20_000, retry: false },
  });
  // While a draft is being written, look again every few seconds.
  const drafts = useListEmailDrafts({
    query: { queryKey: getListEmailDraftsQueryKey(), refetchInterval: (q) => (q.state.data?.items.some((d) => d.draft.state === 'writing') ? 3_000 : false) },
  });
  const review = useListReview();
  const slack = useSlackToAnswer();
  const draftItems = useMemo(() => {
    const items = drafts.data?.items ?? [];
    return STAGES.flatMap((s) => items.filter((d) => stageOf(d.draft) === s.id));
  }, [drafts.data]);
  // An email with a draft on Drafts is not also To answer, unless it is the one open now.
  const drafted = useMemo(() => new Set(draftItems.map((d) => d.task.id)), [draftItems]);
  // Needs a reply first (with any not read yet), then for information; newest first in each.
  const toAnswer = useMemo(() => {
    const items = (inbox.data?.items ?? []).filter((e) => e.taskId == null || !drafted.has(e.taskId) || (tab === 'to-answer' && e.threadId === pickedThread));
    return ANSWER_GROUPS.flatMap((g) => items.filter((e) => groupOf(e) === g.id));
  }, [inbox.data, drafted, tab, pickedThread]);
  const needsReply = toAnswer.filter((e) => groupOf(e) === 'reply').length;
  // The email open now, kept after it leaves the list (Done, Noise) so Undo and noise rules still show.
  const [kept, setKept] = useState<EmailInboxItem | null>(null);
  const openEmail = toAnswer.find((e) => e.threadId === pickedThread) ?? (kept?.threadId === pickedThread ? kept : null);
  useEffect(() => {
    if (openEmail && openEmail !== kept) setKept(openEmail);
  }, [openEmail, kept]);

  const go = useCallback(
    (next: Tab, id?: string | number | null) => navigate(`/email?tab=${next}${id ? `&${next === 'to-answer' ? 'thread' : 'id'}=${id}` : ''}`, { replace: true }),
    [navigate],
  );
  const pickAnswer = useCallback((id: string) => go('to-answer', id), [go]);
  const pickDraft = useCallback((id: string) => go('drafts', id), [go]);
  const pickSlack = useCallback((id: string | null) => go('slack', id), [go]);

  const tabs: { id: Tab; label: string; count: number | undefined }[] = [
    { id: 'to-answer', label: 'To answer', count: inbox.data ? needsReply : undefined },
    { id: 'slack', label: 'Slack', count: slack.q.data?.readBy === 'ollieos' ? slack.needsReply : undefined },
    { id: 'drafts', label: 'Drafts', count: drafts.data?.items.length },
    { id: 'waiting', label: 'Waiting for a reply', count: review.data?.noReplyDue || undefined },
  ];

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-email">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <h1 className="oo-h1">Email</h1>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
          Your Gmail inbox emails and Slack messages that you have not replied to, the replies OllieOS has drafted, and emails you sent that are waiting for a reply. Nothing is ever sent for you.
        </p>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Email views" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="oo-tab" aria-selected={t.id === tab} onClick={() => go(t.id)} data-testid={'tab-email-' + t.id}>
              {t.label} <span className="oo-count oo-num">{t.count ?? ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: -6 }}>
        {tab === 'waiting' ? (
          <NoReplyTab />
        ) : tab === 'slack' ? (
          <SlackTab picked={picked} wide={wide} onPick={pickSlack} />
        ) : tab === 'to-answer' ? (
          <>
            <Mail
              ids={toAnswer.map((e) => e.threadId)}
              picked={pickedThread}
              wide={wide}
              loading={inbox.isLoading}
              failed={!inbox.data && !inbox.isLoading}
              retry={() => inbox.refetch()}
              what="your inbox"
              empty="Nothing to answer. Every email in your Gmail inbox has a reply from you."
              onPick={pickAnswer}
              row={(id, current) => {
                const e = toAnswer.find((x) => x.threadId === id)!;
                const at = toAnswer.indexOf(e);
                const group = groupOf(e);
                const heading = at === 0 || groupOf(toAnswer[at - 1]) !== group ? ANSWER_GROUPS.find((g) => g.id === group)! : null;
                return (
                  <>
                    {heading && (
                      <span className="oo-mail-group" data-testid={'heading-to-answer-' + group}>
                        {heading.label} <span className="oo-num">{toAnswer.filter((x) => groupOf(x) === group).length}</span>
                      </span>
                    )}
                    <AnswerRow e={e} hasDraft={e.taskId != null && drafted.has(e.taskId)} current={current} onPick={() => go('to-answer', id)} />
                  </>
                );
              }}
              reader={(_id, next) =>
                openEmail ? (
                  <EmailReader
                    taskId={openEmail.taskId}
                    inbox={openEmail}
                    mode="answer"
                    hasDraft={openEmail.taskId != null && drafted.has(openEmail.taskId)}
                    onBack={() => go('to-answer')}
                    onNext={() => go('to-answer', wide ? next : null)}
                    onBriefed={(taskId) => go('drafts', taskId)}
                  />
                ) : (
                  <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>This email is not in your inbox any more.</p>
                )
              }
            />
            {inbox.data && (
              <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }} data-testid="text-inbox-left-out">
                {inbox.data.problem
                  ? `${inbox.data.problem.replace(/\.$/, '')}. This is your inbox as of ${when(inbox.data.checkedAt)}. `
                  : inbox.data.updating
                    ? 'Checking Gmail for new emails. '
                    : `Checked Gmail at ${when(inbox.data.checkedAt)}. `}
                {inbox.data.leftOut > 0 && `${inbox.data.leftOut === 1 ? '1 newsletter or automatic email is' : `${inbox.data.leftOut} newsletters and automatic emails are`} left out. `}
                {inbox.data.more && 'Only your newest 200 inbox emails are looked at. '}
                Needs a reply and For your information are OllieOS's best guess.
              </p>
            )}
          </>
        ) : (
          <Mail
            ids={draftItems.map((d) => String(d.task.id))}
            picked={picked}
            wide={wide}
            loading={drafts.isLoading}
            failed={!drafts.data && !drafts.isLoading}
            retry={() => drafts.refetch()}
            what="drafts"
            empty="No drafts waiting. Brief a reply to an email from To answer, or chase one from Waiting for a reply. A draft leaves this list when you send an email in its thread, when its task is closed, or when you mark it done."
            onPick={pickDraft}
            row={(id, current) => {
              const it = draftItems.find((x) => String(x.task.id) === id)!;
              const at = draftItems.indexOf(it);
              const stage = stageOf(it.draft);
              const heading = at === 0 || stageOf(draftItems[at - 1].draft) !== stage ? STAGES.find((s) => s.id === stage)!.label : null;
              return (
                <>
                  {heading && <span className="oo-mail-group" data-testid={'heading-drafts-' + stage}>{heading}</span>}
                  <DraftRow it={it} current={current} onPick={() => go('drafts', id)} />
                </>
              );
            }}
            reader={(id, next) => {
              const it = draftItems.find((x) => String(x.task.id) === id);
              return <EmailReader taskId={Number(id)} mode="draft" chase={it?.chase ?? false} onBack={() => go('drafts')} onNext={() => go('drafts', wide ? next : null)} />;
            }}
          />
        )}
      </div>
    </main>
  );
}

function AnswerRow({ e, hasDraft, current, onPick }: { e: EmailInboxItem; hasDraft: boolean; current: boolean; onPick: () => void }) {
  const from = e.fromName ?? e.fromEmail ?? 'Unknown sender';
  return (
    <button type="button" className="oo-mail-row" aria-current={current ? 'true' : undefined} onClick={onPick} data-unread={e.unread ? 'true' : undefined} data-testid={'row-to-answer-' + e.threadId}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="oo-mail-clamp" style={{ fontSize: 14, fontWeight: e.unread ? 700 : 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          {e.unread && <span className="oo-mail-unread" aria-label="Unread" />}
          {from}
          {e.messages > 1 && <span className="oo-muted oo-num" style={{ fontSize: 12, fontWeight: 400 }}>{e.messages}</span>}
        </span>
        <span className="oo-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{when(e.at)}</span>
      </span>
      <span className="oo-mail-clamp" style={{ fontSize: 13, fontWeight: e.unread ? 600 : 500, display: '-webkit-box' }}>{e.subject ?? '(no subject)'}</span>
      {e.ask ? (
        <span className="oo-soft oo-mail-clamp" style={{ fontSize: 13 }} data-testid={'text-to-answer-ask-' + e.threadId}>{e.ask}</span>
      ) : (
        <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>{firstLine(e.snippet)}</span>
      )}
      {(e.taskId != null || hasDraft) && (
        <span style={{ display: 'flex', gap: 6, marginTop: 3 }}>
          {e.taskId != null && <span className="oo-pill">Task</span>}
          {hasDraft && <span className="oo-pill">Draft</span>}
        </span>
      )}
    </button>
  );
}

function DraftRow({ it, current, onPick }: { it: EmailDraftItem; current: boolean; onPick: () => void }) {
  const d = it.draft;
  const sender = it.task.fromName ?? it.task.fromAddress;
  return (
    <button type="button" className="oo-mail-row" aria-current={current ? 'true' : undefined} onClick={onPick} data-testid={'row-draft-' + it.task.id}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="oo-mail-clamp" style={{ fontSize: 14, fontWeight: 600 }}>To {d.state === 'ready' ? firstRecipient(d.to) : (sender ?? 'the sender')}</span>
        <span className="oo-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{when(d.updatedAt)}</span>
      </span>
      <span className="oo-mail-clamp" style={{ fontSize: 13, fontWeight: 500 }}>{d.subject || it.task.sourceSubject || it.task.title}</span>
      <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>
        {d.state === 'writing' ? `Writing from your brief: ${d.brief ?? ''}` : d.state === 'failed' ? 'Could not be written. Open it to try again.' : firstLine(d.body)}
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3 }}>
        <span className="oo-pill">{it.followUp ? 'Meeting follow-up' : it.chase ? 'Chase' : 'Reply'}</span>
        {d.state === 'writing' ? (
          <span className="oo-pill" data-testid={'pill-draft-writing-' + it.task.id}>Writing…</span>
        ) : d.state === 'failed' ? (
          <span className="oo-pill" data-tone="now">Not written</span>
        ) : (
          <span className="oo-pill">{d.savedAt ? 'In Gmail' : d.canSaveToGmail ? 'Not in Gmail yet' : 'Copy to send'}</span>
        )}
      </span>
    </button>
  );
}
