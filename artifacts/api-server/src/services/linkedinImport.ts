/**
 * LinkedIn connections import. Ollie uploads Connections.csv from LinkedIn's data export (Settings,
 * Data privacy, Get a copy of your data). Each connection is matched to someone already in OllieOS,
 * by email when LinkedIn has one, otherwise by name (and company when two people share a name).
 * For a match, OllieOS proposes what is missing or has changed (job title, organisation, LinkedIn
 * link) as a change card in the Knowledge Inbox; a move to a company OllieOS does not know becomes an
 * organisation fact, so it can open a conflict against what is held. Nothing changes until Ollie
 * approves. Connections that match nobody are not kept: only counts are stored.
 */
import { eq } from "drizzle-orm";
import { appSettingsTable, db, organisationsTable, peopleTable } from "@workspace/db";
import { linkedinProfileUrl } from "@workspace/shared";
import { ValidationError } from "./tasks";
import { propose, type ProposeMeta, type ProposeResult } from "./suggestions";

export const LINKEDIN_PROPOSER = "LinkedIn import";
const LAST_KEY = "linkedin_import_last";
/** More rows than any real export; a guard against the wrong file. */
const MAX_ROWS = 30_000;

export interface Connection {
  firstName: string;
  lastName: string;
  url: string | null;
  email: string | null;
  company: string;
  position: string;
  connectedOn: string;
}

export interface LinkedInImportResult {
  at: Date;
  /** Rows in the file */
  connections: number;
  /** Connections matched to someone in OllieOS */
  matched: number;
  /** Matched, and OllieOS already holds the same details */
  upToDate: number;
  /** Change cards made (missing details, a new role or organisation) */
  changes: number;
  /** Organisation facts made for a company OllieOS does not know */
  facts: number;
  /** Proposals already waiting in the Knowledge Inbox, or rejected lately */
  alreadyProposed: number;
  /** Names that fit more than one person in OllieOS and were left alone */
  ambiguous: number;
  /** Matched people hidden from AI, left alone */
  hidden: number;
}

/* ---------- CSV ---------- */

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADERS = { firstName: "first name", lastName: "last name", url: "url", email: "email address", company: "company", position: "position", connectedOn: "connected on" } as const;

/** Connections from LinkedIn's Connections.csv. The export starts with a few lines of notes before the header row. */
export function parseConnections(text: string): Connection[] {
  const rows = parseCsv(text);
  const headerAt = rows.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return cells.includes(HEADERS.firstName) && cells.includes(HEADERS.lastName);
  });
  if (headerAt < 0) throw new ValidationError("This does not look like LinkedIn's Connections.csv: there is no First Name and Last Name header.");
  const header = rows[headerAt].map((c) => c.trim().toLowerCase());
  const col = (k: keyof typeof HEADERS) => header.indexOf(HEADERS[k]);
  const idx = { firstName: col("firstName"), lastName: col("lastName"), url: col("url"), email: col("email"), company: col("company"), position: col("position"), connectedOn: col("connectedOn") };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const out: Connection[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const firstName = get(r, idx.firstName);
    const lastName = get(r, idx.lastName);
    if (!firstName && !lastName) continue;
    const email = get(r, idx.email).toLowerCase();
    out.push({
      firstName,
      lastName,
      url: linkedinProfileUrl(get(r, idx.url)),
      email: email.includes("@") ? email : null,
      company: get(r, idx.company),
      position: get(r, idx.position),
      connectedOn: get(r, idx.connectedOn),
    });
  }
  if (out.length > MAX_ROWS) throw new ValidationError(`That file has ${out.length} rows; LinkedIn exports are smaller. Check it is Connections.csv.`);
  return out;
}

/* ---------- Matching ---------- */

/** Letters credentials and titles people add to their LinkedIn name. */
const NAME_NOISE = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "phd", "mba", "msc", "ma", "bsc", "ba", "beng", "meng", "frsa", "cipd", "mcipd", "fcipd", "acca", "aca", "fca", "cfa", "pmp", "cmgr", "fcmi", "obe", "mbe", "cbe", "fhea", "sfhea", "pgce", "llb", "llm"]);

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Name tokens without accents, emoji, credentials or anything after a comma. */
export function nameTokens(name: string): string[] {
  const s = fold(name).replace(/\(.*?\)/g, " ").split(",")[0];
  return s
    .replace(/[^a-z' -]/g, " ")
    .split(/[\s-]+/)
    .map((t) => t.replace(/'/g, ""))
    .filter((t) => t && !NAME_NOISE.has(t));
}

/** Full name, and first-plus-last, so "Anna Marie Clarke" still finds "Anna Clarke". */
export function nameKeys(name: string): string[] {
  const t = nameTokens(name);
  if (!t.length) return [];
  const keys = [t.join(" ")];
  if (t.length > 2) keys.push(`${t[0]} ${t[t.length - 1]}`);
  return keys;
}

const COMPANY_NOISE = new Set(["ltd", "limited", "plc", "inc", "llc", "llp", "group", "the", "co", "company", "corp", "corporation", "uk", "gmbh", "ag", "sa"]);

export function companyKey(name: string | null | undefined): string {
  return fold(name ?? "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !COMPANY_NOISE.has(t))
    .join(" ");
}

/** The same company, allowing "Kestrel" for "Kestrel Bank plc". */
export function sameCompany(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && (` ${long} `.includes(` ${short} `));
}

/** The same job title, allowing one to hold the other ("Careers Lead" and "Careers Lead, UK"). */
export function sameRole(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = fold(a ?? "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const y = fold(b ?? "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

interface Known {
  id: number;
  name: string;
  role: string | null;
  email: string | null;
  otherEmails: string[];
  linkedinUrl: string | null;
  confidential: boolean;
  aiAccess: boolean;
  orgId: number | null;
  orgName: string | null;
}

export type MatchOutcome = { person: Known } | { ambiguous: true } | null;

/** Email first, then a name that fits one person, then a shared name narrowed by company. */
export function matchConnection(c: Connection, people: Known[], byName: Map<string, Known[]>, byEmail: Map<string, Known>): MatchOutcome {
  if (c.email) {
    const p = byEmail.get(c.email);
    if (p) return { person: p };
  }
  if (c.url) {
    const p = people.find((x) => x.linkedinUrl === c.url);
    if (p) return { person: p };
  }
  for (const key of nameKeys(`${c.firstName} ${c.lastName}`)) {
    const found = byName.get(key);
    if (!found?.length) continue;
    const unique = [...new Map(found.map((p) => [p.id, p])).values()];
    if (unique.length === 1) return { person: unique[0] };
    const atCompany = unique.filter((p) => sameCompany(p.orgName, c.company));
    if (atCompany.length === 1) return { person: atCompany[0] };
    return { ambiguous: true };
  }
  return null;
}

/* ---------- Import ---------- */

export async function importLinkedInConnections(csv: string, now = new Date()): Promise<LinkedInImportResult> {
  const connections = parseConnections(csv);
  const [people, orgs] = await Promise.all([
    db
      .select({
        id: peopleTable.id,
        name: peopleTable.name,
        role: peopleTable.role,
        email: peopleTable.email,
        otherEmails: peopleTable.otherEmails,
        linkedinUrl: peopleTable.linkedinUrl,
        confidential: peopleTable.confidential,
        aiAccess: peopleTable.aiAccess,
        isSelf: peopleTable.isSelf,
        orgId: organisationsTable.id,
        orgName: organisationsTable.name,
      })
      .from(peopleTable)
      .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId)),
    db.select({ id: organisationsTable.id, name: organisationsTable.name }).from(organisationsTable),
  ]);
  const known: Known[] = people.filter((p) => !p.isSelf);
  const byName = new Map<string, Known[]>();
  const byEmail = new Map<string, Known>();
  for (const p of known) {
    for (const k of nameKeys(p.name)) byName.set(k, [...(byName.get(k) ?? []), p]);
    for (const e of [p.email, ...p.otherEmails]) if (e) byEmail.set(e.toLowerCase(), p);
  }
  // An organisation OllieOS knows by exactly this name, so a move can be one change card.
  const orgByKey = new Map<string, { id: number; name: string }[]>();
  for (const o of orgs) {
    const k = companyKey(o.name);
    if (k) orgByKey.set(k, [...(orgByKey.get(k) ?? []), o]);
  }
  const knownOrg = (company: string) => {
    const found = orgByKey.get(companyKey(company));
    return found?.length === 1 ? found[0] : null;
  };

  const result: LinkedInImportResult = { at: now, connections: connections.length, matched: 0, upToDate: 0, changes: 0, facts: 0, alreadyProposed: 0, ambiguous: 0, hidden: 0 };
  const seen = new Set<number>();
  const tally = (r: ProposeResult, kind: "changes" | "facts") => {
    if (r.status === "suggested" || r.status === "conflict") result[kind]++;
    else result.alreadyProposed++;
  };

  for (const c of connections) {
    const m = matchConnection(c, known, byName, byEmail);
    if (!m) continue;
    if ("ambiguous" in m) {
      result.ambiguous++;
      continue;
    }
    const p = m.person;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    result.matched++;
    // Same rule as the other automatic readers: people hidden from AI are not proposed about.
    if (p.confidential || !p.aiAccess) {
      result.hidden++;
      continue;
    }

    const fields: Record<string, string> = {};
    const before: Record<string, string | null> = {};
    let organisationId: number | null = null;
    let orgFact: string | null = null;
    if (c.url && !p.linkedinUrl) {
      fields.linkedin_url = c.url;
      before.linkedin_url = null;
    }
    if (c.position && !sameRole(p.role, c.position)) {
      fields.role = c.position;
      before.role = p.role;
    }
    if (c.company && !sameCompany(p.orgName, c.company)) {
      const org = knownOrg(c.company);
      if (org) {
        fields.organisation = org.name;
        before.organisation = p.orgName;
        organisationId = org.id;
      } else {
        orgFact = c.company;
      }
    }
    if (!Object.keys(fields).length && !orgFact) {
      result.upToDate++;
      continue;
    }

    const changed = before.role != null || before.organisation != null || (orgFact != null && p.orgName != null);
    const label = c.connectedOn ? `LinkedIn connections export (connected ${c.connectedOn})` : "LinkedIn connections export";
    const meta: ProposeMeta = { proposedBy: LINKEDIN_PROPOSER, clientId: null, sourceType: "linkedin", sourceUrl: c.url, sourceLabel: label };
    if (Object.keys(fields).length) {
      tally(
        await propose(
          { ...meta, sourceRef: `linkedin:${p.id}:change` },
          {
            kind: "summary_change",
            entityType: "person",
            entityId: p.id,
            payload: {
              fields,
              before,
              organisation_id: organisationId,
              reason: changed ? `LinkedIn shows a different job${c.company ? ` (${[c.position, c.company].filter(Boolean).join(" at ")})` : ""}.` : "Missing details, from LinkedIn.",
            },
          },
          now,
        ),
        "changes",
      );
    }
    if (orgFact) {
      tally(
        await propose(
          { ...meta, sourceRef: `linkedin:${p.id}:org` },
          { kind: "fact", entityType: "person", entityId: p.id, payload: { text: `${p.name} works at ${orgFact}`, attribute: "organisation", source: label } },
          now,
        ),
        "facts",
      );
    }
  }

  const value = { ...result, at: now.toISOString() };
  await db.insert(appSettingsTable).values({ key: LAST_KEY, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value } });
  return result;
}

/** The last import's counts, for the Contacts page. */
export async function lastLinkedInImport(): Promise<LinkedInImportResult | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, LAST_KEY));
  if (!row) return null;
  const v = row.value as LinkedInImportResult & { at: string };
  return { ...v, at: new Date(v.at) };
}
