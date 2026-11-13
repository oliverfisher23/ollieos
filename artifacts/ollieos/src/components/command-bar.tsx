import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { useQuickAddTask, useSearchKnowledge } from '@workspace/api-client-react';
import { parseQuickAdd } from '@workspace/shared';
import { IconArrowOut, IconBook, IconCalendar, IconCompass, IconGoal, IconHome, IconMessages, IconPeople, IconPlus, IconSearch, IconSettings, IconTasks } from '@/components/icons';
import { IS_MAC } from '@/lib/command-bar';
import { TYPE_LABELS, searchHitPath } from '@/lib/knowledge';
import { useInvalidateTasks } from '@/lib/task-cache';
import { notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

type Icon = (p: { size?: number }) => ReactNode;

/** Every page the bar can jump to. `words` are other things Ollie might type for it. */
const PAGES: { href: string; label: string; Icon: Icon; words?: string }[] = [
  { href: '/', label: 'Home', Icon: IconHome },
  { href: '/tasks', label: 'Tasks', Icon: IconTasks, words: 'to do list' },
  { href: '/triage', label: 'Triage the Inbox', Icon: IconTasks, words: 'sort new' },
  { href: '/messages', label: 'Messages', Icon: IconMessages, words: 'email slack to answer reply' },
  { href: '/messages?tab=waiting', label: 'Messages: waiting for a reply', Icon: IconMessages, words: 'email no reply chase' },
  { href: '/messages?tab=drafts', label: 'Messages: drafts', Icon: IconMessages, words: 'email' },
  { href: '/meetings', label: 'Meetings', Icon: IconCalendar, words: 'calendar briefs prep agenda' },
  { href: '/briefs/next', label: 'Prep for my next meeting', Icon: IconCalendar, words: 'brief agenda' },
  { href: '/contacts', label: 'Contacts', Icon: IconPeople, words: 'people organisations' },
  { href: '/goals', label: 'Goals', Icon: IconGoal },
  { href: '/strategy', label: 'Strategy and ideas', Icon: IconCompass },
  { href: '/knowledge', label: 'Knowledge', Icon: IconBook, words: 'projects clients' },
  { href: '/knowledge/inbox', label: 'Knowledge Inbox', Icon: IconBook, words: 'review cards approve' },
  { href: '/knowledge/library', label: 'Library: documents', Icon: IconBook, words: 'files drive dropbox' },
  { href: '/knowledge/library?tab=rules', label: 'Library: rules', Icon: IconBook },
  { href: '/knowledge/library?tab=playbooks', label: 'Library: playbooks', Icon: IconBook },
  { href: '/knowledge/decisions', label: 'Decisions', Icon: IconBook },
  { href: '/knowledge/notes', label: 'Notes', Icon: IconBook },
  { href: '/knowledge/sessions', label: 'Cowork sessions', Icon: IconBook, words: 'claude' },
  { href: '/knowledge/products', label: 'Products', Icon: IconBook },
  { href: '/knowledge/map', label: 'Map', Icon: IconBook, words: 'graph connections' },
  { href: '/digest', label: 'Updates: today', Icon: IconArrowOut, words: 'digest what changed' },
  { href: '/digest/week', label: 'Updates: this week', Icon: IconArrowOut, words: 'weekly round-up roundup' },
  { href: '/digest/friday', label: 'Updates: Friday update', Icon: IconArrowOut, words: 'leadership weekly post' },
  { href: '/duplicates', label: 'Duplicate tasks', Icon: IconTasks },
  { href: '/ask', label: 'Ask OllieOS', Icon: IconSearch, words: 'question' },
  { href: '/settings/connectors', label: 'Settings: connectors', Icon: IconSettings, words: 'gmail slack calendar granola drive dropbox ai access sweep' },
  { href: '/settings/email', label: 'Settings: email', Icon: IconSettings },
  { href: '/settings/knowledge', label: 'Settings: knowledge', Icon: IconSettings, words: 'shelf life round-up' },
  { href: '/settings/noise-rules', label: 'Settings: noise rules', Icon: IconSettings },
  { href: '/settings/planning', label: 'Settings: planning', Icon: IconSettings, words: 'working hours' },
  { href: '/settings/agents', label: 'Settings: agents', Icon: IconSettings, words: 'ai jobs scorecards lessons test cases' },
  { href: '/settings/imports', label: 'Settings: imports', Icon: IconSettings },
  { href: '/settings/export', label: 'Settings: export', Icon: IconSettings, words: 'csv download' },
];

/** Shown before anything is typed: the pages used every hour. */
const FIRST = ['/', '/tasks', '/messages', '/meetings', '/contacts', '/triage', '/briefs/next', '/knowledge/inbox'];

/** Pages whose name or other words start with what was typed come first, then ones that contain it. */
function matchPages(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = PAGES.map((p) => {
    const label = p.label.toLowerCase();
    const all = label + ' ' + (p.words ?? '');
    if (!words.every((w) => all.includes(w))) return null;
    const score = label.startsWith(words[0]) ? 0 : label.split(/[\s:]+/).some((part) => part.startsWith(words[0])) ? 1 : label.includes(words[0]) ? 2 : 3;
    return { p, score };
  }).filter((x): x is { p: (typeof PAGES)[number]; score: number } => x !== null);
  return scored.sort((a, b) => a.score - b.score).slice(0, 5).map((x) => x.p);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Section 30, Part D: one box to add a task, find anything OllieOS holds, go to any page, or hand the
 * words to Ask. Order is always pages, then what was found, then Add and Ask, so the top row is the
 * most specific thing the words could mean. Cmd+Enter (Ctrl+Enter) adds the words as a task whatever is selected.
 */
export function CommandBar({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState('');
  const moved = useRef(false);
  const [, navigate] = useLocation();
  const quickAdd = useQuickAddTask();
  const invalidate = useInvalidateTasks();

  const q = text.trim();
  const asked = useDebounced(q, 180);
  const search = useSearchKnowledge({ q: asked }, { query: { enabled: asked.length > 1, staleTime: 30_000 } as never });
  const hits = useMemo(
    () => (asked.length > 1 && asked === q ? (search.data?.hits ?? []) : []).map((h) => ({ h, path: searchHitPath(h) })).filter((x): x is { h: typeof x.h; path: string } => !!x.path).slice(0, 12),
    [search.data, asked, q],
  );
  const searching = q.length > 1 && (asked !== q || search.isFetching);

  const pages = useMemo(() => (q ? matchPages(q) : PAGES.filter((p) => FIRST.includes(p.href)).sort((a, b) => FIRST.indexOf(a.href) - FIRST.indexOf(b.href))), [q]);
  const parsed = useMemo(() => (q ? parseQuickAdd(q) : null), [q]);
  const canAdd = !!parsed && parsed.title.length > 0;

  // The top row stays selected as results arrive, until Ollie moves with the arrow keys or the pointer; after that his choice is kept.
  const first = pages[0] ? 'page:' + pages[0].href : hits[0] ? 'hit:' + hits[0].h.type + ':' + hits[0].h.id : canAdd ? 'add' : '';
  useEffect(() => {
    moved.current = false;
  }, [q]);
  useEffect(() => {
    if (!moved.current) setSelected(first);
  }, [first]);

  const go = (href: string) => {
    onClose();
    navigate(href);
  };
  const add = () => {
    if (!canAdd || quickAdd.isPending) return;
    quickAdd.mutate(
      { data: { text: q } },
      {
        onSuccess: (res) => {
          invalidate(res.task.id);
          notify('Task added', res.warnings.length ? res.warnings.join('. ') : res.task.title);
          onClose();
        },
        onError: (err) => {
          reportApiError(err);
          notify('Could not add that task', 'Check the text and try again.');
        },
      },
    );
  };
  const ask = () => go('/ask?q=' + encodeURIComponent(q.slice(0, 1000)));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') moved.current = true;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-cmd-scrim">
          <Dialog.Content className="oo-cmd" aria-describedby={undefined} data-testid="dialog-command-bar">
            <Dialog.Title className="oo-sr">Search, add or go to a page</Dialog.Title>
            <Command shouldFilter={false} loop value={selected} onValueChange={setSelected} onKeyDown={onKeyDown} label="Search, add or go to a page">
              <div className="oo-cmd-input">
                <IconSearch size={18} />
                <Command.Input value={text} onValueChange={setText} placeholder="Search, add a task, or go to a page" autoFocus maxLength={1000} data-testid="input-command-bar" />
              </div>
              <Command.List className="oo-cmd-list" onPointerMove={() => { moved.current = true; }} data-testid="list-command-bar">
                {pages.length > 0 && (
                  <Command.Group heading="Go to">
                    {pages.map(({ href, label, Icon }) => (
                      <Command.Item key={href} value={'page:' + href} className="oo-cmd-item" onSelect={() => go(href)} data-testid={'cmd-page-' + href}>
                        <Icon size={16} />
                        <span className="oo-cmd-title">{label}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {(hits.length > 0 || searching) && (
                  <Command.Group heading="Found">
                    {hits.map(({ h, path }) => (
                      <Command.Item key={h.type + h.id} value={'hit:' + h.type + ':' + h.id} className="oo-cmd-item" onSelect={() => go(path)} data-testid={'cmd-hit-' + h.type + '-' + h.id}>
                        <span className="oo-cmd-title">{h.title}{h.type === 'fact' && h.parent ? ' · ' + h.parent.name : ''}</span>
                        <span className="oo-cmd-kind">{TYPE_LABELS[h.type] ?? h.type}</span>
                      </Command.Item>
                    ))}
                    {searching && hits.length === 0 && <div className="oo-cmd-empty" aria-live="polite">Searching…</div>}
                  </Command.Group>
                )}
                {q && (
                  <Command.Group heading="Or">
                    {canAdd && (
                      <Command.Item value="add" className="oo-cmd-item" onSelect={add} disabled={quickAdd.isPending} data-testid="cmd-add">
                        <IconPlus size={16} />
                        <span className="oo-cmd-title">Add a task: {parsed!.title}</span>
                        <span className="oo-cmd-kind">{IS_MAC ? '⌘' : 'Ctrl'} Enter</span>
                      </Command.Item>
                    )}
                    <Command.Item value="ask" className="oo-cmd-item" onSelect={ask} data-testid="cmd-ask">
                      <IconSearch size={16} />
                      <span className="oo-cmd-title">Ask OllieOS: {q}</span>
                    </Command.Item>
                  </Command.Group>
                )}
              </Command.List>
              <div className="oo-cmd-foot" aria-hidden="true">
                <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span>
                <span><kbd>Enter</kbd> to open</span>
                <span><kbd>{IS_MAC ? '⌘' : 'Ctrl'}</kbd> <kbd>Enter</kbd> to add as a task</span>
                <span><kbd>Esc</kbd> to close</span>
              </div>
            </Command>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
