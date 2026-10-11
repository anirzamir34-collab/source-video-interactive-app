// One shared rate gate for actual Gemini generateContent attempts.
// Concurrency limits alone are not requests/minute limits. Keep this gate
// across successive video jobs so a key rotation cannot immediately flood the
// free translation tier with simultaneous requests.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createGeminiRequestPacer({ intervalMs = 6500, now = Date.now, sleep = wait } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new RangeError('Gemini request interval must be nonnegative.');
  let nextSlot = 0;
  let tail = Promise.resolve();

  function beforeRequest(signal) {
    let release;
    const predecessor = tail;
    tail = new Promise(resolve => { release = resolve; });
    return (async () => {
      await predecessor;
      try {
        if (signal?.aborted) throw signal.reason;
        const remaining = Math.max(0, nextSlot - now());
        if (remaining > 0) await sleep(remaining, signal);
        if (signal?.aborted) throw signal.reason;
        nextSlot = now() + intervalMs;
      } finally {
        release();
      }
    })();
  }

  return { beforeRequest };
}

export function isGeminiGenerationRequest(url, baseUrl) {
  return String(url).startsWith(String(baseUrl).replace(/\/$/, '') + '/models/') &&
    /:generateContent(?:\?|$)/.test(String(url));
}
