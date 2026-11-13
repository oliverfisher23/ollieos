import { useState } from 'react';
import { UpdatesTabs } from '@/components/updates-tabs';

import { Link, useLocation, useSearch } from 'wouter';
import { makeRoundup, saveRoundupDraft, useGetRoundups, type Roundup, type RoundupContent, type RoundupLine } from '@workspace/api-client-react';
import { formatDayMonth, londonDate, formatTime } from '@workspace/shared';
import { Dropdown } from '@/components/dropdown';
import { IconLeft } from '@/components/icons';
import { LockMark, PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { useKnowledgeWrite } from '@/lib/knowledge';

const H2 = { margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' } as const;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SECTIONS: { key: keyof RoundupContent; title: string; empty: string }[] = [
  { key: 'approved', title: 'Approved this week', empty: 'Nothing approved this week.' },
  { key: 'contradictions', title: 'Contradictions and how each was settled', empty: 'No contradictions.' },
  { key: 'stale', title: 'What went stale', empty: 'Nothing went stale.' },
  { key: 'rules', title: 'New rules', empty: 'No new rules.' },
  { key: 'playbooks', title: 'New playbooks', empty: 'No new playbooks.' },
  { key: 'products', title: 'New products', empty: 'No new products.' },
  { key: 'documents', title: 'Documents that changed', empty: 'No Library documents changed by others.' },
  { key: 'agents', title: 'Agents that slipped', empty: 'No agent did noticeably worse than last week.' },
  { key: 'time', title: 'Where time went', empty: 'No meetings on record this week.' },
];

/** "4 pm" style hour for the schedule line. */
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

export default function RoundupPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = Number(new URLSearchParams(search).get('id'));
  const id = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  const q = useGetRoundups(id ? { id } : undefined);
  const write = useKnowledgeWrite();
  const [busy, setBusy] = useState<'make' | 'draft' | null>(null);

  const make = async () => {
    setBusy('make');
    const r = await write(() => makeRoundup(), { done: 'Round-up made for the last seven days', fail: 'Could not make the round-up' });
    setBusy(null);
    if (r) navigate('/digest/week?id=' + r.id, { replace: true });
  };
  const draft = async (r: Roundup) => {
    setBusy('draft');
    await write(() => saveRoundupDraft(r.id), {
      done: r.draftSaved ? 'Gmail draft updated. Nothing was sent.' : 'Saved as a Gmail draft with no recipient. Nothing was sent.',
      fail: 'Could not save the Gmail draft',
    });
    setBusy(null);
  };

  const data = q.data;
  const r = data?.roundup ?? null;
  const schedule = data?.schedule;

  return (
    <div className="oo-fade-in" style={{ width: '100%', maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-roundup">
      <Link href="/" className="oo-back" style={{ color: 'var(--oo-ink-muted)' }} data-testid="link-back-home"><IconLeft size={14} />Home</Link>
      <UpdatesTabs current="week" />
      <article className="oo-panel" style={{ padding: '36px 40px', display: 'flex', flexDirection: 'column', gap: 26 }} data-testid="article-roundup">
        {q.isLoading ? (
          <PageSkeleton />
        ) : !data ? (
          <PageProblem notFound={false} what="round-up" onRetry={() => q.refetch()} back={{ href: '/', label: 'Home' }} />
        ) : (
          <>
            <header style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <p className="oo-serif oo-muted" style={{ margin: 0, fontSize: 18 }} data-testid="text-roundup-week">
                  {r ? `${formatDayMonth(londonDate(r.weekStart))} to ${formatDayMonth(londonDate(r.weekEnd))}` : 'Weekly round-up'}
                </p>
                {data.weeks.length > 0 && (
                  <Dropdown
                    variant="control"
                    ariaLabel="Week"
                    value={r ? String(r.id) : ''}
                    onChange={(v) => navigate(v ? '/digest/week?id=' + v : '/digest/week', { replace: true })}
                    options={data.weeks.map((w, i) => ({
                      value: String(w.id),
                      label: `Week to ${formatDayMonth(londonDate(w.weekEnd))}`,
                      hint: w.manual ? `Made by hand at ${formatTime(w.weekEnd)}` : i === 0 ? 'Latest' : undefined,
                    }))}
                    testId="select-roundup-week"
                  />
                )}
              </div>
              <h1 className="oo-h1" style={{ fontSize: 30 }}>What changed in your knowledge this week</h1>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {r && (
                  <button type="button" className="oo-btn oo-btn-ink" disabled={busy !== null} onClick={() => draft(r)} data-testid="button-roundup-draft">
                    {busy === 'draft' ? 'Saving…' : r.draftSaved ? 'Update the Gmail draft' : 'Save as Gmail draft'}
                  </button>
                )}
                <button type="button" className={r ? 'oo-btn oo-btn-outline' : 'oo-btn oo-btn-ink'} disabled={busy !== null} onClick={make} data-testid="button-roundup-make">
                  {busy === 'make' ? 'Making…' : 'Make one now'}
                </button>
                <Link href="/digest/friday" className="oo-btn oo-btn-quiet" data-testid="link-roundup-friday">Your Friday update</Link>
              </div>
              <p className="oo-muted" style={{ margin: 0, fontSize: 13, maxWidth: '64ch' }}>
                The Gmail draft has no recipient and is never sent. It leaves out anything confidential or hidden from AI, marked here with a lock.
              </p>
            </header>

            {!r ? (
              <p className="oo-soft" style={{ margin: 0, fontSize: 15 }} data-testid="state-no-roundup">
                No round-up yet. One is made each {schedule ? `${DAYS[schedule.day]} at ${hourLabel(schedule.hour)}` : 'week'}, or use Make one now for the last seven days.
              </p>
            ) : (
              SECTIONS.map((s) => <Section key={s.key} id={'rw-' + s.key} title={s.title} empty={s.empty} lines={r.content[s.key] ?? []} />)
            )}

            <footer style={{ paddingTop: 18, borderTop: '1px solid var(--oo-line-soft)' }}>
              <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-roundup-schedule">
                {schedule ? `Made each ${DAYS[schedule.day]} at ${hourLabel(schedule.hour)}. ` : ''}Change the day and time in <Link href="/settings/knowledge" style={{ color: 'var(--oo-ink)' }}>Settings, Knowledge</Link>. Kept for six months.
              </span>
            </footer>
          </>
        )}
      </article>
    </div>
  );
}

function Section({ id, title, empty, lines }: { id: string; title: string; empty: string; lines: RoundupLine[] }) {
  return (
    <section aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={'section-' + id}>
      <h2 id={id} style={H2}>{title}{lines.length > 0 && <span className="oo-muted oo-num" style={{ marginLeft: 8, fontWeight: 400 }}>{lines.length}</span>}</h2>
      {lines.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{empty}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15, lineHeight: 1.5 }}>
          {lines.map((l, i) => (
            <li key={i} data-testid={`item-${id}-${i}`} data-private={l.private ? 'true' : 'false'}>
              <span style={{ overflowWrap: 'anywhere' }}>{l.text}</span>
              {l.private && (
                <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: 6 }} title="Confidential or hidden from AI. Left out of the Gmail draft.">
                  <LockMark />
                </span>
              )}
              {l.detail && <span className="oo-muted" style={{ display: 'block', fontSize: 13, overflowWrap: 'anywhere' }}>{l.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
