import { and, eq } from "drizzle-orm";
import { db, factReviewsTable } from "@workspace/db";
import { toRef } from "@workspace/shared";

/**
 * Refs (fact:1, decision:2, rule:3) of approved items that a newer card contradicts and Ollie has
 * not decided on yet (Part O). They show "May be out of date", and AI is told they are in question.
 */
export async function inQuestionRefs(): Promise<Set<string>> {
  const rows = await db
    .select({ items: factReviewsTable.contradicts })
    .from(factReviewsTable)
    .where(and(eq(factReviewsTable.status, "pending"), eq(factReviewsTable.kind, "contradiction")));
  return new Set(rows.flatMap((r) => (r.items ?? []).map((i) => toRef(i.type, i.id))));
}
