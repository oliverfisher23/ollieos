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

/** GET a JSON body. `name` is the service name used in messages, for example "Gmail". */
export async function proxyJson(connector: string, name: string, path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await connectors().proxy(connector, path, { method: "GET" });
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
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 || res.status === 403) throw new ConnectorError(`${name} refused access. Reconnect it in Replit.`, true);
    if (res.status === 429) throw new ConnectorError(`${name} asked OllieOS to slow down. The next check will carry on.`);
    if (!res.ok) {
      const err = body.error as { message?: string } | string | undefined;
      const detail = typeof err === "string" ? err : err?.message;
      throw new ConnectorError(`${name} answered ${res.status}${detail ? ": " + detail : ""}`);
    }
    return body;
  }
}
