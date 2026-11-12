import { and, desc, eq } from "drizzle-orm";
import { auditEventsTable, db, type AuditEvent } from "@workspace/db";

/** One field change, stored with display values so history reads well later even if names change. */
export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  dropReason: "Why",
  title: "Title",
  kind: "Type",
  status: "Status",
  priority: "Priority",
  dueDate: "Due date",
  notes: "Notes",
  project: "Project",
  person: "For",
  waitingOn: "Waiting on",
  confidential: "Confidential",
  goal: "Goal",
  notGoalWork: "Not goal work",
  repeat: "Repeat",
};

function describeChange(c: FieldChange): string {
  const label = FIELD_LABELS[c.field] ?? c.field;
  if (c.field === "notes") return c.to ? "Notes edited" : "Notes cleared";
  if (c.field === "title") return `Renamed to "${c.to ?? ""}"`;
  if (c.field === "steps") return c.to ? `Checklist updated (${c.to})` : "Checklist cleared";
  if (c.field === "repeat") return c.to ? `Repeats: ${c.to}` : "Stopped repeating";
  if (c.to === null) return `${label} cleared`;
  if (c.from === null) return `${label} set to ${c.to}`;
  return `${label} changed from ${c.from} to ${c.to}`;
}

function describe(event: AuditEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.action) {
    case "create": {
      const via = payload.via as string | undefined;
      if (via === "quick_add") return "Added with quick add";
      if (via === "seed") return "Imported from Notion";
      if (via === "bundle") return "Created by bundling tasks in Ask OllieOS";
      if (via === "repeat") return `Made when the last one was ticked off. Due ${String(payload.dueLabel ?? "next")}`;
      return "Created";
    }
    case "update":
    case "status": {
      const changes = (payload.changes ?? []) as FieldChange[];
      return changes.length ? changes.map(describeChange).join(". ") : "Updated";
    }
    case "triage": {
      const to = payload.to as string | undefined;
      const label = to === "waiting" ? "Waiting on" : to ? to.charAt(0).toUpperCase() + to.slice(1) : "a new status";
      const extra = ((payload.changes ?? []) as FieldChange[]).filter((c) => c.field !== "status").map(describeChange);
      const rule = payload.ruleLabel ? `Rule added to ignore: ${String(payload.ruleLabel)}` : null;
      return [`Triaged to ${label}`, ...extra, rule].filter(Boolean).join(". ");
    }
    case "undo": {
      const changes = (payload.changes ?? []) as FieldChange[];
      const status = changes.find((c) => c.field === "status");
      const base = status ? `Undone. Status back to ${status.to}` : "Undone";
      return payload.removedRule ? `${base}. The rule made with it was removed` : base;
    }
    case "bundle":
      return `Bundled into "${String(payload.title ?? "a new task")}" and marked done`;
    case "restore": {
      const status = ((payload.changes ?? []) as FieldChange[]).find((c) => c.field === "status");
      return `Restored from ${status?.from ?? "Noise"} to ${status?.to ?? "Inbox"}`;
    }
    case "keep":
      return `Kept in the Inbox, though it looked like noise (${String(payload.hint ?? "")})`;
    case "keep_backlog":
      return "Kept in the Backlog during a clear-out";
    case "reply_draft":
      return payload.saved ? "Reply draft saved to Gmail" : "Reply drafted with AI";
    case "snooze":
      return `Snoozed until ${String(payload.untilLabel ?? "tomorrow")}`;
    default:
      return event.action.charAt(0).toUpperCase() + event.action.slice(1).replace(/_/g, " ");
  }
}

export async function getTaskHistory(taskId: number) {
  const events = await db
    .select()
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.entityType, "task"), eq(auditEventsTable.entityId, taskId)))
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .limit(100);

  return events
    .filter((e) => e.action !== "read")
    .map((e) => ({
      id: e.id,
      actor: e.actor,
      action: e.action,
      summary: describe(e),
      createdAt: e.createdAt,
    }));
}
