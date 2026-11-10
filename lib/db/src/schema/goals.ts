import { sql } from "drizzle-orm";
import { boolean, date, integer, pgTable, text, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Goals (feature 04): Ollie's 12-month priorities. Projects and tasks link to a goal or a sub-goal
 * (one level deep), and counts on a sub-goal roll up to its parent. The target text is never sent
 * to AI tools when the goal is confidential; the name and statement always are.
 */
export const goalsTable = pgTable("goals", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  parentId: integer("parent_id").references((): AnyPgColumn => goalsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  statement: text("statement"),
  targetText: text("target_text"),
  periodStart: date("period_start", { mode: "string" }),
  periodEnd: date("period_end", { mode: "string" }),
  confidential: boolean("confidential").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

export type Goal = typeof goalsTable.$inferSelect;
