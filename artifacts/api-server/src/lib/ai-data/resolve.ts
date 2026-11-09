import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { parseRef } from "@workspace/shared";
import { invalid, notFound } from "./errors";
import { organisationVisible, personVisible, projectVisible, type Grants } from "./visibility";

export type EntityKind = "project" | "person" | "organisation";
export const ENTITY_KINDS: readonly EntityKind[] = ["project", "person", "organisation"];

/** How an AI names a project, person or organisation: a ref, a slug or a name (an email also works for people). */
export interface EntityPick {
  ref?: string;
  slug?: string;
  name?: string;
  type?: EntityKind;
}

export interface Found {
  type: EntityKind;
  id: number;
  name: string;
  slug: string;
  /** Whether the scope that asked can see it. Callers facing an AI only ever use visible rows. */
  visible: boolean;
}

const TABLE: Record<EntityKind, string> = { project: "projects", person: "people", organisation: "organisations" };
const VISIBLE: Record<EntityKind, (alias: string, g: Grants) => string> = {
  project: projectVisible,
  person: personVisible,
  organisation: organisationVisible,
};

type By = "id" | "slug" | "email" | "name";

async function matchRows(kind: EntityKind, by: By, value: string | number, g: Grants): Promise<Found[]> {
  if (by === "email" && kind !== "person") return [];
  const v = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (v === "" || v == null) return [];
  const cond =
    by === "id" ? sql`m.id = ${Number(v)}` : by === "slug" ? sql`m.slug = ${v}` : by === "email" ? sql`lower(m.email) = ${v}` : sql`lower(m.name) = ${v}`;
  const res = await db.execute(
    sql`select m.id, m.name, m.slug, (${sql.raw(VISIBLE[kind]("m", g))}) as visible from ${sql.raw(TABLE[kind])} m where ${cond} order by m.id limit 5`,
  );
  return (res.rows as { id: number; name: string; slug: string; visible: boolean }[]).map((r) => ({
    type: kind,
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    visible: !!r.visible,
  }));
}

/**
 * Every row a piece of text could mean, trying ref, then slug, then email, then exact name, and
 * stopping at the first step that matches anything. Includes hidden rows, flagged.
 */
export async function findEntities(text: string, kinds: readonly EntityKind[], g: Grants): Promise<Found[]> {
  const t = text.trim();
  if (!t) return [];
  const ref = parseRef(t);
  if (ref) return (kinds as readonly string[]).includes(ref.type) ? matchRows(ref.type as EntityKind, "id", ref.id, g) : [];
  const steps: By[] = t.includes("@") ? ["slug", "email", "name"] : ["slug", "name"];
  for (const by of steps) {
    const rows = (await Promise.all(kinds.map((k) => matchRows(k, by, t, g)))).flat();
    if (rows.length) return rows;
  }
  return [];
}

function kindsFor(pick: EntityPick, allowed: readonly EntityKind[]): EntityKind[] {
  return pick.type ? allowed.filter((k) => k === pick.type) : [...allowed];
}

const label = (kinds: readonly EntityKind[]) => (kinds.length === 1 ? `That ${kinds[0]}` : "That item");

/**
 * Resolves an AI's EntityPick to one visible item. Hidden and missing items both give not_found,
 * so the error never confirms that something hidden exists.
 */
export async function resolvePick(g: Grants, pick: EntityPick, allowed: readonly EntityKind[] = ENTITY_KINDS): Promise<Found> {
  const kinds = kindsFor(pick, allowed);
  const text = pick.ref ?? pick.slug ?? pick.name;
  if (!text?.trim()) throw invalid("Name the item with a ref, a slug or a name.");
  if (!kinds.length) throw invalid(`Expected one of: ${allowed.join(", ")}.`);
  let rows: Found[];
  if (pick.ref) {
    const ref = parseRef(pick.ref);
    if (!ref) throw invalid(`"${pick.ref}" is not a ref. Refs look like project:12.`);
    rows = (kinds as string[]).includes(ref.type) ? await matchRows(ref.type as EntityKind, "id", ref.id, g) : [];
  } else if (pick.slug) {
    rows = (await Promise.all(kinds.map((k) => matchRows(k, "slug", pick.slug!, g)))).flat();
  } else {
    rows = await findEntities(pick.name!, kinds, g);
  }
  const visible = rows.filter((r) => r.visible);
  if (visible.length === 1) return visible[0];
  if (visible.length > 1) throw invalid(`More than one item matches "${text}". Use a ref instead: ${visible.map((v) => `${v.type}:${v.id}`).join(", ")}.`);
  throw notFound(label(kinds));
}

/**
 * Loose matching for hints and name lists (people on an activity, attendees, project hints).
 * Returns one item or null. With visibleOnly, hidden rows count as no match.
 */
export async function resolveLoose(text: string, kinds: readonly EntityKind[], g: Grants, visibleOnly: boolean): Promise<Found | null> {
  const rows = (await findEntities(text, kinds, g)).filter((r) => !visibleOnly || r.visible);
  return rows.length === 1 ? rows[0] : null;
}
