/**
 * Daily digest (feature 08): what changed since 18:00 on the previous working day (build plan 35).
 * Built on the first sweep finish of a weekday (question 32), or on open if a sweep has finished
 * today and there is none yet. No email in phase 1 (question 33). Kept 30 days.
 */
import { weekCheck } from "./timeAndMeetings";
import { listPulses } from "./clientPulse";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  connectorRunsTable,
  db,
  digestsTable,
  linksTable,
  organisationsTable,
  peopleTable,
  sweepRunsTable,
  tasksTable,
  type Digest,
  type DigestItem,
  type DigestSection,
  type DigestSections,
} from "@workspace/db";
import { addDays, formatLong, formatTime, isIsoDate, londonRange, londonWallTimeToInstant, todayLondon, toRef, weekday, parseRef } from "@workspace/shared";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { askScope } from "./ask/ask";
import { digestSummaryFromLines } from "./ask/model";
import { workTypesOf } from "./knowledge/functions";
import { recordCheck } from "./writerChecks";
import { briefableIds, notPreppedIds } from "./briefs";
import { listCadence } from "./cadence";
import { inboxCounts } from "./knowledgeInbox";
import { clearOutMonday, untouchedCount } from "./planning";
import { slackRepliesOverdue } from "./slackToAnswer";
import { connectorWarnings } from "./connectorHealth";
import { stuckCount } from "./stuckTasks";
import { readyCount } from "./workPack";
import { changedDocuments, changedText } from "./documentChanges";
import { closedByEvidence } from "./taskEvidence";
import { dueIdeas } from "./strategy";
import { NotFoundError, ValidationError } from "./tasks";

const SECTION_MAX = 5;
const QUIET_MAX = 3;
const KEEP_DAYS = 30;
export const QUIET_NIGHT = "Quiet night.";

export const isWeekday = (date: string) => ![0, 6].includes(weekday(date));

/** 18:00 London on the working day before `date` (Friday for a Monday). */
export function digestWindowStart(date: string): Date {
  let prev = addDays(date, -1);
  while (!isWeekday(prev)) prev = addDays(prev, -1);
  return londonWallTimeToInstant(prev, 18, 0);
}

const hrs = (n: number) => (n === 1 ? "1 hour" : `${n} hours`);
const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The refs among these that are a client-work project, or a task on one. */
async function clientWorkRefs(refs: string[]): Promise<Set<string>> {
  const parsed = refs.map((r) => ({ r, p: parseRef(r) })).filter((x) => x.p && (x.p.type === "project" || x.p.type === "task"));
  if (!parsed.length) return new Set();
  const taskIds = parsed.filter((x) => x.p!.type === "task").map((x) => x.p!.id);
  const taskProject = new Map(
    taskIds.length ? (await db.select({ id: tasksTable.id, projectId: tasksTable.projectId }).from(tasksTable).where(inArray(tasksTable.id, taskIds))).map((t) => [t.id, t.projectId]) : [],
  );
  const projectOf = (x: { p: { type: string; id: number } | null }) => (x.p!.type === "project" ? x.p!.id : (taskProject.get(x.p!.id) ?? null));
  const work = await workTypesOf(parsed.map(projectOf).filter((id): id is number => id != null));
  return new Set(parsed.filter((x) => { const id = projectOf(x); return id != null && work.get(id) === "client"; }).map((x) => x.r));
}

function section(items: DigestItem[], moreHref: string | null, max = SECTION_MAX): DigestSection | null {
  if (!items.length) return null;
  return { items: items.slice(0, max), more: Math.max(0, items.length - max), moreHref };
}

const SOURCE_WORDS: Record<string, string> = { email: "email", slack: "Slack", meeting: "meeting", quarterly: "quarterly", manual: "added by you", session: "Cowork" };

/** Everything the sections need, read straight from the database (Ollie's view). */
async function gather(date: string, since: Date, now: Date) {
  const day = londonRange(date, 1);
  const soon = addDays(date, 3);
  const [inbox, deadline, done, promises, newPeople, waiting, events, knowledge, cadence, ideas] = await Promise.all([
    db
      .select({ source: tasksTable.source, n: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "inbox"), gte(sql`coalesce(${tasksTable.capturedAt}, ${tasksTable.createdAt})`, since)))
      .groupBy(tasksTable.source),
    db
      .select({ id: tasksTable.id, title: tasksTable.title, dueDate: tasksTable.dueDate })
      .from(tasksTable)
      .where(and(inArray(tasksTable.status, ["now", "backlog", "waiting", "inbox"]), isNotNull(tasksTable.dueDate), sql`${tasksTable.dueDate} <= ${soon}`))
      .orderBy(asc(tasksTable.dueDate), sql`case ${tasksTable.priority} when 'high' then 0 when 'medium' then 1 else 2 end`)
      .limit(1),
    db
      .select({ id: tasksTable.id, title: tasksTable.title })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, since), lt(tasksTable.completedAt, now)))
      .orderBy(desc(tasksTable.completedAt)),
    db
      .select({ id: tasksTable.id, title: tasksTable.title })
      .from(tasksTable)
      .where(and(eq(tasksTable.kind, "promise"), notInArray(tasksTable.status, ["noise", "dropped", "archived"]), gte(tasksTable.createdAt, since)))
      .orderBy(asc(tasksTable.createdAt)),
    db
      .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, role: peopleTable.role, org: organisationsTable.name, autoAddedAt: peopleTable.autoAddedAt })
      .from(peopleTable)
      .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
      .where(and(gte(peopleTable.createdAt, since), eq(peopleTable.isSelf, false)))
      .orderBy(asc(peopleTable.createdAt)),
    db
      .selectDistinct({ personId: tasksTable.waitingOnPersonId })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "waiting"), isNotNull(tasksTable.waitingOnPersonId))),
    db
      .select()
      .from(calendarEventsTable)
      .where(and(gte(calendarEventsTable.startsAt, day.start), lt(calendarEventsTable.startsAt, day.end), eq(calendarEventsTable.personal, false)))
      .orderBy(asc(calendarEventsTable.startsAt)),
    inboxCounts(),
    listCadence("overdue", date),
    dueIdeas(date),
  ]);

  // Replies on Waiting on: email or Slack since the window from someone Ollie is waiting on.
  const waitingIds = waiting.map((w) => w.personId).filter((x): x is number => x != null);
  let replies: { id: number; summary: string; personId: number; name: string; slug: string }[] = [];
  if (waitingIds.length) {
    const linked = await db
      .select({ activityId: linksTable.fromId, personId: linksTable.toId })
      .from(linksTable)
      .where(and(eq(linksTable.fromType, "activity"), eq(linksTable.toType, "person"), inArray(linksTable.toId, waitingIds)));
    const acts = await db
      .select()
      .from(activityTable)
      .where(
        and(
          inArray(activityTable.kind, ["email", "slack"]),
          gte(activityTable.occurredAt, since),
          or(
            and(eq(activityTable.entityType, "person"), inArray(activityTable.entityId, waitingIds)),
            linked.length ? inArray(activityTable.id, linked.map((l) => l.activityId)) : sql`false`,
          ),
        ),
      )
      .orderBy(asc(activityTable.occurredAt));
    const people = new Map(
      (await db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(inArray(peopleTable.id, waitingIds))).map((p) => [p.id, p]),
    );
    const seen = new Set<number>();
    for (const a of acts) {
      const pid = a.entityType === "person" && a.entityId != null && people.has(a.entityId) ? a.entityId : linked.find((l) => l.activityId === a.id)?.personId;
      const p = pid != null ? people.get(pid) : undefined;
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      replies.push({ id: a.id, summary: a.summary, personId: p.id, name: p.name, slug: p.slug });
    }
  }
  replies = replies.slice(0, 20);

  return { inbox, deadline: deadline[0] ?? null, done, promises, newPeople, replies, events, knowledge, cadence, ideas };
}

async function buildSections(date: string, since: Date, now: Date): Promise<DigestSections> {
  const g = await gather(date, since, now);
  const needs: DigestItem[] = [];
  const inboxTotal = g.inbox.reduce((n, r) => n + r.n, 0);
  if (inboxTotal) {
    const parts = [...g.inbox].sort((a, b) => b.n - a.n).map((r) => `${r.n} ${SOURCE_WORDS[r.source] ?? r.source}`);
    needs.push({ text: `${plural(inboxTotal, "new item", "new items")} in your Inbox (${parts.join(", ")})`, href: "/triage", refs: [], confidential: false });
  }
  // Part K: today's external meetings whose prep page has not been opened.
  const unprepped = await notPreppedIds(g.events, now);
  for (const e of g.events.filter((x) => unprepped.has(x.id))) {
    needs.push({ text: `Not prepped yet: ${clip(e.title, 70)} at ${formatTime(e.startsAt)}`, href: `/briefs/${e.id}`, refs: [], confidential: false });
  }
  // Part R: on Mondays, warn when this week is over full.
  if (weekday(date) === 1) {
    const wc = await weekCheck(now);
    if (wc.over) needs.push({ text: `This week is over by about ${hrs(wc.overBy)}: ${hrs(wc.dueHours)} due against ${wc.freeHours} free`, href: "/", refs: [], confidential: false });
  }
  // Connector warnings (Part Q): a service that stopped working, or stopped bringing anything in.
  for (const w of await connectorWarnings(now)) needs.push({ text: w.text, href: "/settings/connectors", refs: [], confidential: false });
  // Slack to answer (Part P): only messages that have waited over a working day.
  const slackWaiting = await slackRepliesOverdue(now);
  if (slackWaiting) {
    needs.push({ text: `${plural(slackWaiting, "Slack message", "Slack messages")} to answer, waiting over a working day`, href: "/messages?tab=to-answer&from=slack", refs: [], confidential: false });
  }
  if (g.deadline?.dueDate) {
    const d = g.deadline.dueDate;
    const when = d < date ? `was due ${formatLong(d)}` : d === date ? "is due today" : `is due ${formatLong(d)}`;
    needs.push({ text: `"${clip(g.deadline.title)}" ${when}`, href: `/tasks?task=${g.deadline.id}`, refs: [toRef("task", g.deadline.id)], confidential: false });
  }
  if (g.knowledge.total) {
    const extra = [g.knowledge.conflicts && plural(g.knowledge.conflicts, "conflict", "conflicts"), g.knowledge.stale && plural(g.knowledge.stale, "fact to check", "facts to check")].filter(Boolean);
    needs.push({
      text: `${plural(g.knowledge.total, "item", "items")} to review in your Knowledge Inbox${extra.length ? `, including ${extra.join(" and ")}` : ""}`,
      href: "/knowledge/inbox",
      refs: [],
      confidential: false,
    });
  }

  // Ideas Ollie asked to come back to, on their day (Part H). One line, or one per idea when few.
  if (g.ideas.length === 1) {
    const i = g.ideas[0];
    needs.push({ text: `Idea to come back to: ${clip(i.title)}`, href: `/strategy?idea=${i.id}`, refs: [toRef("idea", i.id)], confidential: false });
  } else if (g.ideas.length > 1) {
    needs.push({
      text: `${plural(g.ideas.length, "idea", "ideas")} to come back to, starting with ${clip(g.ideas[0].title, 60)}`,
      href: "/strategy?tab=come_back",
      refs: g.ideas.map((i) => toRef("idea", i.id)),
      confidential: false,
    });
  }

  // Section 27: tasks whose work is already done and only need sending.
  const ready = await readyCount();
  if (ready) needs.push({ text: `${plural(ready, "task is", "tasks are")} ready to send: what they need already exists`, href: "/tasks?ready=1", refs: [], confidential: false });

  // Section 26: on Mondays, tasks that keep slipping, each with a way out on its panel.
  if (weekday(date) === 1) {
    const stuck = await stuckCount(now);
    if (stuck) needs.push({ text: `${plural(stuck, "task looks", "tasks look")} stuck, each with a way out`, href: "/tasks?stuck=1", refs: [], confidential: false });
  }

  // Every other Monday: the Backlog clear-out (Part I).
  if (clearOutMonday(date) === date) {
    const untouched = await untouchedCount(now);
    if (untouched) {
      needs.push({
        text: `Clear out your Backlog: ${untouched} untouched for 30 days or more`,
        href: "/clear-out",
        refs: [],
        confidential: false,
      });
    }
  }

  // Part U: tasks OllieOS closed from their own conversation say how it knew.
  const how = await closedByEvidence(g.done.map((t) => t.id));
  const moved: DigestItem[] = [
    ...g.done.map((t) => ({ text: `Done${how.has(t.id) ? ` (${how.get(t.id)})` : ""}: ${clip(t.title)}`, href: `/tasks?task=${t.id}`, refs: [toRef("task", t.id)], confidential: false })),
    ...g.replies.map((r) => ({
      text: `${r.name} replied: ${clip(r.summary, 80)}`,
      href: `/knowledge/people/${r.slug}`,
      refs: [toRef("activity", r.id), toRef("person", r.personId)],
      confidential: false,
    })),
    ...g.promises.map((t) => ({ text: `You promised: ${clip(t.title)}`, href: `/tasks?task=${t.id}`, refs: [toRef("task", t.id)], confidential: false })),
    ...g.newPeople.map((p) => ({
      // Section 25: someone the contact finder added by itself says so, with Undo on Contacts.
      text: `${p.autoAddedAt ? "Added to Contacts by OllieOS" : "New person"}: ${p.name}${p.role || p.org ? `, ${[p.role, p.org].filter(Boolean).join(" at ")}` : ""}`,
      href: `/knowledge/people/${p.slug}`,
      refs: [toRef("person", p.id)],
      confidential: false,
    })),
  ];

  const quietPeople = g.cadence.people;
  // Part S: client organisations with no contact for their quiet period join Gone quiet.
  const quietClients: DigestItem[] = (await listPulses(now))
    .filter((p) => p.reasons.some((r) => r.startsWith("No contact")))
    .map((p) => ({ text: `${p.name}: ${p.reasons.find((r) => r.startsWith("No contact"))!.toLowerCase()}`, href: `/knowledge/organisations/${p.slug}`, refs: [toRef("organisation", p.organisationId)], confidential: false }));
  const quiet: DigestItem[] = [...quietClients, ...quietPeople.map((p) => ({
    text: `${p.name}${p.organisation ? `, ${p.organisation.name}` : ""}: ${p.lastContactAt ? `no contact since ${formatLong(p.lastContactAt)}` : "no contact on file"}`,
    href: `/knowledge/people/${p.slug}`,
    refs: [toRef("person", p.id)],
    confidential: false,
  }))];

  // Library documents someone else changed since the last digest (Part Q). Hidden ones have no AI line.
  const changed: DigestItem[] = (await changedDocuments(since, now)).map((d) => ({
    text: changedText(d),
    href: `/knowledge/library?document=${d.documentId}`,
    refs: [toRef("document", d.documentId)],
    confidential: d.hidden,
  }));

  // Lock what is hidden from AI by default, so Ollie can see what an email would leave unnamed.
  const all = [...needs, ...moved, ...quiet, ...changed];
  const plain = await visibleRefs(defaultScope(), all.flatMap((i) => i.refs));
  for (const i of all) i.confidential = i.refs.some((r) => !plain.has(r));

  // Client work first in each section: items about a client project, or a task on one.
  const clientRefs = await clientWorkRefs(all.flatMap((i) => i.refs));
  for (const list of [needs, moved, quiet, changed]) {
    const first = list.filter((i) => i.refs.some((r) => clientRefs.has(r)));
    if (first.length && first.length < list.length) list.splice(0, list.length, ...first, ...list.filter((i) => !first.includes(i)));
  }

  const briefable = await briefableIds(g.events);
  const today = g.events.map((e) => ({ eventId: e.id, title: e.title, startsAt: e.startsAt.toISOString(), hasBrief: briefable.has(e.id) }));
  const quietNight = !needs.length && !moved.length && !changed.length;
  return {
    needs: quietNight ? null : section(needs, null),
    moved: quietNight ? null : section(moved, "/tasks?tab=done"),
    quiet: quietNight ? null : section(quiet, "/contacts?filter=overdue", QUIET_MAX),
    changed: quietNight ? null : section(changed, "/knowledge/library"),
    today,
    quietNight,
  };
}

/** The summary sentence from AI-visible items only; hidden items are counted, never named. */
async function summarise(sections: DigestSections): Promise<string | null> {
  if (sections.quietNight) return QUIET_NIGHT;
  const scope = await askScope();
  const items = [
    ...(sections.needs?.items ?? []).map((i) => ({ ...i, group: "Needs you" })),
    ...(sections.moved?.items ?? []).map((i) => ({ ...i, group: "Moved" })),
    ...(sections.quiet?.items ?? []).map((i) => ({ ...i, group: "Gone quiet" })),
    ...(sections.changed?.items ?? []).map((i) => ({ ...i, group: "Changed" })),
  ];
  const ok = await visibleRefs(scope, items.flatMap((i) => i.refs));
  const lines = items.map((i) => `${i.group}: ${i.refs.every((r) => ok.has(r)) ? i.text : "an item hidden from AI (do not name or guess it)"}`);
  if (sections.today.length) lines.push(`Today: ${plural(sections.today.length, "work meeting", "work meetings")}`);
  try {
    return (await digestSummaryFromLines(lines)) || null;
  } catch (err) {
    logger.error({ err }, "Digest summary failed");
    return null;
  }
}

export async function buildDigest(date: string, now = new Date()): Promise<Digest> {
  const since = digestWindowStart(date);
  const sections = await buildSections(date, since, now);
  const summary = await summarise(sections);
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(digestsTable)
      .values({ forDate: date, windowStart: since, summary, sections })
      .onConflictDoUpdate({ target: digestsTable.forDate, set: { windowStart: since, summary, sections, createdAt: now } })
      .returning();
    await writeAudit(tx, {
      actor: "OllieOS",
      action: "build",
      entityType: "digest",
      entityId: row.id,
      payload: { date, quietNight: sections.quietNight, summary: summary != null },
    });
    return row;
  });
  // Part Y: code checks on the AI summary (asked for under 35 words, one sentence).
  if (summary && summary !== QUIET_NIGHT) await recordCheck("digest_summary", `digest:${saved.id}`, summary, { maxWords: 35 });
  return saved;
}

/** When a sweep finishes: the digest for today, once, on weekdays. */
export async function buildDigestIfDue(now = new Date()): Promise<{ built: boolean; date: string }> {
  const date = todayLondon(now);
  if (!isWeekday(date)) return { built: false, date };
  const [existing] = await db.select({ id: digestsTable.id }).from(digestsTable).where(eq(digestsTable.forDate, date));
  if (existing) return { built: false, date };
  await buildDigest(date, now);
  return { built: true, date };
}

export async function clearOldDigests(now = new Date()): Promise<number> {
  const cutoff = addDays(todayLondon(now), -KEEP_DAYS);
  const rows = await db.delete(digestsTable).where(lt(digestsTable.forDate, cutoff)).returning({ id: digestsTable.id });
  return rows.length;
}

/** Fresh data arrived today: a Claude sweep finished, or OllieOS read a service itself after 07:40. */
async function sweepFinishedToday(now: Date): Promise<boolean> {
  const today = todayLondon(now);
  const day = londonRange(today, 1);
  const [row] = await db
    .select({ id: sweepRunsTable.id })
    .from(sweepRunsTable)
    .where(and(gte(sweepRunsTable.finishedAt, day.start), lt(sweepRunsTable.finishedAt, day.end)))
    .limit(1);
  if (row) return true;
  const [own] = await db
    .select({ id: connectorRunsTable.id })
    .from(connectorRunsTable)
    .where(and(eq(connectorRunsTable.ok, true), gte(connectorRunsTable.startedAt, londonWallTimeToInstant(today, 7, 40)), lt(connectorRunsTable.startedAt, day.end)))
    .limit(1);
  return !!own;
}

export interface DigestView {
  /** Part Y: for thumbs */
  id: number;
  date: string;
  windowStart: Date;
  summary: string | null;
  sections: DigestSections;
  createdAt: Date;
}

const toView = (d: Digest): DigestView => ({ id: d.id, date: d.forDate, windowStart: d.windowStart, summary: d.summary, sections: d.sections, createdAt: d.createdAt });

/**
 * One day's digest. For today, it is built on open if a sweep has finished today and the sweep's
 * own build did not run (a failure there never fails the sweep).
 */
export async function getDigest(dateOrToday: string, now = new Date()): Promise<DigestView> {
  const today = todayLondon(now);
  const date = dateOrToday === "today" ? today : dateOrToday;
  if (!isIsoDate(date)) throw new ValidationError("Use a date like 2026-11-10, or today");
  const [row] = await db.select().from(digestsTable).where(eq(digestsTable.forDate, date));
  if (row) return toView(row);
  if (date === today && isWeekday(date) && (await sweepFinishedToday(now))) return toView(await buildDigest(date, now));
  throw new NotFoundError(date === today ? "Today's digest is written after the first check from 07:40 on a weekday morning" : "There is no digest for that day");
}

/** Dates with a digest, newest first, for the list of past digests. */
export async function listDigests(): Promise<{ date: string; summary: string | null }[]> {
  const rows = await db.select({ date: digestsTable.forDate, summary: digestsTable.summary }).from(digestsTable).orderBy(desc(digestsTable.forDate)).limit(KEEP_DAYS + 1);
  return rows;
}

/** For Home: today's digest date when it exists. */
export async function todaysDigestDate(now = new Date()): Promise<string | null> {
  const date = todayLondon(now);
  const [row] = await db.select({ d: digestsTable.forDate }).from(digestsTable).where(eq(digestsTable.forDate, date));
  return row?.d ?? null;
}


