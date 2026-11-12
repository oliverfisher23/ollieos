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
  slack_sorter: { name: "Slack sorter", kind: "sorter", does: "Reads new Slack messages and finds tasks, promises, waiting on, knowledge, whether a message needs your reply, and ideas worth coming back to (the idea spotter).", reads: "New Slack direct messages, group DMs and mentions, and the names AI may see." },
  granola_reader: { name: "Granola reader", kind: "sorter", does: "Reads notes from meetings you were in and finds actions, promises, decisions, ideas worth coming back to (the idea spotter) and a summary.", reads: "New Granola notes from your meetings, and project names AI may see." },
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
  rules_from_edits: { name: "Rules from your edits", kind: "judge", does: "Once a week, finds changes you made to OllieOS drafts the same way three or more times and proposes them as rules.", reads: "Drafts OllieOS wrote and what you saved or sent instead, from the last 8 weeks." },
  draft_checker: { name: "Draft check", kind: "judge", does: "Checks a draft against your rules, lists the lines that break one, and rewrites only those lines when asked.", reads: "The draft and the rules that apply to it." },
  meeting_follow_up: { name: "Meeting follow-ups", kind: "writer", does: "Drafts a recap email after an external meeting from its Granola notes, saved to Gmail as a draft.", reads: "The meeting's Granola notes, its actions and decisions, your rules and How you write." },
  brief_writer: { name: "Meeting briefs", kind: "writer", does: "Writes why a meeting matters, an agenda and questions for the prep page.", reads: "Items AI may see about the people, organisations and projects in the meeting." },
  agenda_writer: { name: "Meeting agendas", kind: "writer", does: "Turns the thoughts you drop on a meeting into a timed agenda you can edit, and revises it as you add more.", reads: "What you typed, your current agenda, the meeting's title and invite, and items AI may see about the people, organisations and projects on it. Never used when you name something hidden from AI." },
  agenda_checker: { name: "Agenda check", kind: "judge", does: "After a meeting, marks each item on your agenda as covered, partly covered or not covered from its Granola note, so what was missed can go on the next agenda.", reads: "Your agenda and the meeting's Granola note. Never used when the agenda or title names something hidden from AI." },
  thread_matcher: { name: "Meeting thread matcher", kind: "judge", does: "Decides which recent email and Slack threads with the people on a meeting are about that meeting, learning from what you marked Not about this meeting.", reads: "The meeting's title, invite and agenda, recent threads with its people that AI may see, and your earlier verdicts." },
  voice_parser: { name: "Voice capture", kind: "sorter", does: "Splits what you say into tasks, promises and facts for you to check before anything is saved.", reads: "What you said, and the names of projects, people and organisations AI may see. Never used when you name something hidden from AI." },
  test_replay: { name: "Test case replays", kind: "sorter", does: "Runs a reader, as the code now stands, against the test cases you kept, before a changed prompt or model ships. Makes no tasks.", reads: "The exchanges kept as test cases." },
  writer_grader: { name: "Writing grader", kind: "judge", does: "Once a week, grades a few pieces from each writer out of 5 for being useful, accurate to what it was given, short and in your style.", reads: "A sample of answers, briefs, digest summaries and drafts from the last week, with nothing hidden from AI." },
  digest_summary: { name: "Digest summary", kind: "writer", does: "Writes the one-sentence summary at the top of the daily digest.", reads: "Digest lines AI may see; hidden ones are only counted." },
  presorter: { name: "Knowledge Inbox pre-sort", kind: "judge", does: "Marks each Knowledge Inbox card as likely to keep, likely to reject or the same as something approved, so cards can be decided in groups. Repeats of another waiting card are found without AI.", reads: "Cards AI may see, the close matches already approved, and your recent decisions on cards." },
  stale_checker: { name: "Stale fact checker", kind: "judge", does: "For each fact on Needs a check, looks at what OllieOS has seen since it was last confirmed and says whether it still holds, has changed or nothing says either way.", reads: "The stale fact, and notes, activity, decisions, tasks, cards, newer facts and Cowork sessions about the same item since, that AI may see." },
  delegation: { name: "Delegation suggester", kind: "judge", does: "Suggests a colleague who could take a Now or Backlog task, and drafts the Slack message. Never sends it.", reads: "Your open tasks AI may see, and colleagues with Slack: their roles, projects and what they have done for you." },
  weekly_update: { name: "Friday update", kind: "writer", does: "Drafts your Friday leadership update for Slack: Wins, Blockers, AI and Automation, and Quarterly Actions. Never posts it.", reads: "The week's done tasks, decisions, meetings, what you are waiting on, goals and the Agents page, that AI may see." },
  reader_coach: { name: "Reader coach", kind: "judge", does: "Once a week, finds Inbox items the Gmail, Slack and Granola readers keep getting wrong (sent to Noise, dropped, renamed, reprioritised) and proposes a lesson for that reader. Lessons only apply once you turn them on.", reads: "Items the readers made in the last 8 weeks that AI may see, what you did with them, and the lessons already proposed." },
  duplicate_judge: { name: "Duplicate check", kind: "judge", does: "Once a day, looks at pairs of open tasks with similar titles and says which are the same piece of work, for the Duplicates page.", reads: "The title, source, person, due date and quote of open tasks AI may see whose titles share words." },
  stuck_coach: { name: "Stuck-task coach", kind: "judge", does: "Once a day, looks at Now and Backlog tasks that keep slipping (due date moved, snoozed, long overdue, untouched in Now) and suggests one thing to try: a first step, splitting it, handing it on or dropping it.", reads: "The title, notes, checklist, project, person and due date of slipping tasks AI may see." },
  card_coach: { name: "Card coach", kind: "judge", does: "Finds kinds of Knowledge Inbox card you keep rejecting from a reader and proposes a lesson so it stops proposing them. Lessons only apply once you turn them on.", reads: "Cards from the Gmail, Slack and Granola readers you decided lately that AI may see, and the lessons already proposed." },
  contact_finder: { name: "Contact finder", kind: "judge", does: "Proposes people you are in real two-way contact with who are not in Contacts yet, with their organisation, role and how you know them. Shared inboxes and automated senders are left out. Adds the clearest ones itself only if you turn that on.", reads: "Names, addresses, subjects and signatures of people not in Contacts, from email threads, Slack conversations and meetings AI may read." },
  work_pack: { name: "Work pack", kind: "writer", does: "For Now tasks and tasks due soon, gathers what OllieOS already holds (Cowork sessions, documents, decisions, facts, notes) and writes the first output: a message to send, or an outline and what is missing. Never sends anything.", reads: "The task, and the items AI may see that match it or hang off its project and person, your rules and How you write." },
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
