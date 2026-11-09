import { toRef } from "@workspace/shared";
import { recordReads, recordSearch, type AiScope } from "./scope";
import { SEARCH_TYPES, searchItems, type SearchType } from "./search";

export interface AiSearchResult {
  type: SearchType;
  ref: string;
  title: string;
  snippet: string | null;
  updated_at: string | null;
}

/** The MCP search tool. Hidden rows are filtered in SQL, so they are never fetched or counted. */
export async function searchForAi(scope: AiScope, input: { query: string; types?: SearchType[]; limit?: number }): Promise<{ results: AiSearchResult[] }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const types = input.types?.filter((t) => (SEARCH_TYPES as readonly string[]).includes(t));
  const hits = await searchItems({ q: input.query ?? "", types, mode: "user", visibleOnly: true, scope, limitPerType: limit });
  let results = hits.slice(0, limit);
  // Prefix-and-all-words found nothing: fall back to any-word matching, as a sentence-style query would need.
  if (!results.length) results = (await searchItems({ q: input.query ?? "", types, mode: "ask", visibleOnly: true, scope, limitPerType: limit })).slice(0, limit);
  const out = results.map((h) => ({
    type: h.type,
    ref: toRef(h.type, h.id),
    title: h.title,
    snippet: h.snippet ? h.snippet.slice(0, 300) : null,
    updated_at: h.updatedAt ? h.updatedAt.toISOString() : null,
  }));
  const batch = crypto.randomUUID();
  await recordSearch(scope, input.query ?? "", out.map((r) => r.ref), { tool: "search", batch });
  await recordReads(scope, out.map((r) => r.ref), { tool: "search", query: input.query, batch });
  return { results: out };
}
