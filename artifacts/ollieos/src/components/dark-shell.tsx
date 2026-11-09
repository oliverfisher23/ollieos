import type { ReactNode } from 'react';
import { Grain } from '@/components/bits';
import { MainNav } from '@/components/main-nav';

export function DarkShell({ children }: { children: ReactNode }) {
  return (
    <div className="oo-dark" data-testid="shell-dark">
      <Grain />
      <MainNav>{children}</MainNav>
    </div>
  );
}
