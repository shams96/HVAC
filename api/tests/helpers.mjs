import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter, migrate } from "../src/db/adapters.mjs";

export async function newDb() {
  const pg = new PGlite();
  const db = pgliteAdapter(pg);
  await migrate(db);
  return { db, close: () => pg.close() };
}

export const T0 = new Date("2026-03-02T15:00:00Z");
export const minutes = (m, base = T0) => new Date(base.getTime() + m * 60_000);

export async function seedRoutes(db) {
  await db.query("INSERT INTO routing_rules (zip, service_line, branch_id, assignee_group) VALUES ('00001', '*', 'branch-a', 'dispatch'), ('00001', 'install', 'branch-a', 'sales')");
}

export const b2c = (o = {}) => ({
  type: "B2C", channel: "form", name: "Sample Person", phone: "(415) 555-0100", email: "sample@example.org",
  zip: "00001", serviceLine: "repair", emergency: false, consents: [], details: {}, source: "test", ...o,
});
