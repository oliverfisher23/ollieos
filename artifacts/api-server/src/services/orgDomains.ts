/**
 * An organisation's email domains (acme.com). The contact finder fills them in for organisations it
 * creates; here Ollie sets them himself. Setting one puts people with no organisation who write from
 * that domain under it straight away (his own edit, so no card), and from then on a new person with
 * that domain is placed there when they are added.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, organisationsTable, peopleTable } from "@workspace/db";
import { cleanEmailDomain } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { ACTOR } from "./knowledge/common";
import { emailsOf } from "./personMatch";
import { FREE_MAIL } from "./peopleSignals";
import { NotFoundError, ValidationError } from "./tasks";

export const DOMAINS_MAX = 10;

export interface DomainsResult {
  domains: string[];
  /** People with no organisation who write from these domains, now placed here */
  placed: { id: number; name: string; slug: string }[];
}

export async function setOrganisationDomains(slug: string, input: string[]): Promise<DomainsResult> {
  const [org] = await db.select().from(organisationsTable).where(eq(organisationsTable.slug, slug));
  if (!org) throw new NotFoundError("That organisation does not exist");
  const domains: string[] = [];
  for (const raw of input) {
    if (!raw.trim()) continue;
    const d = cleanEmailDomain(raw);
    if (!d) throw new ValidationError(`"${raw.trim()}" does not look like an email domain. Use the part after the @, like acme.com.`);
    if (FREE_MAIL.has(d)) throw new ValidationError(`${d} is a personal email service, so it cannot belong to one organisation.`);
    if (!domains.includes(d)) domains.push(d);
  }
  if (domains.length > DOMAINS_MAX) throw new ValidationError(`Keep it to ${DOMAINS_MAX} domains`);
  for (const d of domains) {
    const [taken] = await db
      .select({ name: organisationsTable.name })
      .from(organisationsTable)
      .where(and(ne(organisationsTable.id, org.id), sql`${d} = any(${organisationsTable.domains})`));
    if (taken) throw new ValidationError(`${d} already belongs to ${taken.name}`);
  }

  return db.transaction(async (tx) => {
    await tx.update(organisationsTable).set({ domains }).where(eq(organisationsTable.id, org.id));
    const added = domains.filter((d) => !org.domains.includes(d));
    const placed: DomainsResult["placed"] = [];
    if (added.length) {
      const loose = await tx
        .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, email: peopleTable.email, otherEmails: peopleTable.otherEmails })
        .from(peopleTable)
        .where(and(isNull(peopleTable.organisationId), eq(peopleTable.isSelf, false)));
      for (const p of loose) {
        if (!emailsOf(p).some((e) => added.includes(e.split("@")[1] ?? ""))) continue;
        await tx.update(peopleTable).set({ organisationId: org.id }).where(eq(peopleTable.id, p.id));
        await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "person", entityId: p.id, payload: { fields: ["organisationId"], via: "organisation domain", organisation: org.id } });
        placed.push({ id: p.id, name: p.name, slug: p.slug });
      }
    }
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "organisation", entityId: org.id, payload: { fields: ["domains"], domains: { from: org.domains, to: domains }, placed: placed.length } });
    return { domains, placed };
  });
}
