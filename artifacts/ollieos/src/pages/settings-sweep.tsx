import { useGetSweepStatus, type SweepRun } from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { CopyField } from '@/components/copy-field';
import { whenLabel } from '@/lib/access';

const H1 = { margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' } as const;
const H2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;

const READS: [string, string][] = [
  ['Email', 'New mail in Superhuman that needs a reply or an action'],
  ['Meetings', 'Granola notes: your actions, promises and what others owe you'],
  ['Slack', 'Direct messages and mentions'],
  ['Calendar', 'Today and the next 7 days, replaced on every run'],
  ['Quarterly actions', 'Anything new on the Q3 action list'],
];

function runState(r: SweepRun): { label: string; tone: 'ok' | 'warn' | 'running' } {
  if (!r.finishedAt) return { label: 'Running or stopped early', tone: 'running' };
  if (r.errors.length) return { label: r.errors.length === 1 ? '1 problem' : `${r.errors.length} problems`, tone: 'warn' };
  return { label: 'Finished', tone: 'ok' };
}

export default function SweepSettings() {
  const status = useGetSweepStatus();
  const s = status.data;
  const off = !!s?.client.revokedAt;

  return (
    <>
      <section className="oo-panel flex flex-col gap-1.5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="sweep-h" data-testid="page-settings-sweep">
        <h1 id="sweep-h" style={H1}>Capture sweep</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          A scheduled Claude task that reads your email, meetings and Slack and adds what needs doing to your Inbox. It runs on weekdays at about 07:40 and 13:40. Each run only reads what arrived since the last clean run.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ marginTop: 14 }}>
          <Stat label="Last clean run" testId="cursor" value={s === undefined ? undefined : s.cursor ? whenLabel(s.cursor) : 'Not yet'} />
          <Stat
            label="Ingest key"
            testId="key"
            value={s === undefined ? undefined : s.keyConfigured ? 'Set' : 'Not set'}
            warn={s !== undefined && !s.keyConfigured}
          />
          <Stat label="Access" testId="access" value={s === undefined ? undefined : off ? 'Revoked' : 'On'} warn={off} />
        </div>
        {s && !s.keyConfigured && (
          <p className="oo-soft" style={{ margin: '8px 0 0', fontSize: 13 }} data-testid="text-key-missing">
            The sweep cannot write anything until the INBOX_API_KEY secret is set.
          </p>
        )}
        {off && (
          <p className="oo-soft" style={{ margin: '8px 0 0', fontSize: 13 }} data-testid="text-sweep-revoked">
            The sweep is revoked, so its calls are refused. Reconnect it under AI access.
          </p>
        )}
      </section>

      <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="sweep-reads-h">
        <h2 id="sweep-reads-h" style={H2}>What it reads</h2>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column' }}>
          {READS.map(([what, line]) => (
            <li key={what} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--oo-line-soft)', fontSize: 14, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 500, flex: '0 0 150px' }}>{what}</span>
              <span className="oo-soft" style={{ flex: '1 1 260px' }}>{line}</span>
            </li>
          ))}
        </ul>
        <p className="oo-soft" style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.6, maxWidth: '70ch' }}>
          Items that match a noise rule go straight to Noise. Anything from a meeting always reaches your Inbox. The sweep sends its results to these addresses with the ingest key:
        </p>
        <CopyField value={window.location.origin + '/api/ingest'} label="Ingest address" testId="ingest-address" />
      </section>

      <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="sweep-runs-h">
        <h2 id="sweep-runs-h" style={H2}>Last runs</h2>
        {status.isLoading ? (
          <Skel h={40} />
        ) : status.error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load the sweep runs.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => status.refetch()}>Try again</button>
          </div>
        ) : s!.runs.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-runs-empty">The sweep has not run yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="oo-table" style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th scope="col">Started</th><th scope="col">Added</th><th scope="col">Noise</th>
                  <th scope="col">Already had</th><th scope="col">Activity</th><th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {s!.runs.map((r) => {
                  const st = runState(r);
                  return (
                    <tr key={r.id} data-testid={'row-run-' + r.id}>
                      <td className="oo-num">{whenLabel(r.startedAt)}</td>
                      <td className="oo-num">{r.itemsCreated}</td>
                      <td className="oo-num oo-soft">{r.itemsNoise}</td>
                      <td className="oo-num oo-soft">{r.itemsDuplicate}</td>
                      <td className="oo-num oo-soft">{r.activityLogged}</td>
                      <td>
                        <span className="oo-pill" data-tone={st.tone === 'warn' ? 'high' : undefined} title={r.errors.join('\n') || undefined}>{st.label}</span>
                        {r.errors.length > 0 && (
                          <span className="oo-soft" style={{ display: 'block', fontSize: 12, marginTop: 4, maxWidth: '40ch' }}>{r.errors[0]}</span>
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

function Stat({ label, value, testId, warn = false }: { label: string; value: string | undefined; testId: string; warn?: boolean }) {
  return (
    <div className="oo-stat" style={{ alignItems: 'flex-start', padding: 18, gap: 8 }} data-testid={'stat-sweep-' + testId}>
      <span style={{ fontSize: 13 }}>{label}</span>
      {value === undefined ? (
        <Skel h={28} w={80} />
      ) : (
        <span className="oo-num" style={{ fontSize: 20, fontWeight: 500, lineHeight: '30px', color: warn ? 'var(--oo-danger)' : undefined }}>{value}</span>
      )}
    </div>
  );
}
