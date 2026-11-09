import { useState } from 'react';
import { copyText } from '@/lib/knowledge';
import { notify } from '@/lib/notify';

/** A read-only value with a Copy button, for addresses Ollie pastes elsewhere. */
export function CopyField({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      notify('Copied', value);
      setTimeout(() => setCopied(false), 2000);
    } else {
      notify('Could not copy', 'Your browser blocked the clipboard.');
    }
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', maxWidth: 640 }}>
      <input
        className="oo-input oo-num"
        style={{ flex: '1 1 280px', minWidth: 0 }}
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        data-testid={'input-' + testId}
      />
      <button type="button" className="oo-btn oo-btn-outline" onClick={copy} data-testid={'button-copy-' + testId}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
