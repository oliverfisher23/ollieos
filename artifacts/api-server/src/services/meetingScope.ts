/**
 * Internal or external: whether anyone on a meeting is from outside Ollie's own company.
 *
 * Ollie's company is the domain of his own addresses, plus the email domains of people at an
 * organisation marked internal. An attendee is external when they are at an organisation that is
 * not internal, or their address is on any other domain (a personal Gmail address included).
 * Attendees with no address and no organisation are not counted either way.
 */
import { eq } from "drizzle-orm";
import { db, organisationsTable, peopleTable } from "@workspace/db";
import type { CalendarAttendee } from "@workspace/db";

export type MeetingScope = "internal" | "external";

/** Addresses anyone can sign up for: they say nothing about a company. */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "btinternet.com",
  "sky.com",
]);

export const domainOf = (email: string | null | undefined): string | null => {
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
};

export interface ScopeContext {
  /** Ollie's own company's email domains */
  internalDomains: Set<string>;
  /** Each person's organisation, and whether it is internal */
  personOrg: Map<number, { id: number; name: string; internal: boolean }>;
}

export async function loadScopeContext(): Promise<ScopeContext> {
  const { myAddresses } = await import("./connectors/index");
  const [me, rows] = await Promise.all([
    myAddresses(),
    db
      .select({ personId: peopleTable.id, email: peopleTable.email, otherEmails: peopleTable.otherEmails, isSelf: peopleTable.isSelf, orgId: organisationsTable.id, orgName: organisationsTable.name, internal: organisationsTable.internal })
      .from(peopleTable)
      .leftJoin(organisationsTable, eq(peopleTable.organisationId, organisationsTable.id)),
  ]);
  const internalDomains = new Set<string>();
  const add = (email: string | null) => {
    const d = domainOf(email);
    if (d && !FREE_MAIL.has(d)) internalDomains.add(d);
  };
  for (const a of me) add(a);
  const personOrg = new Map<number, { id: number; name: string; internal: boolean }>();
  for (const r of rows) {
    if (r.orgId != null) personOrg.set(r.personId, { id: r.orgId, name: r.orgName!, internal: !!r.internal });
    if (r.internal || r.isSelf) for (const e of [r.email, ...r.otherEmails]) add(e);
  }
  return { internalDomains, personOrg };
}

export interface ScopeResult {
  scope: MeetingScope;
  /** The outside companies on an external meeting: the organisation's name when known, else the email domain */
  companies: string[];
  /** The outside companies' email domains (free mail left out) */
  domains: string[];
}

/** Attendees are the matched ones from a brief match, which already leave Ollie out. */
export function scopeOf(attendees: (CalendarAttendee & { personId: number | null })[], ctx: ScopeContext): ScopeResult {
  const companies: string[] = [];
  const domains: string[] = [];
  const add = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  let external = false;
  for (const a of attendees) {
    const org = a.personId != null ? ctx.personOrg.get(a.personId) : undefined;
    const domain = domainOf(a.email);
    if (org?.internal) continue;
    if (!org && (!domain || ctx.internalDomains.has(domain))) continue;
    external = true;
    const company = domain && !FREE_MAIL.has(domain) && !ctx.internalDomains.has(domain) ? domain : null;
    if (company) add(domains, company);
    if (org) add(companies, org.name);
    else if (company) add(companies, company);
  }
  return { scope: external ? "external" : "internal", companies, domains };
}
