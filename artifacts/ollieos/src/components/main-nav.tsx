import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Logo } from '@/components/bits';
import { AddBox } from '@/components/add-box';
import { IconBook, IconCalendar, IconCompass, IconGoal, IconHome, IconLogout, IconMessages, IconMore, IconPeople, IconPlus, IconRight, IconSearch, IconSettings, IconTasks } from '@/components/icons';
import { IS_MAC, openCommandBar } from '@/lib/command-bar';
import { getGetMessageCountsQueryKey, useGetMessageCounts } from '@workspace/api-client-react';
import { useSession } from '@/lib/auth-context';
import { preloadRoute } from '@/routes';

/** Section 30, Part C: the five pages used every hour come first, then a line, then the rest. */
const RAIL = [
  { href: '/', label: 'Home', Icon: IconHome },
  { href: '/tasks', label: 'Tasks', Icon: IconTasks },
  { href: '/messages', label: 'Messages', Icon: IconMessages },
  { href: '/meetings', label: 'Meetings', Icon: IconCalendar },
  { href: '/contacts', label: 'Contacts', Icon: IconPeople },
  { href: '/goals', label: 'Goals', Icon: IconGoal, sep: true },
  { href: '/strategy', label: 'Strategy', Icon: IconCompass },
  { href: '/knowledge', label: 'Knowledge', Icon: IconBook },
];

/**
 * Meetings is active on a meeting's own page and prep pages too (/meetings/{id}, /briefs/{id}).
 * Contacts is at /contacts, but person and organisation pages live under /knowledge, so Contacts is
 * active for those too and Knowledge for everything else under /knowledge.
 */
export function navActive(href: string, location: string): boolean {
  const inPeople =
    location === '/contacts' ||
    location === '/people' ||
    ['/knowledge/people', '/knowledge/organisations'].some((p) => location === p || location.startsWith(p + '/'));
  if (href === '/contacts') return inPeople;
  if (href === '/meetings') return location === '/meetings' || location.startsWith('/meetings/') || location.startsWith('/briefs/');
  if (href === '/knowledge') return !inPeople && (location === '/knowledge' || location.startsWith('/knowledge/'));
  if (href === '/') return location === '/' || location === '/triage' || location === '/ask' || location.startsWith('/ask/');
  return location === href || location.startsWith(href + '/');
}

/** Starts a page's code downloading as soon as its link is touched, hovered or focused. */
const preload = (href: string) => ({
  onPointerEnter: () => preloadRoute(href),
  onTouchStart: () => preloadRoute(href),
  onFocus: () => preloadRoute(href),
});

/**
 * The app's one navigation: the icon rail on desktop and the bottom bar on phones, on every page.
 * Both shells wrap their content in this so the rail sits in the same place everywhere.
 */
export function MainNav({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { logout } = useSession();
  const [sheet, setSheet] = useState<'add' | 'more' | null>(null);
  const [, navigate] = useLocation();
  // Feature 09: holding the add button opens voice capture.
  const held = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdToSpeak = {
    onPointerDown: () => {
      held.current = false;
      holdTimer.current = setTimeout(() => {
        held.current = true;
        navigate('/voice');
      }, 500);
    },
    onPointerUp: () => holdTimer.current && clearTimeout(holdTimer.current),
    onPointerLeave: () => holdTimer.current && clearTimeout(holdTimer.current),
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
  const cur = (href: string) => (navActive(href, location) ? 'page' : undefined);
  // Messages needing a reply, on its icon. Looked at again every 2 minutes and when the window is back in view.
  const counts = useGetMessageCounts({ query: { queryKey: getGetMessageCountsQueryKey(), refetchInterval: 120_000, staleTime: 60_000, retry: false } });
  const toAnswer = counts.data?.needsReply ?? 0;
  const badge = (href: string) => (href === '/messages' && toAnswer > 0 ? toAnswer : 0);
  const inMore = MORE.some((m) => navActive(m.href, location));
  // A page opened from the More sheet closes it.
  useEffect(() => setSheet((s) => (s === 'more' ? null : s)), [location]);

  return (
    <>
      <div className="relative z-[1] flex gap-6 items-start px-4 sm:px-6 pb-[110px] sm:pb-0">
        <nav className="oo-rail oo-on-dark hidden sm:flex" aria-label="Main">
          <Link href="/" aria-label="OllieOS home" style={{ marginBottom: 8, width: 'auto', height: 'auto' }} data-testid="link-rail-logo">
            <Logo size={32} />
          </Link>
          <button type="button" aria-label="Search, add or go to a page" aria-keyshortcuts="Meta+K Control+K" onClick={openCommandBar} data-testid="button-rail-search">
            <IconSearch size={20} />
            <RailTip label={'Search and go to  ' + (IS_MAC ? '⌘K' : 'Ctrl K')} />
          </button>
          {RAIL.map(({ href, label, Icon, sep }) => (
            <Fragment key={href}>
            {sep && <div aria-hidden="true" className="oo-rail-sep" />}
            <Link href={href} aria-label={badge(href) ? `${label}, ${badge(href)} to answer` : label} aria-current={cur(href)} {...preload(href)} data-testid={'link-rail-' + label.toLowerCase()}>
              <Icon />
              {badge(href) > 0 && <span className="oo-rail-badge oo-num" aria-hidden="true" data-testid="badge-rail-messages">{badge(href) > 99 ? '99+' : badge(href)}</span>}
              <RailTip label={badge(href) ? `${label}: ${badge(href)} to answer` : label} />
            </Link>
            </Fragment>
          ))}
          <div aria-hidden="true" className="oo-rail-sep" />
          <Link href="/settings" aria-label="Settings" aria-current={cur('/settings')} {...preload('/settings')} data-testid="link-rail-settings">
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
        <button type="button" aria-label="Add a task. Hold to speak." onClick={() => { if (!held.current) setSheet('add'); held.current = false; }} {...holdToSpeak} data-testid="button-tab-add">
          <span className="oo-add"><IconPlus size={22} /></span>
        </button>
        <Link href="/messages" aria-label={toAnswer > 0 ? `Messages, ${toAnswer} to answer` : undefined} aria-current={cur('/messages')} {...preload('/messages')} data-testid="link-tab-messages">
          <span style={{ position: 'relative', display: 'flex' }}>
            <IconMessages size={22} />
            {toAnswer > 0 && <span className="oo-tab-badge oo-num" aria-hidden="true" data-testid="badge-tab-messages">{toAnswer > 99 ? '99+' : toAnswer}</span>}
          </span>
          Messages
        </Link>
        <button type="button" aria-haspopup="dialog" aria-expanded={sheet === 'more'} aria-current={inMore ? 'page' : undefined} onClick={() => setSheet('more')} data-testid="button-tab-more">
          <IconMore size={22} />
          More
        </button>
      </nav>

      {sheet === 'add' && <AddSheet onClose={() => setSheet(null)} />}
      {sheet === 'more' && (
        <BottomSheet label="More" testId="sheet-more" onClose={() => setSheet(null)}>
          <nav aria-label="More" className="oo-sheet-list">
            {MORE.map(({ href, label, Icon }, i) => (
              <Link key={href} href={href} aria-current={cur(href)} data-autofocus={i === 0 || undefined} {...preload(href)} data-testid={'link-more-' + label.toLowerCase()}>
                <Icon size={20} />
                <span>{label}</span>
                <IconRight size={16} className="oo-sheet-chev" />
              </Link>
            ))}
            <div aria-hidden="true" className="oo-sheet-sep" />
            <button type="button" onClick={logout} data-testid="button-more-logout">
              <IconLogout size={20} />
              <span>Log out</span>
            </button>
          </nav>
        </BottomSheet>
      )}
    </>
  );
}

/**
 * Pages the phone tab bar has no room for (docs/mobile-plan.md, Part D): Home, Tasks, add and
 * Messages are tabs (section 30, Part C: Messages took Contacts' place), everything else is in the More sheet.
 */
const MORE = [
  { href: '/contacts', label: 'Contacts', Icon: IconPeople },
  { href: '/meetings', label: 'Meetings', Icon: IconCalendar },
  { href: '/knowledge', label: 'Knowledge', Icon: IconBook },
  { href: '/goals', label: 'Goals', Icon: IconGoal },
  { href: '/strategy', label: 'Strategy', Icon: IconCompass },
  { href: '/settings', label: 'Settings', Icon: IconSettings },
];

/** The page name beside a rail icon, shown on hover and keyboard focus. */
function RailTip({ label }: { label: string }) {
  return <span aria-hidden="true" className="oo-rail-tip">{label}</span>;
}

/** A sheet from the bottom of the screen: Escape or a tap outside closes it, and focus goes back where it was. */
function BottomSheet({ label, testId, onClose, children }: { label: string; testId: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Move focus into the sheet, unless something in it (the add box) has already taken it.
    const sheet = ref.current;
    if (sheet && !sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>('[data-autofocus]')?.focus();
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
    <div className="oo-sheet-scrim oo-on-dark" onClick={(e) => e.target === e.currentTarget && onClose()} data-testid={testId}>
      <div ref={ref} className="oo-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 12px' }}>
          <h2 className="oo-label">{label}</h2>
          <button type="button" className="oo-btn oo-btn-ghost" onClick={onClose} data-testid={'button-close-' + testId}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddSheet({ onClose }: { onClose: () => void }) {
  return (
    <BottomSheet label="Add a task" testId="sheet-add" onClose={onClose}>
      <AddBox idPrefix="sheet" autoFocus onAdded={onClose} />
    </BottomSheet>
  );
}
