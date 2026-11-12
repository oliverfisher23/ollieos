import { useEffect, useRef, useState } from 'react';
import { updateMeetingNotes } from '@workspace/api-client-react';
import { errorMessage, notify } from '@/lib/notify';

const CARD = { background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)' } as const;

/**
 * Ollie's agenda and notes for a meeting. Saves as he types, a moment after he stops. The same
 * notes show on the prep page and on a meeting with no prep page, because they live on the meeting.
 */
export function MeetingNotes({ eventId, initial, placeholder, onSaved }: { eventId: number; initial: string | null; placeholder: string; onSaved: (notes: string | null) => void }) {
  const [text, setText] = useState(initial ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saved = useRef(initial ?? '');
  const saveRef = useRef(onSaved);
  saveRef.current = onSaved;
  useEffect(() => {
    if (text === saved.current) return;
    const t = setTimeout(async () => {
      setState('saving');
      try {
        const r = await updateMeetingNotes(eventId, { notes: text.trim() ? text : null });
        saved.current = text;
        saveRef.current(r.notes);
        setState('saved');
      } catch (err) {
        setState('error');
        notify('Could not save your notes', errorMessage(err));
      }
    }, 800);
    return () => clearTimeout(t);
  }, [text, eventId]);

  return (
    <section style={{ ...CARD, padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-notes">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <label htmlFor="meeting-notebox" className="oo-h2">Your agenda and notes</label>
        <span role="status" className="oo-muted" style={{ fontSize: 12 }} data-testid="text-notes-state">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : ''}
        </span>
      </div>
      <textarea
        id="meeting-notebox"
        className="oo-input"
        rows={6}
        maxLength={20000}
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        placeholder={placeholder}
        style={{ resize: 'vertical', padding: '12px 14px', borderRadius: 'var(--oo-r-input-lg)', lineHeight: 1.5 }}
        data-testid="input-meeting-notes"
      />
    </section>
  );
}
