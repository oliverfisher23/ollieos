import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  clientAuthEnum,
  clientKindEnum,
  entityTypeEnum,
  oauthTokenKindEnum,
  requestStatusEnum,
} from "./enums";

export const aiClientsTable = pgTable("ai_clients", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  kind: clientKindEnum("kind").notNull(),
  auth: clientAuthEnum("auth").notNull(),
  oauthClientId: text("oauth_client_id").unique(),
  redirectUris: text("redirect_uris").array(),
  scopes: text("scopes").array().notNull().default(sql`'{read,write}'::text[]`),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const accessRequestsTable = pgTable(
  "access_requests",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    clientId: integer("client_id")
      .notNull()
      .references(() => aiClientsTable.id),
    /** null until matched to a real item */
    entityType: entityTypeEnum("entity_type"),
    entityId: integer("entity_id"),
    /** What the AI asked for, as written */
    requestedName: text("requested_name").notNull(),
    reason: text("reason"),
    status: requestStatusEnum("status").notNull().default("pending"),
    /** Set to now + 1 hour on approval */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("access_requests_client_idx").on(t.clientId, t.status)],
);

/** OAuth 2.1 authorisation codes for the MCP connector. Stored as SHA-256 hashes only. */
export const oauthCodesTable = pgTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => aiClientsTable.id),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scopes: text("scopes").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/** OAuth access and refresh tokens. Stored as SHA-256 hashes only. */
export const oauthTokensTable = pgTable(
  "oauth_tokens",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    tokenHash: text("token_hash").notNull().unique(),
    kind: oauthTokenKindEnum("kind").notNull(),
    clientId: integer("client_id")
      .notNull()
      .references(() => aiClientsTable.id),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_tokens_client_idx").on(t.clientId)],
);

export type AiClient = typeof aiClientsTable.$inferSelect;
export type AccessRequest = typeof accessRequestsTable.$inferSelect;
