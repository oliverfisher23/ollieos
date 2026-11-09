import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetHomeQueryKey,
  getGetTaskQueryKey,
  getGetTaskSummaryQueryKey,
  getListNoiseRulesQueryKey,
  getListTasksQueryKey,
} from '@workspace/api-client-react';

/** Invalidates every query a task edit can touch. */
export function useInvalidateTasks() {
  const qc = useQueryClient();
  return useCallback(
    (id?: number) => {
      if (id != null) qc.invalidateQueries({ queryKey: getGetTaskQueryKey(id) });
      qc.invalidateQueries({ queryKey: getListTasksQueryKey().slice(0, 1) });
      qc.invalidateQueries({ queryKey: getGetTaskSummaryQueryKey().slice(0, 1) });
      qc.invalidateQueries({ queryKey: getGetHomeQueryKey() });
      qc.invalidateQueries({ queryKey: getListNoiseRulesQueryKey() });
    },
    [qc],
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function toneFor(id: number | string): string {
  const n = typeof id === 'number' ? id : [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
  return String(Math.abs(n) % 5);
}
