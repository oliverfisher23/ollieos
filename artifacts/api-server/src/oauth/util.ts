import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export const MCP_SCOPES = ["read", "write"] as const;
export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
export const CODE_SECONDS = 5 * 60;
export const CONSENT_REQUEST_SECONDS = 10 * 60;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/**
 * The public origin this request came in on, for example https://ollieos.replit.app.
 * Behind Replit's proxy (trust proxy is on) req.protocol follows x-forwarded-proto.
 */
export function publicOrigin(req: Request): string {
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "localhost").split(",")[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = isLocal ? req.protocol : "https";
  return `${proto}://${host}`;
}

export const mcpUrl = (req: Request) => `${publicOrigin(req)}/mcp`;
export const resourceMetadataUrl = (req: Request) => `${publicOrigin(req)}/.well-known/oauth-protected-resource/mcp`;

/** PKCE S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Redirect URIs a client may register: https anywhere, or http on a loopback address. No fragments. */
export function isAcceptableRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || isLoopback(uri);
  } catch {
    return false;
  }
}

/**
 * Whether a redirect_uri on an authorise request matches a registered one.
 * Exact match, except loopback URIs, which match on any port (RFC 8252 section 7.3).
 */
export function redirectMatches(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopback(requested)) return false;
  const r = new URL(requested);
  return registered.some((reg) => {
    if (!isLoopback(reg)) return false;
    const g = new URL(reg);
    return g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
  });
}

/* ---------- The signed consent request ---------- */

export interface ConsentRequest {
  /** ai_clients.id */
  c: number;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scopes: string[];
  exp: number;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET must be set for OAuth");
  return s;
}

/** The authorise parameters, signed so the consent page cannot be pointed at a different redirect. */
export function signConsentRequest(req: Omit<ConsentRequest, "exp">): string {
  const body = Buffer.from(JSON.stringify({ ...req, exp: Math.floor(Date.now() / 1000) + CONSENT_REQUEST_SECONDS })).toString("base64url");
  const mac = createHmac("sha256", secret()).update(`consent.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyConsentRequest(token: unknown): ConsentRequest | null {
  if (typeof token !== "string" || token.length > 8000) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(`consent.${body}`).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConsentRequest;
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Adds query parameters to a redirect URI without disturbing the ones already on it. */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}
