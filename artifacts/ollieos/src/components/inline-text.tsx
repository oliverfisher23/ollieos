import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { notify } from '@/lib/notify';

interface Props {
  value: string | null | undefined;
  /** Saves the new value. Return false to keep the editor open. */
  onSave: (value: string | null) => Promise<unknown> | unknown;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  inline?: boolean;
  maxLength?: number;
  style?: CSSProperties;
  testId: string;
}

/**
 * Text that reads as plain text and turns into a field when clicked.
 * Enter saves a single line, Ctrl or Cmd + Enter saves a paragraph, Escape cancels, leaving the field saves.
 */
export function InlineText({ value, onSave, label, placeholder = 'Add…', multiline, required, inline, maxLength, style, testId }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [shown, setShown] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);

  useEffect(() => setShown(null), [value]);
  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    if (multiline) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 2 + 'px';
    }
  }, [editing, multiline]);

  const start = () => {
    setDraft(value ?? '');
    cancelled.current = false;
    setEditing(true);
  };

  const finish = async () => {
    if (cancelled.current) return;
    cancelled.current = true;
    const next = draft.trim();
    setEditing(false);
    setTimeout(() => btnRef.current?.focus(), 0);
    if (next === (value ?? '').trim()) return;
    if (!next && required) {
      notify(`${label} cannot be empty`, 'The previous text has been kept.');
      return;
    }
    setShown(next);
    const res = await onSave(next || null);
    if (res === false) setShown(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelled.current = true;
      setEditing(false);
      setTimeout(() => btnRef.current?.focus(), 0);
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void finish();
    }
  };

  if (editing) {
    const common = {
      ref,
      className: 'oo-edit-field' + (inline ? ' oo-edit-inline' : ''),
      value: draft,
      maxLength,
      'aria-label': label,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      onBlur: () => void finish(),
      onKeyDown: onKey,
      style,
      'data-testid': 'input-' + testId,
    };
    return multiline ? (
      <textarea
        {...common}
        rows={3}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = el.scrollHeight + 2 + 'px';
        }}
      />
    ) : (
      <input {...common} type="text" />
    );
  }

  const text = shown ?? value ?? '';
  return (
    <button
      ref={btnRef}
      type="button"
      className={'oo-edit' + (inline ? ' oo-edit-inline' : '')}
      data-empty={!text}
      onClick={start}
      aria-label={`${label}: ${text || 'empty'}. Click to edit`}
      style={style}
      data-testid={'edit-' + testId}
    >
      {text || placeholder}
    </button>
  );
}
