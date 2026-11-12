/**
 * Scorecards (build plan section 21, Part W): how often Ollie kept or undid what each agent did,
 * this week and last week, worked out from his own decisions. Nothing is asked of him and no AI is
 * used: an Inbox item moved to Noise, a rejected card, a reopened task or a "Not done" on Looks done
 * all count against the agent that made it.
 */
import { and, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db, factReviewsTable, readerLessonsTable, reviewItemsTable, suggestionsTable, taskEvidenceTable, tasksTable } from "@workspace/db";
import type { AgentKey } from "../lib/agents";
import { DOCUMENT_PROPOSER } from "./documents/counts";
import { PRODUCT_USER_ACTOR } from "./productUsers";
import { CONTACT_PROPOSER } from "./contactFinder";
import { PROJECT_FUNCTION_ACTOR } from "./projectFunctions";

const WEEK = 7 * 86_400_000;
/** A rate needs this many decisions in both weeks before a drop counts as a slip. */
export const SLIP_MIN_DECIDED = 5;
/** Percentage points down on last week that count as a slip. */
export const SLIP_POINTS = 15;

export interface Measure {
  key: string;
  agent: AgentKey;
  /** What is being counted, for example "Inbox items kept" */
  label: string;
  kept: number;
  undone: number;
  /** Not decided yet (still in the Inbox, card still waiting) */
  waiting: number;
  /** Kept out of kept plus undone, 0 to 100, or null with nothing decided */
  rate: number | null;
  lastRate: number | null;
  lastDecided: number;
}

interface Counts {
  kept: number;
  undone: number;
  waiting: number;
}

type Spec = { key: string; agent: AgentKey; label: string; count: (start: Date, end: Date) => Promise<Counts> };

const n = (v: unknown) => Number(v ?? 0);
const rateOf = (c: Counts) => (c.kept + c.undone ? Math.round((c.kept / (c.kept + c.undone)) * 100) : null);

/** Inbox items an agent made: kept when Ollie acted on them, undone when he sent them to Noise or dropped them. */
function tasksFrom(source: "email" | "slack" | "meeting"): Spec["count"] {
  return async (start, end) => {
    const [r] = await db
      .select({
        kept: sql<number>`count(*) filter (where ${tasksTable.status} in ('now','backlog','waiting','done','archived'))`,
        undone: sql<number>`count(*) filter (where ${tasksTable.status} in ('noise','dropped'))`,
        waiting: sql<number>`count(*) filter (where ${tasksTable.status} = 'inbox')`,
      })
      .from(tasksTable)
      .where(and(eq(tasksTable.createdBy, "ollieos"), eq(tasksTable.source, source), isNull(tasksTable.noiseRuleId), gte(tasksTable.createdAt, start), lt(tasksTable.createdAt, end)));
    return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
  };
}

/** Knowledge Inbox cards from one proposer: approved or "same as existing" kept, rejected undone. */
function cardsFrom(proposedBy: string, sourceType?: string): Spec["count"] {
  return async (start, end) => {
    const where: SQL[] = [eq(suggestionsTable.proposedBy, proposedBy), gte(suggestionsTable.createdAt, start), lt(suggestionsTable.createdAt, end)];
    if (sourceType) where.push(eq(suggestionsTable.sourceType, sourceType));
    const [r] = await db
      .select({
        kept: sql<number>`count(*) filter (where ${suggestionsTable.status} in ('approved','merged'))`,
        undone: sql<number>`count(*) filter (where ${suggestionsTable.status} = 'rejected')`,
        waiting: sql<number>`count(*) filter (where ${suggestionsTable.status} = 'pending')`,
      })
      .from(suggestionsTable)
      .where(and(...where));
    return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
  };
}

/** Probably noise: right when the item went to Noise, wrong when Ollie kept it. */
const noiseHints: Spec["count"] = async (start, end) => {
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where ${tasksTable.status} = 'noise')`,
      undone: sql<number>`count(*) filter (where ${tasksTable.noiseHintKept})`,
      waiting: sql<number>`count(*) filter (where ${tasksTable.status} = 'inbox' and not ${tasksTable.noiseHintKept})`,
    })
    .from(tasksTable)
    .where(and(sql`${tasksTable.noiseHint} is not null`, gte(tasksTable.noiseCheckedAt, start), lt(tasksTable.noiseCheckedAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

/** Contradiction check: a clash Ollie settled as "both are true" was not a clash. */
const contradictions: Spec["count"] = async (start, end) => {
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where ${factReviewsTable.status} <> 'pending' and coalesce(${factReviewsTable.resolution}->>'action', '') <> 'both_true')`,
      undone: sql<number>`count(*) filter (where ${factReviewsTable.status} <> 'pending' and ${factReviewsTable.resolution}->>'action' = 'both_true')`,
      waiting: sql<number>`count(*) filter (where ${factReviewsTable.status} = 'pending')`,
    })
    .from(factReviewsTable)
    .where(and(eq(factReviewsTable.kind, "contradiction"), gte(factReviewsTable.createdAt, start), lt(factReviewsTable.createdAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

/** Waiting for a reply: dropped means it never needed an answer. */
const noReplies: Spec["count"] = async (start, end) => {
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where ${reviewItemsTable.state} in ('accepted','done','answered'))`,
      undone: sql<number>`count(*) filter (where ${reviewItemsTable.state} = 'dropped')`,
      waiting: sql<number>`count(*) filter (where ${reviewItemsTable.state} = 'pending')`,
    })
    .from(reviewItemsTable)
    .where(and(eq(reviewItemsTable.kind, "no_reply"), gte(reviewItemsTable.createdAt, start), lt(reviewItemsTable.createdAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

/** Part U: tasks closed from their own conversation; undone when Ollie reopened them. */
function autoClosed(source: string): Spec["count"] {
  return async (start, end) => {
    const [r] = await db
      .select({
        kept: sql<number>`count(*) filter (where ${tasksTable.status} not in ('inbox','now','backlog','waiting'))`,
        undone: sql<number>`count(*) filter (where ${tasksTable.status} in ('inbox','now','backlog','waiting'))`,
      })
      .from(taskEvidenceTable)
      .innerJoin(tasksTable, eq(tasksTable.id, taskEvidenceTable.taskId))
      .where(and(eq(taskEvidenceTable.source, source), eq(taskEvidenceTable.applied, true), gte(taskEvidenceTable.createdAt, start), lt(taskEvidenceTable.createdAt, end)));
    return { kept: n(r?.kept), undone: n(r?.undone), waiting: 0 };
  };
}

/** Part U: Looks done markers; kept when the task was marked done, undone on "Not done". */
function looksDone(source: string): Spec["count"] {
  return async (start, end) => {
    const [r] = await db
      .select({
        kept: sql<number>`count(*) filter (where ${taskEvidenceTable.dismissedAt} is null and ${tasksTable.status} = 'done')`,
        undone: sql<number>`count(*) filter (where ${taskEvidenceTable.dismissedAt} is not null)`,
        waiting: sql<number>`count(*) filter (where ${taskEvidenceTable.dismissedAt} is null and ${tasksTable.status} <> 'done')`,
      })
      .from(taskEvidenceTable)
      .innerJoin(tasksTable, eq(tasksTable.id, taskEvidenceTable.taskId))
      .where(
        and(
          eq(taskEvidenceTable.source, source),
          eq(taskEvidenceTable.shows, "done"),
          eq(taskEvidenceTable.applied, false),
          gte(taskEvidenceTable.createdAt, start),
          lt(taskEvidenceTable.createdAt, end),
        ),
      );
    return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
  };
}

/** Section 23, the pre-sorter: a hint was right when Ollie did what it said. */
const presortHints: Spec["count"] = async (start, end) => {
  const v = sql`${suggestionsTable.presort}->>'verdict'`;
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where (${v} = 'keep' and ${suggestionsTable.status} in ('approved','merged')) or (${v} = 'same' and ${suggestionsTable.status} = 'merged') or (${v} in ('reject','duplicate') and ${suggestionsTable.status} = 'rejected'))`,
      undone: sql<number>`count(*) filter (where ${suggestionsTable.status} <> 'pending' and not ((${v} = 'keep' and ${suggestionsTable.status} in ('approved','merged')) or (${v} = 'same' and ${suggestionsTable.status} = 'merged') or (${v} in ('reject','duplicate') and ${suggestionsTable.status} = 'rejected')))`,
      waiting: sql<number>`count(*) filter (where ${suggestionsTable.status} = 'pending')`,
    })
    .from(suggestionsTable)
    .where(and(sql`${v} is not null`, gte(suggestionsTable.presortedAt, start), lt(suggestionsTable.presortedAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

/** Section 23, the stale fact checker: "still true" was right when Ollie confirmed it; "changed" when he edited it or marked it out of date. */
const staleFindings: Spec["count"] = async (start, end) => {
  const v = sql`${factReviewsTable.evidence}->>'verdict'`;
  const a = sql`coalesce(${factReviewsTable.resolution}->>'action', '')`;
  const right = sql`((${v} = 'confirmed' and ${a} = 'still_true') or (${v} = 'changed' and ${a} in ('edit','no_longer_true')))`;
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where ${factReviewsTable.status} <> 'pending' and ${right})`,
      undone: sql<number>`count(*) filter (where ${factReviewsTable.status} <> 'pending' and not ${right})`,
      waiting: sql<number>`count(*) filter (where ${factReviewsTable.status} = 'pending')`,
    })
    .from(factReviewsTable)
    .where(and(eq(factReviewsTable.kind, "stale"), sql`${v} in ('confirmed','changed')`, gte(factReviewsTable.evidenceCheckedAt, start), lt(factReviewsTable.evidenceCheckedAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

/** Section 23, the delegation suggester: used when the task went to that colleague, undone on "Not this one". */
const delegations: Spec["count"] = async (start, end) => {
  const used = sql`${tasksTable.waitingOnPersonId} = (${tasksTable.delegateHint}->>'personId')::int`;
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where ${used})`,
      undone: sql<number>`count(*) filter (where ${tasksTable.delegateDismissedAt} is not null and not coalesce(${used}, false))`,
      waiting: sql<number>`count(*) filter (where ${tasksTable.delegateDismissedAt} is null and not coalesce(${used}, false) and ${tasksTable.status} in ('now','backlog'))`,
    })
    .from(tasksTable)
    .where(and(sql`${tasksTable.delegateHint} is not null and jsonb_typeof(${tasksTable.delegateHint}) = 'object'`, gte(tasksTable.delegateCheckedAt, start), lt(tasksTable.delegateCheckedAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

/** Section 24: a coach's lessons; kept when Ollie turned one on and left it on, undone when he said no or turned it off. */
function lessonsBy(learnedBy: "reader_coach" | "card_coach"): Spec["count"] {
  return async (start, end) => {
    const [r] = await db
      .select({
        kept: sql<number>`count(*) filter (where ${readerLessonsTable.status} = 'on')`,
        undone: sql<number>`count(*) filter (where ${readerLessonsTable.status} in ('rejected','off'))`,
        waiting: sql<number>`count(*) filter (where ${readerLessonsTable.status} = 'proposed')`,
      })
      .from(readerLessonsTable)
      .where(and(eq(readerLessonsTable.learnedBy, learnedBy), gte(readerLessonsTable.createdAt, start), lt(readerLessonsTable.createdAt, end)));
    return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
  };
}

/** Section 26: a way out was right when Ollie took it, or the task got done; wrong on Not now. */
const stuckWays: Spec["count"] = async (start, end) => {
  const coached = sql`${tasksTable.stuckHint} is not null and jsonb_typeof(${tasksTable.stuckHint}) = 'object' and ${tasksTable.stuckHint}->>'wayOut' is not null`;
  // Taken, or the task moved on (done, handed on to wait on someone, dropped or archived).
  const taken = sql`(${tasksTable.stuckHint}->>'appliedAt' is not null or ${tasksTable.status} not in ('now','backlog','inbox'))`;
  const [r] = await db
    .select({
      kept: sql<number>`count(*) filter (where ${taken})`,
      undone: sql<number>`count(*) filter (where not ${taken} and ${tasksTable.stuckDismissedAt} is not null)`,
      waiting: sql<number>`count(*) filter (where not ${taken} and ${tasksTable.stuckDismissedAt} is null and ${tasksTable.status} in ('now','backlog'))`,
    })
    .from(tasksTable)
    .where(and(coached, gte(tasksTable.stuckCheckedAt, start), lt(tasksTable.stuckCheckedAt, end)));
  return { kept: n(r?.kept), undone: n(r?.undone), waiting: n(r?.waiting) };
};

const SPECS: Spec[] = [
  { key: "gmail_tasks", agent: "gmail_sorter", label: "Inbox items kept", count: tasksFrom("email") },
  { key: "gmail_cards", agent: "gmail_sorter", label: "Knowledge cards approved", count: cardsFrom("Gmail check") },
  { key: "gmail_closed", agent: "gmail_sorter", label: "Tasks it closed that stayed closed", count: autoClosed("email") },
  { key: "gmail_looks", agent: "gmail_sorter", label: "Looks done confirmed", count: looksDone("email") },
  { key: "slack_tasks", agent: "slack_sorter", label: "Inbox items kept", count: tasksFrom("slack") },
  { key: "slack_cards", agent: "slack_sorter", label: "Knowledge cards approved", count: cardsFrom("Slack check") },
  { key: "slack_closed", agent: "slack_sorter", label: "Tasks it closed that stayed closed", count: autoClosed("slack") },
  { key: "slack_looks", agent: "slack_sorter", label: "Looks done confirmed", count: looksDone("slack") },
  { key: "granola_tasks", agent: "granola_reader", label: "Inbox items kept", count: tasksFrom("meeting") },
  { key: "granola_cards", agent: "granola_reader", label: "Decisions approved", count: cardsFrom("OllieOS", "meeting") },
  { key: "granola_looks", agent: "granola_reader", label: "Looks done confirmed", count: looksDone("meeting") },
  { key: "look_back_cards", agent: "granola_look_back", label: "Decisions approved", count: cardsFrom("Granola look back") },
  { key: "noise", agent: "noise_judge", label: "Hints that were noise", count: noiseHints },
  { key: "no_reply", agent: "no_reply_judge", label: "Emails that did need an answer", count: noReplies },
  { key: "drive", agent: "drive_matcher", label: "Library suggestions approved", count: cardsFrom("OllieOS", "document") },
  { key: "contradictions", agent: "contradiction_judge", label: "Clashes that were real", count: contradictions },
  { key: "documents", agent: "document_reader", label: "Knowledge cards approved", count: cardsFrom(DOCUMENT_PROPOSER) },
  { key: "functions", agent: "function_suggester", label: "Suggestions approved", count: cardsFrom(PROJECT_FUNCTION_ACTOR) },
  { key: "product_users", agent: "product_user_suggester", label: "Suggestions approved", count: cardsFrom(PRODUCT_USER_ACTOR) },
  { key: "presort", agent: "presorter", label: "Hints you agreed with", count: presortHints },
  { key: "stale_evidence", agent: "stale_checker", label: "Findings you agreed with", count: staleFindings },
  { key: "delegation", agent: "delegation", label: "Suggestions you sent", count: delegations },
  { key: "stuck", agent: "stuck_coach", label: "Ways out you took", count: stuckWays },
  { key: "contacts", agent: "contact_finder", label: "People and organisations kept", count: cardsFrom(CONTACT_PROPOSER) },
  { key: "reader_lessons", agent: "reader_coach", label: "Lessons you turned on", count: lessonsBy("reader_coach") },
  { key: "card_lessons", agent: "card_coach", label: "Lessons you turned on", count: lessonsBy("card_coach") },
];

/** Every measure for the week to `now`, with last week's rate beside it. */
export async function scorecards(now = new Date()): Promise<Measure[]> {
  const thisStart = new Date(now.getTime() - WEEK);
  const lastStart = new Date(now.getTime() - 2 * WEEK);
  return Promise.all(
    SPECS.map(async (s) => {
      const [cur, prev] = await Promise.all([s.count(thisStart, now), s.count(lastStart, thisStart)]);
      return { key: s.key, agent: s.agent, label: s.label, ...cur, rate: rateOf(cur), lastRate: rateOf(prev), lastDecided: prev.kept + prev.undone };
    }),
  );
}

/** Measures that dropped noticeably on last week, with enough decisions both weeks to mean something. */
export function slipped(measures: Measure[]): Measure[] {
  return measures.filter(
    (m) => m.rate != null && m.lastRate != null && m.kept + m.undone >= SLIP_MIN_DECIDED && m.lastDecided >= SLIP_MIN_DECIDED && m.lastRate - m.rate >= SLIP_POINTS,
  );
}

/** For tests: the agents that have a scorecard. */
export const SCORED_AGENTS = [...new Set(SPECS.map((s) => s.agent))];
