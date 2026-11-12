import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { checkAgenda, checkConnector, getGetMeetingQueryKey, getListMeetingsQueryKey, linkGranolaNote, setLeftoverDropped, useGetMeeting, type AgendaCheck, type MeetingView } from '@workspace/api-client-react';
import { Check, Circle, CircleDot } from 'lucide-react';
import { errorMessage, notify } from '@/lib/notify';

const CARD = { background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)' } as const;

/** Notes that arrive after this long without a Granola note are probably not coming. */
const LIKELY_MISSING_MS = 6 * 60 * 60_000;

/**
 * After a meeting: its Granola note, the actions it sent to the Inbox, and a link back to Granola.
 * Until the note arrives, says so and offers Check Granola now. Nothing shows before the meeting ends.
 */
export function FromGranola({ eventId, endsAt }: { eventId: number; endsAt: string }) {
  const qc = useQueryClient();
  const q = useGetMeeting(eventId, { query: { queryKey: getGetMeetingQueryKey(eventId) } });
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [link, setLink] = useState('');
  const ended = Date.now() >= new Date(endsAt).getTime();
  const g = q.data?.granola ?? null;
  const outcome = q.data?.agendaCheck ?? null;
  const [checking, setChecking] = useState(false);
  const hasAgenda = !!q.data?.notes?.trim();

  const runCheck = async (quiet: boolean) => {
    setChecking(true);
    try {
      qc.setQueryData(getGetMeetingQueryKey(eventId), await checkAgenda(eventId));
    } catch (err) {
      if (!quiet) notify('Could not check the agenda', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };
  // A note and an agenda but no check yet (the agenda was written after the note arrived): check once.
  const tried = useRef(false);
  useEffect(() => {
    if (!g || !hasAgenda || outcome || tried.current) return;
    tried.current = true;
    void runCheck(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!g, hasAgenda, !!outcome]);

  if (!q.data || (!ended && !g)) return null;

  const check = async () => {
    setBusy(true);
    try {
      const r = await checkConnector('granola');
      if (!r.ok) {
        notify('Could not check Granola', r.error ?? 'Try again in a moment.');
        return;
      }
      const fresh = await q.refetch();
      void qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() });
      if (!fresh.data?.granola) notify('No Granola note for this meeting yet', 'Granola can take a few minutes after the call ends.');
    } catch (err) {
      notify('Could not check Granola', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!link.trim() || busy) return;
    setBusy(true);
    try {
      const view = await linkGranolaNote(eventId, { link: link.trim() });
      qc.setQueryData(getGetMeetingQueryKey(eventId), view as MeetingView);
      void qc.invalidateQueries({ queryKey: getListMeetingsQueryKey() });
      void qc.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? '').includes('/briefs/') });
      setLinking(false);
      setLink('');
      notify('Granola note linked', view.granola?.actions.length ? `${view.granola.actions.length} actions from it are in your Inbox.` : undefined);
    } catch (err) {
      notify('Could not link that note', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const linkForm = (
    <form onSubmit={submitLink} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} data-testid="form-granola-link">
      <label htmlFor="granola-link" className="sr-only">Granola link</label>
      <input
        id="granola-link"
        className="oo-input"
        style={{ flex: '1 1 260px' }}
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="Paste the Granola link (Share, then Copy link)"
        autoFocus
        data-testid="input-granola-link"
      />
      <button type="submit" className="oo-btn oo-btn-ink" disabled={busy || !link.trim()} data-testid="button-granola-link-save">{busy ? 'Linking…' : 'Link note'}</button>
      <button type="button" className="oo-btn oo-btn-outline" onClick={() => setLinking(false)} disabled={busy}>Cancel</button>
    </form>
  );

  return (
    <section aria-labelledby="g-h" style={{ ...CARD, padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="section-b-granola">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 id="g-h" className="oo-h2">From Granola</h2>
        {g?.url && (
          <a href={g.url} target="_blank" rel="noopener noreferrer" className="oo-link" style={{ fontSize: 13 }} data-testid="link-granola">Open in Granola</a>
        )}
      </div>

      {!g ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }} data-testid="state-granola-waiting">
          <p className="oo-muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, maxWidth: '60ch' }}>
            {Date.now() - new Date(endsAt).getTime() > LIKELY_MISSING_MS
              ? 'No Granola note was found for this meeting. It may not have been recorded.'
              : 'Waiting for the Granola note. It usually arrives within half an hour of the meeting ending, with its actions going to your Inbox.'}
          </p>
          {!linking && (
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {q.data.granolaCheck && (
                <button type="button" className="oo-btn oo-btn-outline" onClick={check} disabled={busy} data-testid="button-check-granola">
                  {busy ? 'Checking…' : 'Check Granola now'}
                </button>
              )}
              <button type="button" className="oo-btn oo-btn-outline" onClick={() => setLinking(true)} disabled={busy} data-testid="button-granola-link">
                Link a note
              </button>
            </span>
          )}
          {linking && <div style={{ flex: '1 1 100%' }}>{linkForm}</div>}
        </div>
      ) : (
        <>
          {hasAgenda && (outcome || checking) && (
            <AgendaOutcome eventId={eventId} check={outcome} checking={checking} onAgain={() => runCheck(false)} />
          )}
          {g.actions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="list-granola-actions">
              <p style={{ margin: 0, fontSize: 14 }}>{g.actions.length === 1 ? '1 action went to your Inbox' : `${g.actions.length} actions went to your Inbox`}</p>
              <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
                {g.actions.map((t) => (
                  <li key={t.id}>
                    <Link href={'/tasks?task=' + t.id} style={{ color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-action-' + t.id}>{t.title}</Link>
                    {t.status !== 'inbox' && <span className="oo-muted" style={{ fontSize: 12 }}> · {t.status === 'done' ? 'done' : 'triaged'}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ fontSize: 14, lineHeight: 1.6, maxWidth: '72ch', color: 'var(--oo-ink-soft)', overflowWrap: 'anywhere', display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="text-granola-notes">
            <NoteText text={g.notes} />
          </div>
          {linking ? (
            linkForm
          ) : (
            <button type="button" onClick={() => setLinking(true)} style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: 0, fontSize: 13, color: 'var(--oo-ink-muted)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid="button-granola-relink">
              Wrong note? Link a different one
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** **bold** inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i} style={{ fontWeight: 600, color: 'var(--oo-ink)' }}>{part.slice(2, -2)}</strong> : part));
}

/**
 * Granola writes its summary in Markdown. Headings, bullets and bold are shown as such; anything
 * else is plain text. Built as elements, never as HTML.
 */
function NoteText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) return <p key={i} style={{ margin: '10px 0 0', fontWeight: 600, color: 'var(--oo-ink)' }}>{inline(heading[1])}</p>;
        const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
        if (bullet) {
          const depth = Math.min(3, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2));
          return <p key={i} style={{ margin: 0, paddingLeft: 16 + depth * 16, textIndent: -12 }}>•&nbsp;&nbsp;{inline(bullet[2])}</p>;
        }
        if (!line.trim()) return <span key={i} style={{ height: 4 }} />;
        return <p key={i} style={{ margin: 0 }}>{inline(line)}</p>;
      })}
    </>
  );
}

const STATUS = {
  covered: { label: 'Covered', Icon: Check, color: 'var(--oo-ok)' },
  partly: { label: 'Partly covered', Icon: CircleDot, color: 'var(--oo-ink-soft)' },
  not_covered: { label: 'Not covered', Icon: Circle, color: 'var(--oo-ink-muted)' },
} as const;

/**
 * How the meeting went against Ollie's agenda: each item covered, partly or not, from the Granola
 * note. What was not covered is offered on the next agenda for this meeting unless he drops it.
 */
function AgendaOutcome({ eventId, check, checking, onAgain }: { eventId: number; check: AgendaCheck | null; checking: boolean; onAgain: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  if (!check) return <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-agenda-checking">Checking the notes against your agenda…</p>;
  const covered = check.items.filter((i) => i.status === 'covered').length;
  const open = check.items.filter((i) => i.status !== 'covered' && !i.dropped).length;

  const drop = async (index: number, dropped: boolean) => {
    setBusy(index);
    try {
      await setLeftoverDropped(eventId, index, { dropped });
      qc.setQueryData(getGetMeetingQueryKey(eventId), (old: MeetingView | undefined) =>
        old?.agendaCheck ? { ...old, agendaCheck: { ...old.agendaCheck, items: old.agendaCheck.items.map((i) => (i.index === index ? { ...i, dropped } : i)) } } : old,
      );
    } catch (err) {
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 14, borderBottom: '1px solid var(--oo-line-soft)' }} data-testid="section-agenda-outcome">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }} data-testid="text-agenda-outcome">
          Against your agenda: {covered} of {check.items.length} covered
        </p>
        {(check.stale || checking) && (
          <button type="button" className="oo-mini" onClick={onAgain} disabled={checking} data-testid="button-agenda-check-again">
            {checking ? 'Checking…' : 'Check again'}
          </button>
        )}
      </div>
      {check.stale && !checking && <p className="oo-muted" style={{ margin: 0, fontSize: 12 }}>The agenda or the note has changed since this was checked.</p>}
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {check.items.map((it) => {
          const st = STATUS[it.status];
          return (
            <li key={it.index} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, lineHeight: 1.5, opacity: it.dropped ? 0.55 : 1 }} data-testid={'item-outcome-' + it.index} data-status={it.status}>
              <st.Icon size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 3, color: st.color }} />
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                <span style={{ fontWeight: 500, textDecoration: it.dropped ? 'line-through' : undefined }}>{it.title}</span>
                <span className="oo-muted"> · {st.label}</span>
                {it.note && <span style={{ display: 'block', fontSize: 13, color: 'var(--oo-ink-soft)' }}>{it.note}</span>}
              </span>
              {it.status !== 'covered' && (
                <button type="button" className="oo-mini" onClick={() => drop(it.index, !it.dropped)} disabled={busy === it.index} data-testid={'button-outcome-drop-' + it.index}>
                  {it.dropped ? 'Carry forward' : 'Drop'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {open > 0 && (
        <p className="oo-muted" style={{ margin: 0, fontSize: 12 }} data-testid="text-outcome-carry">
          {open === 1 ? 'The item not fully covered' : `The ${open} items not fully covered`} will be offered on the next agenda for this meeting.
        </p>
      )}
    </div>
  );
}
