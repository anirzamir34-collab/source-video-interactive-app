// Share health checks without retaining a failed lookup or hiding deployments
// indefinitely. Cancellation belongs to each caller, not the shared request.
export function createServerRevisionReader({ fetch = globalThis.fetch, now = Date.now, ttlMs = 30000 } = {}) {
  let cached = null, expiresAt = 0, pending = null;
  return async function readRevision({ signal } = {}) {
    signal?.throwIfAborted();
    if (cached && now() < expiresAt) return cached;
    if (!pending) {
      pending = (async () => {
        const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        const revision = response.ok ? (await response.json()).analysisRevision : null;
        if (typeof revision !== 'string' || !revision) return null;
        cached = revision;
        expiresAt = now() + ttlMs;
        return revision;
      })().finally(() => { pending = null; });
    }
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
}
