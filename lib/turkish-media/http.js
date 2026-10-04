import { MediaError, redactMediaSecrets } from './errors.js';

function scribePermissionError(url, status, details, cause) {
  if (status !== 401 && status !== 403) return null;
  try {
    const address = new URL(url);
    const detail = JSON.parse(details)?.detail;
    if (address.origin === 'https://api.elevenlabs.io' && address.pathname === '/v1/speech-to-text' &&
        detail?.status === 'missing_permissions' && typeof detail.message === 'string' &&
        /\bspeech_to_text\b/.test(detail.message)) {
      return new MediaError('ELEVENLABS_STT_PERMISSION_MISSING',
        'ElevenLabs anahtarında Speech to Text (speech_to_text) izni yok. ElevenLabs API Keys bölümünde anahtarı düzenleyip Speech to Text erişimini aç, ardından yeniden dene.',
        { status, retryable: false, cause });
    }
  } catch { /* Other provider failures retain their original redacted details. */ }
  return null;
}

function alignmentPermissionError(url, status, details, cause) {
  if (![401, 403].includes(status)) return null;
  try {
    const address = new URL(url), detail = JSON.parse(details)?.detail;
    if (address.origin === 'https://api.elevenlabs.io' && address.pathname === '/v1/forced-alignment' &&
      detail?.status === 'missing_permissions' && /\bforced_alignment\b/.test(detail.message || ''))
      return new MediaError('ELEVENLABS_ALIGNMENT_PERMISSION_MISSING',
        'Bu ses için ek kelime hizalaması gerekiyor. ElevenLabs API Keys bölümünde anahtarın Forced Alignment (forced_alignment) iznini açıp yeniden dene. Hazır ses bölümleri yeniden kullanılacak.',
        { status, retryable: false, cause });
  } catch { /* Keep unknown failures unchanged. */ }
  return null;
}

function geminiProviderError(url, status, details, cause) {
  try {
    const address = new URL(url);
    if (address.hostname !== 'generativelanguage.googleapis.com') return null;
    const body = JSON.parse(details);
    const provider = body?.error || body;
    const message = String(provider?.message || details);
    const providerStatus = String(provider?.status || '');
    const normalized = `${providerStatus} ${message}`.toLowerCase();

    if (status === 402 && /prepayment|credit(?:s| balance)?|depleted|resource_exhausted/.test(normalized)) {
      return new MediaError('GEMINI_CREDITS_EXHAUSTED',
        'Gemini API kredisi tükendi. Sunucu Gemini bakiyesini yenile veya VideoQuest’te kendi Gemini API anahtarını girip yeniden dene.',
        { status, retryable: false, cause });
    }
    if (status === 429 && /resource_exhausted|quota|rate|limit/.test(normalized)) {
      return new MediaError('GEMINI_QUOTA_EXHAUSTED',
        'Gemini kota veya hız sınırına ulaştı. Kota yenilendiğinde yeniden dene ya da kullanılabilir başka bir Gemini API anahtarı gir.',
        { status, retryable: true, cause });
    }
    if ([400, 401].includes(status) && /api[_ ]?key.*(?:invalid|not valid)|invalid.*api[_ ]?key/.test(normalized)) {
      return new MediaError('GEMINI_KEY_INVALID',
        'Gemini API anahtarı geçersiz. VideoQuest’te geçerli bir Gemini API anahtarı girip yeniden dene.',
        { status, retryable: false, cause });
    }
    if (status === 403 && /permission|forbidden|denied/.test(normalized)) {
      return new MediaError('GEMINI_ACCESS_DENIED',
        'Gemini API anahtarının seçili modele erişim izni yok. Gemini proje/model izinlerini kontrol et veya başka bir anahtar kullan.',
        { status, retryable: false, cause });
    }
  } catch { /* Unrecognized Gemini errors keep the original provider details. */ }
  return null;
}

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
          const failure = new MediaError(`PROVIDER_HTTP_${response.status}`, `Sağlayıcı HTTP ${response.status}: ${details}`, {
            status: response.status, retryable: canRetry,
          });
          throw scribePermissionError(url, response.status, details, failure) ||
            alignmentPermissionError(url, response.status, details, failure) ||
            geminiProviderError(url, response.status, details, failure) || failure;
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
