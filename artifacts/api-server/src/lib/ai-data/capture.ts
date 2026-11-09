import { and, eq, sql } from "drizzle-orm";
import { captureLogTable, db, noiseRulesTable, tasksTable, type NoiseRule } from "@workspace/db";
import type { Priority, TaskSource, TaskStatus } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../audit";
import type { Writer } from "./errors";

export interface CaptureInput {
  source: TaskSource;
  sourceRef?: string | null;
  kind?: "task" | "promise";
  title: string;
  status?: TaskStatus;
  priority?: Priority;
  dueDate?: string | null;
  snippet?: string | null;
  sourceQuote?: string | null;
  sourceUrl?: string | null;
  sourceSubject?: string | null;
  sourceChannel?: string | null;
  fromName?: string | null;
  fromAddress?: string | null;
  suggestedAction?: string | null;
  notes?: string | null;
  projectId?: number | null;
  personId?: number | null;
  waitingOnPersonId?: number | null;
  /** Stored on insert, in the same transaction, so a confidential item is hidden from the moment it exists */
  confidential?: boolean | null;
  capturedAt?: Date | null;
}

export type CaptureOutcome = "created" | "duplicate" | "noise";

export interface CaptureResult {
  outcome: CaptureOutcome;
  taskId: number | null;
  noiseRuleId?: number;
}

/** The first enabled rule an item matches. Meeting actions are never auto-noised (PRD 13). */
export function matchNoiseRule(rules: readonly NoiseRule[], item: CaptureInput): NoiseRule | null {
  if (item.source === "meeting") return null;
  const address = item.fromAddress?.trim().toLowerCase() ?? "";
  const domain = address.includes("@") ? address.split("@").pop()! : "";
  const channel = item.sourceChannel?.trim().toLowerCase().replace(/^#/, "") ?? "";
  const titles = [item.title, item.sourceSubject].filter((t): t is string => !!t).map((t) => t.toLowerCase());
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.source && r.source !== item.source) continue;
    const v = r.matchValue;
    if (r.matchType === "from_address_equals" && address && address === v) return r;
    if (r.matchType === "from_domain_equals" && domain && domain === v) return r;
    if (r.matchType === "slack_channel_equals" && item.source === "slack" && channel && channel === v) return r;
    if (r.matchType === "title_contains" && v && titles.some((t) => t.includes(v))) return r;
  }
  return null;
}

export async function enabledNoiseRules(conn: DbOrTx = db): Promise<NoiseRule[]> {
  return conn.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true)).orderBy(noiseRulesTable.id);
}

/**
 * Adds one captured item. Order (build plan 4.3): duplicate check on source + source_ref,
 * then noise rules (when given), then insert. Everything happens in one transaction.
 */
export async function captureTask(input: CaptureInput, who: Writer, opts: { noiseRules?: readonly NoiseRule[]; via: string }): Promise<CaptureResult> {
  return db.transaction(async (tx) => {
    const sourceRef = input.sourceRef?.trim() || null;
    if (sourceRef) {
      const [existingTask] = await tx
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(and(eq(tasksTable.source, input.source), eq(tasksTable.sourceRef, sourceRef)));
      const [logged] = await tx
        .insert(captureLogTable)
        .values({ source: input.source, sourceRef, outcome: "created", taskId: null })
        .onConflictDoNothing()
        .returning({ id: captureLogTable.id });
      if (!logged || existingTask) {
        const [prior] = await tx
          .select({ taskId: captureLogTable.taskId })
          .from(captureLogTable)
          .where(and(eq(captureLogTable.source, input.source), eq(captureLogTable.sourceRef, sourceRef)));
        // A fresh log row with an older task (made before capture_log existed) is pointed at that task.
        if (logged && existingTask) {
          await tx.update(captureLogTable).set({ taskId: existingTask.id, outcome: "duplicate" }).where(eq(captureLogTable.id, logged.id));
        }
        return { outcome: "duplicate", taskId: existingTask?.id ?? prior?.taskId ?? null };
      }
    }

    const rule = opts.noiseRules ? matchNoiseRule(opts.noiseRules, input) : null;
    const now = new Date();
    const status: TaskStatus = rule ? "noise" : (input.status ?? "inbox");
    const [task] = await tx
      .insert(tasksTable)
      .values({
        title: input.title.trim(),
        kind: input.kind ?? "task",
        status,
        priority: input.priority ?? "medium",
        dueDate: input.dueDate ?? null,
        source: input.source,
        sourceRef,
        sourceUrl: input.sourceUrl ?? null,
        sourceQuote: input.sourceQuote ?? null,
        sourceSubject: input.sourceSubject ?? null,
        sourceChannel: input.sourceChannel ?? null,
        fromName: input.fromName ?? null,
        fromAddress: input.fromAddress?.trim().toLowerCase() || null,
        snippet: input.snippet ?? null,
        suggestedAction: input.suggestedAction ?? null,
        notes: input.notes ?? null,
        projectId: input.projectId ?? null,
        personId: input.personId ?? null,
        waitingOnPersonId: input.waitingOnPersonId ?? null,
        waitingSince: status === "waiting" ? now : null,
        triagedAt: status !== "inbox" && status !== "noise" ? now : null,
        noiseRuleId: rule?.id ?? null,
        confidential: input.confidential ?? null,
        capturedAt: input.capturedAt ?? now,
        createdBy: who.actor,
      })
      .returning({ id: tasksTable.id });

    if (sourceRef) {
      await tx
        .update(captureLogTable)
        .set({ taskId: task.id, outcome: rule ? "noise" : "created" })
        .where(and(eq(captureLogTable.source, input.source), eq(captureLogTable.sourceRef, sourceRef)));
    }
    if (rule) {
      await tx
        .update(noiseRulesTable)
        .set({ hitCount: sql`${noiseRulesTable.hitCount} + 1`, lastHitAt: now })
        .where(eq(noiseRulesTable.id, rule.id));
    }
    await writeAudit(tx, {
      actor: who.actor,
      clientId: who.clientId,
      action: "create",
      entityType: "task",
      entityId: task.id,
      payload: { via: opts.via, source: input.source, sourceRef, outcome: rule ? "noise" : "created", noiseRuleId: rule?.id ?? null },
    });
    return rule ? { outcome: "noise", taskId: task.id, noiseRuleId: rule.id } : { outcome: "created", taskId: task.id };
  });
}
