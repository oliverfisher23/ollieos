import { and, desc, eq } from "drizzle-orm";
import { auditEventsTable, db, type AuditEvent } from "@workspace/db";

/** One field change, stored with display values so history reads well later even if names change. */
export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

const FIELD_LABELS: Record<string, string> = {
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
};

function describeChange(c: FieldChange): string {
  const label = FIELD_LABELS[c.field] ?? c.field;
  if (c.field === "notes") return c.to ? "Notes edited" : "Notes cleared";
  if (c.field === "title") return `Renamed to "${c.to ?? ""}"`;
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
      return "Created";
    }
    case "update":
    case "status": {
      const changes = (payload.changes ?? []) as FieldChange[];
      return changes.length ? changes.map(describeChange).join(". ") : "Updated";
    }
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
