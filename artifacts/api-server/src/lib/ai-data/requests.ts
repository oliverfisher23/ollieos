import { and, eq, isNull, sql } from "drizzle-orm";
import { accessRequestsTable, db, decisionsTable, notesTable, organisationsTable, peopleTable, projectsTable, tasksTable } from "@workspace/db";
import { parseRef } from "@workspace/shared";
import { writeAudit } from "../audit";
import type { AiScope } from "./scope";
import { visibleRefs } from "./scope";
import type { GrantType } from "./visibility";

export const REQUEST_REPLY = { status: "pending" as const, message: "Sent to Ollie for approval." };

/**
 * Finds the item an AI asked for, by ref, slug or exact name. Ollie-side only: the result never
 * goes back to the AI, which gets the same reply whether or not anything matched (question 13).
 */
export async function matchRequestedItem(item: string): Promise<{ type: GrantType; id: number } | null> {
  const text = item.trim();
  if (!text) return null;
  const ref = parseRef(text);
  if (ref) {
    const table = {
      project: projectsTable,
      person: peopleTable,
      organisation: organisationsTable,
      task: tasksTable,
      decision: decisionsTable,
      note: notesTable,
    }[ref.type as GrantType];
    if (!table) return null;
    const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, ref.id));
    return row ? { type: ref.type as GrantType, id: row.id } : null;
  }
  const lower = text.toLowerCase();
  for (const [type, table] of [
    ["project", projectsTable],
    ["person", peopleTable],
    ["organisation", organisationsTable],
  ] as const) {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(sql`lower(${table.slug}) = ${lower} or lower(${table.name}) = ${lower}`)
      .limit(2);
    // Two items with the same name: leave it for Ollie to pick rather than guess.
    if (rows.length === 1) return { type, id: rows[0].id };
    if (rows.length > 1) return null;
  }
  return null;
}

/**
 * request_access (PRD 10, rule 3). Stores the request for Ollie's approval queue and audits it.
 * The reply is identical in every case, so it never confirms that a hidden item exists.
 */
export async function requestAccess(scope: AiScope, item: string, reason: string | null): Promise<typeof REQUEST_REPLY> {
  const requestedName = item.trim().slice(0, 200);
  const why = reason?.trim().slice(0, 500) || null;
  if (!requestedName) return REQUEST_REPLY;
  const match = await matchRequestedItem(requestedName);

  // Already readable by this client: nothing to approve.
  if (match && (await visibleRefs(scope, [`${match.type}:${match.id}`])).size) return REQUEST_REPLY;

  await db.transaction(async (tx) => {
    const sameItem = match
      ? and(eq(accessRequestsTable.entityType, match.type), eq(accessRequestsTable.entityId, match.id))
      : and(isNull(accessRequestsTable.entityId), sql`lower(${accessRequestsTable.requestedName}) = ${requestedName.toLowerCase()}`);
    const [existing] = await tx
      .select({ id: accessRequestsTable.id })
      .from(accessRequestsTable)
      .where(and(eq(accessRequestsTable.clientId, scope.clientId), eq(accessRequestsTable.status, "pending"), sameItem));
    let id: number;
    if (existing) {
      // Asking again refreshes the reason and time instead of adding a second banner.
      await tx.update(accessRequestsTable).set({ reason: why, createdAt: new Date() }).where(eq(accessRequestsTable.id, existing.id));
      id = existing.id;
    } else {
      const [created] = await tx
        .insert(accessRequestsTable)
        .values({ clientId: scope.clientId, entityType: match?.type ?? null, entityId: match?.id ?? null, requestedName, reason: why })
        .returning({ id: accessRequestsTable.id });
      id = created.id;
    }
    await writeAudit(tx, {
      actor: scope.actor,
      clientId: scope.clientId,
      action: "request_access",
      entityType: match?.type ?? null,
      entityId: match?.id ?? null,
      payload: { requestId: id, requested: requestedName, reason: why },
    });
  });
  return REQUEST_REPLY;
}
