/** What the Gmail, Slack and Granola readers hand to the sorters: exchanges made of messages. */

export interface WorkMessage {
  /** The capture source_ref, for example gmail:18c2f0 or slack:D123:1731234567.000100 */
  ref: string;
  at: Date;
  fromMe: boolean;
  fromName: string | null;
  fromAddress: string | null;
  /** Slack: the sender's Slack user id, so they match a person by their Slack account */
  fromSlackId?: string | null;
  text: string;
  url: string;
}

export interface WorkUnit {
  source: "email" | "slack" | "meeting";
  /** Activity source_ref for this exchange */
  key: string;
  subject: string | null;
  /** Slack: "#channel", the other person's name for a DM, or the names in a group DM */
  channel: string | null;
  /** Who else is in the exchange, for linking to People */
  people: { name: string | null; email: string | null; slackId?: string | null }[];
  /** Oldest first */
  messages: WorkMessage[];
}

/** Collapses runs of blank lines and spaces, and cuts to a length on a word boundary. */
export function trimText(text: string, max: number): string {
  const t = text
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.8 ? cut.slice(0, space) : cut) + " …";
}
