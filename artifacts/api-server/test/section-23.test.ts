/**
 * Build plan section 23: five new agents. The Knowledge Inbox pre-sorter, the stale fact checker,
 * the delegation suggester, the Friday update and the idea spotter. The model is stood in at the
 * one place OllieOS calls it (recordedCreate), so the real prompts are built and the real answers
 * parsed; each test says what the stand-in returns for its agent.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  decisionsTable,
  factReviewsTable,
  factsTable,
  ideasTable,
  notesTable,
  peopleTable,
  suggestionsTable,
  tasksTable,
  weeklyUpdatesTable,
} from "@workspace/db";
import type { AgentKey } from "../src/lib/agents";
import { propose } from "../src/services/suggestions";
import { presortCards } from "../src/services/presort";
import { checkStaleFacts } from "../src/services/staleCheck";
import { suggestDelegations } from "../src/services/delegation";
import { cleanSections, renderUpdate, weekEndingFor } from "../src/services/weeklyUpdate";
import { captureMeetings } from "../src/services/connectors/meetingCapture";
import { sortAndCapture } from "../src/services/connectors/capture";
import type { WorkUnit } from "../src/services/connectors/messages";
import { scorecards } from "../src/services/scorecards";
import { api, useServer } from "./harness";
import { organisation, person, project } from "./helpers";

type Call = { agent: AgentKey; system: string; content: string };
const calls: Call[] = [];
/** What the stand-in model answers, per agent; it gets what it was shown. */
const answers: Partial<Record<AgentKey, (c: Call) => unknown>> = {};

vi.mock("../src/lib/aiRuns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/aiRuns")>()),
  recordedCreate: async (agent: AgentKey, params: { system: string; messages: { content: string }[] }) => {
    const c = { agent, system: String(params.system), content: String(params.messages[0].content) };
    calls.push(c);
    const answer = answers[agent];
    if (!answer) throw new Error(`No stand-in answer for ${agent}`);
    return { content: [{ type: "text", text: JSON.stringify(answer(c)) }], usage: {} };
  },
}));

useServer();

const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k as AgentKey];
};
const DAY = 86_400_000;
const meta = { proposedBy: "Gmail check", clientId: null, sourceType: "email" };
const factCard = async (orgId: number, text: string) =>
  ((await propose(meta, { kind: "fact", entityType: "organisation", entityId: orgId, payload: { text, attribute: null, supersedes: null, source: null } })) as { suggestionId: number }).suggestionId;

/** The card ids and texts the pre-sorter was shown, in order. */
const shownCards = (content: string) => [...content.matchAll(/<card id="(c\d+)">[\s\S]*?text: (.*)\n/g)].map((m) => ({ id: m[1], text: m[2] }));

describe("Knowledge Inbox pre-sorter", () => {
  it("hints each card, finds repeats without the model, keeps hidden cards away from it, and merges in bulk", async () => {
    reset();
    const acme = await organisation("Acme");
    const secret = await organisation("Project Falcon buyer", { confidential: true });
    const [leeds] = await db.insert(factsTable).values({ entityType: "organisation", entityId: acme.id, text: "Acme is based in Leeds", createdBy: "ollie" }).returning();
    const staff = await factCard(acme.id, "Acme has 400 staff across three offices");
    const chat = await factCard(acme.id, "Sam enjoyed the chat on Tuesday");
    const same = await factCard(acme.id, "Acme is in Leeds");
    const hidden = await factCard(secret.id, "The buyer wants to close in March");
    // The same claim again, a little later: a repeat of the first.
    await new Promise((r) => setTimeout(r, 5));
    const repeat = await factCard(acme.id, "Acme has about 400 staff across its three offices");

    answers.presorter = (c) => ({
      cards: shownCards(c.content).map((x) => {
        if (x.text.includes("400")) return { card: x.id, reasoning: "A lasting fact", verdict: "keep", same_as: "", why: "A lasting fact about Acme" };
        if (x.text.includes("chat")) return { card: x.id, reasoning: "Small talk", verdict: "reject", same_as: "", why: "Small talk — not knowledge" };
        return { card: x.id, reasoning: "Says the approved fact again", verdict: "same", same_as: `fact:${leeds.id}`, why: "Already approved" };
      }),
    });
    const r = await presortCards();
    expect(r).toMatchObject({ looked: 5, repeats: 1, hinted: 3, private: 1, failed: false });
    // Only the AI-visible cards went to the model, never the confidential organisation's.
    expect(calls.map((c) => c.agent)).toEqual(["presorter"]);
    expect(calls[0].content).not.toContain("buyer");
    expect(calls[0].content).toContain(`[fact:${leeds.id}] Acme is based in Leeds`);

    const hint = async (id: number) => (await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, id)))[0].presort;
    expect(await hint(staff)).toEqual({ verdict: "keep", why: "A lasting fact about Acme" });
    expect(await hint(chat)).toEqual({ verdict: "reject", why: "Small talk, not knowledge" });
    expect(await hint(same)).toMatchObject({ verdict: "same", sameAs: { type: "fact", id: leeds.id } });
    expect(await hint(repeat)).toMatchObject({ verdict: "duplicate", duplicateOf: staff });
    expect(await hint(hidden)).toBeNull();

    // A second pass looks at nothing new.
    expect((await presortCards()).looked).toBe(0);

    // The Suggested tab filters by hint and counts each.
    const keep = await api("suggestions?hint=keep");
    expect(keep.body.items.map((i: { id: number }) => i.id)).toEqual([staff]);
    expect(keep.body.items[0].presort.verdict).toBe("keep");
    expect(keep.body.presort).toMatchObject({ keep: 1, reject: 1, same: 1, duplicate: 1, none: 1 });

    // Merge the "same" cards into what they name; a card with no such hint is skipped.
    const merged = await api("suggestions/bulk", { method: "POST", body: { action: "same", ids: [same, chat] } });
    expect(merged.body).toMatchObject({ merged: 1, skipped: [{ id: chat, reason: "No match to merge it into" }] });
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, same)))[0].status).toBe("merged");

    // The scorecard counts a hint Ollie agreed with, and one he did not.
    await api("suggestions/bulk", { method: "POST", body: { action: "approve", ids: [staff, chat] } });
    const m = (await scorecards()).find((x) => x.key === "presort")!;
    expect(m).toMatchObject({ kept: 2, undone: 1 });
  });
});

describe("Stale fact checker", () => {
  async function staleFact(orgId: number, text: string, daysOld: number) {
    const [f] = await db
      .insert(factsTable)
      .values({ entityType: "organisation", entityId: orgId, text, createdBy: "ollie", lastConfirmedAt: new Date(Date.now() - daysOld * DAY), needsCheck: true })
      .returning();
    const [r] = await db.insert(factReviewsTable).values({ kind: "stale", factIds: [f.id] }).returning();
    return { fact: f, review: r };
  }

  it("reads what was seen since, says still true or changed, and never calls the model with nothing to read", async () => {
    reset();
    const acme = await organisation("Acme");
    const quiet = await organisation("Quiet Ltd");
    const hiddenOrg = await organisation("Hidden Co", { confidential: true });
    const changed = await staleFact(acme.id, "Acme is in a pilot", 120);
    const nothing = await staleFact(quiet.id, "Quiet Ltd has two staff", 120);
    const hidden = await staleFact(hiddenOrg.id, "Hidden Co is for sale", 120);
    const [n] = await db.insert(notesTable).values({ entityType: "organisation", entityId: acme.id, body: "Acme signed the full three-year contract", createdBy: "ollie" }).returning();

    answers.stale_checker = (c) => ({
      reasoning: "The note says they signed",
      verdict: "changed",
      new_text: "Acme is a full client on a three-year contract",
      why: "A note says they signed the full contract",
      used: c.content.includes(`note:${n.id}`) ? [`note:${n.id}`, "note:999"] : [],
    });
    const r = await checkStaleFacts();
    expect(r).toMatchObject({ looked: 3, changed: 1, none: 1, private: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toContain("Acme signed the full three-year contract");

    const ev = async (id: number) => (await db.select().from(factReviewsTable).where(eq(factReviewsTable.id, id)))[0].evidence;
    expect(await ev(changed.review.id)).toMatchObject({ verdict: "changed", newText: "Acme is a full client on a three-year contract", sources: [{ ref: `note:${n.id}`, label: "Note" }] });
    expect(await ev(nothing.review.id)).toMatchObject({ verdict: "none", sources: [] });
    expect(await ev(hidden.review.id)).toBeNull();

    // Needs a check shows what was found.
    const tab = await api("suggestions?tab=stale");
    const card = tab.body.items.find((i: { id: number }) => i.id === changed.review.id);
    expect(card.evidence.verdict).toBe("changed");
  });

  it("confirms every fact it found still true, as if pressed one by one", async () => {
    reset();
    const acme = await organisation("Acme");
    const a = await staleFact(acme.id, "Acme is based in Leeds", 400);
    await db.insert(notesTable).values({ entityType: "organisation", entityId: acme.id, body: "Visited Acme at their Leeds office", createdBy: "ollie" });
    answers.stale_checker = (c) => ({ reasoning: "Visited Leeds office", verdict: "confirmed", new_text: "", why: "Visited their Leeds office", used: [c.content.match(/\[(note:\d+)\]/)![1]] });
    await checkStaleFacts();
    const res = await api("fact-reviews/confirm-found", { method: "POST" });
    expect(res.body).toEqual({ confirmed: 1 });
    const [f] = await db.select().from(factsTable).where(eq(factsTable.id, a.fact.id));
    expect(f.needsCheck).toBe(false);
    expect(Date.now() - f.lastConfirmedAt.getTime()).toBeLessThan(60_000);
    const m = (await scorecards()).find((x) => x.key === "stale_evidence")!;
    expect(m).toMatchObject({ kept: 1, undone: 0 });
  });

  it("does not trust a verdict that cites nothing it was given", async () => {
    reset();
    const acme = await organisation("Acme");
    const s = await staleFact(acme.id, "Acme has 40 staff", 200);
    await db.insert(notesTable).values({ entityType: "organisation", entityId: acme.id, body: "Lunch with Acme", createdBy: "ollie" });
    answers.stale_checker = () => ({ reasoning: "", verdict: "confirmed", new_text: "", why: "Seems fine", used: ["note:12345"] });
    await checkStaleFacts();
    const [r] = await db.select().from(factReviewsTable).where(eq(factReviewsTable.id, s.review.id));
    expect(r.evidence?.verdict).toBe("none");
  });
});

describe("Delegation suggester", () => {
  it("suggests a colleague with a draft, never one hidden from AI or the person the task came from, and Not this one sticks", async () => {
    reset();
    const ely = await project("Ely rollout");
    const sam = await person("Sam Lee", { role: "Head of Delivery" });
    const kim = await person("Kim Secret", { confidential: true });
    await db.update(peopleTable).set({ slackUserId: "USAM" }).where(eq(peopleTable.id, sam.id));
    await db.update(peopleTable).set({ slackUserId: "UKIM" }).where(eq(peopleTable.id, kim.id));
    const [plan] = await db.insert(tasksTable).values({ title: "Send the Ely rollout timetable to schools", status: "now", projectId: ely.id, createdBy: "ollie" }).returning();
    const [fromSam] = await db.insert(tasksTable).values({ title: "Review Sam's delivery report", status: "backlog", personId: sam.id, createdBy: "ollie" }).returning();
    const [hiddenTask] = await db.insert(tasksTable).values({ title: "Board pack for the sale", status: "now", confidential: true, createdBy: "ollie" }).returning();

    answers.delegation = (c) => ({
      tasks: [...c.content.matchAll(/\[(t\d+)\] (.*)/g)].map((m) => ({
        task: m[1],
        reasoning: "Delivery work",
        delegate: true,
        person: `p${sam.id}`,
        why: "Runs delivery",
        message: "Hi Sam — could you send the Ely timetable to the schools by Friday?",
      })),
    });
    const r = await suggestDelegations();
    expect(r).toMatchObject({ looked: 2, suggested: 1 });
    expect(calls[0].content).toContain("Sam Lee, Head of Delivery");
    expect(calls[0].content).not.toContain("Kim Secret");
    expect(calls[0].content).not.toContain("Board pack");

    const view = (await api(`tasks/${plan.id}`)).body.task;
    expect(view.delegateHint).toMatchObject({ personId: sam.id, personName: "Sam Lee", message: "Hi Sam, could you send the Ely timetable to the schools by Friday?" });
    expect((await api(`tasks/${fromSam.id}`)).body.task.delegateHint).toBeNull();
    expect((await db.select().from(tasksTable).where(eq(tasksTable.id, hiddenTask.id)))[0].delegateCheckedAt).toBeNull();

    // Not this one: gone from the task, and never suggested again.
    expect((await api(`tasks/${plan.id}/delegate-hint/dismiss`, { method: "POST" })).status).toBe(200);
    expect((await api(`tasks/${plan.id}`)).body.task.delegateHint).toBeNull();
    const m = (await scorecards()).find((x) => x.key === "delegation")!;
    expect(m).toMatchObject({ kept: 0, undone: 1 });
    calls.length = 0;
    await db.update(tasksTable).set({ delegateCheckedAt: null }).where(eq(tasksTable.id, plan.id));
    await suggestDelegations();
    expect(calls.every((c) => !c.content.includes("Ely rollout timetable"))).toBe(true);
  });

  it("does nothing when there is no colleague to suggest", async () => {
    reset();
    await db.insert(tasksTable).values({ title: "Something", status: "now", createdBy: "ollie" });
    expect(await suggestDelegations()).toMatchObject({ looked: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("Friday update", () => {
  it("works out the Friday the week ends on", () => {
    expect(weekEndingFor(new Date("2026-11-11T12:00:00Z"))).toBe("2026-11-13"); // Wednesday
    expect(weekEndingFor(new Date("2026-11-13T12:00:00Z"))).toBe("2026-11-13"); // Friday
    expect(weekEndingFor(new Date("2026-11-14T12:00:00Z"))).toBe("2026-11-13"); // Saturday
    expect(weekEndingFor(new Date("2026-11-15T12:00:00Z"))).toBe("2026-11-13"); // Sunday
  });

  it("tidies bullets and renders the skill's template with no em dashes", () => {
    const s = cleanSections({ wins: ["• Closed Acme — £40k", "  "], blockers: [], ai: ["Drafted 6 replies"], quarterly: ["Growth: on track"] });
    expect(s).toEqual({ wins: ["Closed Acme, £40k"], blockers: ["None this week"], ai: ["Drafted 6 replies"], quarterly: ["Growth: on track"] });
    const text = renderUpdate("2026-11-13", s);
    expect(text.split("\n")[0]).toBe("📆 Weekly Update, W/E 13 November");
    expect(text).toContain("🏆 Wins\n• Closed Acme, £40k");
    expect(text).toContain("🚧 Blockers\n• None this week");
    expect(text).not.toContain("—");
  });

  it("drafts from the week AI may see, redrafts one section only, and keeps Ollie's edits", async () => {
    reset();
    const acme = await project("Acme renewal");
    const now = new Date();
    await db.insert(tasksTable).values([
      { title: "Send Acme the renewal contract", status: "done", completedAt: now, projectId: acme.id, priority: "high", createdBy: "ollie" },
      { title: "Brief the board on the buyer", status: "done", completedAt: now, confidential: true, createdBy: "ollie" },
    ]);
    await db.insert(decisionsTable).values({ text: "Renew Acme for three years", decidedAt: now.toISOString().slice(0, 10), projectId: acme.id, createdBy: "ollie" });
    let round = 0;
    answers.weekly_update = () => {
      round++;
      return { wins: [`Acme renewal contract sent (${round})`], blockers: ["Waiting on legal"], ai: ["OllieOS sorted the inbox"], quarterly: ["Growth: renewal on track"] };
    };

    const drafted = await api("weekly-update/draft", { method: "POST" });
    expect(drafted.status).toBe(200);
    expect(drafted.body.basis).toMatchObject({ done: 1, decisions: 1, hidden: 1 });
    expect(drafted.body.text).toContain("• Acme renewal contract sent (1)");
    expect(calls[0].content).toContain("Send Acme the renewal contract");
    expect(calls[0].content).toContain("Renew Acme for three years");
    expect(calls[0].content).not.toContain("buyer");

    // Redraft Blockers: only Blockers may change, whatever comes back.
    const re = await api("weekly-update/redraft", { method: "POST", body: { section: "blockers" } });
    expect(re.body.sections.wins).toEqual(["Acme renewal contract sent (1)"]);
    expect(calls[1].system).toContain('Only "blockers" is being redrafted');

    const saved = await api("weekly-update", { method: "PATCH", body: { weekEnding: re.body.weekEnding, editedText: "My own version" } });
    expect(saved.body.editedText).toBe("My own version");
    expect((await api("weekly-update")).body.update.editedText).toBe("My own version");
    expect(await db.select().from(weeklyUpdatesTable)).toHaveLength(1);
  });
});

describe("Idea spotter", () => {
  it("adds ideas from a meeting once, marked as spotted, and never from a meeting with someone hidden from AI", async () => {
    reset();
    await person("Hidden Person", { confidential: true });
    await db.update(peopleTable).set({ email: "hidden@x.com" }).where(eq(peopleTable.name, "Hidden Person"));
    answers.granola_reader = () => ({
      summary: "Talked about cohorts",
      project: "",
      items: [],
      decisions: [],
      progress: [],
      covered: [],
      tone: "neutral",
      tone_reason: "",
      ideas: [{ ref: "granola:n1", title: "Offer a summer cohort for Year 12s", notes: "Sam floated it — demand is there.", project: "", confidential: false }],
    });
    const note = (id: string, email: string) => ({ noteId: id, title: "Planning", url: `https://notes.granola.ai/d/${id}`, at: new Date(), calendarEventId: null, ownedByMe: true, people: [{ name: null, email }], notes: "We could offer a summer cohort." });
    const counts = await captureMeetings([note("n1", "sam@springpod.com")], { me: "", now: new Date() });
    expect(counts.ideas).toBe(1);
    const [idea] = await db.select().from(ideasTable);
    expect(idea).toMatchObject({ title: "Offer a summer cohort for Year 12s", notes: "Sam floated it, demand is there.", source: "ollieos", sourceRef: "granola:n1#idea:1", sourceLabel: "Granola: Planning", status: "new" });

    // The same meeting read again, or another saying the same, adds nothing.
    await captureMeetings([note("n1", "sam@springpod.com"), note("n2", "sam@springpod.com")], { me: "", now: new Date() });
    expect(await db.select().from(ideasTable)).toHaveLength(1);

    // A meeting with someone hidden from AI adds no ideas.
    answers.granola_reader = () => ({ summary: "", project: "", items: [], decisions: [], progress: [], covered: [], tone: "neutral", tone_reason: "", ideas: [{ ref: "granola:n3", title: "Sell the data to a buyer", notes: "", project: "", confidential: false }] });
    await captureMeetings([note("n3", "hidden@x.com")], { me: "", now: new Date() });
    expect((await db.select().from(ideasTable)).map((i) => i.title)).toEqual(["Offer a summer cohort for Year 12s"]);

    const listed = await api("ideas?status=new");
    expect(listed.body.ideas[0]).toMatchObject({ source: "ollieos", sourceLabel: "Granola: Planning", sourceUrl: "https://notes.granola.ai/d/n1" });
  });

  it("adds ideas from Slack, and none from email", async () => {
    reset();
    const at = new Date();
    const slack: WorkUnit = {
      source: "slack",
      key: "slack:D1:1",
      subject: null,
      channel: "Sam Lee",
      people: [{ name: "Sam Lee", email: null, slackId: "USAM" }],
      messages: [{ ref: "slack:D1:1731234567.000100", at, fromMe: false, fromName: "Sam Lee", fromAddress: null, fromSlackId: "USAM", text: "What if we ran a careers podcast?", url: "https://x.slack.com/archives/D1/p1731234567000100" }],
      conversation: { id: "D1", kind: "im" },
    };
    const email: WorkUnit = { ...slack, source: "email", key: "gmail:e1", channel: null, subject: "Idea", messages: [{ ...slack.messages[0], ref: "gmail:e1", url: "https://mail.google.com/mail/#all/e1" }] };
    const blank = { summary: "", project: "", items: [], knowledge: [], reply_needed: "none", reply_ask: "", progress: [], signature_title: "", signature_company: "", signature_phone: "" };
    const podcast = { ref: "slack:D1:1731234567.000100", title: "Run a careers podcast", notes: "Sam suggested it.", project: "", confidential: false };
    answers.slack_sorter = () => ({ results: [{ unit: "u1", ...blank, ideas: [podcast] }] });
    answers.gmail_sorter = () => ({ results: [{ unit: "u1", ...blank, ideas: [{ ...podcast, ref: "gmail:e1", title: "An email idea" }] }] });

    const s = await sortAndCapture([slack], { me: "", now: at, agent: "slack_sorter" });
    expect(s.ideas).toBe(1);
    expect(calls[0].system).toContain("Ideas (the idea spotter)");
    await sortAndCapture([email], { me: "", now: at, agent: "gmail_sorter" });
    const rows = await db.select().from(ideasTable);
    expect(rows.map((r) => [r.title, r.sourceLabel])).toEqual([["Run a careers podcast", "Slack message from Sam Lee in Sam Lee"]]);
  });
});
