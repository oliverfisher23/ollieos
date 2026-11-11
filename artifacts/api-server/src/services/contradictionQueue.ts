/**
 * Runs the contradiction check (Part O) shortly after new cards arrive, so a card from Claude in
 * the evening is checked without waiting for the next connector check. Several cards in a row
 * share one run. Off under tests, which call the check directly with the model stood in.
 */
import { logger } from "../lib/logger";

let timer: ReturnType<typeof setTimeout> | null = null;

export function queueContradictionCheck(delayMs = 15_000) {
  if (process.env.NODE_ENV === "test" || timer) return;
  timer = setTimeout(() => {
    timer = null;
    import("./contradictions")
      .then((m) => m.checkNewCards())
      .catch((err) => logger.warn({ err }, "Contradiction check did not run"));
  }, delayMs);
  timer.unref?.();
}
