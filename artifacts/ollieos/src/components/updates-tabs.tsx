import { Link } from 'wouter';

const TABS = [
  { id: 'digest', href: '/digest', label: 'Today' },
  { id: 'week', href: '/digest/week', label: 'This week' },
  { id: 'friday', href: '/digest/friday', label: 'Friday update' },
] as const;

/**
 * Section 30, Part B: the daily digest, the weekly round-up and the Friday update are one place,
 * Updates, with a tab each. The three addresses are unchanged, so old links still open the right one.
 */
export function UpdatesTabs({ current }: { current: (typeof TABS)[number]['id'] }) {
  return (
    <nav aria-label="Updates" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--oo-line)' }} data-testid="nav-updates">
      {TABS.map((t) => (
        <Link key={t.id} href={t.href} className="oo-tab" aria-current={t.id === current ? 'page' : undefined} data-testid={'tab-updates-' + t.id}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
