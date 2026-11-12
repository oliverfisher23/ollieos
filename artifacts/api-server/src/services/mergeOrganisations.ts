/**
 * Merging two records for the same organisation ("BT" and "BT Group"). Everything on the merged
 * record moves to the one kept: its people, facts, notes, activity, suggestions, research, links and
 * relationships (projects, products, playbooks, rules, who decides), meeting history and email
 * domains. The kept record's own details win where both have one. The merged record is then removed.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { accessRequestsTable, activityTable, companyResearchTable, db, factsTable, linksTable, notesTable, organisationsTable, peopleTable, suggestionsTable } from "@workspace/db";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { ACTOR } from "./knowledge/common";
import { DOMAINS_MAX } from "./orgDomains";
import { NotFoundError, ValidationError } from "./tasks";

export interface OrgMergeResult {
  kept: { id: number; name: string; slug: string };
  removed: { id: number; name: string };
  moved: { people: number; facts: number; notes: number; links: number };
}

async function loadById(conn: DbOrTx, id: number) {
  const [o] = await conn.select().from(organisationsTable).where(eq(organisationsTable.id, id));
  if (!o) throw new NotFoundError("That organisation does not exist");
  return o;
}

/** Moves links from the merged organisation to the kept one; a link the kept one already has is not doubled. */
async function moveLinks(tx: DbOrTx, keepId: number, goneId: number): Promise<number> {
  const T = "organisation" as const;
  const rows = await tx
    .select()
    .from(linksTable)
    .where(or(and(eq(linksTable.fromType, T), eq(linksTable.fromId, goneId)), and(eq(linksTable.toType, T), eq(linksTable.toId, goneId))));
  let moved = 0;
  for (const r of rows) {
    const out = r.fromType === T && r.fromId === goneId;
    const other = out ? { type: r.toType, id: r.toId } : { type: r.fromType, id: r.fromId };
    await tx
      .delete(linksTable)
      .where(and(eq(linksTable.fromType, r.fromType), eq(linksTable.fromId, r.fromId), eq(linksTable.toType, r.toType), eq(linksTable.toId, r.toId)));
    // A link between the two records means nothing once they are one organisation.
    if (other.type === T && (other.id === keepId || other.id === goneId)) continue;
    const pair = or(
      and(eq(linksTable.fromType, T), eq(linksTable.fromId, keepId), eq(linksTable.toType, other.type), eq(linksTable.toId, other.id)),
      and(eq(linksTable.fromType, other.type), eq(linksTable.fromId, other.id), eq(linksTable.toType, T), eq(linksTable.toId, keepId)),
    );
    const [existing] = await tx.select().from(linksTable).where(pair);
    if (existing) {
      // Keep the kept organisation's link, unless only the merged one says how they are related.
      if (existing.relationship || !r.relationship) continue;
      await tx.delete(linksTable).where(pair);
    }
    await tx.insert(linksTable).values({ ...r, fromType: out ? T : r.fromType, fromId: out ? keepId : r.fromId, toType: out ? r.toType : T, toId: out ? r.toId : keepId });
    moved++;
  }
  return moved;
}

/** Merges `goneId` into `keepId`. */
export async function mergeOrganisations(keepId: number, goneId: number, now = new Date()): Promise<OrgMergeResult> {
  if (keepId === goneId) throw new ValidationError("Choose another organisation to merge with");
  return db.transaction(async (tx) => {
    const keep = await loadById(tx, keepId);
    const gone = await loadById(tx, goneId);
    if (gone.internal && !keep.internal) throw new ValidationError("Your own company cannot be merged into an outside organisation. Merge the other record into it instead.");

    const people = await tx.update(peopleTable).set({ organisationId: keepId }).where(eq(peopleTable.organisationId, goneId)).returning({ id: peopleTable.id });
    const facts = await tx
      .update(factsTable)
      .set({ entityId: keepId })
      .where(and(eq(factsTable.entityType, "organisation"), eq(factsTable.entityId, goneId)))
      .returning({ id: factsTable.id });
    const notes = await tx
      .update(notesTable)
      .set({ entityId: keepId })
      .where(and(eq(notesTable.entityType, "organisation"), eq(notesTable.entityId, goneId)))
      .returning({ id: notesTable.id });
    await tx.update(activityTable).set({ entityId: keepId }).where(and(eq(activityTable.entityType, "organisation"), eq(activityTable.entityId, goneId)));
    await tx.update(suggestionsTable).set({ entityId: keepId }).where(and(eq(suggestionsTable.entityType, "organisation"), eq(suggestionsTable.entityId, goneId)));
    await tx.update(suggestionsTable).set({ resultId: keepId }).where(and(eq(suggestionsTable.resultType, "organisation"), eq(suggestionsTable.resultId, goneId)));
    // Cards that name the merged organisation (a new person's organisation, a project's client) now name the kept one.
    for (const key of ["organisation_id", "client_id"]) {
      await tx.execute(
        sql`update suggestions set payload = jsonb_set(payload, ${`{${key}}`}::text[], to_jsonb(${keepId}::int)) where jsonb_typeof(payload -> ${key}) = 'number' and (payload ->> ${key})::int = ${goneId}`,
      );
    }
    await tx.update(accessRequestsTable).set({ entityId: keepId }).where(and(eq(accessRequestsTable.entityType, "organisation"), eq(accessRequestsTable.entityId, goneId)));
    await tx.update(companyResearchTable).set({ organisationId: keepId }).where(eq(companyResearchTable.organisationId, goneId));
    await tx.execute(
      sql`update meeting_history set org_ids = case when ${keepId} = any(org_ids) then array_remove(org_ids, ${goneId}) else array_replace(org_ids, ${goneId}, ${keepId}) end where ${goneId} = any(org_ids)`,
    );
    await tx.execute(sql`update contact_finder_seen set result = ${`organisation:${keepId}`} where result = ${`organisation:${goneId}`}`);
    const links = await moveLinks(tx, keepId, goneId);

    // Details: the kept record's win; every email domain carries over.
    const domains = [...new Set([...keep.domains, ...gone.domains])].slice(0, DOMAINS_MAX);
    await tx.update(organisationsTable).set({ domains: [] }).where(eq(organisationsTable.id, goneId));
    await tx
      .update(organisationsTable)
      .set({
        type: keep.type ?? gone.type,
        summary: keep.summary ?? gone.summary,
        pulseQuietDays: keep.pulseQuietDays ?? gone.pulseQuietDays,
        domains,
        // Hidden if either was hidden: merging never shows AI something Ollie had kept from it.
        confidential: keep.confidential || gone.confidential,
        aiAccess: keep.aiAccess && gone.aiAccess,
        updatedAt: now,
      })
      .where(eq(organisationsTable.id, keepId));
    await tx.delete(organisationsTable).where(eq(organisationsTable.id, goneId));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "merge",
      entityType: "organisation",
      entityId: keepId,
      payload: { merged: { id: goneId, name: gone.name, domains: gone.domains }, people: people.length, facts: facts.length, notes: notes.length, links },
    });
    return { kept: { id: keep.id, name: keep.name, slug: keep.slug }, removed: { id: gone.id, name: gone.name }, moved: { people: people.length, facts: facts.length, notes: notes.length, links } };
  });
}
