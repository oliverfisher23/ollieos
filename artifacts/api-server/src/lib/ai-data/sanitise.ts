import { parseRef } from "@workspace/shared";
import { visibleRefs, type AiScope } from "./scope";

function collect(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) value.forEach((v) => collect(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "ref" && typeof v === "string" && parseRef(v)) out.add(v);
      else collect(v, out);
    }
  }
}

function strip(value: unknown, ok: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => !(v && typeof v === "object" && isBlocked(v as Record<string, unknown>, ok))).map((v) => strip(v, ok));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && isBlocked(v as Record<string, unknown>, ok) ? null : strip(v, ok);
    }
    return out;
  }
  return value;
}

function isBlocked(obj: Record<string, unknown>, ok: Set<string>): boolean {
  return typeof obj.ref === "string" && !!parseRef(obj.ref) && !ok.has(obj.ref);
}

/**
 * The second check from build plan section 6, step 4: walks a response, and any object whose
 * `ref` this scope cannot see is removed from arrays or replaced with null. The SQL filter
 * should already have left these out; this catches a wrong join.
 */
export async function sanitiseOutput<T>(scope: AiScope, value: T): Promise<T> {
  const refs = new Set<string>();
  collect(value, refs);
  if (!refs.size) return value;
  const ok = await visibleRefs(scope, [...refs]);
  if (ok.size === refs.size) return value;
  return strip(value, ok) as T;
}
