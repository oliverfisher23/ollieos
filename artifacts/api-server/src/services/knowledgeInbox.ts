/** Ollie's view of the Knowledge Inbox: suggestions, conflicts and facts that need a check. */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, factReviewsTable, factsTable, peopleTable, suggestionsTable, usersTable, type Fact, type Suggestion } from "@workspace/db";
import { CADENCE_LABELS, formatDayMonth } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { resolveEntities, uniqueSlug } from "./knowledge/common";
import { reviewCounts, tidyReviews } from "./factReviews";
import {
  FIELD_LABELS,
  editableFields,
  type CadencePayload,
  type DecisionPayload,
  type DocumentPayload,
  type FactPayload,
  type OrganisationPayload,
  type PersonPayload,
  type PlaybookPayload,
  type ProjectPayload,
  type SummaryChangePayload,
} from "./suggestions";

export type InboxTab = "suggested" | "conflicts" | "stale";

export type InboxKind =
  | "new_fact"
  | "new_person"
  | "new_organisation"
  | "new_project"
  | "proposed_decision"
  | "changed_summary"
  | "changed_details"
  | "new_document"
  | "new_playbook"
  | "cadence_change"
  | "conflict"
  | "stale_fact";

export interface InboxTarget {
  type: string;
  id: number | null;
  name: string;
  slug: string | null;
  isSelf: boolean;
}

export interface InboxField {
  key: string;
  label: string;
  value: string | null;
  before: string | null;
  editable: boolean;
}

export interface InboxOption {
  ref: string;
  label: string;
  text: string;
}

export interface InboxItem {
  key: string;
  id: number;
  group: InboxTab;
  kind: InboxKind;
  target: InboxTarget | null;
  by: string;
  createdAt: Date;
  text: string | null;
  fields: InboxField[];
  attribute: string | null;
  replaces: string | null;
  source: string | null;
  sourceUrl: string | null;
  options: InboxOption[];
  lastConfirmedAt: Date | null;
}

/* ---------- Ollie's own person record ---------- */

let selfChecked = false;

/**
 * Ollie's own person record ("Your profile", build plan 27), created from the signed-in account
 * with name and email only. An existing person with the same email becomes it.
 */
export async function ensureSelfPerson(): Promise<void> {
  if (selfChecked) return;
  const [self] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.isSelf, true));
  if (self) {
    selfChecked = true;
    return;
  }
  const [user] = await db.select().from(usersTable).limit(1);
  if (!user?.email) return;
  const email = user.email.toLowerCase();
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || email;
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(sql`lower(${peopleTable.email}) = ${email}`);
    if (existing) {
      await tx.update(peopleTable).set({ isSelf: true }).where(eq(peopleTable.id, existing.id));
      await writeAudit(tx, { actor: "ollie", action: "update", entityType: "person", entityId: existing.id, payload: { isSelf: true } });
      return;
    }
    const slug = await uniqueSlug(tx, "person", name);
    const [row] = await tx.insert(peopleTable).values({ name, slug, email, isSelf: true }).returning({ id: peopleTable.id });
    await writeAudit(tx, { actor: "ollie", action: "create", entityType: "person", entityId: row.id, payload: { name, isSelf: true } });
  });
  selfChecked = true;
}

/** For tests, which recreate the database. */
export function resetSelfCheck() {
  selfChecked = false;
}

/* ---------- Counts ---------- */

async function suggestedCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suggestionsTable)
    .where(
      and(
        eq(suggestionsTable.status, "pending"),
        sql`not exists (select 1 from fact_reviews r where r.suggestion_id = ${suggestionsTable.id} and r.status = 'pending')`,
      ),
    );
  return row?.n ?? 0;
}

export async function inboxCounts() {
  await tidyReviews();
  const [suggested, reviews] = await Promise.all([suggestedCount(), reviewCounts()]);
  return { suggested, conflicts: reviews.conflicts, stale: reviews.stale, total: suggested + reviews.conflicts + reviews.stale };
}

/* ---------- Cards ---------- */

const ATTRIBUTE_LABELS: Record<string, string> = {
  job_title: "Job title",
  organisation: "Organisation",
  status: "Status",
  next_step: "Next step",
  decision_date: "Decision date",
};

function sourceOf(s: Suggestion): string | null {
  if (s.sourceLabel) return s.sourceLabel;
  if (s.sourceType) return s.sourceType.charAt(0).toUpperCase() + s.sourceType.slice(1);
  return null;
}

function factSource(f: Fact): string {
  if (f.source) return f.source;
  return f.createdBy === "ollie" ? "You" : f.createdBy;
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && !!p.trim()).join(". ");
}

function suggestionKind(s: Suggestion): InboxKind {
  switch (s.kind) {
    case "fact":
      return "new_fact";
    case "decision":
      return "proposed_decision";
    case "person":
      return "new_person";
    case "organisation":
      return "new_organisation";
    case "project":
      return "new_project";
    case "summary_change": {
      const f = (s.payload as SummaryChangePayload).fields;
      return "summary" in f || "relationship_summary" in f ? "changed_summary" : "changed_details";
    }
    case "document":
      return "new_document";
    case "playbook":
      return "new_playbook";
    case "cadence":
      return "cadence_change";
  }
}

function fieldsOf(s: Suggestion): InboxField[] {
  const editable = new Set(editableFields(s));
  const p = s.payload as Record<string, unknown>;
  if (s.kind === "summary_change") {
    const c = s.payload as SummaryChangePayload;
    return Object.entries(c.fields).map(([key, value]) => ({
      key,
      label: FIELD_LABELS[key] ?? key,
      value,
      before: c.before?.[key] ?? null,
      editable: editable.has(key),
    }));
  }
  return [...editable].map((key) => ({
    key,
    label: FIELD_LABELS[key] ?? key,
    value: typeof p[key] === "string" ? (p[key] as string) : null,
    before: null,
    editable: true,
  }));
}

function textOf(s: Suggestion): string {
  switch (s.kind) {
    case "fact":
      return (s.payload as FactPayload).text;
    case "decision": {
      const d = s.payload as DecisionPayload;
      return d.text + (d.decided_by ? ` (decided by ${d.decided_by})` : "");
    }
    case "person": {
      const p = s.payload as PersonPayload;
      const head = [p.name, p.role].filter(Boolean).join(", ") + (p.organisation_name ? ` at ${p.organisation_name}` : "");
      return joinParts([head, p.relationship_summary, p.email]);
    }
    case "organisation": {
      const o = s.payload as OrganisationPayload;
      return joinParts([o.name, o.type, o.summary]);
    }
    case "project": {
      const p = s.payload as ProjectPayload;
      return joinParts([p.name, p.area, p.status, p.summary]);
    }
    case "summary_change": {
      const c = s.payload as SummaryChangePayload;
      return Object.entries(c.fields)
        .map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${v}`)
        .join("\n");
    }
    case "document": {
      const d = s.payload as DocumentPayload;
      return joinParts([d.title, d.summary, d.project_names?.length ? `For ${d.project_names.join(", ")}` : null, d.url]);
    }
    case "playbook": {
      const p = s.payload as PlaybookPayload;
      return joinParts([
        p.title,
        `Applies when: ${p.applies_when}`,
        `Rule: ${p.rule}`,
        p.link_names?.length ? `Only for ${p.link_names.join(", ")}` : "Applies everywhere",
      ]);
    }
    case "cadence": {
      const c = s.payload as CadencePayload;
      const change = c.before && c.before !== "none" ? `Cadence: ${CADENCE_LABELS[c.before]} to ${CADENCE_LABELS[c.cadence]}` : `Cadence: ${CADENCE_LABELS[c.cadence]}`;
      return joinParts([change, c.reason]);
    }
  }
}

function newName(s: Suggestion): string | null {
  if (s.kind === "person" || s.kind === "organisation" || s.kind === "project") return (s.payload as { name: string }).name;
  if (s.kind === "document" || s.kind === "playbook") return (s.payload as { title: string }).title;
  return null;
}

async function targetsFor(refs: { type: string; id: number }[]): Promise<{ names: Awaited<ReturnType<typeof resolveEntities>>; selfId: number | null }> {
  const [names, self] = await Promise.all([
    resolveEntities(refs),
    db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.isSelf, true)),
  ]);
  return { names, selfId: self[0]?.id ?? null };
}

function target(t: { names: Map<string, { type: string; id: number; name: string; slug: string | null }>; selfId: number | null }, type: string | null, id: number | null): InboxTarget | null {
  if (!type || id == null) return null;
  const hit = t.names.get(`${type}:${id}`);
  if (!hit) return { type, id, name: "Removed item", slug: null, isSelf: false };
  return { ...hit, isSelf: type === "person" && id === t.selfId };
}

/** Labels that tell the two sides apart, adding the date when the sources match. */
function distinctLabels(options: (InboxOption & { at: Date })[]): InboxOption[] {
  const counts = new Map<string, number>();
  for (const o of options) counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
  return options.map(({ at, ...o }) => ((counts.get(o.label) ?? 0) > 1 ? { ...o, label: `${o.label} (${formatDayMonth(at)})` } : o));
}

export async function listInbox(tab: InboxTab) {
  await ensureSelfPerson().catch(() => undefined);
  const counts = await inboxCounts();
  let items: InboxItem[] = [];

  if (tab === "suggested") {
    const rows = await db
      .select()
      .from(suggestionsTable)
      .where(
        and(
          eq(suggestionsTable.status, "pending"),
          sql`not exists (select 1 from fact_reviews r where r.suggestion_id = ${suggestionsTable.id} and r.status = 'pending')`,
        ),
      )
      .orderBy(asc(suggestionsTable.createdAt), asc(suggestionsTable.id))
      .limit(200);
    const supersedeIds = rows.map((s) => (s.kind === "fact" ? (s.payload as FactPayload).supersedes : null)).filter((x): x is number => x != null);
    const replaced = supersedeIds.length ? await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(inArray(factsTable.id, supersedeIds)) : [];
    const t = await targetsFor(rows.filter((s) => s.entityType && s.entityId != null).map((s) => ({ type: s.entityType!, id: s.entityId! })));
    items = rows.map((s) => {
      const name = newName(s);
      const fp = s.kind === "fact" ? (s.payload as FactPayload) : null;
      return {
        key: `suggestion:${s.id}`,
        id: s.id,
        group: "suggested",
        kind: suggestionKind(s),
        target: target(t, s.entityType, s.entityId) ?? (name ? { type: s.kind, id: null, name, slug: null, isSelf: false } : null),
        by: s.proposedBy,
        createdAt: s.createdAt,
        text: textOf(s),
        fields: fieldsOf(s),
        attribute: fp?.attribute ? ATTRIBUTE_LABELS[fp.attribute] : null,
        replaces: fp?.supersedes != null ? (replaced.find((r) => r.id === fp.supersedes)?.text ?? null) : null,
        source: sourceOf(s),
        sourceUrl: s.sourceUrl,
        options: [],
        lastConfirmedAt: null,
      };
    });
  } else {
    const reviews = await db
      .select()
      .from(factReviewsTable)
      .where(and(eq(factReviewsTable.status, "pending"), eq(factReviewsTable.kind, tab === "conflicts" ? "conflict" : "stale")))
      .orderBy(asc(factReviewsTable.createdAt), asc(factReviewsTable.id))
      .limit(200);
    const factIds = [...new Set(reviews.flatMap((r) => r.factIds))];
    const facts = factIds.length ? await db.select().from(factsTable).where(and(inArray(factsTable.id, factIds), isNull(factsTable.supersededBy))) : [];
    const sids = reviews.map((r) => r.suggestionId).filter((x): x is number => x != null);
    const sugs = sids.length ? await db.select().from(suggestionsTable).where(inArray(suggestionsTable.id, sids)) : [];
    const t = await targetsFor(facts.map((f) => ({ type: f.entityType, id: f.entityId })));
    for (const r of reviews) {
      const fs = r.factIds.map((i) => facts.find((f) => f.id === i)).filter((f): f is Fact => !!f);
      const first = fs[0];
      if (!first) continue;
      if (r.kind === "stale") {
        items.push({
          key: `review:${r.id}`,
          id: r.id,
          group: "stale",
          kind: "stale_fact",
          target: target(t, first.entityType, first.entityId),
          by: "Weekly check",
          createdAt: r.createdAt,
          text: first.text,
          fields: [{ key: "text", label: "Text", value: first.text, before: null, editable: true }],
          attribute: first.attribute ? ATTRIBUTE_LABELS[first.attribute] : null,
          replaces: null,
          source: factSource(first),
          sourceUrl: null,
          options: [],
          lastConfirmedAt: first.lastConfirmedAt,
        });
      } else {
        const sug = sugs.find((s) => s.id === r.suggestionId && s.status === "pending");
        const options = distinctLabels([
          ...fs.map((f) => ({ ref: `fact:${f.id}`, label: factSource(f), text: f.text, at: f.createdAt })),
          ...(sug ? [{ ref: `suggestion:${sug.id}`, label: sourceOf(sug) ?? sug.proposedBy, text: (sug.payload as FactPayload).text, at: sug.createdAt }] : []),
        ]);
        items.push({
          key: `review:${r.id}`,
          id: r.id,
          group: "conflicts",
          kind: "conflict",
          target: target(t, first.entityType, first.entityId),
          by: sug ? sug.proposedBy : "Weekly check",
          createdAt: r.createdAt,
          text: null,
          fields: [],
          attribute: first.attribute ? ATTRIBUTE_LABELS[first.attribute] : null,
          replaces: null,
          source: `${options.length === 2 ? "Two" : String(options.length)} sources disagree${first.attribute ? ` about the ${ATTRIBUTE_LABELS[first.attribute].toLowerCase()}` : ""}`,
          sourceUrl: null,
          options,
          lastConfirmedAt: null,
        });
      }
    }
  }
  return { counts, items };
}
