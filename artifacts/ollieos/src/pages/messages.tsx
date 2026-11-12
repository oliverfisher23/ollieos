import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
import {
  getGetHomeQueryKey,
  getGetMessageCountsQueryKey,
  getListEmailDraftsQueryKey,
  getListEmailInboxQueryKey,
  getListSlackToAnswerQueryKey,
  markMessagesDone,
  refreshSlackToAnswer,
  undoMessagesDone,
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
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';
import { useInvalidateTasks } from '@/lib/task-cache';
import { useMedia } from '@/lib/use-media';
import { NoReplyTab } from '@/pages/email-no-reply';
import { SlackNotRead, SlackReader, SlackRow, slackGroupOf, useSlackToAnswer } from '@/pages/email-slack';

type Tab = 'to-answer' | 'drafts' | 'waiting';
const TABS: Tab[] = ['to-answer', 'drafts', 'waiting'];

/** To answer shows email and Slack together; these narrow it to one. */
type Source = 'all' | 'email' | 'slack';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'email', label: 'Email' },
  { id: 'slack', label: 'Slack' },
];

/** Where each draft is: the Drafts tab lists them in this order, Slack replies last. */
type DraftStage = 'writing' | 'ready' | 'saved' | 'slack';
const STAGES: { id: DraftStage; label: string }[] = [
  { id: 'writing', label: 'Writing' },
  { id: 'ready', label: 'Ready to look at' },
  { id: 'saved', label: 'Saved to Gmail' },
  { id: 'slack', label: 'Slack replies to copy' },
];
const stageOf = (d: EmailDraftItem['draft']): DraftStage => (d.state === 'ready' ? (d.savedAt ? 'saved' : 'ready') : 'writing');

/** One row on Drafts: an email draft (d:{taskId}) or a Slack reply (s:{id}). */
type DraftItem = { key: string; stage: DraftStage; email: EmailDraftItem } | { key: string; stage: 'slack'; slack: SlackToAnswerItem };

const WIDE = '(min-width: 1024px)';

/**
 * To answer in three groups: messages not read yet, or not read by AI, count as needing a reply;
 * then for information; then those hidden until a later day.
 */
type AnswerGroup = 'reply' | 'info' | 'later';
const ANSWER_GROUPS: { id: AnswerGroup; label: string }[] = [
  { id: 'reply', label: 'Needs a reply' },
  { id: 'info', label: 'For your information' },
  { id: 'later', label: 'Hidden until later' },
];
const groupOf = (e: EmailInboxItem): AnswerGroup => (e.snoozedUntil ? 'later' : e.needs === 'info' ? 'info' : 'reply');

/** One row on To answer: an email thread or a Slack message. Keys are t:{threadId} and s:{id}. */
type Item = { key: string; at: string; group: AnswerGroup; priority: string | null; later: string | null } & (
  | { source: 'email'; e: EmailInboxItem }
  | { source: 'slack'; s: SlackToAnswerItem }
);
const emailItem = (e: EmailInboxItem): Item => ({ key: 't:' + e.threadId, source: 'email', at: e.at, group: groupOf(e), priority: e.priority, later: e.snoozedUntil, e });
const slackItem = (s: SlackToAnswerItem): Item => ({ key: 's:' + s.id, source: 'slack', at: s.at, group: s.snoozedUntil ? 'later' : slackGroupOf(s), priority: s.priority, later: s.snoozedUntil, s });

/**
 * Needs a reply: clients and people Ollie is overdue to contact first, then newest first. For your
 * information: newest first. Hidden until later: soonest back first.
 */
function inOrder(a: Item, b: Item): number {
  if (a.group === 'reply' && !!a.priority !== !!b.priority) return a.priority ? -1 : 1;
  if (a.group === 'later' && a.later !== b.later) return (a.later ?? '').localeCompare(b.later ?? '');
  return b.at.localeCompare(a.at);
}

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
    if (key.startsWith('s:')) p.set('slack', key.slice(2));
    else if (tab === 'to-answer') p.set('thread', key.replace(/^t:/, ''));
    else p.set('id', key.replace(/^d:/, ''));
  }
  return '/messages?' + p.toString();
}

/** Typing in a field, or inside a menu or dialog: keys there are not shortcuts. */
function typing(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('[role="dialog"], [role="listbox"], [role="menu"], [cmdk-root]'));
}

/** Presses a button in the reading pane, for a keyboard shortcut. */
function press(...testIds: string[]): boolean {
  const btn = document.querySelector<HTMLButtonElement>(testIds.map((t) => `.oo-mail-read [data-testid="${t}"]:not(:disabled)`).join(', '));
  btn?.click();
  return !!btn;
}

/**
 * Messages: everything waiting on Ollie, wherever it came from. To answer is the Gmail inbox, read or
 * unread, where the last message is not from Ollie, and Slack messages where someone else wrote last,
 * in one list; then the replies OllieOS has drafted, for email and for Slack; then emails and Slack
 * messages Ollie sent that nobody answered. OllieOS never sends email or posts to Slack.
 */
export default function MessagesPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const invalidateTasks = useInvalidateTasks();
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
  const pickedKey = pickedSlack ? 's:' + pickedSlack : tab === 'drafts' ? (picked ? 'd:' + picked : null) : pickedThread ? 't:' + pickedThread : null;
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
  const slackDrafts = slackRead ? slack.drafts : [];
  const draftItems = useMemo(() => {
    const items: DraftItem[] = [
      ...(drafts.data?.items ?? []).map((d): DraftItem => ({ key: 'd:' + d.task.id, stage: stageOf(d.draft), email: d })),
      ...slackDrafts.map((s): DraftItem => ({ key: 's:' + s.id, stage: 'slack', slack: s })),
    ];
    return STAGES.flatMap((st) => items.filter((d) => d.stage === st.id));
  }, [drafts.data, slackDrafts]);
  // An email with a draft on Drafts is not also To answer, unless it is the one open now.
  const drafted = useMemo(() => new Set((drafts.data?.items ?? []).map((d) => d.task.id)), [drafts.data]);
  const emails = useMemo(
    () => (inbox.data?.items ?? []).filter((e) => e.taskId == null || !drafted.has(e.taskId) || (tab === 'to-answer' && e.threadId === pickedThread)),
    [inbox.data, drafted, tab, pickedThread],
  );
  const slackItems = slackRead ? slack.items : [];
  const emailsNeedingReply = emails.filter((e) => groupOf(e) === 'reply').length;
  const slackNeedingReply = slackItems.filter((s) => !s.snoozedUntil && slackGroupOf(s) === 'reply').length;
  const toAnswer = useMemo(() => {
    const items: Item[] = [
      ...(source === 'slack' ? [] : emails.map(emailItem)),
      ...(source === 'email' ? [] : slackItems.map(slackItem)),
    ];
    return ANSWER_GROUPS.flatMap((g) => items.filter((it) => it.group === g.id).sort(inOrder));
  }, [emails, slackItems, source]);

  // The item open now, kept after it leaves the list (Done, Noise, Later) so Undo and noise rules still show.
  const [kept, setKept] = useState<Item | null>(null);
  const openItem = toAnswer.find((it) => it.key === pickedKey) ?? (kept?.key === pickedKey ? kept : null);
  useEffect(() => {
    if (openItem && openItem !== kept) setKept(openItem);
  }, [openItem, kept]);

  const go = useCallback((next: Tab, key?: string | number | null, from: Source = source) => navigate(messagesHref(next, key == null ? null : String(key), from), { replace: true }), [navigate, source]);
  const pickAnswer = useCallback((key: string) => go('to-answer', key), [go]);
  const pickDraft = useCallback((key: string) => go('drafts', key), [go]);

  // A Slack message opened on To answer that has a draft is on Drafts: open it there.
  useEffect(() => {
    if (tab === 'to-answer' && pickedSlack && slackDrafts.some((s) => String(s.id) === pickedSlack)) go('drafts', 's:' + pickedSlack);
  }, [tab, pickedSlack, slackDrafts, go]);

  // Keys: J and K move through the list, E marks the open message done, R starts a reply.
  const listKeys = useMemo(() => (tab === 'to-answer' ? toAnswer.map((it) => it.key) : tab === 'drafts' ? draftItems.map((d) => d.key) : null), [tab, toAnswer, draftItems]);
  useEffect(() => {
    if (!listKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        const at = pickedKey ? listKeys.indexOf(pickedKey) : -1;
        const next = listKeys[key === 'j' ? Math.min(at + 1, listKeys.length - 1) : Math.max(at - 1, 0)];
        if (next && next !== pickedKey) go(tab, next);
        e.preventDefault();
      } else if (key === 'e') {
        if (press('button-email-done', 'button-slack-done')) e.preventDefault();
      } else if (key === 'r') {
        if (press('button-email-brief', 'button-slack-brief')) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listKeys, pickedKey, tab, go]);

  const refreshLists = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: getListEmailInboxQueryKey() }),
        qc.invalidateQueries({ queryKey: getListSlackToAnswerQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetMessageCountsQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetHomeQueryKey() }),
      ]),
    [qc],
  );

  // Mark all done, on For your information: every one listed, with one Undo.
  const [clearing, setClearing] = useState(false);
  const clearGroup = async (group: AnswerGroup) => {
    const items = toAnswer.filter((it) => it.group === group);
    if (!items.length) return;
    setClearing(true);
    try {
      const r = await markMessagesDone({
        threadIds: items.flatMap((it) => (it.source === 'email' ? [it.e.threadId] : [])),
        slackIds: items.flatMap((it) => (it.source === 'slack' ? [it.s.id] : [])),
      });
      const tasks = [...r.emails, ...r.slack].flatMap((x) => (x.taskId != null ? [x.taskId] : []));
      const after = async () => {
        await refreshLists();
        tasks.forEach((id) => invalidateTasks(id));
      };
      await after();
      const count = r.emails.length + r.slack.length;
      notifyUndo(count === 1 ? '1 message marked done' : `${count} messages marked done`, 'Each comes back if a new message arrives.', () => {
        void undoMessagesDone(r).then(after, (err) => {
          reportApiError(err);
          notify('That did not undo', errorMessage(err));
        });
      });
      if (items.some((it) => it.key === pickedKey)) go('to-answer');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setClearing(false);
    }
  };

  // Check now: Gmail is looked at again when the last look is not fresh; Slack's listed conversations always.
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      if (slackRead) await refreshSlackToAnswer().catch(reportApiError);
      await Promise.all([inbox.refetch(), slack.q.refetch()]);
    } finally {
      setChecking(false);
    }
  };

  const toAnswerCount = inbox.data || slackRead ? emailsNeedingReply + slackNeedingReply : undefined;
  const tabs: { id: Tab; label: string; count: number | undefined }[] = [
    { id: 'to-answer', label: 'To answer', count: toAnswerCount },
    { id: 'drafts', label: 'Drafts', count: drafts.data ? draftItems.length : undefined },
    { id: 'waiting', label: 'Waiting for a reply', count: review.data?.noReplyDue || undefined },
  ];
  const sourceCount: Record<Source, number | undefined> = {
    all: toAnswerCount,
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
          Emails and Slack messages you have not replied to, the replies OllieOS has drafted, and messages you sent that are waiting for a reply. Nothing is ever sent for you.
        </p>
      </div>

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" style={{ marginTop: -6 }}>
        <div role="tablist" aria-label="Message views" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)', minWidth: 'max-content' }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="oo-tab" aria-selected={t.id === tab} onClick={() => go(t.id)} data-testid={'tab-messages-' + t.id}>
              {t.label} <span className="oo-count oo-num">{t.count ?? ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label} style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: -6 }}>
        {tab === 'waiting' ? (
          <NoReplyTab />
        ) : tab === 'to-answer' ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
              <div role="group" aria-label="Show messages from" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {SOURCES.map((s) => (
                  <button key={s.id} type="button" className="oo-chip-toggle" aria-pressed={s.id === source} onClick={() => go('to-answer', null, s.id)} data-testid={'button-source-' + s.id}>
                    {s.label} <span className="oo-num">{sourceCount[s.id] ?? ''}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" disabled={checking} onClick={() => void checkNow()} data-testid="button-messages-check">
                {checking ? 'Checking…' : 'Check now'}
              </button>
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
                what={source === 'slack' ? 'Slack' : 'your inbox'}
                empty={empty}
                onPick={pickAnswer}
                row={(key, current) => {
                  const it = toAnswer.find((x) => x.key === key)!;
                  const at = toAnswer.indexOf(it);
                  const heading = at === 0 || toAnswer[at - 1].group !== it.group ? ANSWER_GROUPS.find((g) => g.id === it.group)! : null;
                  return (
                    <>
                      {heading && (
                        <span className="oo-mail-group" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }} data-testid={'heading-to-answer-' + it.group}>
                          <span>
                            {heading.label} <span className="oo-num">{toAnswer.filter((x) => x.group === it.group).length}</span>
                          </span>
                          {it.group === 'info' && (
                            <button type="button" className="oo-link" style={{ font: 'inherit', textTransform: 'none', letterSpacing: 0, fontSize: 12, background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                              disabled={clearing} onClick={() => void clearGroup('info')} data-testid="button-mark-all-done">
                              {clearing ? 'Marking…' : 'Mark all done'}
                            </button>
                          )}
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
                      onBriefed={(taskId) => go('drafts', 'd:' + taskId)}
                    />
                  ) : openItem?.source === 'slack' ? (
                    <SlackReader key={openItem.s.id} s={openItem.s} onBack={() => go('to-answer')} onNext={() => go('to-answer', wide ? next : null)} onDrafted={() => go('drafts', openItem.key)} />
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
                  {inbox.data.leftOut > 0 && `${inbox.data.leftOut === 1 ? '1 newsletter, automatic or muted email is' : `${inbox.data.leftOut} newsletters, automatic and muted emails are`} left out. `}
                  {inbox.data.more && 'Only your newest 200 inbox emails are looked at. '}
                </>
              )}
              {showEmail && emailFailed && !(slackFailed || !showSlack) && 'Gmail could not be loaded, so only Slack messages are shown. '}
              {showSlack && slackRead && slack.q.data && (
                <>
                  {slack.q.data.updating
                    ? 'Looking at Slack again for your replies. '
                    : slack.q.data.checkedAt
                      ? `Slack was last read for new messages at ${when(slack.q.data.checkedAt)}; your own replies are looked for whenever this page is open. `
                      : 'Slack has not been checked yet. '}
                  Quiet direct messages are looked at every 2 hours, so they can show up to 2 hours late.{' '}
                </>
              )}
              {showSlack && slackFailed && !(emailFailed || !showEmail) && 'Slack could not be loaded, so only emails are shown. '}
              Needs a reply and For your information are OllieOS's best guess. Clients and people you are overdue to contact come first.
              {wide && ' Keys: J and K move between messages, E marks one done, R starts a reply.'}
            </p>
          </>
        ) : (
          <Mail
            ids={draftItems.map((d) => d.key)}
            picked={pickedKey}
            wide={wide}
            loading={drafts.isLoading}
            failed={!drafts.data && !drafts.isLoading}
            retry={() => drafts.refetch()}
            what="drafts"
            empty="No drafts waiting. Brief a reply to a message from To answer, or chase one from Waiting for a reply. An email draft leaves this list when you send an email in its thread, when its task is closed, or when you mark it done; a Slack reply leaves when you answer in Slack."
            onPick={pickDraft}
            row={(key, current) => {
              const it = draftItems.find((x) => x.key === key)!;
              const at = draftItems.indexOf(it);
              const heading = at === 0 || draftItems[at - 1].stage !== it.stage ? STAGES.find((s) => s.id === it.stage)!.label : null;
              return (
                <>
                  {heading && <span className="oo-mail-group" data-testid={'heading-drafts-' + it.stage}>{heading}</span>}
                  {'email' in it ? <DraftRow it={it.email} current={current} onPick={() => go('drafts', key)} /> : <SlackRow s={it.slack} current={current} onPick={() => go('drafts', key)} />}
                </>
              );
            }}
            reader={(key, next) => {
              const it = draftItems.find((x) => x.key === key);
              if (it && 'slack' in it) return <SlackReader key={it.slack.id} s={it.slack} onBack={() => go('drafts')} onNext={() => go('drafts', wide ? next : null)} />;
              if (key.startsWith('s:')) return <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>This draft is not here any more. You answered in Slack, or removed it.</p>;
              return <EmailReader taskId={Number(key.replace(/^d:/, ''))} mode="draft" chase={it?.email.chase ?? false} onBack={() => go('drafts')} onNext={() => go('drafts', wide ? next : null)} />;
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
        {e.priority && <span className="oo-pill" data-tone="now" data-testid={'pill-priority-' + e.threadId}>{e.priority}</span>}
        {e.snoozedUntil && <span className="oo-pill">Back {formatShort(e.snoozedUntil)}</span>}
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
