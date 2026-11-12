import { useEffect, useState, type ReactNode } from 'react';
import { BriefTalkingPoints } from '@/components/talking-points';
import { LazyMeetingAgenda as MeetingAgenda } from '@/components/meeting-agenda-lazy';
import { FromGranola } from '@/components/from-granola';
import { MeetingThreads } from '@/components/meeting-threads';
import { Thumbs } from '@/components/evals';
import { CommercialLines } from '@/components/client-pulse';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  allowForBrief,
  getGetBriefQueryKey,
  getGetNextBriefQueryKey,
  refreshBrief,
  useGetBrief,
  useGetNextBrief,
  type BriefAttendee,
  type BriefLine,
  type BriefSource,
  type BriefView,
} from '@workspace/api-client-react';
import { daysBetween, formatDayMonth, formatLong, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { Avatar } from '@/components/bits';
import { IconLeft } from '@/components/icons';
import { LockMark, PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { isNotFound } from '@/lib/knowledge';
import { errorMessage, notify } from '@/lib/notify';
import { cadenceStatusLabel } from '@/components/cadence';
import { ResearchList, ScopePill } from '@/components/research';

const CARD = { background: 'var(--oo-panel)', borderRadius: 'var(--oo-r-panel)', boxShadow: 'var(--oo-shadow-panel)' } as const;

function Back() {
  return <Link href="/meetings" className="oo-back" style={{ color: 'var(--oo-ink-muted)' }} data-testid="link-back-meetings"><IconLeft size={14} />Meetings</Link>;
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
            <PageProblem notFound={false} what="brief" onRetry={() => q.refetch()} back={{ href: '/meetings', label: 'Meetings' }} />
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
            <PageProblem notFound={false} what="brief" onRetry={() => q.refetch()} back={{ href: '/meetings', label: 'Meetings' }} />
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
      <div><Link href="/meetings" className="oo-btn oo-btn-outline" data-testid="link-back">Back to Meetings</Link></div>
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
          <div><ScopePill scope={e.scope} companies={e.companies} testId="pill-brief-scope" /></div>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--oo-text-on-dark-2)' }} data-testid="text-brief-built">
            Written {formatLong(brief.generatedAt) === formatLong(new Date()) ? 'today' : formatDayMonth(brief.generatedAt)} at {formatTime(brief.generatedAt)}.
            {brief.sourcesLine ? ' ' + brief.sourcesLine + '.' : ''}
            {e.location && e.location !== e.platform ? ' ' + e.location : ''}
          </p>
          {!brief.failed && brief.why && <div><Thumbs subject={'brief:' + brief.id} label="Was this brief useful?" dark /></div>}
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

          {(brief.pulse ?? []).length > 0 && (
            <Panel id="b-pulse" title="Client pulse">
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="list-brief-pulse">
                {(brief.pulse ?? []).map((p) => (
                  <li key={p.slug} style={{ fontSize: 14, lineHeight: 1.5 }}>
                    <Link href={'/knowledge/organisations/' + p.slug} className="oo-link">{p.name}</Link>
                    {p.needsAttention && <span className="oo-pill" data-tone="high" style={{ marginLeft: 8 }}>Needs attention</span>}
                    <span className="oo-soft">: {p.line}.</span>
                    {p.reasons.length > 0 && <span className="oo-muted"> {p.reasons.join('. ')}.</span>}
                    <div style={{ marginTop: 4 }}><CommercialLines c={p.commercial} /></div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {brief.research.length > 0 && (
            <Panel id="b-research" title={brief.research.length === 1 ? 'Research on the company' : 'Research on the companies'}>
              <ResearchList items={brief.research} />
            </Panel>
          )}

          {((brief.talkingPoints ?? []).length > 0 || brief.attendees.some((a) => a.person) || (showContext && brief.agenda && brief.agenda.length > 0)) && (
            <Panel id="b-agenda" title="Suggested agenda">
              <BriefTalkingPoints eventId={brief.event.id} points={brief.talkingPoints ?? []} people={brief.attendees.flatMap((a) => (a.person ? [{ id: a.person.id, name: a.person.name }] : []))} />
              {showContext && brief.agenda && brief.agenda.length > 0 && <ol style={{ margin: 0, paddingLeft: 20, listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15, lineHeight: 1.5 }} data-testid="list-agenda">
                {brief.agenda.map((l, i) => (
                  <li key={i}>{l.text}<Cites sources={l.sources} /></li>
                ))}
              </ol>}
            </Panel>
          )}

          <MeetingAgenda eventId={e.id} />

          {brief.followUpTaskId != null && (
            <p className="oo-soft" style={{ margin: 0, fontSize: 14 }} data-testid="text-brief-follow-up">
              A follow-up email was drafted from the meeting notes and saved to Gmail. <Link href={'/messages?tab=drafts&id=' + brief.followUpTaskId} className="oo-link">Open it in Drafts</Link>
            </p>
          )}

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

          <FromGranola eventId={e.id} endsAt={e.endsAt} />

          {brief.earlier.length > 0 && (
            <Panel id="b-earlier" title="Last time, from Granola">
              {brief.earlier.map((m) => <EarlierMeeting key={m.eventId} m={m} />)}
            </Panel>
          )}

          <MeetingThreads eventId={e.id} threads={brief.threads} hidden={brief.threadsHidden ?? []} />

        </main>

        <aside style={{ flex: '1 1 300px', maxWidth: 380, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Side id="b-prom" title="What you owe them">
            {brief.promises.length === 0 && brief.tasks.length === 0 ? (
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
            {brief.tasks.map((t) => (
              <Link key={t.id} href={'/tasks?task=' + t.id} style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--oo-ink)', textDecoration: 'none' }} data-testid={'link-task-' + t.id}>
                {t.title}
                <span style={{ display: 'block', fontSize: 12, color: 'var(--oo-ink-muted)' }}>
                  {['Task' + (t.personName ? ' for ' + t.personName : ''), t.dueDate ? 'due ' + formatDayMonth(t.dueDate) : null].filter(Boolean).join(' · ')}
                </span>
              </Link>
            ))}
          </Side>

          <Side id="b-wait" title="What they owe you">
            {brief.waitingOn.length === 0 ? (
              <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-no-waiting">Nothing you are waiting on from them.</p>
            ) : (
              brief.waitingOn.map((t) => {
                const d = Math.max(0, daysBetween(londonDate(t.since), todayLondon()));
                return (
                  <Link key={t.id} href={'/tasks?task=' + t.id} style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--oo-ink)', textDecoration: 'none' }} data-testid={'link-waiting-' + t.id}>
                    {t.title}
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--oo-ink-muted)' }}>
                      {[t.personName, d === 0 ? 'since today' : `waiting ${d} ${d === 1 ? 'day' : 'days'}`].filter(Boolean).join(' · ')}
                    </span>
                  </Link>
                );
              })
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

          {showContext && (brief.products?.length ?? 0) > 0 && (
            <Side id="b-products" title="Products">
              {brief.products!.map((p) => {
                const rules = brief.rules.filter((r) => p.ruleIds.includes(r.id));
                return (
                  <span key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-testid={'brief-product-' + p.id}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Link href={'/knowledge/products/' + p.slug} style={{ fontSize: 14, color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-product-' + p.id}>{p.name}</Link>
                      {p.confidential && <LockMark />}
                    </span>
                    {p.description && <span style={{ fontSize: 12, color: 'var(--oo-ink-muted)' }}>{p.description}</span>}
                    {rules.length > 0 && <span style={{ fontSize: 12, color: 'var(--oo-ink-muted)' }}>Rules: {rules.map((r) => r.title).join(', ')}</span>}
                  </span>
                );
              })}
            </Side>
          )}

          {showContext && (brief.playbooks?.length ?? 0) > 0 && (
            <Side id="b-playbooks" title="Playbooks that may apply">
              {brief.playbooks!.map((p) => (
                <Link key={p.id} href={'/knowledge/playbooks/' + p.id} style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--oo-ink)', textDecoration: 'none' }} data-testid={'link-playbook-' + p.id}>
                  <span style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>{p.title}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--oo-ink-muted)' }}>
                    When {/^[A-Z][a-z]/.test(p.whenToUse) ? p.whenToUse[0].toLowerCase() + p.whenToUse.slice(1) : p.whenToUse} · {p.steps === 1 ? '1 step' : `${p.steps} steps`}
                  </span>
                </Link>
              ))}
            </Side>
          )}

          {showContext && brief.rules.length > 0 && (
            <section aria-labelledby="b-play" style={{ background: 'var(--oo-dark-base)', color: 'var(--oo-text-on-dark)', borderRadius: 'var(--oo-r-panel)', padding: 22, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="section-watch-outs">
              <h2 id="b-play" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Watch-outs from your rules</h2>
              {brief.rules.map((b) => (
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

/** An email address that wraps before the @ rather than in the middle of a word. */
function breakable(text: string) {
  const at = text.indexOf('@');
  if (at <= 0 || /\s/.test(text)) return text;
  return <>{text.slice(0, at)}<wbr />{text.slice(at)}</>;
}

function AttendeeCard({ a, index }: { a: BriefAttendee; index: number }) {
  const p = a.person;
  // With no name on the invite the name is the email address, so it is shown once.
  const nameIsEmail = !!a.email && a.name.trim().toLowerCase() === a.email.toLowerCase();
  const role = p ? [p.role, p.organisation].filter(Boolean).join(', ') : nameIsEmail ? null : a.email;
  const meta = [
    p ? (p.lastContactAt ? 'Last contact ' + formatDayMonth(p.lastContactAt) : 'No contact logged yet') : 'No previous contact',
    a.organiser ? 'organiser' : null,
    a.response ? RESPONSE[a.response] ?? a.response : null,
  ].filter(Boolean).join(' · ');
  const cadence = p?.cadence ? `${p.cadence.label}, ${cadenceStatusLabel(p.cadence).toLowerCase()}` : null;
  const body = (
    <>
      <Avatar name={a.name} id={p?.id ?? a.name} size={36} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{breakable(a.name)}</span>{p?.confidential && <LockMark />}
        </span>
        {role && <span style={{ fontSize: 13, color: 'var(--oo-ink-muted)', overflowWrap: 'anywhere' }}>{breakable(role)}</span>}
        <span style={{ fontSize: 12, color: 'var(--oo-ink-muted)' }}>{meta}</span>
        {cadence && <span style={{ fontSize: 12, color: 'var(--oo-ink-muted)' }} data-testid={'text-attendee-cadence-' + index}>Cadence: {cadence}</span>}
        {p && p.decidesOn.length > 0 && (
          <span style={{ fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' }} data-testid={'text-attendee-decides-' + index}>
            Decides on {p.decidesOn.map((d) => d.name).join(', ')}
          </span>
        )}
        {p && p.facts.length > 0 && (
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13, lineHeight: 1.45, color: 'var(--oo-ink-soft)' }} data-testid={'list-attendee-facts-' + index}>
            {p.facts.map((f) => (
              <li key={f.id} style={{ overflowWrap: 'anywhere' }}>{f.text}{f.needsCheck && <span className="oo-muted"> (needs a check)</span>}</li>
            ))}
          </ul>
        )}
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

const EARLIER_CUT = 600;

/** Granola notes from an earlier meeting with the same people, cut short until opened. */
function EarlierMeeting({ m }: { m: BriefView['earlier'][number] }) {
  const [open, setOpen] = useState(false);
  const long = m.notes.length > EARLIER_CUT;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 12, borderBottom: '1px solid var(--oo-line-soft)' }} data-testid={'card-earlier-' + m.eventId}>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, fontSize: 14 }}>
        <Link href={'/briefs/' + m.eventId} style={{ fontWeight: 600, color: 'var(--oo-ink)', textUnderlineOffset: 2 }} data-testid={'link-earlier-' + m.eventId}>{m.title}</Link>
        <span className="oo-muted" style={{ fontSize: 12 }}>{formatLong(m.startsAt)}{m.people.length ? ' · with ' + m.people.join(', ') : ''}</span>
      </span>
      <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxWidth: '72ch', color: 'var(--oo-ink-soft)', overflowWrap: 'anywhere' }} data-testid={'text-earlier-notes-' + m.eventId}>
        {open || !long ? m.notes : m.notes.slice(0, EARLIER_CUT).replace(/\s+\S*$/, '') + ' …'}
      </div>
      {long && (
        <div>
          <button type="button" className="oo-btn oo-btn-ghost" style={{ minHeight: 32, padding: '0 10px', fontSize: 13 }} onClick={() => setOpen(!open)} aria-expanded={open} data-testid={'button-earlier-more-' + m.eventId}>
            {open ? 'Show less' : 'Show all'}
          </button>
        </div>
      )}
    </div>
  );
}

