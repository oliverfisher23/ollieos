/**
 * "Who can introduce me?" on a person page. When Ollie does not know someone well (cooling or
 * cold), OllieOS looks for people he does know well (strong or warm) who are connected to them:
 * a stated relationship ("works with", "reports to"), the same organisation, or one step further
 * through a stated relationship. Read from links Ollie has approved; no AI.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, linksTable, organisationsTable, peopleTable, type Person } from "@workspace/db";
import { RELATIONSHIP_INVERSE, RELATIONSHIP_LABELS, todayLondon, type Relationship, type Strength } from "@workspace/shared";
import { strengthOf } from "./cadence";

export interface Introduction {
  via: { id: number; name: string; slug: string; role: string | null; organisation: string | null; strength: Strength };
  /** How they connect, read from the introducer: "works with Anna Clarke" */
  how: string;
  /** direct: a stated relationship; organisation: same employer; second: through someone else */
  kind: "direct" | "organisation" | "second";
}

const MAX = 4;
const KIND_ORDER = { direct: 0, organisation: 1, second: 2 } as const;
const STRENGTH_ORDER: Record<Strength, number> = { strong: 0, warm: 1, cooling: 2, cold: 3 };
/** Relationships that mean two people actually know each other. */
const KNOWS: ReadonlySet<Relationship> = new Set(["reports_to", "works_with", "advises", "introduced_by"]);

interface Edge {
  other: number;
  /** Read from this end: "works with", "manages" */
  phrase: string;
}

export async function introductionsFor(target: Pick<Person, "id" | "name" | "organisationId">, targetStrength: Strength, dayCounts: Map<number, number>): Promise<Introduction[]> {
  if (targetStrength === "strong" || targetStrength === "warm") return [];
  const [people, links] = await Promise.all([
    db
      .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, role: peopleTable.role, orgId: peopleTable.organisationId, orgName: organisationsTable.name, lastContactAt: peopleTable.lastContactAt })
      .from(peopleTable)
      .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
      .where(and(eq(peopleTable.isSelf, false), eq(peopleTable.archived, false))),
    db
      .select({ from: linksTable.fromId, to: linksTable.toId, relationship: linksTable.relationship })
      .from(linksTable)
      .where(and(eq(linksTable.fromType, "person"), eq(linksTable.toType, "person"), isNotNull(linksTable.relationship))),
  ]);
  const today = todayLondon();
  const byId = new Map(people.map((p) => [p.id, { ...p, strength: strengthOf(p.lastContactAt, dayCounts.get(p.id) ?? 0, today) }]));
  const knownWell = (id: number) => {
    const p = byId.get(id);
    return !!p && id !== target.id && (p.strength === "strong" || p.strength === "warm");
  };
  const edges = new Map<number, Edge[]>();
  const add = (a: number, e: Edge) => edges.set(a, [...(edges.get(a) ?? []), e]);
  for (const l of links) {
    const r = l.relationship as Relationship;
    if (!KNOWS.has(r)) continue;
    add(l.from, { other: l.to, phrase: RELATIONSHIP_LABELS[r] });
    add(l.to, { other: l.from, phrase: RELATIONSHIP_INVERSE[r] });
  }

  const found = new Map<number, Introduction>();
  const offer = (id: number, how: string, kind: Introduction["kind"]) => {
    const p = byId.get(id);
    if (!p || found.has(id)) return;
    found.set(id, { via: { id: p.id, name: p.name, slug: p.slug, role: p.role, organisation: p.orgName ?? null, strength: p.strength }, how, kind });
  };
  // 1. Someone Ollie knows well with a stated relationship to them.
  for (const [id, list] of edges) {
    if (!knownWell(id)) continue;
    const e = list.find((x) => x.other === target.id);
    if (e) offer(id, `${e.phrase} ${target.name}`, "direct");
  }
  // 2. Someone Ollie knows well at the same organisation.
  if (target.organisationId != null) {
    for (const p of byId.values()) if (p.orgId === target.organisationId && knownWell(p.id)) offer(p.id, `also at ${p.orgName}`, "organisation");
  }
  // 3. One step further: they know someone who has a stated relationship to the target.
  for (const mid of edges.get(target.id) ?? []) {
    const middle = byId.get(mid.other);
    if (!middle) continue;
    for (const [id, list] of edges) {
      if (!knownWell(id) || id === mid.other) continue;
      const e = list.find((x) => x.other === mid.other);
      // mid.phrase reads from the target's end; turn it round so it reads from the person in the middle.
      const back = (edges.get(mid.other) ?? []).find((x) => x.other === target.id);
      if (e && back) offer(id, `${e.phrase} ${middle.name}, who ${back.phrase} ${target.name}`, "second");
    }
  }
  return [...found.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || STRENGTH_ORDER[a.via.strength] - STRENGTH_ORDER[b.via.strength] || (dayCounts.get(b.via.id) ?? 0) - (dayCounts.get(a.via.id) ?? 0) || a.via.name.localeCompare(b.via.name, "en-GB"))
    .slice(0, MAX);
}
