/**
 * Turns Granola meeting notes into Inbox items, Activity, Knowledge Inbox decisions and brief notes.
 * The same rules as the Claude sweep's meeting-notes route: actions go to the Inbox (no noise rules
 * for meetings), decisions are suggestions on a project, and the notes are attached to the
 * meeting's brief when the meeting is on the calendar.
 */
import { markHistoryNotes } from "../timeAndMeetings";
import { db, meetingTonesTable } from "@workspace/db";
import { todayLondon } from "@workspace/shared";
import { logger } from "../../lib/logger";
import type { CalendarEvent } from "@workspace/db";
import { attachMeetingNotes, findEventBySourceRef, findEventForNote } from "../briefs";
import { propose } from "../suggestions";
import { applyProgress, cleanProgress, openItemsBlock, openItemsFor, type ProgressCounts } from "../taskEvidence";
import { markCovered, openPointsFor, pointsBlock } from "../talkingPoints";
import { writeFollowUp } from "../meetingFollowUp";
import { captureSorted, emptyCounts, loadPeople, mayReadForKnowledge, peopleIdsIn, projectChoices, type CaptureCounts } from "./capture";
import { addSpottedIdea } from "../strategy";
import { lessonsFor } from "../readerLessons";
import { meetingUnit, sortMeeting, type MeetingNote } from "./granola";

export const MEETING_PROPOSER = "OllieOS";

export interface MeetingCounts extends CaptureCounts {
  decisions: number;
  attached: number;
  /** Part K: talking points the notes covered, and follow-up drafts written */
  points_covered?: number;
  follow_ups?: number;
}

export async function captureMeetings(
  notes: MeetingNote[],
  ctx: { me: string; now: Date; myEmails?: Set<string>; /** Ollie linked the note to this meeting by hand */ event?: CalendarEvent },
): Promise<MeetingCounts> {
  const counts: MeetingCounts = { ...emptyCounts(), decisions: 0, attached: 0 };
  if (!notes.length) return counts;
  const choices = await projectChoices();
  // Section 24: the lessons Ollie turned on for the Granola reader.
  const lessons = await lessonsFor("granola_reader");
  const projectIdByName = new Map(choices.map((p) => [p.name.toLowerCase(), p.id]));

  for (const n of notes) {
    // Granola's own calendar link first; otherwise the work meeting at the same time with the same title or people.
    const event = ctx.event ?? (n.calendarEventId ? await findEventBySourceRef(n.calendarEventId) : null) ?? (await findEventForNote(n, ctx.myEmails));
    // Part U: open tasks with the people in the meeting, checked in the same read; always Looks done.
    const unit = meetingUnit(n);
    const loaded = await loadPeople([unit], []);
    const personIds = peopleIdsIn(unit, loaded);
    const [open] = await openItemsFor([unit], [personIds]);
    // Part K: points Ollie wanted to raise with the people in the meeting.
    const points = await openPointsFor([...new Set([...personIds, ...(event?.personIds ?? [])])]);
    const sorted = await sortMeeting(n, { me: ctx.me, projects: choices.map((p) => p.name), now: ctx.now, openItems: openItemsBlock(open), talkingPoints: pointsBlock(points), lessons });
    // Part S: the tone of the meeting, for the client pulse.
    await db
      .insert(meetingTonesTable)
      .values({ granolaRef: n.noteId, title: event?.title ?? n.title, at: n.at, tone: sorted.tone ?? "neutral", reason: sorted.toneReason ?? null, personIds: [...new Set([...personIds, ...(event?.personIds ?? [])])] })
      .onConflictDoNothing();
    // Part R: what the notes made of the meeting, for Meetings worth keeping.
    if (event) await markHistoryNotes(event.sourceRef, sorted.items.length, sorted.decisions.length);
    const offered = new Set(points.map((p) => `point:${p.id}`));
    const covered = (sorted.covered ?? []).filter((r) => offered.has(r)).map((r) => Number(r.split(":")[1]));
    if (covered.length) counts.points_covered = (counts.points_covered ?? 0) + (await markCovered(covered, { eventId: event?.id ?? null, title: event?.title ?? n.title, at: n.at }));
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
      open: [open],
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

    // Section 23, the idea spotter: never from a meeting with anyone hidden from AI. A problem never stops the check.
    if (sorted.ideas?.length && mayReadForKnowledge(unit, loaded)) {
      for (const [k, idea] of sorted.ideas.entries()) {
        try {
          const added = await addSpottedIdea({
            title: idea.title,
            notes: idea.notes || null,
            projectId: projectIdByName.get(idea.project.toLowerCase().trim()) ?? event?.projectId ?? null,
            confidential: idea.confidential,
            sourceRef: `granola:${n.noteId}#idea:${k + 1}`,
            sourceLabel: `Granola: ${event?.title ?? n.title}`,
            sourceUrl: n.url ?? null,
          });
          if (added) counts.ideas = (counts.ideas ?? 0) + 1;
        } catch (err) {
          logger.warn({ err, note: n.noteId }, "Could not add a spotted idea");
        }
      }
    }

    // Part K: a follow-up draft for external meetings, saved to Gmail; never sent. A problem never stops the check.
    if (event && !event.personal) {
      try {
        const f = await writeFollowUp(event, n, sorted, ctx.myEmails ?? new Set());
        if (f) counts.follow_ups = (counts.follow_ups ?? 0) + 1;
      } catch (err) {
        logger.warn({ err, note: n.noteId }, "Could not write the meeting follow-up");
      }
    }

    if (event && !event.personal) {
      try {
        // Every work meeting keeps its note, with or without a brief.
        await attachMeetingNotes(event, { granolaRef: n.noteId, notes: n.notes, url: n.url, actionTaskIds: taskIds, actor: "ollieos", clientId: null });
        counts.attached++;
      } catch (err) {
        logger.warn({ err, note: n.noteId }, "Could not attach Granola notes to the meeting");
      }
    }
  }
  return counts;
}
