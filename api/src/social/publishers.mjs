// Publisher interface: { publish(post) -> Promise<{ externalId }> }.
// `post` is { id, platform, kind, content, media, idempotencyKey }. Credentials are NEVER part of it (S7): a real adapter
// fetches its OAuth token from the secrets manager at call time. Real platform adapters are out of scope for this phase.

export class PublisherNotConfiguredError extends Error {
  constructor(platform = "this platform") {
    super(`No publisher is configured for ${platform}`);
    this.code = "publisher_not_configured";
  }
}

// Always refuses. `configured: false` lets the service refuse BEFORE claiming a post, so an unconfigured platform
// leaves approved posts approved instead of burning them.
export const notConfiguredPublisher = Object.freeze({
  configured: false,
  async publish(post) {
    throw new PublisherNotConfiguredError(post?.platform);
  },
});

// Test double. Records every call. Options: { delayMs, externalId(post) }. Use failNext(error) to script one failure.
export function fakePublisher({ delayMs = 0, externalId } = {}) {
  const calls = [];
  const failures = [];
  let n = 0;
  return {
    calls,
    failNext(err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    },
    async publish(post) {
      calls.push(structuredClone(post));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const f = failures.shift();
      if (f) throw f;
      n += 1;
      return { externalId: externalId ? externalId(post) : `fake-${post.platform}-${n}` };
    },
  };
}
