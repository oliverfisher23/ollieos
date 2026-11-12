import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Logo } from '@/components/bits';
import { MainNav } from '@/components/main-nav';

export function LightShell({ children }: { children: ReactNode }) {
  return (
    <div className="oo-light" data-testid="shell-light">
      <MainNav>
        <div className="mx-auto flex max-w-[1220px] flex-col gap-4 pt-4 sm:pt-8 sm:pb-8">
          {/* Phones have no rail: the logo leads home, and everything else is in the tab bar and its More sheet. */}
          <header className="flex items-center justify-between gap-3 sm:hidden">
            <Link href="/" className="oo-tap inline-flex items-center gap-2.5 no-underline" style={{ color: 'var(--oo-ink)' }} data-testid="link-logo">
              <Logo />
              <span style={{ fontWeight: 600, fontSize: 15 }}>OllieOS</span>
            </Link>
          </header>
          {children}
        </div>
      </MainNav>
    </div>
  );
}
