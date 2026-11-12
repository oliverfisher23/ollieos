import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Thumbs } from '@/components/evals';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  allowAskTurn,
  askOllieOS,
  bundleAskTasks,
  draftAskReply,
  getGetAskThreadQueryKey,
  getGetHomeQueryKey,
  getListAskThreadsQueryKey,
  undoAskBundle,
  useGetAskThread,
  useListAskThreads,
  type AskThread,
  type AskTurn,
  type SourceChip,
} from '@workspace/api-client-react';
import { formatDayMonthShort, formatTime } from '@workspace/shared';
import { Logo, Skel } from '@/components/bits';
import { IconLeft, IconLock, IconUp } from '@/components/icons';
import { copyText, firstName, isNotFound } from '@/lib/knowledge';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';
import { initials, toneFor, useInvalidateTasks } from '@/lib/task-cache';

/* Guards the ?q= auto-ask so a re-render or Strict Mode double effect never asks twice. */
const asked = new Set<string>();

export default function AskPage() {
  const params = useParams<{ threadId?: string }>();
  const search = useSearch();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const threadId = params.threadId ? Number(params.threadId) : null;
  const initialQ = threadId ? null : new URLSearchParams(search).get('q')?.trim() || null;

  const thread = useGetAskThread(threadId ?? 0, { query: { enabled: threadId != null && Number.isInteger(threadId) } as never });
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ question: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');

  const send = async (question: string) => {
    setFailed(null);
    setPending(question);
    const parentId = thread.data?.turns.at(-1)?.id ?? null;
    try {
      const res = await askOllieOS({ question, parentId: threadId ? parentId : null });
      qc.setQueryData(getGetAskThreadQueryKey(res.id), { turns: res.turns } satisfies AskThread);
      qc.invalidateQueries({ queryKey: getListAskThreadsQueryKey() });
      setAnnounce('Answer ready');
      navigate('/ask/' + res.id, { replace: true });
    } catch (err) {
      reportApiError(err);
      setFailed({ question, message: errorMessage(err, 'OllieOS could not answer just now. Try again in a moment.') });
    } finally {
      setPending(null);
    }
  };


  useEffect(() => {
    if (!initialQ || asked.has(search)) return;
    asked.add(search);
    void send(initialQ.slice(0, 1000)).finally(() => asked.delete(search));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ, search]);

  const turns = thread.data?.turns ?? [];
  const lastRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  useEffect(() => {
    if (turns.length > prevCount.current && prevCount.current > 0) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      lastRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
    prevCount.current = turns.length;
  }, [turns.length]);

  const showRecent = !threadId && !initialQ;

  return (
    <div className="oo-askpage oo-fade-in" data-testid="page-ask">
      <Link href="/" className="oo-back" style={{ color: 'var(--oo-text-on-dark-2)' }} data-testid="link-back-home"><IconLeft size={14} />Home</Link>
      <span className="oo-sr" role="status" aria-live="polite">{announce}</span>

      {showRecent && <RecentThreads />}

      {threadId != null && thread.isLoading && <AnswerSkeleton />}
      {threadId != null && thread.error && !thread.data && (
        <section className="oo-answer" data-testid={isNotFound(thread.error) ? 'state-thread-not-found' : 'state-thread-error'}>
          <p style={{ margin: 0, fontSize: 16 }}>{isNotFound(thread.error) ? 'That conversation does not exist.' : 'Could not load this conversation.'}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isNotFound(thread.error) && <button type="button" className="oo-btn oo-btn-white" onClick={() => thread.refetch()} data-testid="button-retry-thread">Try again</button>}
            <Link href="/ask" className="oo-btn oo-btn-ghost" data-testid="link-new-question">Ask something new</Link>
          </div>
        </section>
      )}

      {turns.map((t, i) => (
        <div key={t.id} ref={i === turns.length - 1 ? lastRef : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 18, scrollMarginTop: 16 }}>
          <TurnView turn={t} threadKeyId={threadId!} />
        </div>
      ))}

      {pending && (
        <>
          <div className="oo-q" data-testid="text-pending-question">{pending}</div>
          <AnswerSkeleton reading />
        </>
      )}

      {failed && !pending && (
        <>
          <div className="oo-q">{failed.question}</div>
          <section className="oo-answer" role="alert" data-testid="state-ask-error">
            <p style={{ margin: 0, fontSize: 15 }}>{failed.message}</p>
            <div><button type="button" className="oo-btn oo-btn-white" onClick={() => send(failed.question)} data-testid="button-retry-ask">Try again</button></div>
          </section>
        </>
      )}

      {(threadId == null || thread.data) && (
        <AskBox
          busy={!!pending}
          label={turns.length ? 'Ask a follow-up' : 'Ask OllieOS'}
          placeholder={turns.length ? 'Ask a follow-up…' : 'Ask anything you know…  e.g. What do I owe people this week?'}
          autoFocus={showRecent}
          onSend={send}
        />
      )}
    </div>
  );
}

function AnswerSkeleton({ reading }: { reading?: boolean }) {
  return (
    <section className="oo-answer" aria-busy="true" data-testid="state-answer-loading">
      <div className="oo-prov">
        <Logo size={22} radius={7} font={10} />
        {reading ? 'Reading OllieOS…' : 'Loading…'}
      </div>
      <Skel h={16} w="85%" />
      <Skel h={16} w="60%" />
      <Skel h={64} />
    </section>
  );
}

function AskBox({ busy, label, placeholder, autoFocus, onSend }: { busy: boolean; label: string; placeholder: string; autoFocus?: boolean; onSend: (q: string) => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const can = text.trim().length > 0 && !busy;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!can) return;
    onSend(text.trim());
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form className="oo-followup" aria-label={label} onSubmit={submit} data-testid="form-ask">
      <label htmlFor="ask-input" className="oo-sr">{label}</label>
      <textarea
        ref={ref}
        id="ask-input"
        rows={1}
        maxLength={1000}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
        }}
        onKeyDown={onKey}
        data-testid="input-ask"
      />
      <button type="submit" className="oo-send" aria-label="Ask" disabled={!can} data-testid="button-ask">
        <IconUp />
      </button>
    </form>
  );
}

function RecentThreads() {
  const list = useListAskThreads();
  return (
    <section className="oo-answer" aria-labelledby="recent-h" data-testid="list-recent-threads">
      <h1 id="recent-h" style={{ margin: 0, fontSize: 24, fontWeight: 500 }}>Ask OllieOS</h1>
      <p className="oo-t2" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
        Answers come only from your tasks and Knowledge, with a source for every point. Confidential items are never used.
      </p>
      {list.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><Skel h={36} /><Skel h={36} /></div>
      ) : list.error ? (
        <p className="oo-t2" style={{ margin: 0, fontSize: 14 }}>Could not load recent questions.</p>
      ) : list.data?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="oo-label" style={{ fontSize: 12 }}>Recent</span>
          <nav className="oo-recent" aria-label="Recent questions">
            {list.data.map((t) => (
              <Link key={t.id} href={'/ask/' + t.id} style={{ color: 'var(--oo-text-on-dark)' }} data-testid={'link-thread-' + t.id}>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.question}</span>
                <span className="oo-t3" style={{ fontSize: 12, flex: 'none' }}>{formatDayMonthShort(t.createdAt)}, {formatTime(t.createdAt)}</span>
              </Link>
            ))}
          </nav>
        </div>
      ) : (
        <p className="oo-t3" style={{ margin: 0, fontSize: 14 }} data-testid="state-no-threads">No questions yet.</p>
      )}
    </section>
  );
}

function provenance(t: AskTurn): string {
  const conf = t.usedConfidential
    ? t.hiddenMatches
      ? 'confidential items used with your approval, others not used'
      : 'confidential items used with your approval'
    : t.hiddenMatches
      ? 'some confidential items were not used'
      : 'no confidential items used';
  if (t.status === 'not_found') return `Not found in OllieOS · ${conf}`;
  return `Answered from OllieOS · ${t.sourceCount === 1 ? '1 source' : `${t.sourceCount} sources`} · ${conf}`;
}

function Chip({ chip }: { chip: SourceChip }) {
  const body = (
    <>
      {chip.label}
      {chip.confidential && <IconLock size={11} aria-hidden={false} role="img" aria-label="Confidential" />}
    </>
  );
  return chip.path ? (
    <Link href={chip.path} className="oo-src" style={{ color: 'var(--oo-text-on-dark)' }} data-testid={'link-source-' + chip.ref.replace(':', '-')}>{body}</Link>
  ) : (
    <span className="oo-src">{body}</span>
  );
}

function RelatedChip({ chip }: { chip: SourceChip }) {
  const person = chip.type === 'person';
  const id = chip.ref.split(':')[1] ?? chip.ref;
  const body = (
    <>
      {person && (
        <span aria-hidden="true" className="oo-avatar" data-tone={toneFor(Number(id))} style={{ width: 24, height: 24, fontSize: 10 }}>{initials(chip.label)}</span>
      )}
      {chip.label}
    </>
  );
  return chip.path ? (
    <Link href={chip.path} className="oo-rchip" data-avatar={person} style={{ color: 'var(--oo-text-on-dark)' }} data-testid={'link-related-' + chip.ref.replace(':', '-')}>{body}</Link>
  ) : (
    <span className="oo-rchip" data-avatar={person}>{body}</span>
  );
}

function answerText(t: AskTurn): string {
  const lines = [t.question, '', t.summary];
  if (t.items.length) {
    lines.push('');
    for (const i of t.items) {
      const src = i.sources.map((s) => s.label).join('; ');
      lines.push(`- ${i.text}${i.badge ? ` [${i.badge.label}]` : ''}${src ? ` (${src})` : ''}`);
    }
  }
  lines.push('', provenance(t));
  return lines.join('\n');
}

function TurnView({ turn, threadKeyId }: { turn: AskTurn; threadKeyId: number }) {
  const qc = useQueryClient();
  const invalidateTasks = useInvalidateTasks();
  const [showDraft, setShowDraft] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'bundle' | 'undo' | 'allow' | null>(null);
  const [copied, setCopied] = useState<'answer' | 'draft' | null>(null);
  const draftRef = useRef<HTMLDivElement>(null);
  const answered = turn.status === 'answered';
  const to = turn.draftTo ? firstName(turn.draftTo) : null;

  const setThread = (data: AskThread) => qc.setQueryData(getGetAskThreadQueryKey(threadKeyId), data);
  const fail = (err: unknown, title: string) => {
    reportApiError(err);
    notify(title, errorMessage(err));
  };

  const toggleDraft = async () => {
    if (showDraft) return setShowDraft(false);
    if (!turn.draft) {
      setBusy('draft');
      try {
        setThread(await draftAskReply(turn.id));
      } catch (err) {
        setBusy(null);
        return fail(err, 'Could not draft that reply');
      }
      setBusy(null);
    }
    setShowDraft(true);
    setTimeout(() => draftRef.current?.focus(), 0);
  };

  const undo = async () => {
    setBusy('undo');
    try {
      setThread(await undoAskBundle(turn.id));
      invalidateTasks();
      notify('Bundle undone', 'The original tasks are back as they were.');
    } catch (err) {
      fail(err, 'Could not undo that');
    }
    setBusy(null);
  };

  const bundle = async () => {
    setBusy('bundle');
    try {
      const res = await bundleAskTasks(turn.id, {});
      setThread({ turns: res.turns });
      invalidateTasks(res.taskId);
      const title = res.turns.find((t) => t.id === turn.id)?.bundle?.title ?? turn.bundleTitle ?? 'One task';
      notifyUndo('Bundled into one task', title, () => void undo());
    } catch (err) {
      fail(err, 'Could not bundle those tasks');
    }
    setBusy(null);
  };

  const allow = async () => {
    setBusy('allow');
    try {
      setThread(await allowAskTurn(turn.id));
      void qc.invalidateQueries({ queryKey: getGetHomeQueryKey() });
      notify('Allowed for 1 hour', 'Ask OllieOS answered again with those items. You can end it early in Settings.');
    } catch (err) {
      fail(err, 'Could not allow those items');
    }
    setBusy(null);
  };

  const copy = async (what: 'answer' | 'draft', text: string) => {
    if (await copyText(text)) {
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } else {
      notify('Could not copy', 'Your browser blocked the clipboard.');
    }
  };

  const bundled = turn.bundle && !turn.bundle.undone ? turn.bundle : null;

  return (
    <>
      <div className="oo-q" data-testid={'text-question-' + turn.id}>{turn.question}</div>
      <section className="oo-answer" aria-label="Answer" data-testid={'answer-' + turn.id}>
        <div className="oo-prov" data-testid={'text-provenance-' + turn.id}>
          <Logo size={22} radius={7} font={10} />
          {provenance(turn)}
        </div>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }} data-testid={'text-summary-' + turn.id}>{turn.summary}</p>
        <div><Thumbs subject={'ask:' + turn.id} label="Was this answer useful?" /></div>

        {turn.items.length > 0 && (
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {turn.items.map((item, i) => (
              <li key={i} className="oo-ans-item" data-testid={`answer-item-${turn.id}-${i}`}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 320px' }}>
                  <span style={{ fontSize: 15, fontWeight: 500, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{item.text}</span>
                  {item.sources.length > 0 && (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Sources">
                      {item.sources.map((s) => <Chip key={s.ref} chip={s} />)}
                    </span>
                  )}
                </div>
                {item.badge && <span className="oo-badge" data-tone={item.badge.tone}>{item.badge.label}</span>}
              </li>
            ))}
          </ol>
        )}

        {turn.related.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12 }} className="oo-t3">Related</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {turn.related.map((r) => <RelatedChip key={r.ref} chip={r} />)}
            </div>
          </div>
        )}

        {turn.canAllow && turn.hiddenItems.length > 0 && (
          <div className="oo-held" data-testid={'held-' + turn.id}>
            <span style={{ fontSize: 14, lineHeight: 1.5 }}>
              {turn.hiddenItems.length === 1 ? 'This item also matched but is hidden from AI, so it was not used:' : 'These items also matched but are hidden from AI, so they were not used:'}
            </span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {turn.hiddenItems.map((c) => <Chip key={c.ref} chip={c} />)}
            </span>
            <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <button type="button" className="oo-btn oo-btn-white" disabled={busy === 'allow'} onClick={allow} data-testid={'button-allow-' + turn.id}>
                {busy === 'allow' ? 'Answering again…' : 'Allow for this question'}
              </button>
              <span className="oo-t3" style={{ fontSize: 12 }}>Opens them to Ask OllieOS for 1 hour and answers again. Every read is logged.</span>
            </span>
          </div>
        )}

        {answered && (
          <div className="oo-ans-actions">
            {turn.draftTo && (
              <button type="button" className="oo-btn oo-btn-white" aria-expanded={showDraft} disabled={busy === 'draft'} onClick={toggleDraft} data-testid={'button-draft-' + turn.id}>
                {busy === 'draft' ? 'Drafting…' : showDraft ? 'Hide draft' : `Draft a reply to ${to}`}
              </button>
            )}
            {turn.canBundle && !bundled && (
              <button type="button" className="oo-btn oo-btn-ghost" disabled={busy === 'bundle'} onClick={bundle} data-testid={'button-bundle-' + turn.id}>
                {busy === 'bundle' ? 'Bundling…' : 'Bundle into one task'}
              </button>
            )}
            <button type="button" className="oo-btn oo-btn-ghost" onClick={() => copy('answer', answerText(turn))} data-testid={'button-copy-answer-' + turn.id}>
              {copied === 'answer' ? 'Copied' : 'Copy answer'}
            </button>
          </div>
        )}

        {bundled && (
          <div className="oo-ans-item" style={{ alignItems: 'center' }} data-testid={'state-bundled-' + turn.id}>
            <span style={{ fontSize: 14, minWidth: 0, flex: '1 1 260px' }}>
              Bundled into one task:{' '}
              {bundled.task ? (
                <Link href={'/tasks?task=' + bundled.task.id} style={{ color: 'var(--oo-text-on-dark)' }} data-testid={'link-bundle-task-' + turn.id}>{bundled.task.title}</Link>
              ) : (
                bundled.title
              )}
            </span>
            {bundled.canUndo && (
              <button type="button" className="oo-btn oo-btn-ghost" disabled={busy === 'undo'} onClick={undo} data-testid={'button-undo-bundle-' + turn.id}>
                {busy === 'undo' ? 'Undoing…' : 'Undo'}
              </button>
            )}
          </div>
        )}

        {showDraft && turn.draft && (
          <div ref={draftRef} tabIndex={-1} className="oo-draft" style={{ outline: 'none' }} data-testid={'draft-' + turn.id}>
            <span style={{ fontSize: 12 }} className="oo-muted">Draft · to {turn.draft.to ?? turn.draftTo} · not sent</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{turn.draft.text}</span>
            <div>
              <button type="button" className="oo-btn oo-btn-outline" onClick={() => copy('draft', turn.draft!.text)} data-testid={'button-copy-draft-' + turn.id}>
                {copied === 'draft' ? 'Copied' : 'Copy draft'}
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
