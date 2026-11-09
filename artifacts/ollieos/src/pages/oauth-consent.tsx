import { useState } from 'react';
import { useSearch } from 'wouter';
import { decideOAuthConsent, useGetOAuthConsent } from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { IconLock } from '@/components/icons';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const H1 = { margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' } as const;

/** Ollie approves or denies a tool that wants to connect to OllieOS through OAuth. */
export default function OAuthConsentPage() {
  const req = new URLSearchParams(useSearch()).get('req') ?? '';
  const consent = useGetOAuthConsent({ req }, { query: { enabled: !!req, retry: false, refetchOnWindowFocus: false } });
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const c = consent.data;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    try {
      const { redirectTo } = await decideOAuthConsent({ req, decision });
      window.location.href = redirectTo;
    } catch (err) {
      reportApiError(err);
      notify('That did not work', errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }} className="oo-fade-in">
      <section className="oo-panel flex flex-col gap-4 px-5 py-8 sm:px-10" style={{ width: '100%', maxWidth: 620, boxSizing: 'border-box' }} aria-labelledby="consent-h" data-testid="page-oauth-consent">
        {!req || consent.error ? (
          <>
            <h1 id="consent-h" style={H1}>This link has expired</h1>
            <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }} data-testid="text-consent-expired">
              Connection requests last 15 minutes. Go back to Claude and connect again.
            </p>
          </>
        ) : !c ? (
          <>
            <Skel h={36} w={320} />
            <Skel h={80} />
          </>
        ) : (
          <>
            <span className="oo-serif oo-muted" style={{ fontSize: 18 }}>{c.reconnecting ? 'Reconnecting' : 'New connection'}</span>
            <h1 id="consent-h" style={H1} data-testid="text-consent-title">{c.clientName} wants to connect to OllieOS</h1>
            <p className="oo-soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
              {c.reconnecting
                ? `You revoked ${c.clientName} earlier. Approving lets it back in.`
                : 'Only approve this if you have just asked Claude to connect.'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
              <span style={{ fontWeight: 600 }}>It will be able to</span>
              <ul style={{ margin: 0, paddingLeft: 20, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 6, lineHeight: 1.5 }}>
                <li>Read your tasks, projects, people, decisions and notes</li>
                {c.scopes.includes('write') && <li>Add and change tasks, facts, decisions, notes and activity</li>}
                <li>Ask you to open up something it cannot see, for one hour</li>
              </ul>
              <p className="oo-soft" style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'flex-start', lineHeight: 1.5 }}>
                <IconLock size={16} style={{ flex: 'none', marginTop: 2 }} />
                <span>Confidential items stay hidden. It can never delete anything, and every read and write is logged under AI access.</span>
              </p>
            </div>
            <p className="oo-muted" style={{ margin: 0, fontSize: 13 }} data-testid="text-consent-host">
              After you choose, you go back to <span className="oo-num" style={{ color: 'var(--oo-ink)' }}>{c.redirectHost}</span>.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="oo-btn oo-btn-ink" disabled={busy !== null} onClick={() => decide('approve')} data-testid="button-consent-approve">
                {busy === 'approve' ? 'Connecting' : 'Approve'}
              </button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null} onClick={() => decide('deny')} data-testid="button-consent-deny">
                Deny
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
