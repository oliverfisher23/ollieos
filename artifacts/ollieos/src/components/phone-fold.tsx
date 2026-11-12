import { useState, type ReactNode } from 'react';
import { PHONE_QUERY, useMedia } from '@/lib/use-media';

/**
 * On phones, a long list shows as one button until it is wanted (docs/mobile-plan.md, Part D).
 * On wider screens the content shows as usual.
 */
export function PhoneFold({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const phone = useMedia(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  if (!phone || open) return <>{children}</>;
  return (
    <button type="button" className="oo-btn oo-btn-outline" style={{ alignSelf: 'flex-start' }} aria-expanded={false} onClick={() => setOpen(true)} data-testid={testId}>
      {label}
    </button>
  );
}
