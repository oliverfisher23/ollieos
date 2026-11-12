import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation } from 'wouter';
import { useListProjects, useQuickAddTask } from '@workspace/api-client-react';
import { formatShort, parseQuickAdd, type QuickAddToken } from '@workspace/shared';
import { IconMic, IconUp } from '@/components/icons';
import { useInvalidateTasks } from '@/lib/task-cache';
import { notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const HINTS = ['!high', 'due:fri', '#backlog', '@project'];

function tokenLabel(t: QuickAddToken): string {
  if (t.kind === 'due') return 'Due ' + formatShort(t.label);
  if (t.kind === 'unknown-due') return 'Date not understood: ' + t.label;
  if (t.kind === 'project') return '@' + t.label;
  return t.label;
}

export function AddBox({ idPrefix = 'home', autoFocus = false, onAdded }: { idPrefix?: string; autoFocus?: boolean; onAdded?: () => void }) {
  const [mode, setMode] = useState<'add' | 'ask'>('add');
  const [text, setText] = useState('');
  const [question, setQuestion] = useState('');
  const [, navigate] = useLocation();
  const projects = useListProjects();
  const quickAdd = useQuickAddTask();
  const invalidate = useInvalidateTasks();
  const add = mode === 'add';

  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text) : null), [text]);
  const projectMissing =
    !!parsed?.projectSlug && !!projects.data && !projects.data.some((p) => p.slug === parsed.projectSlug);

  const canSubmit = add ? !!parsed && parsed.title.length > 0 && !quickAdd.isPending : question.trim().length > 0;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    if (!add) {
      const q = question.trim().slice(0, 1000);
      setQuestion('');
      onAdded?.();
      navigate('/ask?q=' + encodeURIComponent(q));
      return;
    }
    quickAdd.mutate(
      { data: { text: text.trim() } },
      {
        onSuccess: (res) => {
          setText('');
          invalidate(res.task.id);
          notify('Task added', res.warnings.length ? res.warnings.join('. ') : res.task.title);
          onAdded?.();
        },
        onError: (err) => {
          reportApiError(err);
          notify('Could not add that task', 'Check the text and try again.');
        },
      },
    );
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const boxId = idPrefix + '-box';
  return (
    <form className="oo-ask" aria-label="Ask or add" onSubmit={submit} data-testid={'form-add-' + idPrefix}>
      <div role="group" aria-label="Mode" style={{ display: 'flex', gap: 4, padding: '2px 4px' }}>
        <button type="button" className="oo-mode" aria-pressed={add} onClick={() => setMode('add')} data-testid={'button-mode-add-' + idPrefix}>Add a task</button>
        <button type="button" className="oo-mode" aria-pressed={!add} onClick={() => setMode('ask')} data-testid={'button-mode-ask-' + idPrefix}>Ask OllieOS</button>
      </div>
      <label htmlFor={boxId} className="oo-sr">{add ? 'Add a task' : 'Ask OllieOS'}</label>
      <textarea
        id={boxId}
        rows={2}
        autoFocus={autoFocus}
        value={add ? text : question}
        maxLength={add ? undefined : 1000}
        onChange={(e) => (add ? setText(e.target.value) : setQuestion(e.target.value))}
        onKeyDown={onKey}
        placeholder={add ? 'Add a task…  e.g. Chase the demo date !high due:fri @project' : 'Ask anything you know…  e.g. What do I owe people this week?'}
        data-testid={'input-add-' + idPrefix}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '2px 6px 4px 10px' }}>
        {!add ? (
          <span className="oo-t2" style={{ fontSize: 13 }} data-testid={'text-ask-hint-' + idPrefix}>
            Answers only from OllieOS, with sources. Confidential items are never used.
          </span>
        ) : parsed && parsed.tokens.length + (parsed.title ? 1 : 0) > 0 ? (
          <>
            <span className="oo-t3" style={{ fontSize: 13 }}>Understood:</span>
            <span className="oo-chip" data-testid={'chip-priority-' + idPrefix}>{parsed.priority === 'high' ? 'High' : parsed.priority === 'low' ? 'Low' : 'Medium'} priority</span>
            {parsed.tokens
              .filter((t) => t.kind !== 'priority')
              .map((t, i) => (
                <span
                  key={i}
                  className="oo-chip"
                  data-warn={t.kind === 'unknown-due' || (t.kind === 'project' && projectMissing)}
                  data-testid={'chip-token-' + t.kind + '-' + idPrefix}
                >
                  {tokenLabel(t)}
                </span>
              ))}
            {!parsed.title && <span className="oo-chip" data-warn="true">Needs a title</span>}
          </>
        ) : (
          <>
            <span className="oo-t3" style={{ fontSize: 13 }}>Try:</span>
            {HINTS.map((h) => (
              <button
                key={h}
                type="button"
                className="oo-chip"
                onClick={() => setText((t) => (t ? t.trimEnd() + ' ' : '') + h + (h === '@project' ? '' : ' '))}
                data-testid={'button-hint-' + h.replace(/[^a-z]/g, '') + '-' + idPrefix}
              >
                {h}
              </button>
            ))}
          </>
        )}
        <div style={{ flexGrow: 1 }} />
        {add && (
          <button type="button" className="oo-send" style={{ background: 'transparent', color: 'inherit' }} aria-label="Speak instead" onClick={() => { onAdded?.(); navigate('/voice'); }} data-testid={'button-voice-' + idPrefix}>
            <IconMic />
          </button>
        )}
        <button type="submit" className="oo-send" aria-label={add ? 'Add task' : 'Ask'} disabled={!canSubmit} data-testid={'button-submit-' + idPrefix}>
          <IconUp />
        </button>
      </div>
      {add && projectMissing && (
        <p role="status" className="oo-amber" style={{ margin: '0 10px 4px', fontSize: 12, fontWeight: 500 }} data-testid={'text-project-warning-' + idPrefix}>
          No project called @{parsed?.projectSlug}. It will be added without a project.
        </p>
      )}
    </form>
  );
}
