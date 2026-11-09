export const TASK_STATUSES = ["inbox", "now", "backlog", "waiting", "done", "noise"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_STATUSES: readonly TaskStatus[] = ["inbox", "now", "backlog", "waiting"];

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_SOURCES = ["email", "slack", "meeting", "quarterly", "manual"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const TASK_KINDS = ["task", "promise"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "Inbox",
  now: "Now",
  backlog: "Backlog",
  waiting: "Waiting on",
  done: "Done",
  noise: "Noise",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const SOURCE_LABELS: Record<TaskSource, string> = {
  email: "Email",
  slack: "Slack",
  meeting: "Meeting",
  quarterly: "Quarterly",
  manual: "Manual",
};

/** Letter shown in the 24px source mark circle. */
export const SOURCE_MARKS: Record<TaskSource, string> = {
  email: "E",
  slack: "S",
  meeting: "M",
  quarterly: "Q",
  manual: "O",
};

/** Waiting items turn amber at this many days. */
export const WAITING_AMBER_DAYS = 5;

/** Backlog items are marked Stale after this many days untouched. */
export const STALE_BACKLOG_DAYS = 30;
