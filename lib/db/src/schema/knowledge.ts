import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { activityKindEnum, cadenceEnum, entityTypeEnum, factAttributeEnum, projectLifecycleEnum, tsvector } from "./enums";
import { goalsTable } from "./goals";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const organisationsTable = pgTable(
  "organisations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    type: text("type"),
    summary: text("summary"),
    confidential: boolean("confidential").notNull().default(false),
    aiAccess: boolean("ai_access").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(name,'') || ' ' || coalesce(type,'') || ' ' || coalesce(summary,''))`,
    ),
  },
  (t) => [index("organisations_search_idx").using("gin", t.search)],
);

export const projectsTable = pgTable(
  "projects",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    area: text("area"),
    status: text("status"),
    summary: text("summary"),
    confidential: boolean("confidential").notNull().default(false),
    aiAccess: boolean("ai_access").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    /** A goal or sub-goal (feature 04); tasks inherit it unless they set their own */
    goalId: integer("goal_id").references(() => goalsTable.id, { onDelete: "set null" }),
    /** Active, paused or complete; paused and complete pause the cadence of people linked only to them */
    lifecycle: projectLifecycleEnum("lifecycle").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(name,'') || ' ' || coalesce(area,'') || ' ' || coalesce(summary,''))`,
    ),
  },
  (t) => [index("projects_search_idx").using("gin", t.search)],
);

export const peopleTable = pgTable(
  "people",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    organisationId: integer("organisation_id").references(() => organisationsTable.id),
    role: text("role"),
    email: text("email"),
    relationshipSummary: text("relationship_summary"),
    confidential: boolean("confidential").notNull().default(false),
    aiAccess: boolean("ai_access").notNull().default(true),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    /** Ollie's own record ("Your profile"). At most one row. */
    isSelf: boolean("is_self").notNull().default(false),
    /** How often Ollie wants to be in touch (feature 05); none keeps them off the People page */
    cadence: cadenceEnum("cadence").notNull().default("none"),
    /** Paused by Ollie; a cadence also pauses when every linked project is paused or complete */
    cadencePaused: boolean("cadence_paused").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(name,'') || ' ' || coalesce(role,'') || ' ' || coalesce(email,'') || ' ' || coalesce(relationship_summary,''))`,
    ),
  },
  (t) => [
    uniqueIndex("people_email_unique").on(t.email).where(sql`email is not null`),
    uniqueIndex("people_self_unique").on(t.isSelf).where(sql`is_self`),
    index("people_organisation_idx").on(t.organisationId),
    index("people_search_idx").using("gin", t.search),
  ],
);

/**
 * Facts are never edited in place: a change inserts a new row and sets superseded_by on the old one.
 * A fact marked "No longer true" points superseded_by at itself: it stays in history with no successor.
 */
export const factsTable = pgTable(
  "facts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    entityType: entityTypeEnum("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    text: text("text").notNull(),
    source: text("source"),
    /** null means a general fact */
    attribute: factAttributeEnum("attribute"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    /** When Ollie (or the import) last confirmed it; drives "Needs a check" */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    /** True while the fact is stale or in conflict; AI responses carry it as needs_check */
    needsCheck: boolean("needs_check").notNull().default(false),
    /** Set when Ollie approved it from the Knowledge Inbox */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    suggestionId: integer("suggestion_id"),
    supersededBy: integer("superseded_by").references((): AnyPgColumn => factsTable.id),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(text,''))`),
  },
  (t) => [
    index("facts_entity_idx").on(t.entityType, t.entityId),
    index("facts_search_idx").using("gin", t.search),
  ],
);

export const decisionsTable = pgTable(
  "decisions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id),
    text: text("text").notNull(),
    decidedAt: date("decided_at", { mode: "string" }).notNull(),
    decidedBy: text("decided_by"),
    source: text("source"),
    /** null means inherit from the project */
    confidential: boolean("confidential"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    suggestionId: integer("suggestion_id"),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(text,''))`),
  },
  (t) => [
    index("decisions_project_idx").on(t.projectId),
    index("decisions_search_idx").using("gin", t.search),
  ],
);

export const notesTable = pgTable(
  "notes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    entityType: entityTypeEnum("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** null means inherit from the entity */
    confidential: boolean("confidential"),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))`,
    ),
  },
  (t) => [
    index("notes_entity_idx").on(t.entityType, t.entityId),
    index("notes_search_idx").using("gin", t.search),
  ],
);

/** One row per touchpoint; extra people and projects for the same touchpoint go in links. */
export const activityTable = pgTable(
  "activity",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    entityType: entityTypeEnum("entity_type"),
    entityId: integer("entity_id"),
    kind: activityKindEnum("kind").notNull(),
    summary: text("summary").notNull(),
    sourceUrl: text("source_url"),
    sourceRef: text("source_ref"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_entity_idx").on(t.entityType, t.entityId),
    index("activity_occurred_idx").on(t.occurredAt),
    uniqueIndex("activity_source_ref_unique").on(t.sourceRef).where(sql`source_ref is not null`),
  ],
);

export const linksTable = pgTable(
  "links",
  {
    fromType: entityTypeEnum("from_type").notNull(),
    fromId: integer("from_id").notNull(),
    toType: entityTypeEnum("to_type").notNull(),
    toId: integer("to_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fromType, t.fromId, t.toType, t.toId] }),
    index("links_to_idx").on(t.toType, t.toId),
  ],
);

export type Project = typeof projectsTable.$inferSelect;
export type Person = typeof peopleTable.$inferSelect;
export type Organisation = typeof organisationsTable.$inferSelect;
export type Fact = typeof factsTable.$inferSelect;
export type Decision = typeof decisionsTable.$inferSelect;
export type Note = typeof notesTable.$inferSelect;
export type Activity = typeof activityTable.$inferSelect;
export type Link = typeof linksTable.$inferSelect;
