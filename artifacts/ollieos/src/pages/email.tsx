import { useCallback, useEffect, useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  getListEmailDraftsQueryKey,
  useListEmailDrafts,
  useListReview,
  useListTasks,
  type EmailDraftItem,
  type Task,
} from '@workspace/api-client-react';
import { formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { EmailReader } from '@/components/email-reader';
import { LockMark } from '@/components/knowledge/parts';
import { PageProblem } from '@/components/knowledge/parts';
import { useMedia } from '@/lib/use-media';
import { NoReplyTab } from '@/pages/email-no-reply';

type Tab = 'to-answer' | 'drafts' | 'waiting';
const TABS: Tab[] = ['to-answer', 'drafts', 'waiting'];

/** Where each draft is: the Drafts tab lists them in this order. */
type DraftStage = 'writing' | 'ready' | 'saved';
const STAGES: { id: DraftStage; label: string }[] = [
  { id: 'writing', label: 'Writing' },
  { id: 'ready', label: 'Ready to look at' },
  { id: 'saved', label: 'Saved to Gmail' },
];
const stageOf = (d: EmailDraftItem['draft']): DraftStage => (d.state === 'ready' ? (d.savedAt ? 'saved' : 'ready') : 'writing');

/** Open email tasks Ollie still has to deal with; Waiting on ones are with someone else. */
const TO_ANSWER: Task['status'][] = ['inbox', 'now', 'backlog'];
/**
 * Tasks the Gmail check found in an email Ollie sent himself (marked "You", with no address):
 * a waiting-on or a promise, never an email to answer. Emails he sent that expect a reply are
 * on Waiting for a reply.
 */
const sentByOllie = (t: Task) => !t.fromAddress && t.fromName === 'You';
const WIDE = '(min-width: 1024px)';

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
 * Email: a small email client over OllieOS. Emails waiting on Ollie, the replies OllieOS has
 * drafted, and emails Ollie sent that nobody answered. Tasks stay the record; this is a view of
 * them. OllieOS never sends email.
 */
export default function EmailPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get('tab');
  // Old links to No reply yet open Waiting for a reply.
  const asked = (raw === 'no-reply' ? 'waiting' : raw) as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : 'to-answer';
  const picked = Number(params.get('id')) || null;
  const wide = useMedia(WIDE);

  const tasks = useListTasks({ tab: 'open', source: 'email' });
  // While a draft is being written, look again every few seconds.
  const drafts = useListEmailDrafts({
    query: { queryKey: getListEmailDraftsQueryKey(), refetchInterval: (q) => (q.state.data?.items.some((d) => d.draft.state === 'writing') ? 3_000 : false) },
  });
  const review = useListReview();
  const draftItems = useMemo(() => {
    const items = drafts.data?.items ?? [];
    return STAGES.flatMap((s) => items.filter((d) => stageOf(d.draft) === s.id));
  }, [drafts.data]);
  // An email with a draft on Drafts is not also To answer, unless it is the one open now.
  const drafted = useMemo(() => new Set(draftItems.map((d) => d.task.id)), [draftItems]);
  const toAnswer = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => TO_ANSWER.includes(t.status) && !sentByOllie(t) && (!drafted.has(t.id) || (tab === 'to-answer' && t.id === picked)))
        .sort((a, b) => new Date(b.capturedAt ?? b.createdAt).getTime() - new Date(a.capturedAt ?? a.createdAt).getTime()),
    [tasks.data, drafted, tab, picked],
  );

  const go = useCallback((next: Tab, id?: number | null) => navigate(`/email?tab=${next}${id ? `&id=${id}` : ''}`, { replace: true }), [navigate]);
  const pickAnswer = useCallback((id: number) => go('to-answer', id), [go]);
  const pickDraft = useCallback((id: number) => go('drafts', id), [go]);

  const tabs: { id: Tab; label: string; count: number | undefined }[] = [
    { id: 'to-answer', label: 'To answer', count: tasks.data ? toAnswer.length : undefined },
    { id: 'drafts', label: 'Drafts', count: drafts.data?.items.length },
    { id: 'waiting', label: 'Waiting for a reply', count: review.data?.noReplyDue || undefined },
  ];

  return (
    <main className="oo-panel oo-kmain oo-fade-in" data-testid="page-email">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <h1 className="oo-h1">Email</h1>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
          Emails waiting on you, the replies OllieOS has drafted, and emails you sent that are waiting for a reply. Nothing is ever sent for you.
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
        ) : tab === 'to-answer' ? (
          <Mail
            ids={toAnswer.map((t) => t.id)}
            picked={picked}
            wide={wide}
            loading={tasks.isLoading}
            failed={!tasks.data && !tasks.isLoading}
            retry={() => tasks.refetch()}
            what="emails to answer"
            empty="Nothing to answer. Emails that need something from you show here once a Gmail check brings them in."
            onPick={pickAnswer}
            row={(id, current) => {
              const t = toAnswer.find((x) => x.id === id)!;
              const d = draftItems.find((x) => x.task.id === id);
              return <AnswerRow t={t} hasDraft={!!d} current={current} onPick={() => go('to-answer', id)} />;
            }}
            reader={(id, next) => (
              <EmailReader
                taskId={id}
                mode="answer"
                hasDraft={draftItems.some((x) => x.task.id === id)}
                onBack={() => go('to-answer')}
                onNext={() => go('to-answer', wide ? next : null)}
                onBriefed={() => go('drafts', id)}
              />
            )}
          />
        ) : (
          <Mail
            ids={draftItems.map((d) => d.task.id)}
            picked={picked}
            wide={wide}
            loading={drafts.isLoading}
            failed={!drafts.data && !drafts.isLoading}
            retry={() => drafts.refetch()}
            what="drafts"
            empty="No drafts waiting. Brief a reply to an email from To answer, or chase one from Waiting for a reply. A draft leaves this list when you send an email in its thread, when its task is closed, or when you mark it done."
            onPick={pickDraft}
            row={(id, current) => {
              const it = draftItems.find((x) => x.task.id === id)!;
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
              const it = draftItems.find((x) => x.task.id === id);
              return <EmailReader taskId={id} mode="draft" chase={it?.chase ?? false} onBack={() => go('drafts')} onNext={() => go('drafts', wide ? next : null)} />;
            }}
          />
        )}
      </div>
    </main>
  );
}

/**
 * The list and the reading pane side by side on wide screens; one at a time on narrow ones.
 * On wide screens the first email opens when none is picked.
 */
function Mail({ ids, picked, wide, loading, failed, retry, what, empty, onPick, row, reader }: {
  ids: number[];
  picked: number | null;
  wide: boolean;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  what: string;
  empty: string;
  onPick: (id: number) => void;
  row: (id: number, current: boolean) => React.ReactNode;
  reader: (id: number, next: number | null) => React.ReactNode;
}) {
  // Wide screens open the first email, and put it in the address so it stays open once dealt with.
  const first = ids[0];
  useEffect(() => {
    if (wide && picked == null && first != null) onPick(first);
  }, [wide, picked, first, onPick]);

  if (loading) {
    return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skel key={i} h={64} />)}</div>;
  }
  if (failed) return <PageProblem notFound={false} what={what} onRetry={retry} back={{ href: '/tasks', label: 'Tasks' }} />;
  // An email just dealt with stays open (to undo or add a noise rule) though it has left the list.
  const open = picked;
  if (ids.length === 0 && open == null) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }} data-testid={'state-email-empty'}>{empty}</p>;
  }
  const at = open != null ? ids.indexOf(open) : -1;
  const next = at >= 0 ? (ids[at + 1] ?? ids[at - 1] ?? null) : (ids[0] ?? null);

  return (
    <div className="oo-mail" data-open={open != null ? 'true' : 'false'}>
      <ul className="oo-mail-list" aria-label="Emails">
        {ids.map((id) => <li key={id}>{row(id, id === open)}</li>)}
        {ids.length === 0 && <li className="oo-muted" style={{ padding: 14, fontSize: 13 }}>{empty}</li>}
      </ul>
      <section className="oo-mail-read" aria-label="Reading pane">
        {open != null ? reader(open, next === open ? null : next) : null}
      </section>
    </div>
  );
}

function AnswerRow({ t, hasDraft, current, onPick }: { t: Task; hasDraft: boolean; current: boolean; onPick: () => void }) {
  const from = t.fromName ?? t.fromAddress ?? 'Unknown sender';
  return (
    <button type="button" className="oo-mail-row" aria-current={current ? 'true' : undefined} onClick={onPick} data-testid={'row-to-answer-' + t.id}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="oo-mail-clamp" style={{ fontSize: 14, fontWeight: 600 }}>{from}</span>
        <span className="oo-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{when(t.capturedAt ?? t.createdAt)}</span>
      </span>
      <span className="oo-mail-clamp" style={{ fontSize: 13, fontWeight: 500, display: '-webkit-box' }}>
        {t.confidential && <LockMark />} {t.sourceSubject ?? t.title}
      </span>
      <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>{t.snippet ? firstLine(t.snippet) : t.title}</span>
      {(t.status !== 'inbox' || hasDraft) && (
        <span style={{ display: 'flex', gap: 6, marginTop: 3 }}>
          {t.status === 'now' && <span className="oo-pill">Now</span>}
          {t.status === 'backlog' && <span className="oo-pill">Backlog</span>}
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
        <span className="oo-pill">{it.chase ? 'Chase' : 'Reply'}</span>
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
