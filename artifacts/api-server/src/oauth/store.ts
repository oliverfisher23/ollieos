/**
 * OAuth 2.1 storage for the MCP connector: registered clients, authorisation codes and tokens.
 * Codes and tokens are stored as SHA-256 hashes only, so a database leak gives nothing usable.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { aiClientsTable, db, oauthCodesTable, oauthTokensTable, type AiClient } from "@workspace/db";
import { writeAudit } from "../lib/audit";

export const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
/** How long the signed consent request stays valid while Ollie signs in. */
const CONSENT_TTL_MS = 15 * 60 * 1000;
export const SCOPES = ["read", "write"] as const;

export class OAuthError extends Error {
  constructor(
    public code: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "invalid_scope" | "invalid_redirect_uri" | "invalid_client_metadata",
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

/* ---------- Redirect URIs ---------- */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** HTTPS anywhere, or plain HTTP to a loopback address (Claude Code and Claude Desktop). */
export function acceptableRedirect(value: string): boolean {
  const u = parseUrl(value);
  if (!u || u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** Exact match, except that the port of a loopback address is ignored (RFC 8252 section 7.3). */
export function redirectMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  const g = parseUrl(given);
  if (!g || g.protocol !== "http:" || !LOOPBACK.has(g.hostname)) return false;
  return registered.some((r) => {
    const u = parseUrl(r);
    return !!u && u.protocol === "http:" && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
  });
}

/* ---------- Clients ---------- */

export interface RegisterInput {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
}

/** Dynamic client registration (RFC 7591). Clients are public and must use PKCE. */
export async function registerClient(input: RegisterInput) {
  const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length) throw new OAuthError("invalid_redirect_uri", "At least one redirect_uri is required");
  if (uris.length > 10 || uris.some((u) => u.length > 500 || !acceptableRedirect(u))) {
    throw new OAuthError("invalid_redirect_uri", "Redirect URIs must use https, or http to localhost");
  }
  const grants = Array.isArray(input.grant_types) ? input.grant_types : ["authorization_code", "refresh_token"];
  if (!grants.includes("authorization_code")) throw new OAuthError("invalid_client_metadata", "authorization_code must be allowed");

  // Registration is open by design, so cap how many unapproved clients can pile up.
  const [pending] = await db
    .select({ n: count() })
    .from(aiClientsTable)
    .where(and(eq(aiClientsTable.auth, "oauth"), isNull(aiClientsTable.connectedAt)));
  if ((pending?.n ?? 0) >= 50) {
    await db.execute(sql`
      delete from ai_clients c where c.auth = 'oauth' and c.connected_at is null
        and not exists (select 1 from oauth_codes o where o.client_id = c.id)
        and not exists (select 1 from oauth_tokens t where t.client_id = c.id)
        and not exists (select 1 from access_requests a where a.client_id = c.id)
        and not exists (select 1 from audit_events e where e.client_id = c.id)`);
  }

  const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 80) : "AI tool";
  const clientId = `ollieos-${token()}`;
  const [row] = await db
    .insert(aiClientsTable)
    .values({ name, kind: "connector", auth: "oauth", oauthClientId: clientId, redirectUris: uris, scopes: [...SCOPES] })
    .returning();
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: row.name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPES.join(" "),
  };
}

export async function clientByOAuthId(oauthClientId: string): Promise<AiClient | null> {
  if (!oauthClientId) return null;
  const [row] = await db.select().from(aiClientsTable).where(eq(aiClientsTable.oauthClientId, oauthClientId));
  return row ?? null;
}

export async function clientById(id: number): Promise<AiClient | null> {
  const [row] = await db.select().from(aiClientsTable).where(eq(aiClientsTable.id, id));
  return row ?? null;
}

/* ---------- Signed consent requests ---------- */

export interface ConsentRequest {
  /** ai_clients.id */
  c: number;
  redirectUri: string;
  challenge: string;
  state: string | null;
  scopes: string[];
  exp: number;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

export function signConsent(req: Omit<ConsentRequest, "exp">): string {
  const body = Buffer.from(JSON.stringify({ ...req, exp: Date.now() + CONSENT_TTL_MS })).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyConsent(value: string): ConsentRequest | null {
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConsentRequest;
    return parsed.exp > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

/** Ollie approved: issue a one-time code and mark the client connected. */
export async function approveConsent(req: ConsentRequest): Promise<string> {
  const code = token();
  await db.transaction(async (tx) => {
    const [client] = await tx.select().from(aiClientsTable).where(eq(aiClientsTable.id, req.c));
    if (!client) throw new OAuthError("invalid_client", "Unknown client");
    await tx.insert(oauthCodesTable).values({
      codeHash: sha256(code),
      clientId: req.c,
      redirectUri: req.redirectUri,
      codeChallenge: req.challenge,
      scopes: req.scopes,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    await tx
      .update(aiClientsTable)
      .set({ connectedAt: client.connectedAt ?? new Date(), revokedAt: null })
      .where(eq(aiClientsTable.id, req.c));
    await writeAudit(tx, {
      actor: "ollie",
      action: client.revokedAt ? "reconnect" : "connect",
      payload: { clientId: req.c, name: client.name, redirectHost: new URL(req.redirectUri).host },
    });
  });
  return code;
}

/* ---------- Tokens ---------- */

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issuePair(clientId: number, scopes: string[], tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<TokenResponse> {
  const access = token();
  const refresh = token();
  const now = Date.now();
  await tx.insert(oauthTokensTable).values([
    { tokenHash: sha256(access), kind: "access", clientId, scopes, expiresAt: new Date(now + ACCESS_TTL_SECONDS * 1000) },
    { tokenHash: sha256(refresh), kind: "refresh", clientId, scopes, expiresAt: new Date(now + REFRESH_TTL_MS) },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopes.join(" ") };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const hashed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const want = Buffer.from(challenge);
  return hashed.length === want.length && timingSafeEqual(hashed, want);
}

/** authorization_code grant with PKCE. A code works once. */
export async function exchangeCode(input: { code?: string; redirectUri?: string; clientId?: string; verifier?: string }): Promise<TokenResponse> {
  if (!input.code || !input.verifier || !input.redirectUri) throw new OAuthError("invalid_request", "code, redirect_uri and code_verifier are required");
  const client = input.clientId ? await clientByOAuthId(input.clientId) : null;
  // Claimed outside the transaction, so a failed attempt still uses the code up.
  const [used] = await db
    .update(oauthCodesTable)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodesTable.codeHash, sha256(input.code)), isNull(oauthCodesTable.usedAt), gt(oauthCodesTable.expiresAt, new Date())))
    .returning();
  if (!used) throw new OAuthError("invalid_grant", "The code is invalid, used or expired");
  if (client && client.id !== used.clientId) throw new OAuthError("invalid_grant", "The code was issued to another client");
  if (used.redirectUri !== input.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
  if (!pkceMatches(input.verifier, used.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE check failed");
  return db.transaction(async (tx) => {
    const [owner] = await tx.select().from(aiClientsTable).where(eq(aiClientsTable.id, used.clientId));
    if (!owner || owner.revokedAt) throw new OAuthError("invalid_grant", "This client has been revoked");
    return issuePair(used.clientId, used.scopes, tx);
  });
}

/** refresh_token grant. The old refresh token is revoked and a new pair issued (rotation). */
export async function refreshTokens(input: { refreshToken?: string; clientId?: string }): Promise<TokenResponse> {
  if (!input.refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
  const client = input.clientId ? await clientByOAuthId(input.clientId) : null;
  // Spent before any check, so a replayed or misused refresh token never works twice.
  const [old] = await db
    .update(oauthTokensTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthTokensTable.tokenHash, sha256(input.refreshToken)),
        eq(oauthTokensTable.kind, "refresh"),
        isNull(oauthTokensTable.revokedAt),
        gt(oauthTokensTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!old) throw new OAuthError("invalid_grant", "The refresh token is invalid, revoked or expired");
  if (client && client.id !== old.clientId) throw new OAuthError("invalid_grant", "The token was issued to another client");
  return db.transaction(async (tx) => {
    const [owner] = await tx.select().from(aiClientsTable).where(eq(aiClientsTable.id, old.clientId));
    if (!owner || owner.revokedAt) throw new OAuthError("invalid_grant", "This client has been revoked");
    return issuePair(old.clientId, old.scopes, tx);
  });
}

/** RFC 7009: revoking an unknown token is not an error. */
export async function revokeToken(value: string): Promise<void> {
  if (!value) return;
  await db.update(oauthTokensTable).set({ revokedAt: new Date() }).where(eq(oauthTokensTable.tokenHash, sha256(value)));
}

/** The client behind a live access token, or null. A revoked client's tokens stop working at once. */
export async function clientForAccessToken(value: string): Promise<AiClient | null> {
  if (!value) return null;
  const [row] = await db
    .select({ client: aiClientsTable })
    .from(oauthTokensTable)
    .innerJoin(aiClientsTable, eq(aiClientsTable.id, oauthTokensTable.clientId))
    .where(
      and(
        eq(oauthTokensTable.tokenHash, sha256(value)),
        eq(oauthTokensTable.kind, "access"),
        isNull(oauthTokensTable.revokedAt),
        gt(oauthTokensTable.expiresAt, new Date()),
        isNull(aiClientsTable.revokedAt),
      ),
    );
  return row?.client ?? null;
}

/** Revoking a connected tool: every token it holds stops working. */
export async function revokeClientTokens(clientId: number, conn: Pick<typeof db, "update"> = db): Promise<void> {
  await conn.update(oauthTokensTable).set({ revokedAt: new Date() }).where(and(eq(oauthTokensTable.clientId, clientId), isNull(oauthTokensTable.revokedAt)));
}
