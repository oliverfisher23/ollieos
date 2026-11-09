import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Logo } from '@/components/bits';
import { useSession } from '@/lib/auth-context';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/people', label: 'People' },
  { href: '/settings', label: 'Settings' },
];

export function LightShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { logout } = useSession();
  return (
    <div className="oo-light" data-testid="shell-light">
      <div className="mx-auto flex max-w-[1220px] flex-col gap-4 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="inline-flex items-center gap-2.5 no-underline" style={{ color: 'var(--oo-ink)' }} data-testid="link-logo">
            <Logo />
            <span style={{ fontWeight: 600, fontSize: 15 }}>OllieOS</span>
          </Link>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="oo-navpill" aria-current={location === n.href ? 'page' : undefined} data-testid={'link-nav-' + n.label.toLowerCase()}>
                {n.label}
              </Link>
            ))}
            <span aria-hidden="true" style={{ width: 1, height: 18, background: 'var(--oo-line)', margin: '0 6px' }} />
            <button type="button" className="oo-navpill" onClick={logout} data-testid="button-logout">Log out</button>
          </nav>
        </header>
        {children}
      </div>
    </div>
  );
}
