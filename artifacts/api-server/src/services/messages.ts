/**
 * Counts for Messages across email and Slack: how many need a reply (the To answer count, for the
 * menu), and how many of those have waited over a working day (Home and the digest).
 */
import { listEmailDrafts } from "./email";
import { listInbox, needsReply, peekInbox, type InboxItem } from "./inbox";
import { readByNow } from "./connectors";
import { logger } from "../lib/logger";
import { oneWorkingDayBefore, slackNeedingReply } from "./slackToAnswer";

/** How old the last look at Gmail may be before the menu count has it looked at again */
const COUNT_FRESH_MS = 5 * 60_000;

export interface MessageCounts {
  /** Emails and Slack messages under Needs a reply on To answer */
  needsReply: number;
  /** Those that have waited over one working day */
  overdue: number;
  emailsOverdue: number;
  slackOverdue: number;
}

/**
 * `look` lets Gmail be looked at again in the background when the last look is old (the menu);
 * without it the last look is used as it is (Home, the digest).
 */
export async function messageCounts(now = new Date(), look = false): Promise<MessageCounts> {
  let emails: InboxItem[];
  try {
    emails = look ? (await listInbox(COUNT_FRESH_MS)).items : await peekInbox();
  } catch (err) {
    // Gmail cannot be read just now: count from the last look.
    logger.warn({ err }, "Counting Messages without a new look at Gmail");
    emails = await peekInbox();
  }
  const [drafts, slackRead] = await Promise.all([listEmailDrafts(), readByNow("slack")]);
  // An email with a draft is on Drafts, not To answer.
  const drafted = new Set(drafts.items.map((d) => d.task.id));
  const waitingEmails = emails.filter((e) => needsReply(e) && (e.taskId == null || !drafted.has(e.taskId)));
  const waitingSlack = slackRead === "ollieos" ? await slackNeedingReply(now) : [];
  const cutoff = oneWorkingDayBefore(now);
  const emailsOverdue = waitingEmails.filter((e) => e.at <= cutoff).length;
  const slackOverdue = waitingSlack.filter((r) => r.at <= cutoff).length;
  return { needsReply: waitingEmails.length + waitingSlack.length, overdue: emailsOverdue + slackOverdue, emailsOverdue, slackOverdue };
}

/** For Home and the digest: emails that need a reply and have waited over one working day, as of the last look at Gmail. */
export async function emailRepliesOverdue(now = new Date()): Promise<number> {
  try {
    return (await messageCounts(now)).emailsOverdue;
  } catch (err) {
    logger.warn({ err }, "Could not count emails waiting for a reply");
    return 0;
  }
}
