/**
 * Client pulse (build plan section 19, Part S): one line on each client organisation (typed
 * customer, client or partner) from what OllieOS already holds: when Ollie last met them and was
 * last in touch, meetings in the last 90 days, emails from them waiting in To answer, what each side
 * owes, and the tone of the last meeting notes. "Needs attention" when any of: no contact for the
 * quiet period (30 days unless changed per organisation), something owed to them overdue, an email
 * from them waiting over 3 working days, or a concerned last meeting.
 */
import { and, arrayOverlaps, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { activityTable, appSettingsTable, calendarEventsTable, db, factsTable, meetingTonesTable, organisationsTable, peopleTable, tasksTable } from "@workspace/db";
import { formatLong, isClientOrgType, todayLondon } from "@workspace/shared";
import { emailsOf } from "./personMatch";
import { oneWorkingDayBefore } from "./slackToAnswer";
import { NotFoundError, ValidationError } from "./tasks";

export const DEFAULT_QUIET_DAYS = 30;
const DAY = 86_400_000;

export interface ClientPulse {
  organisationId: number;
  name: string;
  slug: string;
  quietDays: number;
  lastMetAt: Date | null;
  lastContactAt: Date | null;
  meetings90: number;
  emailsWaiting: number;
  oldestEmailAt: Date | null;
  owedToThem: number;
  overdueToThem: number;
  theyOwe: number;
  tone: { tone: string; reason: string | null; at: Date; title: string } | null;
  needsAttention: boolean;
  /** Why, in short phrases: "No contact for 42 days" */
  reasons: string[];
  /** One plain line for briefs and lists */
  line: string;
  /** Part T: renewal date, contract value and account health, from approved facts, with when each was last confirmed */
  commercial: Commercial;
}

export interface CommercialFact {
  text: string;
  at: Date;
  needsCheck: boolean;
}

export interface Commercial {
  renewalDate: CommercialFact | null;
  /** The renewal date when the fact holds one (YYYY-MM-DD) */
  renewsOn: string | null;
  contractValue: CommercialFact | null;
  accountHealth: CommercialFact | null;
}

/** Renewals this close count towards Needs attention. */
export const RENEWAL_SOON_DAYS = 60;

/** Part T: the current commercial facts on an organisation (the newest of each, not replaced). */
export async function commercialFor(orgId: number): Promise<Commercial> {
  const rows = await db
    .select({ attribute: factsTable.attribute, text: factsTable.text, at: factsTable.lastConfirmedAt, needsCheck: factsTable.needsCheck })
    .from(factsTable)
    .where(and(eq(factsTable.entityType, "organisation"), eq(factsTable.entityId, orgId), inArray(factsTable.attribute, ["renewal_date", "contract_value", "account_health"]), isNull(factsTable.supersededBy)))
    .orderBy(desc(factsTable.createdAt));
  const pick = (a: string) => {
    const r = rows.find((x) => x.attribute === a);
    return r ? { text: r.text, at: r.at, needsCheck: r.needsCheck } : null;
  };
  const renewalDate = pick("renewal_date");
  return { renewalDate, renewsOn: renewalDate ? (/\b(\d{4}-\d{2}-\d{2})\b/.exec(renewalDate.text)?.[1] ?? null) : null, contractValue: pick("contract_value"), accountHealth: pick("account_health") };
}

interface Candidate {
  fromEmail: string | null;
  at: string;
  threadId: string;
  messageId: string;
}

/** Inbox emails waiting on Ollie from these addresses, from the last look at Gmail (To answer). */
async function waitingFrom(emails: Set<string>): Promise<Date[]> {
  if (!emails.size) return [];
  const [snap] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "email_inbox_snapshot"));
  const [done] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "email_inbox_done"));
  const doneMap = (done?.value ?? {}) as Record<string, string>;
  const cands = ((snap?.value as { candidates?: Candidate[] } | undefined)?.candidates ?? []).filter(
    (c) => c.fromEmail && emails.has(c.fromEmail.toLowerCase()) && doneMap[c.threadId] !== c.messageId,
  );
  return cands.map((c) => new Date(c.at));
}

const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY);

export async function pulseFor(orgId: number, now = new Date()): Promise<ClientPulse> {
  const [org] = await db.select().from(organisationsTable).where(eq(organisationsTable.id, orgId));
  if (!org) throw new NotFoundError("That organisation does not exist");
  const people = await db
    .select({ id: peopleTable.id, email: peopleTable.email, otherEmails: peopleTable.otherEmails, lastContactAt: peopleTable.lastContactAt })
    .from(peopleTable)
    .where(eq(peopleTable.organisationId, orgId));
  const ids = people.map((p) => p.id);
  const quietDays = org.pulseQuietDays ?? DEFAULT_QUIET_DAYS;
  const since90 = new Date(now.getTime() - 90 * DAY);
  const today = todayLondon(now);

  const [calendarMet, granolaMet, owed, theyOwe, tones, waiting] = await Promise.all([
    ids.length
      ? db
          .select({ at: calendarEventsTable.startsAt, ref: calendarEventsTable.sourceRef })
          .from(calendarEventsTable)
          .where(and(arrayOverlaps(calendarEventsTable.personIds, ids), eq(calendarEventsTable.personal, false), lt(calendarEventsTable.endsAt, now), gte(calendarEventsTable.startsAt, since90)))
      : [],
    ids.length
      ? db
          .select({ at: activityTable.occurredAt, ref: activityTable.sourceRef })
          .from(activityTable)
          .where(and(eq(activityTable.entityType, "person"), inArray(activityTable.entityId, ids), eq(activityTable.kind, "meeting"), gte(activityTable.occurredAt, since90)))
      : [],
    ids.length
      ? db
          .select({ id: tasksTable.id, dueDate: tasksTable.dueDate })
          .from(tasksTable)
          .where(and(inArray(tasksTable.personId, ids), inArray(tasksTable.status, ["inbox", "now", "backlog"])))
      : ([] as { id: number; dueDate: string | null }[]),
    ids.length
      ? db.select({ id: tasksTable.id }).from(tasksTable).where(and(inArray(tasksTable.waitingOnPersonId, ids), eq(tasksTable.status, "waiting")))
      : [],
    ids.length
      ? db.select().from(meetingTonesTable).where(and(arrayOverlaps(meetingTonesTable.personIds, ids), gte(meetingTonesTable.at, since90))).orderBy(desc(meetingTonesTable.at)).limit(3)
      : [],
    waitingFrom(new Set(people.flatMap((p) => emailsOf(p)))),
  ]);

  const met = [...calendarMet, ...granolaMet].map((m) => m.at).sort((a, b) => b.getTime() - a.getTime());
  const meetingRefs = new Set([...calendarMet.map((m) => m.ref), ...granolaMet.map((m) => m.ref ?? "")].filter(Boolean));
  const lastMetAt = met[0] ?? null;
  const contacts = [lastMetAt, ...people.map((p) => p.lastContactAt)].filter((d): d is Date => !!d);
  const lastContactAt = contacts.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const overdue = owed.filter((t) => t.dueDate && t.dueDate < today).length;
  const oldestEmailAt = waiting.length ? waiting.sort((a, b) => a.getTime() - b.getTime())[0] : null;
  const tone = tones[0] ? { tone: tones[0].tone, reason: tones[0].reason, at: tones[0].at, title: tones[0].title } : null;

  const reasons: string[] = [];
  if (!lastContactAt) reasons.push("No contact on file");
  else if (daysBetween(lastContactAt, now) >= quietDays) reasons.push(`No contact for ${daysBetween(lastContactAt, now)} days`);
  if (overdue) reasons.push(`${overdue} overdue for them`);
  // Over 3 working days: three working days back from now.
  let cutoff = now;
  for (let i = 0; i < 3; i++) cutoff = oneWorkingDayBefore(cutoff);
  if (oldestEmailAt && oldestEmailAt <= cutoff) reasons.push("An email from them has waited over 3 working days");
  if (tone?.tone === "concerned") reasons.push(`Last meeting sounded concerned${tone.reason ? `: ${tone.reason}` : ""}`);
  const commercial = await commercialFor(org.id);
  const renewIn = commercial.renewsOn ? Math.round((Date.parse(commercial.renewsOn + "T12:00:00Z") - now.getTime()) / DAY) : null;
  if (renewIn != null && renewIn >= 0 && renewIn <= RENEWAL_SOON_DAYS) reasons.push(`Renews in ${renewIn} day${renewIn === 1 ? "" : "s"}`);
  if (commercial.accountHealth && /\bat risk\b/i.test(commercial.accountHealth.text)) reasons.push(`Account health: ${commercial.accountHealth.text}`);

  const parts = [
    lastMetAt ? `last met ${daysBetween(lastMetAt, now)} days ago` : "not met in 90 days",
    `${meetingRefs.size} meeting${meetingRefs.size === 1 ? "" : "s"} in 90 days`,
    waiting.length ? `${waiting.length} email${waiting.length === 1 ? "" : "s"} waiting on you` : null,
    owed.length ? `you owe ${owed.length}` : null,
    theyOwe.length ? `they owe ${theyOwe.length}` : null,
    tone ? `last meeting ${tone.tone}` : null,
    commercial.renewsOn ? `renews ${formatLong(commercial.renewsOn)}` : null,
  ].filter(Boolean);
  return {
    organisationId: org.id,
    name: org.name,
    slug: org.slug,
    quietDays,
    lastMetAt,
    lastContactAt,
    meetings90: meetingRefs.size,
    emailsWaiting: waiting.length,
    oldestEmailAt,
    owedToThem: owed.length,
    overdueToThem: overdue,
    theyOwe: theyOwe.length,
    tone,
    needsAttention: reasons.length > 0,
    reasons,
    line: parts.join(", ").replace(/^./, (c) => c.toUpperCase()),
    commercial,
  };
}

/** Every client organisation's pulse, those needing attention first. */
export async function listPulses(now = new Date()): Promise<ClientPulse[]> {
  const orgs = await db.select({ id: organisationsTable.id, type: organisationsTable.type }).from(organisationsTable).where(eq(organisationsTable.internal, false));
  const clients = orgs.filter((o) => isClientOrgType(o.type));
  const out = await Promise.all(clients.map((o) => pulseFor(o.id, now)));
  return out.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || a.name.localeCompare(b.name));
}

/** Pulses for the client organisations among these ids (for briefs). */
export async function pulsesFor(orgIds: number[], now = new Date()): Promise<ClientPulse[]> {
  if (!orgIds.length) return [];
  const orgs = await db.select({ id: organisationsTable.id, type: organisationsTable.type }).from(organisationsTable).where(inArray(organisationsTable.id, orgIds));
  return Promise.all(orgs.filter((o) => isClientOrgType(o.type)).map((o) => pulseFor(o.id, now)));
}

export async function setQuietDays(orgId: number, days: number | null): Promise<void> {
  if (days != null && (!Number.isInteger(days) || days < 7 || days > 365)) throw new ValidationError("Choose between 7 and 365 days");
  await db.update(organisationsTable).set({ pulseQuietDays: days }).where(eq(organisationsTable.id, orgId));
}

