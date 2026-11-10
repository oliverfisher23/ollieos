/**
 * Calls a service through its Replit connector and turns failures into messages Ollie can act on.
 * 401 and 403 mean the connection needs reconnecting in Replit; 429 is retried once after the
 * wait the service asks for.
 */
import { ReplitConnectors } from "@replit/connectors-sdk";

export class ConnectorError extends Error {
  constructor(
    message: string,
    /** True when reconnecting the service in Replit is the likely fix. */
    readonly needsReconnect = false,
  ) {
    super(message);
  }
}

let client: ReplitConnectors | null = null;
const connectors = () => (client ??= new ReplitConnectors());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Services that can also be reached with a key saved in Replit Secrets, for when the Replit
 * connector cannot be set up. The key wins when it is present.
 */
const DIRECT_KEYS: Record<string, { env: string; base: string }> = {
  granola: { env: "GRANOLA_API_KEY", base: "https://public-api.granola.ai" },
};

function send(connector: string, path: string): Promise<Response> {
  const direct = DIRECT_KEYS[connector];
  const key = direct ? process.env[direct.env]?.trim() : undefined;
  if (direct && key) return fetch(direct.base + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  return connectors().proxy(connector, path, { method: "GET" });
}

/** GET through the connector, retrying one 429 and turning access problems into ConnectorErrors. */
async function call(connector: string, name: string, path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await send(connector, path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no .*connection/i.test(msg)) throw new ConnectorError(`${name} is not connected to OllieOS.`, true);
      throw new ConnectorError(`Could not reach ${name}: ${msg}`);
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 5, 30);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401) {
      const direct = DIRECT_KEYS[connector];
      if (direct && process.env[direct.env]?.trim()) throw new ConnectorError(`${name} refused the API key. Replace ${direct.env} in Replit Secrets.`, true);
      throw new ConnectorError(`${name} refused access. Reconnect it in Replit.`, true);
    }
    // The proxy answers 404 when the connection itself is missing, which is not about one item.
    if (res.status === 404 && /no \S+ connection found/i.test(await res.clone().text().catch(() => ""))) {
      throw new ConnectorError(`${name} is not connected to OllieOS. Connect it in Replit under Integrations.`, true);
    }
    if (res.status === 429) throw new ConnectorError(`${name} asked OllieOS to slow down. The next check will carry on.`);
    return res;
  }
}

async function failure(name: string, res: Response): Promise<ConnectorError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = body.error as { message?: string } | string | undefined;
  const detail = typeof err === "string" ? err : (err?.message ?? (typeof body.message === "string" ? body.message : undefined));
  if (res.status === 403) return new ConnectorError(`${name} refused access${detail ? ": " + detail : ""}. Reconnect it in Replit.`, true);
  return new ConnectorError(`${name} answered ${res.status}${detail ? ": " + detail : ""}`);
}

/** GET a JSON body. `name` is the service name used in messages, for example "Gmail". */
export async function proxyJson(connector: string, name: string, path: string): Promise<Record<string, unknown>> {
  const res = await call(connector, name, path);
  if (!res.ok) throw await failure(name, res);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** GET a JSON body, or null when the item is gone or this account cannot open it (404, or 403 on one file). */
export async function proxyJsonOrNull(connector: string, name: string, path: string): Promise<Record<string, unknown> | null> {
  const res = await call(connector, name, path);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(name, res);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * GET a text body, cut to `maxChars`. Null when the item is gone, cannot be exported or is too large
 * for the service to export (404, 403 or 400 for one file is about that file, not the connection).
 */
export async function proxyText(connector: string, name: string, path: string, maxChars: number): Promise<{ text: string; truncated: boolean } | null> {
  const res = await call(connector, name, path);
  if (res.status === 404 || res.status === 403 || res.status === 400) return null;
  if (!res.ok) throw await failure(name, res);
  const text = await res.text();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
