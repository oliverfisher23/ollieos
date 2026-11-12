/** Ollie's view of the Knowledge Inbox: suggestions, conflicts and facts that need a check. */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { presortCounts } from "./presort";
import { db, decisionsTable, factReviewsTable, factsTable, peopleTable, rulesTable, suggestionsTable, usersTable, type Fact, type FactReview, type PresortHint, type StaleEvidence, type Suggestion } from "@workspace/db";
import { decidersFor, weigh, whenSaid } from "./contradictions";
import { hasEmail } from "./personMatch";
import { BUSINESS_FUNCTION_LABELS, CADENCE_LABELS, PRODUCT_STATE_LABELS, PRODUCT_USER_LABELS, RELATIONSHIP_LABELS, WORK_TYPE_LABELS, formatDayMonth, isBusinessFunction, isProductUser, isWorkType } from "@workspace/shared";

/** A change card shows a list value (a product's primary user) by its label. */
const shown = (key: string, v: string | null): string | null =>
  key === "primary_user" && isProductUser(v) ? PRODUCT_USER_LABELS[v] : key === "function" && isBusinessFunction(v) ? BUSINESS_FUNCTION_LABELS[v] : key === "work_type" && isWorkType(v) ? WORK_TYPE_LABELS[v] : v;
import { writeAudit } from "../lib/audit";
import { resolveEntities, uniqueSlug } from "./knowledge/common";
import { reviewCounts, tidyReviews } from "./factReviews";
import { DOCUMENT_PROPOSER } from "./documents/counts";
import {
  FIELD_LABELS,
  editableFields,
  type CadencePayload,
  type RelationshipPayload,
  type DecisionPayload,
  type DocumentPayload,
  type FactPayload,
  type OrganisationPayload,
  type PersonPayload,
  type PlaybookPayload,
  type PlaybookStepPayload,
  type ProductPayload,
  type RulePayload,
  normalise,
  type ProjectPayload,
  type SummaryChangePayload,
  LOOK_BACK_PROPOSER,
} from "./suggestions";

const cleanHint = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

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
  | "document_link"
  | "new_rule"
  | "new_playbook"
  | "playbook_change"
  | "new_product"
  | "cadence_change"
  | "new_relationship"
  | "conflict"
  | "stale_fact"
  /** Part O: a card that disagrees with approved knowledge (Conflicts tab) */
  | "contradiction"
  /** Part O: an approved item a contradiction puts in question (Needs a check tab) */
  | "out_of_date";

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

/** One step on a Playbook card, marked against the playbook as it was when proposed. */
export interface InboxStep {
  text: string;
  person: string | null;
  afterDays: number | null;
  change: "new" | "same" | "added" | "changed" | "removed";
  /** The step as it was, for a changed step */
  before: string | null;
}

export interface InboxPlaybook {
  /** Set for a change to a playbook already in OllieOS */
  playbookId: number | null;
  steps: InboxStep[];
  reason: string | null;
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
  /** Found by a Granola look back */
  lookBack: boolean;
  /** The document or Dropbox file it came from (its source ref), when the knowledge step proposed it */
  fromDocument: string | null;
  /** A decision with no project yet: Ollie may file it under one when he approves it */
  needsProject: boolean;
  /** The project the proposer had in mind, for a decision with none */
  projectHint: string | null;
  /** Steps for a Playbook card, with the change shown */
  playbook: InboxPlaybook | null;
  /** Part N: who made the claim (a person in People when one matched) and when they said it */
  saidBy: InboxSaidBy | null;
  saidAt: Date | null;
  /** Part O: the approved items a contradiction card disagrees with, each weighed against the card */
  contradicts?: InboxContradicted[];
  /** Section 23: the pre-sorter's hint on a Suggested card; null when it gave none or has not looked */
  presort?: PresortHint | null;
  /** Section 23: the stale fact checker's finding on a Needs a check card; null until it has looked */
  evidence?: StaleEvidence | null;
}

export interface InboxContradicted {
  ref: string;
  type: "fact" | "decision" | "rule";
  label: string;
  text: string;
  /** How they disagree, in a line from the check */
  why: string;
  target: InboxTarget | null;
  saidBy: InboxSaidBy | null;
  saidAt: Date | null;
  source: string | null;
  stronger: "new" | "old" | "even";
  weighing: string;
}

export interface InboxSaidBy {
  name: string;
  personId: number | null;
  slug: string | null;
  /** Ollie himself */
  isSelf: boolean;
}

/** Who said each card's claim, with the person's page where one matched. Falls back to a decision's "decided by". */
async function saidByFor(rows: Suggestion[]): Promise<Map<number, InboxSaidBy | null>> {
  const ids = [...new Set(rows.map((s) => s.saidById).filter((x): x is number => x != null))];
  const people = ids.length ? await db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, isSelf: peopleTable.isSelf }).from(peopleTable).where(inArray(peopleTable.id, ids)) : [];
  const out = new Map<number, InboxSaidBy | null>();
  for (const s of rows) {
    const p = s.saidById != null ? people.find((x) => x.id === s.saidById) : undefined;
    const fallback = s.kind === "decision" ? cleanHint((s.payload as DecisionPayload).decided_by) : null;
    const name = p?.name ?? s.saidByName ?? fallback ?? null;
    out.set(s.id, name ? { name, personId: p?.id ?? null, slug: p?.slug ?? null, isSelf: p?.isSelf ?? false } : null);
  }
  return out;
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
    const [existing] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(hasEmail(email));
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
  return { suggested, conflicts: reviews.conflicts, stale: reviews.stale, outOfDate: reviews.outOfDate, total: suggested + reviews.conflicts + reviews.stale };
}

/* ---------- Cards ---------- */

const ATTRIBUTE_LABELS: Record<string, string> = {
  job_title: "Job title",
  organisation: "Organisation",
  status: "Status",
  next_step: "Next step",
  decision_date: "Decision date",
  renewal_date: "Renewal date",
  contract_value: "Contract value",
  account_health: "Account health",
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
      return (s.payload as DocumentPayload).document_id != null ? "document_link" : "new_document";
    case "rule":
      return "new_rule";
    case "playbook":
      return (s.payload as PlaybookPayload).playbook_id != null ? "playbook_change" : "new_playbook";
    case "product":
      return "new_product";
    case "cadence":
      return "cadence_change";
    case "relationship":
      return "new_relationship";
  }
}

const stepLine = (s: PlaybookStepPayload) =>
  [s.text, s.person_name ? `(${s.person_name})` : null, s.after_days != null ? `day ${s.after_days}` : null].filter(Boolean).join(" ");

/** The proposed steps marked against the old ones: matched by id first, then by the same text. */
export function stepDiff(proposed: PlaybookStepPayload[], before: PlaybookStepPayload[] | null): InboxStep[] {
  const view = (s: PlaybookStepPayload, change: InboxStep["change"], was: string | null = null): InboxStep => ({
    text: s.text,
    person: s.person_name ?? null,
    afterDays: s.after_days ?? null,
    change,
    before: was,
  });
  if (!before) return proposed.map((s) => view(s, "new"));
  const used = new Set<number>();
  const out = proposed.map((s) => {
    let i = s.id ? before.findIndex((b, j) => !used.has(j) && b.id === s.id) : -1;
    if (i < 0) i = before.findIndex((b, j) => !used.has(j) && normalise(b.text) === normalise(s.text));
    if (i < 0) return view(s, "added");
    used.add(i);
    const old = before[i];
    const same = normalise(old.text) === normalise(s.text) && (old.person_id ?? null) === (s.person_id ?? null) && (old.after_days ?? null) === (s.after_days ?? null);
    return same ? view(s, "same") : view(s, "changed", stepLine(old));
  });
  before.forEach((b, j) => {
    if (!used.has(j)) out.push(view(b, "removed"));
  });
  return out;
}

function playbookOf(s: Suggestion): InboxPlaybook | null {
  if (s.kind !== "playbook") return null;
  const p = s.payload as PlaybookPayload;
  return { playbookId: p.playbook_id ?? null, steps: stepDiff(p.steps ?? [], p.playbook_id != null ? (p.before?.steps ?? []) : null), reason: p.reason ?? null };
}

function fieldsOf(s: Suggestion): InboxField[] {
  const editable = new Set(editableFields(s));
  const p = s.payload as Record<string, unknown>;
  if (s.kind === "playbook") {
    const pb = s.payload as PlaybookPayload;
    const was = pb.playbook_id != null ? pb.before : null;
    const field = (key: "title" | "when_to_use" | "purpose", before: string | null | undefined): InboxField => ({
      key,
      label: FIELD_LABELS[key],
      value: pb[key] ?? null,
      before: was && (before ?? null) !== (pb[key] ?? null) ? (before ?? null) : null,
      editable: editable.has(key),
    });
    const fields = [field("title", was?.title), field("when_to_use", was?.when_to_use), field("purpose", was?.purpose)];
    if (pb.owner_name || was?.owner_name) {
      fields.push({ key: "owner", label: FIELD_LABELS.owner, value: pb.owner_name ?? null, before: was && was.owner_name !== (pb.owner_name ?? null) ? was.owner_name : null, editable: false });
    }
    return fields;
  }
  if (s.kind === "summary_change") {
    const c = s.payload as SummaryChangePayload;
    return Object.entries(c.fields).map(([key, value]) => ({
      key,
      label: FIELD_LABELS[key] ?? key,
      value: shown(key, value),
      before: shown(key, c.before?.[key] ?? null),
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

export function textOf(s: Suggestion): string {
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
      return joinParts([o.name, o.type, o.summary, o.client_of_project_names?.length ? `Client for ${o.client_of_project_names.join(", ")}` : null]);
    }
    case "project": {
      const p = s.payload as ProjectPayload;
      return joinParts([
        p.name,
        isBusinessFunction(p.function) ? `Function: ${BUSINESS_FUNCTION_LABELS[p.function]}` : null,
        p.client_name ? `Client: ${p.client_name}` : null,
        p.area,
        p.status,
        p.summary,
      ]);
    }
    case "summary_change": {
      const c = s.payload as SummaryChangePayload;
      return [...Object.entries(c.fields).map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${shown(k, v)}`), ...(c.reason ? [`Why: ${c.reason}`] : [])].join("\n");
    }
    case "document": {
      const d = s.payload as DocumentPayload;
      if (d.document_id != null) return joinParts([d.title, d.project_names?.length ? `Link it to ${d.project_names.join(", ")}` : null]);
      const preview = d.content ? d.content.replace(/\s+/g, " ").trim().slice(0, 400) + (d.content.length > 400 ? "…" : "") : null;
      return joinParts([d.title, d.summary, d.doc_kind ? `Saved by Claude as ${d.doc_kind}` : d.content ? "Saved by Claude" : null, d.project_names?.length ? `For ${d.project_names.join(", ")}` : null, d.url, preview]);
    }
    case "rule": {
      const p = s.payload as RulePayload;
      return joinParts([
        p.title,
        `Applies when: ${p.applies_when}`,
        `Rule: ${p.rule}`,
        p.link_names?.length ? `Only for ${p.link_names.join(", ")}` : "Applies everywhere",
      ]);
    }
    case "playbook": {
      const p = s.payload as PlaybookPayload;
      if (p.playbook_id != null) return joinParts([`Change to ${p.before?.title ?? p.title}`, p.reason]);
      return joinParts([
        p.title,
        `When to use it: ${p.when_to_use}`,
        p.purpose,
        `${p.steps.length} ${p.steps.length === 1 ? "step" : "steps"}`,
        p.link_names?.length ? `For ${p.link_names.join(", ")}` : null,
      ]);
    }
    case "product": {
      const p = s.payload as ProductPayload;
      return joinParts([
        p.name,
        p.description,
        p.state ? PRODUCT_STATE_LABELS[p.state] : null,
        isProductUser(p.primary_user) ? `Primary user: ${PRODUCT_USER_LABELS[p.primary_user]}` : null,
        p.summary,
        p.facts?.length ? `Facts: ${p.facts.join("; ")}` : null,
      ]);
    }
    case "cadence": {
      const c = s.payload as CadencePayload;
      const change = c.before && c.before !== "none" ? `Cadence: ${CADENCE_LABELS[c.before]} to ${CADENCE_LABELS[c.cadence]}` : `Cadence: ${CADENCE_LABELS[c.cadence]}`;
      return joinParts([change, c.reason]);
    }
    case "relationship": {
      const r = s.payload as RelationshipPayload;
      return `${r.from_name ?? "This"} ${RELATIONSHIP_LABELS[r.relationship]} ${r.to_name ?? "another item"}`;
    }
  }
}

function newName(s: Suggestion): string | null {
  if (s.kind === "person" || s.kind === "organisation" || s.kind === "project" || s.kind === "product") return (s.payload as { name: string }).name;
  if (s.kind === "document" || s.kind === "rule") return (s.payload as { title: string }).title;
  if (s.kind === "playbook") {
    const p = s.payload as PlaybookPayload;
    return p.playbook_id != null ? (p.before?.title ?? p.title) : p.title;
  }
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

export type InboxOrigin = "all" | "look_back" | "documents";

const CONTRADICTED_LABEL = { fact: "Fact", decision: "Decision", rule: "Rule" } as const;

/**
 * Part O: a contradiction card for the Conflicts tab, with each approved item it disagrees with,
 * who said each and when, and which side looks stronger; plus a "May be out of date" card for each
 * approved item, for the Needs a check tab.
 */
async function contradictionViews(reviews: FactReview[]): Promise<Map<number, { card: InboxItem; outOfDate: InboxItem[] }>> {
  const out = new Map<number, { card: InboxItem; outOfDate: InboxItem[] }>();
  if (!reviews.length) return out;
  const sids = reviews.map((r) => r.suggestionId).filter((x): x is number => x != null);
  const cards = sids.length ? await db.select().from(suggestionsTable).where(and(inArray(suggestionsTable.id, sids), eq(suggestionsTable.status, "pending"))) : [];
  const all = reviews.flatMap((r) => r.contradicts ?? []);
  const ids = (t: string) => [...new Set(all.filter((i) => i.type === t).map((i) => i.id))];
  const [facts, decisions, rules, self] = await Promise.all([
    ids("fact").length ? db.select().from(factsTable).where(and(inArray(factsTable.id, ids("fact")), isNull(factsTable.supersededBy))) : ([] as Fact[]),
    ids("decision").length ? db.select().from(decisionsTable).where(and(inArray(decisionsTable.id, ids("decision")), isNull(decisionsTable.supersededBy))) : ([] as (typeof decisionsTable.$inferSelect)[]),
    ids("rule").length ? db.select().from(rulesTable).where(and(inArray(rulesTable.id, ids("rule")), eq(rulesTable.enabled, true))) : ([] as (typeof rulesTable.$inferSelect)[]),
    db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(eq(peopleTable.isSelf, true)),
  ]);
  const me = self[0] ?? null;
  // Ollie made it, whether or not his own profile exists yet.
  const selfSaid: InboxSaidBy = me ? { name: me.name, personId: me.id, slug: me.slug, isSelf: true } : { name: "You", personId: null, slug: null, isSelf: true };
  // Where the approved items came from, for who said them.
  const originIds = [...facts.map((f) => f.suggestionId), ...decisions.map((d) => d.suggestionId), ...rules.map((r) => r.suggestionId)].filter((x): x is number => x != null);
  const origins = originIds.length ? await db.select().from(suggestionsTable).where(inArray(suggestionsTable.id, originIds)) : [];
  const said = await saidByFor([...cards, ...origins]);
  const t = await targetsFor([
    ...cards.filter((s) => s.entityType && s.entityId != null).map((s) => ({ type: s.entityType!, id: s.entityId! })),
    ...facts.map((f) => ({ type: f.entityType, id: f.entityId })),
    ...decisions.filter((d) => d.projectId != null).map((d) => ({ type: "project", id: d.projectId! })),
  ]);
  const deciders = new Map<string, Set<number>>();
  for (const s of cards) {
    if (!s.entityType || s.entityId == null) continue;
    const k = `${s.entityType}:${s.entityId}`;
    if (!deciders.has(k)) deciders.set(k, new Set(await decidersFor(s.entityType, s.entityId)));
  }
  const origin = (id: number | null) => (id != null ? origins.find((o) => o.id === id) : undefined);
  const fromOrigin = (id: number | null) => {
    const o = origin(id);
    return o ? { by: said.get(o.id) ?? null, at: whenSaid(o) } : null;
  };

  for (const r of reviews) {
    const sug = cards.find((s) => s.id === r.suggestionId);
    if (!sug) continue;
    const cardTarget = target(t, sug.entityType, sug.entityId);
    const area = cardTarget ? (cardTarget.isSelf ? "your own profile" : cardTarget.name) : sug.kind === "rule" ? "how you work" : "this";
    const decide = sug.entityType && sug.entityId != null ? (deciders.get(`${sug.entityType}:${sug.entityId}`) ?? new Set<number>()) : new Set<number>();
    const newBy = said.get(sug.id) ?? null;
    const newAt = whenSaid(sug) ?? sug.createdAt;
    const contradicted: InboxContradicted[] = [];
    for (const c of r.contradicts ?? []) {
      let base: Omit<InboxContradicted, "stronger" | "weighing" | "why" | "ref" | "type" | "label"> | null = null;
      if (c.type === "fact") {
        const f = facts.find((x) => x.id === c.id);
        if (f) {
          const o = fromOrigin(f.suggestionId);
          base = { text: f.text, target: target(t, f.entityType, f.entityId), saidBy: o ? o.by : f.createdBy === "ollie" ? selfSaid : null, saidAt: o?.at ?? f.createdAt, source: factSource(f) };
        }
      } else if (c.type === "decision") {
        const d = decisions.find((x) => x.id === c.id);
        if (d) {
          const o = fromOrigin(d.suggestionId);
          const by = o?.by ?? (cleanHint(d.decidedBy) ? { name: d.decidedBy!, personId: null, slug: null, isSelf: false } : d.createdBy === "ollie" ? selfSaid : null);
          base = { text: d.text, target: target(t, d.projectId != null ? "project" : null, d.projectId), saidBy: by, saidAt: o?.at ?? new Date(`${d.decidedAt}T12:00:00Z`), source: d.source ?? (d.createdBy === "ollie" ? "You" : d.createdBy) };
        }
      } else {
        const rule = rules.find((x) => x.id === c.id);
        if (rule) {
          const o = fromOrigin(rule.suggestionId);
          base = { text: `${rule.title}: ${rule.rule}`, target: null, saidBy: o?.by ?? selfSaid, saidAt: o?.at ?? rule.createdAt, source: "Rules" };
        }
      }
      if (!base) continue;
      const w = weigh({ area, deciders: decide, selfId: me?.id ?? null, newBy, newAt, oldBy: base.saidBy, oldAt: base.saidAt ?? newAt });
      contradicted.push({ ...base, ref: `${c.type}:${c.id}`, type: c.type, label: CONTRADICTED_LABEL[c.type], why: c.why, stronger: w.stronger, weighing: w.reason });
    }
    if (!contradicted.length) continue;
    const common = {
      by: sug.proposedBy,
      createdAt: r.createdAt,
      fields: [],
      attribute: null,
      replaces: null,
      sourceUrl: null,
      options: [],
      lastConfirmedAt: null,
      lookBack: sug.proposedBy === LOOK_BACK_PROPOSER,
      fromDocument: null,
      needsProject: false,
      projectHint: null,
      playbook: null,
    };
    const card: InboxItem = {
      ...common,
      key: `review:${r.id}`,
      id: r.id,
      group: "conflicts",
      kind: "contradiction",
      target: cardTarget,
      text: textOf(sug),
      source: sourceOf(sug),
      sourceUrl: sug.sourceUrl,
      saidBy: newBy,
      saidAt: whenSaid(sug),
      contradicts: contradicted,
    };
    const outOfDate: InboxItem[] = contradicted.map((c) => ({
      ...common,
      key: `out-of-date:${r.id}:${c.ref.replace(":", "-")}`,
      id: r.id,
      group: "stale",
      kind: "out_of_date",
      by: "Contradiction check",
      target: c.target,
      text: c.text,
      source: `${c.label}. A newer card says otherwise: ${textOf(sug)}`,
      saidBy: c.saidBy,
      saidAt: c.saidAt,
      contradicts: [c],
    }));
    out.set(r.id, { card, outOfDate });
  }
  return out;
}

/** Section 23: Suggested filtered by the pre-sorter's hint. "none" is looked at with no hint (unsure, or hidden from AI); "unsorted" is not looked at yet. */
export const PRESORT_FILTERS = ["all", "keep", "reject", "same", "duplicate", "none", "unsorted"] as const;
export type PresortFilter = (typeof PRESORT_FILTERS)[number];

function presortWhere(hint: PresortFilter) {
  if (hint === "all") return undefined;
  if (hint === "unsorted") return isNull(suggestionsTable.presortedAt);
  if (hint === "none") return and(isNotNull(suggestionsTable.presortedAt), sql`(${suggestionsTable.presort} is null or jsonb_typeof(${suggestionsTable.presort}) = 'null')`);
  return sql`${suggestionsTable.presort}->>'verdict' = ${hint}`;
}

export async function listInbox(tab: InboxTab, origin: InboxOrigin = "all", hint: PresortFilter = "all") {
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
          origin === "look_back" ? eq(suggestionsTable.proposedBy, LOOK_BACK_PROPOSER) : undefined,
          origin === "documents" ? eq(suggestionsTable.proposedBy, DOCUMENT_PROPOSER) : undefined,
          presortWhere(hint),
          sql`not exists (select 1 from fact_reviews r where r.suggestion_id = ${suggestionsTable.id} and r.status = 'pending')`,
        ),
      )
      .orderBy(asc(suggestionsTable.createdAt), asc(suggestionsTable.id))
      .limit(1000);
    const supersedeIds = rows.map((s) => (s.kind === "fact" ? (s.payload as FactPayload).supersedes : null)).filter((x): x is number => x != null);
    const replaced = supersedeIds.length ? await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).where(inArray(factsTable.id, supersedeIds)) : [];
    const t = await targetsFor(rows.filter((s) => s.entityType && s.entityId != null).map((s) => ({ type: s.entityType!, id: s.entityId! })));
    const said = await saidByFor(rows);
    items = rows.map((s) => {
      const name = newName(s);
      const fp = s.kind === "fact" ? (s.payload as FactPayload) : null;
      return {
        key: `suggestion:${s.id}`,
        id: s.id,
        group: "suggested",
        kind: suggestionKind(s),
        target:
          target(t, s.entityType, s.entityId) ??
          (name ? { type: s.kind, id: s.kind === "playbook" ? ((s.payload as PlaybookPayload).playbook_id ?? null) : null, name, slug: null, isSelf: false } : null),
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
        lookBack: s.proposedBy === LOOK_BACK_PROPOSER,
        fromDocument: s.proposedBy === DOCUMENT_PROPOSER ? s.sourceRef : null,
        needsProject: s.kind === "decision" && s.entityId == null,
        projectHint: s.kind === "decision" ? (cleanHint((s.payload as DecisionPayload).project_hint) ?? null) : null,
        playbook: playbookOf(s),
        saidBy: said.get(s.id) ?? null,
        saidAt: whenSaid(s),
        presort: s.presort ?? null,
      };
    });
  } else {
    const reviews = await db
      .select()
      .from(factReviewsTable)
      .where(and(eq(factReviewsTable.status, "pending"), inArray(factReviewsTable.kind, tab === "conflicts" ? ["conflict", "contradiction"] : ["stale", "contradiction"])))
      .orderBy(asc(factReviewsTable.createdAt), asc(factReviewsTable.id))
      .limit(200);
    const views = await contradictionViews(reviews.filter((r) => r.kind === "contradiction"));
    const factIds = [...new Set(reviews.flatMap((r) => r.factIds))];
    const facts = factIds.length ? await db.select().from(factsTable).where(and(inArray(factsTable.id, factIds), isNull(factsTable.supersededBy))) : [];
    const sids = reviews.map((r) => r.suggestionId).filter((x): x is number => x != null);
    const sugs = sids.length ? await db.select().from(suggestionsTable).where(inArray(suggestionsTable.id, sids)) : [];
    const t = await targetsFor(facts.map((f) => ({ type: f.entityType, id: f.entityId })));
    const said = await saidByFor(sugs);
    for (const r of reviews) {
      if (r.kind === "contradiction") {
        const v = views.get(r.id);
        if (!v) continue;
        if (tab === "conflicts") items.push(v.card);
        else items.push(...v.outOfDate);
        continue;
      }
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
          lookBack: false,
          fromDocument: null,
          needsProject: false,
          projectHint: null,
          playbook: null,
          saidBy: null,
          saidAt: null,
          evidence: r.evidence ?? null,
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
          lookBack: sug?.proposedBy === LOOK_BACK_PROPOSER,
          fromDocument: null,
          needsProject: false,
          projectHint: null,
          playbook: null,
          saidBy: sug ? (said.get(sug.id) ?? null) : null,
          saidAt: sug ? whenSaid(sug) : null,
        });
      }
    }
  }
  const [lb] = await db
    .select({
      lookBack: sql<number>`count(*) filter (where ${suggestionsTable.proposedBy} = ${LOOK_BACK_PROPOSER})::int`,
      documents: sql<number>`count(*) filter (where ${suggestionsTable.proposedBy} = ${DOCUMENT_PROPOSER})::int`,
    })
    .from(suggestionsTable)
    .where(eq(suggestionsTable.status, "pending"));
  return { counts: { ...counts, lookBack: lb?.lookBack ?? 0, documents: lb?.documents ?? 0 }, items, presort: tab === "suggested" ? await presortCounts() : undefined };
}
