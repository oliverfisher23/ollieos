import { useEffect, useState } from 'react';
import { Skel } from '@/components/bits';

/**
 * Shown while a page's code downloads. Waits 300ms first so a quick load (the usual case,
 * since nav links preload on touch) does not flash a skeleton.
 */
export function PageLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 300);
    return () => window.clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div role="status" aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }} data-testid="state-page-loading">
      <span className="sr-only">Loading</span>
      <Skel h={34} w="45%" />
      <Skel h={120} />
      <Skel h={64} />
      <Skel h={64} />
    </div>
  );
}
