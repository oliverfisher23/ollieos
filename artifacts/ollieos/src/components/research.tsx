/**
 * The research agent's findings on outside companies: on a meeting's prep page and on an
 * organisation's page. Research runs in the background, so this polls while any is running.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listResearch, startResearch, type CompanyResearch, type MeetingScope } from '@workspace/api-client-react';
import { formatDayMonth, formatTime } from '@workspace/shared';
import { errorMessage, notify } from '@/lib/notify';

const POLL_MS = 5000;

/** Internal or External, with the outside companies when there are any. */
export function ScopePill({ scope, companies, testId }: { scope: MeetingScope; companies: string[]; testId: string }) {
  const label = scope === 'internal' ? 'Internal' : companies.length === 0 ? 'External' : companies.length <= 2 ? `External · ${companies.join(', ')}` : `External · ${companies.length} companies`;
  return (
    <span className="oo-pill" data-tone={scope} title={scope === 'external' && companies.length ? companies.join(', ') : undefined} data-testid={testId}>
      {label}
    </span>
  );
}

/** Keeps the research up to date while any of it is running. */
function useLiveResearch(items: CompanyResearch[]) {
  const [live, setLive] = useState(items);
  const key = items.map((r) => r.domain + r.status + (r.researchedAt ?? '')).join('|');
  useEffect(() => setLive(items), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = live.filter((r) => r.status === 'running').map((r) => r.domain);
  const runningKey = running.join(',');
  useEffect(() => {
    if (!runningKey) return;
    const t = setInterval(async () => {
      try {
        const fresh = await listResearch({ domains: runningKey });
        setLive((cur) => cur.map((r) => fresh.items.find((f) => f.domain === r.domain) ?? r));
      } catch {
        /* the next tick tries again */
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [runningKey]);
  const replace = (next: CompanyResearch) => setLive((cur) => (cur.some((r) => r.domain === next.domain) ? cur.map((r) => (r.domain === next.domain ? next : r)) : [...cur, next]));
  return { live, replace };
}

export function ResearchList({ items, organisationId, testId = 'research' }: { items: CompanyResearch[]; organisationId?: number; testId?: string }) {
  const { live, replace } = useLiveResearch(items);
  const start = async (domain: string) => {
    try {
      replace(await startResearch({ domain, ...(organisationId != null ? { organisationId } : {}) }));
    } catch (err) {
      notify('Could not start the research', errorMessage(err));
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }} data-testid={'list-' + testId}>
      {live.map((r, i) => (
        <div key={r.domain} style={i ? { borderTop: '1px solid var(--oo-line)', paddingTop: 18 } : undefined}>
          <CompanyCard r={r} onStart={() => start(r.domain)} />
        </div>
      ))}
      {organisationId != null && live.length === 0 && <StartByDomain onStart={start} />}
    </div>
  );
}

/** For an organisation with nobody's email on file: research by its website or email domain. */
function StartByDomain({ onStart }: { onStart: (domain: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setBusy(true);
        await onStart(value.trim());
        setBusy(false);
      }}
      data-testid="form-research-domain"
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px', maxWidth: 360 }}>
        <span className="oo-field-label">Not researched yet. Their website or email domain</span>
        <input className="oo-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="example.com" data-testid="input-research-domain" />
      </label>
      <button type="submit" className="oo-btn oo-btn-outline" disabled={busy || !value.trim()} data-testid="button-research-domain">
        {busy ? 'Starting…' : 'Research'}
      </button>
    </form>
  );
}

function CompanyCard({ r, onStart }: { r: CompanyResearch; onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const go = async () => {
    setBusy(true);
    await onStart();
    if (mounted.current) setBusy(false);
  };
  const b = r.body;
  const name = b?.name || r.organisation?.name || r.domain;
  const id = 'rs-' + r.domain.replace(/[^a-z0-9]/g, '-');

  return (
    <article aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid={'card-research-' + r.domain}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
        <h3 id={id} style={{ margin: 0, fontSize: 17, fontWeight: 600, overflowWrap: 'anywhere' }}>{name}</h3>
        <span className="oo-muted" style={{ fontSize: 13 }} hidden={name === r.domain && !b?.website}>
          {b?.website ? (
            <a href={b.website} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textUnderlineOffset: 2 }} data-testid={'link-research-site-' + r.domain}>{r.domain}</a>
          ) : (
            r.domain
          )}
        </span>
        {r.stale && r.status === 'ready' && <span className="oo-pill" data-tone="stale">Over 30 days old</span>}
      </header>

      {r.status === 'running' && (
        <p className="oo-muted" role="status" style={{ margin: 0, fontSize: 14 }} data-testid={'text-research-running-' + r.domain}>
          Researching now: searching the web and reading your email with them. This takes about a minute.
        </p>
      )}
      {r.status === 'none' && (
        <Line>
          <span className="oo-muted">Not researched yet.</span>
          <button type="button" className="oo-btn oo-btn-outline" onClick={go} disabled={busy} data-testid={'button-research-' + r.domain}>{busy ? 'Starting…' : 'Research now'}</button>
        </Line>
      )}
      {r.status === 'failed' && !b && (
        <Line>
          <span className="oo-muted" data-testid={'text-research-failed-' + r.domain}>{r.error ?? 'The research could not be finished.'}</span>
          <button type="button" className="oo-btn oo-btn-outline" onClick={go} disabled={busy} data-testid={'button-research-' + r.domain}>{busy ? 'Starting…' : 'Try again'}</button>
        </Line>
      )}

      {b && r.status !== 'running' && (
        <>
          {b.overview && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, maxWidth: '72ch' }} data-testid={'text-research-overview-' + r.domain}>{b.overview}</p>}

          {b.facts.length > 0 && (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '6px 16px', fontSize: 14, lineHeight: 1.5 }} data-testid={'list-research-facts-' + r.domain}>
              {b.facts.map((f, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <dt className="oo-muted">{f.label}</dt>
                  <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{f.value}<Source url={f.url} /></dd>
                </div>
              ))}
            </dl>
          )}

          {(b.relationship || b.openAsks.length > 0 || r.emailNote) && (
            <div style={{ padding: '14px 16px', borderRadius: 'var(--oo-r-card-sm)', background: 'var(--oo-src-email-bg)', color: 'var(--oo-src-email-fg)', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.55 }} data-testid={'section-research-email-' + r.domain}>
              <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>With you, from your email</h4>
              {b.relationship ? <p style={{ margin: 0 }}>{b.relationship}</p> : <p style={{ margin: 0 }}>{r.emailNote}</p>}
              {b.openAsks.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={'list-research-asks-' + r.domain}>
                  {b.openAsks.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}
            </div>
          )}

          {b.people.length > 0 && (
            <Block title="The people">
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={'list-research-people-' + r.domain}>
                {b.people.map((p, i) => (
                  <li key={i} style={{ fontSize: 14, lineHeight: 1.5 }}>
                    <b style={{ fontWeight: 600 }}>{p.name}</b>
                    {p.role && <span>, {p.role}</span>}
                    <Source url={p.url} />
                    {p.note && <span className="oo-muted" style={{ display: 'block' }}>{p.note}</span>}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {b.news.length > 0 && (
            <Block title="Recent news">
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={'list-research-news-' + r.domain}>
                {b.news.map((n, i) => (
                  <li key={i} style={{ fontSize: 14, lineHeight: 1.5 }}>
                    {n.date && <span className="oo-muted">{n.date} · </span>}
                    {n.text}
                    <Source url={n.url} />
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {b.angles.length > 0 && (
            <Block title="Worth raising">
              <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, lineHeight: 1.5 }} data-testid={'list-research-angles-' + r.domain}>
                {b.angles.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </Block>
          )}

          {b.sources.length > 0 && (
            <details style={{ fontSize: 13 }} data-testid={'details-research-sources-' + r.domain}>
              <summary style={{ cursor: 'pointer', color: 'var(--oo-ink-muted)' }}>{b.sources.length} {b.sources.length === 1 ? 'source' : 'sources'}</summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {b.sources.map((s, i) => (
                  <li key={i} style={{ overflowWrap: 'anywhere' }}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--oo-ink)', textUnderlineOffset: 2 }}>{s.title || s.url}</a>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <Line>
            <span className="oo-muted" style={{ fontSize: 12 }} data-testid={'text-research-footer-' + r.domain}>
              {r.researchedAt ? `Researched ${formatDayMonth(r.researchedAt)} at ${formatTime(r.researchedAt)}` : 'Researched'}
              {` · ${r.searches} ${r.searches === 1 ? 'web search' : 'web searches'}`}
              {` · ${r.emailThreads} ${r.emailThreads === 1 ? 'email thread' : 'email threads'}`}
              {r.status === 'failed' ? ' · the last attempt to update it failed' : ''}
            </span>
            <button type="button" className="oo-btn oo-btn-outline" style={{ fontSize: 12, padding: '4px 10px', minHeight: 0 }} onClick={go} disabled={busy} data-testid={'button-research-again-' + r.domain}>
              {busy ? 'Starting…' : 'Research again'}
            </button>
          </Line>
        </>
      )}
    </article>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 14 }}>{children}</div>;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--oo-ink-soft)' }}>{title}</h4>
      {children}
    </div>
  );
}

function Source({ url }: { url: string | null }) {
  if (!url) return null;
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* shown as is */
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="oo-muted" style={{ marginLeft: 6, fontSize: 12, textUnderlineOffset: 2, color: 'var(--oo-ink-muted)' }} title={url}>
      {host}
    </a>
  );
}
