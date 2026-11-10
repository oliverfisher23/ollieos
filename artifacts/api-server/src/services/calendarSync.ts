/**
 * The calendar feed from the sweep (ingest) and from Claude (upsert_calendar), turned into rows.
 * Names are resolved as the calling client sees them; unmatched names are reported, never a
 * reason to drop the event (build plan 30).
 */
import { z } from "zod";
import { resolvePick } from "../lib/ai-data/context";
import type { AiScope } from "../lib/ai-data/scope";
import { normaliseAttendees, platformFor, replaceCalendar, type AttendeeInput, type CalendarInput, type Writer } from "./aiWrites";
import { refusesClaudeFeed } from "./connectors";

/** Said to Claude when it sends a calendar OllieOS now reads itself. */
export const CALENDAR_READ_DIRECT =
  "OllieOS reads Google Calendar itself now, so this calendar was not used and nothing changed. You can stop sending the calendar.";

export const AttendeeSchema = z.union([
  z.string().max(320),
  z.object({
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    response: z.string().max(40).optional().describe("accepted, tentative, declined or none"),
    organiser: z.boolean().optional(),
  }),
]);

export interface FeedEvent {
  source_ref: string;
  title: string;
  starts_at: string;
  ends_at: string;
  attendees?: AttendeeInput[];
  personal?: boolean;
  people?: string[];
  project?: string | null;
  location?: string | null;
  platform?: string | null;
}

export async function syncCalendarFeed(scope: AiScope, writer: Writer, feed: FeedEvent[]) {
  if (await refusesClaudeFeed("calendar")) return { replaced: 0, removed: 0, outsideWindow: 0, unmatched: [] as string[], ignored: CALENDAR_READ_DIRECT };
  const unmatched = new Set<string>();
  const events: CalendarInput[] = [];
  for (const e of feed) {
    const personIds: number[] = [];
    for (const n of e.people ?? []) {
      const hit = await resolvePick(scope, n, ["person"]);
      if (hit) {
        if (!personIds.includes(hit.id)) personIds.push(hit.id);
      } else unmatched.add(n);
    }
    const project = e.project ? await resolvePick(scope, e.project, ["project"]) : null;
    if (e.project && !project) unmatched.add(e.project);
    const { names, details } = normaliseAttendees(e.attendees);
    const location = e.location?.trim() || null;
    events.push({
      sourceRef: e.source_ref,
      title: e.title,
      startsAt: new Date(e.starts_at),
      endsAt: new Date(e.ends_at),
      attendees: names,
      attendeeDetails: details,
      platform: platformFor(e.platform, location),
      personal: e.personal ?? false,
      personIds,
      projectId: project?.id ?? null,
      location,
    });
  }
  const r = await replaceCalendar(writer, events);
  return { ...r, unmatched: [...unmatched], ignored: null };
}
