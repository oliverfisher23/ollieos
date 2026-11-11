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

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contradicts"],
  properties: {
    contradicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "why"],
        properties: { ref: { type: "string" }, why: { type: "string" } },
      },
    },
  },
} as const;

function system(now: Date): string {
  return [
    "You check new claims for OllieOS, Ollie Fisher's personal knowledge base, before he approves them.",
    `Today is ${formatLong(todayLondon(now), { withYear: true })} (London).`,
    "You get one new claim in <claim> and the approved knowledge about the same thing in <approved>, each with a ref.",
    'Return in "contradicts" every approved item the claim disagrees with: both cannot be true at once, or the claim changes what the item says (a different date, figure, owner, status, choice or way of doing something).',
    "Leave out items that are only related, say more or less detail, add something new, or could both be true. A plan moving on (a later step after an earlier one) is not a contradiction unless the claim undoes it. When unsure, leave it out. Most claims contradict nothing.",
    '"why" is one short line in plain British English, under 120 characters, saying what differs, for example "The launch is March here, February in the approved fact." No em dashes.',
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
  const r = await haikuJson<{ contradicts?: JudgeVerdict[] }>(system(now), content, SCHEMA, 1024);
  const allowed = new Set(items.map((i) => i.ref));
  const seen = new Set<string>();
  return (r.contradicts ?? [])
    .filter((v) => allowed.has(v.ref) && !seen.has(v.ref) && (seen.add(v.ref), true))
    .map((v) => ({ ref: v.ref, why: (v.why ?? "").replace(/\s*—\s*/g, ", ").trim().slice(0, 200) }));
}
