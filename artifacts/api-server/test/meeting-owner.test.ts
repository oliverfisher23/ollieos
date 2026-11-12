/** Meeting actions that belong to someone else in the room do not become Ollie's tasks. */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tasksTable } from "@workspace/db";
import { captureMeetings } from "../src/services/connectors/meetingCapture";
import { ownedBySomeoneElse, type MeetingNote } from "../src/services/connectors/granola";
import { OLLIE, useServer } from "./harness";

let system = "";
const item = (title: string, type: string, owner?: string) => ({
  ref: "granola:m1", type, title, action: "", priority: "medium", due: "", project: "", person: "", quote: "", confidential: false, ...(owner === undefined ? {} : { owner }),
});

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (s: string) => {
    system = s;
    return {
      summary: "Scoped the Studio data work",
      project: "",
      items: [
        item("Tidy up and reshare the data mapping diagram", "task", "Oliver"),
        item("Map new survey codes to existing questions", "task", "Konrad"),
        item("Konrad to confirm the mandatory survey fields", "promise", "Konrad Sordyl"),
        item("Check the API request with Sam", "task", "Oliver and Kurt"),
        item("Book the room", "task", ""),
        item("Kurt to send Ollie the heartbeat list", "waiting", "Kurt"),
      ],
      decisions: [],
      progress: [],
      covered: [],
      tone: "neutral",
      tone_reason: "",
    };
  },
}));

useServer();

const note = (): MeetingNote => ({
  noteId: "m1",
  title: "Studio Signals Data - Scoping",
  url: "https://notes.granola.ai/d/m1",
  at: new Date(),
  calendarEventId: null,
  ownedByMe: true,
  people: [{ name: "Konrad Sordyl", email: "konrad@example.com" }],
  notes: "Next steps\n- Tidy up the diagram (Oliver)\n- Map survey codes (Konrad)",
});

describe("Whose meeting action it is", () => {
  it("knows Ollie's names, and treats shared or unclear owners as his", () => {
    for (const o of ["Oliver", "ollie", "Oliver Fisher", "You", "", "Oliver and Kurt", "Sam, Ollie", "(Oliver)"]) expect(ownedBySomeoneElse(o)).toBe(false);
    for (const o of ["Konrad", "Konrad Sordyl", "Kurt and Sam", "Volodymyr"]) expect(ownedBySomeoneElse(o)).toBe(true);
  });

  it("leaves out tasks and promises the notes give to someone else, but keeps waiting items", async () => {
    await captureMeetings([note()], { me: "His email address is " + OLLIE, now: new Date(), myEmails: new Set([OLLIE]) });
    expect(system).toContain(`"owner" is who will do the action`);
    const titles = (await db.select().from(tasksTable).where(eq(tasksTable.source, "meeting"))).map((t) => t.title).sort();
    expect(titles).toEqual([
      "Book the room",
      "Check the API request with Sam",
      "Kurt to send Ollie the heartbeat list",
      "Tidy up and reshare the data mapping diagram",
    ]);
  });
});
