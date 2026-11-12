/**
 * Meeting briefs (feature 03). Written by Ask OllieOS from what AI may read (build plan 47), so a
 * hidden attendee or project is left out unless Ollie opens it up. Built when a sweep finishes for
 * today's and tomorrow's work meetings, and again on open when more than 3 hours old.
 */
import { pulsesFor, type Commercial } from "./clientPulse";
import { openPointsFor, type TalkingPointView } from "./talkingPoints";
import { followUpRef } from "./meetingFollowUp";
import { createHash } from "node:crypto";
import { and, arrayOverlaps, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  db,
  documentsTable,
  factsTable,
  goalsTable,
  meetingBriefsTable,
  organisationsTable,
  peopleTable,
  playbooksTable,
  productsTable,
  rulesTable,
  projectsTable,
  tasksTable,
  type BriefLine,
  type CalendarAttendee,
  type CalendarEvent,
  type MeetingBrief,
  linksTable,
} from "@workspace/db";
import { byEmailMap } from "./personMatch";
import { CADENCE_LABELS, OPEN_STATUSES, SOURCE_LABELS, addDays, formatLong, formatTime, londonRange, parseRef, todayLondon, toRef } from "@workspace/shared";
import { getContext, visibleCalendarRows, wholeWord, type ContextOut } from "../lib/ai-data/context";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { askClient, defaultScope, recordReads, visibleRefs, type AiScope } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { recordCheck } from "./writerChecks";
import { workTypesOf } from "./knowledge/functions";
import type { GrantType } from "../lib/ai-data/visibility";
import { describeRefs, grantDirect } from "./access";
import { askScope } from "./ask/ask";
import { writeBriefFromDocs } from "./ask/model";
import { projectsForPeople, stateFor } from "./cadence";
import { loadScopeContext, scopeOf, type MeetingScope, type ScopeContext } from "./meetingScope";
import { researchViews, type ResearchView } from "./research";
import { ConflictError, NotFoundError } from "./tasks";
import { linkMap } from "./library";
import { resolveEntities } from "./knowledge/common";

export const BRIEF_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Part of the inputs hash: bump when the brief gains a section, so existing briefs are written again. */
const BRIEF_VERSION = 2;
const ACTOR = "Ask OllieOS";
const MAX_PEOPLE = 6;
const MAX_PROJECTS = 4;

/* ---------- Matching an event to what OllieOS knows ---------- */

export interface Matchers {
  people: { id: number; name: string; email: string | null; otherEmails: string[]; organisationId: number | null; isSelf: boolean }[];
  projects: { id: number; name: string; re: RegExp }[];
  orgs: { id: number; name: string; re: RegExp }[];
  selfEmail: string | null;
  scope: ScopeContext;
}

export async function loadMatchers(): Promise<Matchers> {
  const [people, projects, orgs, scope] = await Promise.all([
    db
      .select({ id: peopleTable.id, name: peopleTable.name, email: peopleTable.email, otherEmails: peopleTable.otherEmails, organisationId: peopleTable.organisationId, isSelf: peopleTable.isSelf })
      .from(peopleTable),
    db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.archived, false)),
    db.select({ id: organisationsTable.id, name: organisationsTable.name }).from(organisationsTable),
    loadScopeContext(),
  ]);
  const usable = (n: string) => n.trim().length >= 3;
  return {
    people,
    projects: projects.filter((p) => usable(p.name)).map((p) => ({ ...p, re: wholeWord(p.name) })),
    orgs: orgs.filter((o) => usable(o.name)).map((o) => ({ ...o, re: wholeWord(o.name) })),
    selfEmail: process.env.ALLOWED_EMAIL?.trim().toLowerCase() || null,
    scope,
  };
}

export interface MatchedAttendee extends CalendarAttendee {
  personId: number | null;
}

export interface EventMatch {
  attendees: MatchedAttendee[];
  personIds: number[];
  projectIds: number[];
  orgIds: number[];
  /** External when anyone on it is from outside Ollie's company */
  scope: MeetingScope;
  /** The outside companies on an external meeting: organisation names, else email domains */
  companies: string[];
  /** The email domains of the outside companies, for research */
  domains: string[];
}

/**
 * Who and what an event is about. Attendees match a person by id hint, email or full name.
 * Projects and organisations match the event's project or a whole-word name in the title.
 * Ollie himself is left out.
 */
export function matchEvent(e: CalendarEvent, m: Matchers): EventMatch {
  const details: CalendarAttendee[] = e.attendeeDetails?.length ? e.attendeeDetails : e.attendees.map((name) => ({ name }));
  const byEmail = byEmailMap(m.people);
  const byName = new Map<string, (typeof m.people)[number][]>();
  for (const p of m.people) byName.set(p.name.trim().toLowerCase(), [...(byName.get(p.name.trim().toLowerCase()) ?? []), p]);
  const byId = new Map(m.people.map((p) => [p.id, p]));
  const isSelf = (a: CalendarAttendee, p?: (typeof m.people)[number]) => p?.isSelf || (!!a.email && a.email === m.selfEmail);

  const attendees: MatchedAttendee[] = [];
  const used = new Set<number>();
  for (const a of details) {
    const email = a.email?.toLowerCase() ?? (a.name.includes("@") ? a.name.toLowerCase() : null);
    const named = byName.get(a.name.trim().toLowerCase());
    const hint = e.personIds.map((id) => byId.get(id)).find((p) => p && p.name.trim().toLowerCase() === a.name.trim().toLowerCase());
    const p = (email ? byEmail.get(email) : undefined) ?? hint ?? (named?.length === 1 ? named[0] : undefined);
    if (isSelf({ ...a, email }, p)) continue;
    if (p) used.add(p.id);
    attendees.push({ ...a, ...(email ? { email } : {}), personId: p?.id ?? null });
  }
  // People the sweep linked to the event who are not on the attendee list.
  for (const id of e.personIds) {
    const p = byId.get(id);
    if (!p || p.isSelf || used.has(id)) continue;
    used.add(id);
    attendees.push({ name: p.name, email: p.email, personId: p.id });
  }
  const personIds = [...used];
  const title = e.title.normalize("NFKC");
  const projectIds = [...new Set([...(e.projectId != null ? [e.projectId] : []), ...m.projects.filter((p) => p.re.test(title)).map((p) => p.id)])];
  const orgIds = [
    ...new Set([
      ...m.orgs.filter((o) => o.re.test(title)).map((o) => o.id),
      ...personIds.map((id) => byId.get(id)?.organisationId).filter((x): x is number => x != null),
    ]),
  ];
  return { attendees, personIds, projectIds, orgIds, ...scopeOf(attendees, m.scope) };
}

/** Feature 03 rule 1: not personal, and a known attendee or organisation, or a project, or someone from an outside company. */
export function eligible(e: CalendarEvent, match: EventMatch): boolean {
  return !e.personal && (match.personIds.length > 0 || match.orgIds.length > 0 || match.projectIds.length > 0 || match.companies.length > 0);
}

/** Which of these events get a brief. */
export async function briefableIds(events: CalendarEvent[]): Promise<Set<number>> {
  const work = events.filter((e) => !e.personal);
  if (!work.length) return new Set();
  const m = await loadMatchers();
  return new Set(work.filter((e) => eligible(e, matchEvent(e, m))).map((e) => e.id));
}

/* ---------- Everything a brief shows (Ollie's view: nothing hidden) ---------- */

interface BriefInputs {
  event: CalendarEvent;
  match: EventMatch;
  projectIds: number[];
  goalIds: number[];
  promiseIds: number[];
  documentIds: number[];
  ruleIds: number[];
  /** Products linked to the meeting's projects and organisations, not retired (Part M) */
  productIds: number[];
  /** In use playbooks linked to the meeting's projects and organisations (Part M) */
  playbookIds: number[];
}

async function gatherInputs(event: CalendarEvent, m?: Matchers): Promise<BriefInputs | null> {
  const match = matchEvent(event, m ?? (await loadMatchers()));
  if (!eligible(event, match)) return null;

  // Related projects: the event's own and title matches first, then live projects shared with attendees.
  const shared = await projectsForPeople(match.personIds);
  const projectIds = [...match.projectIds];
  for (const id of match.personIds) {
    for (const p of shared.get(id) ?? []) {
      if (p.lifecycle === "active" && !projectIds.includes(p.id)) projectIds.push(p.id);
    }
  }
  projectIds.splice(MAX_PROJECTS);

  const [products, playbooks] = await Promise.all([linkedProducts(projectIds, match.orgIds), linkedPlaybooks(projectIds, match.orgIds)]);
  const [goals, promises, documents, rules] = await Promise.all([
    projectIds.length
      ? db.select({ goalId: projectsTable.goalId }).from(projectsTable).where(inArray(projectsTable.id, projectIds))
      : [],
    match.personIds.length
      ? db
          .select({ id: tasksTable.id })
          .from(tasksTable)
          .where(and(eq(tasksTable.kind, "promise"), inArray(tasksTable.status, [...OPEN_STATUSES]), inArray(tasksTable.personId, match.personIds)))
          .orderBy(sql`${tasksTable.dueDate} asc nulls last`, asc(tasksTable.createdAt))
      : [],
    projectIds.length
      ? db.execute(sql`
          select d.id from documents d
          where exists (select 1 from links l where
            (l.from_type = 'document' and l.from_id = d.id and l.to_type = 'project' and l.to_id in (${sql.join(projectIds.map((x) => sql`${x}`), sql`, `)}))
            or (l.to_type = 'document' and l.to_id = d.id and l.from_type = 'project' and l.from_id in (${sql.join(projectIds.map((x) => sql`${x}`), sql`, `)})))
          order by d.last_confirmed_at desc limit 6`)
      : null,
    linkedRules(projectIds, match.orgIds, products),
  ]);
  return {
    event,
    match,
    projectIds,
    goalIds: [...new Set(goals.map((g) => g.goalId).filter((x): x is number => x != null))],
    promiseIds: promises.map((p) => p.id),
    documentIds: documents ? (documents.rows as { id: number }[]).map((r) => Number(r.id)) : [],
    ruleIds: rules,
    productIds: products,
    playbookIds: playbooks,
  };
}

const idList = (xs: number[]) => (xs.length ? sql.join(xs.map((x) => sql`${x}`), sql`, `) : sql`null`);

/** Ids of `type` items linked either way to any of the projects or organisations. */
function linkedTo(type: string, alias: string, projectIds: number[], orgIds: number[]) {
  const list = idList;
  return sql`exists (select 1 from links l where
      (l.from_type = ${type} and l.from_id = ${sql.raw(alias)}.id and ((l.to_type = 'project' and l.to_id in (${list(projectIds)})) or (l.to_type = 'organisation' and l.to_id in (${list(orgIds)}))))
      or (l.to_type = ${type} and l.to_id = ${sql.raw(alias)}.id and ((l.from_type = 'project' and l.from_id in (${list(projectIds)})) or (l.from_type = 'organisation' and l.from_id in (${list(orgIds)})))))`;
}

/**
 * Enabled rules linked to any of the projects or organisations, or to products linked to them:
 * the brief's watch-outs.
 */
async function linkedRules(projectIds: number[], orgIds: number[], productIds: number[] = []): Promise<number[]> {
  if (!projectIds.length && !orgIds.length) return [];
  const res = await db.execute(sql`
    select pb.id from rules pb where pb.enabled and (${linkedTo("rule", "pb", projectIds, orgIds)}
      or exists (select 1 from links l where (l.from_type = 'rule' and l.from_id = pb.id and l.to_type = 'product' and l.to_id in (${idList(productIds)}))
                                          or (l.to_type = 'rule' and l.to_id = pb.id and l.from_type = 'product' and l.from_id in (${idList(productIds)}))))
    order by pb.id`);
  return (res.rows as { id: number }[]).map((r) => Number(r.id));
}

async function linkedProducts(projectIds: number[], orgIds: number[]): Promise<number[]> {
  if (!projectIds.length && !orgIds.length) return [];
  const res = await db.execute(sql`
    select pr.id from products pr where pr.state <> 'retired' and ${linkedTo("product", "pr", projectIds, orgIds)} order by pr.name`);
  return (res.rows as { id: number }[]).map((r) => Number(r.id));
}

async function linkedPlaybooks(projectIds: number[], orgIds: number[]): Promise<number[]> {
  if (!projectIds.length && !orgIds.length) return [];
  const res = await db.execute(sql`
    select pp.id from process_playbooks pp where pp.state = 'in_use' and ${linkedTo("playbook", "pp", projectIds, orgIds)} order by pp.title`);
  return (res.rows as { id: number }[]).map((r) => Number(r.id));
}

/* ---------- Writing the brief ---------- */

export function contextRefs(c: ContextOut): string[] {
  return [
    c.entity.ref,
    ...c.facts.map((x) => x.ref),
    ...c.decisions.slice(0, 8).map((x) => x.ref),
    ...c.promises.map((x) => x.ref),
    ...c.waiting_on_them.map((x) => x.ref),
    ...c.open_tasks.slice(0, 10).map((x) => x.ref),
    ...c.notes.slice(0, 6).map((x) => x.ref),
    ...c.recent_activity.slice(0, 8).map((x) => x.ref),
    ...c.sessions.slice(0, 3).map((x) => x.ref),
  ];
}

const whenText = (e: CalendarEvent) => `${formatLong(e.startsAt)}, ${formatTime(e.startsAt)} to ${formatTime(e.endsAt)}`;

/** Keeps only lines that cite something handed to the model, and only those citations. */
function keepCited(lines: { text: string; refs: string[] }[], allowed: Set<string>, requireRef: boolean, max: number): BriefLine[] {
  const out: BriefLine[] = [];
  for (const l of lines) {
    const text = l.text.trim();
    const cited = [...new Set(l.refs.map((r) => r.trim()))].filter((r) => allowed.has(r));
    if (!text || (requireRef && !cited.length)) continue;
    out.push({ text, cited });
    if (out.length >= max) break;
  }
  return out;
}

async function generate(inputs: BriefInputs, existing: MeetingBrief | null, opts: { force?: boolean } = {}): Promise<MeetingBrief> {
  const { event, match } = inputs;
  const scope = await askScope();
  const entityRefs = [
    ...match.personIds.slice(0, MAX_PEOPLE).map((id) => toRef("person", id)),
    ...inputs.projectIds.map((id) => toRef("project", id)),
    ...match.orgIds.map((id) => toRef("organisation", id)),
    ...inputs.productIds.map((id) => toRef("product", id)),
  ];
  const visible = await visibleRefs(scope, entityRefs);
  const heldBack = entityRefs.filter((r) => !visible.has(r));

  // Feature 03 rule 3: get_context for each attendee and linked project, plus promises and rules.
  const refs: string[] = [];
  for (const r of entityRefs.filter((x) => visible.has(x) && !x.startsWith("organisation:"))) {
    const ctx = await getContext(scope, { ref: r }, "meeting_brief");
    if (ctx) refs.push(...contextRefs(ctx));
  }
  refs.push(...match.orgIds.map((id) => toRef("organisation", id)).filter((r) => visible.has(r)));
  refs.push(...inputs.promiseIds.map((id) => toRef("task", id)));
  refs.push(...inputs.productIds.map((id) => toRef("product", id)).filter((r) => visible.has(r)));
  refs.push(...inputs.playbookIds.map((id) => toRef("playbook", id)));
  const items = await loadVisibleDocs(scope, [...new Set(refs)]);
  const rules = await loadVisibleDocs(scope, await applicableRuleRefs(scope, entityRefs.filter((r) => visible.has(r))));
  await recordReads(scope, [...items, ...rules].map((d) => d.ref), { via: "meeting_brief", event: event.id });

  const meeting = {
    title: event.title,
    when: whenText(event),
    attendees: match.attendees.filter((a) => !a.personId || visible.has(toRef("person", a.personId))).map((a) => a.name),
    description: event.location,
  };
  // Hidden names never reach the model, even as attendee text.
  const hiddenNames = await hiddenAttendeeNames(match, visible);
  meeting.attendees = meeting.attendees.filter((n) => !hiddenNames.some((re) => re.test(n)));
  if (hiddenNames.some((re) => re.test(meeting.title))) meeting.title = "(a meeting about something hidden from AI)";

  const hash = createHash("sha256")
    .update(JSON.stringify({ v: BRIEF_VERSION, meeting, docs: [...rules, ...items].map((d) => d.text) }))
    .digest("hex");
  const now = new Date();
  if (existing && !existing.failed && existing.inputsHash === hash && !opts.force) {
    const [row] = await db.update(meetingBriefsTable).set({ generatedAt: now }).where(eq(meetingBriefsTable.id, existing.id)).returning();
    return row;
  }

  // Facts, emails and notes, not just the names of the people and projects.
  const substance = items.filter((d) => !["person", "project", "organisation", "product", "playbook"].includes(d.type));
  let why: BriefLine[] | null = null;
  let questions: BriefLine[] | null = null;
  let agenda: BriefLine[] | null = null;
  let questionsNote: string | null = null;
  let failed = false;
  let model: string | null = null;
  if (substance.length) {
    try {
      const out = await writeBriefFromDocs(meeting, [...rules, ...items]);
      const allowed = new Set(items.map((d) => d.ref));
      const w = keepCited(out.why, allowed, true, 4);
      // Feature 03 rule 5: nothing citable means "Not much on file", never padding.
      if (w.length) {
        why = w;
        questions = keepCited(out.questions, allowed, false, 5);
        agenda = keepCited(out.agenda ?? [], allowed, false, 5);
        questionsNote = out.questionsNote || null;
      }
      model = "anthropic";
    } catch (err) {
      logger.error({ err, eventId: event.id }, "Meeting brief failed");
      if (existing && !existing.failed) return existing;
      failed = true;
    }
  }

  const citedIds = [...new Set([...(why ?? []), ...(agenda ?? []), ...(questions ?? [])].flatMap((l) => l.cited))];
  const inputRefs = [...items, ...rules].map((d) => d.ref);
  const plain = await visibleRefs(defaultScope(), inputRefs);
  const values = {
    calendarEventId: event.id,
    generatedAt: now,
    why,
    questions,
    agenda,
    questionsNote,
    attendeeIds: match.personIds,
    projectIds: inputs.projectIds,
    goalIds: inputs.goalIds,
    promiseIds: inputs.promiseIds,
    documentIds: inputs.documentIds,
    ruleIds: inputs.ruleIds,
    productIds: inputs.productIds,
    playbookIds: inputs.playbookIds,
    citedIds,
    inputRefs,
    heldBack,
    inputsHash: failed ? null : hash,
    usedConfidential: inputRefs.some((r) => !plain.has(r)),
    failed,
    model,
  };
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(meetingBriefsTable)
      .values(values)
      .onConflictDoUpdate({ target: meetingBriefsTable.calendarEventId, set: values })
      .returning();
    await writeAudit(tx, {
      actor: ACTOR,
      action: "generate",
      entityType: "meeting_brief",
      entityId: row.id,
      payload: { event: event.id, cited: citedIds, inputs: inputRefs.length, heldBack: heldBack.length, failed, notMuch: !why && !failed },
    });
    return row;
  });
  // Part Y: code checks on what the brief writer wrote; it may only cite what it was given.
  if (!failed && why) {
    const text = [...(saved.why ?? []), ...(saved.agenda ?? []), ...(saved.questions ?? [])].map((l) => l.text).join("\n");
    await recordCheck("brief_writer", `brief:${saved.id}`, text, { given: inputRefs, cited: citedIds, maxWords: 450 });
  }
  return saved;
}

async function clientFirst<T extends { id: number }>(rows: T[]): Promise<T[]> {
  const work = await workTypesOf(rows.map((r) => r.id));
  return [...rows.filter((r) => work.get(r.id) === "client"), ...rows.filter((r) => work.get(r.id) !== "client")];
}

/** Whole-word patterns for the names of attendees, projects and organisations hidden from AI. */
async function hiddenAttendeeNames(match: EventMatch, visible: Set<string>): Promise<RegExp[]> {
  const people = match.personIds.filter((id) => !visible.has(toRef("person", id)));
  const projects = match.projectIds.filter((id) => !visible.has(toRef("project", id)));
  const orgs = match.orgIds.filter((id) => !visible.has(toRef("organisation", id)));
  const names: string[] = [];
  if (people.length) {
    for (const p of await db.select({ name: peopleTable.name, email: peopleTable.email }).from(peopleTable).where(inArray(peopleTable.id, people))) {
      names.push(p.name, ...(p.email ? [p.email] : []));
    }
  }
  if (projects.length) names.push(...(await db.select({ name: projectsTable.name }).from(projectsTable).where(inArray(projectsTable.id, projects))).map((p) => p.name));
  if (orgs.length) names.push(...(await db.select({ name: organisationsTable.name }).from(organisationsTable).where(inArray(organisationsTable.id, orgs))).map((o) => o.name));
  return names.filter((n) => n.trim()).map(wholeWord);
}

async function loadEvent(eventId: number): Promise<CalendarEvent> {
  const [event] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, eventId));
  if (!event) throw new NotFoundError("That meeting is not on your calendar");
  return event;
}

async function loadBrief(eventId: number): Promise<MeetingBrief | null> {
  const [row] = await db.select().from(meetingBriefsTable).where(eq(meetingBriefsTable.calendarEventId, eventId));
  return row ?? null;
}

/**
 * The brief for an event, written or refreshed when needed: missing, more than 3 hours old, or
 * failed last time. Once a meeting has ended the brief is kept as it was.
 */
export async function ensureBrief(eventId: number, opts: { force?: boolean; now?: Date } = {}): Promise<{ event: CalendarEvent; brief: MeetingBrief; inputs: BriefInputs }> {
  const now = opts.now ?? new Date();
  const event = await loadEvent(eventId);
  if (event.personal) throw new NotFoundError("Personal events have no brief");
  const inputs = await gatherInputs(event);
  if (!inputs) throw new NotFoundError("This meeting has no one or nothing OllieOS knows about, so there is no brief");
  const existing = await loadBrief(event.id);
  const ended = event.endsAt <= now;
  const stale = !existing || existing.failed || now.getTime() - existing.generatedAt.getTime() > BRIEF_MAX_AGE_MS;
  if (existing && !opts.force && (ended || !stale)) return { event, brief: existing, inputs };
  return { event, brief: await generate(inputs, existing, { force: opts.force }), inputs };
}

/** The next work meeting that gets a brief, from now to the end of tomorrow. */
export async function nextBriefEventId(now = new Date()): Promise<number | null> {
  const end = londonRange(addDays(todayLondon(now), 1), 1).end;
  const events = await db
    .select()
    .from(calendarEventsTable)
    .where(and(gt(calendarEventsTable.endsAt, now), lt(calendarEventsTable.startsAt, end), eq(calendarEventsTable.personal, false)))
    .orderBy(asc(calendarEventsTable.startsAt));
  const ok = await briefableIds(events);
  return events.find((e) => ok.has(e.id))?.id ?? null;
}

/**
 * When a sweep finishes: briefs for the work meetings in the next seven days that have not
 * started, so each is ready well before it is needed (criterion 1) and the Meetings page shows
 * the whole week prepared (Assist Part B). Unchanged inputs skip the model call.
 */
export async function buildUpcomingBriefs(now = new Date()): Promise<{ built: number; unchanged: number; failed: number }> {
  const range = londonRange(todayLondon(now), 7);
  const events = await db
    .select()
    .from(calendarEventsTable)
    .where(and(gt(calendarEventsTable.startsAt, now), lt(calendarEventsTable.startsAt, range.end), eq(calendarEventsTable.personal, false)))
    .orderBy(asc(calendarEventsTable.startsAt));
  const m = await loadMatchers();
  let built = 0;
  let unchanged = 0;
  let failed = 0;
  const queue = [...events];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      try {
        const inputs = await gatherInputs(e, m);
        if (!inputs) continue;
        const existing = await loadBrief(e.id);
        const row = await generate(inputs, existing);
        if (row.failed) failed++;
        else if (existing && row.inputsHash === existing.inputsHash && !existing.failed) unchanged++;
        else built++;
      } catch (err) {
        failed++;
        logger.error({ err, eventId: e.id }, "Meeting brief after sweep failed");
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { built, unchanged, failed };
}

/* ---------- Ollie's view ---------- */

export interface BriefSource {
  ref: string;
  label: string;
  href: string | null;
  external: boolean;
}

export interface DecidesOnItem {
  type: "project" | "product" | "organisation";
  id: number;
  name: string;
  slug: string;
}

/** What each person decides on (Part N), for the brief's attendee lines. Ollie's view. */
async function decidesOnFor(personIds: number[]): Promise<Map<number, DecidesOnItem[]>> {
  const out = new Map<number, DecidesOnItem[]>();
  if (!personIds.length) return out;
  const rows = await db
    .select({ personId: linksTable.fromId, type: linksTable.toType, id: linksTable.toId })
    .from(linksTable)
    .where(and(eq(linksTable.relationship, "decides_on"), eq(linksTable.fromType, "person"), inArray(linksTable.fromId, personIds)));
  const names = await resolveEntities(rows.map((r) => ({ type: r.type, id: r.id })));
  for (const r of rows) {
    const n = names.get(`${r.type}:${r.id}`);
    if (!n || !["project", "product", "organisation"].includes(r.type)) continue;
    out.set(r.personId, [...(out.get(r.personId) ?? []), { type: r.type as DecidesOnItem["type"], id: r.id, name: n.name, slug: n.slug ?? "" }]);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface BriefView {
  /** Part Y: for thumbs */
  id: number;
  event: { id: number; title: string; startsAt: Date; endsAt: Date; location: string | null; platform: string | null; scope: MeetingScope; companies: string[] };
  /** What the research agent found about each outside company on the meeting */
  research: ResearchView[];
  /** Part S: the pulse of each client organisation in the meeting */
  pulse: { name: string; slug: string; line: string; needsAttention: boolean; reasons: string[]; commercial: Commercial }[];
  /** Part K: open "Next time I see…" points for people in the meeting, top of the agenda */
  talkingPoints: TalkingPointView[];
  /** Part K: the follow-up task drafted from this meeting's Granola notes, if there is one */
  followUpTaskId: number | null;
  /** Part K: when Ollie first opened this prep page */
  openedAt: Date | null;
  generatedAt: Date;
  failed: boolean;
  notMuch: boolean;
  sourcesLine: string | null;
  why: { text: string; sources: BriefSource[] }[] | null;
  questions: { text: string; sources: BriefSource[] }[] | null;
  questionsNote: string | null;
  /** Suggested agenda; null when not much is on file or the brief predates it */
  agenda: { text: string; sources: BriefSource[] }[] | null;
  attendees: {
    name: string;
    email: string | null;
    response: string | null;
    organiser: boolean;
    person: {
      id: number;
      slug: string;
      name: string;
      role: string | null;
      organisation: string | null;
      confidential: boolean;
      lastContactAt: Date | null;
      facts: { id: number; text: string; needsCheck: boolean }[];
      cadence: { label: string; status: string; daysOverdue: number | null; daysLeft: number | null; daysSince: number | null } | null;
      /** Part N: the projects, products and organisations they decide on */
      decidesOn: DecidesOnItem[];
    } | null;
  }[];
  promises: { id: number; title: string; source: string; capturedAt: Date; dueDate: string | null; personName: string | null }[];
  /** Open tasks for people on the meeting (Ollie owes them), promises aside */
  tasks: { id: number; title: string; status: string; dueDate: string | null; personName: string | null }[];
  /** What Ollie is waiting on from people on the meeting */
  waitingOn: { id: number; title: string; since: Date; personName: string | null }[];
  /** Granola notes from earlier meetings with any of the same people, newest first */
  earlier: { eventId: number; title: string; startsAt: Date; notes: string; people: string[] }[];
  /** Recent email and Slack exchanges with the people on the meeting */
  threads: { id: number; kind: string; summary: string; occurredAt: Date; url: string | null }[];
  projects: { id: number; slug: string; name: string; confidential: boolean }[];
  goals: { id: number; name: string }[];
  documents: { id: number; title: string; url: string | null; location: string }[];
  rules: { id: number; title: string; rule: string }[];
  /** Products linked to the meeting's projects and organisations, with the rules linked to each (Part M) */
  products: { id: number; slug: string; name: string; description: string | null; state: string; confidential: boolean; ruleIds: number[] }[];
  /** In use playbooks linked to the meeting's projects and organisations (Part M) */
  playbooks: { id: number; title: string; whenToUse: string; steps: number }[];
  heldBack: number;
  notes: string | null;
  granolaNotes: string | null;
  granolaRef: string | null;
  actions: { id: number; title: string; status: string }[];
}

const TYPE_WORDS: Record<string, [string, string]> = {
  fact: ["fact", "facts"],
  note: ["note", "notes"],
  decision: ["decision", "decisions"],
  task: ["task", "tasks"],
  person: ["person", "people"],
  project: ["project", "projects"],
  organisation: ["organisation", "organisations"],
  email: ["email", "emails"],
  meeting: ["meeting", "meetings"],
  slack: ["Slack message", "Slack messages"],
  activity: ["update", "updates"],
  session: ["Cowork session", "Cowork sessions"],
};

function listWords(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Built from 4 emails, 2 facts and 1 note", from what the brief cites. */
async function sourcesLine(cited: string[]): Promise<string | null> {
  if (!cited.length) return null;
  const actIds = cited.map(parseRef).filter((r) => r?.type === "activity").map((r) => r!.id);
  const kinds = new Map(
    (actIds.length ? await db.select({ id: activityTable.id, kind: activityTable.kind }).from(activityTable).where(inArray(activityTable.id, actIds)) : []).map((a) => [
      a.id,
      a.kind,
    ]),
  );
  const counts = new Map<string, number>();
  for (const r of cited) {
    const p = parseRef(r);
    if (!p) continue;
    const key = p.type === "activity" ? (["email", "meeting", "slack"].includes(kinds.get(p.id) ?? "") ? kinds.get(p.id)! : "activity") : p.type;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${(TYPE_WORDS[k] ?? [k, k + "s"])[n === 1 ? 0 : 1]}`);
  return `Built from ${listWords(parts)}`;
}

async function sourcesFor(refs: string[]): Promise<Map<string, BriefSource>> {
  const out = new Map<string, BriefSource>();
  if (!refs.length) return out;
  const labels = await describeRefs(refs);
  const parsed = refs.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const ids = (t: string) => parsed.filter((r) => r.type === t).map((r) => r.id);
  const none = <T>(): Promise<T[]> => Promise.resolve([]);
  const [acts, docs, goals, books] = await Promise.all([
    ids("activity").length
      ? db.select({ id: activityTable.id, url: activityTable.sourceUrl, kind: activityTable.kind, at: activityTable.occurredAt }).from(activityTable).where(inArray(activityTable.id, ids("activity")))
      : none<{ id: number; url: string | null; kind: string; at: Date }>(),
    ids("document").length
      ? db.select({ id: documentsTable.id, title: documentsTable.title, url: documentsTable.url }).from(documentsTable).where(inArray(documentsTable.id, ids("document")))
      : none<{ id: number; title: string; url: string | null }>(),
    ids("goal").length ? db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, ids("goal"))) : none<{ id: number; name: string }>(),
    ids("rule").length
      ? db.select({ id: rulesTable.id, title: rulesTable.title }).from(rulesTable).where(inArray(rulesTable.id, ids("rule")))
      : none<{ id: number; title: string }>(),
  ]);

  const actMap = new Map(acts.map((a) => [a.id, a]));
  for (const r of refs) {
    const p = parseRef(r);
    if (!p) continue;
    const l = labels.get(r);
    const pid = p.id;
    if (p.type === "activity") {
      const a = actMap.get(p.id);
      const kind = a ? (a.kind === "email" ? "Email" : a.kind === "slack" ? "Slack" : a.kind === "meeting" ? "Meeting" : "Update") : "Update";
      out.set(r, { ref: r, label: a ? `${kind}, ${formatLong(a.at)}` : (l?.name ?? r), href: a?.url ?? null, external: !!a?.url });
    } else if (p.type === "document") {
      const d = docs.find((x) => x.id === pid);
      if (d) out.set(r, { ref: r, label: d.title, href: d.url, external: true });
    } else if (p.type === "session" && l) {
      out.set(r, { ref: r, label: l.name, href: l.path, external: false });
    } else if (p.type === "goal") {
      const g = goals.find((x) => x.id === pid);
      if (g) out.set(r, { ref: r, label: g.name, href: "/goals", external: false });
    } else if (p.type === "rule") {
      const b = books.find((x) => x.id === pid);
      if (b) out.set(r, { ref: r, label: b.title, href: "/knowledge/library", external: false });
    } else if (l) {
      const label = p.type === "fact" ? "Fact" : p.type === "note" ? "Note" : p.type === "decision" ? "Decision" : l.name;
      out.set(r, { ref: r, label: p.type === "fact" || p.type === "note" || p.type === "decision" ? `${label}: ${l.name}` : label, href: l.path, external: false });
    }
  }
  return out;
}

export async function briefView(eventId: number, opts: { force?: boolean } = {}): Promise<BriefView> {
  const { event, brief, inputs } = await ensureBrief(eventId, opts);
  return viewOf(event, brief, inputs);
}

const MAX_FACTS = 4;
const MAX_EARLIER = 3;
const MAX_THREADS = 8;
const THREAD_DAYS = 60;

async function viewOf(event: CalendarEvent, brief: MeetingBrief, inputs: BriefInputs): Promise<BriefView> {
  const people = inputs.match.personIds;
  const [productRows, playbookRows, productRules] = await Promise.all([
    inputs.productIds.length
      ? db
          .select({
            id: productsTable.id,
            slug: productsTable.slug,
            name: productsTable.name,
            description: productsTable.description,
            state: productsTable.state,
            confidential: productsTable.confidential,
            aiAccess: productsTable.aiAccess,
          })
          .from(productsTable)
          .where(inArray(productsTable.id, inputs.productIds))
      : [],
    inputs.playbookIds.length
      ? db.select({ id: playbooksTable.id, title: playbooksTable.title, whenToUse: playbooksTable.whenToUse, steps: playbooksTable.steps }).from(playbooksTable).where(inArray(playbooksTable.id, inputs.playbookIds))
      : [],
    linkMap("rule", inputs.ruleIds, "product"),
  ]);
  const rulesByProduct = new Map<number, number[]>();
  for (const [ruleId, productIds] of productRules) {
    for (const p of productIds) rulesByProduct.set(p, [...(rulesByProduct.get(p) ?? []), ruleId]);
  }
  const [personRows, promiseRows, projectRows, goalRows, docRows, bookRows, actionRows, extra] = await Promise.all([
    people.length
      ? db
          .select({
            id: peopleTable.id,
            slug: peopleTable.slug,
            name: peopleTable.name,
            role: peopleTable.role,
            confidential: peopleTable.confidential,
            lastContactAt: peopleTable.lastContactAt,
            cadence: peopleTable.cadence,
            cadencePaused: peopleTable.cadencePaused,
            organisation: organisationsTable.name,
          })
          .from(peopleTable)
          .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
          .where(inArray(peopleTable.id, people))
      : [],
    inputs.promiseIds.length
      ? db
          .select({ t: tasksTable, personName: peopleTable.name })
          .from(tasksTable)
          .leftJoin(peopleTable, eq(peopleTable.id, tasksTable.personId))
          .where(inArray(tasksTable.id, inputs.promiseIds))
          .orderBy(sql`${tasksTable.dueDate} asc nulls last`, asc(tasksTable.createdAt))
      : [],
    inputs.projectIds.length
      ? db.select({ id: projectsTable.id, slug: projectsTable.slug, name: projectsTable.name, confidential: projectsTable.confidential }).from(projectsTable).where(inArray(projectsTable.id, inputs.projectIds))
      : [],
    inputs.goalIds.length ? db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, inputs.goalIds)) : [],
    inputs.documentIds.length
      ? db.select({ id: documentsTable.id, title: documentsTable.title, url: documentsTable.url, location: documentsTable.location }).from(documentsTable).where(inArray(documentsTable.id, inputs.documentIds))
      : [],
    inputs.ruleIds.length
      ? db.select({ id: rulesTable.id, title: rulesTable.title, rule: rulesTable.rule }).from(rulesTable).where(inArray(rulesTable.id, inputs.ruleIds))
      : [],
    brief.actionTaskIds.length
      ? db.select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status }).from(tasksTable).where(inArray(tasksTable.id, brief.actionTaskIds)).orderBy(asc(tasksTable.id))
      : [],
    prepExtras(event, people),
  ]);
  const sources = await sourcesFor(brief.citedIds);
  const withSources = (lines: BriefLine[] | null) =>
    lines ? lines.map((l) => ({ text: l.text, sources: l.cited.map((r) => sources.get(r)).filter((s): s is BriefSource => !!s) })) : null;
  const byPerson = new Map(personRows.map((p) => [p.id, p]));
  const deciding = await decidesOnFor(personRows.map((p) => p.id));
  const order = (ids: number[]) => (a: { id: number }, b: { id: number }) => ids.indexOf(a.id) - ids.indexOf(b.id);

  return {
    event: {
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      location: event.location,
      platform: event.platform,
      scope: inputs.match.scope,
      companies: inputs.match.companies,
    },
    research: await researchViews(inputs.match.domains),
    talkingPoints: await openPointsFor(people),
    pulse: inputs.match.scope === "external" ? (await pulsesFor(inputs.match.orgIds)).map((p) => ({ name: p.name, slug: p.slug, line: p.line, needsAttention: p.needsAttention, reasons: p.reasons, commercial: p.commercial })) : [],
    followUpTaskId: brief.granolaRef ? await followUpTaskFor(brief.granolaRef) : null,
    openedAt: brief.openedAt,
    id: brief.id,
    generatedAt: brief.generatedAt,
    failed: brief.failed,
    notMuch: !brief.why && !brief.failed,
    sourcesLine: await sourcesLine(brief.citedIds),
    why: withSources(brief.why),
    questions: withSources(brief.questions),
    questionsNote: brief.questionsNote,
    agenda: brief.why ? withSources(brief.agenda) : null,
    attendees: inputs.match.attendees.map((a) => {
      const p = a.personId != null ? byPerson.get(a.personId) : undefined;
      const cad = p && p.cadence !== "none" ? stateFor(p, extra.projects.get(p.id)) : null;
      return {
        name: p?.name ?? a.name,
        email: a.email ?? null,
        response: a.response ?? null,
        organiser: !!a.organiser,
        person: p
          ? {
              id: p.id,
              slug: p.slug,
              name: p.name,
              role: p.role,
              organisation: p.organisation,
              confidential: p.confidential,
              lastContactAt: p.lastContactAt,
              facts: extra.facts.get(p.id) ?? [],
              cadence: cad ? { label: CADENCE_LABELS[p.cadence], status: cad.status, daysOverdue: cad.daysOverdue, daysLeft: cad.daysLeft, daysSince: cad.daysSince } : null,
              decidesOn: deciding.get(p.id) ?? [],
            }
          : null,
      };
    }),
    promises: promiseRows.map(({ t, personName }) => ({
      id: t.id,
      title: t.title,
      source: SOURCE_LABELS[t.source],
      capturedAt: t.capturedAt ?? t.createdAt,
      dueDate: t.dueDate,
      personName,
    })),
    tasks: extra.tasks,
    waitingOn: extra.waitingOn,
    earlier: extra.earlier,
    threads: extra.threads,
    // Client work first, then the order the meeting matched them in.
    projects: await clientFirst(projectRows.sort(order(inputs.projectIds))),
    goals: goalRows,
    documents: docRows,
    rules: bookRows,
    products: productRows
      .sort(order(inputs.productIds))
      .map(({ aiAccess, ...p }) => ({ ...p, confidential: p.confidential || !aiAccess, ruleIds: (rulesByProduct.get(p.id) ?? []).sort((a, b) => a - b) })),
    playbooks: playbookRows.sort(order(inputs.playbookIds)).map((p) => ({ id: p.id, title: p.title, whenToUse: p.whenToUse, steps: p.steps.length })),
    heldBack: brief.heldBack.length,
    // Ollie's notes live on the event now; older ones may still be on the brief.
    notes: event.notes ?? brief.notes,
    granolaNotes: brief.granolaNotes,
    granolaRef: brief.granolaRef,
    actions: actionRows,
  };
}

/**
 * The rest of the prep page (Assist Part B), Ollie's view so nothing is hidden: each person's
 * current facts, open tasks both ways, Granola notes from earlier meetings with any of the same
 * people, and recent email and Slack exchanges with them.
 */
async function prepExtras(event: CalendarEvent, people: number[]) {
  if (!people.length) {
    return {
      facts: new Map<number, { id: number; text: string; needsCheck: boolean }[]>(),
      projects: new Map(),
      tasks: [] as BriefView["tasks"],
      waitingOn: [] as BriefView["waitingOn"],
      earlier: [] as BriefView["earlier"],
      threads: [] as BriefView["threads"],
    };
  }
  const ids = sql.join(people.map((id) => sql`${id}`), sql`, `);
  const since = new Date(Date.now() - THREAD_DAYS * 86_400_000);
  const [factRows, projects, taskRows, waitingRows, earlierRows, threadRows, names] = await Promise.all([
    db
      .select({ id: factsTable.id, personId: factsTable.entityId, text: factsTable.text, needsCheck: factsTable.needsCheck })
      .from(factsTable)
      .where(and(eq(factsTable.entityType, "person"), inArray(factsTable.entityId, people), isNull(factsTable.supersededBy)))
      .orderBy(desc(factsTable.lastConfirmedAt), desc(factsTable.id)),
    projectsForPeople(people),
    db
      .select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status, dueDate: tasksTable.dueDate, personName: peopleTable.name })
      .from(tasksTable)
      .leftJoin(peopleTable, eq(peopleTable.id, tasksTable.personId))
      .where(and(eq(tasksTable.kind, "task"), inArray(tasksTable.status, ["inbox", "now", "backlog"]), inArray(tasksTable.personId, people)))
      .orderBy(sql`${tasksTable.dueDate} asc nulls last`, asc(tasksTable.createdAt))
      .limit(10),
    db
      .select({ t: tasksTable, personName: peopleTable.name })
      .from(tasksTable)
      .leftJoin(peopleTable, eq(peopleTable.id, tasksTable.waitingOnPersonId))
      .where(and(eq(tasksTable.status, "waiting"), inArray(tasksTable.waitingOnPersonId, people)))
      .orderBy(sql`coalesce(${tasksTable.waitingSince}, ${tasksTable.capturedAt}, ${tasksTable.createdAt}) asc`)
      .limit(10),
    db
      .select({ eventId: calendarEventsTable.id, title: calendarEventsTable.title, startsAt: calendarEventsTable.startsAt, notes: meetingBriefsTable.granolaNotes, attendeeIds: meetingBriefsTable.attendeeIds })
      .from(meetingBriefsTable)
      .innerJoin(calendarEventsTable, eq(calendarEventsTable.id, meetingBriefsTable.calendarEventId))
      .where(
        and(
          ne(calendarEventsTable.id, event.id),
          lt(calendarEventsTable.startsAt, event.startsAt),
          sql`${meetingBriefsTable.granolaNotes} is not null`,
          arrayOverlaps(meetingBriefsTable.attendeeIds, people),
        ),
      )
      .orderBy(desc(calendarEventsTable.startsAt))
      .limit(MAX_EARLIER),
    db.execute(sql`
      select a.id, a.kind, a.summary, a.occurred_at, a.source_url from activity a
      where a.kind in ('email', 'slack') and a.occurred_at >= ${since.toISOString()}
        and ((a.entity_type = 'person' and a.entity_id in (${ids}))
          or exists (select 1 from links l where l.from_type = 'activity' and l.from_id = a.id and l.to_type = 'person' and l.to_id in (${ids}))
          or exists (select 1 from links l where l.to_type = 'activity' and l.to_id = a.id and l.from_type = 'person' and l.from_id in (${ids})))
      order by a.occurred_at desc limit ${MAX_THREADS}`),
    db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, people)),
  ]);
  const facts = new Map<number, { id: number; text: string; needsCheck: boolean }[]>();
  for (const f of factRows) {
    const list = facts.get(f.personId) ?? [];
    if (list.length < MAX_FACTS) list.push({ id: f.id, text: f.text, needsCheck: f.needsCheck });
    facts.set(f.personId, list);
  }
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return {
    facts,
    projects,
    tasks: taskRows,
    waitingOn: waitingRows.map(({ t, personName }) => ({ id: t.id, title: t.title, since: t.waitingSince ?? t.capturedAt ?? t.createdAt, personName })),
    earlier: earlierRows.map((r) => ({
      eventId: r.eventId,
      title: r.title,
      startsAt: r.startsAt,
      notes: r.notes!,
      people: r.attendeeIds.filter((id) => people.includes(id)).map((id) => nameOf.get(id)).filter((n): n is string => !!n),
    })),
    threads: (threadRows.rows as { id: number; kind: string; summary: string; occurred_at: string | Date; source_url: string | null }[]).map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      summary: r.summary,
      occurredAt: new Date(r.occurred_at),
      url: r.source_url,
    })),
  };
}

/** "Allow for this brief": opens what was held back to Ask OllieOS for one hour and writes the brief again. */
export async function allowForBrief(eventId: number): Promise<BriefView> {
  const brief = await loadBrief(eventId);
  if (!brief?.heldBack.length) throw new ConflictError("Nothing was held back from this brief");
  const event = await loadEvent(eventId);
  const labels = await describeRefs(brief.heldBack);
  const items = brief.heldBack
    .map(parseRef)
    .filter((r): r is NonNullable<typeof r> => !!r && labels.has(`${r.type}:${r.id}`))
    .map((r) => ({ type: r.type as GrantType, id: r.id, name: labels.get(`${r.type}:${r.id}`)!.name }));
  await grantDirect(await askClient(), items, `Allowed for the brief "${event.title.slice(0, 200)}"`);
  return briefView(eventId, { force: true });
}

/* ---------- Granola notes after the meeting (rule 6) ---------- */

/**
 * Part K: external work meetings today that have a prep page Ollie has not opened yet and have not
 * started. Used by the digest and the Home Today strip.
 */
export async function notPreppedIds(events: CalendarEvent[], now = new Date()): Promise<Set<number>> {
  const upcoming = events.filter((e) => !e.personal && e.startsAt > now);
  if (!upcoming.length) return new Set();
  const [briefable, m, opened] = await Promise.all([
    briefableIds(upcoming),
    loadMatchers(),
    db
      .select({ id: meetingBriefsTable.calendarEventId })
      .from(meetingBriefsTable)
      .where(and(inArray(meetingBriefsTable.calendarEventId, upcoming.map((e) => e.id)), sql`${meetingBriefsTable.openedAt} is not null`)),
  ]);
  const seen = new Set(opened.map((o) => o.id));
  return new Set(upcoming.filter((e) => briefable.has(e.id) && !seen.has(e.id) && matchEvent(e, m).scope === "external").map((e) => e.id));
}

/** Part K: Ollie opened the prep page, so the meeting no longer counts as "Not prepped". */
export async function markBriefOpened(eventId: number): Promise<void> {
  await db
    .update(meetingBriefsTable)
    .set({ openedAt: new Date() })
    .where(and(eq(meetingBriefsTable.calendarEventId, eventId), isNull(meetingBriefsTable.openedAt)));
}

async function followUpTaskFor(granolaRef: string): Promise<number | null> {
  const [t] = await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.source, "meeting"), eq(tasksTable.sourceRef, followUpRef(granolaRef)))).limit(1);
  return t?.id ?? null;
}

export async function findEventBySourceRef(sourceRef: string): Promise<CalendarEvent | null> {
  const [event] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, sourceRef));
  return event ?? null;
}

/** Attaches notes and action task ids to an event's brief, writing the brief first if there is none. */
export async function attachMeetingNotes(
  event: CalendarEvent,
  input: { granolaRef: string; notes: string; url?: string | null; actionTaskIds: number[]; actor: string; clientId: number | null },
  now = new Date(),
): Promise<MeetingBrief | null> {
  if (event.personal) throw new ConflictError("Personal events have no brief");
  // A brief only exists when someone or something on the meeting is known; the meeting keeps the note either way.
  let brief = await loadBrief(event.id);
  if (!brief) {
    const inputs = await gatherInputs(event);
    if (inputs) brief = await generate(inputs, null);
  }
  const notes = input.notes.slice(0, 50000);
  const sameNote = event.granolaRef === input.granolaRef;
  const eventIds = [...new Set([...(sameNote ? event.granolaTaskIds : []), ...input.actionTaskIds])];
  return db.transaction(async (tx) => {
    await tx
      .update(calendarEventsTable)
      .set({ granolaRef: input.granolaRef, granolaUrl: input.url ?? (sameNote ? event.granolaUrl : null), granolaNotes: notes, granolaTaskIds: eventIds, granolaAttachedAt: now })
      .where(eq(calendarEventsTable.id, event.id));
    let row: MeetingBrief | null = null;
    if (brief) {
      [row] = await tx
        .update(meetingBriefsTable)
        .set({ granolaRef: input.granolaRef, granolaNotes: notes, actionTaskIds: [...new Set([...brief.actionTaskIds, ...input.actionTaskIds])] })
        .where(eq(meetingBriefsTable.id, brief.id))
        .returning();
    }
    await writeAudit(tx, {
      actor: input.actor,
      clientId: input.clientId,
      action: "attach_notes",
      entityType: row ? "meeting_brief" : "calendar_event",
      entityId: row ? row.id : event.id,
      payload: { granolaRef: input.granolaRef, actions: input.actionTaskIds, event: event.id },
    });
    return row;
  });
}

/**
 * The work meeting a Granola note belongs to when Granola did not link a calendar event: one that
 * started within half an hour of the note, with the same title or someone in common (Ollie aside).
 * A meeting already linked to a different note is never taken.
 */
export async function findEventForNote(
  note: { noteId: string; title: string; at: Date; people: { email: string | null }[] },
  myEmails: Set<string> = new Set(),
): Promise<CalendarEvent | null> {
  const window = 30 * 60_000;
  const rows = await db
    .select()
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.personal, false),
        gt(calendarEventsTable.startsAt, new Date(note.at.getTime() - window)),
        lt(calendarEventsTable.startsAt, new Date(note.at.getTime() + window)),
      ),
    );
  const me = new Set([...myEmails, ...(process.env.ALLOWED_EMAIL ? [process.env.ALLOWED_EMAIL] : [])].map((e) => e.trim().toLowerCase()));
  const theirs = new Set(note.people.map((p) => p.email?.trim().toLowerCase()).filter((e): e is string => !!e && !me.has(e)));
  const norm = (t: string) => t.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  let best: { e: CalendarEvent; score: number; gap: number } | null = null;
  for (const e of rows) {
    if (e.granolaRef && e.granolaRef !== note.noteId) continue;
    const shared = (e.attendeeDetails ?? []).filter((a) => a.email && theirs.has(a.email.trim().toLowerCase())).length;
    const score = (norm(e.title) === norm(note.title) ? 2 : 0) + shared;
    if (!score) continue;
    const gap = Math.abs(e.startsAt.getTime() - note.at.getTime());
    if (!best || score > best.score || (score === best.score && gap < best.gap)) best = { e, score, gap };
  }
  return best?.e ?? null;
}

/* ---------- For AI tools (get_meeting_brief, ollieos://brief/next) ---------- */

export interface BriefOut {
  event: { ref: string; title: string; starts_at: string; ends_at: string; platform: string | null; location: string | null };
  generated_at: string;
  not_much_on_file: boolean;
  why: { text: string; refs: string[] }[];
  questions: { text: string; refs: string[] }[];
  agenda: { text: string; refs: string[] }[];
  questions_note: string | null;
  /** decides_on: refs of the projects, products and organisations the person decides on */
  attendees: { name: string; response: string | null; person: string | null; decides_on: string[] }[];
  promises: { ref: string; title: string; due_date: string | null }[];
  projects: { ref: string; name: string }[];
  goals: { ref: string; name: string }[];
  documents: { ref: string; title: string; url: string | null }[];
  rules: { ref: string; title: string; rule: string }[];
  /** Products linked to the meeting's projects and organisations, with refs of their rules */
  products: { ref: string; name: string; description: string | null; rules: string[] }[];
  /** Playbooks in use for the meeting's projects and organisations */
  playbooks: { ref: string; title: string; when_to_use: string }[];
  /** Part K: points Ollie wants to raise with people in the meeting */
  talking_points: { person: string; text: string }[];
}

/**
 * The brief filtered for the calling AI. A sentence citing anything the caller cannot see is
 * dropped whole; side lists only keep visible items. The event itself must already be visible
 * to the caller (the caller checks with the calendar filter).
 */
export async function briefForAi(scope: AiScope, eventId: number): Promise<BriefOut> {
  const { event, brief, inputs } = await ensureBrief(eventId);
  const promiseRefs = inputs.promiseIds.map((id) => toRef("task", id));
  const all = [
    ...brief.citedIds,
    ...inputs.match.personIds.map((id) => toRef("person", id)),
    ...inputs.projectIds.map((id) => toRef("project", id)),
    ...inputs.goalIds.map((id) => toRef("goal", id)),
    ...inputs.documentIds.map((id) => toRef("document", id)),
    ...inputs.ruleIds.map((id) => toRef("rule", id)),
    ...inputs.productIds.map((id) => toRef("product", id)),
    ...inputs.playbookIds.map((id) => toRef("playbook", id)),
    ...promiseRefs,
  ];
  const ok = await visibleRefs(scope, all);
  const keep = (lines: BriefLine[] | null) => (lines ?? []).filter((l) => l.cited.every((r) => ok.has(r))).map((l) => ({ text: l.text, refs: l.cited }));
  const view = await viewOf(event, brief, inputs);
  const okDecide = await visibleRefs(scope, view.attendees.flatMap((a) => (a.person?.decidesOn ?? []).map((d) => toRef(d.type, d.id))));
  const out: BriefOut = {
    event: {
      ref: `calendar_event:${event.id}`,
      title: event.title,
      starts_at: event.startsAt.toISOString(),
      ends_at: event.endsAt.toISOString(),
      platform: event.platform,
      location: event.location,
    },
    generated_at: brief.generatedAt.toISOString(),
    not_much_on_file: !brief.why,
    why: keep(brief.why),
    questions: keep(brief.questions),
    agenda: brief.why ? keep(brief.agenda) : [],
    questions_note: brief.why ? brief.questionsNote : null,
    attendees: view.attendees.filter((a) => !a.person || ok.has(toRef("person", a.person.id))).map((a) => ({
      name: a.name,
      response: a.response,
      person: a.person && ok.has(toRef("person", a.person.id)) ? toRef("person", a.person.id) : null,
      decides_on: a.person && ok.has(toRef("person", a.person.id)) ? a.person.decidesOn.map((d) => toRef(d.type, d.id)).filter((r) => okDecide.has(r)) : [],
    })),
    promises: view.promises.filter((p) => ok.has(toRef("task", p.id))).map((p) => ({ ref: toRef("task", p.id), title: p.title, due_date: p.dueDate })),
    projects: view.projects.filter((p) => ok.has(toRef("project", p.id))).map((p) => ({ ref: toRef("project", p.id), name: p.name })),
    goals: view.goals.filter((g) => ok.has(toRef("goal", g.id))).map((g) => ({ ref: toRef("goal", g.id), name: g.name })),
    documents: view.documents.filter((d) => ok.has(toRef("document", d.id))).map((d) => ({ ref: toRef("document", d.id), title: d.title, url: d.url })),
    rules: view.rules.filter((b) => ok.has(toRef("rule", b.id))).map((b) => ({ ref: toRef("rule", b.id), title: b.title, rule: b.rule })),
    products: view.products
      .filter((p) => ok.has(toRef("product", p.id)))
      .map((p) => ({
        ref: toRef("product", p.id),
        name: p.name,
        description: p.description,
        rules: p.ruleIds.map((id) => toRef("rule", id)).filter((r) => ok.has(r)),
      })),
    playbooks: view.playbooks.filter((p) => ok.has(toRef("playbook", p.id))).map((p) => ({ ref: toRef("playbook", p.id), title: p.title, when_to_use: p.whenToUse })),
    talking_points: view.talkingPoints.filter((p) => ok.has(toRef("person", p.personId))).map((p) => ({ person: toRef("person", p.personId), text: p.text })),
  };
  if (!out.why.length) {
    out.questions = [];
    out.agenda = [];
  }
  await recordReads(
    scope,
    [
      ...out.why.flatMap((l) => l.refs),
      ...out.promises.map((p) => p.ref),
      ...out.projects.map((p) => p.ref),
      ...out.documents.map((d) => d.ref),
      ...out.rules.map((p) => p.ref),
      ...out.products.map((p) => p.ref),
      ...out.playbooks.map((p) => p.ref),
    ],
    { via: "get_meeting_brief", event: event.id },
  );
  return out;
}

/**
 * The event an AI asked about: "next" or a calendar_event ref. Null when it does not exist, has
 * no brief, or is hidden from the caller (the same filter as the calendar in ollieos://today).
 */
export async function resolveEventForAi(scope: AiScope, arg: string, now = new Date()): Promise<number | null> {
  let rows: CalendarEvent[];
  if (arg.trim().toLowerCase() === "next") {
    const end = londonRange(addDays(todayLondon(now), 1), 1).end;
    rows = await db
      .select()
      .from(calendarEventsTable)
      .where(and(gt(calendarEventsTable.endsAt, now), lt(calendarEventsTable.startsAt, end), eq(calendarEventsTable.personal, false)))
      .orderBy(asc(calendarEventsTable.startsAt));
  } else {
    const m = /^calendar_event:(\d+)$/.exec(arg.trim());
    if (!m) return null;
    rows = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, Number(m[1])));
  }
  const { rows: seen } = await visibleCalendarRows(scope, rows.filter((r) => !r.personal));
  const ok = await briefableIds(seen);
  return seen.find((e) => ok.has(e.id))?.id ?? null;
}
