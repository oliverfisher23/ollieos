/**
 * Context packs (Part O): one Markdown file about a project, product or organisation for Ollie to
 * give Claude by hand. It holds only what AI may see (as if no access had been granted), each item
 * with its date and source, and says it is a copy as of the day it was made. The page is told how
 * many items were left out.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  documentsTable,
  factsTable,
  linksTable,
  organisationsTable,
  peopleTable,
  playbooksTable,
  productsTable,
  projectsTable,
  rulesTable,
} from "@workspace/db";
import { DOC_LOCATION_LABELS, PRODUCT_STATE_LABELS, formatDayMonth, formatLong, londonDate, todayLondon, toRef } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { decisionVisible, documentVisible, factVisible, personVisible, playbookVisible } from "../lib/ai-data/visibility";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { ruleContextFor, rulesFor } from "../lib/ai-data/direction";
import { ACTOR } from "./knowledge/common";
import { NotFoundError, ValidationError } from "./tasks";

/** "When: Any PwC material." with a full stop unless it already ends in one. */
const whenPart = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export type PackType = "project" | "product" | "organisation";

export interface ContextPack {
  fileName: string;
  content: string;
  madeAt: Date;
  /** Items in the file */
  included: number;
  /** Confidential or hidden items on the page that the file leaves out */
  leftOut: number;
}

const TYPE_LABEL: Record<PackType, string> = { project: "Project", product: "Product", organisation: "Organisation" };

/** "3rd November 2026" */
function day(d: Date | string): string {
  const iso = londonDate(d);
  return `${formatDayMonth(iso)} ${iso.slice(0, 4)}`;
}

const line = (s: string) => s.replace(/\s+/g, " ").trim();

async function loadEntity(type: PackType, id: number) {
  if (type === "project") {
    const [p] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
    return p ? { name: p.name, slug: p.slug, summary: p.summary, details: [p.area, p.status].filter((x): x is string => !!x) } : null;
  }
  if (type === "product") {
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    return p ? { name: p.name, slug: p.slug, summary: p.summary ?? p.description, details: [PRODUCT_STATE_LABELS[p.state]] } : null;
  }
  const [o] = await db.select().from(organisationsTable).where(eq(organisationsTable.id, id));
  return o ? { name: o.name, slug: o.slug, summary: o.summary, details: [o.type].filter((x): x is string => !!x) } : null;
}

/** Item ids linked to the entity either way, of one type. */
function linkedTo(type: PackType, id: number, other: string, column: unknown) {
  return sql`${column} in (select to_id from links where to_type = ${other} and from_type = ${type} and from_id = ${id}
    union select from_id from links where from_type = ${other} and to_type = ${type} and to_id = ${id})`;
}

export async function buildContextPack(type: PackType, id: number, now = new Date()): Promise<ContextPack> {
  const entity = await loadEntity(type, id);
  if (!entity) throw new NotFoundError(`That ${type} does not exist`);
  const ref = toRef(type, id);
  if (!(await visibleRefs(defaultScope(), [ref])).has(ref)) {
    throw new ValidationError(`This ${type} is hidden from AI or confidential, so there is nothing to download for Claude.`);
  }
  let leftOut = 0;
  let included = 0;

  // Facts on the entity
  const facts = await db
    .select({ id: factsTable.id, text: factsTable.text, source: factsTable.source, createdBy: factsTable.createdBy, createdAt: factsTable.createdAt, needsCheck: factsTable.needsCheck, ok: sql<boolean>`${sql.raw(factVisible("facts"))}` })
    .from(factsTable)
    .where(and(eq(factsTable.entityType, type), eq(factsTable.entityId, id), isNull(factsTable.supersededBy)))
    .orderBy(asc(factsTable.createdAt), asc(factsTable.id));

  // Decisions: a project's own, plus any linked; replaced ones are history and stay out.
  const decisions = await db
    .select({
      id: decisionsTable.id,
      text: decisionsTable.text,
      decidedAt: decisionsTable.decidedAt,
      decidedBy: decisionsTable.decidedBy,
      source: decisionsTable.source,
      ok: sql<boolean>`${sql.raw(decisionVisible("decisions"))}`,
    })
    .from(decisionsTable)
    .where(and(type === "project" ? or(eq(decisionsTable.projectId, id), linkedTo(type, id, "decision", decisionsTable.id)) : linkedTo(type, id, "decision", decisionsTable.id), isNull(decisionsTable.supersededBy)))
    .orderBy(desc(decisionsTable.decidedAt), desc(decisionsTable.id));

  // Rules that apply here: global ones and those linked to it and what it is part of.
  const context = await ruleContextFor(type, id);
  const rules = await rulesFor(defaultScope(), context);
  const ruleRows = rules.length
    ? await db.select({ id: rulesTable.id, createdAt: rulesTable.createdAt }).from(rulesTable).where(inArray(rulesTable.id, rules.map((r) => Number(r.ref.split(":")[1]))))
    : [];
  const contextIds = (t: string) => context.filter((r) => r.startsWith(`${t}:`)).map((r) => Number(r.split(":")[1]));
  const linkedRuleIds = new Set<number>();
  for (const t of ["project", "organisation", "product"] as const) {
    const ids = contextIds(t);
    if (!ids.length) continue;
    const rows = await db
      .select({ a: linksTable.fromId, b: linksTable.toId, fromType: linksTable.fromType })
      .from(linksTable)
      .where(or(and(eq(linksTable.fromType, "rule"), eq(linksTable.toType, t), inArray(linksTable.toId, ids)), and(eq(linksTable.toType, "rule"), eq(linksTable.fromType, t), inArray(linksTable.fromId, ids))));
    for (const r of rows) linkedRuleIds.add(r.fromType === "rule" ? r.a : r.b);
  }
  const enabledLinked = linkedRuleIds.size
    ? await db.select({ id: rulesTable.id }).from(rulesTable).where(and(inArray(rulesTable.id, [...linkedRuleIds]), eq(rulesTable.enabled, true)))
    : [];
  const sentRules = new Set(rules.map((r) => Number(r.ref.split(":")[1])));
  leftOut += enabledLinked.filter((r) => !sentRules.has(r.id)).length;

  // Playbooks in use linked to it, or to what it is part of.
  const playbookIds = new Set<number>();
  for (const t of ["project", "organisation", "product"] as const) {
    const ids = t === type ? [id, ...contextIds(t).filter((x) => x !== id)] : contextIds(t);
    if (!ids.length) continue;
    const rows = await db
      .select({ a: linksTable.fromId, b: linksTable.toId, fromType: linksTable.fromType })
      .from(linksTable)
      .where(or(and(eq(linksTable.fromType, "playbook"), eq(linksTable.toType, t), inArray(linksTable.toId, ids)), and(eq(linksTable.toType, "playbook"), eq(linksTable.fromType, t), inArray(linksTable.fromId, ids))));
    for (const r of rows) playbookIds.add(r.fromType === "playbook" ? r.a : r.b);
  }
  const playbooks = playbookIds.size
    ? await db
        .select({ id: playbooksTable.id, title: playbooksTable.title, whenToUse: playbooksTable.whenToUse, purpose: playbooksTable.purpose, steps: playbooksTable.steps, lastCheckedAt: playbooksTable.lastCheckedAt, ok: sql<boolean>`${sql.raw(playbookVisible("process_playbooks"))}` })
        .from(playbooksTable)
        .where(and(inArray(playbooksTable.id, [...playbookIds]), eq(playbooksTable.state, "in_use")))
        .orderBy(asc(playbooksTable.title))
    : [];

  // Linked documents: titles and links only.
  const documents = await db
    .select({ id: documentsTable.id, title: documentsTable.title, url: documentsTable.url, location: documentsTable.location, createdAt: documentsTable.createdAt, ok: sql<boolean>`${sql.raw(documentVisible("documents"))}` })
    .from(documentsTable)
    .where(linkedTo(type, id, "document", documentsTable.id))
    .orderBy(asc(documentsTable.title));

  // Who decides
  const deciders = await db
    .select({ id: peopleTable.id, name: peopleTable.name, role: peopleTable.role, since: linksTable.createdAt, ok: sql<boolean>`${sql.raw(personVisible("people"))}` })
    .from(linksTable)
    .innerJoin(peopleTable, eq(peopleTable.id, linksTable.fromId))
    .where(and(eq(linksTable.relationship, "decides_on"), eq(linksTable.fromType, "person"), eq(linksTable.toType, type), eq(linksTable.toId, id)))
    .orderBy(asc(peopleTable.name));

  // Steps can name people; only visible names are used.
  const stepPeople = [...new Set(playbooks.filter((p) => p.ok).flatMap((p) => p.steps.map((s) => s.personId)).filter((x): x is number => x != null))];
  const okPeople = stepPeople.length ? await visibleRefs(defaultScope(), stepPeople.map((i) => toRef("person", i))) : new Set<string>();
  const peopleNames = stepPeople.length ? await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, stepPeople)) : [];

  const keep = <T extends { ok: boolean }>(rows: T[]) => {
    const ok = rows.filter((r) => r.ok);
    leftOut += rows.length - ok.length;
    included += ok.length;
    return ok;
  };
  const okFacts = keep(facts);
  const okDecisions = keep(decisions);
  const okPlaybooks = keep(playbooks);
  const okDocuments = keep(documents);
  const okDeciders = keep(deciders);
  included += rules.length;

  const madeOn = formatLong(todayLondon(now), { withYear: true });
  const out: string[] = [];
  out.push(`# ${entity.name}: context for Claude`);
  out.push("");
  out.push(`${TYPE_LABEL[type]}${entity.details.length ? ` (${entity.details.join(", ")})` : ""}. A copy of what OllieOS knew on ${madeOn}. It is not kept up to date, so anything may have changed since.`);
  out.push("Items marked \"may be out of date\" are in question and waiting for Ollie to check them.");
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push(entity.summary?.trim() || "No summary written yet.");
  out.push("");
  out.push("## Who decides");
  out.push("");
  if (okDeciders.length) for (const d of okDeciders) out.push(`- ${d.name}${d.role ? `, ${d.role}` : ""} (noted ${day(d.since)})`);
  else {
    const [self] = await db.select({ name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.isSelf, true));
    out.push(`- ${self?.name ?? "Ollie"} (nobody else is named as deciding on this)`);
  }
  out.push("");
  out.push("## Facts");
  out.push("");
  if (okFacts.length) for (const f of okFacts) out.push(`- ${line(f.text)} (${f.source ?? (f.createdBy === "ollie" ? "Ollie" : f.createdBy)}, ${day(f.createdAt)})${f.needsCheck ? " (may be out of date)" : ""}`);
  else out.push("- None yet.");
  out.push("");
  out.push("## Decisions");
  out.push("");
  if (okDecisions.length)
    for (const d of okDecisions)
      out.push(`- ${line(d.text)} (decided ${day(d.decidedAt)}${d.decidedBy ? ` by ${d.decidedBy}` : ""}${d.source ? `; source: ${d.source}` : ""})`);
  else out.push("- None yet.");
  out.push("");
  out.push("## Rules that apply");
  out.push("");
  if (rules.length)
    for (const r of rules) {
      const at = ruleRows.find((x) => x.id === Number(r.ref.split(":")[1]))?.createdAt;
      const where = r.applies_to.length ? `applies to ${r.applies_to.map((a) => a.name).join(", ")}` : "applies everywhere";
      out.push(`- **${line(r.title)}**. When: ${whenPart(line(r.applies_when))} ${line(r.rule)} (${where}; Ollie's rule${at ? `, added ${day(at)}` : ""})${r.needs_check ? " (may be out of date)" : ""}`);
    }
  else out.push("- None.");
  out.push("");
  out.push("## Playbooks in use");
  out.push("");
  if (okPlaybooks.length)
    for (const p of okPlaybooks) {
      out.push(`- **${line(p.title)}**. When to use: ${line(p.whenToUse)}${p.purpose ? `. Purpose: ${line(p.purpose)}` : ""} (Ollie's playbook, last checked ${day(p.lastCheckedAt)})`);
      p.steps.forEach((s, i) => {
        const who = s.personId != null && okPeople.has(toRef("person", s.personId)) ? peopleNames.find((n) => n.id === s.personId)?.name : null;
        out.push(`  ${i + 1}. ${line(s.text)}${who ? ` (${who})` : ""}${s.afterDays != null ? ` (day ${s.afterDays})` : ""}`);
      });
    }
  else out.push("- None.");
  out.push("");
  out.push("## Linked documents");
  out.push("");
  if (okDocuments.length)
    for (const d of okDocuments) out.push(`- ${d.url ? `[${line(d.title)}](${d.url})` : line(d.title)} (${DOC_LOCATION_LABELS[d.location] ?? d.location}, added ${day(d.createdAt)})`);
  else out.push("- None.");
  out.push("");

  await writeAudit(db, { actor: ACTOR, action: "context_pack", entityType: type, entityId: id, payload: { included, leftOut } });
  return { fileName: `${entity.slug}-context-${todayLondon(now)}.md`, content: out.join("\n"), madeAt: now, included, leftOut };
}
