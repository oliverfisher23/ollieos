import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import {
  getClearOut,
  getDayPlan,
  getGetClearOutQueryKey,
  getGetDayPlanQueryKey,
  getGetHomeQueryKey,
  getHome,
  getGetProjectQueryKey,
  getListKnowledgeInboxQueryKey,
  getListProjectsQueryKey,
  getListTasksQueryKey,
  getProject,
  listKnowledgeInbox,
  listProjects,
  listTasks,
} from '@workspace/api-client-react';
import { isForbiddenError, reportApiError } from '@/lib/forbidden';
import { preloadRoute } from '@/routes';
import { PHONE_QUERY } from '@/lib/use-media';

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportApiError }),
  mutationCache: new MutationCache({ onError: reportApiError }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !isForbiddenError(err) && (err as { status?: number } | null)?.status !== 404 && count < 2,
      refetchOnWindowFocus: true,
      // Coming back to the app within 30 seconds reuses what is on screen instead of refetching
      // every query. Writes still refresh at once: they invalidate their queries.
      staleTime: 30_000,
    },
  },
});

/**
 * Runs before the first render (docs/mobile-plan.md, Part B). Without it the phone waits for the
 * app's code, then for the sign-in check, then for the page's code and data one after another.
 * Starts the current page's code and, on Home and Knowledge, their first data, alongside the sign-in check.
 * Signed out, the data calls answer 401 and are dropped; nothing is shown from them.
 */
export function startEarlyLoads(path: string) {
  preloadRoute(path);
  const p = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const early = { retry: false, staleTime: 30_000 } as const;
  if (p === '/knowledge' || p.startsWith('/knowledge/projects/')) {
    // Knowledge opens on the latest project, so its data otherwise waits for the project list and then the page's code.
    void queryClient.prefetchQuery({ queryKey: getListKnowledgeInboxQueryKey({ tab: 'suggested' }), queryFn: ({ signal }) => listKnowledgeInbox({ tab: 'suggested' }, { signal }), ...early });
    const slug = p.startsWith('/knowledge/projects/') ? decodeURIComponent(p.slice('/knowledge/projects/'.length)) : null;
    if (slug) {
      void queryClient.prefetchQuery({ queryKey: getGetProjectQueryKey(slug), queryFn: ({ signal }) => getProject(slug, { signal }), ...early });
      return;
    }
    const list = queryClient.fetchQuery({ queryKey: getListProjectsQueryKey(), queryFn: ({ signal }) => listProjects(undefined, { signal }), ...early });
    // On phones /knowledge is the Knowledge menu, so it does not open the latest project.
    if (window.matchMedia(PHONE_QUERY).matches) {
      void list.catch(() => {});
      return;
    }
    void list
      .then((projects) => {
        const latest = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!latest) return;
        return queryClient.prefetchQuery({ queryKey: getGetProjectQueryKey(latest.slug), queryFn: ({ signal }) => getProject(latest.slug, { signal }), ...early });
      })
      .catch(() => {});
    return;
  }
  if (p !== '/' && p !== '/triage' && p !== '/clear-out') return;
  void queryClient.prefetchQuery({ queryKey: getGetHomeQueryKey(), queryFn: ({ signal }) => getHome({ signal }), ...early });
  void queryClient.prefetchQuery({ queryKey: getGetDayPlanQueryKey(), queryFn: ({ signal }) => getDayPlan({ signal }), ...early });
  void queryClient.prefetchQuery({ queryKey: getListTasksQueryKey({ tab: 'open' }), queryFn: ({ signal }) => listTasks({ tab: 'open' }, { signal }), ...early });
  void queryClient.prefetchQuery({ queryKey: getGetClearOutQueryKey(), queryFn: ({ signal }) => getClearOut({ signal }), ...early });
}
