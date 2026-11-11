import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  draftSlackToAnswerReply,
  ensureSlackToAnswerTask,
  getGetHomeQueryKey,
  getListSlackToAnswerQueryKey,
  markSlackToAnswerDone,
  undoSlackToAnswerDone,
  useListSlackToAnswer,
  type SlackToAnswerItem,
} from '@workspace/api-client-react';
import { formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { IconArrowOut, IconLeft } from '@/components/icons';
import { Mail } from '@/components/mail-layout';
import { reportApiError } from '@/lib/forbidden';
import { copyText } from '@/lib/knowledge';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';

/** Slack to answer in two groups: messages not read by AI count as needing a reply. */
type Group = 'reply' | 'info';
const GROUPS: { id: Group; label: string }[] = [
  { id: 'reply', label: 'Needs a reply' },
  { id: 'info', label: 'For your information' },
];
const groupOf = (s: SlackToAnswerItem): Group => (s.needs === 'info' ? 'info' : 'reply');

function when(at: string): string {
  return londonDate(at) === todayLondon() ? formatTime(at) : formatShort(at);
}

const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Slack to answer, needs a reply first then for information, newest first in each. For the tab count too. */
export function useSlackToAnswer() {
  const q = useListSlackToAnswer({ query: { queryKey: getListSlackToAnswerQueryKey(), refetchInterval: 60_000, staleTime: 20_000, retry: false } });
  const items = useMemo(() => {
    const all = q.data?.items ?? [];
    return GROUPS.flatMap((g) => all.filter((s) => groupOf(s) === g.id));
  }, [q.data]);
  return { q, items, needsReply: items.filter((s) => groupOf(s) === 'reply').length };
}

/**
 * Slack on the Email page (build plan section 19, Part P): direct messages, group DMs and channel
 * mentions where someone else wrote last. The Slack check keeps it up to date; nothing is posted to Slack.
 */
export function SlackTab({ picked, wide, onPick }: { picked: string | null; wide: boolean; onPick: (id: string | null) => void }) {
  const { q, items } = useSlackToAnswer();
  // The message open now, kept after it leaves the list (Done) so Undo still shows.
  const [kept, setKept] = useState<SlackToAnswerItem | null>(null);
  const open = items.find((s) => String(s.id) === picked) ?? (kept && String(kept.id) === picked ? kept : null);
  useEffect(() => {
    if (open && open !== kept) setKept(open);
  }, [open, kept]);

  if (q.data?.readBy === 'claude') {
    return (
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, maxWidth: '64ch' }} data-testid="state-slack-not-read">
        OllieOS is not reading Slack itself yet, so this list is empty. Switch Slack to OllieOS in <Link href="/settings/connectors" className="oo-link">Settings, Connectors</Link>.
      </p>
    );
  }

  return (
    <>
      <Mail
        ids={items.map((s) => String(s.id))}
        picked={picked}
        wide={wide}
        loading={q.isLoading}
        failed={!q.data && !q.isLoading}
        retry={() => q.refetch()}
        what="Slack"
        empty="Nothing to answer on Slack. In every direct message, group DM and mention from the last 14 days, you wrote last."
        onPick={(id) => onPick(id)}
        row={(id, current) => {
          const s = items.find((x) => String(x.id) === id)!;
          const at = items.indexOf(s);
          const group = groupOf(s);
          const heading = at === 0 || groupOf(items[at - 1]) !== group ? GROUPS.find((g) => g.id === group)! : null;
          return (
            <>
              {heading && (
                <span className="oo-mail-group" data-testid={'heading-slack-' + group}>
                  {heading.label} <span className="oo-num">{items.filter((x) => groupOf(x) === group).length}</span>
                </span>
              )}
              <SlackRow s={s} current={current} onPick={() => onPick(id)} />
            </>
          );
        }}
        reader={(_id, next) =>
          open ? (
            <SlackReader key={open.id} s={open} onBack={() => onPick(null)} onNext={() => onPick(wide ? next : null)} />
          ) : (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>This message is not waiting on you any more.</p>
          )
        }
      />
      {q.data && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }} data-testid="text-slack-checked">
          {q.data.checkedAt ? `Checked Slack at ${when(q.data.checkedAt)}. ` : 'Slack has not been checked yet. '}
          Quiet direct messages are looked at every 2 hours, so they can show up to 2 hours late. Needs a reply and For your information are OllieOS's best guess.
        </p>
      )}
    </>
  );
}

const KIND_LABEL: Record<string, string> = { im: 'Direct message', mpim: 'Group DM', channel: 'Mention' };

function SlackRow({ s, current, onPick }: { s: SlackToAnswerItem; current: boolean; onPick: () => void }) {
  return (
    <button type="button" className="oo-mail-row" aria-current={current ? 'true' : undefined} onClick={onPick} data-testid={'row-slack-' + s.id}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="oo-mail-clamp" style={{ fontSize: 14, fontWeight: 600 }}>{s.place}</span>
        <span className="oo-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{when(s.at)}</span>
      </span>
      {s.kind !== 'im' && s.fromName && <span className="oo-mail-clamp" style={{ fontSize: 13, fontWeight: 500 }}>{s.fromName}</span>}
      {s.ask ? (
        <span className="oo-soft oo-mail-clamp" style={{ fontSize: 13 }} data-testid={'text-slack-ask-' + s.id}>{s.ask}</span>
      ) : (
        <span className="oo-muted oo-mail-clamp" style={{ fontSize: 13 }}>{firstLine(s.text)}</span>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3 }}>
        <span className="oo-pill">{KIND_LABEL[s.kind] ?? 'Slack'}</span>
        {s.taskId != null && <span className="oo-pill">Task</span>}
      </span>
    </button>
  );
}

function SlackReader({ s, onBack, onNext }: { s: SlackToAnswerItem; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'done' | 'task' | 'draft' | null>(null);
  const [done, setDone] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const top = useRef<HTMLHeadingElement>(null);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: getListSlackToAnswerQueryKey() }), qc.invalidateQueries({ queryKey: getGetHomeQueryKey() })]);
  };

  const markDone = async () => {
    setBusy('done');
    try {
      const r = await markSlackToAnswerDone(s.id);
      setDone(true);
      await refresh();
      notifyUndo('Marked done', 'It comes back if they write again.', () => {
        void (async () => {
          try {
            await undoSlackToAnswerDone(s.id, r);
            setDone(false);
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

  const writeDraft = async () => {
    setBusy('draft');
    try {
      const r = await draftSlackToAnswerReply(s.id);
      setDraft(r.text);
    } catch (err) {
      reportApiError(err);
      notify('No draft', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (draft == null) return;
    if (await copyText(draft)) notify('Reply copied', 'Paste it into Slack. Nothing was posted.');
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
          {s.taskId != null && (
            <span>
              In OllieOS: <Link href={'/tasks?task=' + s.taskId} className="oo-link" data-testid="link-slack-task">open task</Link>
            </span>
          )}
        </span>
        {s.ask && <span className="oo-soft" style={{ fontSize: 13 }}><span className="oo-muted">{s.needs === 'info' ? 'For your information:' : 'Needs a reply:'}</span> {s.ask}</span>}
      </div>

      {done ? (
        <div className="oo-source" style={{ gap: 10 }} role="status" data-testid="state-slack-done">
          <span style={{ fontSize: 14 }}>Marked done. It comes back if they write again.</span>
          <div><button type="button" className="oo-btn oo-btn-sm oo-btn-ink" onClick={onNext} data-testid="button-slack-next">Next message</button></div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="toolbar" aria-label="Slack actions">
          <button type="button" className="oo-btn oo-btn-sm oo-btn-ink" disabled={busy !== null || s.hidden} onClick={() => void writeDraft()} data-testid="button-slack-draft">
            {busy === 'draft' ? 'Writing…' : draft == null ? 'Draft a reply' : 'Draft again'}
          </button>
          <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void markDone()} data-testid="button-slack-done">Done</button>
          {s.taskId == null && (
            <button type="button" className="oo-btn oo-btn-sm oo-btn-outline" disabled={busy !== null} onClick={() => void makeTask()} data-testid="button-slack-task">Make a task</button>
          )}
          <a href={s.url} target="_blank" rel="noreferrer" className="oo-btn oo-btn-sm oo-btn-outline" style={{ gap: 4 }} data-testid="link-slack-open">
            Open in Slack <IconArrowOut size={12} />
          </a>
        </div>
      )}
      {s.hidden && (
        <span className="oo-muted" style={{ fontSize: 13, lineHeight: 1.5 }} data-testid="text-slack-hidden">
          Someone in this conversation is hidden from AI, so OllieOS has not read it and cannot draft a reply.
        </span>
      )}

      <div className="oo-mail-msg" aria-label="Message">
        <span className="oo-muted" style={{ fontSize: 12 }}>{s.fromName ?? 'Someone'}, {when(s.at)}</span>
        <p className="oo-mail-body" data-testid="text-slack-message">{s.text}</p>
      </div>

      {draft != null && !done && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="card-slack-draft">
          <label className="oo-field-label" htmlFor={'slack-draft-' + s.id}>Reply to copy into Slack</label>
          <textarea id={'slack-draft-' + s.id} className="oo-input" rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ resize: 'vertical', lineHeight: 1.5 }} data-testid="input-slack-draft" />
          <span className="oo-soft" style={{ fontSize: 13 }}>Written in the way you write. Edit it here, then copy it. Nothing is posted to Slack.</span>
          <div><button type="button" className="oo-btn oo-btn-sm oo-btn-ink" onClick={() => void copy()} data-testid="button-slack-copy">Copy reply</button></div>
        </div>
      )}
    </div>
  );
}
