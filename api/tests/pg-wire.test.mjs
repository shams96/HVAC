import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { pgAdapter, migrate } from "../src/db/adapters.mjs";
import { createLead, getLead } from "../src/repo/leads.mjs";
import { b2c, T0 } from "./helpers.mjs";

// Drives the production pg adapter over the real Postgres wire protocol (one connection: pglite-socket limit).
test("pg adapter over the wire: migrate, intake, rollback on error", async () => {
  const lite = new PGlite();
  const server = new PGLiteSocketServer({ db: lite, port: 54399, host: "127.0.0.1" });
  await server.start();
  const pool = new pg.Pool({ host: "127.0.0.1", port: 54399, user: "postgres", database: "postgres", max: 1, ssl: false });
  const db = pgAdapter(pool);
  try {
    assert.equal(await migrate(db), true);
    assert.equal(await migrate(db), false, "migrate is idempotent");
    const r = await createLead(db, b2c(), { now: T0 });
    assert.equal((await getLead(db, r.id)).events[0].event_type, "lead_created");
    await assert.rejects(db.transaction(async (tx) => {
      await tx.query("INSERT INTO accounts (name, kind) VALUES ('Rolled Back', 'commercial')");
      throw new Error("boom");
    }), /boom/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM accounts WHERE name = 'Rolled Back'")).rows[0].n, 0, "rolled back");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM leads")).rows[0].n, 1, "pool still usable after rollback");
  } finally {
    await pool.end();
    await server.stop();
    await lite.close();
  }
});
