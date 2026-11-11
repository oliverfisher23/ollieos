import { useEffect } from 'react';
import { Skel } from '@/components/bits';
import { PageProblem } from '@/components/knowledge/parts';

/**
 * The list and the reading pane side by side on wide screens; one at a time on narrow ones.
 * On wide screens the first email opens when none is picked.
 */
export function Mail({ ids, picked, wide, loading, failed, retry, what, empty, onPick, row, reader }: {
  ids: string[];
  picked: string | null;
  wide: boolean;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  what: string;
  empty: string;
  onPick: (id: string) => void;
  row: (id: string, current: boolean) => React.ReactNode;
  reader: (id: string, next: string | null) => React.ReactNode;
}) {
  // Wide screens open the first email, and put it in the address so it stays open once dealt with.
  const first = ids[0];
  useEffect(() => {
    if (wide && picked == null && first != null) onPick(first);
  }, [wide, picked, first, onPick]);

  if (loading) {
    return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[0, 1, 2, 3].map((i) => <Skel key={i} h={64} />)}</div>;
  }
  if (failed) return <PageProblem notFound={false} what={what} onRetry={retry} back={{ href: '/tasks', label: 'Tasks' }} />;
  // An email just dealt with stays open (to undo or add a noise rule) though it has left the list.
  const open = picked;
  if (ids.length === 0 && open == null) {
    return <p className="oo-muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }} data-testid={'state-email-empty'}>{empty}</p>;
  }
  const at = open != null ? ids.indexOf(open) : -1;
  const next = at >= 0 ? (ids[at + 1] ?? ids[at - 1] ?? null) : (ids[0] ?? null);

  return (
    <div className="oo-mail" data-open={open != null ? 'true' : 'false'}>
      <ul className="oo-mail-list" aria-label="Emails">
        {ids.map((id) => <li key={id}>{row(id, id === open)}</li>)}
        {ids.length === 0 && <li className="oo-muted" style={{ padding: 14, fontSize: 13 }}>{empty}</li>}
      </ul>
      <section className="oo-mail-read" aria-label="Reading pane">
        {open != null ? reader(open, next === open ? null : next) : null}
      </section>
    </div>
  );
}
