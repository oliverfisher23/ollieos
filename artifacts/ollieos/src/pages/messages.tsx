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
  type SlackToAnswerItem,
} from '@workspace/api-client-react';
import { formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { EmailReader } from '@/components/email-reader';
import { Mail } from '@/components/mail-layout';
import { useMedia } from '@/lib/use-media';
import { NoReplyTab } from '@/pages/email-no-reply';
import { SlackNotRead, SlackReader, SlackRow, slackGroupOf, useSlackToAnswer } from '@/pages/email-slack';
import { ScrollRow } from '@/components/scroll-row';

type Tab = 'to-answer' | 'drafts' | 'waiting';
const TABS: Tab[] = ['to-answer', 'drafts', 'waiting'];

/** To answer shows email and Slack together; these narrow it to one. */
type Source = 'all' | 'email' | 'slack';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'email', label: 'Email' },
  { id: 'slack', label: 'Slack' },
];

/** Where each draft is: the Drafts tab lists them in this order. */
type DraftStage = 'writing' | 'ready' | 'saved';
const STAGES: { id: DraftStage; label: string }[] = [
  { id: 'writing', label: 'Writing' },
  { id: 'ready', label: 'Ready to look at' },
  { id: 'saved', label: 'Saved to Gmail' },
];
const stageOf = (d: EmailDraftItem['draft']): DraftStage => (d.state === 'ready' ? (d.savedAt ? 'saved' : 'ready') : 'writing');

const WIDE = '(min-width: 1024px)';

/** To answer in two groups: messages not read yet, or not read by AI, count as needing a reply. */
type AnswerGroup = 'reply' | 'info';
const ANSWER_GROUPS: { id: AnswerGroup; label: string }[] = [
  { id: 'reply', label: 'Needs a reply' },
  { id: 'info', label: 'For your information' },
];
const groupOf = (e: EmailInboxItem): AnswerGroup => (e.needs === 'info' ? 'info' : 'reply');

/** One row on To answer: an email thread or a Slack message. Keys are t:{threadId} and s:{id}. */
type Item =
  | { key: string; source: 'email'; at: string; group: AnswerGroup; e: EmailInboxItem }
  | { key: string; source: 'slack'; at: string; group: AnswerGroup; s: SlackToAnswerItem };
const emailItem = (e: EmailInboxItem): Item => ({ key: 't:' + e.threadId, source: 'email', at: e.at, group: groupOf(e), e });
const slackItem = (s: SlackToAnswerItem): Item => ({ key: 's:' + s.id, source: 'slack', at: s.at, group: slackGroupOf(s), s });

/** Today's messages show the time, older ones the date. */
function when(at: string): string {
  return londonDate(at) === todayLondon() ? formatTime(at) : formatShort(at);
}

const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The first person a draft goes to, by name when there is one. */
function firstRecipient(to: string): string {
  const first = to.split(',')[0]?.trim() ?? '';
  return first.replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, '') || first || 'No recipient yet';
}

/** The address for a tab, an open item and, on To answer, a source filter. */
function messagesHref(tab: Tab, key?: string | null, source: Source = 'all'): string {
  const p = new URLSearchParams({ tab });
  if (tab === 'to-answer' && source !== 'all') p.set('from', source);
  if (key) {
    if (tab !== 'to-answer') p.set('id', key);
    else if (key.startsWith('s:')) p.set('slack', key.slice(2));
    else p.set('thread', key.replace(/^t:/, ''));
  }
  return '/messages?' + p.toString();
}

/**
 * Messages: everything waiting on Ollie, wherever it came from. To answer is the Gmail inbox, read or
 * unread, where the last message is not from Ollie, and Slack messages where someone else wrote last,
 * in one list; then the replies OllieOS has drafted, and emails Ollie sent that nobody answered.
 * OllieOS never sends email or posts to Slack.
 */
export default function MessagesPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get('tab');
  // Old links: No reply yet opens Waiting for a reply; the Slack tab opens To answer showing Slack.
  const asked = (raw === 'no-reply' ? 'waiting' : raw === 'slack' ? 'to-answer' : raw) as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : 'to-answer';
  const fromParam = params.get('from') ?? (raw === 'slack' ? 'slack' : null);
  const source: Source = fromParam === 'email' || fromParam === 'slack' ? fromParam : 'all';
  const picked = params.get('id') || null;
  const pickedThread = params.get('thread') || null;
  const pickedSlack = params.get('slack') || (raw === 'slack' ? picked : null);
  const pickedKey = pickedSlack ? 's:' + pickedSlack : pickedThread ? 't:' + pickedThread : null;
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
  const slackRead = slack.q.data?.readBy === 'ollieos';
  const draftItems = useMemo(() => {
    const items = drafts.data?.items ?? [];
    return STAGES.flatMap((s) => items.filter((d) => stageOf(d.draft) === s.id));
  }, [drafts.data]);
  // An email with a draft on Drafts is not also To answer, unless it is the one open now.
  const drafted = useMemo(() => new Set(draftItems.map((d) => d.task.id)), [draftItems]);
  const emails = useMemo(
    () => (inbox.data?.items ?? []).filter((e) => e.taskId == null || !drafted.has(e.taskId) || (tab === 'to-answer' && e.threadId === pickedThread)),
    [inbox.data, drafted, tab, pickedThread],
  );
  const slackItems = slackRead ? slack.items : [];
  const emailsNeedingReply = emails.filter((e) => groupOf(e) === 'reply').length;
  const slackNeedingReply = slackRead ? slack.needsReply : 0;
  // Needs a reply first, then for information; newest first in each, email and Slack mixed.
  const toAnswer = useMemo(() => {
    const items: Item[] = [
      ...(source === 'slack' ? [] : emails.map(emailItem)),
      ...(source === 'email' ? [] : slackItems.map(slackItem)),
    ];
    return ANSWER_GROUPS.flatMap((g) => items.filter((it) => it.group === g.id).sort((a, b) => b.at.localeCompare(a.at)));
  }, [emails, slackItems, source]);

  // The item open now, kept after it leaves the list (Done, Noise) so Undo and noise rules still show.
  const [kept, setKept] = useState<Item | null>(null);
  const openItem = toAnswer.find((it) => it.key === pickedKey) ?? (kept?.key === pickedKey ? kept : null);
  useEffect(() => {
    if (openItem && openItem !== kept) setKept(openItem);
  }, [openItem, kept]);

  const go = useCallback((next: Tab, key?: string | number | null, from: Source = source) => navigate(messagesHref(next, key == null ? null : String(key), from), { replace: true }), [navigate, source]);
  const pickAnswer = useCallback((key: string) => go('to-answer', key), [go]);
  const pickDraft = useCallback((id: string) => go('drafts', id), [go]);

  const tabs: { id: Tab; label: string; count: number | undefined }[] = [
    { id: 'to-answer', label: 'To answer', count: inbox.data || slackRead ? emailsNeedingReply + slackNeedingReply : undefined },
    { id: 'drafts', label: 'Drafts', count: drafts.data?.items.length },
    { id: 'waiting', label: 'Waiting for a reply', count: review.data?.noReplyDue || undefined },
  ];
  const sourceCount: Record<Source, number | undefined> = {
    all: inbox.data || slackRead ? emailsNeedingReply + slackNeedingReply : undefined,
    email: inbox.data ? emailsNeedingReply : undefined,
    slack: slackRead ? slackNeedingReply : undefined,
  };

  const showEmail = source !== 'slack';
  const showSlack = source !== 'email';
  const slackOff = slack.q.data?.readBy === 'claude';
  const emailFailed = showEmail && !inbox.data && !inbox.isLoading;
  const slackFailed = showSlack && !slack.q.data && !slack.q.isLoading;
  const empty =
    source === 'email'
      ? 'Nothing to answer. Every email in your Gmail inbox has a reply from you.'
      : source === 'slack'
        ? 'Nothing to answer on Slack. In every direct message, group DM and mention from the last 14 days, you wrote last.'
        : 'Nothing to answer. Every email in your Gmail inbox has a reply from you, and on Slack you wrote last.';

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-messages">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <h1 className="oo-h1">Messages</h1>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
          Emails and Slack messages you have not replied to, the replies OllieOS has drafted, and emails you sent that are waiting for a reply. Nothing is ever sent for you.
        </p>
      </div>

      <ScrollRow className="-mx-4 px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Message views" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="oo-tab" aria-selected={t.id === tab} onClick={() => go(t.id)} data-testid={'tab-messages-' + t.id}>
              {t.label} <span className="oo-count oo-num">{t.count ?? ''}</span>
            </button>
          ))}
        </div>
      </ScrollRow>

      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: -6 }}>
        {tab === 'waiting' ? (
          <NoReplyTab />
        ) : tab === 'to-answer' ? (
          <>
            <div role="group" aria-label="Show messages from" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {SOURCES.map((s) => (
                <button key={s.id} type="button" className="oo-chip-toggle" aria-pressed={s.id === source} onClick={() => go('to-answer', null, s.id)} data-testid={'button-source-' + s.id}>
                  {s.label} <span className="oo-num">{sourceCount[s.id] ?? ''}</span>
                </button>
              ))}
            </div>
            {source === 'slack' && slackOff ? (
              <SlackNotRead />
            ) : (
              <Mail
                ids={toAnswer.map((it) => it.key)}
                picked={pickedKey}
                wide={wide}
                loading={(showEmail && inbox.isLoading) || (showSlack && slack.q.isLoading)}
                failed={(emailFailed || !showEmail) && (slackFailed || !showSlack)}
                retry={() => {
                  if (showEmail) void inbox.refetch();
                  if (showSlack) void slack.q.refetch();
                }}
                what={source === 'slack' ? 'list of Slack messages' : 'inbox'}
                empty={empty}
                onPick={pickAnswer}
                row={(key, current) => {
                  const it = toAnswer.find((x) => x.key === key)!;
                  const at = toAnswer.indexOf(it);
                  const heading = at === 0 || toAnswer[at - 1].group !== it.group ? ANSWER_GROUPS.find((g) => g.id === it.group)! : null;
                  return (
                    <>
                      {heading && (
                        <span className="oo-mail-group" data-testid={'heading-to-answer-' + it.group}>
                          {heading.label} <span className="oo-num">{toAnswer.filter((x) => x.group === it.group).length}</span>
                        </span>
                      )}
                      {it.source === 'email' ? (
                        <AnswerRow e={it.e} hasDraft={it.e.taskId != null && drafted.has(it.e.taskId)} current={current} onPick={() => go('to-answer', key)} />
                      ) : (
                        <SlackRow s={it.s} current={current} onPick={() => go('to-answer', key)} />
                      )}
                    </>
                  );
                }}
                reader={(_key, next) =>
                  openItem?.source === 'email' ? (
                    <EmailReader
                      taskId={openItem.e.taskId}
                      inbox={openItem.e}
                      mode="answer"
                      hasDraft={openItem.e.taskId != null && drafted.has(openItem.e.taskId)}
                      onBack={() => go('to-answer')}
                      onNext={() => go('to-answer', wide ? next : null)}
                      onBriefed={(taskId) => go('drafts', taskId)}
                    />
                  ) : openItem?.source === 'slack' ? (
                    <SlackReader key={openItem.s.id} s={openItem.s} onBack={() => go('to-answer')} onNext={() => go('to-answer', wide ? next : null)} />
                  ) : (
                    <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>This is not waiting on you any more.</p>
                  )
                }
              />
            )}
            {source === 'all' && slackOff && <SlackNotRead />}
            <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }} data-testid="text-inbox-left-out">
              {showEmail && inbox.data && (
                <>
                  {inbox.data.problem
                    ? `${inbox.data.problem.replace(/\.$/, '')}. This is your inbox as of ${when(inbox.data.checkedAt)}. `
                    : inbox.data.updating
                      ? 'Checking Gmail for new emails. '
                      : `Checked Gmail at ${when(inbox.data.checkedAt)}. `}
                  {inbox.data.leftOut > 0 && `${inbox.data.leftOut === 1 ? '1 newsletter or automatic email is' : `${inbox.data.leftOut} newsletters and automatic emails are`} left out. `}
                  {inbox.data.more && 'Only your newest 200 inbox emails are looked at. '}
                </>
              )}
              {showEmail && emailFailed && !(slackFailed || !showSlack) && 'Gmail could not be loaded, so only Slack messages are shown. '}
              {showSlack && slackRead && slack.q.data && (
                <>
                  {slack.q.data.checkedAt ? `Checked Slack at ${when(slack.q.data.checkedAt)}. ` : 'Slack has not been checked yet. '}
                  Quiet direct messages are looked at every 2 hours, so they can show up to 2 hours late.{' '}
                </>
              )}
              {showSlack && slackFailed && !(emailFailed || !showEmail) && 'Slack could not be loaded, so only emails are shown. '}
              Needs a reply and For your information are OllieOS's best guess.
            </p>
          </>
        ) : (
          <Mail
            ids={draftItems.map((d) => String(d.task.id))}
            picked={picked}
            wide={wide}
            loading={drafts.isLoading}
            failed={!drafts.data && !drafts.isLoading}
            retry={() => drafts.refetch()}
            what="list of drafts"
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
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3 }}>
        <span className="oo-pill" data-source="email">Email</span>
        {e.taskId != null && <span className="oo-pill">Task</span>}
        {hasDraft && <span className="oo-pill">Draft</span>}
      </span>
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
