/**
 * The contradiction check (Part O): Haiku reads one Knowledge Inbox card beside the approved
 * facts, decisions and rules about the same thing, and says which of them it disagrees with. It
 * only reads what it is given (items AI may see) and writes nothing.
 */
import { formatLong, todayLondon } from "@workspace/shared";
import { haikuJson } from "./connectors/sorter";

export interface JudgeCard {
  /** fact, decision or rule */
  kind: string;
  /** What the card is about, such as "project Atlas launch" */
  about: string;
  text: string;
  saidBy: string | null;
  saidAt: Date | null;
}

export interface JudgeItem {
  /** fact:12, decision:4, rule:2 */
  ref: string;
  text: string;
  at: Date | null;
}

export interface JudgeVerdict {
  ref: string;
  /** One line on how they disagree */
  why: string;
}

/**
 * Each approved item the model looked at closely, with its reasoning first and a yes or no after,
 * so a "these do not clash" reason can never be counted as a contradiction.
 */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "reasoning", "contradicts", "why"],
        properties: {
          ref: { type: "string" },
          reasoning: { type: "string" },
          contradicts: { type: "boolean" },
          why: { type: "string" },
        },
      },
    },
  },
} as const;

function system(now: Date): string {
  return [
    "You check new claims for OllieOS, Ollie Fisher's personal knowledge base, before he approves them.",
    `Today is ${formatLong(todayLondon(now), { withYear: true })} (London).`,
    "You get one new claim in <claim> and the approved knowledge about the same thing in <approved>, each with a ref.",
    'In "items", list each approved item that is about the same thing as the claim (leave out the rest). For each: "reasoning" says in a line what the claim says and what the item says; then "contradicts" is true only if both cannot be true at once, or the claim changes what the item says (a different date, figure, owner, status, choice or way of doing something).',
    '"contradicts" is false when they are only related, one says more or less than the other, the claim adds something new, they could both be true, or a rule simply does not cover the claim. A plan moving on (a later step after an earlier one) is not a contradiction unless the claim undoes it. When unsure, false. Most claims contradict nothing.',
    '"why" (only read when "contradicts" is true) is one short line in plain British English, under 120 characters, saying what differs, for example "The launch is March here, February in the approved fact." No em dashes.',
  ].join("\n");
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "unknown");

export async function judgeContradictions(card: JudgeCard, items: JudgeItem[], now = new Date()): Promise<JudgeVerdict[]> {
  if (!items.length) return [];
  const content = [
    "<claim>",
    `kind: ${card.kind}`,
    `about: ${card.about}`,
    `said by: ${card.saidBy ?? "unknown"}, ${day(card.saidAt)}`,
    `text: ${card.text}`,
    "</claim>",
    "<approved>",
    ...items.map((i) => `[${i.ref}] (${day(i.at)}) ${i.text}`),
    "</approved>",
  ].join("\n");
  const r = await haikuJson<{ items?: (JudgeVerdict & { contradicts?: boolean })[] }>(system(now), content, SCHEMA, 2048);
  const allowed = new Set(items.map((i) => i.ref));
  const seen = new Set<string>();
  return (r.items ?? [])
    .filter((v) => v.contradicts === true && allowed.has(v.ref) && !seen.has(v.ref) && (seen.add(v.ref), true))
    .map((v) => ({ ref: v.ref, why: (v.why ?? "").replace(/\s*—\s*/g, ", ").trim().slice(0, 200) }));
}
