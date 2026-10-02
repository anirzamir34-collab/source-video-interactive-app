import { MediaError, redactMediaSecrets } from './errors.js';

function retryAfter(response, now) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(header) - now());
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// A fresh body factory keeps multipart streams reusable on a bounded retry.
export function createMediaRequest({ fetchImpl = globalThis.fetch, timeoutMs = 120000, maxRetries = 3,
  random = Math.random, sleep = wait, now = Date.now, secrets = [], onRequest = () => {}, onRetry = () => {} } = {}) {
  return async function request(url, { method = 'GET', headers = {}, body, bodyFactory, signal,
    responseType = 'json', retries = maxRetries, requestTimeoutMs = timeoutMs } = {}) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new MediaError('PROVIDER_TIMEOUT', 'Ses sağlayıcısının yanıt süresi doldu.', { retryable: true })), requestTimeoutMs);
      let delay = 0;
      try {
        onRequest({ url, method, attempt });
        const response = await fetchImpl(url, { method, headers, body: bodyFactory ? await bodyFactory() : body, signal: controller.signal });
        if (!response.ok) {
          const details = redactMediaSecrets(await response.text().catch(() => ''), secrets);
          const canRetry = response.status === 429 || response.status >= 500;
          delay = retryAfter(response, now);
          throw new MediaError(`PROVIDER_HTTP_${response.status}`, `Sağlayıcı HTTP ${response.status}: ${details}`, {
            status: response.status, retryable: canRetry,
          });
        }
        if (responseType === 'response') return response;
        if (responseType === 'buffer') return Buffer.from(await response.arrayBuffer());
        let result;
        try { result = await response.json(); }
        catch { throw new MediaError('PROVIDER_INVALID_RESPONSE', 'Sağlayıcı HTTP 200 yanıtı geçerli JSON içermiyor.'); }
        if (result === null || typeof result !== 'object') throw new MediaError('PROVIDER_INVALID_RESPONSE', 'Sağlayıcı geçerli bir JSON sonucu döndürmedi.');
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        last = error instanceof MediaError ? error : new MediaError(
          controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
          controller.signal.aborted ? 'Sağlayıcı isteği zaman aşımına uğradı.' : 'Sağlayıcıya bağlantı kesildi.',
          { retryable: true, cause: error },
        );
        if (!last.retryable || attempt === retries) throw last;
        delay = Math.max(delay, Math.min(30000, 600 * 2 ** attempt + Math.floor(random() * 500)));
        if (delay > 60000) throw new MediaError('PROVIDER_RATE_LIMIT_WAIT', 'Sağlayıcı uzun süre bekleme istiyor. İşlem daha sonra sürdürülebilir.', { retryable: true });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
      onRetry({ attempt: attempt + 1, code: last.code, delay });
      await sleep(delay, signal);
    }
    throw last;
  };
}
