import pg from "pg";
import { pgAdapter, migrate } from "./db/adapters.mjs";
import { buildServer } from "./server.mjs";
import { sweepSlaBreaches } from "./repo/leads.mjs";
import { drainOutbox } from "./crm/outbox.mjs";
import { loadConfig } from "./config.mjs";
import { assembleDeps } from "./assemble.mjs";
import { purgeChats } from "./agent/privacy.mjs";

const cfg = loadConfig(process.env); // throws with every problem listed

pg.types.setTypeParser(20, (v) => Number(v)); // bigint ids as numbers (safe at this scale); consistent across endpoints
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
const db = pgAdapter(pool);
if (await migrate(db)) console.log("schema applied");

// Optional modules start only when configured (fail closed). Decisions live in assemble.mjs so they can be tested.
const { agentDeps, socialDeps, notes, warnings } = assembleDeps(cfg, { env: process.env });
for (const n of notes) console.log(n);
for (const w of warnings) console.warn(`WARNING: ${w}`);

const app = await buildServer({ db, staffToken: cfg.staffToken, logger: true, trustProxy: cfg.trustProxy, corsOrigins: cfg.corsOrigins, agentDeps, socialDeps });

let lastPurge = 0;
const tick = async () => {
  try {
    const breached = await sweepSlaBreaches(db);
    if (breached.length) app.log.warn({ count: breached.length }, "SLA breaches flagged");
    if (cfg.crm) {
      const r = await drainOutbox(db, { url: cfg.crm.url, secret: cfg.crm.secret });
      if (r.sent || r.retried || r.failed) app.log.info(r, "crm outbox");
    }
    if (app.agent) {
      await app.agent.expireStale();
      if (Date.now() - lastPurge > 6 * 3600_000) {
        const r = await purgeChats(db, new Date(), { days: cfg.chatRetentionDays });
        lastPurge = Date.now();
        if (r.messages || r.actions) app.log.info(r, "chat retention purge");
      }
    }
  } catch (e) {
    app.log.error({ err: { message: e.message } }, "background tick failed");
  }
};
const timer = setInterval(tick, 60_000);
timer.unref?.();
tick();

const shutdown = async () => { clearInterval(timer); await app.close(); await pool.end(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
