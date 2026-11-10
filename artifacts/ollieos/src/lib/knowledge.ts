import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useInvalidateTasks } from '@/lib/task-cache';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const KNOWLEDGE_PREFIXES = ['/api/projects', '/api/people', '/api/organisations', '/api/decisions', '/api/notes', '/api/search', '/api/suggestions', '/api/goals', '/api/documents', '/api/playbooks', '/api/home', '/api/sessions'];

/** Invalidates every Knowledge query, plus the task caches that show project and person names. */
export function useInvalidateKnowledge() {
  const qc = useQueryClient();
  const invalidateTasks = useInvalidateTasks();
  return useCallback(() => {
    qc.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey[0];
        return typeof k === 'string' && KNOWLEDGE_PREFIXES.some((p) => k === p || k.startsWith(p + '/') || k.startsWith(p + '?'));
      },
    });
    invalidateTasks();
  }, [qc, invalidateTasks]);
}

/** Runs a Knowledge write, refreshes the caches, and reports failure in a toast. Returns undefined on failure. */
export function useKnowledgeWrite() {
  const invalidate = useInvalidateKnowledge();
  return useCallback(
    async <T,>(fn: () => Promise<T>, opts: { done?: string; fail?: string } = {}): Promise<T | undefined> => {
      try {
        const res = await fn();
        invalidate();
        if (opts.done) notify(opts.done);
        return res;
      } catch (err) {
        reportApiError(err);
        notify(opts.fail ?? 'That did not save', errorMessage(err));
        return undefined;
      }
    },
    [invalidate],
  );
}

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}

export type EntityKind = 'project' | 'person' | 'organisation';

export function entityPath(type: string, slug: string | null | undefined, id: number): string | null {
  if (type === 'project' && slug) return `/knowledge/projects/${slug}`;
  if (type === 'person' && slug) return `/knowledge/people/${slug}`;
  if (type === 'organisation' && slug) return `/knowledge/organisations/${slug}`;
  if (type === 'decision') return `/knowledge/decisions/${id}`;
  if (type === 'note') return `/knowledge/notes/${id}`;
  if (type === 'task') return `/tasks?task=${id}`;
  if (type === 'session') return `/knowledge/sessions?session=${id}`;
  return null;
}

/** "task:12" to an app path; facts open their parent so they have no path of their own here. */
export function refPath(ref: string | null): string | null {
  if (!ref) return null;
  const [type, raw] = ref.split(':');
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  if (type === 'task') return `/tasks?task=${id}`;
  if (type === 'decision') return `/knowledge/decisions/${id}`;
  if (type === 'note') return `/knowledge/notes/${id}`;
  if (type === 'session') return `/knowledge/sessions?session=${id}`;
  return null;
}

export const TYPE_LABELS: Record<string, string> = {
  task: 'Task',
  project: 'Project',
  person: 'Person',
  organisation: 'Organisation',
  decision: 'Decision',
  note: 'Note',
  fact: 'Fact',
  document: 'Document',
  session: 'Cowork session',
};

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
