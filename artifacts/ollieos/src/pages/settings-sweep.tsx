import { Link } from 'wouter';
import { useGetSweepOverview, type SweepRun } from '@workspace/api-client-react';
import { formatTime } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { whenLabel } from '@/lib/access';
import { CopyButton } from './settings-ai-access';

const H1 = { margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' } as const;
const H2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;
const INGEST_URL = `${window.location.origin}/api/ingest`;

function minutesBetween(a: string, b: string): string {
  const m = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
  return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : `${m} minutes`;
}

/** A run with no finish after an hour is treated as stopped. */
function runState(r: SweepRun): { label: string; tone: 'ok' | 'warn' | 'live' } {
  if (!r.finishedAt) {
    const stale = Date.now() - new Date(r.startedAt).getTime() > 60 * 60 * 1000;
    return stale ? { label: 'Did not finish', tone: 'warn' } : { label: 'Running', tone: 'live' };
  }
  if (r.errors.length) return { label: r.errors.length === 1 ? '1 problem' : `${r.errors.length} problems`, tone: 'warn' };
  return { label: 'Clean', tone: 'ok' };
}

export default function SweepSettings() {
  const q = useGetSweepOverview();
  const d = q.data;
  const access = !d ? undefined : !d.client ? 'Not run yet' : d.client.revokedAt ? 'Revoked' : 'On';
  const stats: [string, string | undefined, string][] = [
    ['Ingest key', d ? (d.keyConfigured ? 'Set' : 'Not set') : undefined, 'key'],
    ['Sweep access', access, 'access'],
    ['Last clean run', d ? (d.lastSuccessfulAt ? whenLabel(d.lastSuccessfulAt) : 'None yet') : undefined, 'cursor'],
  ];

  return (
    <>
      <section className="oo-panel flex flex-col gap-1.5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="sw-h" data-testid="page-settings-sweep">
        <h1 id="sw-h" style={H1}>Capture sweep</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          A scheduled Claude task reads your email, Granola notes, Slack messages, calendar and Q3 actions on weekdays at about 07:40 and 13:40.
          What needs you lands in your Inbox; items that match a noise rule go straight to Noise. Each run reads only what arrived since the last clean run.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ marginTop: 14 }}>
          {stats.map(([label, value, id]) => (
            <div key={id} className="oo-stat" style={{ alignItems: 'flex-start', padding: 18, gap: 8 }} data-testid={'stat-sweep-' + id}>
              <span style={{ fontSize: 13 }}>{label}</span>
              {value === undefined ? <Skel h={28} w={80} /> : <span className="oo-num" style={{ fontSize: 20, fontWeight: 500, lineHeight: '30px' }}>{value}</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="sw-setup-h">
        <h2 id="sw-setup-h" style={H2}>Connecting the sweep</h2>
        <p className="oo-soft" style={{ margin: 0, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          Ingest address: <code style={{ fontFamily: 'var(--oo-font-mono)', fontSize: 12 }} data-testid="text-ingest-url">{INGEST_URL}</code>
          <CopyButton text={INGEST_URL} label="Copy the ingest address" testId="button-copy-ingest-url" />
        </p>
        <p className="oo-soft" style={{ margin: 0, fontSize: 13, maxWidth: '72ch', lineHeight: 1.6 }}>
          The sweep sends the INBOX_API_KEY secret with every call. The key is never shown here; to replace it, change the secret.
          {d && !d.keyConfigured && <b style={{ fontWeight: 600 }}> The secret is not set yet, so the sweep is refused.</b>}{' '}
          To stop the sweep at once, revoke it in <Link href="/settings/ai-access">AI access</Link>.
        </p>
      </section>

      <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="sw-runs-h">
        <h2 id="sw-runs-h" style={H2}>Recent runs</h2>
        {q.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={18} />)}</div>
        ) : q.error || !d ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load the sweep runs.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()}>Try again</button>
          </div>
        ) : d.runs.length === 0 ? (
          <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="state-runs-empty">
            <p className="oo-serif" style={{ margin: 0, fontSize: 20 }}>No runs yet.</p>
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>The first run shows here with what it added.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="oo-table" style={{ minWidth: 680 }}>
              <thead>
                <tr>
                  <th scope="col">Started</th><th scope="col">Took</th><th scope="col">Added</th><th scope="col">Noise</th>
                  <th scope="col">Already had</th><th scope="col">Activity</th><th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {d.runs.map((r) => {
                  const st = runState(r);
                  return (
                    <tr key={r.id} data-testid={'row-run-' + r.id}>
                      <td className="oo-num" style={{ whiteSpace: 'nowrap' }}>{whenLabel(r.startedAt)}</td>
                      <td className="oo-num oo-soft">{r.finishedAt ? minutesBetween(r.startedAt, r.finishedAt) : `since ${formatTime(r.startedAt)}`}</td>
                      <td className="oo-num">{r.itemsCreated}</td>
                      <td className="oo-num oo-soft">{r.itemsNoise}</td>
                      <td className="oo-num oo-soft">{r.itemsDuplicate}</td>
                      <td className="oo-num oo-soft">{r.activityLogged}</td>
                      <td>
                        <span className="oo-pill" data-tone={st.tone === 'warn' ? 'waiting' : st.tone === 'live' ? 'now' : undefined} data-testid={'text-run-result-' + r.id}>{st.label}</span>
                        {r.errors.length > 0 && (
                          <ul className="oo-soft" style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12 }}>
                            {r.errors.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
