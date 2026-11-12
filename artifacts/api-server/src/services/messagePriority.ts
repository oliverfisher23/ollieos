/**
 * Who a message on Messages is from, and whether they should come first: someone at a client
 * organisation (typed customer, client or partner), or someone Ollie is overdue to be in touch
 * with. Read without AI, from People and Organisations.
 */
import { eq, inArray, or } from "drizzle-orm";
import { db, organisationsTable, peopleTable } from "@workspace/db";
import { isClientOrgType } from "@workspace/shared";
import { projectsForPeople, stateFor } from "./cadence";
import { byEmailMap, hasAnyEmail } from "./personMatch";

export interface MessageSender {
  personId: number;
  personSlug: string;
  personName: string;
  /** Why they come first ("Client", "Overdue to contact"); null when they do not */
  priority: string | null;
}

export interface Senders {
  byEmail: Map<string, MessageSender>;
  byPersonId: Map<number, MessageSender>;
}

/** The people behind these addresses and person ids, with why each comes first. Never Ollie's own record. */
export async function sendersFor(emails: (string | null)[], personIds: (number | null)[]): Promise<Senders> {
  const addresses = [...new Set(emails.flatMap((e) => (e ? [e.trim().toLowerCase()] : [])))];
  const ids = [...new Set(personIds.filter((x): x is number => x != null))];
  const out: Senders = { byEmail: new Map(), byPersonId: new Map() };
  if (!addresses.length && !ids.length) return out;
  const rows = await db
    .select({ person: peopleTable, orgType: organisationsTable.type, orgInternal: organisationsTable.internal })
    .from(peopleTable)
    .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(or(hasAnyEmail(addresses), ids.length ? inArray(peopleTable.id, ids) : undefined));
  const people = rows.filter((r) => !r.person.isSelf);
  const projects = await projectsForPeople(people.map((r) => r.person.id));
  const senders = new Map<number, MessageSender>();
  for (const r of people) {
    const p = r.person;
    const client = !r.orgInternal && isClientOrgType(r.orgType);
    const overdue = stateFor(p, projects.get(p.id)).status === "overdue";
    senders.set(p.id, { personId: p.id, personSlug: p.slug, personName: p.name, priority: client ? "Client" : overdue ? "Overdue to contact" : null });
  }
  out.byPersonId = senders;
  for (const [email, r] of byEmailMap(people.map((r) => r.person))) out.byEmail.set(email, senders.get(r.id)!);
  return out;
}
