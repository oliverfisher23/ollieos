/** Entity refs look like "task:42". They are how Ask answers cite items and how links name both ends. */
export const REF_TYPES = ["task", "project", "person", "organisation", "decision", "note", "fact", "activity", "goal", "document", "playbook"] as const;
export type RefType = (typeof REF_TYPES)[number];

export interface Ref {
  type: RefType;
  id: number;
}

export function toRef(type: RefType, id: number): string {
  return `${type}:${id}`;
}

export function parseRef(value: string): Ref | null {
  const m = /^([a-z_]+):(\d+)$/.exec(value.trim());
  if (!m) return null;
  const type = m[1] as RefType;
  if (!(REF_TYPES as readonly string[]).includes(type)) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
}

/** Lower-case, hyphenated slug from a name. */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}
