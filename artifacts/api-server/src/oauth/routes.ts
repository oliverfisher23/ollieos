import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import {
  approveConsent,
  clientById,
  clientByOauthId,
  consumeCode,
  issueTokens,
  registerClient,
  revokeToken,
  useRefreshToken,
} from "./store";
import {
  MCP_SCOPES,
  isAcceptableRedirect,
  isLoopback,
  mcpUrl,
  pkceMatches,
  publicOrigin,
  redirectMatches,
  signConsentRequest,
  verifyConsentRequest,
  withParams,
} from "./util";

/* ---------- Discovery (/.well-known) ---------- */

export const wellKnownRouter: IRouter = Router();

function protectedResource(req: Request, res: Response) {
  res.json({
    resource: mcpUrl(req),
    authorization_servers: [publicOrigin(req)],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "OllieOS",
  });
}

wellKnownRouter.get("/oauth-protected-resource/mcp", protectedResource);
wellKnownRouter.get("/oauth-protected-resource", protectedResource);

wellKnownRouter.get("/oauth-authorization-server", (req, res) => {
  const origin = publicOrigin(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES, "offline_access"],
  });
});

/* ---------- Public OAuth endpoints (/api/oauth) ---------- */

export const oauthRouter: IRouter = Router();

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });

/** Requested scopes, limited to the ones OllieOS has. offline_access is accepted; refresh tokens are always issued. */
function grantedScopes(scope: unknown): string[] {
  const asked = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
  const known = asked.filter((s) => (MCP_SCOPES as readonly string[]).includes(s));
  return known.length ? [...new Set(known)] : [...MCP_SCOPES];
}

oauthRouter.post("/register", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(isAcceptableRedirect)) {
    oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must list https URLs, or http URLs on localhost.");
    return;
  }
  const rawName = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 60) : "";
  const client = await registerClient({ name: rawName || "AI tool", redirectUris: [...new Set(uris as string[])] });
  res.status(201).set("Cache-Control", "no-store").json({
    client_id: client.oauthClientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: MCP_SCOPES.join(" "),
  });
});

function plainError(res: Response, message: string) {
  res.status(400).type("text/plain").send(`OllieOS could not start the connection: ${message}`);
}

oauthRouter.get("/authorize", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const client = await clientByOauthId(q.client_id);
  // Without a known client and a registered redirect, there is nowhere safe to send an error.
  if (!client) return plainError(res, "this tool is not registered. Remove the connector and add it again.");
  const redirectUri = q.redirect_uri ?? (client.redirectUris?.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectMatches(redirectUri, client.redirectUris ?? [])) return plainError(res, "the redirect address does not match the registered one.");

  const fail = (error: string, description: string) =>
    res.redirect(302, withParams(redirectUri, { error, error_description: description, state: q.state ?? null }));
  if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with S256 is required.");
  if (!/^[A-Za-z0-9\-_]{43,128}$/.test(q.code_challenge)) return fail("invalid_request", "code_challenge is not valid.");
  if (q.resource && q.resource.replace(/\/$/, "") !== mcpUrl(req)) return fail("invalid_target", "Unknown resource.");

  const request = signConsentRequest({
    c: client.id,
    redirectUri,
    codeChallenge: q.code_challenge,
    state: q.state ?? null,
    scopes: grantedScopes(q.scope),
  });
  res.redirect(302, `${publicOrigin(req)}/oauth/consent?request=${encodeURIComponent(request)}`);
});

oauthRouter.post("/token", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, string | undefined>;
  const client = await clientByOauthId(b.client_id);
  if (!client) return oauthError(res, 401, "invalid_client", "Unknown client_id.");

  if (b.grant_type === "authorization_code") {
    if (!b.code || !b.code_verifier) return oauthError(res, 400, "invalid_request", "code and code_verifier are required.");
    const code = await consumeCode(b.code);
    if (!code || code.clientId !== client.id) return oauthError(res, 400, "invalid_grant", "The code is invalid, used or expired.");
    if (b.redirect_uri && b.redirect_uri !== code.redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match.");
    if (!pkceMatches(b.code_verifier, code.codeChallenge)) return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
    if (client.revokedAt) return oauthError(res, 400, "invalid_grant", "This tool's access has been revoked.");
    return res.set("Cache-Control", "no-store").json(await issueTokens(client.id, code.scopes));
  }

  if (b.grant_type === "refresh_token") {
    if (!b.refresh_token) return oauthError(res, 400, "invalid_request", "refresh_token is required.");
    const old = await useRefreshToken(b.refresh_token);
    if (!old || old.clientId !== client.id || client.revokedAt) return oauthError(res, 400, "invalid_grant", "The refresh token is invalid, expired or revoked.");
    return res.set("Cache-Control", "no-store").json(await issueTokens(client.id, old.scopes));
  }

  return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
});

oauthRouter.post("/revoke", async (req, res) => {
  const token = (req.body ?? {}).token;
  if (typeof token === "string" && token) await revokeToken(token);
  res.status(200).json({});
});

/* ---------- The consent screen API (/api/oauth/consent, Ollie only) ---------- */

export const consentRouter: IRouter = Router();

async function loadConsent(token: unknown) {
  const request = verifyConsentRequest(token);
  if (!request) return null;
  const client = await clientById(request.c);
  if (!client || client.auth !== "oauth" || !redirectMatches(request.redirectUri, client.redirectUris ?? [])) return null;
  return { request, client };
}

consentRouter.get("/oauth/consent", async (req, res) => {
  const found = await loadConsent(req.query.request);
  if (!found) {
    res.status(400).json({ error: "This connection request has expired or is not valid. Start again from the tool." });
    return;
  }
  const { request, client } = found;
  const registered = client.redirectUris ?? [];
  res.json({
    clientName: client.name,
    redirectHost: new URL(request.redirectUri).host,
    loopbackOnly: registered.length > 0 && registered.every(isLoopback),
    scopes: request.scopes,
    reconnecting: !!client.revokedAt,
  });
});

consentRouter.post("/oauth/consent", async (req, res) => {
  const body = (req.body ?? {}) as { request?: string; approve?: boolean };
  const found = await loadConsent(body.request);
  if (!found) {
    res.status(400).json({ error: "This connection request has expired or is not valid. Start again from the tool." });
    return;
  }
  const { request, client } = found;
  if (body.approve !== true) {
    res.json({ redirectTo: withParams(request.redirectUri, { error: "access_denied", error_description: "Ollie declined the connection.", state: request.state }) });
    return;
  }
  const code = await approveConsent(client, { redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, scopes: request.scopes });
  logger.info({ clientId: client.id }, "OAuth consent approved");
  res.json({ redirectTo: withParams(request.redirectUri, { code, state: request.state }) });
});
