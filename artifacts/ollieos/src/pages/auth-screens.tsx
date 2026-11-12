import { Grain, Logo } from '@/components/bits';

function DarkCentre({ children }: { children: React.ReactNode }) {
  return (
    <div className="oo-dark" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <Grain />
      <main className="oo-glass oo-fade-in" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 420, boxSizing: 'border-box', padding: 32, borderRadius: 'var(--oo-r-ask)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
        {children}
      </main>
    </div>
  );
}

export function SignIn({ onLogin }: { onLogin: () => void }) {
  return (
    <DarkCentre>
      <Logo size={48} radius={14} />
      <p className="oo-serif oo-t2" style={{ margin: 0, fontSize: 18 }}>Private</p>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500 }}>OllieOS</h1>
      <p className="oo-t2" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>Your tasks and work knowledge, in one quiet place.</p>
      <button type="button" className="oo-btn oo-btn-white" style={{ width: '100%', minHeight: 44, fontSize: 15 }} onClick={onLogin} data-testid="button-login">Log in</button>
    </DarkCentre>
  );
}

export function NotAuthorised({ onLogout }: { onLogout: () => void }) {
  return (
    <DarkCentre>
      <Logo size={48} radius={14} />
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500 }} data-testid="text-not-authorised">Not authorised</h1>
      <p className="oo-t2" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>This OllieOS belongs to someone else. Log out and sign in with the right account.</p>
      <button type="button" className="oo-btn oo-btn-white" style={{ width: '100%', minHeight: 44, fontSize: 15 }} onClick={onLogout} data-testid="button-logout">Log out</button>
    </DarkCentre>
  );
}

export function Splash() {
  return (
    <div className="oo-dark" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-busy="true">
      <Grain />
      <div style={{ position: 'relative', zIndex: 1 }}><Logo size={48} radius={14} /></div>
      <span className="oo-sr">Loading</span>
    </div>
  );
}
