/**
 * Shaping a meeting's agenda from Ollie's thoughts. He types rough notes; the agenda writer turns
 * them into a timed agenda in the meeting's notes, which he can then edit by hand. Each message
 * starts from the agenda as it stands, so his edits carry forward.
 *
 * AI sees only what default AI scope may see about the people, organisations and projects on the
 * meeting. If Ollie's text, the agenda or the title names anything hidden from AI, nothing is sent.
 */
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, type AgendaTurn } from "@workspace/db";
import { formatLong, formatTime, toRef } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { askScope } from "./ask/ask";
import { writeAgendaFromThoughts, type AgendaItem } from "./ask/model";
import { contextRefs, loadMatchers, matchEvent } from "./briefs";
import { getContext } from "../lib/ai-data/context";
import { workEvent } from "./meetings";
import { openPointsFor } from "./talkingPoints";
import { ConflictError, UpstreamError, ValidationError } from "./tasks";
import { mentions, namedThings } from "./voice";
import { recordCheck } from "./writerChecks";

export const MAX_THOUGHTS = 4000;
const MAX_AGENDA = 20000;
/** Turns kept on the meeting, and turns handed to the writer */
const KEEP_TURNS = 40;
const HISTORY_TURNS = 12;
/** Attendees and projects read in full, as for a brief */
const MAX_CONTEXT = 6;

/** The agenda as text Ollie can edit: numbered items with minutes, and indented points. */
export function agendaText(items: AgendaItem[]): string {
  return items
    .map((it, i) => [`${i + 1}. ${it.title}${it.minutes > 0 ? ` (${it.minutes} min)` : ""}`, ...it.points.map((p) => `   - ${p}`)].join("\n"))
    .join("\n\n");
}

export interface AgendaResult {
  /** The agenda now saved as the meeting's notes */
  agenda: string;
  /** What the agenda was before, for Undo */
  previous: string;
  chat: AgendaTurn[];
}

export async function shapeAgenda(eventId: number, input: { message: string; agenda: string }, now = new Date()): Promise<AgendaResult> {
  const event = await workEvent(eventId);
  const message = input.message.trim();
  if (!message) throw new ValidationError("Type your thoughts first");
  if (message.length > MAX_THOUGHTS) throw new ValidationError(`That is too long to send at once (${MAX_THOUGHTS} characters at most)`);
  const previous = input.agenda.slice(0, MAX_AGENDA);

  const hidden = (await namedThings()).filter((n) => !n.visible && [message, previous, event.title].some((t) => mentions(t, n)));
  if (hidden.length) {
    const names = [...new Set(hidden.map((n) => n.name))].slice(0, 3).join(", ");
    throw new ConflictError(`This names ${names}, which is hidden from AI, so OllieOS will not send it. Edit the agenda by hand instead.`);
  }

  const scope = await askScope();
  const match = matchEvent(event, await loadMatchers());
  const entityRefs = [
    ...match.personIds.map((id) => toRef("person", id)),
    ...match.orgIds.map((id) => toRef("organisation", id)),
    ...match.projectIds.map((id) => toRef("project", id)),
  ];
  const visible = await visibleRefs(scope, entityRefs);
  const visiblePeople = match.personIds.filter((id) => visible.has(toRef("person", id)));
  // The same reading as a brief: get_context for each visible attendee and project, then the organisations.
  const refs: string[] = [];
  for (const r of entityRefs.filter((x) => visible.has(x) && !x.startsWith("organisation:")).slice(0, MAX_CONTEXT)) {
    const ctx = await getContext(scope, { ref: r }, "agenda_writer");
    if (ctx) refs.push(...contextRefs(ctx));
  }
  refs.push(...entityRefs.filter((r) => r.startsWith("organisation:") && visible.has(r)));
  const [items, rules, points] = await Promise.all([
    loadVisibleDocs(scope, [...new Set(refs)]),
    applicableRuleRefs(scope, entityRefs.filter((r) => visible.has(r))).then((rs) => loadVisibleDocs(scope, rs)),
    openPointsFor(visiblePeople),
  ]);
  const docs = [...rules, ...items];
  await recordReads(scope, docs.map((d) => d.ref), { via: "agenda_writer", event: event.id });

  // Invite names: people hidden from AI are left out, everyone else as the invite has them.
  const attendees = match.attendees.filter((a) => a.personId == null || visible.has(toRef("person", a.personId))).map((a) => a.name);
  let out: { reply: string; items: AgendaItem[] };
  try {
    out = await writeAgendaFromThoughts({
      meeting: {
        title: event.title,
        when: `${formatLong(event.startsAt)}, ${formatTime(event.startsAt)} to ${formatTime(event.endsAt)}`,
        minutes: Math.round((event.endsAt.getTime() - event.startsAt.getTime()) / 60_000),
        platform: event.platform,
        attendees,
      },
      agenda: previous,
      history: event.agendaChat.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, text: t.text })),
      message,
      points: points.map((p) => (p.personName ? `${p.personName}: ${p.text}` : p.text)),
      docs,
    });
  } catch (err) {
    logger.error({ err, event: event.id }, "Agenda writer failed");
    throw new UpstreamError("The agenda could not be written just now. Your thoughts are still in the box; try again in a moment.");
  }
  if (!out.items.length) throw new UpstreamError("The agenda came back empty. Try adding a little more about what you want from the meeting.");

  const agenda = agendaText(out.items).slice(0, MAX_AGENDA);
  const at = now.toISOString();
  const chat: AgendaTurn[] = [
    ...event.agendaChat,
    { role: "ollie" as const, text: message, at },
    { role: "ai" as const, text: out.reply || "Here is the agenda.", at },
  ].slice(-KEEP_TURNS);
  await db.transaction(async (tx) => {
    await tx.update(calendarEventsTable).set({ notes: agenda, agendaChat: chat }).where(eq(calendarEventsTable.id, event.id));
    await writeAudit(tx, { actor: "ollie", action: "update", entityType: "calendar_event", entityId: event.id, payload: { agenda: agenda.length, viaAi: true } });
  });
  await recordCheck("agenda_writer", `agenda:${event.id}:${chat.length}`, [out.reply, agenda].join("\n"), { maxWords: 500 });
  return { agenda, previous, chat };
}

/** "Start again": forgets the conversation. The agenda itself stays as it is. */
export async function clearAgendaChat(eventId: number): Promise<void> {
  const event = await workEvent(eventId);
  if (!event.agendaChat.length) return;
  await db.transaction(async (tx) => {
    await tx.update(calendarEventsTable).set({ agendaChat: [] }).where(eq(calendarEventsTable.id, event.id));
    await writeAudit(tx, { actor: "ollie", action: "update", entityType: "calendar_event", entityId: event.id, payload: { agendaChat: "cleared" } });
  });
}
