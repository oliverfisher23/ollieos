/**
 * Errors an AI client can see. `not_found` is used for hidden items as well as missing ones,
 * so a reply never confirms that a hidden item exists (build plan section 5).
 */
export type AiErrorCode = "not_found" | "invalid_input" | "forbidden";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.code, message: this.message };
  }
}

export const notFound = (what: string) => new AiError("not_found", `${what} was not found in OllieOS.`);
export const invalid = (message: string) => new AiError("invalid_input", message);

/** Who a write is recorded against in audit_events. */
export interface Writer {
  actor: string;
  clientId: number;
}
