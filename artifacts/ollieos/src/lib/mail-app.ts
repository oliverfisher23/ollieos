import { useSyncExternalStore } from 'react';

/** Where "Open in…" on an email goes. Kept on this device, as a phone and a laptop may differ. */
export type MailApp = 'gmail' | 'superhuman';
export const MAIL_APP_LABELS: Record<MailApp, string> = { gmail: 'Gmail', superhuman: 'Superhuman' };

const KEY = 'ollieos.mail-app';
const CHANGED = 'ollieos:mail-app';

export function getMailApp(): MailApp {
  try {
    return window.localStorage.getItem(KEY) === 'superhuman' ? 'superhuman' : 'gmail';
  } catch {
    return 'gmail';
  }
}

export function setMailApp(app: MailApp) {
  try {
    window.localStorage.setItem(KEY, app);
  } catch {
    // Private windows may refuse; the choice then lasts until the page is closed.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export const useMailApp = (): MailApp => useSyncExternalStore(subscribe, getMailApp, () => 'gmail' as const);

/**
 * The link for an email in the chosen app. OllieOS holds Gmail links
 * (https://mail.google.com/mail/?authuser=<account>#all/<thread>); the Superhuman one is made from
 * its account and thread. A link that is not in that shape stays a Gmail link.
 */
export function mailLink(gmailUrl: string, app: MailApp): { href: string; label: string } {
  if (app === 'superhuman') {
    const account = /[?&]authuser=([^&#]+)/.exec(gmailUrl)?.[1];
    const thread = /#[a-z]+\/([A-Za-z0-9]+)$/.exec(gmailUrl)?.[1];
    if (account && thread) return { href: `https://mail.superhuman.com/${decodeURIComponent(account)}/thread/${thread}`, label: 'Open in Superhuman' };
  }
  return { href: gmailUrl, label: 'Open in Gmail' };
}
