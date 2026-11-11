import { useListAgents, type AgentMeasure, type AgentView, type ConnectedAiView } from '@workspace/api-client-react';
import { formatShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { Skel } from '@/components/bits';

const KIND_LABEL: Record<string, string> = { sorter: 'Sorts', judge: 'Judges', writer: 'Writes', researcher: 'Researches', unknown: 'Retired' };
const MODEL_LABEL: Record<string, string> = { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' };

function when(at: string): string {
  return londonDate(at) === todayLondon() ? formatTime(at) + ' today' : formatShort(at);
}

/** Dollars with enough places to show small costs: $0.0042, $0.41, $12.30. */
function dollars(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const tokens = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);

function seconds(ms: number | null): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Settings, Agents (build plan section 21, Part V): every AI agent inside OllieOS with its runs,
 * estimated cost, speed and errors over the last 7 days, then every connected AI.
 */
export default function AgentsSettings() {
  const q = useListAgents({ query: { staleTime: 30_000 } });
  const d = q.data;
  const active = d?.agents.filter((a) => a.runs > 0) ?? [];
  const idle = d?.agents.filter((a) => a.runs === 0) ?? [];

  return (
    <section className="oo-panel flex flex-col gap-5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="ag-h" data-testid="page-settings-agents">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 id="ag-h" style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' }}>Agents</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          Every AI job inside OllieOS, what it reads, and how it did over the last 7 days, including how often you kept what it did, worked out from your own choices (Noise, Reject, Not done, reopening a task). Costs are estimates at Anthropic's list prices in US dollars; Replit bills them through your credits. No message, email or document text is kept for this, only the counts.
        </p>
      </div>

      {q.isLoading ? (
        <Skel h={240} />
      ) : !d ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-agents-error">
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load the agents.</p>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()}>Try again</button>
        </div>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 15 }} data-testid="text-agents-total">
            <strong className="oo-num">{dollars(d.totalCostUsd)}</strong> <span className="oo-soft">across {plural(d.totalRuns, 'run')} in the last 7 days.</span>
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {active.length === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No agent has run in the last 7 days.</p>}
            {active.map((a) => <AgentCard key={a.key} a={a} />)}
          </div>

          {idle.length > 0 && (
            <details data-testid="details-agents-idle">
              <summary className="oo-soft" style={{ fontSize: 13, cursor: 'pointer' }}>{plural(idle.length, 'agent')} with no runs in the last 7 days</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                {idle.map((a) => <AgentCard key={a.key} a={a} />)}
              </div>
            </details>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Connected AIs</h2>
            <p className="oo-soft" style={{ margin: 0, fontSize: 13, maxWidth: '64ch', lineHeight: 1.5 }}>
              AI tools that read and write OllieOS through its connector, and its own Ask OllieOS. Reads and writes are for the last 7 days; proposals decided in that time, and all still waiting.
            </p>
          </div>
          {d.connected.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No AI tools are connected yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {d.connected.map((c) => <ConnectedCard key={c.id} c={c} />)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AgentCard({ a }: { a: AgentView }) {
  return (
    <article className="oo-source" style={{ gap: 6 }} data-testid={'card-agent-' + a.key}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{a.name}</span>
          <span className="oo-pill">{KIND_LABEL[a.kind] ?? a.kind}</span>
          {a.model && <span className="oo-muted" style={{ fontSize: 12 }}>{MODEL_LABEL[a.model] ?? a.model}</span>}
        </span>
        {a.runs > 0 && <span className="oo-num" style={{ fontSize: 14, fontWeight: 600 }} data-testid={'text-agent-cost-' + a.key}>{dollars(a.costUsd)}</span>}
      </div>
      <span className="oo-soft" style={{ fontSize: 13, lineHeight: 1.5 }}>{a.does}</span>
      {a.reads && <span className="oo-muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Reads: {a.reads}</span>}
      {a.runs > 0 ? (
        <span style={{ fontSize: 13 }} data-testid={'text-agent-runs-' + a.key}>
          {plural(a.runs, 'run')}
          {a.failures > 0 && <span style={{ color: 'var(--oo-danger)' }}>, {a.failures} failed</span>}
          {a.avgMs != null && `, ${seconds(a.avgMs)} on average`}
          {`, ${tokens(a.inputTokens)} tokens in, ${tokens(a.outputTokens)} out`}
          {a.promptVersions > 1 && `, ${a.promptVersions} prompt versions`}
          {a.lastRunAt && <span className="oo-muted">. Last run {when(a.lastRunAt)}</span>}
        </span>
      ) : (
        <span className="oo-muted" style={{ fontSize: 13 }}>{a.lastRunAt ? `Last run ${when(a.lastRunAt)}.` : 'Not run yet.'}</span>
      )}
      {a.measures.some((m) => m.kept + m.undone + m.waiting > 0 || m.lastRate != null) && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }} data-testid={'list-agent-measures-' + a.key}>
          {a.measures.filter((m) => m.kept + m.undone + m.waiting > 0 || m.lastRate != null).map((m) => <MeasureLine key={m.key} m={m} />)}
        </ul>
      )}
      {a.lastError && (
        <span style={{ fontSize: 13, color: 'var(--oo-danger)', lineHeight: 1.5 }} data-testid={'text-agent-error-' + a.key}>
          Last error{a.lastErrorAt ? ` (${when(a.lastErrorAt)})` : ''}: {a.lastError}
        </span>
      )}
    </article>
  );
}

/** "Inbox items kept: 82% (28 of 34), last week 90%", with waiting ones counted after. */
function MeasureLine({ m }: { m: AgentMeasure }) {
  const decided = m.kept + m.undone;
  const drop = m.rate != null && m.lastRate != null && m.lastRate - m.rate >= 15 && decided >= 5 && m.lastDecided >= 5;
  return (
    <li style={{ fontSize: 13 }} data-testid={'text-measure-' + m.key}>
      <span className="oo-soft">{m.label}: </span>
      {m.rate != null ? (
        <span style={{ fontWeight: 600, color: drop ? 'var(--oo-danger)' : undefined }}>{m.rate}%</span>
      ) : (
        <span className="oo-muted">nothing decided yet</span>
      )}
      {decided > 0 && <span className="oo-muted"> ({m.kept} of {decided})</span>}
      {m.lastRate != null && <span className="oo-muted">, last week {m.lastRate}%</span>}
      {m.waiting > 0 && <span className="oo-muted">, {m.waiting} waiting for you</span>}
    </li>
  );
}

function ConnectedCard({ c }: { c: ConnectedAiView }) {
  const p = c.proposals;
  const decided = p.approved + p.rejected + p.merged;
  const rate = decided ? Math.round(((p.approved + p.merged) / decided) * 100) : null;
  return (
    <article className="oo-source" style={{ gap: 6 }} data-testid={'card-connected-' + c.id}>
      <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
        {c.auth === 'internal' && <span className="oo-pill">Inside OllieOS</span>}
        {c.revoked && <span className="oo-pill" data-tone="dropped">Revoked</span>}
      </span>
      <span style={{ fontSize: 13 }}>
        Read {plural(c.reads, 'item')}, wrote {plural(c.writes, 'change')}
        {c.lastUsedAt && <span className="oo-muted">. Last used {when(c.lastUsedAt)}</span>}
      </span>
      {(decided > 0 || p.pending > 0) && (
        <span className="oo-soft" style={{ fontSize: 13 }} data-testid={'text-connected-proposals-' + c.id}>
          Knowledge Inbox: {p.approved} approved, {p.merged} same as existing, {p.rejected} rejected, {p.pending} waiting
          {rate != null && ` (${rate}% kept)`}
        </span>
      )}
    </article>
  );
}
