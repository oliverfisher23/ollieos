import { useEffect, useState } from 'react';
import { setThreadVerdict, type BriefView } from '@workspace/api-client-react';
import { formatDayMonth } from '@workspace/shared';
import { errorMessage, notify, notifyUndo } from '@/lib/notify';

type Shown = BriefView['threads'][number];
type Hidden = BriefView['threadsHidden'][number];

const CARD = { background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)' } as const;

/**
 * Recent email and Slack about the meeting. "Not about this meeting" hides a thread here (and for the
 * rest of a repeating series) and teaches the thread matcher; threads it hid can be put back.
 */
export function MeetingThreads({ eventId, threads, hidden }: { eventId: number; threads: Shown[]; hidden: Hidden[] }) {
  const [shown, setShown] = useState(threads);
  const [off, setOff] = useState(hidden);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    setShown(threads);
    setOff(hidden);
  }, [threads, hidden]);

  if (!shown.length && !off.length) return null;

  const byDate = <T extends { occurredAt: string }>(xs: T[]) => [...xs].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const verdict = async (t: Shown, related: boolean) => {
    setBusy(t.id);
    try {
      await setThreadVerdict(eventId, t.id, { related });
      if (related) {
        setOff((xs) => xs.filter((x) => x.id !== t.id));
        setShown((xs) => byDate([...xs.filter((x) => x.id !== t.id), t]));
      } else {
        setShown((xs) => xs.filter((x) => x.id !== t.id));
        setOff((xs) => byDate([...xs.filter((x) => x.id !== t.id), { ...t, by: 'ollie', reason: null }]));
      }
      return true;
    } catch (err) {
      notify('That did not save', errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const notAbout = async (t: Shown) => {
    if (await verdict(t, false)) notifyUndo('Hidden from this meeting', 'OllieOS will learn from this for future meetings.', () => void verdict(t, true));
  };

  const meta = (t: Shown) => (
    <span className="oo-muted" style={{ fontSize: 12 }}>
      {t.kind === 'slack' ? 'Slack' : 'Email'} · {formatDayMonth(t.occurredAt)}
      {t.url && (
        <>
          {' · '}
          <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--oo-ink-muted)', textUnderlineOffset: 2 }} data-testid={'link-thread-' + t.id}>Open</a>
        </>
      )}
    </span>
  );

  return (
    <section aria-labelledby="b-threads" style={{ ...CARD, padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="section-b-threads">
      <h2 id="b-threads" className="oo-h2">Recent email and Slack</h2>
      {shown.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Nothing recent looks like it is about this meeting.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="list-threads">
          {shown.map((t) => (
            <li key={t.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }} data-testid={'row-thread-' + t.id}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 14, lineHeight: 1.5, minWidth: 0, flex: '1 1 240px' }}>
                {meta(t)}
                <span style={{ overflowWrap: 'anywhere' }}>{t.summary}</span>
              </span>
              <button type="button" className="oo-mini" onClick={() => notAbout(t)} disabled={busy === t.id} data-testid={'button-thread-unrelated-' + t.id}>
                Not about this meeting
              </button>
            </li>
          ))}
        </ul>
      )}

      {off.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            type="button"
            className="oo-link"
            style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: 0, fontSize: 13, color: 'var(--oo-ink-muted)', cursor: 'pointer', textUnderlineOffset: 2 }}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid="button-threads-hidden"
          >
            {open ? 'Hide' : 'Show'} {off.length === 1 ? '1 thread' : `${off.length} threads`} not about this meeting
          </button>
          {open && (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="list-threads-hidden">
              {off.map((t) => (
                <li key={t.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', opacity: 0.85 }} data-testid={'row-thread-hidden-' + t.id}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 14, lineHeight: 1.5, minWidth: 0, flex: '1 1 240px' }}>
                    {meta(t)}
                    <span style={{ overflowWrap: 'anywhere', color: 'var(--oo-ink-soft)' }}>{t.summary}</span>
                    <span className="oo-muted" style={{ fontSize: 12 }}>{t.by === 'ollie' ? 'You said it is not about this meeting' : t.reason ? `OllieOS: ${t.reason}` : 'OllieOS judged it not about this meeting'}</span>
                  </span>
                  <button type="button" className="oo-mini" onClick={() => void verdict(t, true)} disabled={busy === t.id} data-testid={'button-thread-related-' + t.id}>
                    It is about this meeting
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
