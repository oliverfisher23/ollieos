import { useSyncExternalStore } from 'react';

let forbidden = false;
const listeners = new Set<() => void>();

export function isForbiddenError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 403;
}

export function reportApiError(err: unknown) {
  if (isForbiddenError(err) && !forbidden) {
    forbidden = true;
    listeners.forEach((l) => l());
  }
}

export function useForbidden(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => forbidden,
  );
}
