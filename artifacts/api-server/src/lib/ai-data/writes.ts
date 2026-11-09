import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  db,
  decisionsTable,
  factsTable,
  linksTable,
  notesTable,
  organisationsTable,
  peopleTable,
  projectsTable,
} from "@workspace/db";
import { isIsoDate, londonRange, parseRef, todayLondon, toRef } from "@workspace/shared";
import { writeAudit } from "../audit";
import { cleanText, touch, uniqueSlug } from "../../services/knowledge/common";
import { AiError, invalid, notFound, type Writer } from "./errors";
import { findEntities, resolveLoose, resolvePick, type EntityPick, type Found } from "./resolve";
import { loadVisibleTask } from "./tasks";
import type { AiScope } from "./scope";
import { decisionVisible, factVisible, noteVisible, type Grants } from "./visibility";

const SAVED_HIDDEN = "Saved. It is confidential, so OllieOS will not show it back.";

function need(text: string | undefined | null, what: string): string {
  const t = cleanText(text);
  if (!t) throw invalid(`${what} is required.`);
  return t;
}

/* ---------- Facts ---------- */

export async function addFact(scope: AiScope, who: Writer, input: { entity: EntityPick; text: string; source?: string; supersedes?: string }) {
  const target = await resolvePick(scope.grants, input.entity);
  const text = need(input.text, "Fact text");
  let supersedesId: number | null = null;
  if (input.supersedes) {
    const r = parseRef(input.supersedes);
    if (!r || r.type !== "fact") throw invalid(`"${input.supersedes}" is not a fact ref.`);
    const [old] = await db
      .select({ id: factsTable.id, type: factsTable.entityType, eid: factsTable.entityId })
      .from(factsTable)
      .where(and(eq(factsTable.id, r.id), sql.raw(factVisible("facts", scope.grants))));
    if (!old) throw notFound("That fact");
    if (old.type !== target.type || old.eid !== target.id) throw invalid("A fact can only replace a fact on the same item.");
    supersedesId = old.id;
  }
  const fact = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(factsTable)
      .values({ entityType: target.type, entityId: target.id, text, source: cleanText(input.source), createdBy: who.actor })
      .returning();
    if (supersedesId) await tx.update(factsTable).set({ supersededBy: row.id }).where(eq(factsTable.id, supersedesId));
    await touch(tx, target.type, target.id);
    await writeAudit(tx, {
      actor: who.actor,
      clientId: who.clientId,
      action: "create",
      entityType: "fact",
      entityId: row.id,
      payload: { entity: toRef(target.type, target.id), supersedes: supersedesId },
    });
    return row;
  });
  return {
    fact: { ref: toRef("fact", fact.id), text: fact.text, source: fact.source, created_at: fact.createdAt.toISOString() },
    ...(supersedesId ? { superseded: toRef("fact", supersedesId) } : {}),
  };
}

/* ---------- Decisions ---------- */

export async function logDecision(
  scope: AiScope,
  who: Writer,
  input: { project: EntityPick; text: string; decided_at?: string; decided_by?: string; source?: string; confidential?: boolean },
) {
  const project = await resolvePick(scope.grants, input.project, ["project"]);
  const text = need(input.text, "Decision text");
  const decidedAt = input.decided_at ?? todayLondon();
  if (!isIsoDate(decidedAt)) throw invalid("decided_at must be a date like 2026-11-09.");
  const row = await db.transaction(async (tx) => {
    const [d] = await tx
      .insert(decisionsTable)
      .values({
        projectId: project.id,
        text,
        decidedAt,
        decidedBy: cleanText(input.decided_by),
        source: cleanText(input.source),
        confidential: input.confidential ?? null,
        createdBy: who.actor,
      })
      .returning();
    await touch(tx, "project", project.id);
    await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "create", entityType: "decision", entityId: d.id, payload: { project: toRef("project", project.id) } });
    return d;
  });
  const [visible] = await db.select({ id: decisionsTable.id }).from(decisionsTable).where(and(eq(decisionsTable.id, row.id), sql.raw(decisionVisible("decisions", scope.grants))));
  if (!visible) return { decision: null, message: SAVED_HIDDEN };
  return {
    decision: {
      ref: toRef("decision", row.id),
      text: row.text,
      decided_at: row.decidedAt,
      decided_by: row.decidedBy,
      source: row.source,
      project: { ref: toRef("project", project.id), name: project.name },
    },
  };
}

/* ---------- Notes ---------- */

async function noteTarget(g: Grants, scope: AiScope, pick: EntityPick): Promise<{ type: "project" | "person" | "organisation" | "task" | "decision"; id: number }> {
  const ref = pick.ref ? parseRef(pick.ref) : null;
  if (ref?.type === "task") return { type: "task", id: (await loadVisibleTask(scope, pick.ref!)).id };
  if (ref?.type === "decision") {
    const [d] = await db.select({ id: decisionsTable.id }).from(decisionsTable).where(and(eq(decisionsTable.id, ref.id), sql.raw(decisionVisible("decisions", g))));
    if (!d) throw notFound("That decision");
    return { type: "decision", id: d.id };
  }
  const found = await resolvePick(g, pick);
  return { type: found.type, id: found.id };
}

export async function addNote(scope: AiScope, who: Writer, input: { entity: EntityPick; title?: string; body: string; confidential?: boolean }) {
  const target = await noteTarget(scope.grants, scope, input.entity);
  const body = need(input.body, "Note body");
  const row = await db.transaction(async (tx) => {
    const [n] = await tx
      .insert(notesTable)
      .values({ entityType: target.type, entityId: target.id, title: cleanText(input.title), body, confidential: input.confidential ?? null, createdBy: who.actor })
      .returning();
    await touch(tx, target.type, target.id);
    await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "create", entityType: "note", entityId: n.id, payload: { entity: toRef(target.type, target.id) } });
    return n;
  });
  const [visible] = await db.select({ id: notesTable.id }).from(notesTable).where(and(eq(notesTable.id, row.id), sql.raw(noteVisible("notes", scope.grants))));
  if (!visible) return { note: null, message: SAVED_HIDDEN };
  return { note: { ref: toRef("note", row.id), title: row.title, body: row.body, entity: toRef(target.type, target.id), created_at: row.createdAt.toISOString() } };
}

/* ---------- Activity ---------- */

export interface ActivityInput {
  kind: "email" | "meeting" | "slack" | "note" | "task";
  summary: string;
  occurred_at: string;
  source_url?: string | null;
  source_ref?: string | null;
  people?: string[];
  projects?: string[];
}

export interface ActivityResult {
  activity: { ref: string } | null;
  duplicate: boolean;
  linked: { people: string[]; projects: string[] };
  unmatched: string[];
}

/**
 * Logs one touchpoint (PRD 9). MCP callers match only visible people and projects; ingest
 * matches everything, so a hint naming a hidden project makes the activity inherit hidden.
 * Hidden matches are never echoed back in `linked`.
 */
export async function logActivity(
  who: Writer,
  input: ActivityInput,
  opts: { grants: Grants; visibleOnly: boolean },
): Promise<ActivityResult> {
  const summary = need(input.summary, "Summary");
  const occurredAt = new Date(input.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) throw invalid("occurred_at must be an ISO date-time.");
  const sourceRef = cleanText(input.source_ref);
  if (sourceRef) {
    const [dupe] = await db.select({ id: activityTable.id }).from(activityTable).where(eq(activityTable.sourceRef, sourceRef));
    if (dupe) return { activity: null, duplicate: true, linked: { people: [], projects: [] }, unmatched: [] };
  }

  const unmatched: string[] = [];
  const people: Found[] = [];
  const projects: Found[] = [];
  for (const name of input.people ?? []) {
    const f = await resolveLoose(name, ["person"], opts.grants, opts.visibleOnly);
    if (f) people.push(f);
    else unmatched.push(name);
  }
  for (const name of input.projects ?? []) {
    const f = await resolveLoose(name, ["project"], opts.grants, opts.visibleOnly);
    if (f) projects.push(f);
    else unmatched.push(name);
  }
  const uniq = (xs: Found[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  const ps = uniq(people);
  const pr = uniq(projects);

  // The primary entity decides visibility, so a hidden project wins; otherwise prefer a visible person.
  const primary = pr.find((p) => !p.visible) ?? ps.find((p) => p.visible) ?? pr[0] ?? ps[0] ?? null;

  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(activityTable)
      .values({
        kind: input.kind,
        summary,
        occurredAt,
        sourceUrl: cleanText(input.source_url),
        sourceRef,
        entityType: primary?.type ?? null,
        entityId: primary?.id ?? null,
        createdBy: who.actor,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) return null;
    const a = inserted[0];
    const others = [...ps, ...pr].filter((x) => !(primary && x.type === primary.type && x.id === primary.id));
    if (others.length) {
      await tx
        .insert(linksTable)
        .values(others.map((o) => ({ fromType: "activity" as const, fromId: a.id, toType: o.type, toId: o.id, createdBy: who.actor })))
        .onConflictDoNothing();
    }
    if (ps.length) {
      await tx
        .update(peopleTable)
        .set({ lastContactAt: sql`greatest(coalesce(${peopleTable.lastContactAt}, ${occurredAt.toISOString()}::timestamptz), ${occurredAt.toISOString()}::timestamptz)` })
        .where(inArray(peopleTable.id, ps.map((p) => p.id)));
    }
    await writeAudit(tx, {
      actor: who.actor,
      clientId: who.clientId,
      action: "create",
      entityType: "activity",
      entityId: a.id,
      payload: { sourceRef, people: ps.map((p) => p.id), projects: pr.map((p) => p.id) },
    });
    return a;
  });
  if (!row) return { activity: null, duplicate: true, linked: { people: [], projects: [] }, unmatched: [] };

  const hidden = primary && !primary.visible;
  return {
    activity: hidden ? null : { ref: toRef("activity", row.id) },
    duplicate: false,
    linked: {
      people: hidden ? [] : ps.filter((p) => p.visible).map((p) => toRef("person", p.id)),
      projects: hidden ? [] : pr.filter((p) => p.visible).map((p) => toRef("project", p.id)),
    },
    unmatched,
  };
}

/* ---------- People and projects ---------- */

const forbiddenHidden = () =>
  new AiError("forbidden", "OllieOS cannot change that item from here. Use request_access if you need it, or ask Ollie.");

/** Finds the row an upsert should change. Matching a hidden row is refused without writing anything. */
async function upsertMatch(kind: "person" | "project", g: Grants, keys: { slug?: string; email?: string; name: string }): Promise<Found | null> {
  const steps: string[] = [];
  if (keys.slug?.trim()) steps.push(keys.slug.trim());
  if (kind === "person" && keys.email?.trim()) steps.push(keys.email.trim());
  steps.push(keys.name.trim());
  for (const text of steps) {
    const rows = await findEntities(text, [kind], g);
    if (!rows.length) continue;
    if (rows.some((r) => !r.visible)) throw forbiddenHidden();
    if (rows.length > 1) throw invalid(`More than one ${kind} matches "${text}". Pass a slug.`);
    return rows[0];
  }
  return null;
}

export async function upsertPerson(
  scope: AiScope,
  who: Writer,
  input: { name: string; slug?: string; email?: string; organisation?: string; role?: string; relationship_summary?: string },
) {
  const name = need(input.name, "Name");
  const g = scope.grants;
  const match = await upsertMatch("person", g, { slug: input.slug, email: input.email, name });
  const email = cleanText(input.email)?.toLowerCase() ?? null;
  if (email) {
    const [clash] = await db.select({ id: peopleTable.id }).from(peopleTable).where(sql`lower(${peopleTable.email}) = ${email}`);
    if (clash && clash.id !== match?.id) throw invalid("That email already belongs to another person.");
  }

  let orgId: number | null | undefined = undefined;
  const orgName = cleanText(input.organisation);
  if (orgName) {
    const orgs = await findEntities(orgName, ["organisation"], g);
    if (orgs.some((o) => !o.visible)) orgId = undefined;
    else if (orgs.length === 1) orgId = orgs[0].id;
    else if (orgs.length === 0) orgId = null;
    else throw invalid(`More than one organisation matches "${orgName}".`);
  }

  return db.transaction(async (tx) => {
    if (orgName && orgId === null) {
      const [org] = await tx.insert(organisationsTable).values({ name: orgName, slug: await uniqueSlug(tx, "organisation", orgName) }).returning();
      await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "create", entityType: "organisation", entityId: org.id });
      orgId = org.id;
    }
    const fields = {
      ...(email ? { email } : {}),
      ...(cleanText(input.role) ? { role: cleanText(input.role) } : {}),
      ...(cleanText(input.relationship_summary) ? { relationshipSummary: cleanText(input.relationship_summary) } : {}),
      ...(orgId ? { organisationId: orgId } : {}),
    };
    if (match) {
      const set = { ...fields, ...(name !== match.name ? { name } : {}), updatedAt: new Date() };
      const [row] = await tx.update(peopleTable).set(set).where(eq(peopleTable.id, match.id)).returning();
      await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "update", entityType: "person", entityId: row.id, payload: { fields: Object.keys(set) } });
      return { person: { ref: toRef("person", row.id), name: row.name, slug: row.slug }, created: false };
    }
    const slug = await uniqueSlug(tx, "person", cleanText(input.slug) ?? name);
    const [row] = await tx.insert(peopleTable).values({ name, slug, ...fields }).returning();
    await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "create", entityType: "person", entityId: row.id });
    return { person: { ref: toRef("person", row.id), name: row.name, slug: row.slug }, created: true };
  });
}

export async function upsertProject(scope: AiScope, who: Writer, input: { name: string; slug?: string; area?: string; status?: string; summary?: string }) {
  const name = need(input.name, "Name");
  const match = await upsertMatch("project", scope.grants, { slug: input.slug, name });
  const fields = {
    ...(cleanText(input.area) ? { area: cleanText(input.area) } : {}),
    ...(cleanText(input.status) ? { status: cleanText(input.status) } : {}),
    ...(cleanText(input.summary) ? { summary: cleanText(input.summary) } : {}),
  };
  return db.transaction(async (tx) => {
    if (match) {
      const set = { ...fields, ...(name !== match.name ? { name } : {}), updatedAt: new Date() };
      const [row] = await tx.update(projectsTable).set(set).where(eq(projectsTable.id, match.id)).returning();
      await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "update", entityType: "project", entityId: row.id, payload: { fields: Object.keys(set) } });
      return { project: { ref: toRef("project", row.id), name: row.name, slug: row.slug }, created: false };
    }
    const slug = await uniqueSlug(tx, "project", cleanText(input.slug) ?? name);
    const [row] = await tx.insert(projectsTable).values({ name, slug, ...fields }).returning();
    await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "create", entityType: "project", entityId: row.id });
    return { project: { ref: toRef("project", row.id), name: row.name, slug: row.slug }, created: true };
  });
}

/* ---------- Calendar ---------- */

export interface CalendarEventInput {
  source_ref: string;
  title: string;
  starts_at: string;
  ends_at: string;
  attendees?: string[];
  personal?: boolean;
  people?: string[];
  project?: string;
  location?: string;
}

/**
 * Replaces every event in [today 00:00, today + 8 days) London with the given ones.
 * Events starting outside that window are skipped.
 */
export async function replaceCalendar(
  who: Writer,
  events: CalendarEventInput[],
  opts: { grants: Grants; visibleOnly: boolean },
): Promise<{ replaced: number; skipped: number; unmatched_people: string[] }> {
  const window = londonRange(todayLondon(), 8);
  const unmatched = new Set<string>();
  const rows: (typeof calendarEventsTable.$inferInsert)[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const e of events) {
    const ref = cleanText(e.source_ref);
    const title = cleanText(e.title);
    const startsAt = new Date(e.starts_at);
    const endsAt = new Date(e.ends_at);
    if (!ref || !title || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw invalid("Each event needs source_ref, title, starts_at and ends_at.");
    if (startsAt < window.start || startsAt >= window.end || seen.has(ref)) {
      skipped++;
      continue;
    }
    seen.add(ref);
    const personIds: number[] = [];
    for (const n of e.people ?? []) {
      const f = await resolveLoose(n, ["person"], opts.grants, opts.visibleOnly);
      if (f) personIds.push(f.id);
      else unmatched.add(n);
    }
    let projectId: number | null = null;
    if (e.project) {
      const f = await resolveLoose(e.project, ["project"], opts.grants, opts.visibleOnly);
      if (f) projectId = f.id;
    }
    rows.push({
      sourceRef: ref,
      title,
      startsAt,
      endsAt,
      attendees: (e.attendees ?? []).map((a) => a.trim()).filter(Boolean),
      personal: !!e.personal,
      personIds: [...new Set(personIds)],
      projectId,
      location: cleanText(e.location),
    });
  }
  await db.transaction(async (tx) => {
    await tx.delete(calendarEventsTable).where(and(gte(calendarEventsTable.startsAt, window.start), lt(calendarEventsTable.startsAt, window.end)));
    if (rows.length) {
      await tx
        .insert(calendarEventsTable)
        .values(rows)
        .onConflictDoUpdate({
          target: calendarEventsTable.sourceRef,
          set: {
            title: sql`excluded.title`,
            startsAt: sql`excluded.starts_at`,
            endsAt: sql`excluded.ends_at`,
            attendees: sql`excluded.attendees`,
            personal: sql`excluded.personal`,
            personIds: sql`excluded.person_ids`,
            projectId: sql`excluded.project_id`,
            location: sql`excluded.location`,
            updatedAt: new Date(),
          },
        });
    }
    await writeAudit(tx, { actor: who.actor, clientId: who.clientId, action: "replace_calendar", payload: { events: rows.length, skipped } });
  });
  return { replaced: rows.length, skipped, unmatched_people: [...unmatched] };
}
