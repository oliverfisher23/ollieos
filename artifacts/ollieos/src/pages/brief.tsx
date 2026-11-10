import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  allowForBrief,
  getGetBriefQueryKey,
  getGetNextBriefQueryKey,
  refreshBrief,
  updateBriefNotes,
  useGetBrief,
  useGetNextBrief,
  type BriefAttendee,
  type BriefLine,
  type BriefSource,
  type BriefView,
} from '@workspace/api-client-react';
import { formatDayMonth, formatLong, formatTime } from '@workspace/shared';
import { Avatar } from '@/components/bits';
import { IconLeft } from '@/components/icons';
import { LockMark, PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { isNotFound } from '@/lib/knowledge';
import { errorMessage, notify } from '@/lib/notify';

const CARD = { background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)' } as const;

function Back() {
  return <Link href="/" className="oo-back" style={{ color: 'var(--oo-ink-muted)' }} data-testid="link-back-today"><IconLeft size={14} />Today</Link>;
}

export function BriefPage({ eventId }: { eventId: string }) {
  const id = Number(eventId);
  const q = useGetBrief(id, { query: { enabled: Number.isInteger(id) && id > 0, queryKey: getGetBriefQueryKey(id) } });
  return (
    <div className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-brief">
      <Back />
      {q.isLoading ? (
        <main className="oo-panel oo-kmain"><PageSkeleton /></main>
      ) : !q.data ? (
        <main className="oo-panel oo-kmain">
          {isNotFound(q.error) ? (
            <NoBrief text={(q.error as { data?: { error?: string } } | null)?.data?.error ?? 'This meeting has no brief'} />
          ) : (
            <PageProblem notFound={false} what="brief" onRetry={() => q.refetch()} back={{ href: '/', label: 'Today' }} />
          )}
        </main>
      ) : (
        <Brief brief={q.data} />
      )}
    </div>
  );
}

export function NextBriefPage() {
  const q = useGetNextBrief();
  return (
    <div className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-brief">
      <Back />
      {q.isLoading ? (
        <main className="oo-panel oo-kmain"><PageSkeleton /></main>
      ) : !q.data ? (
        <main className="oo-panel oo-kmain">
          {isNotFound(q.error) ? (
            <NoBrief text="No work meeting needs a brief between now and the end of tomorrow" />
          ) : (
            <PageProblem notFound={false} what="brief" onRetry={() => q.refetch()} back={{ href: '/', label: 'Today' }} />
          )}
        </main>
      ) : (
        <Brief brief={q.data} />
      )}
    </div>
  );
}

function NoBrief({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="state-no-brief">
      <p className="oo-serif" style={{ margin: 0, fontSize: 22 }}>No brief</p>
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>{text.replace(/\.$/, '')}. Personal events, and meetings with nobody or nothing you know, never get one.</p>
      <div><Link href="/" className="oo-btn oo-btn-outline" data-testid="link-back">Back to Today</Link></div>
    </div>
  );
}

/* ---------- Countdown ---------- */

function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function countdown(startsAt: string, endsAt: string, now: number): string {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (now >= end) return 'Finished';
  if (now >= start) return 'In progress';
  const mins = Math.ceil((start - now) / 60_000);
  if (mins < 60) return `Starts in ${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(mins / 60);
  if (hours < 12) return `Starts in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${formatLong(startsAt)} at ${formatTime(startsAt)}`;
}

/* ---------- The brief ---------- */

function Brief({ brief }: { brief: BriefView }) {
  const qc = useQueryClient();
  const now = useNow();
  const [busy, setBusy] = useState<'refresh' | 'allow' | null>(null);
  const e = brief.event;
  const ended = new Date(e.endsAt).getTime() <= now;
  const showContext = !brief.notMuch && !brief.failed;

  const replace = (next: BriefView) => {
    qc.setQueryData(getGetBriefQueryKey(e.id), next);
    qc.invalidateQueries({ queryKey: getGetNextBriefQueryKey() });
  };
  const run = async (kind: 'refresh' | 'allow') => {
    setBusy(kind);
    try {
      replace(kind === 'refresh' ? await refreshBrief(e.id) : await allowForBrief(e.id));
      notify(kind === 'refresh' ? 'Brief written again' : 'Opened for one hour and written again');
    } catch (err) {
      notify(kind === 'refresh' ? 'Could not write the brief' : 'Could not open those items', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section
        style={{ borderRadius: 'var(--oo-r-panel)', padding: '30px 36px', background: 'var(--oo-dark-base)', color: 'var(--oo-text-on-dark)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}
        data-testid="section-brief-header"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <p className="oo-serif" style={{ margin: 0, fontSize: 18, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-brief-when">
            Brief · {formatLong(e.startsAt)}, {formatTime(e.startsAt)} to {formatTime(e.endsAt)}{e.platform ? ' · ' + e.platform : ''}
          </p>
          <h1 className="oo-h1" style={{ color: 'var(--oo-text-on-dark)', overflowWrap: 'anywhere' }} data-testid="text-brief-title">{e.title}</h1>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-brief-built">
            Written {formatLong(brief.generatedAt) === formatLong(new Date()) ? 'today' : formatDayMonth(brief.generatedAt)} at {formatTime(brief.generatedAt)}.
            {brief.sourcesLine ? ' ' + brief.sourcesLine + '.' : ''}
            {e.location && e.location !== e.platform ? ' ' + e.location : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!ended && (
            <button type="button" className="oo-btn oo-btn-ghost" onClick={() => run('refresh')} disabled={busy !== null} data-testid="button-refresh-brief">
              {busy === 'refresh' ? 'Writing…' : 'Write again'}
            </button>
          )}
          <span style={{ fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 'var(--oo-r-full)', background: 'var(--oo-accent)', color: 'var(--oo-ink)' }} data-testid="text-countdown">
            {countdown(e.startsAt, e.endsAt, now)}
          </span>
        </div>
      </section>

      {brief.heldBack > 0 && (
        <div role="note" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderRadius: 'var(--oo-r-card-sm)', background: 'var(--oo-banner-bg)', border: '1px solid var(--oo-banner-border)', color: 'var(--oo-banner-fg)', fontSize: 14 }} data-testid="banner-held-back">
          <span>
            {brief.heldBack === 1 ? 'One person, project or organisation on this meeting is' : `${brief.heldBack} people, projects or organisations on this meeting are`} hidden from AI, so the brief leaves {brief.heldBack === 1 ? 'it' : 'them'} out.
          </span>
          <button type="button" className="oo-btn oo-btn-ink" onClick={() => run('allow')} disabled={busy !== null} data-testid="button-allow-brief">
            {busy === 'allow' ? 'Writing…' : 'Allow for this brief'}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <main style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel id="b-why" title="Why this meeting">
            {brief.failed ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 15 }} data-testid="text-brief-failed">
                The brief could not be written just now. Who is coming and what you promised are below. Try Write again in a moment.
              </p>
            ) : brief.notMuch ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 15 }} data-testid="text-not-much">
                Not much on file for this meeting yet, so there is no summary. Here is who is coming and what you promised.
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, maxWidth: '72ch' }} data-testid="text-why">
                {brief.why!.map((l, i) => <Sentence key={i} line={l} index={i} />)}
              </p>
            )}
          </Panel>

          <Panel id="b-who" title="Who's in the room">
            {brief.attendees.length === 0 ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No attendees on the invite.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                {brief.attendees.map((a, i) => <AttendeeCard key={i} a={a} index={i} />)}
              </div>
            )}
          </Panel>

          {showContext && brief.questions && brief.questions.length > 0 && (
            <Panel id="b-ask" title="Questions to open with">
              {brief.questionsNote && <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-questions-note">{brief.questionsNote}</p>}
              <ol style={{ margin: 0, paddingLeft: 20, listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15, lineHeight: 1.5 }} data-testid="list-questions">
                {brief.questions.map((l, i) => (
                  <li key={i}>{l.text}<Cites sources={l.sources} /></li>
                ))}
              </ol>
            </Panel>
          )}

          {(brief.granolaNotes || brief.actions.length > 0) && <AfterMeeting brief={brief} />}

          <NotesForAfter brief={brief} />
        </main>

        <aside style={{ flex: '1 1 300px', maxWidth: 380, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Side id="b-prom" title="What you promised">
            {brief.promises.length === 0 ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-no-promises">Nothing open to anyone on this meeting.</p>
            ) : (
              brief.promises.map((p) => (
                <Link key={p.id} href={'/tasks?task=' + p.id} style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--oo-ink)', textDecoration: 'none' }} data-testid={'link-promise-' + p.id}>
                  {p.title}
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--oo-ink-muted)' }}>
                    {[p.source + (p.personName ? ' to ' + p.personName : ''), formatDayMonth(p.capturedAt), p.dueDate ? 'due ' + formatDayMonth(p.dueDate) : null].filter(Boolean).join(' · ')}
                  </span>
                </Link>
              ))
            )}
          </Side>

          {showContext && (brief.projects.length > 0 || brief.goals.length > 0) && (
            <Side id="b-rel" title="Related">
              {brief.projects.map((p) => (
                <span key={'p' + p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Link href={'/knowledge/projects/' + p.slug} style={{ fontSize: 14, color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-project-' + p.id}>{p.name}</Link>
                  {p.confidential && <LockMark />}
                </span>
              ))}
              {brief.goals.map((g) => (
                <Link key={'g' + g.id} href="/goals" style={{ fontSize: 14, color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-goal-' + g.id}>Goal: {g.name}</Link>
              ))}
            </Side>
          )}

          {showContext && brief.documents.length > 0 && (
            <Side id="b-docs" title="Documents to have open">
              {brief.documents.map((d) => (
                <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-document-' + d.id}>{d.title}</a>
              ))}
            </Side>
          )}

          {showContext && brief.playbooks.length > 0 && (
            <section aria-labelledby="b-play" style={{ background: 'var(--oo-dark-base)', color: 'var(--oo-text-on-dark)', borderRadius: 'var(--oo-r-panel)', padding: 22, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="section-watch-outs">
              <h2 id="b-play" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Watch-outs from your playbooks</h2>
              {brief.playbooks.map((b) => (
                <p key={b.id} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--oo-text-on-dark-2)' }}>{b.rule}</p>
              ))}
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ ...CARD, padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid={'section-' + id}>
      <h2 id={id} className="oo-h2">{title}</h2>
      {children}
    </section>
  );
}

function Side({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ ...CARD, padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={'section-' + id}>
      <h2 id={id} style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
      {children}
    </section>
  );
}

/** A sentence followed by numbered links to what it rests on. */
function Sentence({ line, index }: { line: BriefLine; index: number }) {
  return (
    <span data-testid={'text-why-' + index}>
      {line.text}
      <Cites sources={line.sources} />{' '}
    </span>
  );
}

function Cites({ sources }: { sources: BriefSource[] }) {
  if (!sources.length) return null;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {sources.map((s, i) => (
        <SourceLink key={s.ref} s={s} n={i + 1} />
      ))}
    </span>
  );
}

function SourceLink({ s, n }: { s: BriefSource; n: number }) {
  const style = { marginLeft: 4, fontSize: 11, padding: '1px 6px', borderRadius: 'var(--oo-r-pill)', background: 'var(--oo-field)', color: 'var(--oo-ink-soft)', textDecoration: 'none', verticalAlign: 'text-top' } as const;
  const testId = 'link-source-' + s.ref.replace(':', '-');
  if (!s.href) return <span style={style} title={s.label} data-testid={testId}>{n}</span>;
  return s.external ? (
    <a href={s.href} target="_blank" rel="noopener noreferrer" style={style} title={s.label} aria-label={'Source: ' + s.label} data-testid={testId}>{n}</a>
  ) : (
    <Link href={s.href} style={style} title={s.label} aria-label={'Source: ' + s.label} data-testid={testId}>{n}</Link>
  );
}

const RESPONSE: Record<string, string> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'maybe',
  none: 'invite not yet accepted',
};

function AttendeeCard({ a, index }: { a: BriefAttendee; index: number }) {
  const p = a.person;
  const role = p ? [p.role, p.organisation].filter(Boolean).join(', ') : a.email;
  const meta = [
    p ? (p.lastContactAt ? 'Last contact ' + formatDayMonth(p.lastContactAt) : 'No contact logged yet') : 'No previous contact',
    a.organiser ? 'organiser' : null,
    a.response ? RESPONSE[a.response] ?? a.response : null,
  ].filter(Boolean).join(' · ');
  const body = (
    <>
      <Avatar name={a.name} id={p?.id ?? a.name} size={36} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>{a.name}{p?.confidential && <LockMark />}</span>
        {role && <span style={{ fontSize: 13, color: 'var(--oo-ink-muted)', overflowWrap: 'anywhere' }}>{role}</span>}
        <span style={{ fontSize: 12, color: 'var(--oo-ink-muted)' }}>{meta}</span>
      </span>
    </>
  );
  const box = { display: 'flex', gap: 12, padding: '14px 16px', border: '1px solid var(--oo-line)', borderRadius: 'var(--oo-r-card-sm)', textDecoration: 'none', color: 'var(--oo-ink)' } as const;
  return p ? (
    <Link href={'/knowledge/people/' + p.slug} style={box} data-testid={'card-attendee-' + index}>{body}</Link>
  ) : (
    <div style={box} data-testid={'card-attendee-' + index}>{body}</div>
  );
}

function AfterMeeting({ brief }: { brief: BriefView }) {
  const n = brief.actions.length;
  return (
    <Panel id="b-granola" title="From Granola">
      {n > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="list-granola-actions">
          <p style={{ margin: 0, fontSize: 14 }}>{n === 1 ? '1 action went to your Inbox' : `${n} actions went to your Inbox`}</p>
          <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
            {brief.actions.map((t) => (
              <li key={t.id}>
                <Link href={'/tasks?task=' + t.id} style={{ color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-action-' + t.id}>{t.title}</Link>
                {t.status !== 'inbox' && <span className="oo-muted" style={{ fontSize: 12 }}> · {t.status === 'done' ? 'done' : 'triaged'}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {brief.granolaNotes && (
        <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxWidth: '72ch', color: 'var(--oo-ink-soft)' }} data-testid="text-granola-notes">{brief.granolaNotes}</div>
      )}
    </Panel>
  );
}

/** Saves as Ollie types, a moment after he stops. */
function NotesForAfter({ brief }: { brief: BriefView }) {
  const qc = useQueryClient();
  const id = brief.event.id;
  const [text, setText] = useState(brief.notes ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saved = useRef(brief.notes ?? '');
  useEffect(() => {
    if (text === saved.current) return;
    const t = setTimeout(async () => {
      setState('saving');
      try {
        const r = await updateBriefNotes(id, { notes: text.trim() ? text : null });
        saved.current = text;
        qc.setQueryData(getGetBriefQueryKey(id), (old: BriefView | undefined) => (old ? { ...old, notes: r.notes } : old));
        setState('saved');
      } catch (err) {
        setState('error');
        notify('Could not save your notes', errorMessage(err));
      }
    }, 800);
    return () => clearTimeout(t);
  }, [text, id, qc]);

  return (
    <section style={{ ...CARD, padding: '26px 30px', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-notes">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <label htmlFor="b-notebox" className="oo-h2">Notes for after</label>
        <span role="status" className="oo-muted" style={{ fontSize: 12 }} data-testid="text-notes-state">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : ''}
        </span>
      </div>
      <textarea
        id="b-notebox"
        className="oo-input"
        rows={4}
        maxLength={20000}
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        placeholder="Anything to capture. Granola notes are added automatically after the call."
        style={{ resize: 'vertical', padding: '12px 14px', borderRadius: 'var(--oo-r-input-lg)', lineHeight: 1.5 }}
        data-testid="input-brief-notes"
      />
    </section>
  );
}
