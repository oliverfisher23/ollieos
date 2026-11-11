import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetClientPulseQueryKey,
  getGetRelationshipLookBackQueryKey,
  getListClientPulsesQueryKey,
  setClientQuietDays,
  startRelationshipLookBack,
  useGetClientPulse,
  useGetRelationshipLookBack,
} from '@workspace/api-client-react';
import { formatShort } from '@workspace/shared';
import { Dropdown } from '@/components/dropdown';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const QUIET_OPTIONS = [
  { value: '', label: '30 days (usual)' },
  { value: '14', label: '14 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
];

/** Part S: the client pulse on an organisation page, with the quiet period it uses. */
export function ClientPulseCard({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const q = useGetClientPulse(slug, { query: { queryKey: getGetClientPulseQueryKey(slug) } });
  const p = q.data;
  if (!p) return null;
  const change = async (v: string) => {
    try {
      const next = await setClientQuietDays(slug, { quietDays: v ? Number(v) : null });
      qc.setQueryData(getGetClientPulseQueryKey(slug), next);
      void qc.invalidateQueries({ queryKey: getListClientPulsesQueryKey() });
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    }
  };
  return (
    <section aria-labelledby="pulse-h" className="oo-source" style={{ gap: 8 }} data-testid="card-client-pulse">
      <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 id="pulse-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Client pulse</h2>
        {p.needsAttention ? <span className="oo-pill" data-tone="high">Needs attention</span> : <span className="oo-pill" data-tone="done">All good</span>}
      </span>
      <span style={{ fontSize: 14 }} data-testid="text-pulse-line">{p.line}.</span>
      {p.reasons.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }} className="oo-soft" data-testid="list-pulse-reasons">
          {p.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      {p.tone && (
        <span className="oo-muted" style={{ fontSize: 12 }}>Last meeting ({p.tone.title}, {formatShort(p.tone.at)}): {p.tone.tone}{p.tone.reason ? `, ${p.tone.reason}` : ''}</span>
      )}
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <span className="oo-muted">Flag after no contact for</span>
        <Dropdown value={p.quietDays === 30 ? '' : String(p.quietDays)} onChange={(v) => void change(v)} options={QUIET_OPTIONS} ariaLabel="Quiet period" variant="compact" testId="select-quiet-days" />
      </span>
    </section>
  );
}

/** Part S: the one-off look back over 6 months of email headers for "works with" cards. */
export function RelationshipLookBackPanel() {
  const qc = useQueryClient();
  const q = useGetRelationshipLookBack({ query: { queryKey: getGetRelationshipLookBackQueryKey(), refetchInterval: (x) => (x.state.data?.status === 'running' ? 3000 : false) } });
  const [busy, setBusy] = useState(false);
  const s = q.data;
  const start = async () => {
    setBusy(true);
    try {
      qc.setQueryData(getGetRelationshipLookBackQueryKey(), await startRelationshipLookBack());
    } catch (err) {
      reportApiError(err);
      notify('Could not start', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="ks-rel-h" data-testid="section-relationship-look-back">
      <h2 id="ks-rel-h" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Who works with whom</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.5 }}>
        Every Gmail and Calendar check counts the people you know who are on email threads and in meetings together, and suggests "works with" for pairs seen often, in the Knowledge Inbox. Look back once over 6 months of email to catch up. Only who is on each email and its subject are read, with no AI.
      </p>
      {s && (
        <span style={{ fontSize: 13 }} role="status" data-testid="text-look-back-status">
          {s.status === 'running'
            ? `Reading ${s.done} of ${s.total || '…'} threads.`
            : s.status === 'done'
              ? `Done${s.finishedAt ? ` on ${formatShort(s.finishedAt)}` : ''}: read ${s.total} threads and suggested ${s.proposed} relationship${s.proposed === 1 ? '' : 's'}.`
              : s.status === 'failed'
                ? `Stopped: ${s.error ?? 'something went wrong'}.`
                : 'Not run yet.'}
        </span>
      )}
      <div>
        <button type="button" className="oo-btn oo-btn-outline" disabled={busy || s?.status === 'running'} onClick={() => void start()} data-testid="button-look-back-start">
          {s?.status === 'done' || s?.status === 'failed' ? 'Look back again' : 'Look back over 6 months'}
        </button>
      </div>
    </section>
  );
}
