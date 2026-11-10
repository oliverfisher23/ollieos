/**
 * Meeting briefs (feature 03). Written by Ask OllieOS from what AI may read (build plan 47), so a
 * hidden attendee or project is left out unless Ollie opens it up. Built when a sweep finishes for
 * today's and tomorrow's work meetings, and again on open when more than 3 hours old.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  db,
  documentsTable,
  goalsTable,
  meetingBriefsTable,
  organisationsTable,
  peopleTable,
  playbooksTable,
  projectsTable,
  tasksTable,
  type BriefLine,
  type CalendarAttendee,
  type CalendarEvent,
  type MeetingBrief,
} from "@workspace/db";
import { OPEN_STATUSES, SOURCE_LABELS, addDays, formatLong, formatTime, londonRange, parseRef, todayLondon, toRef } from "@workspace/shared";
import { getContext, visibleCalendarRows, wholeWord, type ContextOut } from "../lib/ai-data/context";
import { applicablePlaybookRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { askClient, defaultScope, recordReads, visibleRefs, type AiScope } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import type { GrantType } from "../lib/ai-data/visibility";
import { describeRefs, grantDirect } from "./access";
import { askScope } from "./ask/ask";
import { writeBriefFromDocs } from "./ask/model";
import { projectsForPeople } from "./cadence";
import { ConflictError, NotFoundError } from "./tasks";

export const BRIEF_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const ACTOR = "Ask OllieOS";
const MAX_PEOPLE = 6;
const MAX_PROJECTS = 4;

/* ---------- Matching an event to what OllieOS knows ---------- */

interface Matchers {
  people: { id: number; name: string; email: string | null; organisationId: number | null; isSelf: boolean }[];
  projects: { id: number; name: string; re: RegExp }[];
  orgs: { id: number; name: string; re: RegExp }[];
  selfEmail: string | null;
}

async function loadMatchers(): Promise<Matchers> {
  const [people, projects, orgs] = await Promise.all([
    db
      .select({ id: peopleTable.id, name: peopleTable.name, email: peopleTable.email, organisationId: peopleTable.organisationId, isSelf: peopleTable.isSelf })
      .from(peopleTable),
    db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.archived, false)),
    db.select({ id: organisationsTable.id, name: organisationsTable.name }).from(organisationsTable),
  ]);
  const usable = (n: string) => n.trim().length >= 3;
  return {
    people,
    projects: projects.filter((p) => usable(p.name)).map((p) => ({ ...p, re: wholeWord(p.name) })),
    orgs: orgs.filter((o) => usable(o.name)).map((o) => ({ ...o, re: wholeWord(o.name) })),
    selfEmail: process.env.ALLOWED_EMAIL?.trim().toLowerCase() || null,
  };
}

export interface MatchedAttendee extends CalendarAttendee {
  personId: number | null;
}

interface EventMatch {
  attendees: MatchedAttendee[];
  personIds: number[];
  projectIds: number[];
  orgIds: number[];
}

/**
 * Who and what an event is about. Attendees match a person by id hint, email or full name.
 * Projects and organisations match the event's project or a whole-word name in the title.
 * Ollie himself is left out.
 */
function matchEvent(e: CalendarEvent, m: Matchers): EventMatch {
  const details: CalendarAttendee[] = e.attendeeDetails?.length ? e.attendeeDetails : e.attendees.map((name) => ({ name }));
  const byEmail = new Map(m.people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]));
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
  return { attendees, personIds, projectIds, orgIds };
}

/** Feature 03 rule 1: not personal, and a known attendee or organisation, or a project. */
function eligible(e: CalendarEvent, match: EventMatch): boolean {
  return !e.personal && (match.personIds.length > 0 || match.orgIds.length > 0 || match.projectIds.length > 0);
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

  const [goals, promises, documents, playbooks] = await Promise.all([
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
    linkedPlaybooks(projectIds, match.orgIds),
  ]);
  return {
    event,
    match,
    projectIds,
    goalIds: [...new Set(goals.map((g) => g.goalId).filter((x): x is number => x != null))],
    promiseIds: promises.map((p) => p.id),
    documentIds: documents ? (documents.rows as { id: number }[]).map((r) => Number(r.id)) : [],
    playbookIds: playbooks,
  };
}

/** Enabled playbooks linked to any of the projects or organisations: the brief's watch-outs. */
async function linkedPlaybooks(projectIds: number[], orgIds: number[]): Promise<number[]> {
  if (!projectIds.length && !orgIds.length) return [];
  const list = (xs: number[]) => (xs.length ? sql.join(xs.map((x) => sql`${x}`), sql`, `) : sql`null`);
  const res = await db.execute(sql`
    select pb.id from playbooks pb where pb.enabled and exists (select 1 from links l where
      (l.from_type = 'playbook' and l.from_id = pb.id and ((l.to_type = 'project' and l.to_id in (${list(projectIds)})) or (l.to_type = 'organisation' and l.to_id in (${list(orgIds)}))))
      or (l.to_type = 'playbook' and l.to_id = pb.id and ((l.from_type = 'project' and l.from_id in (${list(projectIds)})) or (l.from_type = 'organisation' and l.from_id in (${list(orgIds)})))))
    order by pb.id`);
  return (res.rows as { id: number }[]).map((r) => Number(r.id));
}

/* ---------- Writing the brief ---------- */

function contextRefs(c: ContextOut): string[] {
  return [
    c.entity.ref,
    ...c.facts.map((x) => x.ref),
    ...c.decisions.slice(0, 8).map((x) => x.ref),
    ...c.promises.map((x) => x.ref),
    ...c.waiting_on_them.map((x) => x.ref),
    ...c.open_tasks.slice(0, 10).map((x) => x.ref),
    ...c.notes.slice(0, 6).map((x) => x.ref),
    ...c.recent_activity.slice(0, 8).map((x) => x.ref),
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
  ];
  const visible = await visibleRefs(scope, entityRefs);
  const heldBack = entityRefs.filter((r) => !visible.has(r));

  // Feature 03 rule 3: get_context for each attendee and linked project, plus promises and playbooks.
  const refs: string[] = [];
  for (const r of entityRefs.filter((x) => visible.has(x) && !x.startsWith("organisation:"))) {
    const ctx = await getContext(scope, { ref: r }, "meeting_brief");
    if (ctx) refs.push(...contextRefs(ctx));
  }
  refs.push(...match.orgIds.map((id) => toRef("organisation", id)).filter((r) => visible.has(r)));
  refs.push(...inputs.promiseIds.map((id) => toRef("task", id)));
  const items = await loadVisibleDocs(scope, [...new Set(refs)]);
  const playbooks = await loadVisibleDocs(scope, await applicablePlaybookRefs(scope, entityRefs.filter((r) => visible.has(r))));
  await recordReads(scope, [...items, ...playbooks].map((d) => d.ref), { via: "meeting_brief", event: event.id });

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
    .update(JSON.stringify({ meeting, docs: [...playbooks, ...items].map((d) => d.text) }))
    .digest("hex");
  const now = new Date();
  if (existing && !existing.failed && existing.inputsHash === hash && !opts.force) {
    const [row] = await db.update(meetingBriefsTable).set({ generatedAt: now }).where(eq(meetingBriefsTable.id, existing.id)).returning();
    return row;
  }

  // Facts, emails and notes, not just the names of the people and projects.
  const substance = items.filter((d) => !["person", "project", "organisation"].includes(d.type));
  let why: BriefLine[] | null = null;
  let questions: BriefLine[] | null = null;
  let questionsNote: string | null = null;
  let failed = false;
  let model: string | null = null;
  if (substance.length) {
    try {
      const out = await writeBriefFromDocs(meeting, [...playbooks, ...items]);
      const allowed = new Set(items.map((d) => d.ref));
      const w = keepCited(out.why, allowed, true, 4);
      // Feature 03 rule 5: nothing citable means "Not much on file", never padding.
      if (w.length) {
        why = w;
        questions = keepCited(out.questions, allowed, false, 5);
        questionsNote = out.questionsNote || null;
      }
      model = "anthropic";
    } catch (err) {
      logger.error({ err, eventId: event.id }, "Meeting brief failed");
      if (existing && !existing.failed) return existing;
      failed = true;
    }
  }

  const citedIds = [...new Set([...(why ?? []), ...(questions ?? [])].flatMap((l) => l.cited))];
  const inputRefs = [...items, ...playbooks].map((d) => d.ref);
  const plain = await visibleRefs(defaultScope(), inputRefs);
  const values = {
    calendarEventId: event.id,
    generatedAt: now,
    why,
    questions,
    questionsNote,
    attendeeIds: match.personIds,
    projectIds: inputs.projectIds,
    goalIds: inputs.goalIds,
    promiseIds: inputs.promiseIds,
    documentIds: inputs.documentIds,
    playbookIds: inputs.playbookIds,
    citedIds,
    inputRefs,
    heldBack,
    inputsHash: failed ? null : hash,
    usedConfidential: inputRefs.some((r) => !plain.has(r)),
    failed,
    model,
  };
  return db.transaction(async (tx) => {
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
 * When a sweep finishes: briefs for today's and tomorrow's work meetings that have not started,
 * so each is ready well before the 30 minutes ahead it is needed (criterion 1).
 */
export async function buildUpcomingBriefs(now = new Date()): Promise<{ built: number; unchanged: number; failed: number }> {
  const range = londonRange(todayLondon(now), 2);
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

export interface BriefView {
  event: { id: number; title: string; startsAt: Date; endsAt: Date; location: string | null; platform: string | null };
  generatedAt: Date;
  failed: boolean;
  notMuch: boolean;
  sourcesLine: string | null;
  why: { text: string; sources: BriefSource[] }[] | null;
  questions: { text: string; sources: BriefSource[] }[] | null;
  questionsNote: string | null;
  attendees: {
    name: string;
    email: string | null;
    response: string | null;
    organiser: boolean;
    person: { id: number; slug: string; name: string; role: string | null; organisation: string | null; confidential: boolean; lastContactAt: Date | null } | null;
  }[];
  promises: { id: number; title: string; source: string; capturedAt: Date; dueDate: string | null; personName: string | null }[];
  projects: { id: number; slug: string; name: string; confidential: boolean }[];
  goals: { id: number; name: string }[];
  documents: { id: number; title: string; url: string; location: string }[];
  playbooks: { id: number; title: string; rule: string }[];
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
      : none<{ id: number; title: string; url: string }>(),
    ids("goal").length ? db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, ids("goal"))) : none<{ id: number; name: string }>(),
    ids("playbook").length
      ? db.select({ id: playbooksTable.id, title: playbooksTable.title }).from(playbooksTable).where(inArray(playbooksTable.id, ids("playbook")))
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
    } else if (p.type === "goal") {
      const g = goals.find((x) => x.id === pid);
      if (g) out.set(r, { ref: r, label: g.name, href: "/goals", external: false });
    } else if (p.type === "playbook") {
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

async function viewOf(event: CalendarEvent, brief: MeetingBrief, inputs: BriefInputs): Promise<BriefView> {
  const people = inputs.match.personIds;
  const [personRows, promiseRows, projectRows, goalRows, docRows, bookRows, actionRows] = await Promise.all([
    people.length
      ? db
          .select({
            id: peopleTable.id,
            slug: peopleTable.slug,
            name: peopleTable.name,
            role: peopleTable.role,
            confidential: peopleTable.confidential,
            lastContactAt: peopleTable.lastContactAt,
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
    inputs.playbookIds.length
      ? db.select({ id: playbooksTable.id, title: playbooksTable.title, rule: playbooksTable.rule }).from(playbooksTable).where(inArray(playbooksTable.id, inputs.playbookIds))
      : [],
    brief.actionTaskIds.length
      ? db.select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status }).from(tasksTable).where(inArray(tasksTable.id, brief.actionTaskIds)).orderBy(asc(tasksTable.id))
      : [],
  ]);
  const sources = await sourcesFor(brief.citedIds);
  const withSources = (lines: BriefLine[] | null) =>
    lines ? lines.map((l) => ({ text: l.text, sources: l.cited.map((r) => sources.get(r)).filter((s): s is BriefSource => !!s) })) : null;
  const byPerson = new Map(personRows.map((p) => [p.id, p]));
  const order = (ids: number[]) => (a: { id: number }, b: { id: number }) => ids.indexOf(a.id) - ids.indexOf(b.id);

  return {
    event: { id: event.id, title: event.title, startsAt: event.startsAt, endsAt: event.endsAt, location: event.location, platform: event.platform },
    generatedAt: brief.generatedAt,
    failed: brief.failed,
    notMuch: !brief.why && !brief.failed,
    sourcesLine: await sourcesLine(brief.citedIds),
    why: withSources(brief.why),
    questions: withSources(brief.questions),
    questionsNote: brief.questionsNote,
    attendees: inputs.match.attendees.map((a) => {
      const p = a.personId != null ? byPerson.get(a.personId) : undefined;
      return {
        name: p?.name ?? a.name,
        email: a.email ?? null,
        response: a.response ?? null,
        organiser: !!a.organiser,
        person: p ? { id: p.id, slug: p.slug, name: p.name, role: p.role, organisation: p.organisation, confidential: p.confidential, lastContactAt: p.lastContactAt } : null,
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
    projects: projectRows.sort(order(inputs.projectIds)),
    goals: goalRows,
    documents: docRows,
    playbooks: bookRows,
    heldBack: brief.heldBack.length,
    notes: brief.notes,
    granolaNotes: brief.granolaNotes,
    granolaRef: brief.granolaRef,
    actions: actionRows,
  };
}

export async function updateBriefNotes(eventId: number, notes: string | null): Promise<string | null> {
  const brief = await loadBrief(eventId);
  if (!brief) throw new NotFoundError("That brief does not exist");
  const text = notes?.trim() ? notes.slice(0, 20000) : null;
  await db.transaction(async (tx) => {
    await tx.update(meetingBriefsTable).set({ notes: text }).where(eq(meetingBriefsTable.id, brief.id));
    await writeAudit(tx, { actor: "ollie", action: "update", entityType: "meeting_brief", entityId: brief.id, payload: { notes: text ? text.length : 0 } });
  });
  return text;
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

export async function findEventBySourceRef(sourceRef: string): Promise<CalendarEvent | null> {
  const [event] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, sourceRef));
  return event ?? null;
}

/** Attaches notes and action task ids to an event's brief, writing the brief first if there is none. */
export async function attachMeetingNotes(
  event: CalendarEvent,
  input: { granolaRef: string; notes: string; actionTaskIds: number[]; actor: string; clientId: number | null },
): Promise<MeetingBrief> {
  if (event.personal) throw new ConflictError("Personal events have no brief");
  let brief = await loadBrief(event.id);
  if (!brief) {
    const inputs = await gatherInputs(event);
    if (!inputs) throw new ConflictError("This meeting has no brief: no one on it is known to OllieOS");
    brief = await generate(inputs, null);
  }
  const ids = [...new Set([...brief.actionTaskIds, ...input.actionTaskIds])];
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(meetingBriefsTable)
      .set({ granolaRef: input.granolaRef, granolaNotes: input.notes.slice(0, 50000), actionTaskIds: ids })
      .where(eq(meetingBriefsTable.id, brief!.id))
      .returning();
    await writeAudit(tx, {
      actor: input.actor,
      clientId: input.clientId,
      action: "attach_notes",
      entityType: "meeting_brief",
      entityId: row.id,
      payload: { granolaRef: input.granolaRef, actions: input.actionTaskIds },
    });
    return row;
  });
}

/* ---------- For AI tools (get_meeting_brief, ollieos://brief/next) ---------- */

export interface BriefOut {
  event: { ref: string; title: string; starts_at: string; ends_at: string; platform: string | null; location: string | null };
  generated_at: string;
  not_much_on_file: boolean;
  why: { text: string; refs: string[] }[];
  questions: { text: string; refs: string[] }[];
  questions_note: string | null;
  attendees: { name: string; response: string | null; person: string | null }[];
  promises: { ref: string; title: string; due_date: string | null }[];
  projects: { ref: string; name: string }[];
  goals: { ref: string; name: string }[];
  documents: { ref: string; title: string; url: string }[];
  playbooks: { ref: string; title: string; rule: string }[];
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
    ...inputs.playbookIds.map((id) => toRef("playbook", id)),
    ...promiseRefs,
  ];
  const ok = await visibleRefs(scope, all);
  const keep = (lines: BriefLine[] | null) => (lines ?? []).filter((l) => l.cited.every((r) => ok.has(r))).map((l) => ({ text: l.text, refs: l.cited }));
  const view = await viewOf(event, brief, inputs);
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
    questions_note: brief.why ? brief.questionsNote : null,
    attendees: view.attendees.filter((a) => !a.person || ok.has(toRef("person", a.person.id))).map((a) => ({
      name: a.name,
      response: a.response,
      person: a.person && ok.has(toRef("person", a.person.id)) ? toRef("person", a.person.id) : null,
    })),
    promises: view.promises.filter((p) => ok.has(toRef("task", p.id))).map((p) => ({ ref: toRef("task", p.id), title: p.title, due_date: p.dueDate })),
    projects: view.projects.filter((p) => ok.has(toRef("project", p.id))).map((p) => ({ ref: toRef("project", p.id), name: p.name })),
    goals: view.goals.filter((g) => ok.has(toRef("goal", g.id))).map((g) => ({ ref: toRef("goal", g.id), name: g.name })),
    documents: view.documents.filter((d) => ok.has(toRef("document", d.id))).map((d) => ({ ref: toRef("document", d.id), title: d.title, url: d.url })),
    playbooks: view.playbooks.filter((b) => ok.has(toRef("playbook", b.id))).map((b) => ({ ref: toRef("playbook", b.id), title: b.title, rule: b.rule })),
  };
  if (!out.why.length) out.questions = [];
  await recordReads(
    scope,
    [...out.why.flatMap((l) => l.refs), ...out.promises.map((p) => p.ref), ...out.projects.map((p) => p.ref), ...out.documents.map((d) => d.ref), ...out.playbooks.map((p) => p.ref)],
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
