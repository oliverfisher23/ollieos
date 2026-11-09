import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Grain, Logo } from '@/components/bits';
import { AddBox } from '@/components/add-box';
import { IconBook, IconHome, IconPeople, IconPlus, IconSettings, IconTasks } from '@/components/icons';

const RAIL = [
  { href: '/', label: 'Home', Icon: IconHome },
  { href: '/tasks', label: 'Tasks', Icon: IconTasks },
  { href: '/knowledge', label: 'Knowledge', Icon: IconBook },
  { href: '/people', label: 'People', Icon: IconPeople },
];

export function DarkShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [sheet, setSheet] = useState(false);
  const cur = (href: string) => (location === href ? 'page' : undefined);

  return (
    <div className="oo-dark" data-testid="shell-dark">
      <Grain />
      <div className="relative z-[1] flex gap-6 items-start px-4 sm:px-6 pb-[110px] sm:pb-0">
        <nav className="oo-rail hidden sm:flex" aria-label="Main">
          <div style={{ marginBottom: 8 }}><Logo size={32} radius={10} font={13} /></div>
          {RAIL.map(({ href, label, Icon }) => (
            <Link key={href} href={href} aria-label={label} aria-current={cur(href)} data-testid={'link-rail-' + label.toLowerCase()}>
              <Icon />
            </Link>
          ))}
          <div aria-hidden="true" className="oo-rail-sep" />
          <Link href="/settings" aria-label="Settings" aria-current={cur('/settings')} data-testid="link-rail-settings">
            <IconSettings />
          </Link>
        </nav>
        <div className="flex-1 min-w-0">{children}</div>
      </div>

      <nav className="oo-tabbar sm:hidden" aria-label="Main">
        <Link href="/" aria-current={cur('/')} data-testid="link-tab-home"><IconHome size={22} />Home</Link>
        <Link href="/tasks" data-testid="link-tab-tasks"><IconTasks size={22} />Tasks</Link>
        <button type="button" aria-label="Add a task" onClick={() => setSheet(true)} data-testid="button-tab-add">
          <span className="oo-add"><IconPlus size={22} /></span>
        </button>
        <Link href="/knowledge" data-testid="link-tab-knowledge"><IconBook size={22} />Knowledge</Link>
        <Link href="/people" data-testid="link-tab-people"><IconPeople size={22} />People</Link>
      </nav>

      {sheet && <AddSheet onClose={() => setSheet(false)} />}
    </div>
  );
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
