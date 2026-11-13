import { Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { CommandBar } from '@/routes';
import { isTyping, onOpenCommandBar } from '@/lib/command-bar';

/** G then one of these goes straight to a page. */
const GO: Record<string, string> = { h: '/', t: '/tasks', m: '/messages', e: '/meetings', c: '/contacts', k: '/knowledge' };

/**
 * Section 30, Part D: the keys that work on every page. Cmd+K or Ctrl+K opens the command bar from
 * anywhere; "/" opens it, and G then H, T, M, E, C or K goes to Home, Tasks, Messages, Meetings, Contacts
 * or Knowledge, but never while typing in a field or with a dialog open. The bar's own code loads on first use.
 */
export function CommandKeys() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const gAt = useRef(0);

  useEffect(() => onOpenCommandBar(() => setOpen(true)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const key = e.key.toLowerCase();
      if (key === '/') {
        e.preventDefault();
        setOpen(true);
      } else if (key === 'g') {
        gAt.current = Date.now();
      } else if (GO[key] && Date.now() - gAt.current < 1200) {
        gAt.current = 0;
        e.preventDefault();
        navigate(GO[key]);
      } else {
        gAt.current = 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CommandBar onClose={() => setOpen(false)} />
    </Suspense>
  );
}
