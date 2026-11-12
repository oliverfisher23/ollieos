/**
 * Closing the loop: a meeting's Granola note compared with its agenda, and what was not covered
 * offered on the next agenda for the same meeting.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, peopleTable } from "@workspace/db";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { attachMeetingNotes } from "../src/services/briefs";
import { api, useServer } from "./harness";
import { fact, person } from "./helpers";

const judged = vi.hoisted(() => [] as { title: string; agenda: string; notes: string }[]);
const written = vi.hoisted(() => [] as { suggested?: string[]; leftOver?: string[] }[]);

// Items whose title appears in the notes are covered; "Budget" only partly.
vi.mock("../src/services/agendaJudge", () => ({
  judgeAgenda: async (input: { title: string; agenda: string; notes: string }) => {
    judged.push(input);
    return [...input.agenda.matchAll(/^\d+\.\s+\**([^*(\n]+?)\**\s*(?:\(|$)/gm)].map((m) => {
      const title = m[1].trim();
      const said = input.notes.toLowerCase().includes(title.toLowerCase());
      return { title, status: title === "Budget" && said ? "partly" : said ? "covered" : "not_covered", note: said ? `Talked about ${title}.` : "" };
    });
  },
}));
vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  writeBriefFromDocs: async (_m: unknown, docs: AiDoc[]) => {
    const cited = docs.filter((d) => d.ref.startsWith("fact:"));
    return { why: cited.map((d) => ({ text: `Because of ${d.ref}.`, refs: [d.ref] })), agenda: [{ text: "Agree the January intake", refs: cited.slice(0, 1).map((d) => d.ref) }], questions: [], questionsNote: "" };
  },
  writeAgendaFromThoughts: async (opts: { suggested?: string[]; leftOver?: string[] }) => {
    written.push(opts);
    return { reply: "Done.", agenda: "1. **Something**" };
  },
}));

useServer();

const AGENDA = "1. **Hiring plan** (15 min)\n   - Two roles\n2. **Budget** (10 min)\n3. **Board prep** (15 min)\n\n- [ ] Send the pack";
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

async function meeting(ref: string, daysAgo: number, o: Partial<typeof calendarEventsTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(calendarEventsTable)
    .values({ sourceRef: ref, title: "Exec huddle", startsAt: at(daysAgo), endsAt: new Date(at(daysAgo).getTime() + 45 * 60_000), ...o })
    .returning();
  return row;
}

describe("Agenda check", () => {
  it("marks each agenda item from the Granola note, notices when either changes, and keeps what Ollie dropped", async () => {
    judged.length = 0;
    const ev = await meeting("c1", 1, { notes: AGENDA, granolaRef: "not_1", granolaNotes: "We agreed the hiring plan. Budget came up but was left open." });

    const r = await api(`meetings/${ev.id}/agenda/check`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.agendaCheck.stale).toBe(false);
    expect(r.body.agendaCheck.items.map((i: { title: string; status: string }) => [i.title, i.status])).toEqual([
      ["Hiring plan", "covered"],
      ["Budget", "partly"],
      ["Board prep", "not_covered"],
    ]);
    expect(judged[0].title).toBe("Exec huddle");

    expect((await api(`meetings/${ev.id}/agenda/check/items/2`, { method: "PUT", body: { dropped: true } })).status).toBe(204);
    expect((await api(`meetings/${ev.id}`)).body.agendaCheck.items[2].dropped).toBe(true);

    // Editing the agenda makes the check out of date; checking again keeps the dropped item dropped.
    await api(`meetings/${ev.id}`, { method: "PATCH", body: { notes: AGENDA + "\n- [ ] Another action" } });
    expect((await api(`meetings/${ev.id}`)).body.agendaCheck.stale).toBe(true);
    const again = await api(`meetings/${ev.id}/agenda/check`, { method: "POST" });
    expect(again.body.agendaCheck).toMatchObject({ stale: false });
    expect(again.body.agendaCheck.items[2]).toMatchObject({ title: "Board prep", dropped: true });
    expect((await api(`meetings/${ev.id}/agenda/check/items/9`, { method: "PUT", body: { dropped: true } })).status).toBe(404);
  });

  it("runs when the Granola note is attached, and refuses when there is nothing to compare or a hidden name", async () => {
    judged.length = 0;
    const ev = await meeting("c2", 1, { notes: AGENDA });
    expect((await api(`meetings/${ev.id}/agenda/check`, { method: "POST" })).status).toBe(409);
    await attachMeetingNotes(ev, { granolaRef: "not_2", notes: "Board prep was the whole meeting.", actionTaskIds: [], actor: "ollieos", clientId: null });
    const v = (await api(`meetings/${ev.id}`)).body;
    expect(v.agendaCheck.items.map((i: { status: string }) => i.status)).toEqual(["not_covered", "not_covered", "covered"]);

    const none = await meeting("c3", 1, { title: "No agenda", granolaRef: "not_3", granolaNotes: "Notes" });
    expect((await api(`meetings/${none.id}/agenda/check`, { method: "POST" })).status).toBe(409);
    expect((await api(`meetings/${none.id}`)).body.agendaCheck).toBeNull();

    await person("Priya Secret", { aiAccess: false });
    const hidden = await meeting("c4", 1, { title: "Private", notes: "1. **Priya Secret's pay**", granolaRef: "not_4", granolaNotes: "Notes" });
    const before = judged.length;
    const r = await api(`meetings/${hidden.id}/agenda/check`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/hidden from AI/);
    expect(judged).toHaveLength(before);
  });
});

describe("Carrying forward", () => {
  const check = (items: { title: string; status: "covered" | "partly" | "not_covered"; note?: string; dropped?: boolean }[]) => ({
    granolaRef: "not_x",
    agendaHash: "x",
    at: new Date().toISOString(),
    items: items.map((i) => ({ note: "", ...i })),
  });

  it("offers what was not covered at the last meeting in the series, and hands it to the agenda writer with the brief's suggestions", async () => {
    written.length = 0;
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ email: "sam@example.test" }).where(eq(peopleTable.id, sam.id));
    await fact("person", sam.id, "Sam is hiring two graduates in January");
    const who = { attendees: ["Sam Lee"], attendeeDetails: [{ name: "Sam Lee", email: "sam@example.test" }] };
    const last = await meeting("s1", 7, {
      recurringEventId: "series",
      ...who,
      agendaCheck: check([
        { title: "Hiring plan", status: "covered" },
        { title: "Budget", status: "partly", note: "Left open." },
        { title: "Board prep", status: "not_covered" },
        { title: "Office move", status: "not_covered", dropped: true },
      ]),
    });
    // An older one in the series is ignored: only the most recent checked meeting counts.
    await meeting("s0", 14, { recurringEventId: "series", ...who, agendaCheck: check([{ title: "Ancient item", status: "not_covered" }]) });
    const next = await meeting("s2", -1, { recurringEventId: "series", ...who });

    const v = (await api(`meetings/${next.id}`)).body;
    expect(v.leftovers).toMatchObject({ eventId: last.id, title: "Exec huddle" });
    expect(v.leftovers.items).toEqual([
      { index: 1, title: "Budget", status: "partly", note: "Left open." },
      { index: 2, title: "Board prep", status: "not_covered", note: "" },
    ]);

    await api(`briefs/${next.id}`);
    await api(`meetings/${next.id}/agenda`, { method: "POST", body: { message: "plan the week", agenda: "" } });
    expect(written[0].leftOver).toEqual(["Budget", "Board prep"]);
    expect(written[0].suggested).toEqual(["Agree the January intake"]);

    // Dropping one from the earlier meeting takes it off the offer.
    await api(`meetings/${last.id}/agenda/check/items/2`, { method: "PUT", body: { dropped: true } });
    expect((await api(`meetings/${next.id}`)).body.leftovers.items.map((i: { title: string }) => i.title)).toEqual(["Budget"]);
  });

  it("matches a one-off by title only when someone is in common", async () => {
    const pat = { attendees: ["Pat"], attendeeDetails: [{ name: "Pat", email: "pat@gmail.com" }] };
    await meeting("o1", 7, { title: "Catch-up", ...pat, agendaCheck: check([{ title: "Pricing", status: "not_covered" }]) });
    const same = await meeting("o2", -1, { title: "catch-up", ...pat });
    const other = await meeting("o3", -1, { title: "Catch-up", attendees: ["Lee"], attendeeDetails: [{ name: "Lee", email: "lee@gmail.com" }] });
    expect((await api(`meetings/${same.id}`)).body.leftovers.items.map((i: { title: string }) => i.title)).toEqual(["Pricing"]);
    expect((await api(`meetings/${other.id}`)).body.leftovers).toBeNull();
  });
});
