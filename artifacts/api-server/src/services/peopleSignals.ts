/**
 * Part S (build plan section 19): what OllieOS can learn about people from who is on an email
 * thread or in a meeting together, and from email signatures. Everything goes to the Knowledge
 * Inbox; nothing changes until Ollie approves. No AI is used for the counting; the signature is read
 * in the Gmail sorter's existing read.
 */
import { and, count, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { appSettingsTable, coOccurrencesTable, db, factsTable, linksTable, organisationsTable, peopleTable, suggestionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { emailsOf, hasAnyEmail } from "./personMatch";
import { propose, type ProposeMeta } from "./suggestions";

/** Together on this many email threads, or in this many meetings, in 90 days makes a "works with" card. */
export const EMAIL_THREADS = 5;
export const MEETINGS = 3;
const WINDOW_MS = 90 * 86_400_000;
export const SIGNALS_PROPOSER = "OllieOS";

const pairsOf = (ids: number[]) => {
  const u = [...new Set(ids)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) out.push([u[i], u[j]]);
  return out;
};

/** People hidden from AI, and Ollie, are never counted. */
async function countable(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(and(inArray(peopleTable.id, [...new Set(ids)]), eq(peopleTable.isSelf, false), eq(peopleTable.confidential, false), eq(peopleTable.aiAccess, true)));
  return rows.map((r) => r.id);
}

/** Records the known people seen together on one email thread or in one meeting, and proposes what the counts now support. */
export async function recordTogether(kind: "email" | "meeting", ref: string, label: string | null, at: Date, personIds: number[], now = new Date()): Promise<number> {
  const ids = await countable(personIds);
  const pairs = pairsOf(ids).slice(0, 45);
  if (!pairs.length) return 0;
  await db
    .insert(coOccurrencesTable)
    .values(pairs.map(([a, b]) => ({ personA: a, personB: b, kind, ref, label, at })))
    .onConflictDoNothing();
  let made = 0;
  for (const [a, b] of pairs) {
    try {
      if (await proposeWorksWith(a, b, now)) made++;
    } catch (err) {
      logger.warn({ err, a, b }, "Could not propose a relationship from people seen together");
    }
  }
  return made;
}

/** A "works with" card for two people often together, unless they are linked or were proposed before. */
async function proposeWorksWith(a: number, b: number, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const rows = await db
    .select({ kind: coOccurrencesTable.kind, n: count(), label: sql<string | null>`max(${coOccurrencesTable.label})` })
    .from(coOccurrencesTable)
    .where(and(eq(coOccurrencesTable.personA, a), eq(coOccurrencesTable.personB, b), gte(coOccurrencesTable.at, since)))
    .groupBy(coOccurrencesTable.kind);
  const emails = Number(rows.find((r) => r.kind === "email")?.n ?? 0);
  const meetings = Number(rows.find((r) => r.kind === "meeting")?.n ?? 0);
  if (emails < EMAIL_THREADS && meetings < MEETINGS) return false;

  // Already linked either way, or a card for this pair was made before (whatever Ollie did with it).
  const [linked] = await db
    .select({ n: count() })
    .from(linksTable)
    .where(
      or(
        and(eq(linksTable.fromType, "person"), eq(linksTable.fromId, a), eq(linksTable.toType, "person"), eq(linksTable.toId, b)),
        and(eq(linksTable.fromType, "person"), eq(linksTable.fromId, b), eq(linksTable.toType, "person"), eq(linksTable.toId, a)),
      ),
    );
  if (Number(linked?.n ?? 0) > 0) return false;
  const [before] = await db
    .select({ n: count() })
    .from(suggestionsTable)
    .where(
      and(
        eq(suggestionsTable.kind, "relationship"),
        eq(suggestionsTable.entityType, "person"),
        or(
          and(eq(suggestionsTable.entityId, a), sql`(${suggestionsTable.payload}->>'to_id')::int = ${b}`),
          and(eq(suggestionsTable.entityId, b), sql`(${suggestionsTable.payload}->>'to_id')::int = ${a}`),
        ),
      ),
    );
  if (Number(before?.n ?? 0) > 0) return false;

  const example = rows.find((r) => r.label)?.label;
  const evidence = [
    emails ? `On ${emails} email thread${emails === 1 ? "" : "s"} together` : null,
    meetings ? `in ${meetings} meeting${meetings === 1 ? "" : "s"} together` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const meta: ProposeMeta = { proposedBy: SIGNALS_PROPOSER, clientId: null, sourceType: emails >= EMAIL_THREADS ? "email" : "meeting", sourceLabel: "Who is on email threads and in meetings together" };
  const r = await propose(meta, {
    kind: "relationship",
    entityType: "person",
    entityId: a,
    payload: { relationship: "works_with", to_type: "person", to_id: b, note: `${evidence} in the last 90 days${example ? `, for example "${example}"` : ""}.` },
  }, now);
  return r.status === "suggested";
}

/**
 * "Works at": a known person with no organisation, writing from the email domain most people at a
 * known outside organisation use. Proposed once as a change of details.
 */
export async function proposeWorksAt(personIds: number[], now = new Date()): Promise<number> {
  const ids = await countable(personIds);
  if (!ids.length) return 0;
  const people = await db
    .select({ id: peopleTable.id, name: peopleTable.name, email: peopleTable.email, otherEmails: peopleTable.otherEmails })
    .from(peopleTable)
    .where(and(inArray(peopleTable.id, ids), isNull(peopleTable.organisationId)));
  if (!people.length) return 0;
  const domains = await organisationDomains();
  let made = 0;
  for (const p of people) {
    const domain = emailsOf(p).map((e) => e.split("@")[1]).find((d) => d && domains.has(d));
    const org = domain ? domains.get(domain) : undefined;
    if (!org) continue;
    const r = await propose(
      { proposedBy: SIGNALS_PROPOSER, clientId: null, sourceType: "email", sourceLabel: `Writes from @${domain}, like others at ${org.name}` },
      { kind: "summary_change", entityType: "person", entityId: p.id, payload: { fields: { organisation: org.name }, before: { organisation: null }, organisation_id: org.id, reason: `Writes from @${domain}, the address others at ${org.name} use.` } },
      now,
    );
    if (r.status === "suggested") made++;
  }
  return made;
}

/** The email domain used by two or more people at each outside organisation AI may see. */
export async function organisationDomains(): Promise<Map<string, { id: number; name: string }>> {
  const rows = await db
    .select({ orgId: organisationsTable.id, name: organisationsTable.name, email: peopleTable.email, otherEmails: peopleTable.otherEmails })
    .from(peopleTable)
    .innerJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(and(eq(organisationsTable.internal, false), eq(organisationsTable.confidential, false), eq(organisationsTable.aiAccess, true), isNotNull(peopleTable.organisationId)));
  const tally = new Map<string, Map<number, { name: string; n: number }>>();
  for (const r of rows) {
    for (const e of emailsOf(r)) {
      const d = e.split("@")[1];
      if (!d || FREE_MAIL.has(d)) continue;
      const m = tally.get(d) ?? new Map();
      const cur = m.get(r.orgId) ?? { name: r.name, n: 0 };
      cur.n++;
      m.set(r.orgId, cur);
      tally.set(d, m);
    }
  }
  const out = new Map<string, { id: number; name: string }>();
  for (const [d, m] of tally) {
    const best = [...m.entries()].sort((x, y) => y[1].n - x[1].n)[0];
    if (best && best[1].n >= 2 && m.size === 1) out.set(d, { id: best[0], name: best[1].name });
  }
  return out;
}

export const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

/**
 * Details from an email signature for a known person: job title and company as attributed facts
 * (so a change becomes a conflict review), a phone number as a plain fact. Only when OllieOS does
 * not already hold the same value.
 */
export async function proposeSignature(
  person: { id: number; name: string },
  sig: { title: string; company: string; phone: string },
  source: { ref: string; url: string | null; label: string; at: Date },
  now = new Date(),
): Promise<number> {
  const [ok] = await countable([person.id]);
  if (ok == null) return 0;
  const [row] = await db
    .select({ role: peopleTable.role, org: organisationsTable.name })
    .from(peopleTable)
    .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(eq(peopleTable.id, person.id));
  const facts = await db
    .select({ text: factsTable.text, attribute: factsTable.attribute })
    .from(factsTable)
    .where(and(eq(factsTable.entityType, "person"), eq(factsTable.entityId, person.id), isNull(factsTable.supersededBy)));
  const held = (v: string) => {
    const x = v.toLowerCase();
    return [row?.role, row?.org, ...facts.map((f) => f.text)].some((h) => !!h && h.toLowerCase().includes(x));
  };
  const meta: ProposeMeta = { proposedBy: "Gmail check", clientId: null, sourceType: "email", sourceRef: source.ref, sourceUrl: source.url, sourceLabel: source.label, saidBy: { personId: person.id, at: source.at } };
  let made = 0;
  const cards: { text: string; attribute: "job_title" | "organisation" | null }[] = [];
  if (sig.title && !held(sig.title)) cards.push({ text: `${person.name} is ${sig.title}`, attribute: "job_title" });
  if (sig.company && !held(sig.company)) cards.push({ text: `${person.name} works at ${sig.company}`, attribute: "organisation" });
  const phone = sig.phone.replace(/[^\d+()\s-]/g, "").trim();
  if (phone.replace(/\D/g, "").length >= 7 && !held(phone)) cards.push({ text: `${person.name}'s phone number is ${phone}`, attribute: null });
  for (const [n, c] of cards.entries()) {
    try {
      const r = await propose({ ...meta, sourceRef: `${source.ref}#sig${n + 1}` }, { kind: "fact", entityType: "person", entityId: person.id, payload: { text: c.text, attribute: c.attribute, source: source.label } }, now);
      if (r.status === "suggested" || r.status === "conflict") made++;
    } catch (err) {
      logger.warn({ err, person: person.id }, "Could not propose a detail from a signature");
    }
  }
  return made;
}

/* ---------- One-off look back over 6 months of email headers ---------- */

const LOOK_BACK_KEY = "relationship_look_back";
/** Most threads read in one look back */
export const LOOK_BACK_THREADS = 600;

export interface RelationshipLookBack {
  status: "idle" | "running" | "done" | "failed";
  total: number;
  done: number;
  /** Cards proposed */
  proposed: number;
  error: string | null;
  finishedAt: string | null;
}

const IDLE: RelationshipLookBack = { status: "idle", total: 0, done: 0, proposed: 0, error: null, finishedAt: null };

export async function getRelationshipLookBack(): Promise<RelationshipLookBack> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, LOOK_BACK_KEY));
  return { ...IDLE, ...((row?.value as Partial<RelationshipLookBack> | undefined) ?? {}) };
}

async function saveLookBack(v: RelationshipLookBack) {
  await db.insert(appSettingsTable).values({ key: LOOK_BACK_KEY, value: v }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value: v, updatedAt: new Date() } });
}

let lookingBack: Promise<void> | null = null;

/**
 * Starts the look back in the background: the last 6 months of email threads, headers only (who is
 * on each, and the subject), no AI. Known people on the same thread are counted together, as each
 * Gmail check does from now on.
 */
export async function startRelationshipLookBack(): Promise<RelationshipLookBack> {
  if (lookingBack) return getRelationshipLookBack();
  const start: RelationshipLookBack = { ...IDLE, status: "running" };
  await saveLookBack(start);
  lookingBack = runLookBack(start)
    .catch(async (err) => {
      logger.warn({ err }, "Relationship look back failed");
      await saveLookBack({ ...(await getRelationshipLookBack()), status: "failed", error: err instanceof Error ? err.message : "The look back stopped", finishedAt: new Date().toISOString() });
    })
    .finally(() => {
      lookingBack = null;
    });
  return start;
}

/** For tests: waits for a look back to finish. */
export async function relationshipLookBackIdle(): Promise<void> {
  if (lookingBack) await lookingBack;
}

async function runLookBack(state: RelationshipLookBack): Promise<void> {
  const { proxyJson } = await import("./connectors/http");
  const { threadMeta } = await import("./connectors/noReply");
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 6 && ids.length < LOOK_BACK_THREADS; page++) {
    const p = new URLSearchParams({ q: "newer_than:180d -in:chats -category:promotions -category:social", maxResults: "100" });
    if (pageToken) p.set("pageToken", pageToken);
    const body = await proxyJson("google-mail", "Gmail", "/gmail/v1/users/me/threads?" + p.toString());
    ids.push(...((body.threads as { id: string }[] | undefined) ?? []).map((t) => t.id));
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  state.total = Math.min(ids.length, LOOK_BACK_THREADS);
  await saveLookBack(state);
  for (const id of ids.slice(0, LOOK_BACK_THREADS)) {
    const metas = await threadMeta(id).catch(() => null);
    state.done++;
    const msgs = (metas ?? []).filter((m) => !m.bulk && !m.auto);
    if (msgs.length) {
      const emails = [...new Set(msgs.flatMap((m) => [m.from, ...m.to, ...m.cc]).map((a) => a.email?.toLowerCase()).filter((e): e is string => !!e))];
      const people = emails.length ? await db.select({ id: peopleTable.id }).from(peopleTable).where(hasAnyEmail(emails)) : [];
      if (people.length > 1) {
        state.proposed += await recordTogether("email", id, msgs.find((m) => m.subject)?.subject ?? null, msgs[msgs.length - 1].at, people.map((p) => p.id));
      }
    }
    // Section 25: people in the thread who are not in Contacts, for the contact finder.
    if (msgs.length) {
      try {
        const { recordSightings, sightingsFromThread } = await import("./contactFinder");
        await recordSightings(await sightingsFromThread(id, msgs));
      } catch (err) {
        logger.warn({ err, thread: id }, "Could not record contact sightings from the look back");
      }
    }
    if (state.done % 20 === 0) await saveLookBack(state);
  }
  await saveLookBack({ ...state, status: "done", finishedAt: new Date().toISOString() });
}
