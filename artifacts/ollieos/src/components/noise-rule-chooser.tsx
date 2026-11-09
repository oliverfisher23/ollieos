import { useEffect, useRef, useState } from 'react';
import { useGetNoiseRuleOptions, type NoiseRuleSummary, type Task, type TriageResult } from '@workspace/api-client-react';
import { useTaskActions } from '@/lib/task-actions';

/**
 * "Always ignore items like this", offered once an item is in Noise. Picking an option makes
 * a rule that only applies to new items from the next sweep, never to anything already captured.
 */
export function NoiseRuleChooser({
  task,
  dark = false,
  toast = true,
  onApplied,
}: {
  task: Task;
  dark?: boolean;
  toast?: boolean;
  onApplied?: (res: TriageResult) => void;
}) {
  const options = useGetNoiseRuleOptions(task.id, { query: { enabled: task.status === 'noise' && !task.noiseRule, staleTime: 60_000 } });
  const actions = useTaskActions();
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<NoiseRuleSummary | null>(task.noiseRule);
  const titleOption = options.data?.find((o) => o.matchType === 'title_contains');
  const [phrase, setPhrase] = useState('');
  useEffect(() => setPhrase(titleOption?.matchValue ?? ''), [titleOption?.matchValue]);
  useEffect(() => setApplied(task.noiseRule), [task.id, task.noiseRule]);
  // The button that was pressed disappears once the rule is made; move focus to the confirmation.
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const focusConfirm = useRef(false);
  useEffect(() => {
    if (applied && focusConfirm.current) {
      focusConfirm.current = false;
      const id = setTimeout(() => confirmRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [applied]);

  if (applied) {
    return (
      <p ref={confirmRef} tabIndex={-1} role="status" className={dark ? 'oo-t2' : 'oo-soft'} style={{ margin: 0, fontSize: 13, outline: 'none' }} data-testid={'text-noise-rule-' + task.id}>
        Ignoring from now on: <span style={{ fontWeight: 600 }}>{applied.label}</span>
      </p>
    );
  }
  if (task.source === 'meeting' || !options.data || options.data.length === 0) return null;

  const apply = async (matchType: NonNullable<typeof titleOption>['matchType'], matchValue: string) => {
    if (busy || !matchValue.trim()) return;
    setBusy(true);
    const res = await actions.triage(task, { action: 'noise', noiseRule: { matchType, matchValue: matchValue.trim() } }, { toast });
    setBusy(false);
    if (res?.noiseRule) {
      focusConfirm.current = true;
      setApplied({ id: res.noiseRule.id, matchType: res.noiseRule.matchType, matchValue: res.noiseRule.matchValue, label: res.noiseRule.label });
      onApplied?.(res);
    }
  };

  const btn = dark ? 'oo-chip' : 'oo-btn oo-btn-outline';
  const fixed = options.data.filter((o) => o.matchType !== 'title_contains');
  const inputId = 'noise-phrase-' + task.id;

  return (
    <div role="group" aria-labelledby={'noise-rule-h-' + task.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={'group-noise-rule-' + task.id}>
      <span id={'noise-rule-h-' + task.id} className={dark ? 'oo-t2' : 'oo-field-label'} style={{ fontSize: 13 }}>
        Always ignore items like this?
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {fixed.map((o) => (
          <button key={o.matchType} type="button" className={btn} disabled={busy} onClick={() => apply(o.matchType, o.matchValue)}
            data-testid={'button-noise-rule-' + o.matchType}>
            {o.label}
          </button>
        ))}
      </div>
      {titleOption && (
        <form style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
          onSubmit={(e) => { e.preventDefault(); apply('title_contains', phrase); }}>
          <label htmlFor={inputId} className={dark ? 'oo-t2' : 'oo-soft'} style={{ fontSize: 13 }}>Titles containing</label>
          <input id={inputId} className={dark ? 'oo-tri-input' : 'oo-input'} style={{ flex: '1 1 180px', minWidth: 0 }} value={phrase}
            onChange={(e) => setPhrase(e.target.value)} data-testid="input-noise-phrase" />
          <button type="submit" className={btn} disabled={busy || !phrase.trim()} data-testid="button-noise-rule-title_contains">Ignore these</button>
        </form>
      )}
      <span className={dark ? 'oo-t3' : 'oo-muted'} style={{ fontSize: 12 }}>Applies to new items from the next sweep. Nothing already captured changes.</span>
    </div>
  );
}
