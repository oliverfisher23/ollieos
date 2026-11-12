import { Link } from 'wouter';
import { Thumbs } from '@/components/evals';
import {
  getGetDigestQueryKey,
  useGetDigest,
  useListDigests,
  type Digest,
  type DigestItem,
  type DigestSection,
} from '@workspace/api-client-react';
import { addDays, formatDayMonth, formatLong, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { IconLeft } from '@/components/icons';
import { LockMark, PageProblem, PageSkeleton } from '@/components/knowledge/parts';
import { isNotFound } from '@/lib/knowledge';

const H2 = { margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' } as const;

export default function DigestPage({ date }: { date?: string }) {
  const key = date ?? 'today';
  const q = useGetDigest(key, { query: { queryKey: getGetDigestQueryKey(key) } });
  return (
    <div className="oo-fade-in" style={{ width: '100%', maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="page-digest">
      <Link href="/" className="oo-back" style={{ color: 'var(--oo-ink-muted)' }} data-testid="link-back-home"><IconLeft size={14} />Home</Link>
      <article className="oo-panel" style={{ padding: '36px 40px', display: 'flex', flexDirection: 'column', gap: 26 }} data-testid="article-digest">
        {q.isLoading ? (
          <PageSkeleton />
        ) : !q.data ? (
          isNotFound(q.error) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="state-no-digest">
              <p className="oo-serif" style={{ margin: 0, fontSize: 22 }}>{key === 'today' ? 'No digest yet today' : 'No digest for that day'}</p>
              <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
                The digest is written each weekday morning, after the first check from 07:40 by OllieOS or the Claude sweep. It covers what changed since 18:00 the working day before.
              </p>
            </div>
          ) : (
            <PageProblem notFound={false} what="digest" onRetry={() => q.refetch()} back={{ href: '/', label: 'Home' }} />
          )
        ) : (
          <DigestBody d={q.data} />
        )}
        <Earlier current={q.data?.date ?? null} />
      </article>
    </div>
  );
}

/** "since 18:00 yesterday" or "since 18:00 on Friday". */
function sinceLabel(d: Digest): string {
  const from = londonDate(d.windowStart);
  const time = formatTime(d.windowStart);
  if (from === addDays(d.date, -1)) return `since ${time} yesterday`;
  if (from === d.date) return `since ${time}`;
  return `since ${time} on ${formatLong(from).split(' ')[0]}`;
}

function DigestBody({ d }: { d: Digest }) {
  const s = d.sections;
  const isToday = d.date === todayLondon();
  return (
    <>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p className="oo-serif oo-muted" style={{ margin: 0, fontSize: 18 }} data-testid="text-digest-date">
          {formatLong(d.date)} · {sinceLabel(d)}
        </p>
        <h1 className="oo-h1" style={{ fontSize: 30 }}>What changed</h1>
        {s.quietNight ? (
          <p className="oo-soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }} data-testid="text-quiet-night">A quiet night. Nothing new needs you.</p>
        ) : d.summary ? (
          <p className="oo-soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }} data-testid="text-digest-summary">{d.summary}</p>
        ) : null}
        {!s.quietNight && <div><Thumbs subject={'digest:' + d.id} label="Was this digest useful?" /></div>}
      </header>

      <Section id="dg-needs" title="Needs you" section={s.needs} />
      <Section id="dg-moved" title="Moved" section={s.moved} />
      <Section id="dg-quiet" title="Gone quiet" section={s.quiet} />
      <Section id="dg-changed" title="Changed" section={s.changed ?? null} />

      {s.today.length > 0 && (
        <section aria-labelledby="dg-today" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-dg-today">
          <h2 id="dg-today" style={H2}>{isToday ? 'Today' : 'That day'}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15 }}>
            {s.today.map((e) => (
              <div key={e.eventId} style={{ display: 'flex', gap: 14 }} data-testid={'row-digest-event-' + e.eventId}>
                <span className="oo-num oo-muted" style={{ flex: 'none', width: 48 }}>{formatTime(e.startsAt)}</span>
                <span>
                  {e.title}
                  {e.hasBrief && (
                    <>
                      {' '}
                      <Link href={'/briefs/' + e.eventId} style={{ fontSize: 13, color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }} data-testid={'link-digest-brief-' + e.eventId}>Brief</Link>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Empty sections are left out entirely (feature 08, criterion 2). */
function Section({ id, title, section }: { id: string; title: string; section: DigestSection | null }) {
  if (!section || section.items.length === 0) return null;
  return (
    <section aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={'section-' + id}>
      <h2 id={id} style={H2}>{title}</h2>
      <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 15, lineHeight: 1.5 }}>
        {section.items.map((it, i) => <Item key={i} it={it} testId={`item-${id}-${i}`} />)}
        {section.more > 0 && (
          <li className="oo-muted" data-testid={`text-${id}-more`}>
            {section.moreHref ? <Link href={section.moreHref} style={{ color: 'var(--oo-ink-muted)' }}>and {section.more} more</Link> : `and ${section.more} more`}
          </li>
        )}
      </ul>
    </section>
  );
}

function Item({ it, testId }: { it: DigestItem; testId: string }) {
  const lock = it.confidential ? <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: 6 }}><LockMark /></span> : null;
  if (!it.href) return <li data-testid={testId}>{it.text}{lock}</li>;
  return (
    <li data-testid={testId}>
      <Link href={it.href} style={{ color: 'var(--oo-ink)', textDecoration: 'underline', textUnderlineOffset: 2 }}>{it.text}</Link>{lock}
    </li>
  );
}

function Earlier({ current }: { current: string | null }) {
  const list = useListDigests();
  const others = (list.data ?? []).filter((d) => d.date !== current).slice(0, 10);
  return (
    <footer style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 18, borderTop: '1px solid var(--oo-line-soft)' }} data-testid="footer-digest">
      <span className="oo-muted" style={{ fontSize: 13 }}>Shown on Home each weekday morning from 07:40. Kept for 30 days.</span>
      {others.length > 0 && (
        <nav aria-label="Earlier digests" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 13 }}>
          <span className="oo-muted">Earlier:</span>
          {others.map((d) => (
            <Link key={d.date} href={'/digest/' + d.date} style={{ color: 'var(--oo-ink)' }} data-testid={'link-digest-' + d.date}>{formatDayMonth(d.date)}</Link>
          ))}
        </nav>
      )}
    </footer>
  );
}
