// Experimental video-input analysis: the phone's small analysis copy is
// uploaded once through the resumable upload store, then handed to the Gemini
// Files API with the same API key that will analyze it.
import crypto from 'node:crypto';

const FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-z0-9-]+$/i;
export const isGeminiFileUri = value => FILE_URI.test(String(value || ''));
export const geminiVideoMime = value => ['video/mp4', 'video/webm'].includes(String(value || '').toLowerCase())
  ? String(value).toLowerCase() : 'video/mp4';

export function createGeminiVideoFiles({ GoogleGenAI, uploads, now = Date.now,
  pollMs = 3000, maxWaitMs = 6 * 60 * 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const ready = new Map();
  const pending = new Map();
  const keyHash = apiKey => crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);

  async function prepare({ apiKey, uploadId, mimeType, signal }) {
    if (!apiKey) throw Object.assign(new Error('Gemini API anahtarı bulunamadı.'), { status: 503, code: 'GEMINI_NOT_CONFIGURED' });
    const source = await uploads.source(String(uploadId || ''));
    const cacheKey = `${keyHash(apiKey)}:${source.hash}`;
    const cached = ready.get(cacheKey);
    // Gemini keeps uploaded files for 48 hours; reuse well inside that window.
    if (cached && cached.expiresAt > now() + 60 * 60 * 1000) return cached.value;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const work = (async () => {
      const ai = new GoogleGenAI({ apiKey });
      let file = await ai.files.upload({ file: source.path,
        config: { mimeType: geminiVideoMime(mimeType), displayName: `videoquest-${source.hash.slice(0, 12)}`, abortSignal: signal } });
      const started = now();
      while (file.state === 'PROCESSING' || file.state === 'STATE_UNSPECIFIED' || !file.state) {
        if (now() - started > maxWaitMs) throw Object.assign(new Error('Google videoyu zamanında işleyemedi.'), { status: 504, code: 'GEMINI_VIDEO_PROCESSING_TIMEOUT' });
        signal?.throwIfAborted();
        await sleep(pollMs);
        file = await ai.files.get({ name: file.name });
      }
      if (file.state !== 'ACTIVE' || !isGeminiFileUri(file.uri)) {
        throw Object.assign(new Error('Google videoyu kabul etmedi.'), { status: 422, code: 'GEMINI_VIDEO_REJECTED', fileState: file.state });
      }
      const value = { fileUri: file.uri, mimeType: geminiVideoMime(file.mimeType || mimeType), name: file.name };
      ready.set(cacheKey, { value, expiresAt: now() + 46 * 60 * 60 * 1000 });
      return value;
    })().finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, work);
    return work;
  }
  return { prepare };
}

// Gemini may report times relative to the clip start; analysis needs absolute
// source seconds. Shift only when every action clearly sits in clip time.
export function absoluteClipTimes(actions = [], chunkStart = 0, chunkEnd = 0) {
  const start = Number(chunkStart) || 0, span = Math.max(0, Number(chunkEnd) - start);
  if (start < 5 || !Array.isArray(actions) || !actions.length) return actions;
  const timed = actions.filter(action => Number.isFinite(Number(action?.startTime)));
  if (!timed.length) return actions;
  const relative = timed.every(action => Number(action.startTime) < start - 1 &&
    Number(action.endTime ?? action.startTime) <= span + 2);
  if (!relative) return actions;
  const fields = ['startTime', 'endTime', 'loopStartTime', 'loopEndTime', 'positionStartTime', 'positionEndTime',
    'adultSceneStartTime', 'adultSceneEndTime', 'postSceneTime', 'outcomeStartTime', 'outcomeEndTime'];
  return actions.map(action => {
    const next = { ...action };
    for (const field of fields) if (Number.isFinite(Number(next[field])) && Number(next[field]) > 0) next[field] = Number(next[field]) + start;
    if (Array.isArray(next.verifiedSubsequences)) next.verifiedSubsequences = next.verifiedSubsequences.map(row => ({
      ...row, startTime: Number(row.startTime) + start, endTime: Number(row.endTime) + start }));
    return next;
  });
}
