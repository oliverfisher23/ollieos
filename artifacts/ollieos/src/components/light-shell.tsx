import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Logo } from '@/components/bits';
import { MainNav } from '@/components/main-nav';
import { useSession } from '@/lib/auth-context';

export function LightShell({ children }: { children: ReactNode }) {
  const { logout } = useSession();
  return (
    <div className="oo-light" data-testid="shell-light">
      <MainNav>
        <div className="mx-auto flex max-w-[1220px] flex-col gap-4 pt-4 sm:pt-8 sm:pb-8">
          {/* Phones have no rail, so Goals, Settings and Log out live in a small header there. */}
          <header className="flex items-center justify-between gap-3 sm:hidden">
            <Link href="/" className="inline-flex items-center gap-2.5 no-underline" style={{ color: 'var(--oo-ink)' }} data-testid="link-logo">
              <Logo />
              <span style={{ fontWeight: 600, fontSize: 15 }}>OllieOS</span>
            </Link>
            <nav aria-label="Account" className="flex items-center gap-1">
              <Link href="/goals" className="oo-navpill" data-testid="link-header-goals">Goals</Link>
              <Link href="/settings" className="oo-navpill" data-testid="link-header-settings">Settings</Link>
              <button type="button" className="oo-navpill" onClick={logout} data-testid="button-logout-phone">Log out</button>
            </nav>
          </header>
          {children}
        </div>
      </MainNav>
    </div>
  );
}
