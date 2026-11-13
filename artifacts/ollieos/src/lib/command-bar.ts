/**
 * Section 30, Part D: the command bar is mounted once in App and opened from anywhere
 * (Cmd+K or Ctrl+K, "/", the rail's search button, the phone header) with this event.
 */
const OPEN_EVENT = 'oo:command-bar';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function openCommandBar() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenCommandBar(fn: () => void): () => void {
  window.addEventListener(OPEN_EVENT, fn);
  return () => window.removeEventListener(OPEN_EVENT, fn);
}

/** True while the keyboard is in a field, so single-key shortcuts never fire while typing. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'textbox';
}
