export const TASK_STATUSES = ["inbox", "now", "backlog", "waiting", "done", "noise", "dropped", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_STATUSES: readonly TaskStatus[] = ["inbox", "now", "backlog", "waiting"];

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_SOURCES = ["email", "slack", "meeting", "quarterly", "manual", "session"] as const;
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
  dropped: "Dropped",
  archived: "Archived",
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
  session: "Cowork",
};

/** Letter shown in the 24px source mark circle. */
export const SOURCE_MARKS: Record<TaskSource, string> = {
  email: "E",
  slack: "S",
  meeting: "M",
  quarterly: "Q",
  manual: "O",
  session: "C",
};

/** Waiting items turn amber at this many days. */
export const WAITING_AMBER_DAYS = 5;

/** Backlog items are marked Stale after this many days untouched. */
export const STALE_BACKLOG_DAYS = 30;

/* ---------- Relationship cadence (feature 05) ---------- */

export const CADENCES = ["weekly", "fortnightly", "monthly", "two_monthly", "quarterly", "none"] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  fortnightly: "Every 2 weeks",
  monthly: "Monthly",
  two_monthly: "Every 2 months",
  quarterly: "Quarterly",
  none: "None",
};

/** Length of one cadence period in days. */
export const CADENCE_DAYS: Record<Exclude<Cadence, "none">, number> = {
  weekly: 7,
  fortnightly: 14,
  monthly: 30,
  two_monthly: 60,
  quarterly: 91,
};

/** Due soon covers the last 20% of a period. */
export const DUE_SOON_SHARE = 0.2;

export type CadenceStatus = "overdue" | "due_soon" | "on_track" | "paused" | "none";

export interface CadenceState {
  status: CadenceStatus;
  /** Whole days since the last contact; null when there is none on file */
  daysSince: number | null;
  /** Days past the period; null unless overdue with a contact on file */
  daysOverdue: number | null;
  /** Days left in the period; null unless due soon or on track */
  daysLeft: number | null;
}

/**
 * Where someone stands against their cadence. Overdue after one full period with no contact (or with
 * none on file at all); due soon in the last 20% of the period. Paused cadences have no status.
 */
export function cadenceState(input: { cadence: Cadence; paused: boolean; daysSince: number | null }): CadenceState {
  const { cadence, paused, daysSince } = input;
  if (cadence === "none") return { status: "none", daysSince, daysOverdue: null, daysLeft: null };
  if (paused) return { status: "paused", daysSince, daysOverdue: null, daysLeft: null };
  const period = CADENCE_DAYS[cadence];
  if (daysSince == null) return { status: "overdue", daysSince, daysOverdue: null, daysLeft: null };
  if (daysSince > period) return { status: "overdue", daysSince, daysOverdue: daysSince - period, daysLeft: null };
  const left = period - daysSince;
  return { status: left <= period * DUE_SOON_SHARE ? "due_soon" : "on_track", daysSince, daysOverdue: null, daysLeft: left };
}

export const PROJECT_LIFECYCLES = ["active", "paused", "complete"] as const;
export type ProjectLifecycle = (typeof PROJECT_LIFECYCLES)[number];
export const LIFECYCLE_LABELS: Record<ProjectLifecycle, string> = { active: "Active", paused: "Paused", complete: "Complete" };

/** "ollieos" is text kept in OllieOS itself: pasted, uploaded or saved by Claude, with no link. */
export const DOC_LOCATIONS = ["dropbox", "gdrive", "claude_project", "other", "ollieos"] as const;
export type DocLocation = (typeof DOC_LOCATIONS)[number];
export const DOC_LOCATION_LABELS: Record<DocLocation, string> = {
  dropbox: "Dropbox",
  gdrive: "Google Drive",
  claude_project: "Claude project",
  other: "Other",
  ollieos: "Kept in OllieOS",
};

/** Part M: where a product is. Kept in step with the product_state enum in lib/db. */
export const PRODUCT_STATES = ["live", "pilot", "in_development", "retired"] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];
export const PRODUCT_STATE_LABELS: Record<ProductState, string> = { live: "Live", pilot: "Pilot", in_development: "In development", retired: "Retired" };

/** Part M: where a playbook is; only In use ones reach AI. Kept in step with the playbook_state enum in lib/db. */
export const PLAYBOOK_STATES = ["draft", "in_use", "retired"] as const;
export type PlaybookState = (typeof PLAYBOOK_STATES)[number];
export const PLAYBOOK_STATE_LABELS: Record<PlaybookState, string> = { draft: "Draft", in_use: "In use", retired: "Retired" };
/** Most steps a playbook may have */
export const PLAYBOOK_STEPS_MAX = 40;

/** Longest a rule may be (feature 07). */
export const RULE_MAX = 400;

/**
 * Labelled relationships between people, organisations and projects (build plan 13, Part G).
 * Stored on links, read "from <label> to". Kept in step with the relationship enum in lib/db.
 */
export const RELATIONSHIPS = [
  "reports_to",
  "works_with",
  "advises",
  "introduced_by",
  "investor_in",
  "customer_of",
  "supplier_to",
  "partner_of",
  "competitor_of",
  "part_of",
  "depends_on",
  "blocked_by",
  "related_to",
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** Read from the "from" end: "Sam reports to Alex". */
export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  reports_to: "reports to",
  works_with: "works with",
  advises: "advises",
  introduced_by: "was introduced by",
  investor_in: "invests in",
  customer_of: "is a customer of",
  supplier_to: "supplies",
  partner_of: "partners with",
  competitor_of: "competes with",
  part_of: "is part of",
  depends_on: "depends on",
  blocked_by: "is blocked by",
  related_to: "is related to",
};

/** Read from the "to" end: "Alex manages Sam". The same words for two-way relationships. */
export const RELATIONSHIP_INVERSE: Record<Relationship, string> = {
  reports_to: "manages",
  works_with: "works with",
  advises: "is advised by",
  introduced_by: "introduced",
  investor_in: "is backed by",
  customer_of: "has as a customer",
  supplier_to: "is supplied by",
  partner_of: "partners with",
  competitor_of: "competes with",
  part_of: "includes",
  depends_on: "is needed by",
  blocked_by: "is blocking",
  related_to: "is related to",
};

/** Two-way relationships read the same from either end. */
export const SYMMETRIC_RELATIONSHIPS: readonly Relationship[] = ["works_with", "partner_of", "competitor_of", "related_to"];

/** What each relationship is called in a picker, as a phrase that starts with a capital. */
export const RELATIONSHIP_OPTIONS: Record<Relationship, string> = {
  reports_to: "Reports to",
  works_with: "Works with",
  advises: "Advises",
  introduced_by: "Was introduced by",
  investor_in: "Invests in",
  customer_of: "Is a customer of",
  supplier_to: "Supplies",
  partner_of: "Partners with",
  competitor_of: "Competes with",
  part_of: "Is part of",
  depends_on: "Depends on",
  blocked_by: "Is blocked by",
  related_to: "Is related to",
};
