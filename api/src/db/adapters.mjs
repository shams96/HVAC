// Minimal DB interface used everywhere: { query(text, params) -> {rows}, exec(sql), transaction(fn(tx)) }.
// Production: pg Pool. Tests: PGlite (real Postgres in WASM). Same SQL in both.
import { readFileSync, readdirSync } from "node:fs";

const MIGRATIONS = new URL("./migrations/", import.meta.url);

export function pgAdapter(pool) {
  return {
    query: (text, params = []) => pool.query(text, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (t, p = []) => client.query(t, p) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export function pgliteAdapter(pg) {
  return {
    query: (text, params = []) => pg.query(text, params),
    exec: (sql) => pg.exec(sql),
    transaction: (fn) => pg.transaction((tx) => fn({ query: (t, p = []) => tx.query(t, p) })),
  };
}

// Applies src/db/migrations/NNN_name.sql in order, once each. Returns true if anything was applied.
// Each file runs as one multi-statement batch (implicitly atomic) and is then recorded.
export async function migrate(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  let applied = false;
  for (const f of files) {
    if (done.has(f)) continue;
    await db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    applied = true;
  }
  return applied;
}
