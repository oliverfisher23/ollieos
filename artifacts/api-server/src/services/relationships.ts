/**
 * Stated relationships between people, organisations and projects (build plan 13, Part G).
 * A relationship is a link with a label, read "from <label> to". Ollie sets them directly; AI
 * tools propose them through the Knowledge Inbox and they are set here when he approves.
 */
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db, linksTable } from "@workspace/db";
import { RELATIONSHIPS, RELATIONSHIP_INVERSE, RELATIONSHIP_LABELS, SYMMETRIC_RELATIONSHIPS, type Relationship } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { ACTOR, cleanText, resolveEntities, resolveEntity, touch, type EntityKind } from "./knowledge/common";
import { ValidationError } from "./tasks";

export const RELATABLE = ["person", "organisation", "project"] as const;
export { RELATIONSHIPS };

export interface End {
  type: EntityKind;
  id: number;
}

export interface RelationshipView {
  relationship: Relationship;
  /** How it reads from the item being looked at: "reports to", or "manages" from the other end */
  phrase: string;
  direction: "out" | "in";
  other: { type: EntityKind; id: number; name: string; slug: string | null };
  note: string | null;
  source: string | null;
  createdBy: string;
  createdAt: Date;
}

const pairWhere = (a: End, b: End) =>
  or(
    and(eq(linksTable.fromType, a.type), eq(linksTable.fromId, a.id), eq(linksTable.toType, b.type), eq(linksTable.toId, b.id)),
    and(eq(linksTable.fromType, b.type), eq(linksTable.fromId, b.id), eq(linksTable.toType, a.type), eq(linksTable.toId, a.id)),
  );

/** Project to person or organisation links mean something without a label (the project's people). */
const plainLinkMatters = (a: End, b: End) => (a.type === "project") !== (b.type === "project");

export function phraseFor(relationship: Relationship, direction: "out" | "in"): string {
  return direction === "out" ? RELATIONSHIP_LABELS[relationship] : RELATIONSHIP_INVERSE[relationship];
}

/** The relationship already stated between two items, whichever way round it was stored. */
export async function existingRelationship(a: End, b: End, conn: DbOrTx = db) {
  const [row] = await conn.select().from(linksTable).where(and(pairWhere(a, b), isNotNull(linksTable.relationship)));
  return row ?? null;
}

/** True when the same relationship already reads the same way (either way for two-way ones). */
export function sameRelationship(row: { fromType: string; fromId: number; relationship: Relationship | null }, from: End, relationship: Relationship): boolean {
  if (row.relationship !== relationship) return false;
  if (SYMMETRIC_RELATIONSHIPS.includes(relationship)) return true;
  return row.fromType === from.type && row.fromId === from.id;
}

export interface SetRelationshipInput {
  from: End;
  to: End;
  relationship: Relationship;
  note?: string | null;
}

/**
 * States how two items are related. Replaces whatever link was there between them, so each pair
 * holds one relationship. `source` says where an approved one came from.
 */
export async function setRelationship(
  input: SetRelationshipInput,
  opts: { actor?: string; source?: string | null; suggestionId?: number | null; conn?: DbOrTx } = {},
): Promise<RelationshipView> {
  const { from, to, relationship } = input;
  if (!RELATIONSHIPS.includes(relationship)) throw new ValidationError("Choose a relationship");
  if (from.type === to.type && from.id === to.id) throw new ValidationError("An item cannot be related to itself");
  const run = async (tx: DbOrTx) => {
    const [, b] = await Promise.all([resolveEntity(from.type, from.id, tx), resolveEntity(to.type, to.id, tx)]);
    await tx.delete(linksTable).where(pairWhere(from, to));
    const note = cleanText(input.note)?.slice(0, 1000) ?? null;
    const source = cleanText(opts.source)?.slice(0, 500) ?? null;
    const actor = opts.actor ?? ACTOR;
    const [row] = await tx
      .insert(linksTable)
      .values({ fromType: from.type, fromId: from.id, toType: to.type, toId: to.id, relationship, note, source, createdBy: actor })
      .returning();
    await touch(tx, from.type, from.id);
    await touch(tx, to.type, to.id);
    await writeAudit(tx, {
      actor,
      action: "relate",
      entityType: from.type,
      entityId: from.id,
      payload: { to: `${to.type}:${to.id}`, relationship, ...(opts.suggestionId ? { suggestionId: opts.suggestionId } : {}) },
    });
    return {
      relationship,
      phrase: phraseFor(relationship, "out"),
      direction: "out" as const,
      other: { type: to.type, id: to.id, name: b.name, slug: b.slug },
      note,
      source,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  };
  return opts.conn ? run(opts.conn) : db.transaction(run);
}

/**
 * Takes the label off. A project keeps a plain link to its person or organisation (they still
 * belong to it); any other pair is unlinked.
 */
export async function clearRelationship(a: End, b: End): Promise<{ removed: boolean }> {
  return db.transaction(async (tx) => {
    const row = await existingRelationship(a, b, tx);
    if (!row) return { removed: false };
    if (plainLinkMatters(a, b)) {
      await tx.update(linksTable).set({ relationship: null, note: null, source: null }).where(pairWhere(a, b));
    } else {
      await tx.delete(linksTable).where(pairWhere(a, b));
    }
    await touch(tx, a.type, a.id);
    await touch(tx, b.type, b.id);
    await writeAudit(tx, { actor: ACTOR, action: "unrelate", entityType: a.type, entityId: a.id, payload: { to: `${b.type}:${b.id}`, relationship: row.relationship } });
    return { removed: true };
  });
}

/** Every stated relationship on an item, read from its side. Ollie's view: nothing is hidden. */
export async function relationshipsOf(item: End): Promise<RelationshipView[]> {
  const rows = await db
    .select()
    .from(linksTable)
    .where(
      and(
        isNotNull(linksTable.relationship),
        or(and(eq(linksTable.fromType, item.type), eq(linksTable.fromId, item.id)), and(eq(linksTable.toType, item.type), eq(linksTable.toId, item.id))),
      ),
    );
  const others = rows.map((r) => {
    const out = r.fromType === item.type && r.fromId === item.id;
    return { row: r, direction: (out ? "out" : "in") as "out" | "in", type: (out ? r.toType : r.fromType) as EntityKind, id: out ? r.toId : r.fromId };
  });
  const names = await resolveEntities(others.map((o) => ({ type: o.type, id: o.id })));
  return others
    .filter((o) => (RELATABLE as readonly string[]).includes(o.type) && names.has(`${o.type}:${o.id}`))
    .map((o) => {
      const n = names.get(`${o.type}:${o.id}`)!;
      return {
        relationship: o.row.relationship!,
        phrase: phraseFor(o.row.relationship!, o.direction),
        direction: o.direction,
        other: { type: o.type, id: o.id, name: n.name, slug: n.slug },
        note: o.row.note,
        source: o.row.source,
        createdBy: o.row.createdBy,
        createdAt: o.row.createdAt,
      };
    })
    .sort((x, y) => x.phrase.localeCompare(y.phrase) || x.other.name.localeCompare(y.other.name));
}
