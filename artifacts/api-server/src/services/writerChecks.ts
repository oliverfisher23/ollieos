/**
 * Checks for the writers (build plan section 21, Part Y). Three kinds of score, one of each per
 * piece of writing:
 * - code checks on every piece as it is written (no em dashes, within its word limit, only citing
 *   what it was given, none of the phrases a rule says never to use), no AI;
 * - a weekly Sonnet grade out of 5 on a small sample from each writer;
 * - Ollie's thumbs up or down on Ask answers, meeting briefs and the digest.
 * The Agents page shows them per writer for the last 7 days.
 */
import { and, desc, eq, gte, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { appSettingsTable, askThreadsTable, db, digestsTable, meetingBriefsTable, replyDraftsTable, rulesTable, tasksTable, writerScoresTable } from "@workspace/db";
import type { AgentKey } from "../lib/agents";
import { logger } from "../lib/logger";
import { gradeWriting } from "./ask/model";
import { NotFoundError, ValidationError } from "./tasks";

export type WritingIssueKind = "em_dash" | "too_long" | "unknown_citation" | "rule_phrase";

export interface WritingIssue {
  kind: WritingIssueKind;
  detail: string;
}

export interface CheckOptions {
  /** The most words allowed */
  maxWords?: number;
  /** Refs the writer was given; citations outside these are flagged */
  given?: readonly string[] | null;
  cited?: readonly string[];
  /** Phrases rules say never to use */
  phrases?: { phrase: string; rule: string }[];
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** The code checks. Pure, so writers and tests can call it directly. */
export function checkWriting(text: string, opts: CheckOptions = {}): WritingIssue[] {
  const out: WritingIssue[] = [];
  const dashes = (text.match(/—/g) ?? []).length;
  if (dashes) out.push({ kind: "em_dash", detail: `${dashes} em dash${dashes === 1 ? "" : "es"}` });
  if (opts.maxWords) {
    const n = words(text);
    if (n > opts.maxWords) out.push({ kind: "too_long", detail: `${n} words, over the limit of ${opts.maxWords}` });
  }
  if (opts.given && opts.cited) {
    const given = new Set(opts.given);
    const unknown = [...new Set(opts.cited.filter((r) => !given.has(r)))];
    if (unknown.length) out.push({ kind: "unknown_citation", detail: `Cites ${unknown.join(", ")}, which it was not given` });
  }
  const lower = text.toLowerCase();
  for (const p of opts.phrases ?? []) {
    if (lower.includes(p.phrase.toLowerCase())) out.push({ kind: "rule_phrase", detail: `Uses "${p.phrase}" (rule: ${p.rule})` });
  }
  return out;
}

/**
 * Phrases enabled rules say never to use: a quoted phrase in a rule that says never, do not, don't
 * or avoid. Rules hidden from AI are still checked: this runs in code and sends nothing anywhere.
 */
export async function bannedPhrases(): Promise<{ phrase: string; rule: string }[]> {
  const rows = await db.select({ title: rulesTable.title, rule: rulesTable.rule }).from(rulesTable).where(eq(rulesTable.enabled, true));
  const out: { phrase: string; rule: string }[] = [];
  for (const r of rows) {
    if (!/\b(never|do not|don't|avoid|no)\b/i.test(r.rule)) continue;
    for (const m of r.rule.matchAll(/["“']([^"”']{3,60})["”']/g)) out.push({ phrase: m[1].trim(), rule: r.title });
  }
  return out;
}

async function upsertScore(agent: AgentKey, subject: string, kind: "check" | "grade" | "thumb", score: number, detail: unknown) {
  await db
    .insert(writerScoresTable)
    .values({ agent, subject, kind, score, detail: detail ?? null })
    .onConflictDoUpdate({ target: [writerScoresTable.subject, writerScoresTable.kind], set: { agent, score, detail: detail ?? null, at: new Date() } });
}

/** Runs the code checks on a piece of writing and records the result. Never fails the writer. */
export async function recordCheck(agent: AgentKey, subject: string, text: string, opts: CheckOptions & { rulePhrases?: boolean } = {}): Promise<WritingIssue[]> {
  try {
    const phrases = opts.rulePhrases ? await bannedPhrases() : opts.phrases;
    const issues = checkWriting(text, { ...opts, phrases });
    await upsertScore(agent, subject, "check", issues.length ? 0 : 1, { issues });
    return issues;
  } catch (err) {
    logger.warn({ err, agent, subject }, "Could not record a writing check");
    return [];
  }
}

/* ---------- Thumbs ---------- */

const THUMB_SUBJECTS: Record<string, AgentKey> = { ask: "ask_answer", brief: "brief_writer", digest: "digest_summary" };

/** Ollie's thumbs up or down on an Ask answer, a meeting brief or a digest. A second press replaces the first; null clears it. */
export async function setThumb(subject: string, thumb: "up" | "down" | null, note?: string | null): Promise<{ subject: string; thumb: "up" | "down" | null }> {
  const m = /^(ask|brief|digest):(\d+)$/.exec(subject);
  if (!m) throw new ValidationError("Thumbs are for Ask answers, meeting briefs and the digest");
  const id = Number(m[2]);
  const table = m[1] === "ask" ? askThreadsTable : m[1] === "brief" ? meetingBriefsTable : digestsTable;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id));
  if (!row) throw new NotFoundError("That no longer exists");
  if (thumb === null) {
    await db.delete(writerScoresTable).where(and(eq(writerScoresTable.subject, subject), eq(writerScoresTable.kind, "thumb")));
    return { subject, thumb: null };
  }
  await upsertScore(THUMB_SUBJECTS[m[1]], subject, "thumb", thumb === "up" ? 1 : -1, note?.trim() ? { note: note.trim().slice(0, 500) } : null);
  return { subject, thumb };
}

export async function thumbsFor(subjects: string[]): Promise<Map<string, "up" | "down">> {
  if (!subjects.length) return new Map();
  const rows = await db
    .select({ subject: writerScoresTable.subject, score: writerScoresTable.score })
    .from(writerScoresTable)
    .where(and(eq(writerScoresTable.kind, "thumb"), inArray(writerScoresTable.subject, subjects)));
  return new Map(rows.map((r) => [r.subject, r.score > 0 ? "up" : "down"]));
}

/* ---------- Weekly grade ---------- */

const GRADE_KEY = "writer_grade_last";
const WEEK = 7 * 86_400_000;
/** Pieces graded per writer per week. */
export const GRADE_SAMPLE = 3;

interface Piece {
  agent: AgentKey;
  subject: string;
  /** What was asked of the writer, in a line */
  task: string;
  text: string;
}

/** Recent pieces from each writer with nothing hidden from AI in them, not graded yet. */
async function samplePieces(now: Date): Promise<Piece[]> {
  const since = new Date(now.getTime() - WEEK);
  const graded = db.select({ s: writerScoresTable.subject }).from(writerScoresTable).where(eq(writerScoresTable.kind, "grade"));
  const out: Piece[] = [];

  const asks = await db
    .select()
    .from(askThreadsTable)
    .where(and(gte(askThreadsTable.createdAt, since), eq(askThreadsTable.usedConfidential, false), notInArray(sql`'ask:' || ${askThreadsTable.id}`, graded)))
    .orderBy(sql`random()`)
    .limit(GRADE_SAMPLE);
  for (const a of asks) {
    const ans = a.answer as { summary?: string; items?: { text: string }[] };
    out.push({ agent: "ask_answer", subject: `ask:${a.id}`, task: `Answer Ollie's question: "${a.question}"`, text: [ans.summary ?? "", ...(ans.items ?? []).map((i) => `- ${i.text}`)].join("\n") });
  }

  const briefs = await db
    .select()
    .from(meetingBriefsTable)
    .where(and(gte(meetingBriefsTable.generatedAt, since), eq(meetingBriefsTable.usedConfidential, false), eq(meetingBriefsTable.failed, false), isNotNull(meetingBriefsTable.why), notInArray(sql`'brief:' || ${meetingBriefsTable.id}`, graded)))
    .orderBy(sql`random()`)
    .limit(GRADE_SAMPLE);
  for (const b of briefs) {
    const lines = (label: string, xs: { text: string }[] | null) => (xs?.length ? [`${label}:`, ...xs.map((x) => `- ${x.text}`)] : []);
    out.push({ agent: "brief_writer", subject: `brief:${b.id}`, task: "Prepare Ollie for a meeting: why it matters, an agenda and questions to ask", text: [...lines("Why it matters", b.why), ...lines("Agenda", b.agenda), ...lines("Questions", b.questions)].join("\n") });
  }

  const digests = await db
    .select()
    .from(digestsTable)
    .where(and(gte(digestsTable.createdAt, since), isNotNull(digestsTable.summary), notInArray(sql`'digest:' || ${digestsTable.id}`, graded)))
    .orderBy(sql`random()`)
    .limit(GRADE_SAMPLE);
  for (const d of digests) out.push({ agent: "digest_summary", subject: `digest:${d.id}`, task: "Sum up Ollie's morning digest in one sentence", text: d.summary! });

  const drafts = await db
    .select({ id: replyDraftsTable.id, body: replyDraftsTable.writtenBody, title: tasksTable.title, source: tasksTable.sourceRef })
    .from(replyDraftsTable)
    .innerJoin(tasksTable, eq(tasksTable.id, replyDraftsTable.taskId))
    .where(and(gte(replyDraftsTable.updatedAt, since), eq(replyDraftsTable.state, "ready"), isNotNull(replyDraftsTable.writtenBody), ne(replyDraftsTable.writtenBody, ""), sql`${tasksTable.confidential} is not true`, notInArray(sql`'draft:' || ${replyDraftsTable.id}`, graded)))
    .orderBy(sql`random()`)
    .limit(GRADE_SAMPLE * 2);
  let replies = 0;
  let followUps = 0;
  for (const d of drafts) {
    const followUp = d.source?.endsWith("#follow-up") ?? false;
    if (followUp ? followUps >= GRADE_SAMPLE : replies >= GRADE_SAMPLE) continue;
    if (followUp) followUps++;
    else replies++;
    out.push({ agent: followUp ? "meeting_follow_up" : "email_reply_draft", subject: `draft:${d.id}`, task: followUp ? `Write the follow-up email after a meeting (${d.title})` : `Write Ollie's email reply (${d.title})`, text: d.body! });
  }
  return out;
}

/** Once a week, after the scheduled checks: grades a small sample from each writer. */
export async function gradeIfDue(now = new Date()): Promise<{ ran: boolean; graded: number }> {
  const [last] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, GRADE_KEY));
  const at = (last?.value as { at?: string } | undefined)?.at;
  if (at && now.getTime() - Date.parse(at) < WEEK) return { ran: false, graded: 0 };
  const graded = await gradeSample(now);
  const value = { at: now.toISOString(), graded };
  await db.insert(appSettingsTable).values({ key: GRADE_KEY, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  return { ran: true, graded };
}

export async function gradeSample(now = new Date()): Promise<number> {
  const pieces = await samplePieces(now);
  let n = 0;
  for (const p of pieces) {
    try {
      const g = await gradeWriting(p.task, p.text);
      const score = Math.min(5, Math.max(1, Math.round(g.score)));
      await upsertScore(p.agent, p.subject, "grade", score, { reason: g.reason.slice(0, 300) });
      n++;
    } catch (err) {
      logger.warn({ err, subject: p.subject }, "Could not grade a piece of writing");
    }
  }
  return n;
}

/* ---------- For the Agents page ---------- */

export interface WritingView {
  checks: { passed: number; total: number; lastIssues: string[] };
  grade: { average: number | null; count: number; lowest: { subject: string; score: number; reason: string } | null };
  thumbs: { up: number; down: number };
}

export async function writingViews(now = new Date()): Promise<Map<string, WritingView>> {
  const since = new Date(now.getTime() - WEEK);
  const rows = await db.select().from(writerScoresTable).where(gte(writerScoresTable.at, since)).orderBy(desc(writerScoresTable.at));
  const out = new Map<string, WritingView>();
  const get = (agent: string) => {
    let v = out.get(agent);
    if (!v) out.set(agent, (v = { checks: { passed: 0, total: 0, lastIssues: [] }, grade: { average: null, count: 0, lowest: null }, thumbs: { up: 0, down: 0 } }));
    return v;
  };
  const sums = new Map<string, number>();
  for (const r of rows) {
    const v = get(r.agent);
    if (r.kind === "check") {
      v.checks.total++;
      if (r.score > 0) v.checks.passed++;
      else if (v.checks.lastIssues.length < 3) v.checks.lastIssues.push(...((r.detail as { issues?: WritingIssue[] } | null)?.issues ?? []).map((i) => i.detail).slice(0, 3 - v.checks.lastIssues.length));
    } else if (r.kind === "grade") {
      v.grade.count++;
      sums.set(r.agent, (sums.get(r.agent) ?? 0) + r.score);
      if (!v.grade.lowest || r.score < v.grade.lowest.score) v.grade.lowest = { subject: r.subject, score: r.score, reason: (r.detail as { reason?: string } | null)?.reason ?? "" };
    } else if (r.score > 0) v.thumbs.up++;
    else v.thumbs.down++;
  }
  for (const [agent, v] of out) if (v.grade.count) v.grade.average = Math.round(((sums.get(agent) ?? 0) / v.grade.count) * 10) / 10;
  return out;
}
