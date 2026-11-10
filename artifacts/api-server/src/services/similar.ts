/**
 * A plain "close enough" check for short texts such as task titles and decisions, so a look back
 * does not add something OllieOS already has in slightly different words.
 */
const STOP = new Set(
  "a an and are as at be by for from has have in into is it its of on or our the their them they this to was we were will with you your ollie ollie's about after before over".split(" "),
);

export function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^\p{L}\p{N}'\s]/gu, " ")
      .split(/\s+/)
      .map((w) => w.replace(/'s$/, "").replace(/^'+|'+$/g, ""))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/**
 * True when two texts share most of their words: at least 60% of all words, or every word of the
 * shorter one when it has three or more.
 */
export function closeMatch(a: Set<string> | string, b: Set<string> | string): boolean {
  const x = typeof a === "string" ? wordsOf(a) : a;
  const y = typeof b === "string" ? wordsOf(b) : b;
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  if (shared / union >= 0.6) return true;
  const smaller = Math.min(x.size, y.size);
  return smaller >= 3 && shared === smaller;
}
