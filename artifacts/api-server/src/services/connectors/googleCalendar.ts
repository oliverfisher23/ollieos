/**
 * Reads Ollie's primary Google Calendar through the Replit connector, for today and the next
 * seven days (London time), and turns each event into a calendar row. No AI is involved.
 */
import { ReplitConnectors } from "@replit/connectors-sdk";
import { londonRange, todayLondon } from "@workspace/shared";
import { normaliseAttendees, platformFor, type CalendarInput } from "../aiWrites";

const CONNECTOR = "google-calendar";

/** The parts of a Google Calendar event this reader uses. */
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  eventType?: string;
  visibility?: string;
  location?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  conferenceData?: { conferenceSolution?: { name?: string } };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
    resource?: boolean;
  }[];
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    /** True when reconnecting the service in Replit is the likely fix. */
    readonly needsReconnect = false,
  ) {
    super(message);
  }
}

/** Working location, out of office, focus time and birthdays are not meetings. */
const SKIP_TYPES = new Set(["workingLocation", "outOfOffice", "focusTime", "birthday"]);

export interface MapResult {
  event: CalendarInput | null;
  /** Why the event was left out, when it was. */
  skipped?: "cancelled" | "all_day" | "not_a_meeting" | "declined";
}

/** Google's conference names, shortened to the platform labels the calendar strip uses. */
function platformFrom(e: GoogleEvent): string | null {
  const name = e.conferenceData?.conferenceSolution?.name?.toLowerCase() ?? "";
  if (e.hangoutLink || name.includes("google meet")) return "Meet";
  if (name.includes("teams")) return "Teams";
  if (name.includes("zoom")) return "Zoom";
  return null;
}

export function mapGoogleEvent(e: GoogleEvent): MapResult {
  if (e.status === "cancelled") return { event: null, skipped: "cancelled" };
  if (e.eventType && SKIP_TYPES.has(e.eventType)) return { event: null, skipped: "not_a_meeting" };
  if (!e.start?.dateTime || !e.end?.dateTime) return { event: null, skipped: "all_day" };
  const me = e.attendees?.find((a) => a.self);
  if (me?.responseStatus === "declined") return { event: null, skipped: "declined" };

  const others = (e.attendees ?? []).filter((a) => !a.self && !a.resource);
  const { names, details } = normaliseAttendees(
    others.map((a) => ({ name: a.displayName ?? null, email: a.email ?? null, response: a.responseStatus ?? null, organiser: a.organizer ?? null })),
  );
  const location = e.location?.trim() || null;
  return {
    event: {
      sourceRef: e.id,
      title: e.summary?.trim() || "(No title)",
      startsAt: new Date(e.start.dateTime),
      endsAt: new Date(e.end.dateTime),
      attendees: names,
      attendeeDetails: details,
      platform: platformFor(platformFrom(e), location),
      personal: e.visibility === "private",
      personIds: [],
      projectId: null,
      location,
    },
  };
}

export interface CalendarRead {
  account: string | null;
  events: CalendarInput[];
  /** How many events Google returned in the window, before any were left out. */
  found: number;
  skipped: number;
}

async function getJson(client: ReplitConnectors, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await client.proxy(CONNECTOR, path, { method: "GET" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no .*connection/i.test(msg)) throw new ConnectorError("Google Calendar is not connected to OllieOS.", true);
    throw new ConnectorError("Could not reach Google Calendar: " + msg);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorError("Google Calendar refused access. Reconnect it in Replit.", true);
  }
  if (!res.ok) {
    const err = body.error as { message?: string } | undefined;
    throw new ConnectorError(`Google Calendar answered ${res.status}${err?.message ? ": " + err.message : ""}`);
  }
  return body;
}

export async function readGoogleCalendar(now = new Date()): Promise<CalendarRead> {
  const client = new ReplitConnectors();
  const today = todayLondon(now);
  const window = londonRange(today, 8);
  const cal = await getJson(client, "/calendar/v3/calendars/primary?fields=id");
  const account = typeof cal.id === "string" ? cal.id : null;

  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      timeMin: window.start.toISOString(),
      timeMax: window.end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      fields:
        "nextPageToken,items(id,status,summary,eventType,visibility,location,hangoutLink,start,end,conferenceData/conferenceSolution/name,attendees(email,displayName,responseStatus,organizer,self,resource))",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const body = await getJson(client, "/calendar/v3/calendars/primary/events?" + q.toString());
    items.push(...((body.items as GoogleEvent[] | undefined) ?? []));
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }

  const events: CalendarInput[] = [];
  let skipped = 0;
  for (const it of items) {
    const m = mapGoogleEvent(it);
    if (m.event) events.push(m.event);
    else skipped++;
  }
  return { account, events, found: items.length, skipped };
}
