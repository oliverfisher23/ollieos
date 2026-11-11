/**
 * Turns sorted email and Slack exchanges into Inbox items and Activity entries.
 *
 * Messages that match one of Ollie's noise rules are dropped before the AI sees them. Every item
 * goes through captureTask, so the usual duplicate check (by source_ref) and noise rules apply,
 * and items land in the Inbox for Ollie to triage. Activity is only logged for exchanges with
 * someone in People, or about a project, so the log does not fill up with strangers.
 *
 * Part N: the same read also picks out firm decisions and facts about items OllieOS knows. They go
 * to the Knowledge Inbox as cards that say who said them, never straight into knowledge. Exchanges
 * with anyone hidden from AI are not read for knowledge.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, organisationsTable, peopleTable, productsTable, projectsTable, type NoiseRule } from "@workspace/db";
import { londonDate } from "@workspace/shared";
import { logger } from "../../lib/logger";
import { captureTask, enabledRules, logActivity, matchNoiseRule, type CaptureWriter } from "../aiWrites";
import { emailsOf, hasAnyEmail, hasAnySlackId } from "../personMatch";
import { propose, type Proposal } from "../suggestions";
import type { WorkMessage, WorkUnit } from "./messages";
import { sortUnits, type KnownNames, type SortedClaim, type SortedUnit } from "./sorter";

export const CONNECTOR_WRITER: CaptureWriter = { actor: "ollieos", clientId: null };

export interface CaptureCounts {
  inbox: number;
  promises: number;
  waiting: number;
  noise: number;
  duplicate: number;
  noise_rule: number;
  activity: number;
  /** Part N: decision and fact cards proposed to the Knowledge Inbox */
  knowledge?: number;
}

/** True when one of Ollie's noise rules covers every message in the exchange from someone else. */
export function ruledOut(rules: NoiseRule[], u: WorkUnit): boolean {
  const theirs = u.messages.filter((m) => !m.fromMe);
  if (!theirs.length) return false;
  return theirs.every(
    (m) =>
      !!matchNoiseRule(rules, {
        title: u.subject ?? "",
        source: u.source,
        fromAddress: m.fromAddress,
        sourceSubject: u.subject,
        sourceChannel: u.channel,
      }),
  );
}

export type PersonRow = {
  id: number;
  name: string;
  email: string | null;
  otherEmails: string[];
  slackUserId: string | null;
  confidential: boolean;
  aiAccess: boolean;
  isSelf: boolean;
};

export interface LoadedPeople {
  byEmail: Map<string, PersonRow>;
  byName: Map<string, PersonRow>;
  bySlack: Map<string, PersonRow>;
}

/** The person for someone in an exchange: by Slack account first, then any of their emails. */
export function personIn(people: LoadedPeople, who: { email?: string | null; slackId?: string | null }): PersonRow | null {
  return (who.slackId ? people.bySlack.get(who.slackId) : undefined) ?? (who.email ? people.byEmail.get(who.email.toLowerCase()) : undefined) ?? null;
}

export const senderOf = (people: LoadedPeople, m: WorkMessage): PersonRow | null => personIn(people, { email: m.fromAddress, slackId: m.fromSlackId });

export async function loadPeople(units: WorkUnit[], sorted: SortedUnit[]): Promise<LoadedPeople> {
  const emails = new Set<string>();
  const names = new Set<string>();
  const slackIds = new Set<string>();
  for (const u of units) {
    for (const p of u.people) {
      if (p.email) emails.add(p.email.toLowerCase());
      if (p.name) names.add(p.name.toLowerCase());
      if (p.slackId) slackIds.add(p.slackId);
    }
    for (const m of u.messages) {
      if (m.fromAddress) emails.add(m.fromAddress.toLowerCase());
      if (m.fromSlackId) slackIds.add(m.fromSlackId);
    }
  }
  for (const s of sorted) for (const it of s.items) if (it.person) (it.person.includes("@") ? emails : names).add(it.person.toLowerCase().trim());
  const cols = {
    id: peopleTable.id,
    name: peopleTable.name,
    email: peopleTable.email,
    otherEmails: peopleTable.otherEmails,
    slackUserId: peopleTable.slackUserId,
    confidential: peopleTable.confidential,
    aiAccess: peopleTable.aiAccess,
    isSelf: peopleTable.isSelf,
  };
  const none: PersonRow[] = [];
  const [a, b] = await Promise.all([
    emails.size || slackIds.size ? db.select(cols).from(peopleTable).where(or(hasAnyEmail([...emails]), hasAnySlackId([...slackIds]))) : none,
    names.size ? db.select(cols).from(peopleTable).where(inArray(sql`lower(${peopleTable.name})`, [...names])) : none,
  ]);
  const byEmail = new Map<string, PersonRow>();
  const bySlack = new Map<string, PersonRow>();
  for (const p of a) {
    for (const e of emailsOf(p)) if (!byEmail.has(e)) byEmail.set(e, p);
    if (p.slackUserId) bySlack.set(p.slackUserId, p);
  }
  return { byEmail, bySlack, byName: new Map(b.map((p) => [p.name.toLowerCase(), p])) };
}

/** Active projects the AI may link items to. Confidential projects are never sent to it. */
export async function projectChoices(): Promise<{ id: number; name: string }[]> {
  const rows = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(and(eq(projectsTable.confidential, false), eq(projectsTable.archived, false), eq(projectsTable.lifecycle, "active")))
    .limit(150);
  return rows;
}

export const emptyCounts = (): CaptureCounts => ({ inbox: 0, promises: 0, waiting: 0, noise: 0, duplicate: 0, noise_rule: 0, activity: 0 });

const hidden = (p: { confidential: boolean; aiAccess: boolean }) => p.confidential || !p.aiAccess;

/** False when anyone in the exchange is in People and hidden from AI: such exchanges are never read for knowledge. */
export function mayReadForKnowledge(u: WorkUnit, people: LoadedPeople): boolean {
  for (const p of u.people) {
    const row = personIn(people, p) ?? (p.name ? people.byName.get(p.name.toLowerCase()) : undefined);
    if (row && hidden(row)) return false;
  }
  for (const m of u.messages) {
    const row = senderOf(people, m);
    if (row && hidden(row)) return false;
  }
  return true;
}

type Known = KnownNames & { ids: Record<"project" | "person" | "organisation" | "product", Map<string, number>> };

/** Items knowledge may be about: AI-visible projects, organisations and products, and the AI-visible people in these exchanges. */
export async function knownNames(people: LoadedPeople): Promise<Known> {
  const [projects, orgs, products] = await Promise.all([
    db
      .select({ id: projectsTable.id, name: projectsTable.name })
      .from(projectsTable)
      .where(and(eq(projectsTable.confidential, false), eq(projectsTable.aiAccess, true), eq(projectsTable.archived, false)))
      .limit(150),
    db
      .select({ id: organisationsTable.id, name: organisationsTable.name })
      .from(organisationsTable)
      .where(and(eq(organisationsTable.confidential, false), eq(organisationsTable.aiAccess, true)))
      .limit(150),
    db
      .select({ id: productsTable.id, name: productsTable.name })
      .from(productsTable)
      .where(and(eq(productsTable.confidential, false), eq(productsTable.aiAccess, true)))
      .limit(100),
  ]);
  const ppl = new Map<number, PersonRow>();
  for (const m of [people.byEmail, people.bySlack, people.byName]) for (const p of m.values()) if (!hidden(p)) ppl.set(p.id, p);
  const [self] = await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.isSelf, true));
  const ids = {
    project: new Map(projects.map((p) => [p.name.toLowerCase(), p.id])),
    organisation: new Map(orgs.map((o) => [o.name.toLowerCase(), o.id])),
    product: new Map(products.map((p) => [p.name.toLowerCase(), p.id])),
    person: new Map([...ppl.values()].map((p) => [p.name.toLowerCase(), p.id])),
  };
  if (self) ids.person.set(self.name.toLowerCase(), self.id);
  return {
    projects: projects.map((p) => p.name),
    organisations: orgs.map((o) => o.name),
    products: products.map((p) => p.name),
    people: [...new Set([...[...ppl.values()].map((p) => p.name), ...(self ? [self.name] : [])])],
    ids,
  };
}

const PROPOSER: Record<WorkUnit["source"], string> = { email: "Gmail check", slack: "Slack check", meeting: "Granola" };

function sourceLabel(u: WorkUnit, m: WorkMessage): string {
  const who = m.fromMe ? "you" : (m.fromName ?? m.fromAddress ?? "someone");
  if (u.source === "slack") return `Slack message from ${who}${u.channel ? ` in ${u.channel}` : ""}`;
  return `Email from ${who}${u.subject ? `: ${u.subject}` : ""}`;
}

/**
 * Part N: turns the claims found in one exchange into Knowledge Inbox cards, citing the message and
 * saying who wrote it. Facts marked confidential are left out; confidential decisions are hidden from AI.
 */
export async function proposeClaims(u: WorkUnit, claims: SortedClaim[], known: Known, people: LoadedPeople, selfName: string | null): Promise<number> {
  let made = 0;
  for (const [n, c] of claims.entries()) {
    const id = known.ids[c.about_type]?.get(c.about.toLowerCase());
    if (id == null) continue;
    if (c.kind === "fact" && c.confidential) continue;
    const msg = u.messages.find((m) => m.ref === c.ref) ?? u.messages[u.messages.length - 1];
    const sender = msg.fromMe ? null : senderOf(people, msg);
    const saidBy = msg.fromMe
      ? { name: selfName ?? "Ollie", at: msg.at, personId: null, email: null }
      : { name: sender?.name ?? msg.fromName ?? c.said_by ?? null, email: msg.fromAddress, personId: sender?.id ?? null, at: msg.at };
    const decidedAt = londonDate(msg.at);
    const proposal: Proposal =
      c.kind === "fact"
        ? { kind: "fact", entityType: c.about_type, entityId: id, payload: { text: c.text, source: sourceLabel(u, msg) } }
        : {
            kind: "decision",
            entityType: c.about_type === "project" ? "project" : null,
            entityId: c.about_type === "project" ? id : null,
            payload: {
              text: c.text,
              decided_at: decidedAt,
              decided_by: saidBy.name,
              source: sourceLabel(u, msg),
              confidential: c.confidential || null,
              project_hint: c.about_type === "project" ? null : c.about,
            },
          };
    try {
      const r = await propose(
        {
          proposedBy: PROPOSER[u.source],
          clientId: null,
          sourceType: u.source,
          sourceRef: n === 0 ? msg.ref : `${msg.ref}#k${n + 1}`,
          sourceUrl: msg.url,
          sourceLabel: sourceLabel(u, msg),
          saidBy,
        },
        proposal,
      );
      if (r.status === "suggested" || r.status === "conflict") made++;
    } catch (err) {
      logger.warn({ err, ref: msg.ref }, "Could not propose knowledge from a message");
    }
  }
  return made;
}

export async function sortAndCapture(units: WorkUnit[], ctx: { me: string; now: Date }): Promise<CaptureCounts> {
  const counts = emptyCounts();
  const rules = await enabledRules();
  const keep = units.filter((u) => {
    if (!ruledOut(rules, u)) return true;
    counts.noise_rule += u.messages.length;
    return false;
  });
  if (!keep.length) return counts;

  const choices = await projectChoices();
  const before = await loadPeople(keep, []);
  const known = await knownNames(before);
  const readable = keep.map((u) => mayReadForKnowledge(u, before));
  const sorted = await sortUnits(keep, { me: ctx.me, projects: choices.map((p) => p.name), now: ctx.now, known, readKnowledge: (i) => readable[i] });
  await captureSorted(keep, sorted, { choices, rules, applyNoise: true, counts });

  counts.knowledge = 0;
  const [self] = await db.select({ name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.isSelf, true));
  const selfName = self?.name ?? null;
  for (const [i, u] of keep.entries()) {
    const claims = readable[i] ? (sorted[i].knowledge ?? []) : [];
    if (claims.length) counts.knowledge += await proposeClaims(u, claims, known, before, selfName);
  }
  return counts;
}

/**
 * Writes sorted items to the Inbox and logs Activity. Returns the task ids made or matched for each
 * unit, in order, so meeting notes can point at their actions.
 */
export async function captureSorted(
  keep: WorkUnit[],
  sorted: SortedUnit[],
  opts: { choices: { id: number; name: string }[]; rules: NoiseRule[]; applyNoise: boolean; counts: CaptureCounts; projectFor?: (i: number) => number | null },
): Promise<number[][]> {
  const { counts, rules } = opts;
  const projects = new Map(opts.choices.map((p) => [p.name.toLowerCase(), p.id]));
  const people = await loadPeople(keep, sorted);
  const taskIds: number[][] = keep.map(() => []);
  const personFor = (hint: string): PersonRow | null => {
    const h = hint.toLowerCase().trim();
    if (!h) return null;
    return (h.includes("@") ? people.byEmail.get(h) : people.byName.get(h)) ?? null;
  };
  const projectFor = (name: string): number | null => projects.get(name.toLowerCase().trim()) ?? null;

  for (const [i, u] of keep.entries()) {
    const s = sorted[i];
    const linkedProjects = new Set<number>();
    const unitProject = projectFor(s.project) ?? opts.projectFor?.(i) ?? null;
    if (unitProject) linkedProjects.add(unitProject);

    // One message can hold several items; each needs its own ref or the second looks like a duplicate.
    const perMessage = new Map<string, number>();
    for (const it of s.items) {
      const msg = u.messages.find((m) => m.ref === it.ref) ?? u.messages[u.messages.length - 1];
      // Emails Ollie sends that wait on someone are on Email, Waiting for a reply; no task as well.
      if (u.source === "email" && it.type === "waiting" && msg.fromMe) continue;
      const n = (perMessage.get(msg.ref) ?? 0) + 1;
      perMessage.set(msg.ref, n);
      const sourceRef = n === 1 ? msg.ref : `${msg.ref}#${n}`;
      const sender = msg.fromMe ? null : senderOf(people, msg);
      const person = personFor(it.person) ?? (it.type === "task" ? sender : null);
      const projectId = projectFor(it.project) ?? unitProject;
      if (projectId) linkedProjects.add(projectId);
      const r = await captureTask(
        CONNECTOR_WRITER,
        {
          title: it.title,
          kind: it.type === "promise" ? "promise" : "task",
          priority: it.priority,
          dueDate: it.due || null,
          source: u.source,
          sourceRef,
          sourceUrl: msg.url,
          sourceQuote: it.quote || null,
          sourceSubject: u.subject,
          sourceChannel: u.channel,
          snippet: msg.text.slice(0, 280),
          suggestedAction: it.action || null,
          fromName: msg.fromMe ? "You" : msg.fromName,
          fromAddress: msg.fromMe ? null : msg.fromAddress,
          projectId,
          personId: it.type === "waiting" ? null : (person?.id ?? null),
          waitingOnPersonId: it.type === "waiting" ? (person?.id ?? null) : null,
          confidential: it.confidential || person?.confidential ? true : null,
          capturedAt: msg.at,
        },
        { applyNoise: opts.applyNoise, via: "connector", rules },
      );
      if (r.taskId != null) taskIds[i].push(r.taskId);
      if (r.outcome === "duplicate") counts.duplicate++;
      else if (r.outcome === "noise") counts.noise++;
      else if (it.type === "promise") counts.promises++;
      else if (it.type === "waiting") counts.waiting++;
      else counts.inbox++;
    }

    // Activity: only exchanges with someone in People, or about a project.
    const personIds = new Set<number>();
    for (const p of u.people) {
      const row = personIn(people, p);
      if (row) personIds.add(row.id);
    }
    if (s.summary && (personIds.size || linkedProjects.size)) {
      const last = u.messages[u.messages.length - 1];
      const a = await logActivity(
        CONNECTOR_WRITER,
        {
          kind: u.source,
          summary: s.summary,
          occurredAt: last.at,
          sourceUrl: last.url,
          sourceRef: u.key,
          personIds: [...personIds],
          projectIds: [...linkedProjects],
        },
        "connector",
      );
      if (!a.duplicate) counts.activity++;
    }
  }
  return taskIds;
}
