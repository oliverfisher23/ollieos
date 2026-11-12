/**
 * Meeting agendas: Ollie's thoughts shaped into an agenda he can edit.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, peopleTable, talkingPointsTable } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import { api, useServer } from "./harness";
import { fact, person } from "./helpers";

const calls = vi.hoisted(() => [] as { agenda: string; message: string; history: { role: string; text: string }[]; points: string[]; docs: { ref: string }[]; meeting: { attendees: string[]; minutes: number } }[]);
const fail = vi.hoisted(() => ({ on: false }));

vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  writeAgendaFromThoughts: async (opts: (typeof calls)[number]) => {
    calls.push(opts);
    if (fail.on) throw new Error("model down");
    const md = "1. **Hiring plan** (15 min)\n   - Two roles\n   - Who signs off\n2. **Budget** (10 min)";
    return { reply: "Put hiring first.", agenda: opts.agenda.trim() ? `${opts.agenda.trim()}\n\n${md}` : md };
  },
}));

useServer();

const today = todayLondon();
const at = (days: number, h: number) => londonWallTimeToInstant(addDays(today, days), h, 0);

async function event(ref: string, attendees: { name: string; email?: string }[], opts: { personal?: boolean; title?: string } = {}) {
  const starts = at(1, 10);
  const [row] = await db
    .insert(calendarEventsTable)
    .values({
      sourceRef: ref,
      title: opts.title ?? "Catch-up",
      startsAt: starts,
      endsAt: new Date(starts.getTime() + 45 * 60_000),
      attendees: attendees.map((a) => a.name),
      attendeeDetails: attendees,
      personal: opts.personal ?? false,
    })
    .returning();
  return row;
}

describe("Shaping an agenda", () => {
  it("turns thoughts into a numbered, timed agenda, keeps the conversation, and starts from the edited agenda next time", async () => {
    calls.length = 0;
    fail.on = false;
    const ev = await event("a1", [{ name: "Guest Person", email: "guest@gmail.com" }]);

    const r = await api(`meetings/${ev.id}/agenda`, { method: "POST", body: { message: "hiring, then budget", agenda: "" } });
    expect(r.status).toBe(200);
    expect(r.body.agenda).toBe("1. **Hiring plan** (15 min)\n   - Two roles\n   - Who signs off\n2. **Budget** (10 min)");
    expect(r.body.previous).toBe("");
    expect(r.body.chat.map((t: { role: string; text: string }) => [t.role, t.text])).toEqual([
      ["ollie", "hiring, then budget"],
      ["ai", "Put hiring first."],
    ]);
    expect(calls[0].meeting).toMatchObject({ attendees: ["Guest Person"], minutes: 45 });

    const v = (await api(`meetings/${ev.id}`)).body;
    expect(v.notes).toBe(r.body.agenda);
    expect(v.agendaChat).toHaveLength(2);

    // Ollie edits by hand, then asks for more: the writer gets his edited version and the conversation.
    const edited = r.body.agenda + "\n\n- [ ] My own action";
    const r2 = await api(`meetings/${ev.id}/agenda`, { method: "POST", body: { message: "add a wrap-up", agenda: edited } });
    expect(calls[1].agenda).toBe(edited);
    expect(calls[1].history.map((t) => t.text)).toEqual(["hiring, then budget", "Put hiring first."]);
    expect(r2.body.previous).toBe(edited);
    expect(r2.body.chat).toHaveLength(4);

    // Start again forgets the conversation and keeps the agenda.
    expect((await api(`meetings/${ev.id}/agenda/chat`, { method: "DELETE" })).status).toBe(204);
    const after = (await api(`meetings/${ev.id}`)).body;
    expect(after.agendaChat).toEqual([]);
    expect(after.notes).toBe(r2.body.agenda);
  });

  it("hands the writer what AI may see about the people on it, and their open talking points", async () => {
    calls.length = 0;
    fail.on = false;
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ email: "sam@example.test" }).where(eq(peopleTable.id, sam.id));
    const f = await fact("person", sam.id, "Sam is hiring two graduates in January");
    await db.insert(talkingPointsTable).values({ personId: sam.id, text: "Ask about the January intake", createdBy: "ollie" });
    const ev = await event("a2", [{ name: "Sam Lee", email: "sam@example.test" }]);

    await api(`meetings/${ev.id}/agenda`, { method: "POST", body: { message: "catch up with Sam", agenda: "" } });
    expect(calls[0].meeting.attendees).toEqual(["Sam Lee"]);
    expect(calls[0].points).toEqual(["Sam Lee: Ask about the January intake"]);
    expect(calls[0].docs.map((d) => d.ref)).toContain(`fact:${f.id}`);
  });

  it("sends nothing when the thoughts name someone hidden from AI, and leaves the agenda alone when the model fails", async () => {
    calls.length = 0;
    fail.on = false;
    await person("Priya Secret", { aiAccess: false });
    const ev = await event("a3", []);
    const r = await api(`meetings/${ev.id}/agenda`, { method: "POST", body: { message: "talk about Priya Secret's pay", agenda: "" } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/hidden from AI/);
    expect(calls).toHaveLength(0);

    await api(`meetings/${ev.id}`, { method: "PATCH", body: { notes: "My agenda" } });
    fail.on = true;
    const r2 = await api(`meetings/${ev.id}/agenda`, { method: "POST", body: { message: "tidy it up", agenda: "My agenda" } });
    expect(r2.status).toBe(502);
    expect((await api(`meetings/${ev.id}`)).body).toMatchObject({ notes: "My agenda", agendaChat: [] });
    fail.on = false;
  });

  it("refuses empty thoughts and personal events", async () => {
    const ev = await event("a4", []);
    expect((await api(`meetings/${ev.id}/agenda`, { method: "POST", body: { message: "", agenda: "" } })).status).toBe(400);
    const personal = await event("a5", [], { personal: true });
    expect((await api(`meetings/${personal.id}/agenda`, { method: "POST", body: { message: "x", agenda: "" } })).status).toBe(404);
  });
});
