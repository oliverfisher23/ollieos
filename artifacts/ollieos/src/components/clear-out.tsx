import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useGetClearOut, type Task } from '@workspace/api-client-react';
import { PRIORITY_LABELS, REPEAT_SHORT, formatDayMonth, formatShort } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { IconLeft } from '@/components/icons';
import { useTaskActions } from '@/lib/task-actions';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';

type Action = 'keep' | 'now' | 'archived' | 'dropped' | 'done';

const BUTTONS: { action: Action; label: string; key: string }[] = [
  { action: 'keep', label: 'Keep', key: 'K' },
  { action: 'now', label: 'Do next', key: 'N' },
  { action: 'archived', label: 'Archive', key: 'A' },
  { action: 'dropped', label: 'Drop', key: 'D' },
  { action: 'done', label: 'Done', key: 'E' },
];
const KEY_ACTION: Record<string, Action> = { k: 'keep', n: 'now', a: 'archived', d: 'dropped', e: 'done' };
const DONE_LABEL: Record<Action, string> = {
  keep: 'Kept in the Backlog',
  now: 'Moved to Now',
  archived: 'Archived',
  dropped: 'Dropped',
  done: 'Marked done',
};

function isTyping(el: EventTarget | null) {
  return el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
}

/**
 * The Backlog clear-out: every Backlog task untouched for 30 days, one at a time, oldest first.
 * Keep starts its 30 days again; the rest move it on. Built like Triage.
 */
export function ClearOutDialog({ onClose }: { onClose: () => void }) {
  const phone = useMedia(PHONE_QUERY);
  const list = useGetClearOut();
  const actions = useTaskActions();

  // Handled this session, newest last, with what was done so Undo can walk back.
  const [handled, setHandled] = useState<{ task: Task; action: Action }[]>([]);
  const [front, setFront] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');

  const handledIds = new Set(handled.map((h) => h.task.id));
  const fresh = (list.data?.tasks ?? []).filter((t) => !handledIds.has(t.id) && t.status === 'backlog');
  const queue = front ? [front, ...fresh.filter((t) => t.id !== front.id)] : fresh;
  const current = queue[0] ?? null;
  const total = handled.length + queue.length;
  const position = handled.length + 1;
  const progress = total ? Math.round((handled.length / total) * 100) : 100;
  const loading = list.isLoading;
  const clear = !loading && !list.error && !current;

  const panelRef = useRef<HTMLDivElement>(null);
  const wasClear = useRef<boolean | null>(null);
  useEffect(() => {
    if (loading) return undefined;
    if (wasClear.current !== null && wasClear.current !== clear) {
      // Deferred so it lands after the dialog's own focus handling for removed elements.
      const sel = clear ? '[data-testid="button-clear-out-finish"]' : '[data-testid="button-clear-out-keep"]';
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
    const res =
      action === 'keep'
        ? await actions.keepInBacklog(current)
        : action === 'done'
          ? await actions.markDone(current, { toast: false })
          : await actions.setStatus(current, action, { toast: false });
    setBusy(false);
    if (!res) return;
    const next = queue[1];
    setHandled((h) => [...h, { task: current, action }]);
    setFront(null);
    setAnnounce(`${DONE_LABEL[action]}. ` + (next ? `Next, ${position + 1} of ${total}: ${next.title}` : 'Backlog cleared out.'));
  };

  const undo = async () => {
    const prev = handled[handled.length - 1];
    if (!prev || busy) return;
    // Keep only restarted its clock, so there is nothing to put back on the server.
    if (prev.action !== 'keep') {
      setBusy(true);
      const t = await actions.undo(prev.task);
      setBusy(false);
      if (!t) return;
    }
    setHandled((h) => h.slice(0, -1));
    setFront(prev.task);
    setAnnounce(`Undone. Back to ${prev.task.title}`);
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

  const counts = handled.reduce<Partial<Record<Action, number>>>((m, h) => ({ ...m, [h.action]: (m[h.action] ?? 0) + 1 }), {});
  const summary = (
    [
      ['keep', 'kept'],
      ['now', 'moved to Now'],
      ['archived', 'archived'],
      ['dropped', 'dropped'],
      ['done', 'done'],
    ] as const
  )
    .filter(([a]) => counts[a])
    .map(([a, word]) => `${counts[a]} ${word}`)
    .join(', ');

  const last = handled[handled.length - 1];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-tri-scrim">
          <Dialog.Content ref={panelRef} className="oo-tri-panel oo-fade-in" onKeyDown={onKeyDown}
            aria-describedby={current ? 'co-current' : undefined} data-testid="dialog-clear-out">
            {phone ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Dialog.Close className="oo-tri-back" data-testid="button-clear-out-close"><IconLeft size={18} />Back</Dialog.Close>
                <Dialog.Title className="oo-num" style={{ margin: 0, fontSize: 14, fontWeight: 400, color: 'var(--oo-text-on-dark-2)' }}>
                  <span className="oo-sr">Backlog clear-out, </span>
                  {clear ? 'Done' : loading ? '' : `${position} of ${total}`}
                </Dialog.Title>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Dialog.Title style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                  Clear out your Backlog{' '}
                  <span className="oo-num" style={{ fontWeight: 400, color: 'var(--oo-text-on-dark-3)' }} data-testid="text-clear-out-position">
                    {clear || loading ? '' : `${position} of ${total}`}
                  </span>
                </Dialog.Title>
                <Dialog.Close className="oo-btn oo-btn-ghost" style={{ borderRadius: 'var(--oo-r-full)', minHeight: 32, padding: '6px 12px' }} data-testid="button-clear-out-close">Close</Dialog.Close>
              </div>
            )}

            <div className="oo-tri-bar" aria-hidden="true"><div style={{ width: progress + '%' }} /></div>
            <p role="status" className="oo-sr" data-testid="text-clear-out-announce">{announce}</p>

            {loading ? (
              <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skel h={12} w={180} /><Skel h={26} w="80%" /><Skel h={14} /><Skel h={44} />
              </div>
            ) : list.error ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-clear-out-error">
                <p style={{ margin: 0, fontSize: 14 }}>Could not load the Backlog.</p>
                <button type="button" className="oo-btn oo-btn-white" onClick={() => list.refetch()} data-testid="button-retry-clear-out">Try again</button>
              </div>
            ) : clear ? (
              <div className="oo-tri-clear" data-testid="state-clear-out-done">
                <p className="oo-serif" style={{ margin: 0, fontSize: phone ? 34 : 26 }}>
                  {handled.length ? 'Backlog cleared out.' : 'Nothing to clear out.'}
                </p>
                <p className="oo-t2" style={{ margin: 0, fontSize: 14 }} data-testid="text-clear-out-summary">
                  {handled.length ? summary.charAt(0).toUpperCase() + summary.slice(1) + '.' : 'Every Backlog task has been touched in the last 30 days.'}
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: phone ? 'center' : 'flex-start' }}>
                  <Dialog.Close className="oo-btn oo-btn-white" style={{ borderRadius: 'var(--oo-r-full)' }} data-testid="button-clear-out-finish">Finish</Dialog.Close>
                </div>
                {last && <LastLine last={last} />}
                {handled.length > 0 && <UndoButton phone={phone} busy={busy} onUndo={undo} />}
              </div>
            ) : current ? (
              <>
                <section className="oo-tri-item" aria-label="Backlog task" data-testid={'clear-out-item-' + current.id}>
                  <span className="oo-tri-meta" data-testid="text-clear-out-meta">
                    {[
                      'Untouched since ' + formatDayMonth(current.updatedAt),
                      current.project?.name,
                      current.dueDate ? 'Due ' + formatShort(current.dueDate) : null,
                      current.priority === 'high' ? PRIORITY_LABELS.high + ' priority' : null,
                      current.repeat ? REPEAT_SHORT[current.repeat.every] : null,
                      current.steps.length ? `${current.steps.filter((s) => s.done).length} of ${current.steps.length} steps` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  <p id="co-current" className="oo-tri-title" data-testid="text-clear-out-title">{current.title}</p>
                  {current.notes && <p className="oo-tri-snippet">{current.notes}</p>}
                </section>
                <div className="oo-tri-actions" role="group" aria-label="What to do with this task">
                  {BUTTONS.map((b) => (
                    <button key={b.action} type="button" className="oo-tri-btn" data-primary={b.action === 'keep'} disabled={busy}
                      aria-keyshortcuts={b.key} onClick={() => act(b.action)} data-testid={'button-clear-out-' + b.action}>
                      {b.label}
                      {!phone && <span className="oo-tri-key" aria-hidden="true">{b.key}</span>}
                    </button>
                  ))}
                </div>
                {last && <LastLine last={last} />}
                {handled.length > 0 && <UndoButton phone={phone} busy={busy} onUndo={undo} />}
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LastLine({ last }: { last: { task: Task; action: Action } }) {
  return (
    <div className="oo-tri-last" data-testid="strip-clear-out-last">
      <span className="oo-t2" style={{ fontSize: 13 }}>
        {DONE_LABEL[last.action]}: <span style={{ color: 'var(--oo-text-on-dark)' }}>{last.task.title}</span>
      </span>
    </div>
  );
}

function UndoButton({ phone, busy, onUndo }: { phone: boolean; busy: boolean; onUndo: () => void }) {
  return (
    <button type="button" className="oo-tri-undo" onClick={onUndo} disabled={busy} data-testid="button-clear-out-undo">
      Undo last{phone ? '' : ' (U)'}
    </button>
  );
}
