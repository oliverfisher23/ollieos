import { customType, pgEnum } from "drizzle-orm/pg-core";

export const taskKindEnum = pgEnum("task_kind", ["task", "promise"]);
export const taskStatusEnum = pgEnum("task_status", ["inbox", "now", "backlog", "waiting", "done", "noise"]);
export const priorityEnum = pgEnum("priority", ["high", "medium", "low"]);
export const taskSourceEnum = pgEnum("task_source", ["email", "slack", "meeting", "quarterly", "manual"]);
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
export const oauthTokenKindEnum = pgEnum("oauth_token_kind", ["access", "refresh"]);

/** Postgres full-text search vector. Always a generated column. */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
