import { newDb, T0 } from "./helpers.mjs";
import { buildServer } from "../src/server.mjs";
import { createAgent } from "../src/agent/index.mjs";
import { fixtureCatalog } from "./catalog-fixture.mjs";

export const TOKEN = "t".repeat(40);

// Scripted fake LLM. `script` is an array of responses ({ text?, toolCalls? }) consumed one per call,
// or a function (request, callIndex) => response. Every request is recorded in `.calls`.
export function scriptedLlm(script) {
  const llm = {
    calls: [],
    async complete(req) {
      const i = llm.calls.length;
      llm.calls.push(JSON.parse(JSON.stringify(req)));
      const r = typeof script === "function" ? script(req, i) : script[Math.min(i, script.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return llm;
}

export const call = (name, args, id = `c-${name}`) => ({ id, name, args });
export const say = (text) => ({ text });
export const tools = (...calls) => ({ toolCalls: calls });

export const contact = { name: "Sample Person", phone: "(415) 555-0100", email: "sample@example.org" };
export const estimateArgs = (o = {}) => ({ serviceLine: "repair", zip: "00001", ...contact, ...o });

export async function setup({ script = [say("ok")], availability, catalog = fixtureCatalog(), agentOpts = {}, serverOpts = {} } = {}) {
  const { db, close } = await newDb();
  let clock = T0;
  const llm = scriptedLlm(script);
  const deps = { catalog, llm, availability, ...agentOpts };
  const agent = createAgent({ db, now: () => clock, ...deps });
  const app = await buildServer({ db, staffToken: TOKEN, now: () => clock, agentDeps: deps, ...serverOpts });
  return {
    db, llm, agent, app, catalog,
    setClock: (d) => (clock = d),
    close: async () => { await app.close(); await close(); },
  };
}

export const post = (app, url, payload, headers = {}) => app.inject({ method: "POST", url, payload, headers });
export async function startChat(app) {
  const r = await post(app, "/api/chat/start", {});
  return r.json().token;
}
export const send = (app, token, text) => post(app, "/api/chat/message", { token, text });
export const count = async (db, table, where = "true") => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
export const logEvents = async (db) => (await db.query("SELECT event, actor_type, data, conversation_id, action_id FROM agent_actions_log ORDER BY id")).rows;
// Script for tests with several conversations: propose on the first model call of a turn, answer once a tool result is present.
export const always = (toolCall, reply = "ok") => (req) => (req.messages.some((m) => m.role === "tool") ? say(reply) : tools(toolCall));
