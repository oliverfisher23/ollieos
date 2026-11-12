/**
 * Which organisation someone on a meeting probably belongs to, from their email domain, so adding
 * them to Contacts from a meeting can set it in one go.
 *
 * Organisations hold no domain of their own, so the domain is learnt from people already in
 * Contacts: the organisation most of them at that domain belong to. Ollie's own company's domain
 * falls back to the one internal organisation, when there is exactly one. Otherwise a new
 * organisation named after the domain is offered. Personal addresses (Gmail and the like) get nothing.
 */
import { eq } from "drizzle-orm";
import { db, organisationsTable, peopleTable } from "@workspace/db";
import { FREE_MAIL, domainOf, loadScopeContext } from "./meetingScope";

export interface OrgSuggestion {
  /** An organisation already in Contacts */
  existing: { id: number; name: string; slug: string } | null;
  /** When none fits: a name for a new one, from the domain */
  newName: string | null;
  /** Whether the domain is Ollie's own company's */
  internal: boolean;
}

/** "rolls-royce.co.uk" becomes "Rolls-Royce". */
export function nameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join("-");
}

export async function suggestOrganisations(emails: (string | null | undefined)[]): Promise<Map<string, OrgSuggestion>> {
  const wanted = new Set(emails.map((e) => domainOf(e)).filter((d): d is string => !!d && !FREE_MAIL.has(d)));
  const out = new Map<string, OrgSuggestion>();
  if (!wanted.size) return out;
  const [rows, internalOrgs, scope] = await Promise.all([
    db
      .select({ email: peopleTable.email, otherEmails: peopleTable.otherEmails, id: organisationsTable.id, name: organisationsTable.name, slug: organisationsTable.slug })
      .from(peopleTable)
      .innerJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId)),
    db.select({ id: organisationsTable.id, name: organisationsTable.name, slug: organisationsTable.slug }).from(organisationsTable).where(eq(organisationsTable.internal, true)),
    loadScopeContext(),
  ]);
  const counts = new Map<string, Map<number, { org: OrgSuggestion["existing"] & object; n: number }>>();
  for (const r of rows) {
    for (const e of [r.email, ...r.otherEmails]) {
      const d = domainOf(e);
      if (!d || !wanted.has(d)) continue;
      const byOrg = counts.get(d) ?? new Map();
      const cur = byOrg.get(r.id) ?? { org: { id: r.id, name: r.name, slug: r.slug }, n: 0 };
      cur.n++;
      byOrg.set(r.id, cur);
      counts.set(d, byOrg);
    }
  }
  for (const d of wanted) {
    const internal = scope.internalDomains.has(d);
    const best = [...(counts.get(d)?.values() ?? [])].sort((a, b) => b.n - a.n)[0]?.org ?? null;
    const existing = best ?? (internal && internalOrgs.length === 1 ? internalOrgs[0] : null);
    out.set(d, { existing, newName: existing ? null : nameFromDomain(d), internal });
  }
  return out;
}

/** The suggestion for one address, or null for personal addresses and those with no domain. */
export function suggestionFor(map: Map<string, OrgSuggestion>, email: string | null | undefined): OrgSuggestion | null {
  const d = domainOf(email);
  return d ? (map.get(d) ?? null) : null;
}
