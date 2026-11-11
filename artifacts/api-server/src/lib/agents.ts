/**
 * Every AI agent inside OllieOS (build plan section 21, Part V): one entry per job that calls a
 * model, so each run can be recorded against it and the Agents page can explain it. A call to the
 * model must name one of these keys.
 */
export type AgentKind = "sorter" | "judge" | "writer" | "researcher";

export interface AgentInfo {
  name: string;
  kind: AgentKind;
  /** One line on what it does */
  does: string;
  /** What it may read */
  reads: string;
}

export const AGENTS = {
  gmail_sorter: { name: "Gmail sorter", kind: "sorter", does: "Reads new email and finds tasks, promises, things you are waiting on, and firm decisions and facts for the Knowledge Inbox.", reads: "New Gmail messages, and the names of projects, people, organisations and products AI may see." },
  slack_sorter: { name: "Slack sorter", kind: "sorter", does: "Reads new Slack messages and finds tasks, promises, waiting on, knowledge, and whether a message needs your reply.", reads: "New Slack direct messages, group DMs and mentions, and the names AI may see." },
  granola_reader: { name: "Granola reader", kind: "sorter", does: "Reads notes from meetings you were in and finds actions, promises, decisions and a summary.", reads: "New Granola notes from your meetings, and project names AI may see." },
  granola_look_back: { name: "Granola look back", kind: "sorter", does: "The one-off read of older Granola notes for decisions and actions OllieOS missed.", reads: "Older Granola notes from your meetings." },
  noise_judge: { name: "Probably noise", kind: "judge", does: "Marks Inbox email and Slack items that look like noise, learning from your noise rules and what you kept.", reads: "Unchecked Inbox items not hidden from AI, and examples of what you moved to Noise or kept." },
  inbox_reader: { name: "Needs a reply", kind: "judge", does: "Sorts To answer emails into Needs a reply or For your information, with a line on what is wanted.", reads: "The last three messages of inbox emails from people AI may see." },
  no_reply_judge: { name: "Waiting for a reply", kind: "judge", does: "Decides whether an email you sent asked for something, so unanswered ones go on Waiting for a reply.", reads: "Emails you sent, and project names AI may see." },
  drive_matcher: { name: "Drive file matcher", kind: "judge", does: "Matches Drive files you opened to projects and suggests them for the Library.", reads: "The name, folder, owner and start of files you opened, and project names AI may see." },
  contradiction_judge: { name: "Contradiction check", kind: "judge", does: "Checks each new Knowledge Inbox card against approved facts, decisions and rules about the same thing.", reads: "The card, and approved items about the same thing that AI may see." },
  function_suggester: { name: "Function and client suggester", kind: "judge", does: "Suggests the function and client for projects that are missing them.", reads: "Projects AI may see, with their facts and documents." },
  product_user_suggester: { name: "Primary user suggester", kind: "judge", does: "Suggests who each product is mainly for.", reads: "Products AI may see, with their facts and documents." },
  document_reader: { name: "Document reader", kind: "sorter", does: "Reads Library documents, Dropbox files and Cowork sessions for facts, decisions, rules, playbooks and relationships.", reads: "The text of documents and sessions AI may see, and names AI may see." },
  document_change_line: { name: "Document change line", kind: "writer", does: "Says in one line what a colleague changed in a Library document, for the digest.", reads: "The lines removed and added in a document AI may see." },
  thread_summary: { name: "Thread summaries", kind: "writer", does: "Summarises long email threads at the top of the reading pane.", reads: "Email threads with no one hidden from AI." },
  writing_style: { name: "How you write", kind: "writer", does: "Reads your sent email to write the note every draft follows.", reads: "Up to 200 emails you sent in the last 6 months." },
  research: { name: "Company research", kind: "researcher", does: "Researches outside companies before external meetings, with web search and your email with them.", reads: "The web, and 6 months of your email with that company." },
  ask_answer: { name: "Ask OllieOS", kind: "writer", does: "Answers your questions with citations, from what OllieOS holds.", reads: "Items AI may see, plus anything you allow for one question." },
  ask_draft: { name: "Ask: draft a reply", kind: "writer", does: "Drafts an email from an Ask answer.", reads: "The answer and the items it cited." },
  email_reply_draft: { name: "Email replies and chases", kind: "writer", does: "Writes replies, briefed replies and chases in your style, saved to Gmail as drafts.", reads: "The email thread, items AI may see about it, your rules and How you write." },
  check_in_draft: { name: "Check-in drafts", kind: "writer", does: "Drafts a check-in to someone you have not been in touch with.", reads: "The person and open threads with them that AI may see." },
  slack_reply_draft: { name: "Slack reply drafts", kind: "writer", does: "Drafts a Slack reply for you to copy.", reads: "The Slack conversation, the person and their open tasks AI may see." },
  brief_writer: { name: "Meeting briefs", kind: "writer", does: "Writes why a meeting matters, an agenda and questions for the prep page.", reads: "Items AI may see about the people, organisations and projects in the meeting." },
  digest_summary: { name: "Digest summary", kind: "writer", does: "Writes the one-sentence summary at the top of the daily digest.", reads: "Digest lines AI may see; hidden ones are only counted." },
} as const satisfies Record<string, AgentInfo>;

export type AgentKey = keyof typeof AGENTS;
export const AGENT_KEYS = Object.keys(AGENTS) as AgentKey[];

/** List prices in US dollars per million tokens (Anthropic, November 2026). */
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Prompts longer than this many input tokens are charged the long rates */
  longOver?: number;
  longInput?: number;
  longOutput?: number;
}

const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, longOver: 100_000, longInput: 0.5, longOutput: 2.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};
/** Web search: $10 per 1,000 searches */
const SEARCH_DOLLARS = 0.01;

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

/** Estimated cost at list price, in millionths of a dollar. Unknown models count as Sonnet. */
export function costMicros(model: string, u: RunUsage): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const long = p.longOver != null && prompt > p.longOver;
  const input = long ? p.longInput! : p.input;
  const output = long ? p.longOutput! : p.output;
  // Dollars per million tokens times tokens is micro-dollars.
  const micros = u.inputTokens * input + u.outputTokens * output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite + u.webSearches * SEARCH_DOLLARS * 1_000_000;
  return Math.round(micros);
}
