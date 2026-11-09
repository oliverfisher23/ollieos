import { resolveDueToken, todayLondon } from "./dates";
import type { Priority } from "./constants";

/**
 * Quick-add syntax:
 *   !high !low !medium   priority (default Medium)
 *   due:fri due:2026-11-20 due:tomorrow
 *   #backlog             goes to Backlog instead of Now
 *   @project-slug        links a project by slug
 */
export interface QuickAddToken {
  kind: "priority" | "due" | "status" | "project" | "unknown-due";
  raw: string;
  label: string;
}

export interface QuickAddParse {
  title: string;
  priority: Priority;
  dueDate: string | null;
  status: "now" | "backlog";
  projectSlug: string | null;
  tokens: QuickAddToken[];
  warnings: string[];
}

const PRIORITY_RE = /^!(high|medium|med|low)$/i;
const DUE_RE = /^due:(\S+)$/i;
const STATUS_RE = /^#(backlog|now)$/i;
const PROJECT_RE = /^@([a-z0-9][a-z0-9-]*)$/i;

export function parseQuickAdd(text: string, today: string = todayLondon()): QuickAddParse {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const titleWords: string[] = [];
  const tokens: QuickAddToken[] = [];
  const warnings: string[] = [];
  let priority: Priority = "medium";
  let dueDate: string | null = null;
  let status: "now" | "backlog" = "now";
  let projectSlug: string | null = null;

  for (const word of words) {
    let m: RegExpMatchArray | null;
    if ((m = word.match(PRIORITY_RE))) {
      const v = m[1].toLowerCase();
      priority = v === "high" ? "high" : v === "low" ? "low" : "medium";
      tokens.push({ kind: "priority", raw: word, label: `${priority[0].toUpperCase()}${priority.slice(1)} priority` });
    } else if ((m = word.match(DUE_RE))) {
      const resolved = resolveDueToken(m[1], today);
      if (resolved) {
        dueDate = resolved;
        tokens.push({ kind: "due", raw: word, label: resolved });
      } else {
        tokens.push({ kind: "unknown-due", raw: word, label: m[1] });
        warnings.push(`Could not read the date "${m[1]}", added without a due date`);
      }
    } else if ((m = word.match(STATUS_RE))) {
      status = m[1].toLowerCase() === "backlog" ? "backlog" : "now";
      tokens.push({ kind: "status", raw: word, label: status === "backlog" ? "Backlog" : "Now" });
    } else if ((m = word.match(PROJECT_RE))) {
      projectSlug = m[1].toLowerCase();
      tokens.push({ kind: "project", raw: word, label: projectSlug });
    } else {
      titleWords.push(word);
    }
  }

  return { title: titleWords.join(" "), priority, dueDate, status, projectSlug, tokens, warnings };
}
