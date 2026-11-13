/**
 * Calls a service through its Replit connector and turns failures into messages Ollie can act on.
 * 401 and 403 mean the connection needs reconnecting in Replit; 429 is retried once after the
 * wait the service asks for; a read that cannot reach the service is tried twice more.
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

/** Waits before each retry of a read that could not reach the service at all. */
const NETWORK_RETRIES = process.env.NODE_ENV === "test" ? [0, 0] : [2_000, 6_000];

/**
 * Services that can also be reached with a key saved in Replit Secrets, for when the Replit
 * connector cannot be set up. The key wins when it is present.
 */
const DIRECT_KEYS: Record<string, { env: string; base: string }> = {
  granola: { env: "GRANOLA_API_KEY", base: "https://public-api.granola.ai" },
};

interface Write {
  method: "POST" | "PUT";
  body: unknown;
}

/** A call to Gmail, Slack, Drive, Calendar or Granola that has not answered by now is abandoned. */
const CALL_TIMEOUT_MS = 60_000;

function send(connector: string, path: string, write?: Write): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CALL_TIMEOUT_MS / 1000} seconds`)), CALL_TIMEOUT_MS);
  });
  return Promise.race([sendNow(connector, path, write), timeout]).finally(() => clearTimeout(timer));
}

function sendNow(connector: string, path: string, write?: Write): Promise<Response> {
  const direct = DIRECT_KEYS[connector];
  const key = direct ? process.env[direct.env]?.trim() : undefined;
  if (direct && key) return fetch(direct.base + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (write) {
    return connectors().proxy(connector, path, { method: write.method, body: JSON.stringify(write.body), headers: { "Content-Type": "application/json" } });
  }
  return connectors().proxy(connector, path, { method: "GET" });
}

/** Calls through the connector, retrying one 429 and turning access problems into ConnectorErrors. */
async function call(connector: string, name: string, path: string, write?: Write): Promise<Response> {
  let retried429 = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await send(connector, path, write);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no .*connection/i.test(msg)) throw new ConnectorError(`${name} is not connected to OllieOS.`, true);
      // A dropped connection is usually brief: try a read twice more before giving up. Never repeat a
      // write, because the first may have landed (a second Gmail draft, say).
      if (!write && attempt < NETWORK_RETRIES.length) {
        await sleep(NETWORK_RETRIES[attempt]);
        continue;
      }
      throw new ConnectorError(`Could not reach ${name}: ${msg}`);
    }
    if (res.status === 429 && !retried429) {
      retried429 = true;
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

/** GET a file's bytes, or null when it is gone, cannot be opened or is larger than `maxBytes`. */
export async function proxyBytes(connector: string, name: string, path: string, maxBytes: number): Promise<Uint8Array | null> {
  const res = await call(connector, name, path);
  if (res.status === 404 || res.status === 403 || res.status === 400) return null;
  if (!res.ok) throw await failure(name, res);
  const size = Number(res.headers.get("content-length"));
  if (size && size > maxBytes) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > maxBytes ? null : buf;
}

/**
 * A read made with POST, as Dropbox's API does for every call. Null when Dropbox says the path is
 * not there (409 with a path error). OllieOS only ever calls Dropbox's read endpoints.
 */
export async function proxyReadPost(connector: string, name: string, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const res = await call(connector, name, path, { method: "POST", body });
  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    if (/not_found|path\/|malformed_path/.test(text)) return null;
    throw new ConnectorError(`${name} could not do that: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw await failure(name, res);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * POST or PUT a JSON body and read the JSON answer. Null when the item is gone (404), so a caller
 * updating something can fall back to creating it. Only used to save Gmail drafts; never to send.
 */
export async function proxyWriteJson(
  connector: string,
  name: string,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  const res = await call(connector, name, path, { method, body });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(name, res);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}
