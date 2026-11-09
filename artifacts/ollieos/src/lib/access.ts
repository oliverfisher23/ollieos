import { useQueryClient } from '@tanstack/react-query';
import {
  approveAccessRequest,
  declineAccessRequest,
  endAccess,
  getGetAiAccessSummaryQueryKey,
  getGetHomeQueryKey,
  getListAccessRequestsQueryKey,
  getListAiActivityQueryKey,
  type AccessRequest,
  type ApproveAccessInput,
} from '@workspace/api-client-react';
import { formatDayMonthShort, formatTime, londonDate, todayLondon } from '@workspace/shared';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

/** "08:12 today", or "8th Nov, 08:12" for older times. */
export function whenLabel(at: string): string {
  return londonDate(at) === todayLondon() ? `${formatTime(at)} today` : `${formatDayMonthShort(at)}, ${formatTime(at)}`;
}

/** The item name, or what the AI asked for when nothing matched. */
export function requestItemName(r: AccessRequest): string {
  return r.item?.name ?? `“${r.requestedName}”`;
}

/** Approve, decline and end, with every view that shows requests kept in step. */
export function useAccessActions() {
  const qc = useQueryClient();
  const refresh = () => {
    for (const key of [getListAccessRequestsQueryKey(), getGetHomeQueryKey(), getGetAiAccessSummaryQueryKey(), getListAiActivityQueryKey()]) {
      void qc.invalidateQueries({ queryKey: [key[0]] });
    }
  };
  const run = async <T,>(fn: () => Promise<T>, failTitle: string): Promise<T | null> => {
    try {
      const res = await fn();
      refresh();
      return res;
    } catch (err) {
      reportApiError(err);
      notify(failTitle, errorMessage(err));
      refresh();
      return null;
    }
  };
  return {
    approve: (r: AccessRequest, match?: ApproveAccessInput) => run(() => approveAccessRequest(r.id, match ?? {}), 'Could not allow that'),
    decline: (r: AccessRequest) => run(() => declineAccessRequest(r.id), 'Could not decline that'),
    end: (r: AccessRequest) => run(() => endAccess(r.id), 'Could not end that access'),
  };
}

export function hiddenSummary(h: { projects: number; people: number; organisations: number }): string {
  const parts: string[] = [];
  if (h.projects) parts.push(h.projects === 1 ? '1 project' : `${h.projects} projects`);
  if (h.people) parts.push(h.people === 1 ? '1 person' : `${h.people} people`);
  if (h.organisations) parts.push(h.organisations === 1 ? '1 organisation' : `${h.organisations} organisations`);
  return parts.length ? parts.join(', ') : 'Nothing';
}
