import { customType, pgEnum } from "drizzle-orm/pg-core";

export const taskKindEnum = pgEnum("task_kind", ["task", "promise"]);
export const taskStatusEnum = pgEnum("task_status", ["inbox", "now", "backlog", "waiting", "done", "noise", "dropped", "archived"]);
export const priorityEnum = pgEnum("priority", ["high", "medium", "low"]);
export const taskSourceEnum = pgEnum("task_source", ["email", "slack", "meeting", "quarterly", "manual", "session", "voice"]);
export const entityTypeEnum = pgEnum("entity_type", [
  "task",
  "project",
  "person",
  "organisation",
  "decision",
  "note",
  "fact",
  "activity",
  "calendar_event",
  "noise_rule",
  "suggestion",
  "fact_review",
  "goal",
  "document",
  "playbook",
  "meeting_brief",
  "digest",
  "review_item",
  "session",
  "strategy",
  "idea",
  /** Part M: a rule (what "playbook" meant before Part M) */
  "rule",
  /** Part M: a product */
  "product",
]);
export const activityKindEnum = pgEnum("activity_kind", ["email", "meeting", "slack", "note", "task"]);
export const captureOutcomeEnum = pgEnum("capture_outcome", ["created", "duplicate", "noise", "error"]);
export const noiseMatchEnum = pgEnum("noise_match", [
  "from_address_equals",
  "from_domain_equals",
  "slack_channel_equals",
  "title_contains",
]);
export const requestStatusEnum = pgEnum("request_status", ["pending", "approved", "declined", "expired"]);
export const clientKindEnum = pgEnum("client_kind", ["connector", "scheduled_task", "other"]);
export const clientAuthEnum = pgEnum("client_auth", ["oauth", "api_key", "internal"]);
/** Knowledge Inbox (feature 01). project, document, playbook and cadence are additions (build plan question 25). */
export const suggestionKindEnum = pgEnum("suggestion_kind", [
  "fact",
  "decision",
  "person",
  "organisation",
  "project",
  "summary_change",
  "document",
  "playbook",
  "cadence",
  "relationship",
  /** Part M: a rule; "playbook" is now a process (a new playbook, or a change to one) */
  "rule",
  "product",
]);
export const suggestionStatusEnum = pgEnum("suggestion_status", ["pending", "approved", "rejected", "merged"]);
/** Stale and conflicting facts (feature 02). */
/** The Review page (Assist Part C): look-back actions; Part D adds unanswered email. */
export const reviewItemKindEnum = pgEnum("review_item_kind", ["action", "no_reply"]);
export const reviewItemStateEnum = pgEnum("review_item_state", ["pending", "accepted", "done", "dropped", "answered"]);
/** Part O adds "contradiction": an AI check found a card disagreeing with approved knowledge. */
export const reviewKindEnum = pgEnum("review_kind", ["stale", "conflict", "contradiction"]);
export const reviewStatusEnum = pgEnum("review_status", ["pending", "resolved"]);
/** Fixed list of fact attributes (build plan question 42); null means a general fact. */
/** Part T (section 19): renewal_date, contract_value and account_health, for client organisations. */
export const FACT_ATTRIBUTES = ["job_title", "organisation", "status", "next_step", "decision_date", "renewal_date", "contract_value", "account_health"] as const;
export const factAttributeEnum = pgEnum("fact_attribute", FACT_ATTRIBUTES);
/** Relationship cadence (feature 05). "none" keeps a person off the cadence page. */
export const CADENCES = ["weekly", "fortnightly", "monthly", "two_monthly", "quarterly", "none"] as const;
export const cadenceEnum = pgEnum("cadence", CADENCES);
/** Separate from the free-text project status (build plan question 38). */
export const PROJECT_LIFECYCLES = ["active", "paused", "complete"] as const;
export const projectLifecycleEnum = pgEnum("project_lifecycle", PROJECT_LIFECYCLES);
/** Where a document lives (feature 06). */
export const DOC_LOCATIONS = ["dropbox", "gdrive", "claude_project", "other", "ollieos"] as const;
export const docLocationEnum = pgEnum("doc_location", DOC_LOCATIONS);
/** Part M: where a product is. Kept in step with PRODUCT_STATES in lib/shared. */
export const PRODUCT_STATES = ["live", "pilot", "in_development", "retired"] as const;
export const productStateEnum = pgEnum("product_state", PRODUCT_STATES);
/** Who a product is mainly for. Kept in step with PRODUCT_USERS in lib/shared. */
export const PRODUCT_USERS = ["students", "employers", "universities", "colleges", "schools"] as const;
export const productUserEnum = pgEnum("product_user", PRODUCT_USERS);
/** The parts of the business. Kept in step with BUSINESS_FUNCTIONS in lib/shared. */
export const BUSINESS_FUNCTIONS = ["delivery", "product", "sales", "marketing"] as const;
export const businessFunctionEnum = pgEnum("business_function", BUSINESS_FUNCTIONS);
/** Part M: where a playbook is; only In use ones reach AI. Kept in step with PLAYBOOK_STATES in lib/shared. */
export const PLAYBOOK_STATES = ["draft", "in_use", "retired"] as const;
export const playbookStateEnum = pgEnum("playbook_state", PLAYBOOK_STATES);
export const oauthTokenKindEnum = pgEnum("oauth_token_kind", ["access", "refresh"]);

/** Postgres full-text search vector. Always a generated column. */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
/** Labelled relationships on links (Part G). Kept in step with RELATIONSHIPS in lib/shared. */
export const RELATIONSHIP_KINDS = [
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
  /** Part N: a person who decides on a project, product or organisation */
  "decides_on",
] as const;
export const relationshipEnum = pgEnum("relationship", RELATIONSHIP_KINDS);
