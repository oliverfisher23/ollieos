import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Logo } from '@/components/bits';
import { AddBox } from '@/components/add-box';
import { IconBook, IconCalendar, IconCompass, IconGoal, IconHome, IconLogout, IconPeople, IconPlus, IconSettings, IconTasks, IconMail } from '@/components/icons';
import { useSession } from '@/lib/auth-context';

const RAIL = [
  { href: '/', label: 'Home', Icon: IconHome },
  { href: '/tasks', label: 'Tasks', Icon: IconTasks },
  { href: '/email', label: 'Email', Icon: IconMail },
  { href: '/meetings', label: 'Meetings', Icon: IconCalendar },
  { href: '/people', label: 'People', Icon: IconPeople },
  { href: '/goals', label: 'Goals', Icon: IconGoal },
  { href: '/strategy', label: 'Strategy', Icon: IconCompass },
  { href: '/knowledge', label: 'Knowledge', Icon: IconBook },
];

/**
 * Meetings is active on prep pages too (/briefs/{id}).
 * People is the cadence page at /people, but person pages and the full list live under /knowledge/people,
 * so People is active for those too and Knowledge for everything else under /knowledge.
 */
export function navActive(href: string, location: string): boolean {
  const inPeople = location === '/people' || location === '/knowledge/people' || location.startsWith('/knowledge/people/');
  if (href === '/people') return inPeople;
  if (href === '/meetings') return location === '/meetings' || location.startsWith('/briefs/');
  if (href === '/knowledge') return !inPeople && (location === '/knowledge' || location.startsWith('/knowledge/'));
  if (href === '/') return location === '/' || location === '/triage' || location === '/ask' || location.startsWith('/ask/');
  return location === href || location.startsWith(href + '/');
}

/**
 * The app's one navigation: the icon rail on desktop and the bottom bar on phones, on every page.
 * Both shells wrap their content in this so the rail sits in the same place everywhere.
 */
export function MainNav({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { logout } = useSession();
  const [sheet, setSheet] = useState(false);
  const cur = (href: string) => (navActive(href, location) ? 'page' : undefined);

  return (
    <>
      <div className="relative z-[1] flex gap-6 items-start px-4 sm:px-6 pb-[110px] sm:pb-0">
        <nav className="oo-rail oo-on-dark hidden sm:flex" aria-label="Main">
          <Link href="/" aria-label="OllieOS home" style={{ marginBottom: 8, width: 'auto', height: 'auto' }} data-testid="link-rail-logo">
            <Logo size={32} radius={10} font={13} />
          </Link>
          {RAIL.map(({ href, label, Icon }) => (
            <Link key={href} href={href} aria-label={label} aria-current={cur(href)} data-testid={'link-rail-' + label.toLowerCase()}>
              <Icon />
              <RailTip label={label} />
            </Link>
          ))}
          <div aria-hidden="true" className="oo-rail-sep" />
          <Link href="/settings" aria-label="Settings" aria-current={cur('/settings')} data-testid="link-rail-settings">
            <IconSettings />
            <RailTip label="Settings" />
          </Link>
          <button type="button" aria-label="Log out" onClick={logout} data-testid="button-logout">
            <IconLogout />
            <RailTip label="Log out" />
          </button>
        </nav>
        <div className="flex-1 min-w-0">{children}</div>
      </div>

      <nav className="oo-tabbar oo-on-dark sm:hidden" aria-label="Main">
        <Link href="/" aria-current={cur('/')} data-testid="link-tab-home"><IconHome size={22} />Home</Link>
        <Link href="/tasks" aria-current={cur('/tasks')} data-testid="link-tab-tasks"><IconTasks size={22} />Tasks</Link>
        <button type="button" aria-label="Add a task" onClick={() => setSheet(true)} data-testid="button-tab-add">
          <span className="oo-add"><IconPlus size={22} /></span>
        </button>
        <Link href="/people" aria-current={cur('/people')} data-testid="link-tab-people"><IconPeople size={22} />People</Link>
        <Link href="/knowledge" aria-current={cur('/knowledge')} data-testid="link-tab-knowledge"><IconBook size={22} />Knowledge</Link>
      </nav>

      {sheet && <AddSheet onClose={() => setSheet(false)} />}
    </>
  );
}

/** The page name beside a rail icon, shown on hover and keyboard focus. */
function RailTip({ label }: { label: string }) {
  return <span aria-hidden="true" className="oo-rail-tip">{label}</span>;
}

function AddSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="oo-sheet-scrim oo-on-dark" onClick={(e) => e.target === e.currentTarget && onClose()} data-testid="sheet-add">
      <div ref={ref} className="oo-sheet" role="dialog" aria-modal="true" aria-label="Add a task">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 12px' }}>
          <h2 className="oo-label">Add a task</h2>
          <button type="button" className="oo-btn oo-btn-ghost" onClick={onClose} data-testid="button-close-sheet">Close</button>
        </div>
        <AddBox idPrefix="sheet" autoFocus onAdded={onClose} />
      </div>
    </div>
  );
}
