import { execFileSync } from "node:child_process";
import path from "node:path";

/** Rebuilds ollieos_test from the current schema. Refuses to touch any other database. */
export default function setup() {
  const admin = process.env.OLLIEOS_ADMIN_DATABASE_URL!;
  const test = process.env.OLLIEOS_TEST_DATABASE_URL!;
  if (new URL(test).pathname !== "/ollieos_test") throw new Error("Refusing to reset a database that is not ollieos_test");
  execFileSync("psql", [admin, "-v", "ON_ERROR_STOP=1", "-q", "-c", "drop database if exists ollieos_test with (force)", "-c", "create database ollieos_test"], {
    stdio: "pipe",
  });
  execFileSync("pnpm", ["--filter", "@workspace/db", "run", "push-force"], {
    cwd: path.resolve(__dirname, "../../.."),
    env: { ...process.env, DATABASE_URL: test },
    stdio: "pipe",
  });
}
