/**
 * Finding people by email or Slack account (Part N). A person can have a main email, other emails
 * and a Slack user id; every reader matches on any of them, so the same person is found wherever
 * they turn up. Other emails are always stored in lower case.
 */
import { inArray, or, sql, type SQL } from "drizzle-orm";
import { db, peopleTable } from "@workspace/db";

export const emailKey = (e: string | null | undefined): string | null => {
  const v = (e ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
};

/** Every address a person uses, main one first, in lower case. */
export function emailsOf(p: { email: string | null; otherEmails?: string[] | null }): string[] {
  const out: string[] = [];
  for (const e of [p.email, ...(p.otherEmails ?? [])]) {
    const k = emailKey(e);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

const textArray = (values: string[]): SQL => sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

/** True for a person with this address, main or other. */
export function hasEmail(email: string): SQL {
  const e = email.trim().toLowerCase();
  return sql`(lower(${peopleTable.email}) = ${e} or ${e} = any(${peopleTable.otherEmails}))`;
}

/** True for a person with any of these addresses. */
export function hasAnyEmail(emails: string[]): SQL {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return sql`false`;
  return or(inArray(sql`lower(${peopleTable.email})`, list), sql`${peopleTable.otherEmails} && ${textArray(list)}`)!;
}

/** True for a person with any of these Slack user ids. */
export function hasAnySlackId(ids: string[]): SQL {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return sql`false`;
  return inArray(peopleTable.slackUserId, list);
}

/** Maps each address (lower case) to the row that uses it. Rows need email and otherEmails. */
export function byEmailMap<T extends { email: string | null; otherEmails: string[] }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) for (const e of emailsOf(r)) if (!m.has(e)) m.set(e, r);
  return m;
}

/** The person (id and name) with this address, if any. */
export async function personByEmail(email: string): Promise<{ id: number; name: string } | null> {
  const [p] = await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(hasEmail(email)).limit(1);
  return p ?? null;
}
