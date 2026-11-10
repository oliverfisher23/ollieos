import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';

export interface DropdownOption {
  value: string;
  label: string;
  /** Muted text on the right of the row, such as an organisation or a count */
  hint?: string;
  /** Consecutive options with the same group sit under one heading */
  group?: string;
  /** Shows the option one step in, for sub-goals */
  indent?: boolean;
  /** A small mark before the label, such as a source dot or an avatar */
  leading?: ReactNode;
}

/**
 * - field: full-width form field
 * - control: filter bar button; shows as active when a value other than '' is chosen
 * - compact: small inline picker inside a line of text or a details list
 * - dark: on the dark glass of triage
 * - bare: no frame, for editing straight from a table cell; pass `trigger` to show the cell's own content
 */
export type DropdownVariant = 'field' | 'control' | 'compact' | 'dark' | 'bare';

const SEARCH_FROM = 8;
const key = (v: string) => 'v:' + v;

/** Plain "contains" matching on the label, hint and heading, so a search never turns up letters scattered through a word. */
function matches(_value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const text = (keywords ?? []).join(' ').toLowerCase();
  if (text.startsWith(q) || text.includes(' ' + q)) return 1;
  return text.includes(q) ? 0.5 : 0;
}

/**
 * The one dropdown used across OllieOS. Opens a panel under the trigger with keyboard
 * navigation; longer lists get a search box at the top.
 */
export function Dropdown({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  id,
  ariaLabel,
  variant = 'field',
  searchable,
  searchPlaceholder = 'Search',
  disabled,
  testId,
  style,
  title,
  align = 'start',
  defaultOpen = false,
  trigger,
  footer,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  /** Pair with <label htmlFor> */
  id?: string;
  ariaLabel?: string;
  variant?: DropdownVariant;
  /** Defaults to on for lists of 8 or more */
  searchable?: boolean;
  searchPlaceholder?: string;
  disabled?: boolean;
  testId?: string;
  style?: CSSProperties;
  title?: string;
  align?: 'start' | 'end';
  /** Open the list as soon as it appears, for pickers revealed by a button */
  defaultOpen?: boolean;
  /** Replaces the chosen label inside the button, such as a status pill */
  trigger?: ReactNode;
  /** Extra controls under the list, such as a date field. Call `close` once done. */
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [highlight, setHighlight] = useState(key(value));
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const withSearch = searchable ?? options.length >= SEARCH_FROM;
  const current = options.find((o) => o.value === value);

  // Consecutive runs of the same group, so headings follow the order given.
  const groups = useMemo(() => {
    const out: { heading?: string; items: DropdownOption[] }[] = [];
    for (const o of options) {
      const last = out[out.length - 1];
      if (last && last.heading === o.group) last.items.push(o);
      else out.push({ heading: o.group, items: [o] });
    }
    return out;
  }, [options]);

  useEffect(() => {
    if (!open) return;
    setHighlight(key(value));
    setQuery('');
    const t = setTimeout(() => {
      (withSearch ? inputRef.current : rootRef.current)?.focus();
      listRef.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' });
    }, 0);
    return () => clearTimeout(t);
  }, [open, value, withSearch]);

  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          className="oo-dd"
          data-variant={variant}
          data-active={variant === 'control' && value !== '' ? 'true' : undefined}
          data-empty={!current || value === '' ? 'true' : undefined}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          title={title}
          style={style}
          data-testid={testId}
        >
          {trigger ?? (
            <>
              {current?.leading && <span className="oo-dd-lead" aria-hidden="true">{current.leading}</span>}
              <span className="oo-dd-value">{current ? current.label : placeholder}</span>
            </>
          )}
          <svg className="oo-dd-chev" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="oo-dd-panel"
          align={align}
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          // React events bubble through portals; keep picks from also clicking a table row behind.
          onClick={(e) => e.stopPropagation()}
          data-testid={testId ? testId + '-panel' : undefined}
        >
          <Command
            ref={rootRef}
            tabIndex={-1}
            value={highlight}
            onValueChange={setHighlight}
            shouldFilter={withSearch}
            filter={matches}
            loop
            label={ariaLabel ?? 'Options'}
            className="oo-dd-cmd"
          >
            {withSearch && (
              <div className="oo-dd-search">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <Command.Input ref={inputRef} value={query} onValueChange={setQuery} placeholder={searchPlaceholder} data-testid={testId ? testId + '-search' : undefined} />
              </div>
            )}
            <Command.List ref={listRef} className="oo-dd-list">
              <Command.Empty className="oo-dd-empty">Nothing matches “{query}”</Command.Empty>
              {groups.map((g, i) => {
                const items = g.items.map((o) => (
                  <Command.Item
                    key={o.value}
                    value={key(o.value)}
                    keywords={[o.label, o.hint ?? '', o.group ?? '']}
                    onSelect={() => pick(o.value)}
                    className="oo-dd-item"
                    data-current={o.value === value ? 'true' : undefined}
                    data-indent={o.indent ? 'true' : undefined}
                    data-testid={testId ? `${testId}-option-${o.value || 'none'}` : undefined}
                  >
                    {o.leading && <span className="oo-dd-lead" aria-hidden="true">{o.leading}</span>}
                    <span className="oo-dd-label">{o.label}</span>
                    {o.hint && <span className="oo-dd-hint">{o.hint}</span>}
                    <svg className="oo-dd-tick" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Command.Item>
                ));
                return g.heading ? (
                  <Command.Group key={g.heading + i} heading={g.heading} className="oo-dd-group">{items}</Command.Group>
                ) : (
                  <Command.Group key={'g' + i} className="oo-dd-group">{items}</Command.Group>
                );
              })}
            </Command.List>
          </Command>
          {footer && <div className="oo-dd-footer">{footer(() => setOpen(false))}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A coloured dot for an option, from a CSS variable. */
export function Dot({ color }: { color: string }) {
  return <span className="oo-dd-dot" style={{ background: color }} />;
}
