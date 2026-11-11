/**
 * Turns Granola meeting notes into Inbox items, Activity, Knowledge Inbox decisions and brief notes.
 * The same rules as the Claude sweep's meeting-notes route: actions go to the Inbox (no noise rules
 * for meetings), decisions are suggestions on a project, and the notes are attached to the
 * meeting's brief when the meeting is on the calendar.
 */
import { todayLondon } from "@workspace/shared";
import { logger } from "../../lib/logger";
import { attachMeetingNotes, findEventBySourceRef } from "../briefs";
import { propose } from "../suggestions";
import { ConflictError } from "../tasks";
import { applyProgress, cleanProgress, openItemsBlock, openItemsFor, type ProgressCounts } from "../taskEvidence";
import { captureSorted, emptyCounts, loadPeople, peopleIdsIn, projectChoices, type CaptureCounts } from "./capture";
import { meetingUnit, sortMeeting, type MeetingNote } from "./granola";

export const MEETING_PROPOSER = "OllieOS";

export interface MeetingCounts extends CaptureCounts {
  decisions: number;
  attached: number;
}

export async function captureMeetings(notes: MeetingNote[], ctx: { me: string; now: Date }): Promise<MeetingCounts> {
  const counts: MeetingCounts = { ...emptyCounts(), decisions: 0, attached: 0 };
  if (!notes.length) return counts;
  const choices = await projectChoices();
  const projectIdByName = new Map(choices.map((p) => [p.name.toLowerCase(), p.id]));

  for (const n of notes) {
    const event = n.calendarEventId ? await findEventBySourceRef(n.calendarEventId) : null;
    // Part U: open tasks with the people in the meeting, checked in the same read; always Looks done.
    const unit = meetingUnit(n);
    const [open] = await openItemsFor([unit], [peopleIdsIn(unit, await loadPeople([unit], []))]);
    const sorted = await sortMeeting(n, { me: ctx.me, projects: choices.map((p) => p.name), now: ctx.now, openItems: openItemsBlock(open) });
    const progress = cleanProgress(sorted.progress, unit, open);
    if (progress.length) {
      const pc: ProgressCounts = { closed: 0, looks_done: 0, progress: 0 };
      await applyProgress(unit, open, progress, pc);
      if (pc.looks_done) counts.looks_done = (counts.looks_done ?? 0) + pc.looks_done;
    }
    const [taskIds] = await captureSorted([unit], [sorted], {
      choices,
      rules: [],
      applyNoise: false,
      counts,
      projectFor: () => event?.projectId ?? null,
    });

    for (const d of sorted.decisions) {
      const projectId = projectIdByName.get(d.project.toLowerCase().trim()) ?? projectIdByName.get(sorted.project.toLowerCase().trim()) ?? event?.projectId ?? null;
      if (projectId == null) continue;
      const r = await propose(
        { proposedBy: MEETING_PROPOSER, clientId: null, sourceType: "meeting", sourceRef: `granola:${n.noteId}`, sourceUrl: n.url, sourceLabel: `Granola: ${n.title}`, saidBy: { at: n.at } },
        {
          kind: "decision",
          entityType: "project",
          entityId: projectId,
          payload: { text: d.text, decided_at: todayLondon(n.at), decided_by: null, source: `Granola: ${n.title}`, confidential: d.confidential ? true : null },
        },
        ctx.now,
      );
      if (r.status === "suggested" || r.status === "conflict") counts.decisions++;
    }

    if (event && !event.personal) {
      try {
        await attachMeetingNotes(event, { granolaRef: n.noteId, notes: n.notes, actionTaskIds: taskIds, actor: "ollieos", clientId: null });
        counts.attached++;
      } catch (err) {
        // No brief is possible when no one in the meeting is known to OllieOS; the items still landed.
        if (!(err instanceof ConflictError)) logger.warn({ err, note: n.noteId }, "Could not attach Granola notes to the brief");
      }
    }
  }
  return counts;
}
