import { defineConfig } from "vitest/config";

/**
 * Tests run against a separate database, ollieos_test, on the same server as the dev database.
 * It is dropped and rebuilt from the Drizzle schema before every run, so Ollie's data is never touched.
 */
const base = process.env.DATABASE_URL;
if (!base) throw new Error("DATABASE_URL must be set to run the tests");
const url = new URL(base);
url.pathname = "/ollieos_test";
process.env.OLLIEOS_ADMIN_DATABASE_URL = base;
process.env.OLLIEOS_TEST_DATABASE_URL = url.toString();

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    env: { DATABASE_URL: url.toString(), NODE_ENV: "test", LOG_LEVEL: "silent" },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
