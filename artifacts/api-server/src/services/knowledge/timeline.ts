import { and, desc, eq, inArray, or } from "drizzle-orm";
import { activityTable, db, linksTable, tasksTable } from "@workspace/db";
import { SOURCE_LABELS } from "@workspace/shared";
import type { NoteView } from "./items";

export interface TimelineItem {
  key: string;
  /** email, meeting, slack, note, task, quarterly or manual */
  kind: string;
  label: string;
  text: string;
  at: Date;
  /** Ref of the item to open, e.g. task:42 or note:7 */
  ref: string | null;
  sourceUrl: string | null;
}

const KIND_LABELS: Record<string, string> = {
  email: "Email",
  meeting: "Meeting",
  slack: "Slack",
  note: "Note",
  task: "Task",
};

const LIMIT = 40;

/**
 * Touchpoints for a project, person or organisation: activity rows (from the sweep, milestone 5),
 * captures and completions of linked tasks, and notes. Newest first.
 */
export async function timelineFor(
  type: "project" | "person" | "organisation",
  id: number,
  notes: NoteView[],
  extraPersonIds: number[] = [],
): Promise<TimelineItem[]> {
  const linkedActivity = await db
    .select({ id: linksTable.fromId })
    .from(linksTable)
    .where(and(eq(linksTable.fromType, "activity"), eq(linksTable.toType, type), eq(linksTable.toId, id)));
  const activityIds = linkedActivity.map((l) => l.id);
  const activity = await db
    .select()
    .from(activityTable)
    .where(
      or(
        and(eq(activityTable.entityType, type), eq(activityTable.entityId, id)),
        activityIds.length ? inArray(activityTable.id, activityIds) : undefined,
      ),
    )
    .orderBy(desc(activityTable.occurredAt))
    .limit(LIMIT);

  const taskWhere =
    type === "project"
      ? eq(tasksTable.projectId, id)
      : type === "person"
        ? or(eq(tasksTable.personId, id), eq(tasksTable.waitingOnPersonId, id))
        : extraPersonIds.length
          ? inArray(tasksTable.personId, extraPersonIds)
          : undefined;
  const tasks = taskWhere
    ? await db.select().from(tasksTable).where(taskWhere).orderBy(desc(tasksTable.updatedAt)).limit(LIMIT)
    : [];

  const items: TimelineItem[] = [];
  for (const a of activity) {
    items.push({
      key: `activity:${a.id}`,
      kind: a.kind,
      label: KIND_LABELS[a.kind] ?? a.kind,
      text: a.summary,
      at: a.occurredAt,
      ref: null,
      sourceUrl: a.sourceUrl,
    });
  }
  for (const t of tasks) {
    if (t.status === "noise") continue;
    if (t.source !== "manual") {
      items.push({
        key: `capture:${t.id}`,
        kind: t.source,
        label: SOURCE_LABELS[t.source],
        text: t.sourceSubject ? `${t.sourceSubject}. ${t.title}` : t.title,
        at: t.capturedAt ?? t.createdAt,
        ref: `task:${t.id}`,
        sourceUrl: t.sourceUrl,
      });
    }
    if (t.status === "done" && t.completedAt) {
      items.push({ key: `done:${t.id}`, kind: "task", label: "Done", text: t.title, at: t.completedAt, ref: `task:${t.id}`, sourceUrl: null });
    }
  }
  for (const n of notes) {
    items.push({
      key: `note:${n.id}`,
      kind: "note",
      label: "Note",
      text: n.title ? `${n.title}. ${n.body}` : n.body,
      at: n.createdAt,
      ref: `note:${n.id}`,
      sourceUrl: null,
    });
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, LIMIT);
}
