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
  /** Section 28: other names they go by */
  otherNames?: string[] | null;
}

/**
 * Every way a person can be named, as keys: their name, each other name, and each other name with
 * their surname ("Volodymyr" on Vova Tatsakovych also answers to "Volodymyr Tatsakovych").
 */
export function nameKeysOf(p: Named): string[] {
  const main = nameKey(p.name);
  const parts = main.split(" ");
  const surname = parts.length > 1 ? parts[parts.length - 1] : null;
  const out = [main];
  for (const o of p.otherNames ?? []) {
    const k = nameKey(o);
    if (!k) continue;
    out.push(k);
    if (surname && !k.includes(" ")) out.push(`${k} ${surname}`);
  }
  return [...new Set(out.filter(Boolean))];
}

/** Everyone a name could mean: an exact match on any of their names, else the same first name (and surname or initial, when given). */
export function nameCandidates<T extends Named>(hint: string | null | undefined, people: readonly T[], opts: { fullOnly?: boolean } = {}): T[] {
  const h = nameKey(hint);
  if (!h) return [];
  const pool = people.filter((p) => !p.isSelf);
  const exact = pool.filter((p) => nameKeysOf(p).includes(h));
  if (exact.length) return exact;
  const ht = h.split(" ");
  if (ht.length === 1 && opts.fullOnly) return [];
  const last = ht[ht.length - 1];
  return pool.filter((p) =>
    nameKeysOf(p).some((k) => {
      const pt = k.split(" ");
      if (pt[0] !== ht[0]) return false;
      if (ht.length === 1) return true;
      const pl = pt[pt.length - 1];
      return pt.length > 1 && (pl === last || (last.length === 1 && pl.startsWith(last)));
    }),
  );
}

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
  const found = nameCandidates(hint, people, opts);
  return found.length ? pick(found, opts.prefer) : null;
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
