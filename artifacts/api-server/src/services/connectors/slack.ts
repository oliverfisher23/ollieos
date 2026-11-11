/**
 * Reads Ollie's Slack direct messages, group DMs and @mentions through the Replit connector,
 * read-only, with conversations.history (Slack's search is not available to this connection).
 *
 * Ollie is in about 2,000 conversations, so a check cannot open every one. Conversations with a
 * message in the last two weeks are checked every time. The rest are checked in turn: quiet
 * direct messages every two hours, quiet group DMs and channels a slice at a time, oldest-checked
 * first. Each conversation remembers the last message read, so nothing is read twice and nothing
 * since the first check is missed, only picked up later for quiet conversations.
 */
import { ConnectorError, proxyJson } from "./http";
import { trimText, type WorkMessage, type WorkUnit } from "./messages";

const CONNECTOR = "slack";
const NAME = "Slack";
const HOT_DAYS = 14;
const MAX_HOT = 80;
const QUIET_DMS_PER_RUN = 30;
const QUIET_DM_EVERY_MS = 2 * 3600_000;
const QUIET_OTHERS_PER_RUN = 40;
const MAX_MESSAGES_PER_UNIT = 25;
const MAX_TEXT = 800;
/** Stop opening conversations after this long; the rest are checked next time. */
const BUDGET_MS = 90_000;
/** Slack allows about 50 history calls a minute. */
const GAP_MS = 1000;

export interface SlackConvState {
  /** ts of the newest message read */
  ts?: string;
  /** When the newest message was posted, in ms */
  active?: number;
  /** When it was last checked, in ms */
  checked?: number;
}

export interface SlackState {
  /** Nothing before this is read: the first check starts 24 hours back. */
  since: string;
  convs: Record<string, SlackConvState>;
}

export interface SlackConv {
  id: string;
  kind: "im" | "mpim" | "channel";
  name: string | null;
  /** For a DM, the other person */
  user: string | null;
  /** Slack's own "updated" time in ms. Loosely linked to activity; only used to order unchecked ones. */
  updated?: number;
}

/** Which conversations to open this time, most important first. */
export function pickConversations(convs: SlackConv[], state: SlackState, now: Date): SlackConv[] {
  const t = now.getTime();
  const s = (c: SlackConv) => state.convs[c.id] ?? {};
  const hot = convs
    .filter((c) => (s(c).active ?? 0) > t - HOT_DAYS * 86_400_000)
    .sort((a, b) => (s(b).active ?? 0) - (s(a).active ?? 0))
    .slice(0, MAX_HOT);
  const hotIds = new Set(hot.map((c) => c.id));
  const byChecked = (a: SlackConv, b: SlackConv) => (s(a).checked ?? 0) - (s(b).checked ?? 0) || (b.updated ?? 0) - (a.updated ?? 0);
  const quietDms = convs
    .filter((c) => c.kind === "im" && !hotIds.has(c.id) && (s(c).checked ?? 0) < t - QUIET_DM_EVERY_MS)
    .sort(byChecked)
    .slice(0, QUIET_DMS_PER_RUN);
  const quietOthers = convs
    .filter((c) => c.kind !== "im" && !hotIds.has(c.id))
    .sort(byChecked)
    .slice(0, QUIET_OTHERS_PER_RUN);
  return [...hot, ...quietDms, ...quietOthers];
}

interface SlackUser {
  id: string;
  name: string;
  handle: string;
  email: string | null;
  bot: boolean;
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

let usersCache: { at: number; users: Map<string, SlackUser> } | null = null;

const getJson = (path: string) => proxyJson(CONNECTOR, NAME, path);

/** Slack reports most errors as 200 with ok: false. */
async function slack(path: string): Promise<Record<string, unknown>> {
  const body = await getJson(path);
  if (body.ok === false) {
    const code = String(body.error ?? "unknown_error");
    if (/invalid_auth|not_authed|token_revoked|account_inactive|missing_scope/.test(code)) {
      throw new ConnectorError(`Slack refused access (${code}). Reconnect it in Replit.`, true);
    }
    throw new ConnectorError(`Slack answered: ${code}`);
  }
  return body;
}

async function loadUsers(now: number): Promise<Map<string, SlackUser>> {
  if (usersCache && now - usersCache.at < 6 * 3600_000) return usersCache.users;
  const users = new Map<string, SlackUser>();
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const body = await slack("/users.list?limit=1000" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    for (const u of (body.members as Record<string, unknown>[] | undefined) ?? []) {
      const profile = (u.profile ?? {}) as Record<string, unknown>;
      const name = String(u.real_name || profile.real_name || profile.display_name || u.name || u.id);
      users.set(String(u.id), {
        id: String(u.id),
        name,
        handle: String(u.name ?? ""),
        email: typeof profile.email === "string" ? profile.email.toLowerCase() : null,
        bot: !!u.is_bot || u.id === "USLACKBOT" || !!u.deleted,
      });
    }
    cursor = String((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
    if (!cursor) break;
  }
  usersCache = { at: now, users };
  return users;
}

export interface SlackPerson {
  id: string;
  name: string;
  handle: string;
  email: string | null;
}

/** Slack accounts in Ollie's workspace whose name, handle or email contains the text, people only. */
export async function findSlackUsers(q: string, now = Date.now(), limit = 20): Promise<SlackPerson[]> {
  const needle = q.trim().toLowerCase();
  const users = await loadUsers(now);
  const out: SlackPerson[] = [];
  for (const u of users.values()) {
    if (u.bot) continue;
    if (needle && ![u.name, u.handle, u.email ?? ""].some((v) => v.toLowerCase().includes(needle))) continue;
    out.push({ id: u.id, name: u.name, handle: u.handle, email: u.email });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

/** Test hook. */
export function resetSlackCache() {
  usersCache = null;
}

/** Slack markup to plain text: <@U1> to @Name, <url|label> to label, <#C1|name> to #name. */
export function plainSlack(text: string, users: Map<string, { name: string }>): string {
  return text
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => "@" + (users.get(id)?.name ?? "someone"))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const KEEP_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share", "me_message"]);

/** Messages worth sorting: from people, with text. Channels keep only those that mention Ollie. */
export function usefulMessages(msgs: SlackMessage[], kind: SlackConv["kind"], me: string, users: Map<string, SlackUser>): SlackMessage[] {
  return msgs.filter((m) => {
    if (!KEEP_SUBTYPES.has(m.subtype) || m.bot_id || !m.user || !m.text?.trim()) return false;
    if (users.get(m.user)?.bot) return false;
    if (kind === "channel") return m.text.includes(`<@${me}>`);
    return true;
  });
}

/** Group DM names look like mpdm-oliver.fisher--sam.lee--amy-1. */
function mpimMembers(name: string | null, users: Map<string, SlackUser>, me: string): SlackUser[] {
  const handles = (name ?? "").replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--");
  const byHandle = new Map([...users.entries()].map(([id, u]) => [u.handle, { id, u }]));
  return handles.map((h) => byHandle.get(h)).filter((x): x is { id: string; u: SlackUser } => !!x && x.id !== me).map((x) => x.u);
}

export interface SlackRead {
  account: string;
  units: WorkUnit[];
  found: number;
  leftOut: number;
  /** Conversations opened this time */
  checked: number;
  state: SlackState;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readSlack(prev: SlackState | null, now = new Date()): Promise<SlackRead> {
  const started = Date.now();
  const state: SlackState = prev ? { since: prev.since, convs: { ...prev.convs } } : { since: new Date(now.getTime() - 86_400_000).toISOString(), convs: {} };
  const auth = await slack("/auth.test");
  const me = String(auth.user_id);
  const teamUrl = String(auth.url ?? "https://slack.com/").replace(/\/?$/, "/");
  const account = `${auth.user ?? "you"} at ${auth.team ?? "Slack"}`;
  const users = await loadUsers(now.getTime());

  const convs: SlackConv[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const body = await slack(
      "/users.conversations?types=im,mpim,public_channel,private_channel&exclude_archived=true&limit=999" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    for (const c of (body.channels as Record<string, unknown>[] | undefined) ?? []) {
      const kind = c.is_im ? "im" : c.is_mpim ? "mpim" : "channel";
      const user = kind === "im" ? String(c.user ?? "") : null;
      if (kind === "im" && (c.is_user_deleted || !user || user === me || users.get(user)?.bot)) continue;
      convs.push({ id: String(c.id), kind, name: typeof c.name === "string" ? c.name : null, user, updated: typeof c.updated === "number" ? c.updated : undefined });
    }
    cursor = String((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
    if (!cursor) break;
  }

  const sinceTs = (new Date(state.since).getTime() / 1000).toFixed(6);
  const units: WorkUnit[] = [];
  let found = 0;
  let leftOut = 0;
  let checked = 0;
  for (const c of pickConversations(convs, state, now)) {
    if (Date.now() - started > BUDGET_MS) break;
    if (checked > 0) await sleep(GAP_MS);
    const cs = state.convs[c.id] ?? {};
    const oldest = cs.ts && cs.ts > sinceTs ? cs.ts : sinceTs;
    const body = await slack(`/conversations.history?channel=${c.id}&oldest=${oldest}&limit=200&inclusive=false`);
    checked++;
    const msgs = ((body.messages as SlackMessage[] | undefined) ?? []).filter((m) => m.ts > oldest);
    const next: SlackConvState = { ...cs, checked: now.getTime() };
    if (msgs.length) {
      const newest = msgs.reduce((a, m) => (m.ts > a ? m.ts : a), "0");
      next.ts = newest;
      next.active = Math.round(Number(newest) * 1000);
    }
    state.convs[c.id] = next;

    const useful = usefulMessages(msgs, c.kind, me, users);
    if (c.kind !== "channel") leftOut += msgs.length - useful.length;
    if (!useful.length) continue;
    found += useful.length;

    const ordered = useful.sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(-MAX_MESSAGES_PER_UNIT);
    const other = c.user ? users.get(c.user) : undefined;
    const members = c.kind === "mpim" ? mpimMembers(c.name, users, me) : [];
    const label = c.kind === "im" ? (other?.name ?? "Direct message") : c.kind === "mpim" ? members.map((u) => u.name).join(", ") || "Group DM" : `#${c.name ?? c.id}`;
    const messages: WorkMessage[] = ordered.map((m) => {
      const u = users.get(m.user!);
      return {
        ref: `slack:${c.id}:${m.ts}`,
        at: new Date(Number(m.ts) * 1000),
        fromMe: m.user === me,
        fromName: m.user === me ? null : (u?.name ?? null),
        fromAddress: u?.email ?? null,
        fromSlackId: m.user ?? null,
        text: trimText(plainSlack(m.text ?? "", users), MAX_TEXT),
        url: `${teamUrl}archives/${c.id}/p${m.ts.replace(".", "")}`,
      };
    });
    const people =
      c.kind === "im"
        ? [{ name: other?.name ?? null, email: other?.email ?? null, slackId: c.user ?? null }]
        : c.kind === "mpim"
          ? members.map((u) => ({ name: u.name, email: u.email, slackId: u.id }))
          : [...new Map(ordered.filter((m) => m.user !== me).map((m) => [m.user!, users.get(m.user!)])).values()].filter(Boolean).map((u) => ({ name: u!.name, email: u!.email, slackId: u!.id }));
    units.push({
      source: "slack",
      key: `slack:${c.id}:${ordered[ordered.length - 1].ts}`,
      subject: null,
      channel: label,
      people,
      messages,
    });
  }
  // Forget conversations Ollie has left, so the saved state does not grow for ever.
  const live = new Set(convs.map((c) => c.id));
  for (const id of Object.keys(state.convs)) if (!live.has(id)) delete state.convs[id];
  return { account, units, found, leftOut, checked, state };
}
