/**
 * "Missing from Contacts": people in Ollie's calendar who are not in Contacts. The contact finder
 * reads email, Slack and Granola notes but not calendar invitations, so this covers the gap with no
 * AI: anyone with an email address on two or more work meetings in the calendar (the last 30 days
 * and the week ahead, which is what OllieOS keeps), who is not Ollie, not a room or shared inbox,
 * did not decline, and whom the contact finder has not already dealt with. Add puts them in
 * Contacts, under the organisation that owns their email domain, and links those meetings to them.
 */
import { eq, sql } from "drizzle-orm";
import { calendarEventsTable, contactFinderSeenTable, db, organisationsTable, peopleTable } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { personalAddress } from "./contactFinder";
import { ACTOR } from "./knowledge/common";
import { createPerson, type PersonView } from "./knowledge/entities";
import { emailsOf } from "./personMatch";
import { FREE_MAIL, organisationDomains } from "./peopleSignals";
import { ValidationError } from "./tasks";

/** Meetings together before someone is listed. */
export const MISSING_MIN_MEETINGS = 2;
/** Bigger than this is a webinar or an all-hands, not meeting someone. */
const MAX_ATTENDEES = 15;
const MAX = 20;

export interface MissingContact {
  email: string;
  name: string;
  meetings: number;
  /** The latest meeting with them that has already happened, if any */
  lastMetAt: Date | null;
  /** The next one in the calendar, if any */
  nextMeetingAt: Date | null;
  /** Up to three meeting titles, newest first */
  titles: string[];
  /** The organisation their email domain belongs to, when OllieOS knows it */
  organisation: { id: number; name: string } | null;
}

/** "anna.clarke@x.com" → "Anna Clarke", for an invitation that carries no name. */
export function nameFromEmail(email: string): string {
  return email
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

async function selfEmails(): Promise<Set<string>> {
  const rows = await db.select({ email: peopleTable.email, otherEmails: peopleTable.otherEmails }).from(peopleTable).where(eq(peopleTable.isSelf, true));
  const out = new Set(rows.flatMap((r) => emailsOf(r)));
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  if (allowed) out.add(allowed);
  return out;
}

/** Explicit organisation domains first, then the domain most people at an organisation write from. */
async function orgByDomain(): Promise<Map<string, { id: number; name: string }>> {
  const [inferred, orgs] = await Promise.all([organisationDomains(), db.select({ id: organisationsTable.id, name: organisationsTable.name, domains: organisationsTable.domains }).from(organisationsTable)]);
  const out = new Map(inferred);
  for (const o of orgs) for (const d of o.domains) out.set(d, { id: o.id, name: o.name });
  return out;
}

export async function listMissingContacts(now = new Date()): Promise<MissingContact[]> {
  const [events, people, seen, me, domains] = await Promise.all([
    db
      .select({ id: calendarEventsTable.id, title: calendarEventsTable.title, startsAt: calendarEventsTable.startsAt, attendeeDetails: calendarEventsTable.attendeeDetails })
      .from(calendarEventsTable)
      .where(eq(calendarEventsTable.personal, false)),
    db.select({ email: peopleTable.email, otherEmails: peopleTable.otherEmails }).from(peopleTable),
    db.select({ key: contactFinderSeenTable.key }).from(contactFinderSeenTable),
    selfEmails(),
    orgByDomain(),
  ]);
  const known = new Set(people.flatMap((p) => emailsOf(p)));
  const handled = new Set(seen.map((s) => s.key));
  const found = new Map<string, { names: Map<string, number>; events: { title: string; at: Date }[] }>();
  for (const e of events) {
    const list = e.attendeeDetails ?? [];
    if (list.length > MAX_ATTENDEES) continue;
    for (const a of list) {
      const email = a.email?.trim().toLowerCase();
      if (!email || !email.includes("@") || me.has(email) || known.has(email) || handled.has(email)) continue;
      if (a.response === "declined" || !personalAddress(email) || /(^|\.)calendar\.google\.com$/.test(email.split("@")[1])) continue;
      const row = found.get(email) ?? { names: new Map<string, number>(), events: [] };
      const name = a.name?.trim();
      if (name && !name.includes("@")) row.names.set(name, (row.names.get(name) ?? 0) + 1);
      row.events.push({ title: e.title, at: e.startsAt });
      found.set(email, row);
    }
  }
  const out: MissingContact[] = [];
  for (const [email, row] of found) {
    if (row.events.length < MISSING_MIN_MEETINGS) continue;
    const past = row.events.filter((x) => x.at.getTime() <= now.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
    const future = row.events.filter((x) => x.at.getTime() > now.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime());
    const domain = email.split("@")[1];
    out.push({
      email,
      name: [...row.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? nameFromEmail(email),
      meetings: row.events.length,
      lastMetAt: past[0]?.at ?? null,
      nextMeetingAt: future[0]?.at ?? null,
      titles: [...new Set([...past, ...future].map((x) => x.title))].slice(0, 3),
      organisation: FREE_MAIL.has(domain) ? null : (domains.get(domain) ?? null),
    });
  }
  return out.sort((a, b) => b.meetings - a.meetings || (b.lastMetAt?.getTime() ?? 0) - (a.lastMetAt?.getTime() ?? 0) || a.name.localeCompare(b.name, "en-GB")).slice(0, MAX);
}

async function markHandled(email: string, status: "added" | "ignored", extra: { result?: string | null; why?: string | null }) {
  const value = { key: email, status, suggestionId: null, result: extra.result ?? null, why: extra.why ?? null, at: new Date() };
  await db.insert(contactFinderSeenTable).values(value).onConflictDoUpdate({ target: contactFinderSeenTable.key, set: value });
}

/** Adds someone from the list to Contacts and links the meetings they were in to them. */
export async function addMissingContact(input: { email: string; name?: string | null }, now = new Date()): Promise<PersonView> {
  const email = input.email.trim().toLowerCase();
  const listed = (await listMissingContacts(now)).find((m) => m.email === email);
  if (!listed) throw new ValidationError("They are no longer on the list. They may already be in Contacts.");
  const person = await createPerson({ name: input.name?.trim() || listed.name, email, organisationId: listed.organisation?.id ?? null });
  // The meetings they were in now count as contact with them.
  await db.execute(
    sql`update calendar_events set person_ids = array_append(person_ids, ${person.id}) where not personal and not (${person.id} = any(person_ids)) and exists (select 1 from jsonb_array_elements(attendee_details) a where lower(a ->> 'email') = ${email})`,
  );
  if (listed.lastMetAt) await db.update(peopleTable).set({ lastContactAt: listed.lastMetAt }).where(eq(peopleTable.id, person.id));
  await markHandled(email, "added", { result: `person:${person.id}`, why: "Added from Missing from Contacts" });
  await writeAudit(db, { actor: ACTOR, action: "update", entityType: "person", entityId: person.id, payload: { via: "missing from contacts", meetings: listed.meetings } });
  return { ...person, lastContactAt: listed.lastMetAt ?? person.lastContactAt };
}

/** "Not now": they stop being listed here, and the contact finder leaves them alone too. */
export async function dismissMissingContact(emailRaw: string): Promise<void> {
  const email = emailRaw.trim().toLowerCase();
  if (!email.includes("@")) throw new ValidationError("That is not an email address");
  await markHandled(email, "ignored", { why: "You chose Not now on Contacts" });
}
