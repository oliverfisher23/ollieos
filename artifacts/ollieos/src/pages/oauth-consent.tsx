import { useState } from 'react';
import { useSearch } from 'wouter';
import { answerOauthConsent, useGetOauthConsent } from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { errorMessage } from '@/lib/notify';

const CAN: Record<string, string> = {
  read: 'Read your tasks, projects, people, decisions and notes, except anything confidential or hidden from AI',
  write: 'Add tasks, facts, notes, decisions and activity, and update tasks. It can never delete anything',
};

/** The OAuth consent screen. Claude (or another MCP tool) sends Ollie here when it first connects. */
export default function OauthConsentPage() {
  const request = new URLSearchParams(useSearch()).get('request') ?? '';
  const info = useGetOauthConsent({ request }, { query: { enabled: !!request, retry: false } });
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const answer = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'decline');
    setProblem(null);
    try {
      const r = await answerOauthConsent({ request, approve });
      window.location.assign(r.redirectTo);
    } catch (err) {
      setProblem(errorMessage(err));
      setBusy(null);
    }
  };

  const d = info.data;
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }} className="oo-fade-in">
      <section className="oo-panel flex flex-col gap-4 px-5 py-8 sm:px-10" style={{ width: '100%', maxWidth: 560 }} aria-labelledby="consent-h" data-testid="page-oauth-consent">
        {!request || info.error ? (
          <>
            <h1 id="consent-h" style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>This link has expired</h1>
            <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }} data-testid="text-consent-invalid">
              Connection requests last 10 minutes. Go back to the tool and connect again.
            </p>
          </>
        ) : !d ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Skel h={30} w="70%" />
            <Skel h={18} />
            <Skel h={18} w="80%" />
          </div>
        ) : (
          <>
            <span className="oo-serif oo-muted" style={{ fontSize: 18 }}>{d.reconnecting ? 'Reconnect a tool' : 'Connect a tool'}</span>
            <h1 id="consent-h" style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }} data-testid="text-consent-title">
              {d.clientName} wants to connect to OllieOS
            </h1>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>If you approve, it can:</span>
              <ul className="oo-soft" style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {d.scopes.map((s) => <li key={s}>{CAN[s] ?? s}.</li>)}
              </ul>
            </div>
            <p className="oo-soft" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              After you approve, you go back to <b style={{ fontWeight: 600 }} data-testid="text-consent-host">{d.redirectHost}</b>. Every read and write is logged, and you can revoke it any time in Settings, AI access.
            </p>
            {d.loopbackOnly && (
              <p role="note" className="oo-request" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }} data-testid="text-consent-loopback">
                This tool only sends you back to an app on this computer (localhost). Approve it only if you started the connection yourself just now.
              </p>
            )}
            {problem && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--oo-danger)' }}>{problem}</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="oo-btn oo-btn-ink" disabled={!!busy} onClick={() => answer(true)} data-testid="button-consent-approve">
                {busy === 'approve' ? 'Connecting…' : 'Approve'}
              </button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={!!busy} onClick={() => answer(false)} data-testid="button-consent-decline">
                Decline
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
