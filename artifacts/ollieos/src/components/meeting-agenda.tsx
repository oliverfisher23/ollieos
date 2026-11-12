import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  clearAgendaChat,
  getGetMeetingQueryKey,
  setLeftoverDropped,
  shapeAgenda,
  updateMeetingNotes,
  useGetMeeting,
  type AgendaTurn,
  type MeetingView,
} from '@workspace/api-client-react';
import { errorMessage, notify } from '@/lib/notify';
import { Skel } from '@/components/bits';
import { AgendaEditorBox, appendAgendaItem, replaceAgenda, useAgendaEditor } from '@/components/rich-agenda';
import { formatDayMonth } from '@workspace/shared';
import { AddIdea, type AgendaHandle } from '@/components/agenda-ideas';

const finePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

const CARD = { background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)' } as const;

/**
 * A meeting's agenda, shaped with AI. Ollie drops thoughts on the left; the agenda on the right is
 * rewritten from them and stays his to edit. The next message starts from his edited version.
 * Used on the prep page and on a meeting with no prep page, because the agenda lives on the meeting.
 */
const plain = (t: string) => t.toLowerCase().replace(/[*_`#>\[\]()]/g, '').replace(/\s+/g, ' ').trim();

export function MeetingAgenda({ eventId, ideas }: { eventId: number; ideas?: (agenda: AgendaHandle) => ReactNode }) {
  const q = useGetMeeting(eventId, { query: { queryKey: getGetMeetingQueryKey(eventId) } });
  if (q.isLoading) return <section style={{ ...CARD, padding: '26px 30px' }}><Skel h={180} /></section>;
  if (!q.data) {
    return (
      <section style={{ ...CARD, padding: '26px 30px' }}>
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>The agenda could not be loaded. <button type="button" className="oo-mini" onClick={() => q.refetch()}>Try again</button></p>
      </section>
    );
  }
  return <Agenda key={eventId} m={q.data} ideas={ideas} />;
}

function Agenda({ m, ideas }: { m: MeetingView; ideas?: (agenda: AgendaHandle) => ReactNode }) {
  const qc = useQueryClient();
  const key = getGetMeetingQueryKey(m.id);
  const [text, setText] = useState(m.notes ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saved = useRef(m.notes ?? '');
  const [chat, setChat] = useState<AgendaTurn[]>(m.agendaChat);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const [droppedLeft, setDroppedLeft] = useState<number[]>([]);
  const editor = useAgendaEditor({ initial: m.notes ?? '', placeholder: 'Your agenda appears here. Edit it freely, or write your own.', onChange: setText });

  useEffect(() => {
    editor.setEditable(!busy);
  }, [editor, busy]);

  const remember = (patch: Partial<MeetingView>) => qc.setQueryData(key, (old: MeetingView | undefined) => (old ? { ...old, ...patch } : old));

  // Hand edits save a moment after Ollie stops typing; nothing saves while the writer is working.
  useEffect(() => {
    if (busy || text === saved.current) return;
    const t = setTimeout(async () => {
      setState('saving');
      try {
        const r = await updateMeetingNotes(m.id, { notes: text.trim() ? text : null });
        saved.current = text;
        remember({ notes: r.notes });
        setState('saved');
      } catch (err) {
        setState('error');
        notify('Could not save the agenda', errorMessage(err));
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, busy, m.id]);

  // Leaving the page, or closing the tab, before the pause is up still saves what was typed.
  const latest = useRef({ text, busy });
  latest.current = { text, busy };
  useEffect(() => {
    const flush = () => {
      const { text: t, busy: b } = latest.current;
      if (b || t === saved.current) return;
      const before = saved.current;
      saved.current = t;
      updateMeetingNotes(m.id, { notes: t.trim() ? t : null }, { keepalive: true })
        .then((r) => remember({ notes: r.notes }))
        .catch(() => {
          saved.current = before;
        });
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [chat.length, busy]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      const r = await shapeAgenda(m.id, { message, agenda: text });
      saved.current = r.agenda;
      replaceAgenda(editor, r.agenda);
      setText(r.agenda);
      setPrevious(r.previous);
      setChat(r.chat);
      setDraft('');
      setState('saved');
      remember({ notes: r.agenda, agendaChat: r.chat });
    } catch (err) {
      notify('Could not shape the agenda', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // On a keyboard, Enter sends; on a phone it is a new line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && finePointer()) {
      e.preventDefault();
      void send();
    }
  };

  const startAgain = async () => {
    try {
      await clearAgendaChat(m.id);
      setChat([]);
      setPrevious(null);
      remember({ agendaChat: [] });
    } catch (err) {
      notify('Could not start again', errorMessage(err));
    }
  };

  const undo = () => {
    if (previous == null) return;
    replaceAgenda(editor, previous);
    setText(previous);
    setPrevious(null);
  };

  const handle: AgendaHandle = {
    busy,
    add: (item) => {
      if (!busy) appendAgendaItem(editor, item.trim());
    },
    has: (item) => plain(text).includes(plain(item)),
  };
  const extra = ideas?.(handle);
  const left = (m.leftovers?.items ?? []).filter((i) => !droppedLeft.includes(i.index));
  const dropLeft = async (index: number) => {
    if (!m.leftovers) return;
    setDroppedLeft((xs) => [...xs, index]);
    try {
      await setLeftoverDropped(m.leftovers.eventId, index, { dropped: true });
    } catch (err) {
      setDroppedLeft((xs) => xs.filter((x) => x !== index));
      notify('That did not save', errorMessage(err));
    }
  };

  return (
    <section aria-labelledby="agenda-h" style={{ ...CARD, padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="section-agenda">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 id="agenda-h" className="oo-h2">Agenda</h2>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span role="status" className="oo-muted" style={{ fontSize: 12 }} data-testid="text-notes-state">
            {busy ? 'Shaping…' : state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : ''}
          </span>
          {chat.length > 0 && <button type="button" className="oo-mini" onClick={startAgain} disabled={busy} data-testid="button-agenda-start-again">Start again</button>}
        </span>
      </div>

      {(left.length > 0 || extra) && (
        <div className="oo-agenda-ideas" data-testid="section-agenda-ideas">
          {left.length > 0 && m.leftovers && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="list-agenda-leftovers">
              <span className="oo-field-label">
                Not covered last time ({formatDayMonth(m.leftovers.startsAt)})
              </span>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {left.map((it) => (
                  <li key={it.index} className="oo-idea-row" data-testid={'item-leftover-' + it.index}>
                    <span style={{ flex: '1 1 220px', lineHeight: 1.5, minWidth: 0 }}>
                      {it.title}
                      {it.note && <span className="oo-muted"> · {it.note}</span>}
                    </span>
                    <span style={{ display: 'flex', gap: 4 }}>
                      <AddIdea agenda={handle} text={it.title} testId={'leftover-' + it.index} />
                      <button type="button" className="oo-mini" onClick={() => dropLeft(it.index)} data-testid={'button-leftover-drop-' + it.index}>Drop</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {extra}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'stretch' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="oo-field-label">Your thoughts</span>
          <div ref={log} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }} aria-live="polite" data-testid="list-agenda-chat">
            {chat.length === 0 && !busy && (
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                Drop what you want from this meeting, in any order. OllieOS shapes it into an agenda you can edit, and changes it as you add more.
              </p>
            )}
            {chat.map((t, i) => (
              <p
                key={i}
                style={{
                  margin: 0,
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  ...(t.role === 'ollie'
                    ? { alignSelf: 'flex-end', maxWidth: '90%', padding: '8px 12px', borderRadius: 'var(--oo-r-card-sm)', background: 'var(--oo-field)' }
                    : { color: 'var(--oo-ink-soft)' }),
                }}
                data-testid={'agenda-turn-' + i}
              >
                {t.text}
              </p>
            ))}
            {busy && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Shaping the agenda…</p>}
          </div>
          <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="agenda-thoughts" className="sr-only">Your thoughts on this meeting</label>
            <textarea
              id="agenda-thoughts"
              className="oo-input"
              rows={3}
              maxLength={4000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder={chat.length ? 'Add or change something' : 'What you want to cover, decide or ask'}
              style={{ resize: 'vertical', padding: '10px 12px', borderRadius: 'var(--oo-r-input-lg)', lineHeight: 1.5 }}
              data-testid="input-agenda-thoughts"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="oo-muted hidden sm:inline" style={{ fontSize: 12 }}>Enter to send, Shift and Enter for a new line</span>
              <span className="sm:hidden" />
              <button type="submit" style={{ whiteSpace: 'nowrap' }} className="oo-btn oo-btn-ink" disabled={busy || !draft.trim()} data-testid="button-agenda-send">
                {busy ? 'Shaping…' : text.trim() ? 'Update agenda' : 'Shape agenda'}
              </button>
            </div>
          </form>
        </div>

        <div style={{ flex: '2 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <span className="oo-field-label">The agenda</span>
            {previous != null && !busy && (
              <button type="button" className="oo-mini" onClick={undo} data-testid="button-agenda-undo">Undo AI change</button>
            )}
          </div>
          <AgendaEditorBox editor={editor} busy={busy} />
        </div>
      </div>
    </section>
  );
}
