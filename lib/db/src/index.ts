import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Background work (scheduled preparation, connector checks, the knowledge reader) holds a few
  // connections for long stretches; 20 leaves pages plenty. Hosted Postgres allows far more.
  max: 20,
  // Hosted Postgres closes connections left idle for a few minutes. Close them first, so a request
  // never picks up one that is already dead, and keep live ones open with TCP keepalive.
  idleTimeoutMillis: 30_000,
  keepAlive: true,
  // Wait at most 15 seconds for a free connection rather than hanging the request.
  connectionTimeoutMillis: 15_000,
});

// A connection dropped by the database while idle emits "error" on the pool. Without a listener
// Node treats it as unhandled and the whole server crashes and restarts, failing every request in
// the meantime. The pool discards the broken connection and opens a new one when next needed.
pool.on("error", (err) => {
  console.warn(JSON.stringify({ level: "warn", msg: "Database connection dropped while idle; it will be replaced", err: err.message }));
});
export const db = drizzle(pool, { schema });

export * from "./schema";
