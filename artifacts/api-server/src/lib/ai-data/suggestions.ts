/**
 * list_my_suggestions: what this client has proposed that is still waiting, or that Ollie
 * rejected in the last 30 days, so it does not propose the same thing again. Suggestions on
 * hidden items and confidential decisions are left out (feature 01, rule 6).
 */
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { db, suggestionsTable } from "@workspace/db";
import { toRef } from "@workspace/shared";
import type { AiScope } from "./scope";
import { suggestionVisible } from "./visibility";

export interface SuggestionOut {
  suggestion_id: number;
  kind: string;
  status: "pending" | "rejected";
  on: string | null;
  text: string;
  created_at: string;
  decided_at: string | null;
}

export async function listMySuggestions(scope: AiScope, status: "pending" | "rejected" | "all" = "all", limit = 50): Promise<{ suggestions: SuggestionOut[] }> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const pending = eq(suggestionsTable.status, "pending");
  const rejected = and(eq(suggestionsTable.status, "rejected"), gte(suggestionsTable.decidedAt, since));
  const rows = await db
    .select()
    .from(suggestionsTable)
    .where(
      and(
        eq(suggestionsTable.clientId, scope.clientId),
        status === "pending" ? pending : status === "rejected" ? rejected : or(pending, rejected),
        sql.raw(suggestionVisible("suggestions", scope.grants)),
      ),
    )
    .orderBy(desc(suggestionsTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return {
    suggestions: rows.map((s) => {
      const p = s.payload as Record<string, unknown>;
      const text =
        typeof p.text === "string"
          ? p.text
          : typeof p.name === "string"
            ? p.name
            : Object.entries((p.fields as Record<string, string>) ?? {})
                .map(([k, v]) => `${k}: ${v}`)
                .join("; ");
      return {
        suggestion_id: s.id,
        kind: s.kind,
        status: s.status as "pending" | "rejected",
        on: s.entityType && s.entityId != null ? toRef(s.entityType as "project", s.entityId) : null,
        text,
        created_at: s.createdAt.toISOString(),
        decided_at: s.decidedAt ? s.decidedAt.toISOString() : null,
      };
    }),
  };
}
