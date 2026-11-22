// Where real platform adapters plug in. Each entry is a factory (env) => publisher | null, keyed by platform
// (gbp, facebook, instagram, youtube). NO real adapters exist yet: they need OAuth credentials, a platform app, and
// platform review, and none could be tested here. Until one is registered, that platform refuses to publish (503).
// Adapters must fetch their OAuth token from the secrets manager at call time; tokens never enter these tables (S7).
import { PLATFORMS } from "./policy.mjs";
import { notConfiguredPublisher } from "./publishers.mjs";

export const ADAPTERS = Object.freeze({});

export function buildPublishers(env = {}, adapters = ADAPTERS) {
  return Object.fromEntries(PLATFORMS.map((p) => {
    const made = adapters[p]?.(env) ?? null;
    return [p, made && typeof made.publish === "function" ? made : notConfiguredPublisher];
  }));
}

export const configuredPlatforms = (publishers) => PLATFORMS.filter((p) => publishers[p]?.configured !== false && typeof publishers[p]?.publish === "function");
