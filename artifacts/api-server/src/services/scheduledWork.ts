/**
 * Work that runs after OllieOS has fresh data: when the Claude sweep finishes, and after each of
 * OllieOS's own checks. Marking new Inbox items that are probably noise, the weekly fact check after Sunday 18:00, clearing old rejected
 * suggestions, briefs for today's and tomorrow's meetings, research on outside companies, the contradiction check, the morning digest, the weekly round-up and the 30-day
 * clean-ups. Each part runs on its own, and a failure in one never stops the others.
 */
import { learnRulesIfDue } from "./draftLearning";
import { gradeIfDue } from "./writerChecks";
import { clearOldHistory } from "./timeAndMeetings";
import { clearOldAiRuns } from "../lib/aiRuns";
import { clearOldInputs } from "./evals";
import { clearOldNoise } from "./exports";
import { londonParts } from "@workspace/shared";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { clearOldCalendar } from "./aiWrites";
import { buildUpcomingBriefs } from "./briefs";
import { buildDigestIfDue, clearOldDigests } from "./digest";
import { onSweepFinished } from "./factReviews";
import { checkInboxNoise } from "./noiseCheck";
import { researchUpcoming } from "./research";
import { checkNewCards } from "./contradictions";
import { buildRoundupIfDue, clearOldRoundups } from "./roundup";
import { presortCards } from "./presort";
import { checkStaleFacts } from "./staleCheck";
import { suggestDelegations } from "./delegation";
import { draftWeeklyUpdateIfDue } from "./weeklyUpdate";
import { learnLessonsIfDue } from "./readerLessons";
import { findDuplicatesIfDue } from "./duplicates";
import { linkPeopleToTasks } from "./taskPeople";
import { coachStuckIfDue } from "./stuckCoach";
import { buildWorkPacks } from "./workPack";
import { clearOldSightings, findContacts } from "./contactFinder";
import { fillTasks } from "./autoFill";

/** OllieOS's own checks start at 07:00, so they wait for 07:40 (when the morning sweep ran) before building the digest. */
export const DIGEST_NOT_BEFORE = { hour: 7, minute: 40 };

export function digestTimeReached(now: Date): boolean {
  const p = londonParts(now);
  return p.hour * 60 + p.minute >= DIGEST_NOT_BEFORE.hour * 60 + DIGEST_NOT_BEFORE.minute;
}

let workTail: Promise<unknown> = Promise.resolve();

export function scheduledWork(from: "sweep" | "connectors", now = new Date()): Promise<Record<string, unknown>> {
  // Wait locally before reserving a pool connection for the cross-server lock.
  const work = workTail.then(() => lockedScheduledWork(from, now));
  workTail = work.catch(() => undefined);
  return work;
}

async function lockedScheduledWork(from: "sweep" | "connectors", now: Date): Promise<Record<string, unknown>> {
  // Share the lock with timer/sweep calls too: no two preparation passes overlap,
  // even on different server instances. Session locks avoid a long-lived transaction.
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(472091, 1)");
    return await runScheduledWork(from, now);
  } finally {
    try {
      await client.query("select pg_advisory_unlock(472091, 1)");
      client.release();
    } catch (err) {
      client.release(true);
      logger.error({ err }, "Could not release scheduled work lock");
    }
  }
}

async function runScheduledWork(from: "sweep" | "connectors", now: Date): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const part = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      logger.error({ err, part: name, from }, "Scheduled work failed");
      out[name] = { error: "Did not run. It will try again after the next check." };
    }
  };
  await part("knowledge", async () => {
    const r = await onSweepFinished(now);
    return { rejected_cleared: r.cleared, fact_check: r.check };
  });
  // Section 27: people linked to tasks nobody is on yet (no AI). Tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("task_people", () => linkPeopleToTasks());
  // Section 30, Part H: a project or due date filled in where there is one clear answer (no AI). Tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("auto_fill", () => fillTasks(now));
  // Calls the model on real Inbox items, so tests run it directly with the model stood in.
  if (process.env.NODE_ENV !== "test") await part("noise", () => checkInboxNoise());
  // Part O: new cards checked against approved knowledge. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("contradictions", () => checkNewCards(now));
  // Section 23: hints on Knowledge Inbox cards, and evidence for stale facts. Call the model, so tests run them directly.
  if (process.env.NODE_ENV !== "test") await part("presort", () => presortCards(now));
  if (process.env.NODE_ENV !== "test") await part("stale_evidence", () => checkStaleFacts(now));
  if (process.env.NODE_ENV !== "test") await part("delegation", () => suggestDelegations(now));
  // Section 25: people in real two-way contact who are not in Contacts yet. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("contacts", () => findContacts(now));
  await part("briefs", () => buildUpcomingBriefs(now));
  // Searches the web and calls the model on real companies, so tests run it directly with the model stood in.
  if (process.env.NODE_ENV !== "test") await part("research", () => researchUpcoming(now));
  if (from === "sweep" || digestTimeReached(now)) await part("digest", () => buildDigestIfDue(now));
  await part("roundup", () => buildRoundupIfDue(now));
  // Section 23: the Friday update, drafted on Friday mornings. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("weekly_update", () => draftWeeklyUpdateIfDue(now));
  // Part L: rules from Ollie's edits, once a week. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("rules_from_edits", () => learnRulesIfDue(now));
  if (process.env.NODE_ENV !== "test") await part("writer_grades", () => gradeIfDue(now));
  // Section 24: the reader coach and card coach, weekly (the card coach sooner while the backlog is being cleared).
  if (process.env.NODE_ENV !== "test") await part("lessons", () => learnLessonsIfDue(now));
  // Section 26: pairs of open tasks that are the same work, for the Duplicates page.
  if (process.env.NODE_ENV !== "test") await part("duplicates", () => findDuplicatesIfDue(now));
  // Section 27: tasks that keep slipping, with one thing to try on each.
  if (process.env.NODE_ENV !== "test") await part("stuck", () => coachStuckIfDue(now));
  // Section 28: work packs for Now tasks and tasks due soon. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("work_packs", () => buildWorkPacks(now));
  await part("cleared", async () => ({ digests: await clearOldDigests(now), calendar_events: await clearOldCalendar(now), roundups: await clearOldRoundups(now), ai_runs: await clearOldAiRuns(now), meeting_history: await clearOldHistory(now), ai_inputs: await clearOldInputs(now), noise: await clearOldNoise(now), contact_sightings: await clearOldSightings(now) }));
  return out;
}
