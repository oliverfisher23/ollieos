import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useListPeople, useListTasks, type Task, type TriageInputAction } from '@workspace/api-client-react';
import { SOURCE_LABELS, formatDayMonth, formatTime, todayLondon } from '@workspace/shared';
import { Skel, SourceMark } from '@/components/bits';
import { IconLeft } from '@/components/icons';
import { NoiseRuleChooser } from '@/components/noise-rule-chooser';
import { useTaskActions } from '@/lib/task-actions';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';

type Action = TriageInputAction;

const BUTTONS: { action: Action; label: string; key: string }[] = [
  { action: 'now', label: 'Now', key: 'N' },
  { action: 'backlog', label: 'Backlog', key: 'B' },
  { action: 'waiting', label: 'Waiting', key: 'W' },
  { action: 'noise', label: 'Noise', key: 'X' },
];
const KEY_ACTION: Record<string, Action> = { n: 'now', b: 'backlog', w: 'waiting', x: 'noise' };
const DONE_LABEL: Record<Action, string> = {
  now: 'Moved to Now',
  backlog: 'Moved to Backlog',
  waiting: 'Moved to Waiting on',
  noise: 'Moved to Noise',
};

function when(t: Task) {
  const at = t.capturedAt ?? t.createdAt;
  const day = new Date(at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  return day === todayLondon() ? formatTime(at) : formatDayMonth(at);
}

function isTyping(el: EventTarget | null) {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
}

/** One Inbox item at a time. A dialog over Home on desktop, full screen on a phone. */
export function TriageDialog({ onClose }: { onClose: () => void }) {
  const phone = useMedia(PHONE_QUERY);
  const inbox = useListTasks({ tab: 'inbox' });
  const people = useListPeople();
  const actions = useTaskActions();

  // Items handled in this session, newest last, so Undo can walk back through them.
  const [handled, setHandled] = useState<Task[]>([]);
  // An undone item goes back to the front of the queue, even before the list refetches.
  const [front, setFront] = useState<Task | null>(null);
  const [last, setLast] = useState<{ task: Task; action: Action } | null>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');

  const handledIds = new Set(handled.map((t) => t.id));
  const fresh = (inbox.data ?? []).filter((t) => !handledIds.has(t.id) && t.status === 'inbox');
  const frontFresh = front ? fresh.find((t) => t.id === front.id) ?? front : null;
  const queue = frontFresh ? [frontFresh, ...fresh.filter((t) => t.id !== frontFresh.id)] : fresh;
  const current = queue[0] ?? null;
  const total = handled.length + queue.length;
  const position = handled.length + 1;
  const progress = total ? Math.round((handled.length / total) * 100) : 100;
  const loading = inbox.isLoading;
  const clear = !loading && !inbox.error && !current;

  // When the queue empties or refills, the focused button disappears; keep focus inside the dialog.
  const panelRef = useRef<HTMLDivElement>(null);
  const wasClear = useRef<boolean | null>(null);
  useEffect(() => {
    if (loading) return undefined;
    if (wasClear.current !== null && wasClear.current !== clear) {
      // Deferred so it lands after the dialog's own focus handling for removed elements.
      const sel = clear ? '[data-testid="button-triage-home"]' : '[data-testid="button-triage-now"]';
      const id = setTimeout(() => panelRef.current?.querySelector<HTMLElement>(sel)?.focus(), 0);
      wasClear.current = clear;
      return () => clearTimeout(id);
    }
    wasClear.current = clear;
    return undefined;
  }, [clear, loading]);

  const act = async (action: Action) => {
    if (!current || busy) return;
    setBusy(true);
    const res = await actions.triage(current, { action }, { toast: false });
    setBusy(false);
    if (!res) return;
    const next = queue[1];
    setHandled((h) => [...h, current]);
    setFront(null);
    setLast({ task: res.task, action });
    setAnnounce(`${DONE_LABEL[action]}. ` + (next ? `Next, ${position + 1} of ${total}: ${next.title}` : 'Inbox clear.'));
  };

  const undo = async () => {
    const prev = handled[handled.length - 1];
    if (!prev || busy) return;
    setBusy(true);
    const t = await actions.undo(prev);
    setBusy(false);
    if (!t) return;
    setHandled((h) => h.slice(0, -1));
    setFront(t);
    setLast(null);
    setAnnounce(`Undone. Back to ${prev.title}`);
  };

  const changeWaiting = async (personId: number | null) => {
    if (!last || busy) return;
    setBusy(true);
    const res = await actions.triage(last.task, { action: 'waiting', waitingOnPersonId: personId }, { toast: false });
    setBusy(false);
    if (res) setLast({ task: res.task, action: 'waiting' });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (KEY_ACTION[k]) {
      e.preventDefault();
      void act(KEY_ACTION[k]);
    } else if (k === 'u') {
      e.preventDefault();
      void undo();
    }
  };

  const undoButton = handled.length > 0 && (
    <button type="button" className="oo-tri-undo" onClick={undo} disabled={busy} data-testid="button-triage-undo">
      Undo last{phone ? '' : ' (U)'}
    </button>
  );

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-tri-scrim">
          <Dialog.Content ref={panelRef} className="oo-tri-panel oo-fade-in" onKeyDown={onKeyDown}
            aria-describedby={current ? 'tri-current' : undefined} data-testid="dialog-triage">
            {phone ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Dialog.Close className="oo-tri-back" data-testid="button-triage-close"><IconLeft size={18} />Home</Dialog.Close>
                <Dialog.Title className="oo-num" style={{ margin: 0, fontSize: 14, fontWeight: 400, color: 'var(--oo-text-on-dark-2)' }}>
                  <span className="oo-sr">Triage, </span>
                  {clear ? 'Done' : loading ? '' : `${position} of ${total}`}
                </Dialog.Title>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Dialog.Title style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                  Triage{' '}
                  <span className="oo-num" style={{ fontWeight: 400, color: 'var(--oo-text-on-dark-3)' }} data-testid="text-triage-position">
                    {clear ? '' : loading ? '' : `${position} of ${total}`}
                  </span>
                </Dialog.Title>
                <Dialog.Close className="oo-btn oo-btn-ghost" style={{ borderRadius: 'var(--oo-r-full)', minHeight: 32, padding: '6px 12px' }} data-testid="button-triage-close">Close</Dialog.Close>
              </div>
            )}

            <div className="oo-tri-bar" aria-hidden="true"><div style={{ width: progress + '%' }} /></div>
            <p role="status" className="oo-sr" data-testid="text-triage-announce">{announce}</p>

            {loading ? (
              <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skel h={12} w={180} /><Skel h={26} w="80%" /><Skel h={14} /><Skel h={44} />
              </div>
            ) : inbox.error ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-triage-error">
                <p style={{ margin: 0, fontSize: 14 }}>Could not load the Inbox.</p>
                <button type="button" className="oo-btn oo-btn-white" onClick={() => inbox.refetch()} data-testid="button-retry-triage">Try again</button>
              </div>
            ) : clear ? (
              <div className="oo-tri-clear" data-testid="state-triage-clear">
                <p className="oo-serif" style={{ margin: 0, fontSize: phone ? 34 : 26 }}>Inbox clear.</p>
                {handled.length > 0 && (
                  <p className="oo-t2" style={{ margin: 0, fontSize: 14 }}>
                    {handled.length === 1 ? '1 item triaged.' : `${handled.length} items triaged.`}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: phone ? 'center' : 'flex-start' }}>
                  <Dialog.Close className="oo-btn oo-btn-white" style={{ borderRadius: 'var(--oo-r-full)' }} data-testid="button-triage-home">Back to Home</Dialog.Close>
                </div>
                {last && <LastStrip last={last} people={people.data ?? []} busy={busy} onWaiting={changeWaiting} />}
                {undoButton}
              </div>
            ) : current ? (
              <>
                <section className="oo-tri-item" aria-label="Inbox item" data-testid={'triage-item-' + current.id}>
                  <span className="oo-tri-meta">
                    <SourceMark source={current.source} size={phone ? 26 : 22} />
                    {[SOURCE_LABELS[current.source], current.fromName, when(current)].filter(Boolean).join(' · ')}
                  </span>
                  <p id="tri-current" className="oo-tri-title" data-testid="text-triage-title">{current.title}</p>
                  {(current.snippet ?? current.sourceQuote) && <p className="oo-tri-snippet">{current.snippet ?? current.sourceQuote}</p>}
                  {current.suggestedAction && (
                    <span className="oo-tri-suggest" data-testid="text-triage-suggest">Suggested: <b>{current.suggestedAction}</b></span>
                  )}
                </section>
                <div className="oo-tri-actions" role="group" aria-label="Move this item to">
                  {BUTTONS.map((b) => (
                    <button key={b.action} type="button" className="oo-tri-btn" data-primary={b.action === 'now'} disabled={busy}
                      aria-keyshortcuts={b.key} onClick={() => act(b.action)} data-testid={'button-triage-' + b.action}>
                      {b.label}
                      {!phone && <span className="oo-tri-key" aria-hidden="true">{b.key}</span>}
                    </button>
                  ))}
                </div>
                {last && <LastStrip last={last} people={people.data ?? []} busy={busy} onWaiting={changeWaiting} />}
                {undoButton}
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What just happened to the previous item, with the follow-up choices that action allows. */
function LastStrip({
  last,
  people,
  busy,
  onWaiting,
}: {
  last: { task: Task; action: Action };
  people: { id: number; name: string }[];
  busy: boolean;
  onWaiting: (id: number | null) => void;
}) {
  const t = last.task;
  return (
    <div className="oo-tri-last" data-testid="strip-triage-last">
      <span className="oo-t2" style={{ fontSize: 13 }}>
        {DONE_LABEL[last.action]}: <span style={{ color: 'var(--oo-text-on-dark)' }}>{t.title}</span>
      </span>
      {last.action === 'waiting' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="tri-waiting" className="oo-t2" style={{ fontSize: 13 }}>Waiting on</label>
          <select id="tri-waiting" className="oo-tri-input" style={{ width: 'auto', minWidth: 180 }} disabled={busy}
            value={t.waitingOn?.id ?? ''} onChange={(e) => onWaiting(e.target.value ? Number(e.target.value) : null)} data-testid="select-triage-waiting">
            <option value="">Nobody chosen yet</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {last.action === 'noise' && <NoiseRuleChooser key={t.id} task={t} dark toast={false} />}
    </div>
  );
}
