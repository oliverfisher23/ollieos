/**
 * "Probably noise" in the Inbox. After each check, Claude Haiku looks at new email and Slack items
 * in the Inbox and flags the ones Ollie would probably move to Noise, with a short reason. It learns
 * from his noise rules, what he moved to Noise by hand, and what he kept. Nothing moves on its own:
 * Ollie decides from the Inbox.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, noiseRulesTable, tasksTable } from "@workspace/db";
import { taskVisible } from "../lib/ai-data/visibility";
import { writeAudit } from "../lib/audit";
import { noiseRuleLabel } from "./noiseRules";
import { judgeNoise, type NoiseCandidate, type NoiseExample } from "./noiseJudge";
import { loadTask, ConflictError } from "./tasks";
import { toTaskView, type TaskView } from "./taskView";

/** Items looked at in one check; the rest wait for the next. */
const PER_CHECK = 40;
const TEXT_CHARS = 600;

function example(t: { title: string; fromName: string | null; fromAddress: string | null }): NoiseExample {
  return { title: t.title, from: [t.fromName, t.fromAddress].filter(Boolean).join(" ") };
}

export async function checkInboxNoise(): Promise<{ checked: number; flagged: number }> {
  const todo = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.status, "inbox"), inArray(tasksTable.source, ["email", "slack"]), isNull(tasksTable.noiseCheckedAt)))
    .orderBy(desc(tasksTable.capturedAt))
    .limit(PER_CHECK);
  if (!todo.length) return { checked: 0, flagged: 0 };

  // Items hidden from AI are marked as looked at without being read.
  const visible = new Set(
    (
      await db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(and(inArray(tasksTable.id, todo.map((t) => t.id)), sql.raw(taskVisible("tasks"))))
    ).map((r) => r.id),
  );
  const candidates: NoiseCandidate[] = todo
    .filter((t) => visible.has(t.id))
    .map((t) => ({
      id: t.id,
      source: t.source,
      title: t.title,
      from: [t.fromName, t.fromAddress].filter(Boolean).join(" "),
      knownPerson: t.personId != null,
      subject: t.sourceSubject,
      where: t.sourceChannel,
      text: [t.snippet, t.sourceQuote].filter(Boolean).join("\n").slice(0, TEXT_CHARS),
    }));

  const verdicts = new Map<number, string>();
  if (candidates.length) {
    const [rules, byHand, kept] = await Promise.all([
      db.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true)).orderBy(desc(noiseRulesTable.lastHitAt)).limit(30),
      db
        .select({ title: tasksTable.title, fromName: tasksTable.fromName, fromAddress: tasksTable.fromAddress })
        .from(tasksTable)
        .where(and(eq(tasksTable.status, "noise"), isNull(tasksTable.noiseRuleId), sql.raw(taskVisible("tasks"))))
        .orderBy(desc(tasksTable.updatedAt))
        .limit(25),
      db
        .select({ title: tasksTable.title, fromName: tasksTable.fromName, fromAddress: tasksTable.fromAddress })
        .from(tasksTable)
        .where(and(eq(tasksTable.noiseHintKept, true), sql.raw(taskVisible("tasks"))))
        .orderBy(desc(tasksTable.updatedAt))
        .limit(15),
    ]);
    const results = await judgeNoise(candidates, {
      rules: rules.map((r) => noiseRuleLabel(r.matchType, r.matchValue)),
      noise: byHand.map(example),
      kept: kept.map(example),
    });
    const ids = new Set(candidates.map((c) => c.id));
    for (const r of results) if (r.noise && ids.has(r.id)) verdicts.set(r.id, (r.reason || "Looks like noise").slice(0, 120));
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    for (const t of todo) {
      await tx
        .update(tasksTable)
        .set({ noiseHint: verdicts.get(t.id) ?? null, noiseCheckedAt: now, updatedAt: t.updatedAt })
        .where(eq(tasksTable.id, t.id));
    }
  });
  return { checked: todo.length, flagged: verdicts.size };
}

/** Ollie keeps an item the check flagged. It stays in the Inbox, and teaches the next check. */
export async function keepTask(id: number, actor: string): Promise<TaskView> {
  const current = await loadTask(id);
  if (current.status !== "inbox") throw new ConflictError("Only Inbox items can be kept");
  const [row] = await db.update(tasksTable).set({ noiseHintKept: true }).where(eq(tasksTable.id, id)).returning();
  if (current.noiseHint && !current.noiseHintKept) {
    await writeAudit(db, { actor, action: "keep", entityType: "task", entityId: id, payload: { hint: current.noiseHint } });
  }
  return toTaskView(row);
}
