/**
 * Matching a person by name (build plan section 27). Readers name people the way the message does:
 * "Sam", "Sam H", "Sam Hyams (he/him)". Slack often gives no email, and most people have no Slack
 * id saved, so without this nobody was linked to a task. A first name alone only counts when one
 * person has it, or one of them is in the exchange.
 */
export interface Named {
  id: number;
  name: string;
  isSelf?: boolean;
  /** Main email: its first part is often the full first name, "volodymyr" for Vova (volodymyr.t@) */
  email?: string | null;
}

/** The first part of an address, up to the first dot or underscore: "volodymyr.t@x.com" is "volodymyr". */
const emailFirstKey = (email: string | null | undefined): string => (email ?? "").toLowerCase().split("@")[0].split(/[._]/)[0] ?? "";

/** Lower case, without brackets, dots, underscores or punctuation. */
export const nameKey = (s: string | null | undefined): string =>
  (s ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/[^\p{L}' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const firstNameKey = (s: string | null | undefined): string => nameKey(s).split(" ")[0] ?? "";

function pick<T extends Named>(found: T[], prefer?: ReadonlySet<number>): T | null {
  if (found.length === 1) return found[0];
  const preferred = prefer ? found.filter((p) => prefer.has(p.id)) : [];
  return preferred.length === 1 ? preferred[0] : null;
}

/**
 * The person a name points to, or null when nobody or more than one fits. `prefer` are the people
 * known to be in the exchange; they break a tie. `fullOnly` needs more than a first name.
 */
export function matchName<T extends Named>(hint: string | null | undefined, people: readonly T[], opts: { prefer?: ReadonlySet<number>; fullOnly?: boolean } = {}): T | null {
  const h = nameKey(hint);
  if (!h) return null;
  const pool = people.filter((p) => !p.isSelf);
  const exact = pool.filter((p) => nameKey(p.name) === h);
  if (exact.length) return pick(exact, opts.prefer);
  const ht = h.split(" ");
  if (ht.length === 1 && opts.fullOnly) return null;
  const last = ht[ht.length - 1];
  const found = pool.filter((p) => {
    const pt = nameKey(p.name).split(" ");
    if (pt[0] !== ht[0]) return false;
    if (ht.length === 1) return true;
    const pl = pt[pt.length - 1];
    return pt.length > 1 && (pl === last || (last.length === 1 && pl.startsWith(last)));
  });
  // A first name nobody goes by in People, but that starts someone's email: "Volodymyr" for Vova.
  if (!found.length && ht.length === 1) return pick(pool.filter((p) => emailFirstKey(p.email) === ht[0]), opts.prefer);
  return pick(found, opts.prefer);
}

/** Words in a task title that could be a person: capitalised runs of one or two words, in order. */
export function namesInTitle(title: string): string[] {
  const out: string[] = [];
  const words = title.replace(/\([^)]*\)/g, " ").split(/\s+/).filter(Boolean);
  const cap = (w: string) => /^\p{Lu}\p{Ll}+(?:[-'’]\p{L}+)*$/u.test(w.replace(/[,.;:!?'’]+s?$/u, "").replace(/[’']s$/u, ""));
  const clean = (w: string) => w.replace(/[’']s$/u, "").replace(/[,.;:!?]+$/u, "");
  for (let i = 0; i < words.length; i++) {
    if (!cap(words[i])) continue;
    // The first word of a title is usually a verb ("Send", "Mark"), unless it is "Sam to send…".
    if (i === 0 && words[1]?.toLowerCase() !== "to") continue;
    if (i + 1 < words.length && cap(words[i + 1])) out.push(`${clean(words[i])} ${clean(words[i + 1])}`);
    out.push(clean(words[i]));
  }
  return [...new Set(out)];
}

/** "Volodymyr to set up…", "Paul (RAF) to reply": who a waiting-on title says Ollie is waiting on. */
export function waitingOnInTitle(title: string): string | null {
  const m = /^(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)\s*(?:\([^)]*\)\s*)?\s+to\s+\p{Ll}/u.exec(title.trim());
  return m ? m[1] : null;
}
