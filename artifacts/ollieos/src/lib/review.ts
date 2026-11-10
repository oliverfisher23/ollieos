import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { decideReview, type ReviewDecideInputAction, type ReviewItem } from '@workspace/api-client-react';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

type Action = ReviewDecideInputAction;

export const n = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;

/** Choosing for review items: one at a time or in bulk, with Waiting on asking who first. */
export function useReviewDecide(noun: (count: number) => string, line: (action: Action, count: number) => string) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Which Waiting on picker is open: an item id, or the bulk bar */
  const [waitingFor, setWaitingFor] = useState<number | 'bulk' | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const decide = async (ids: number[], action: Action, waitingOnPersonId?: number | null) => {
    setBusy(true);
    try {
      const r = await decideReview({ ids, action, ...(waitingOnPersonId !== undefined ? { waitingOnPersonId } : {}) });
      notify(line(action, r.items.length));
      setSelected((s) => {
        const next = new Set(s);
        for (const id of ids) next.delete(id);
        return next;
      });
      setWaitingFor(null);
      void qc.invalidateQueries({ predicate: (query) => { const k = String(query.queryKey[0] ?? ''); return k.includes('/review') || k.includes('/tasks') || k.includes('/connectors'); } });
      return r.items as ReviewItem[];
    } catch (err) {
      reportApiError(err);
      notify(`Could not update the ${noun(ids.length)}`, errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  return { selected, setSelected, waitingFor, setWaitingFor, busy, toggle, decide };
}

