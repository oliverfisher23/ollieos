import { and, eq, gt, isNull } from "drizzle-orm";
import { aiClientsTable, db, oauthCodesTable, oauthTokensTable, type AiClient } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { ACCESS_TOKEN_SECONDS, CODE_SECONDS, REFRESH_TOKEN_SECONDS, randomToken, sha256 } from "./util";

export async function registerClient(input: { name: string; redirectUris: string[] }): Promise<AiClient> {
  const [row] = await db
    .insert(aiClientsTable)
    .values({
      name: input.name,
      kind: "connector",
      auth: "oauth",
      oauthClientId: crypto.randomUUID(),
      redirectUris: input.redirectUris,
      scopes: ["read", "write"],
      connectedAt: null,
    })
    .returning();
  await writeAudit(db, { actor: "oauth", action: "register_client", payload: { aiClientId: row.id, name: row.name, redirectUris: input.redirectUris } });
  return row;
}

export async function clientByOauthId(clientId: unknown): Promise<AiClient | null> {
  if (typeof clientId !== "string" || !clientId || clientId.length > 100) return null;
  const [row] = await db
    .select()
    .from(aiClientsTable)
    .where(and(eq(aiClientsTable.oauthClientId, clientId), eq(aiClientsTable.auth, "oauth")));
  return row ?? null;
}

export async function clientById(id: number): Promise<AiClient | null> {
  const [row] = await db.select().from(aiClientsTable).where(eq(aiClientsTable.id, id));
  return row ?? null;
}

/** Ollie approved the consent screen: issue a one-time code and mark the tool connected. */
export async function approveConsent(client: AiClient, input: { redirectUri: string; codeChallenge: string; scopes: string[] }): Promise<string> {
  const code = randomToken();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(oauthCodesTable).values({
      codeHash: sha256(code),
      clientId: client.id,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      expiresAt: new Date(now.getTime() + CODE_SECONDS * 1000),
    });
    const reconnecting = !client.connectedAt || !!client.revokedAt;
    await tx
      .update(aiClientsTable)
      .set({ revokedAt: null, ...(reconnecting ? { connectedAt: now } : {}) })
      .where(eq(aiClientsTable.id, client.id));
    await writeAudit(tx, { actor: "ollie", clientId: client.id, action: "authorise", payload: { scopes: input.scopes, redirectUri: input.redirectUri } });
  });
  return code;
}

/** Marks a code used and returns it, or null when it is unknown, used or expired. A code works once. */
export async function consumeCode(code: string) {
  const [row] = await db
    .update(oauthCodesTable)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodesTable.codeHash, sha256(code)), isNull(oauthCodesTable.usedAt), gt(oauthCodesTable.expiresAt, new Date())))
    .returning();
  return row ?? null;
}

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function issueTokens(clientId: number, scopes: string[]): Promise<IssuedTokens> {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  await db.insert(oauthTokensTable).values([
    { tokenHash: sha256(access), kind: "access", clientId, scopes, expiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000) },
    { tokenHash: sha256(refresh), kind: "refresh", clientId, scopes, expiresAt: new Date(now + REFRESH_TOKEN_SECONDS * 1000) },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: scopes.join(" ") };
}

/** Rotates a refresh token: the old one stops working the moment it is used. */
export async function useRefreshToken(token: string) {
  const [row] = await db
    .update(oauthTokensTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthTokensTable.tokenHash, sha256(token)),
        eq(oauthTokensTable.kind, "refresh"),
        isNull(oauthTokensTable.revokedAt),
        gt(oauthTokensTable.expiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

export async function revokeToken(token: string): Promise<void> {
  await db.update(oauthTokensTable).set({ revokedAt: new Date() }).where(and(eq(oauthTokensTable.tokenHash, sha256(token)), isNull(oauthTokensTable.revokedAt)));
}

/** The client behind a live access token, or null. Revoked clients have no live tokens. */
export async function clientForAccessToken(token: string): Promise<{ id: number; name: string } | null> {
  const [row] = await db
    .select({ id: aiClientsTable.id, name: aiClientsTable.name })
    .from(oauthTokensTable)
    .innerJoin(aiClientsTable, eq(aiClientsTable.id, oauthTokensTable.clientId))
    .where(
      and(
        eq(oauthTokensTable.tokenHash, sha256(token)),
        eq(oauthTokensTable.kind, "access"),
        isNull(oauthTokensTable.revokedAt),
        gt(oauthTokensTable.expiresAt, new Date()),
        isNull(aiClientsTable.revokedAt),
      ),
    );
  return row ?? null;
}
