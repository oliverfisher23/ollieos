/** External or internal, as a two-button switch. */
export function InternalSwitch({ value, onChange, testId, compact }: { value: boolean; onChange: (internal: boolean) => void; testId: string; compact?: boolean }) {
  const btn = compact ? { padding: '3px 10px' } : undefined;
  return (
    <span role="group" aria-label="External or internal" className="oo-seg" data-compact={compact || undefined} style={{ display: 'inline-flex', padding: compact ? 3 : 4 }} data-testid={testId}>
      <button type="button" aria-pressed={!value} style={btn} onClick={() => value && onChange(false)} data-testid={testId + '-external'}>
        External
      </button>
      <button type="button" aria-pressed={value} style={btn} onClick={() => !value && onChange(true)} data-testid={testId + '-internal'}>
        Internal
      </button>
    </span>
  );
}
