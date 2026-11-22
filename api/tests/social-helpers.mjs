import { newDb, T0 } from "./helpers.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";
import { buildServer } from "../src/server.mjs";
import { fakePublisher, recordOfficialReview } from "../src/social/routes.mjs";

export const TOKEN = "t".repeat(40);
export const auth = { authorization: `Bearer ${TOKEN}` };
export const alice = { type: "user", id: "alice" };
export const bob = { type: "user", id: "bob" };
export const carol = { type: "user", id: "carol" };
export const bot = { type: "agent", id: "social-agent" };
export const PLATFORMS = ["gbp", "facebook", "instagram", "youtube"];
export const GOOD = "FIXTURE: seasonal tune-ups are $129. Call (415) 555-0100 to book.";

export async function setup({ publishers, catalog, staffToken = TOKEN, publishTimeoutMs } = {}) {
  const { db, close } = await newDb();
  const pubs = publishers ?? Object.fromEntries(PLATFORMS.map((p) => [p, fakePublisher()]));
  let clock = T0;
  const app = await buildServer({ db, staffToken, now: () => clock, socialDeps: { catalog: catalog ?? fixtureCatalog(), publishers: pubs, publishTimeoutMs } });
  const call = async (method, url, payload, headers = auth) => {
    const r = await app.inject({ method, url: `/api/staff/social${url}`, payload, headers });
    let json = null;
    try { json = r.json(); } catch { /* not json */ }
    return { status: r.statusCode, json, raw: r };
  };
  const ctx = {
    db, app, pubs, call, setClock: (d) => (clock = d), clock: () => clock,
    close: async () => { await app.close(); await close(); },
    connect: async (platform = "gbp", actor = alice) => (await call("POST", "/connections", { platform, scope: ["post"], actor })).json?.connection,
    draft: async (o = {}) => (await call("POST", "/posts", { platform: "gbp", kind: "update", content: GOOD, actor: alice, ...o })).json?.post,
    pending: async (o = {}, by = alice) => { const p = await ctx.draft({ actor: by, ...o }); const r = await call("POST", `/posts/${p.id}/submit`, { actor: by }); if (r.status !== 200) throw new Error(`submit failed ${r.status} ${r.raw.body}`); return r.json.post; },
    approved: async (o = {}) => { const p = await ctx.pending(o, alice); const r = await call("POST", `/posts/${p.id}/approve`, { actor: bob }); if (r.status !== 200) throw new Error(`approve failed ${r.status} ${r.raw.body}`); return r.json.post; },
    officialReview: (o = {}) => recordOfficialReview(db, { source: "google", externalId: `ext-${Math.random().toString(36).slice(2)}`, rating: 5, body: "Great work, the technician was on time and fixed our heat the same day.", authorDisplay: "S. Example", sourceUrl: "https://www.google.com/maps/reviews/data=sample", ...o }, { now: T0 }),
    status: async (id) => (await db.query("SELECT status FROM social_posts WHERE id = $1", [id])).rows[0].status,
  };
  return ctx;
}
