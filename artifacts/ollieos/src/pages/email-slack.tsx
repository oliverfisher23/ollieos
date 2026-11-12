import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  draftSlackToAnswerReply,
  ensureSlackToAnswerTask,
  getGetHomeQueryKey,
  getGetMessageCountsQueryKey,
  getGetSlackConversationQueryKey,
  getListSlackToAnswerQueryKey,
  markSlackToAnswerDone,
  muteFromMessages,
  removeSlackToAnswerDraft,
  saveSlackToAnswerDraft,
  snoozeSlackToAnswer,
  undoSlackToAnswerDone,
  updateNoiseRule,
  useGetSlackConversation,
  useListSlackToAnswer,
  type SlackToAnswerItem,
} from '@workspace/api-client-react';
import { formatLong, formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { IconArrowOut, IconLeft } from '@/components/icons';
import { LaterPicker } from '@/components/later-picker';
import { reportApiError } from '@/lib/forbidden';
import { copyText } from '@/lib/knowledge';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';

/** Slack messages to answer, listed with emails on the Messages page's To answer tab. In two groups: messages not read by AI count as needing a reply. */
type Group = 'reply' | 'info';
export const slackGroupOf = (s: SlackToAnswerItem): Group => (s.needs === 'info' ? 'info' : 'reply');

function when(at: string): string {
  return londonDate(at) === todayLondon() ? formatTime(at) : formatShort(at);
}

const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Slack messages waiting on Ollie, newest first. `items` are those on To answer (no draft yet);
 * `drafts` are those with a reply drafted, which are on Drafts instead. While the list is being
 * looked at again, ask every few seconds.
 */
export function useSlackToAnswer() {
  const q = useListSlackToAnswer({
    query: { queryKey: getListSlackToAnswerQueryKey(), refetchInterval: (query) => (query.state.data?.updating ? 4_000 : 60_000), staleTime: 20_000, retry: false },
  });
  const all = q.data?.items;
  const items = useMemo(() => (all ?? []).filter((s) => s.draft == null), [all]);
  const drafts = useMemo(() => (all ?? []).filter((s) => s.draft != null), [all]);
  return { q, items, drafts };
}

/** The note shown where Slack would be while Claude, not OllieOS, reads Slack. */
export function SlackNotRead() {
  return (
    <p className="oo-muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, maxWidth: '64ch' }} data-testid="state-slack-not-read">
      OllieOS is not reading Slack itself yet, so no Slack messages are listed. Switch Slack to OllieOS in <Link href="/settings/connectors" className="oo-link">Settings, Connectors</Link>.
    </p>
  );
}

export const KIND_LABEL: Record<string, string> = { im: 'Direct message', mpim: 'Group DM', channel: 'Mention' };

export function SlackRow({ s, current, onPick }: { s: SlackToAnswerItem; current: boolean; onPick: () => void }) {
  return (
    <button type="button" className="oo-mail-row" aria-current={current ? 'true' : undefined} onClick={onPick} data-testid={'row-slack-' + s.id}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="oo-mail-clamp" style={{ fontSize: 14, fontWeight: 600 }}>{s.place}</span>
        <span className="oo-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{when(s.at)}</span>
      </span>
      {s.kind !== 'im' && s.fromName && <span className="oo-mail-clamp" style={{ fontSize: 13, fontWeight: 500 }}>{s.fromName}</span>}
      {s.draft ? (
        <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>{firstLine(s.draft.text) || 'Empty draft'}</span>
      ) : s.ask ? (
        <span className="oo-soft oo-mail-clamp" style={{ fontSize: 13 }} data-testid={'text-slack-ask-' + s.id}>{s.ask}</span>
      ) : (
        <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>{firstLine(s.text)}</span>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3 }}>
        <span className="oo-pill" data-source="slack">Slack · {KIND_LABEL[s.kind] ?? 'Message'}</span>
        {s.priority && <span className="oo-pill" data-tone="now" data-testid={'pill-priority-slack-' + s.id}>{s.priority}</span>}
        {s.snoozedUntil && <span className="oo-pill">Back {formatShort(s.snoozedUntil)}</span>}
        {s.draft && <span className="oo-pill">Copy to send</span>}
        {s.taskId != null && <span className="oo-pill">Task</span>}
      </span>
    </button>
  );
}

/** The last few messages of the conversation, read from Slack; the saved message while that loads or when it fails. */
function Conversation({ s }: { s: SlackToAnswerItem }) {
  const q = useGetSlackConversation(s.id, { query: { queryKey: getGetSlackConversationQueryKey(s.id), staleTime: 60_000, retry: false } });
  if (q.isLoading) return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><Skel h={56} /><Skel h={72} /></div>;
  const messages = q.data?.messages ?? [{ fromName: s.fromName ?? 'Someone', fromOllie: false, at: s.at, text: s.text }];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Conversation" data-testid="list-slack-conversation">
      {q.data && !q.data.fromSlack && <span className="oo-muted" style={{ fontSize: 12 }}>Slack could not be read just now, so this is the message OllieOS kept.</span>}
      {messages.map((m, i) => (
        <div key={i} className="oo-mail-msg" data-from={m.fromOllie ? 'ollie' : 'other'}>
          <span className="oo-muted" style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 600, color: 'var(--oo-ink)' }}>{m.fromOllie ? 'You' : m.fromName}</span>, {when(m.at)}
          </span>
          <p className="oo-mail-body" data-testid={i === messages.length - 1 ? 'text-slack-message' : undefined}>{m.text}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The reading pane for a Slack message: the conversation, then Brief a reply, Draft a reply, Done,
 * Later, Make a task and Mute. A draft is kept on the message, so it shows on Drafts until Ollie
 * answers in Slack or removes it. Nothing is ever posted to Slack: a reply is copied.
 */
export function SlackReader({ s, onBack, onNext, onDrafted }: { s: SlackToAnswerItem; onBack: () => void; onNext: () => void; onDrafted?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'done' | 'task' | 'draft' | 'later' | 'mute' | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [brief, setBrief] = useState('');
  const [change, setChange] = useState('');
  // The draft as typed; saved a moment after typing stops.
  const [text, setText] = useState(s.draft?.text ?? '');
  const saved = useRef(s.draft?.text ?? '');
  const top = useRef<HTMLHeadingElement>(null);
  const hasDraft = s.draft != null;

  // A draft written or changed by OllieOS replaces what is typed; Ollie's own typing is left alone.
  useEffect(() => {
    const next = s.draft?.text ?? '';
    if (next !== saved.current) {
      saved.current = next;
      setText(next);
    }
  }, [s.draft?.text, s.draft?.updatedAt]);

  useEffect(() => {
    if (!hasDraft || text === saved.current) return;
    const t = setTimeout(() => {
      const sending = text;
      saveSlackToAnswerDraft(s.id, { text: sending }).then(
        () => {
          saved.current = sending;
        },
        (err) => reportApiError(err),
      );
    }, 800);
    return () => clearTimeout(t);
  }, [text, hasDraft, s.id]);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListSlackToAnswerQueryKey() }),
      qc.invalidateQueries({ queryKey: getGetHomeQueryKey() }),
      qc.invalidateQueries({ queryKey: getGetMessageCountsQueryKey() }),
    ]);
  };

  const markDone = async () => {
    setBusy('done');
    try {
      const r = await markSlackToAnswerDone(s.id);
      void refresh();
      notifyUndo('Marked done', 'It comes back if they write again.', () => {
        void (async () => {
          try {
            await undoSlackToAnswerDone(s.id, r);
            await refresh();
          } catch (err) {
            reportApiError(err);
            notify('Could not undo', errorMessage(err));
          }
        })();
      });
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
      return;
    } finally {
      setBusy(null);
    }
    // Straight on to the next message, as Done on an email does; Undo is on the note.
    onNext();
  };

  const later = async (until: string | null) => {
    setBusy('later');
    try {
      await snoozeSlackToAnswer(s.id, { until });
      void refresh();
      if (until) {
        notifyUndo(`Hidden until ${formatLong(until)}`, 'It comes back sooner if they write again.', () => {
          void snoozeSlackToAnswer(s.id, { until: null }).then(refresh, (err) => {
            reportApiError(err);
            notify('Could not undo', errorMessage(err));
          });
        });
        onNext();
      } else notify('Back on To answer', undefined);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const mute = async () => {
    setBusy('mute');
    try {
      const r = await muteFromMessages({ matchType: 'slack_channel_equals', matchValue: s.place });
      void refresh();
      notifyUndo(`Muted ${s.place}`, 'Mentions there no longer show on Messages or become tasks. Turn it back on in Settings, Noise rules.', () => {
        void updateNoiseRule(r.rule.id, { enabled: false }).then(refresh, (err) => {
          reportApiError(err);
          notify('Could not undo', errorMessage(err));
        });
      });
      onNext();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const makeTask = async () => {
    setBusy('task');
    try {
      await ensureSlackToAnswerTask(s.id);
      await refresh();
      notify('Added to Now', `Reply to ${s.fromName ?? s.place} on Slack.`);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Writes the draft, from a brief, as a change to the one there, or from the conversation alone. */
  const writeDraft = async (opts: { brief?: string; change?: string } = {}) => {
    setBusy('draft');
    try {
      const first = !hasDraft;
      const d = await draftSlackToAnswerReply(s.id, opts);
      saved.current = d.text;
      setText(d.text);
      setBriefing(false);
      setBrief('');
      setChange('');
      await refresh();
      if (first) {
        notify('Draft written', 'It is on Drafts until you answer in Slack. Nothing was posted.');
        onDrafted?.();
      }
    } catch (err) {
      reportApiError(err);
      notify('No draft', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeDraft = async () => {
    setBusy('draft');
    try {
      await removeSlackToAnswerDraft(s.id);
      await refresh();
      notify('Draft removed', 'The message is back on To answer.');
      onNext();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (await copyText(text)) notify('Reply copied', 'Paste it into Slack. Nothing was posted.');
    else notify('Could not copy', 'Your browser blocked the clipboard.');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }} data-testid={'reader-slack-' + s.id}>
      <button type="button" className="oo-mail-back oo-btn oo-btn-outline oo-btn-sm" style={{ alignSelf: 'flex-start', gap: 4 }} onClick={onBack} data-testid="button-slack-back">
        <IconLeft size={14} /> All messages
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 ref={top} style={{ margin: 0, fontSize: 21, fontWeight: 600, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }} data-testid="text-slack-place">{s.place}</h2>
        <span className="oo-muted" style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'baseline' }}>
          <span>
            {KIND_LABEL[s.kind] ?? 'Slack'}
            {s.fromName && (
              <>
                {' from '}
                {s.personSlug ? <Link href={'/knowledge/people/' + s.personSlug} className="oo-link">{s.fromName}</Link> : s.fromName}
              </>
            )}
            , {when(s.at)}
          </span>
          {s.priority && <span className="oo-pill" data-tone="now">{s.priority}</span>}
          {s.snoozedUntil && <span data-testid="text-slack-snoozed">Hidden until {formatLong(s.snoozedUntil)}</span>}
          {s.taskId != null && (
            <span>
              In OllieOS: <Link href={'/tasks?task=' + s.taskId} className="oo-link" data-testid="link-slack-task">open task</Link>
            </span>
          )}
        </span>
        {s.ask && <span className="oo-soft" style={{ fontSize: 13 }}><span className="oo-muted">{s.needs === 'info' ? 'For your information:' : 'Needs a reply:'}</span> {s.ask}</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }} role="toolbar" aria-label="Slack actions">
        {!hasDraft && !briefing && (
          <>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" disabled={busy !== null || s.hidden} onClick={() => setBriefing(true)} data-testid="button-slack-brief">Brief a reply</button>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null || s.hidden} onClick={() => void writeDraft()} data-testid="button-slack-draft">
              {busy === 'draft' ? 'Writing…' : 'Draft a reply'}
            </button>
          </>
        )}
        <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void markDone()} data-testid="button-slack-done">Done</button>
        {s.snoozedUntil ? (
          <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void later(null)} data-testid="button-slack-back-now">Bring back</button>
        ) : (
          <LaterPicker what={`the message from ${s.fromName ?? s.place}`} disabled={busy !== null} onPick={(d) => void later(d)} testId="button-slack-later" />
        )}
        {s.taskId == null && (
          <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void makeTask()} data-testid="button-slack-task">Make a task</button>
        )}
        {s.kind === 'channel' && (
          <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void mute()} data-testid="button-slack-mute">Mute {s.place}</button>
        )}
        <a href={s.url} target="_blank" rel="noreferrer" className="oo-btn oo-btn-sm oo-btn-outline" style={{ gap: 4 }} data-testid="link-slack-open">
          Open in Slack <IconArrowOut size={12} />
        </a>
      </div>
      {s.hidden && (
        <span className="oo-muted" style={{ fontSize: 13, lineHeight: 1.5 }} data-testid="text-slack-hidden">
          Someone in this conversation is hidden from AI, so OllieOS has not read it and cannot draft a reply.
        </span>
      )}

      {briefing && !hasDraft && (
        <form className="oo-source" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (brief.trim()) void writeDraft({ brief: brief.trim() }); }} data-testid="form-slack-brief">
          <label htmlFor={'slack-brief-' + s.id} style={{ fontSize: 14, fontWeight: 600 }}>What should the reply say?</label>
          <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>One line is enough. OllieOS writes it in the way you write, for you to copy into Slack. Nothing is posted.</span>
          <input id={'slack-brief-' + s.id} className="oo-input" autoFocus value={brief} maxLength={500} onChange={(e) => setBrief(e.target.value)}
            placeholder="For example: yes, I will send it by Friday" data-testid="input-slack-brief" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="submit" className="oo-btn oo-btn-sm oo-btn-ink" disabled={busy !== null || !brief.trim()} data-testid="button-slack-brief-send">{busy === 'draft' ? 'Writing…' : 'Write the draft'}</button>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" onClick={() => setBriefing(false)} data-testid="button-slack-brief-cancel">Cancel</button>
          </div>
        </form>
      )}

      <Conversation s={s} />

      {hasDraft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="card-slack-draft">
          <label className="oo-field-label" htmlFor={'slack-draft-' + s.id}>Reply to copy into Slack</label>
          <textarea id={'slack-draft-' + s.id} className="oo-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} style={{ resize: 'vertical', lineHeight: 1.5 }} data-testid="input-slack-draft" />
          <span className="oo-soft" style={{ fontSize: 13 }}>
            {s.draft?.brief ? `From your brief: ${s.draft.brief}. ` : ''}Edit it here; it is saved as you type and stays on Drafts until you answer in Slack. Nothing is posted to Slack.
          </span>
          <form style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (change.trim()) void writeDraft({ change: change.trim() }); }}>
            <input className="oo-input" style={{ flex: '1 1 220px', minWidth: 0 }} value={change} maxLength={500} onChange={(e) => setChange(e.target.value)} aria-label="What to change about the draft"
              placeholder="For example: shorter, warmer, say no politely" data-testid="input-slack-change" />
            <button type="submit" className="oo-btn oo-btn-outline" disabled={busy !== null || !change.trim() || s.hidden} data-testid="button-slack-change">{busy === 'draft' && change ? 'Changing…' : 'Change it'}</button>
          </form>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" disabled={!text.trim()} onClick={() => void copy()} data-testid="button-slack-copy">Copy reply</button>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null || s.hidden} onClick={() => void writeDraft()} data-testid="button-slack-draft">
              {busy === 'draft' && !change ? 'Writing…' : 'Write again'}
            </button>
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void removeDraft()} data-testid="button-slack-remove-draft">Remove draft</button>
          </div>
        </div>
      )}
    </div>
  );
}
