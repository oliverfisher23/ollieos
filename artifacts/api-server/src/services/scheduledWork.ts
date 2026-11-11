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
import { logger } from "../lib/logger";
import { clearOldCalendar } from "./aiWrites";
import { buildUpcomingBriefs } from "./briefs";
import { buildDigestIfDue, clearOldDigests } from "./digest";
import { onSweepFinished } from "./factReviews";
import { checkInboxNoise } from "./noiseCheck";
import { researchUpcoming } from "./research";
import { checkNewCards } from "./contradictions";
import { buildRoundupIfDue, clearOldRoundups } from "./roundup";

/** OllieOS's own checks start at 07:00, so they wait for 07:40 (when the morning sweep ran) before building the digest. */
export const DIGEST_NOT_BEFORE = { hour: 7, minute: 40 };

export function digestTimeReached(now: Date): boolean {
  const p = londonParts(now);
  return p.hour * 60 + p.minute >= DIGEST_NOT_BEFORE.hour * 60 + DIGEST_NOT_BEFORE.minute;
}

export async function scheduledWork(from: "sweep" | "connectors", now = new Date()): Promise<Record<string, unknown>> {
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
  // Calls the model on real Inbox items, so tests run it directly with the model stood in.
  if (process.env.NODE_ENV !== "test") await part("noise", () => checkInboxNoise());
  // Part O: new cards checked against approved knowledge. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("contradictions", () => checkNewCards(now));
  await part("briefs", () => buildUpcomingBriefs(now));
  // Searches the web and calls the model on real companies, so tests run it directly with the model stood in.
  if (process.env.NODE_ENV !== "test") await part("research", () => researchUpcoming(now));
  if (from === "sweep" || digestTimeReached(now)) await part("digest", () => buildDigestIfDue(now));
  await part("roundup", () => buildRoundupIfDue(now));
  // Part L: rules from Ollie's edits, once a week. Calls the model, so tests run it directly.
  if (process.env.NODE_ENV !== "test") await part("rules_from_edits", () => learnRulesIfDue(now));
  if (process.env.NODE_ENV !== "test") await part("writer_grades", () => gradeIfDue(now));
  await part("cleared", async () => ({ digests: await clearOldDigests(now), calendar_events: await clearOldCalendar(now), roundups: await clearOldRoundups(now), ai_runs: await clearOldAiRuns(now), meeting_history: await clearOldHistory(now), ai_inputs: await clearOldInputs(now), noise: await clearOldNoise(now) }));
  return out;
}
