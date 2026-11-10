/**
 * Reads Ollie's Gmail (the account behind Superhuman) through the Replit connector, read-only.
 *
 * Each check reads mail that arrived in the inbox, or that Ollie sent, since the last check.
 * Gmail's Promotions, Social, Updates and Forums tabs are skipped, and so are mailing lists,
 * no-reply senders and calendar invites, before any AI sees them. Quoted replies are cut so only
 * the new text of each message is sorted.
 */
import { proxyJson } from "./http";
import { trimText, type WorkUnit } from "./messages";

const CONNECTOR = "google-mail";
const NAME = "Gmail";
/** At most this many messages per check; the rest are read by the next check. */
export const GMAIL_PER_RUN = 100;
const MAX_TEXT = 3000;

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

export type GmailSkip = "draft" | "bulk" | "automated" | "calendar" | "empty";

export interface Address {
  name: string | null;
  email: string | null;
}

/** Splits an address header such as `"Lee, Sam" <sam@x.com>, amy@y.com` into names and emails. */
export function parseAddresses(header: string | undefined): Address[] {
  if (!header) return [];
  const out: Address[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  const flush = () => {
    const v = cur.trim();
    cur = "";
    if (!v) return;
    const m = /^(.*?)<([^>]+)>\s*$/.exec(v);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, "").trim();
      out.push({ name: name || null, email: m[2].trim().toLowerCase() });
    } else if (v.includes("@")) {
      out.push({ name: null, email: v.replace(/^"|"$/g, "").toLowerCase() });
    }
  };
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if (ch === "," && !quoted && !angle) flush();
    else cur += ch;
  }
  flush();
  return out;
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findPart(p: GmailPart | undefined, mime: string): GmailPart | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data && !p.filename) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return null;
}

function hasPart(p: GmailPart | undefined, mime: string): boolean {
  if (!p) return false;
  if (p.mimeType === mime) return true;
  return (p.parts ?? []).some((c) => hasPart(c, mime));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Cuts the quoted earlier messages and the signature marker from a reply. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();
    if (/^On .+wrote:$/.test(l) || (/^On .+/.test(l) && /wrote:$/.test(next) && l.length < 200)) break;
    if (/^-{2,}\s*(Original|Forwarded) Message/i.test(l)) break;
    if (/^_{10,}$/.test(l)) break;
    if (/^From:\s/.test(l) && lines.slice(i + 1, i + 5).some((n) => /^(Sent|Date):\s/.test(n.trim()))) break;
    if (l === "--") break;
    if (l.startsWith(">")) continue;
    out.push(lines[i]);
  }
  return out.join("\n");
}

const AUTOMATED = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce)([._+-]|@)/i;
const INVITE = /^(invitation|updated invitation|accepted|declined|tentatively accepted|cancelled event|canceled event|new event)( with note)?:/i;

export interface MappedMessage {
  unit: WorkUnit | null;
  skipped?: GmailSkip;
  at: Date;
}

/** One Gmail message as one exchange for the sorter, or why it was left out. */
export function mapGmailMessage(m: GmailMessage, account: string): MappedMessage {
  const at = new Date(Number(m.internalDate ?? 0));
  const labels = new Set(m.labelIds ?? []);
  if (labels.has("DRAFT") || labels.has("SPAM") || labels.has("TRASH")) return { unit: null, skipped: "draft", at };
  const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
  const from = parseAddresses(header("from"))[0] ?? { name: null, email: null };
  const me = account.toLowerCase();
  const fromMe = labels.has("SENT") || from.email === me;
  const subject = header("subject")?.trim() || null;

  if (!fromMe) {
    const precedence = header("precedence")?.toLowerCase() ?? "";
    const auto = header("auto-submitted")?.toLowerCase() ?? "";
    if (header("list-unsubscribe") || header("list-id") || /bulk|list|junk/.test(precedence)) return { unit: null, skipped: "bulk", at };
    if ((auto && auto !== "no") || (from.email && AUTOMATED.test(from.email))) return { unit: null, skipped: "automated", at };
  }
  if ((subject && INVITE.test(subject)) || hasPart(m.payload, "text/calendar")) return { unit: null, skipped: "calendar", at };

  const plain = findPart(m.payload, "text/plain");
  const html = plain ? null : findPart(m.payload, "text/html");
  const raw = plain?.body?.data ? decode(plain.body.data) : html?.body?.data ? htmlToText(decode(html.body.data)) : (m.snippet ?? "");
  const text = trimText(stripQuoted(raw), MAX_TEXT);
  if (!text) return { unit: null, skipped: "empty", at };

  const others = fromMe
    ? [...parseAddresses(header("to")), ...parseAddresses(header("cc"))]
    : [from, ...parseAddresses(header("to")), ...parseAddresses(header("cc"))];
  const seen = new Set<string>();
  const people = others.filter((p) => p.email && p.email !== me && !seen.has(p.email) && (seen.add(p.email), true)).slice(0, 12);
  const url = `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${m.threadId}`;
  return {
    at,
    unit: {
      source: "email",
      key: `gmail:${m.id}`,
      subject,
      channel: null,
      people,
      messages: [{ ref: `gmail:${m.id}`, at, fromMe, fromName: fromMe ? null : from.name, fromAddress: fromMe ? me : from.email, text, url }],
    },
  };
}

/**
 * Messages from the same thread become one exchange, so a back-and-forth is sorted once and a
 * request answered later in the thread is not added. Units arrive oldest first.
 */
export function groupByThread(units: WorkUnit[]): WorkUnit[] {
  const byThread = new Map<string, WorkUnit>();
  for (const u of units) {
    const thread = u.messages[0].url.split("#all/")[1] ?? u.key;
    const cur = byThread.get(thread);
    if (!cur) {
      byThread.set(thread, { ...u, people: [...u.people], messages: [...u.messages] });
      continue;
    }
    cur.messages.push(...u.messages);
    cur.key = u.key;
    for (const p of u.people) if (!cur.people.some((q) => q.email === p.email)) cur.people.push(p);
  }
  return [...byThread.values()];
}

export interface GmailRead {
  account: string;
  units: WorkUnit[];
  /** Messages read in this check */
  found: number;
  leftOut: number;
  /** Arrival time of the newest message read, for the next check's starting point */
  newest: Date | null;
  /** True when more messages are waiting than one check reads */
  more: boolean;
}

const getJson = (path: string) => proxyJson(CONNECTOR, NAME, path);

async function inPool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function readGmail(since: Date): Promise<GmailRead> {
  const profile = await getJson("/gmail/v1/users/me/profile");
  const account = String(profile.emailAddress ?? "").toLowerCase();

  const q = `after:${Math.floor(since.getTime() / 1000) - 1} {in:inbox in:sent} -in:chats -category:promotions -category:social -category:updates -category:forums`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const p = new URLSearchParams({ q, maxResults: "500", includeSpamTrash: "false" });
    if (pageToken) p.set("pageToken", pageToken);
    const body = await getJson("/gmail/v1/users/me/messages?" + p.toString());
    ids.push(...((body.messages as { id: string }[] | undefined) ?? []).map((m) => m.id));
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }

  // Gmail lists newest first; read the oldest first so a busy day carries over in order.
  const todo = [...new Set(ids)].reverse().slice(0, GMAIL_PER_RUN);
  const messages = await inPool(todo, 5, (id) => getJson(`/gmail/v1/users/me/messages/${id}?format=full`) as unknown as Promise<GmailMessage>);

  const mapped: MappedMessage[] = [];
  let leftOut = 0;
  let found = 0;
  let newest: Date | null = null;
  for (const m of messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate))) {
    const one = mapGmailMessage(m, account);
    if (one.at.getTime() <= since.getTime()) continue;
    found++;
    if (!newest || one.at > newest) newest = one.at;
    if (one.unit) mapped.push(one);
    else leftOut++;
  }
  return { account, units: groupByThread(mapped.map((x) => x.unit!)), found, leftOut, newest, more: ids.length > GMAIL_PER_RUN };
}
