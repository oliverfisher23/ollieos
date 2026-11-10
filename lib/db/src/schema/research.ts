import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organisationsTable } from "./knowledge";

/** What the research agent found about one outside company, as shown on prep and organisation pages. */
export interface CompanyResearchBody {
  name: string;
  website: string | null;
  /** Two to four sentences: what they do and for whom */
  overview: string;
  /** Sector, founded, size, headquarters, ownership or funding: whatever could be found */
  facts: { label: string; value: string; url: string | null }[];
  /** Recent news, newest first */
  news: { date: string | null; text: string; url: string | null }[];
  /** The people from this company on Ollie's meetings */
  people: { name: string; role: string | null; note: string | null; url: string | null }[];
  /** Where things stand with Ollie, from his email; null when there was no email */
  relationship: string | null;
  /** Open asks and who owes whom what, from his email */
  openAsks: string[];
  /** Points worth raising, given what Ollie's company does */
  angles: string[];
  sources: { title: string; url: string }[];
}

/**
 * One row per outside company (by email domain). Written by the research agent, never by hand,
 * and never turned into knowledge directly. Research is reused for 30 days.
 */
export const companyResearchTable = pgTable(
  "company_research",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** The company's email domain, lower case */
    domain: text("domain").notNull().unique(),
    organisationId: integer("organisation_id").references(() => organisationsTable.id, { onDelete: "set null" }),
    /** running, ready or failed */
    status: text("status").notNull(),
    body: jsonb("body").$type<CompanyResearchBody>(),
    /** Email threads with the company that were read */
    emailThreads: integer("email_threads").notNull().default(0),
    /** Why the email was not read, when it was not */
    emailNote: text("email_note"),
    searches: integer("searches").notNull().default(0),
    /** Automatic, or Ollie pressed Research */
    trigger: text("trigger").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    researchedAt: timestamp("researched_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("company_research_org_idx").on(t.organisationId)],
);

export type CompanyResearch = typeof companyResearchTable.$inferSelect;
