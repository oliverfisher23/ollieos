import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, peopleTable, tasksTable } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon, weekday } from "@workspace/shared";
import { nudgeTick, sendTestNudge, setNudgeSettings, type Send } from "../src/services/nudges";
import { api, useServer } from "./harness";
import { person, task } from "./helpers";

// Ollie's Slack id comes from the Slack connection; the test stands it in.
vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  slackMe: async () => "U0OLLIE",
}));

useServer();

/** The next weekday, today included: nudges never go at weekends. */
const day = (() => {
  let d = todayLondon();
  while (weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
  return d;
})();
const at = (time: string, onDay = day) => {
  const [h, m] = time.split(":").map(Number);
  return new Date(londonWallTimeToInstant(onDay, h, m));
};

function outbox() {
  const sent: { to: string; text: string }[] = [];
  const send: Send = async (to, text) => {
    sent.push({ to, text });
  };
  return { sent, send };
}

const ALL_ON = { morning: true, meeting: true, evening: true };

async function meeting(ref: string, starts: Date, opts: { title?: string; attendees?: { name: string; email?: string }[]; personal?: boolean } = {}) {
  const [row] = await db
    .insert(calendarEventsTable)
    .values({
      sourceRef: ref,
      title: opts.title ?? "Catch-up " + ref,
      startsAt: starts,
      endsAt: new Date(starts.getTime() + 30 * 60_000),
      attendees: (opts.attendees ?? []).map((a) => a.name),
      attendeeDetails: opts.attendees ?? [],
      personal: opts.personal ?? false,
    })
    .returning();
  return row;
}

async function sam() {
  const p = await person("Sam Lee");
  await db.update(peopleTable).set({ email: "sam@example.test" }).where(eq(peopleTable.id, p.id));
  return { name: "Sam Lee", email: "sam@example.test" };
}

describe("Nudges on Slack", () => {
  it("sends nothing until a nudge is turned on, and nothing at a weekend", async () => {
    await db.update(tasksTable).set({ dueDate: day }).where(eq(tasksTable.id, (await task("Send the report")).id));
    const { sent, send } = outbox();
    expect((await nudgeTick(at("08:00"), send)).sent).toEqual([]);

    await setNudgeSettings(ALL_ON);
    let saturday = day;
    while (weekday(saturday) !== 6) saturday = addDays(saturday, 1);
    expect((await nudgeTick(at("08:00", saturday), send)).sent).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sends the morning message once, after the digest time, to Ollie only, without naming hidden tasks", async () => {
    const due = await task("Send the costs to the client");
    const secret = await task("Board salary review", { confidential: true });
    await db.update(tasksTable).set({ dueDate: day }).where(eq(tasksTable.id, due.id));
    await db.update(tasksTable).set({ dueDate: day }).where(eq(tasksTable.id, secret.id));
    await setNudgeSettings(ALL_ON, "https://ollieos.example");
    const { sent, send } = outbox();

    // Before 07:40 nothing goes.
    expect((await nudgeTick(at("07:00"), send)).sent).toEqual([]);
    expect((await nudgeTick(at("07:45"), send)).sent).toEqual(["morning"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("U0OLLIE");
    expect(sent[0].text).toContain("2 tasks for today");
    expect(sent[0].text).toContain("• Send the costs to the client");
    expect(sent[0].text).not.toContain("Board salary review");
    expect(sent[0].text).toContain("• and 1 more");
    expect(sent[0].text).toContain("<https://ollieos.example/|use this plan>");

    // The next ticks that morning do not send it again.
    expect((await nudgeTick(at("07:46"), send)).sent).toEqual([]);
    expect((await nudgeTick(at("09:00"), send)).sent).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("says nothing on a morning with nothing to say, and not after 11:00", async () => {
    await setNudgeSettings({ morning: true });
    const { sent, send } = outbox();
    expect((await nudgeTick(at("08:00"), send)).sent).toEqual([]);

    // A task that turns up later the same morning does not bring the message back.
    await db.update(tasksTable).set({ dueDate: day }).where(eq(tasksTable.id, (await task("Late arrival")).id));
    expect((await nudgeTick(at("08:05"), send)).sent).toEqual([]);

    // The day after, a server that only wakes at noon stays quiet.
    let next = addDays(day, 1);
    while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
    expect((await nudgeTick(at("12:00", next), send)).sent).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sends one message before a work meeting with a prep page, and none for personal or unknown ones", async () => {
    const who = await sam();
    const work = await meeting("m1", at("10:00"), { title: "Pilot review", attendees: [who] });
    await meeting("m2", at("10:00"), { title: "Dentist", attendees: [who], personal: true });
    await meeting("m3", at("10:00"), { title: "Stranger call", attendees: [{ name: "Nobody Known", email: "x@gmail.com" }] });
    await setNudgeSettings({ meeting: true }, "https://ollieos.example");
    const { sent, send } = outbox();

    // 30 minutes ahead is too early; 15 minutes ahead is inside the window.
    expect((await nudgeTick(at("09:30"), send)).sent).toEqual([]);
    expect((await nudgeTick(at("09:45"), send)).sent).toEqual(["meeting"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("*Pilot review* starts at 10:00.");
    expect(sent[0].text).toContain(`<https://ollieos.example/briefs/${work.id}|Open the prep page>`);

    // Later ticks inside the window do not repeat it.
    expect((await nudgeTick(at("09:50"), send)).sent).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("sends the end-of-day message once working hours end, with counts only", async () => {
    const done = await task("Reply to finance");
    await db.update(tasksTable).set({ status: "done", completedAt: at("14:00") }).where(eq(tasksTable.id, done.id));
    await db.update(tasksTable).set({ dueDate: addDays(day, -1) }).where(eq(tasksTable.id, (await task("Overdue thing")).id));
    await setNudgeSettings({ evening: true });
    const { sent, send } = outbox();

    expect((await nudgeTick(at("17:30"), send)).sent).toEqual([]);
    expect((await nudgeTick(at("18:00"), send)).sent).toEqual(["evening"]);
    expect(sent[0].text).toContain("1 task done");
    expect(sent[0].text).toContain("1 task due today or overdue");
    expect(sent[0].text).not.toContain("Overdue thing");
    expect((await nudgeTick(at("18:05"), send)).sent).toEqual([]);
  });

  it("tries again on the next tick when Slack refuses", async () => {
    await db.update(tasksTable).set({ dueDate: day }).where(eq(tasksTable.id, (await task("Send the report")).id));
    await setNudgeSettings({ morning: true });
    let fail = true;
    const sent: string[] = [];
    const send: Send = async (_to, text) => {
      if (fail) throw new Error("slack is down");
      sent.push(text);
    };
    await expect(nudgeTick(at("08:00"), send)).rejects.toThrow("slack is down");
    fail = false;
    expect((await nudgeTick(at("08:01"), send)).sent).toEqual(["morning"]);
    expect(sent).toHaveLength(1);
  });

  it("keeps the settings, reports the app as not connected without a token, and sends a test", async () => {
    const before = (await api("settings/nudges")).body;
    expect(before).toEqual({ morning: false, meeting: false, evening: false, appConnected: false });
    const after = (await api("settings/nudges", { method: "PUT", body: { morning: true } })).body;
    expect(after).toMatchObject({ morning: true, meeting: false, evening: false });
    expect((await api("settings/nudges", { method: "PUT", body: { noon: true } })).status).toBe(400);
    // No token in the test environment: the test message is refused with the reason, not sent.
    const refused = await api("settings/nudges/test", { method: "POST" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("SLACK_BOT_TOKEN");

    const { sent, send } = outbox();
    await sendTestNudge("https://ollieos.example", send);
    expect(sent).toEqual([{ to: "U0OLLIE", text: expect.stringContaining("This is OllieOS") }]);
  });
});
