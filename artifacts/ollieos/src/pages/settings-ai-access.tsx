import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetAiAccessSummaryQueryKey,
  getGetSweepStatusQueryKey,
  getListAiClientsQueryKey,
  reconnectAiClient,
  revokeAiClient,
  useGetAiAccessSummary,
  useListAccessRequests,
  useListAiActivity,
  useListAiClients,
  useListOrganisations,
  useListPeople,
  useListProjects,
  type AccessRequest,
  type AiActivity,
  type AiClient,
  type ApproveAccessInputEntityType,
} from '@workspace/api-client-react';
import { formatDayMonthShort, formatTime } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { LockMark } from '@/components/knowledge/parts';
import { hiddenSummary, requestItemName, useAccessActions, whenLabel } from '@/lib/access';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';
import { CopyField } from '@/components/copy-field';

const H1 = { margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' } as const;
const H2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;

export default function AiAccessSettings() {
  const summary = useGetAiAccessSummary();
  const s = summary.data;
  const stats: [string, string | number | undefined, string][] = [
    ['Connected tools', s?.connectedTools, 'tools'],
    ['Waiting for approval', s?.pendingRequests, 'pending'],
    ['AI reads today', s?.readsToday, 'reads'],
    ['Hidden from AI', s ? hiddenSummary(s.hidden) : undefined, 'hidden'],
  ];
  return (
    <>
      <section className="oo-panel flex flex-col gap-1.5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="ai-h" data-testid="page-settings-ai-access">
        <h1 id="ai-h" style={H1}>AI access</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          Which AI tools can read and write OllieOS, what they have looked at, and what they are asking to see. Confidential items are never shared without your approval.
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ marginTop: 14 }}>
          {stats.map(([label, value, id]) => (
            <div key={id} className="oo-stat" style={{ alignItems: 'flex-start', padding: 18, gap: 8 }} data-testid={'stat-ai-' + id}>
              <span style={{ fontSize: 13 }}>{label}</span>
              {value === undefined ? (
                <Skel h={32} w={56} />
              ) : (
                <span className="oo-num" style={{ fontSize: typeof value === 'number' ? 32 : 20, fontWeight: 500, lineHeight: typeof value === 'number' ? undefined : '38px' }}>{value}</span>
              )}
            </div>
          ))}
        </div>
      </section>
      <Requests />
      <Tools />
      <Activity />
    </>
  );
}

/* ---------- Requests ---------- */

function Requests() {
  const list = useListAccessRequests();
  const d = list.data;
  return (
    <section className="oo-panel flex flex-col gap-3 px-5 py-6 sm:px-8" aria-labelledby="req-h">
      <h2 id="req-h" style={H2}>Access requests</h2>
      {list.isLoading ? (
        <Skel h={64} />
      ) : list.error || !d ? (
        <Problem what="access requests" onRetry={() => list.refetch()} />
      ) : (
        <>
          {d.pending.length === 0 && d.open.length === 0 && (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-requests-empty">No requests waiting.</p>
          )}
          {d.pending.map((r) => <PendingRequest key={r.id} req={r} />)}
          {d.open.map((r) => <OpenGrant key={r.id} req={r} />)}
          {d.recent.length > 0 && (
            <details style={{ fontSize: 13 }} data-testid="recent-requests">
              <summary className="oo-soft" style={{ cursor: 'pointer' }}>Answered in the last week ({d.recent.length})</summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {d.recent.map((r) => (
                  <li key={r.id} className="oo-soft">
                    {r.client.name}, {requestItemName(r)}: {r.status === 'declined' ? 'declined' : 'allowed, now ended'}
                    {r.decidedAt ? ` · ${whenLabel(r.decidedAt)}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function PendingRequest({ req }: { req: AccessRequest }) {
  const actions = useAccessActions();
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState('');
  const needsChoice = !req.item;

  const approve = async () => {
    let match;
    if (needsChoice) {
      const [entityType, id] = choice.split(':');
      match = { entityType: entityType as ApproveAccessInputEntityType, entityId: Number(id) };
    }
    setBusy(true);
    await actions.approve(req, match);
    setBusy(false);
  };
  const decline = async () => {
    setBusy(true);
    await actions.decline(req);
    setBusy(false);
  };

  return (
    <div className="oo-request" data-testid={'request-' + req.id}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 320px' }}>
        <span style={{ fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {req.item?.confidential && <LockMark />}
          <span>{req.client.name} wants to read <b style={{ fontWeight: 600 }}>{requestItemName(req)}</b></span>
        </span>
        <span className="oo-soft" style={{ fontSize: 13 }}>
          {req.reason ? <>Reason given: “{req.reason}”. </> : 'No reason given. '}Requested {whenLabel(req.createdAt)}.
        </span>
        {needsChoice && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, marginTop: 4 }}>
            <span className="oo-soft">Nothing in OllieOS has that exact name. Choose the item it means, or decline.</span>
            <ItemPicker value={choice} onChange={setChoice} testId={'select-request-item-' + req.id} />
          </label>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="oo-btn oo-btn-ink" disabled={busy || (needsChoice && !choice)} onClick={approve} data-testid={'button-allow-' + req.id}>
          Allow for 1 hour
        </button>
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={decline} data-testid={'button-decline-' + req.id}>
          Decline
        </button>
      </div>
    </div>
  );
}

function ItemPicker({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  const projects = useListProjects();
  const people = useListPeople();
  const orgs = useListOrganisations();
  return (
    <select className="oo-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 360 }} data-testid={testId}>
      <option value="">Choose an item</option>
      <optgroup label="Projects">{(projects.data ?? []).map((p) => <option key={p.id} value={'project:' + p.id}>{p.name}</option>)}</optgroup>
      <optgroup label="People">{(people.data ?? []).map((p) => <option key={p.id} value={'person:' + p.id}>{p.name}</option>)}</optgroup>
      <optgroup label="Organisations">{(orgs.data ?? []).map((o) => <option key={o.id} value={'organisation:' + o.id}>{o.name}</option>)}</optgroup>
    </select>
  );
}

function OpenGrant({ req }: { req: AccessRequest }) {
  const actions = useAccessActions();
  const [busy, setBusy] = useState(false);
  const end = async () => {
    setBusy(true);
    await actions.end(req);
    setBusy(false);
  };
  return (
    <div className="oo-request" data-state="open" data-testid={'grant-' + req.id}>
      <span style={{ fontSize: 14, minWidth: 0, flex: '1 1 320px', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {req.item?.confidential && <LockMark />}
        <span>
          {req.item?.path ? <Link href={req.item.path}>{requestItemName(req)}</Link> : requestItemName(req)} is open to {req.client.name} until {formatTime(req.expiresAt!)}. Every read is logged below.
        </span>
      </span>
      <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={end} data-testid={'button-end-' + req.id}>End now</button>
    </div>
  );
}

/* ---------- Tools ---------- */

function canLabel(c: AiClient): string {
  if (c.builtIn) return 'Read, with your approval for hidden items';
  if (c.kind === 'scheduled_task') return 'Add to Inbox, log activity';
  return c.scopes.includes('write') ? 'Read and write' : 'Read only';
}

function kindLabel(c: AiClient): string {
  if (c.builtIn) return 'Built into OllieOS';
  return c.kind === 'connector' ? 'Claude connector' : c.kind === 'scheduled_task' ? 'Scheduled Claude task' : 'Other tool';
}

/** The address Claude needs for a custom connector. */
function mcpAddress(): string {
  return window.location.origin + '/mcp';
}

function Tools() {
  const clients = useListAiClients();
  const list = clients.data ?? [];
  return (
    <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="tools-h">
      <h2 id="tools-h" style={H2}>Connected tools</h2>
      <p className="oo-soft" style={{ margin: 0, fontSize: 13, maxWidth: '70ch', lineHeight: 1.6 }}>
        To connect Claude, add a custom connector in Claude's settings with this address, then approve it here when asked. Revoke cuts a tool off at once.
      </p>
      <CopyField value={mcpAddress()} label="Connector address" testId="mcp-address" />
      {clients.isLoading ? (
        <Skel h={40} />
      ) : clients.error ? (
        <Problem what="connected tools" onRetry={() => clients.refetch()} />
      ) : list.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-tools-empty">No tools have connected yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="oo-table" style={{ minWidth: 640 }}>
            <thead>
              <tr><th scope="col">Tool</th><th scope="col">Can</th><th scope="col">Connected</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Action</span></th></tr>
            </thead>
            <tbody>
              {list.map((c) => <ToolRow key={c.id} c={c} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ToolRow({ c }: { c: AiClient }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const off = !!c.revokedAt;
  const toggle = async () => {
    setBusy(true);
    try {
      if (off) {
        await reconnectAiClient(c.id);
        notify(
          `${c.name} reconnected`,
          c.auth === 'oauth' ? `Open ${c.name} and connect again. You will be asked to approve it here.` : 'The sweep can write to OllieOS again.',
        );
      } else {
        await revokeAiClient(c.id);
        notify(`${c.name} revoked`, 'It can no longer read or write OllieOS.');
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: getListAiClientsQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetAiAccessSummaryQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetSweepStatusQueryKey() }),
      ]);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-testid={'row-tool-' + c.id}>
      <td>
        <span style={{ fontWeight: 500 }}>{c.name}</span>
        <br />
        <span className="oo-soft" style={{ fontSize: 12 }}>{kindLabel(c)}</span>
      </td>
      <td className="oo-soft">{canLabel(c)}</td>
      <td className="oo-num oo-soft">{c.connectedAt ? formatDayMonthShort(c.connectedAt) : 'Not yet'}</td>
      <td className="oo-num oo-soft" data-testid={'text-tool-last-' + c.id}>{off ? 'Revoked' : c.lastUsedAt ? whenLabel(c.lastUsedAt) : 'Not yet'}</td>
      <td style={{ textAlign: 'right' }}>
        {c.builtIn ? (
          <span className="oo-muted" style={{ fontSize: 13 }}>Always on</span>
        ) : (
          <button
            type="button"
            className={off ? 'oo-btn oo-btn-ink' : 'oo-btn oo-btn-outline'}
            style={off ? undefined : { color: 'var(--oo-danger)' }}
            disabled={busy}
            onClick={toggle}
            aria-label={(off ? 'Reconnect ' : 'Revoke ') + c.name}
            data-testid={(off ? 'button-reconnect-' : 'button-revoke-') + c.id}
          >
            {off ? 'Reconnect' : 'Revoke'}
          </button>
        )}
      </td>
    </tr>
  );
}

/* ---------- Read log ---------- */

const KIND_LABEL: Record<AiActivity['kind'], string> = { read: 'Read', search: 'Search', request: 'Request', write: 'Write' };

function ActivityItems({ a }: { a: AiActivity }) {
  if (a.kind === 'request') {
    const item = a.items[0];
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {item?.name ?? (a.context ? `“${a.context}”` : 'An item')}
        {item?.confidential && <span className="oo-muted">(confidential)</span>}
      </span>
    );
  }
  if (a.items.length === 0) {
    return <span className="oo-soft">{a.context ? (a.kind === 'search' ? `“${a.context}”` : a.context) : a.count === 1 ? 'One item' : `${a.count} items`}</span>;
  }
  const extra = a.count - a.items.length;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {a.items.map((it, i) => (
        <span key={it.ref} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span aria-hidden="true" className="oo-muted">·</span>}
          {it.confidential && <LockMark />}
          {it.path ? <Link href={it.path}>{it.name}</Link> : it.name}
        </span>
      ))}
      {extra > 0 && <span className="oo-muted">and {extra} more</span>}
    </span>
  );
}

function Activity() {
  const log = useListAiActivity({ limit: 100 });
  const list = log.data ?? [];
  return (
    <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="log-h">
      <h2 id="log-h" style={H2}>What AI looked at</h2>
      {log.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={18} />)}</div>
      ) : log.error ? (
        <Problem what="the AI read log" onRetry={() => log.refetch()} />
      ) : list.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="state-log-empty">No AI has read anything yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="oo-table" style={{ minWidth: 620 }}>
            <thead>
              <tr><th scope="col">Time</th><th scope="col">Tool</th><th scope="col">Action</th><th scope="col">Item</th></tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.key} data-testid={'row-ai-log-' + a.key}>
                  <td className="oo-num oo-soft" style={{ whiteSpace: 'nowrap' }}>{whenLabel(a.at)}</td>
                  <td>{a.actor}</td>
                  <td>{KIND_LABEL[a.kind]}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <ActivityItems a={a} />
                      {a.kind !== 'request' && a.context && a.items.length > 0 && <span className="oo-muted" style={{ fontSize: 12 }}>For “{a.context}”</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="oo-muted" style={{ margin: 0, fontSize: 12 }}>Shows the last 100 actions. Every item an AI tool is given is logged.</p>
    </section>
  );
}

function Problem({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load {what}.</p>
      <button type="button" className="oo-btn oo-btn-outline" onClick={onRetry}>Try again</button>
    </div>
  );
}
