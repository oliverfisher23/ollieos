import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  decisionVisible,
  documentVisible,
  factVisible,
  ideaVisible,
  noteVisible,
  organisationVisible,
  personVisible,
  projectVisible,
  sessionVisible,
  strategyVisible,
  taskVisible,
  NO_GRANTS,
} from "./visibility";
import type { AiScope } from "./scope";

export const SEARCH_TYPES = ["task", "project", "person", "organisation", "decision", "note", "fact", "document", "session", "strategy", "idea"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  type: SearchType;
  id: number;
  title: string;
  snippet: string | null;
  /** Project, person and organisation slug; the parent entity slug for facts */
  slug: string | null;
  /** For facts and notes: the entity they hang off */
  entityType: string | null;
  entityId: number | null;
  rank: number;
  /** True when AI clients cannot read this item (own flag or inherited) */
  hiddenFromAi: boolean;
  /** Own confidential flag (null when inherited) */
  confidential: boolean | null;
  status: string | null;
  /** Facts only: stale or in conflict */
  needsCheck: boolean;
}

export interface SearchOptions {
  q: string;
  types?: readonly SearchType[];
  /**
   * "user" matches word prefixes and requires every word (typing in a search box).
   * "ask" matches any significant word and ranks by how many match (a question in prose).
   */
  mode: "user" | "ask";
  /** AI-facing reads pass true so hidden rows are never fetched. */
  visibleOnly: boolean;
  /** The AI client's grants. Without one, nothing hidden is unlocked; hiddenFromAi is always relative to this. */
  scope?: AiScope;
  limitPerType?: number;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Builds a safe tsquery string from free text: only letters and digits survive. */
export function buildTsQuery(q: string, mode: "user" | "ask"): string | null {
  const words = (q.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 2).slice(0, 24);
  if (!words.length) return null;
  if (mode === "user") return words.map((w) => `'${w}':*`).join(" & ");
  return [...new Set(words)].map((w) => `'${w}'`).join(" | ");
}

/** Wraps a visibility expression so the select returns hidden_from_ai and, for AI reads, filters. */
function vis(expr: string, visibleOnly: boolean) {
  return {
    hidden: sql.raw(`not ${expr}`),
    where: visibleOnly ? sql.raw(` and ${expr}`) : sql.raw(""),
  };
}

function textMatch(vector: SQL, tsq: string | null, ilikeCol: SQL | null, q: string, mode: "user" | "ask"): SQL {
  const parts: SQL[] = [];
  if (tsq) parts.push(sql`${vector} @@ to_tsquery('english', ${tsq})`);
  if (mode === "user" && ilikeCol && q.trim().length >= 2) parts.push(sql`${ilikeCol} ilike ${"%" + q.trim().replace(/[\\%_]/g, (c) => "\\" + c) + "%"}`);
  if (!parts.length) return sql`false`;
  return sql.join(parts, sql` or `);
}

function rankExpr(vector: SQL, tsq: string | null): SQL {
  return tsq ? sql`ts_rank(${vector}, to_tsquery('english', ${tsq}))` : sql`0`;
}

function queryFor(type: SearchType, q: string, tsq: string | null, opts: SearchOptions, limit: number): SQL {
  const { mode, visibleOnly } = opts;
  const g = opts.scope?.grants ?? NO_GRANTS;
  switch (type) {
    case "task": {
      const v = vis(taskVisible("t", g), visibleOnly);
      return sql`select 'task' as type, t.id, t.title, coalesce(t.source_subject, t.snippet, t.notes) as snippet, null as slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("t.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, t.confidential, t.status::text as status, null::boolean as needs_check
        from tasks t
        where t.status <> 'noise' and (${textMatch(sql.raw("t.search"), tsq, sql.raw("t.title"), q, mode)})${v.where}
        order by rank desc, t.updated_at desc limit ${limit}`;
    }
    case "project": {
      const v = vis(projectVisible("p", g), visibleOnly);
      return sql`select 'project' as type, p.id, p.name as title, p.summary as snippet, p.slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("p.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, p.confidential, p.status, null::boolean as needs_check
        from projects p
        where (${textMatch(sql.raw("p.search"), tsq, sql.raw("p.name"), q, mode)})${v.where}
        order by rank desc, p.updated_at desc limit ${limit}`;
    }
    case "person": {
      const v = vis(personVisible("pe", g), visibleOnly);
      return sql`select 'person' as type, pe.id, pe.name as title,
          nullif(concat_ws(' · ', ${sql.raw(visibleOnly ? `case when ${organisationVisible("o", g)} then o.name end` : "o.name")}, pe.role), '') as snippet, pe.slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("pe.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, pe.confidential, null as status, null::boolean as needs_check
        from people pe left join organisations o on o.id = pe.organisation_id
        where (${textMatch(sql.raw("pe.search"), tsq, sql.raw("pe.name"), q, mode)})${v.where}
        order by rank desc, pe.updated_at desc limit ${limit}`;
    }
    case "organisation": {
      const v = vis(organisationVisible("o", g), visibleOnly);
      return sql`select 'organisation' as type, o.id, o.name as title, coalesce(o.type, o.summary) as snippet, o.slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("o.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, o.confidential, null as status, null::boolean as needs_check
        from organisations o
        where (${textMatch(sql.raw("o.search"), tsq, sql.raw("o.name"), q, mode)})${v.where}
        order by rank desc, o.updated_at desc limit ${limit}`;
    }
    case "decision": {
      const v = vis(decisionVisible("d", g), visibleOnly);
      return sql`select 'decision' as type, d.id, d.text as title, ${sql.raw(visibleOnly ? `case when ${projectVisible("p", g)} then p.name end` : "p.name")} as snippet, null as slug,
          'project' as entity_type, d.project_id as entity_id, ${rankExpr(sql.raw("d.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, d.confidential, null as status, null::boolean as needs_check
        from decisions d join projects p on p.id = d.project_id
        where (${textMatch(sql.raw("d.search"), tsq, sql.raw("d.text"), q, mode)})${v.where}
        order by rank desc, d.decided_at desc limit ${limit}`;
    }
    case "note": {
      const v = vis(noteVisible("n", g), visibleOnly);
      return sql`select 'note' as type, n.id, coalesce(nullif(n.title, ''), left(n.body, 80)) as title, n.body as snippet, null as slug,
          n.entity_type::text as entity_type, n.entity_id, ${rankExpr(sql.raw("n.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, n.confidential, null as status, null::boolean as needs_check
        from notes n
        where (${textMatch(sql.raw("n.search"), tsq, sql.raw("concat_ws(' ', n.title, n.body)"), q, mode)})${v.where}
        order by rank desc, n.updated_at desc limit ${limit}`;
    }
    case "fact": {
      const v = vis(factVisible("f", g), visibleOnly);
      return sql`select 'fact' as type, f.id, f.text as title, null as snippet, null as slug,
          f.entity_type::text as entity_type, f.entity_id, ${rankExpr(sql.raw("f.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, null::boolean as confidential, null as status, f.needs_check
        from facts f
        where f.superseded_by is null and (${textMatch(sql.raw("f.search"), tsq, sql.raw("f.text"), q, mode)})${v.where}
        order by rank desc, f.created_at desc limit ${limit}`;
    }
    case "document": {
      const v = vis(documentVisible("dc", g), visibleOnly);
      return sql`select 'document' as type, dc.id, dc.title, coalesce(dc.summary, dc.url) as snippet, null as slug,
          null as entity_type, null::int as entity_id,
          greatest(${rankExpr(sql.raw("dc.search"), tsq)}, ${rankExpr(sql.raw("dcc.search"), tsq)} * 0.5) as rank,
          ${v.hidden} as hidden_from_ai, dc.confidential, dc.location::text as status, null::boolean as needs_check
        from documents dc
        left join document_contents dcc on dcc.document_id = dc.id
        where (${textMatch(sql.raw("dc.search"), tsq, sql.raw("concat_ws(' ', dc.title, dc.summary)"), q, mode)}
          ${tsq ? sql`or dcc.search @@ to_tsquery('english', ${tsq})` : sql``})${v.where}
        order by rank desc, dc.last_confirmed_at desc limit ${limit}`;
    }
    case "session": {
      const v = vis(sessionVisible("cs", g), visibleOnly);
      return sql`select 'session' as type, cs.id, cs.title, cs.summary as snippet, null as slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("cs.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, cs.confidential, to_char(cs.happened_at at time zone 'Europe/London', 'YYYY-MM-DD') as status, null::boolean as needs_check
        from cowork_sessions cs
        where (${textMatch(sql.raw("cs.search"), tsq, sql.raw("cs.title"), q, mode)})${v.where}
        order by rank desc, cs.happened_at desc limit ${limit}`;
    }
    case "strategy": {
      const v = vis(strategyVisible("ss", g), visibleOnly);
      return sql`select 'strategy' as type, ss.id, ss.name as title, left(ss.body, 300) as snippet, null as slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("ss.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, ss.confidential, null as status, null::boolean as needs_check
        from strategy_sections ss
        where ss.deleted_at is null and (${textMatch(sql.raw("ss.search"), tsq, sql.raw("concat_ws(' ', ss.name, ss.body)"), q, mode)})${v.where}
        order by rank desc, ss.updated_at desc limit ${limit}`;
    }
    case "idea": {
      const v = vis(ideaVisible("i", g), visibleOnly);
      return sql`select 'idea' as type, i.id, i.title, left(i.notes, 300) as snippet, null as slug,
          null as entity_type, null::int as entity_id, ${rankExpr(sql.raw("i.search"), tsq)} as rank,
          ${v.hidden} as hidden_from_ai, i.confidential, i.status::text as status, null::boolean as needs_check
        from ideas i
        where i.deleted_at is null and (${textMatch(sql.raw("i.search"), tsq, sql.raw("concat_ws(' ', i.title, i.notes)"), q, mode)})${v.where}
        order by rank desc, i.updated_at desc limit ${limit}`;
    }
  }
}

interface RawHit {
  type: SearchType;
  id: number;
  title: string;
  snippet: string | null;
  slug: string | null;
  entity_type: string | null;
  entity_id: number | null;
  rank: number | string;
  hidden_from_ai: boolean;
  confidential: boolean | null;
  status: string | null;
  needs_check: boolean | null;
}

/** Full-text search across tasks and Knowledge. */
export async function searchItems(opts: SearchOptions): Promise<SearchHit[]> {
  const q = opts.q.trim().slice(0, 300);
  const tsq = buildTsQuery(q, opts.mode);
  if (!tsq && (opts.mode === "ask" || q.length < 2)) return [];
  const types = opts.types?.length ? opts.types : SEARCH_TYPES;
  const limit = opts.limitPerType ?? 10;

  const results = await Promise.all(
    types.map(async (type) => {
      const res = await db.execute(queryFor(type, q, tsq, opts, limit));
      return (res.rows as unknown as RawHit[]).map(
        (r): SearchHit => ({
          type: r.type,
          id: Number(r.id),
          title: r.title,
          snippet: r.snippet,
          slug: r.slug,
          entityType: r.entity_type,
          entityId: r.entity_id == null ? null : Number(r.entity_id),
          rank: Number(r.rank),
          hiddenFromAi: !!r.hidden_from_ai,
          confidential: r.confidential,
          status: r.status,
          needsCheck: !!r.needs_check,
        }),
      );
    }),
  );
  return results.flat().sort((a, b) => b.rank - a.rank);
}
