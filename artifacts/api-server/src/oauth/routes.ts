/**
 * OAuth 2.1 for the MCP connector, checked against Anthropic's connector auth docs:
 * protected-resource metadata, authorisation-server metadata, dynamic client registration,
 * authorisation code with PKCE (S256), refresh token rotation and token revocation.
 *
 * The authorise step hands over to the app's consent screen, which sits behind sign-in and the
 * allowlist, so only Ollie can connect a tool.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import {
  OAuthError,
  SCOPES,
  approveConsent,
  clientById,
  clientByOAuthId,
  exchangeCode,
  redirectMatches,
  refreshTokens,
  registerClient,
  revokeToken,
  signConsent,
  verifyConsent,
} from "./store";

/** The public origin, as Claude sees it (the Replit proxy sets x-forwarded-*). */
export function originOf(req: Request): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  const proto = first(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host = first(req.headers["x-forwarded-host"]) || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

export const MCP_PATH = "/mcp";

export function resourceMetadataUrl(req: Request): string {
  return `${originOf(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

function protectedResource(req: Request) {
  const origin = originOf(req);
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SCOPES],
    resource_name: "OllieOS",
  };
}

function authorizationServer(req: Request) {
  const origin = originOf(req);
  return {
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
    scopes_supported: [...SCOPES],
  };
}

/** Mounted at the root of the server: /.well-known/... */
export const wellKnownRouter: IRouter = Router();
wellKnownRouter.get(["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${MCP_PATH}`], (req, res) => {
  res.json(protectedResource(req));
});
wellKnownRouter.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/oauth"], (req, res) => {
  res.json(authorizationServer(req));
});

function oauthError(res: Response, err: unknown, next: NextFunction) {
  if (err instanceof OAuthError) {
    res.status(err.status).set("Cache-Control", "no-store").json({ error: err.code, error_description: err.message });
    return;
  }
  next(err);
}

function plainError(res: Response, message: string) {
  res.status(400).type("text/plain").send(`OllieOS could not start the connection: ${message}`);
}

function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Open routes, mounted at /api/oauth before the sign-in check. */
export const oauthPublicRouter: IRouter = Router();

oauthPublicRouter.post("/oauth/register", async (req, res, next) => {
  try {
    const out = await registerClient(req.body ?? {});
    res.status(201).set("Cache-Control", "no-store").json(out);
  } catch (err) {
    oauthError(res, err, next);
  }
});

oauthPublicRouter.get("/oauth/authorize", async (req, res, next) => {
  try {
    const q = req.query;
    const client = await clientByOAuthId(str(q.client_id) ?? "");
    if (!client) return plainError(res, "this tool is not registered. Remove the connector and add it again.");
    const redirectUri = str(q.redirect_uri) ?? "";
    // Without a trusted redirect there is nowhere safe to send an error, so show it here.
    if (!redirectUri || !redirectMatches(client.redirectUris ?? [], redirectUri)) return plainError(res, "the redirect address does not match.");
    const state = str(q.state) ?? null;
    const fail = (error: string, description: string) =>
      res.redirect(302, withParams(redirectUri, { error, error_description: description, state, iss: originOf(req) }));

    if (str(q.response_type) !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    const challenge = str(q.code_challenge);
    if (!challenge || str(q.code_challenge_method) !== "S256") return fail("invalid_request", "PKCE with S256 is required");
    const resource = str(q.resource);
    const expected = `${originOf(req)}${MCP_PATH}`;
    if (resource && resource.replace(/\/$/, "") !== expected && resource.replace(/\/$/, "") !== originOf(req)) {
      return fail("invalid_target", "Unknown resource");
    }
    const asked = (str(q.scope) ?? "").split(" ").filter(Boolean);
    const scopes = asked.length ? asked.filter((s) => (SCOPES as readonly string[]).includes(s)) : [...SCOPES];
    if (!scopes.length) return fail("invalid_scope", "Supported scopes are read and write");

    const signed = signConsent({ c: client.id, redirectUri, challenge, state, scopes });
    res.redirect(302, `/oauth/consent?req=${encodeURIComponent(signed)}`);
  } catch (err) {
    next(err);
  }
});

oauthPublicRouter.post("/oauth/token", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const grant = str(b.grant_type);
    const out =
      grant === "authorization_code"
        ? await exchangeCode({ code: str(b.code), redirectUri: str(b.redirect_uri), clientId: str(b.client_id), verifier: str(b.code_verifier) })
        : grant === "refresh_token"
          ? await refreshTokens({ refreshToken: str(b.refresh_token), clientId: str(b.client_id) })
          : (() => {
              throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
            })();
    res.set("Cache-Control", "no-store").set("Pragma", "no-cache").json(out);
  } catch (err) {
    oauthError(res, err, next);
  }
});

oauthPublicRouter.post("/oauth/revoke", async (req, res, next) => {
  try {
    await revokeToken(str((req.body ?? {}).token) ?? "");
    res.status(200).json({});
  } catch (err) {
    next(err);
  }
});

/** Consent API for the app's /oauth/consent screen. Mounted after the sign-in check. */
export const oauthConsentRouter: IRouter = Router();

const ConsentQuery = z.object({ req: z.string().min(1).max(4000) });
const ConsentBody = z.object({ req: z.string().min(1).max(4000), decision: z.enum(["approve", "deny"]) }).strict();

const EXPIRED = "This connection request has expired. Start connecting again from Claude.";

oauthConsentRouter.get(
  "/oauth/consent",
  handle(async (req, res) => {
    const parsed = verifyConsent(ConsentQuery.parse(req.query).req);
    const client = parsed ? await clientById(parsed.c) : null;
    if (!parsed || !client) {
      res.status(400).json({ error: EXPIRED });
      return;
    }
    res.json({
      clientName: client.name,
      redirectHost: new URL(parsed.redirectUri).host,
      scopes: parsed.scopes,
      reconnecting: client.revokedAt != null,
    });
  }),
);

oauthConsentRouter.post(
  "/oauth/consent",
  handle(async (req, res) => {
    const body = ConsentBody.parse(req.body ?? {});
    const parsed = verifyConsent(body.req);
    if (!parsed) {
      res.status(400).json({ error: EXPIRED });
      return;
    }
    const iss = originOf(req);
    if (body.decision === "deny") {
      res.json({ redirectTo: withParams(parsed.redirectUri, { error: "access_denied", error_description: "Ollie declined the connection", state: parsed.state, iss }) });
      return;
    }
    const code = await approveConsent(parsed);
    res.json({ redirectTo: withParams(parsed.redirectUri, { code, state: parsed.state, iss }) });
  }),
);
