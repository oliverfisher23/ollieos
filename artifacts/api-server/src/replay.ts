/**
 * Part X: the replay command. Runs the Gmail, Slack and Granola readers, as the code now stands,
 * against the test cases Ollie kept, so a changed prompt or model can be checked before it ships.
 *
 *   pnpm --filter @workspace/api-server run replay                 every reader with cases
 *   pnpm --filter @workspace/api-server run replay -- --agent gmail_sorter --model claude-sonnet-5-5
 *
 * Exits with 1 when any case fails. Replays make no tasks and keep no inputs.
 */
import { pool } from "@workspace/db";
import { listTestCases, replay, REPLAY_AGENTS } from "./services/evals";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const only = arg("agent");
  const model = arg("model");
  const cases = await listTestCases(only ?? undefined);
  const agents = (only ? [only] : REPLAY_AGENTS).filter((a) => cases.some((c) => c.agent === a));
  if (!agents.length) {
    console.log("No test cases to replay yet. Keep one from an Inbox item first.");
    return 0;
  }
  let failures = 0;
  for (const agent of agents) {
    const r = await replay(agent, { model }, "replay command");
    failures += r.failed.length;
    const prev = r.previous ? ` (last time ${r.previous.passed} of ${r.previous.total} on ${r.previous.model}, prompt ${r.previous.promptVersion})` : "";
    console.log(`${agent}: ${r.passed} of ${r.total} passed on ${r.model}, prompt ${r.promptVersion}${prev}`);
    for (const f of r.failed) console.log(`  failed #${f.caseId} ${f.title}: expected ${f.expected === "task" ? "a task" : "nothing"}, found ${f.got.length ? f.got.join("; ") : "nothing"}`);
  }
  return failures ? 1 : 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(2);
  });
