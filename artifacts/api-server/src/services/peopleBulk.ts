/** One change to several people at once, from Contacts: a cadence, a tag, an organisation, or archive. */
import { inArray } from "drizzle-orm";
import { db, organisationsTable, peopleTable } from "@workspace/db";
import { cleanTags, type Cadence } from "@workspace/shared";
import { eq } from "drizzle-orm";
import { writeAudit } from "../lib/audit";
import { ACTOR } from "./knowledge/common";
import { NotFoundError, ValidationError } from "./tasks";

export interface BulkPeopleInput {
  ids: number[];
  cadence?: Cadence;
  addTag?: string;
  removeTag?: string;
  /** null takes them out of their organisation */
  organisationId?: number | null;
  archived?: boolean;
}

export async function bulkUpdatePeople(input: BulkPeopleInput): Promise<{ updated: number }> {
  const ids = [...new Set(input.ids)];
  if (!ids.length) throw new ValidationError("Choose at least one person");
  const addTag = input.addTag !== undefined ? cleanTags([input.addTag])[0] : undefined;
  if (input.addTag !== undefined && !addTag) throw new ValidationError("A tag needs a name");
  const removeKey = input.removeTag?.trim().toLowerCase();
  if (input.cadence === undefined && addTag === undefined && !removeKey && input.organisationId === undefined && input.archived === undefined) throw new ValidationError("Nothing to change");
  if (input.organisationId != null) {
    const [o] = await db.select({ id: organisationsTable.id }).from(organisationsTable).where(eq(organisationsTable.id, input.organisationId));
    if (!o) throw new NotFoundError("That organisation does not exist");
  }
  return db.transaction(async (tx) => {
    const people = await tx.select().from(peopleTable).where(inArray(peopleTable.id, ids));
    let updated = 0;
    for (const p of people) {
      const set: Partial<typeof peopleTable.$inferInsert> = {};
      // Ollie's own record has no cadence and is never archived.
      if (input.archived !== undefined && !p.isSelf && input.archived !== p.archived) {
        set.archived = input.archived;
        if (input.archived && p.cadence !== "none") set.cadence = "none";
      }
      if (input.cadence !== undefined && !p.isSelf && !set.archived && input.cadence !== p.cadence) set.cadence = input.cadence;
      if (input.organisationId !== undefined && input.organisationId !== p.organisationId) set.organisationId = input.organisationId;
      let tags = p.tags;
      if (removeKey) tags = tags.filter((t) => t.toLowerCase() !== removeKey);
      if (addTag) tags = cleanTags([...tags, addTag]);
      if (tags.length !== p.tags.length || tags.some((t, i) => t !== p.tags[i])) set.tags = tags;
      if (!Object.keys(set).length) continue;
      await tx.update(peopleTable).set(set).where(eq(peopleTable.id, p.id));
      await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "person", entityId: p.id, payload: { fields: Object.keys(set), via: "bulk" } });
      updated++;
    }
    return { updated };
  });
}
