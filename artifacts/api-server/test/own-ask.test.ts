/** Section 30: what Ollie asks someone else for is theirs to do, never a task for him. */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, peopleTable, reviewItemsTable, tasksTable } from "@workspace/db";
import type { SlackRead } from "../src/services/connectors/slack";
import type { SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { askedOfOllie } from "../src/services/connectors/capture";
import { api, useServer } from "./harness";
import { person } from "./helpers";

let nextSlack: SlackRead = emptySlack();
let answer: (u: WorkUnit) => Partial<SortedUnit> = () => ({});

function emptySlack(): SlackRead {
  return { account: "ollie at Example", me: "UME", opened: [], units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } };
}

vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => nextSlack,
  repliedInThread: async () => false,
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[]) => units.map((u) => ({ summary: "", project: "", items: [], ...answer(u) })),
}));

useServer();

const item = (o: Record<string, unknown>) => ({ ref: "", type: "task", title: "", action: "", priority: "medium", due: "", project: "", person: "", quote: "", confidential: false, same_as: "", quick: false, steps: [], due_guess: "", ...o }) as never;

/** A direct message with Kurt. `said` is oldest first; "me:" marks Ollie's messages. */
function dm(said: string[], kind: "im" | "channel" = "im"): WorkUnit {
  const base = Date.now() - 600_000;
  const messages = said.map((line, i) => {
    const fromMe = line.startsWith("me:");
    const at = new Date(base + i * 60_000);
    return {
      ref: `slack:DK:${(at.getTime() / 1000).toFixed(6)}`,
      at,
      fromMe,
      fromName: fromMe ? null : "Kurt Skillen",
      fromAddress: null,
      fromSlackId: fromMe ? "UME" : "UKURT",
      text: line.replace(/^me:\s*/, ""),
      url: "https://x.slack.com/archives/DK/p" + i,
    };
  });
  return { source: "slack", key: messages[messages.length - 1].ref, subject: null, channel: kind === "im" ? "Kurt Skillen" : "#product", people: [{ name: "Kurt Skillen", email: null, slackId: "UKURT" }], messages, conversation: { id: "DK", kind } };
}

async function slackCheck(units: WorkUnit[]) {
  nextSlack = { ...emptySlack(), units, found: units.length };
  const r = await api("connectors/slack/check", { method: "POST" });
  expect(r.body).toMatchObject({ ok: true });
  return r.body.counts as Record<string, number>;
}

async function kurt() {
  const p = await person("Kurt Skillen");
  await db.update(peopleTable).set({ slackUserId: "UKURT" }).where(eq(peopleTable.id, p.id));
  return p;
}

describe("Titles written from the other side", () => {
  it("spots something to do for Ollie and turns it round", () => {
    expect(askedOfOllie("Send Ollie the product team's December holiday dates")).toBe("send you the product team's December holiday dates");
    expect(askedOfOllie("Share the holiday dates with Ollie")).toBe("share the holiday dates with you");
    expect(askedOfOllie("Let Ollie know when the build is live")).toBe("let you know when the build is live");
    expect(askedOfOllie("Get back to Oliver Fisher on pricing")).toBe("get back to you on pricing");
    expect(askedOfOllie("Send me the deck")).toBe("send you the deck");
    // His own work, and other Olivers, are left alone.
    expect(askedOfOllie("Send Kurt the holiday dates")).toBeNull();
    expect(askedOfOllie("Tell Oliver Smith about the launch")).toBeNull();
    expect(askedOfOllie("Draft the December plan")).toBeNull();
  });
});

describe("What Ollie asked for on Slack", () => {
  const wrong = (u: WorkUnit) => item({ ref: u.messages[u.messages.length - 1].ref, title: "Send Ollie the product team's December holiday dates", quote: "Can you share what holidays product team have in December" });

  it("makes no task when he is waiting for a reply: it is on Messages, Waiting for a reply", async () => {
    await kurt();
    const u = dm(["me: Can you share what holidays product team have in December"]);
    answer = () => ({ reply: { needs: "awaiting", ask: "Kurt to share the product team's December holidays" }, items: [wrong(u)] });
    const counts = await slackCheck([u]);
    expect(counts).toMatchObject({ asked: 1, inbox: 0, waiting: 0 });
    expect(await db.select().from(tasksTable)).toEqual([]);
    const [waiting] = await db.select().from(reviewItemsTable).where(eq(reviewItemsTable.kind, "no_reply"));
    expect(waiting).toMatchObject({ text: "Kurt to share the product team's December holidays", suggestedType: "waiting" });
  });

  it("makes a Waiting on item named for who he asked, not a task for him, when it is not just a reply he waits for", async () => {
    const k = await kurt();
    const u = dm(["me: Can you share what holidays product team have in December", "Will do, need to check with the team first"]);
    answer = () => ({ reply: { needs: "none", ask: "" }, items: [item({ ...(wrong(u) as object), ref: u.messages[0].ref })] });
    const counts = await slackCheck([u]);
    expect(counts).toMatchObject({ waiting: 1, inbox: 0 });
    const [t] = await db.select().from(tasksTable);
    expect(t).toMatchObject({ title: "Kurt to send you the product team's December holiday dates", kind: "task", personId: null, waitingOnPersonId: k.id, fromName: "You" });
  });

  it("treats a title already written as someone else's action the same way", async () => {
    const k = await kurt();
    const u = dm(["me: Can you share the holiday dates?"], "channel");
    answer = () => ({ items: [item({ ref: u.messages[0].ref, title: "Kurt to share the December holiday dates" })] });
    await slackCheck([u]);
    const [t] = await db.select().from(tasksTable);
    expect(t).toMatchObject({ title: "Kurt to share the December holiday dates", personId: null, waitingOnPersonId: k.id });
  });

  it("leaves Ollie's own work from his own message as his task", async () => {
    await kurt();
    const u = dm(["me: I need to draft the December plan before we speak"]);
    answer = () => ({ items: [item({ ref: u.messages[0].ref, title: "Draft the December plan" })] });
    expect((await slackCheck([u])).inbox).toBe(1);
    const [t] = await db.select().from(tasksTable);
    expect(t).toMatchObject({ title: "Draft the December plan", waitingOnPersonId: null });
  });
});
