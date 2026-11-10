/**
 * Turns sorted email and Slack exchanges into Inbox items and Activity entries.
 *
 * Messages that match one of Ollie's noise rules are dropped before the AI sees them. Every item
 * goes through captureTask, so the usual duplicate check (by source_ref) and noise rules apply,
 * and items land in the Inbox for Ollie to triage. Activity is only logged for exchanges with
 * someone in People, or about a project, so the log does not fill up with strangers.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, peopleTable, projectsTable, type NoiseRule } from "@workspace/db";
import { captureTask, enabledRules, logActivity, matchNoiseRule, type CaptureWriter } from "../aiWrites";
import type { WorkUnit } from "./messages";
import { sortUnits, type SortedUnit } from "./sorter";

export const CONNECTOR_WRITER: CaptureWriter = { actor: "ollieos", clientId: null };

export interface CaptureCounts {
  inbox: number;
  promises: number;
  waiting: number;
  noise: number;
  duplicate: number;
  noise_rule: number;
  activity: number;
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

export type PersonRow = { id: number; name: string; email: string | null; confidential: boolean };

export async function loadPeople(units: WorkUnit[], sorted: SortedUnit[]): Promise<{ byEmail: Map<string, PersonRow>; byName: Map<string, PersonRow> }> {
  const emails = new Set<string>();
  const names = new Set<string>();
  for (const u of units) {
    for (const p of u.people) {
      if (p.email) emails.add(p.email.toLowerCase());
      if (p.name) names.add(p.name.toLowerCase());
    }
    for (const m of u.messages) if (m.fromAddress) emails.add(m.fromAddress.toLowerCase());
  }
  for (const s of sorted) for (const it of s.items) if (it.person) (it.person.includes("@") ? emails : names).add(it.person.toLowerCase().trim());
  const cols = { id: peopleTable.id, name: peopleTable.name, email: peopleTable.email, confidential: peopleTable.confidential };
  const none: PersonRow[] = [];
  const [a, b] = await Promise.all([
    emails.size ? db.select(cols).from(peopleTable).where(inArray(sql`lower(${peopleTable.email})`, [...emails])) : none,
    names.size ? db.select(cols).from(peopleTable).where(inArray(sql`lower(${peopleTable.name})`, [...names])) : none,
  ]);
  return {
    byEmail: new Map(a.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p])),
    byName: new Map(b.map((p) => [p.name.toLowerCase(), p])),
  };
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
  const sorted = await sortUnits(keep, { me: ctx.me, projects: choices.map((p) => p.name), now: ctx.now });
  await captureSorted(keep, sorted, { choices, rules, applyNoise: true, counts });
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
      const sender = msg.fromMe ? null : msg.fromAddress ? (people.byEmail.get(msg.fromAddress.toLowerCase()) ?? null) : null;
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
      const row = (p.email && people.byEmail.get(p.email.toLowerCase())) || null;
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
