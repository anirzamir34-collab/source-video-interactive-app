import { parseModelJson } from './model-json.js';
import { geminiQuotaFailure } from './gemini-quota.js';

// Shared transport/coverage rules. Missing provider data is never an action.
export function storyboardFailureReason(error) {
  const code = String(error?.code || '');
  if (/^(?:GEMINI_|MODEL_)/.test(code)) return code;
  // The SDK's HTTP deadline rejects as AbortError, without "timeout" in its
  // message. Treat it as a provider wait, never as malformed image evidence.
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return 'GEMINI_TEMPORARILY_UNAVAILABLE';
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const details = `${code} ${String(error?.message || error || '')}`;
  if (/PROHIBITED_CONTENT|\bSAFETY\b|BLOCKLIST|GEMINI_CONTENT_RESTRICTED/i.test(details)) return 'GEMINI_CONTENT_RESTRICTED';
  const quota = geminiQuotaFailure(error);
  if (quota) return quota.reason;
  if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(details)) return 'GEMINI_AUTH_ERROR';
  if (status === 404 || /NOT_FOUND|model.*not found/i.test(details)) return 'GEMINI_MODEL_UNAVAILABLE';
  if (status === 400) return 'GEMINI_INVALID_REQUEST';
  if ([500, 502, 503, 504].includes(status) || /502|503|504|UNAVAILABLE|high demand|fetch failed|timeout|timed out|ECONNRESET|ETIMEDOUT|network|socket/i.test(details)) return 'GEMINI_TEMPORARILY_UNAVAILABLE';
  if (/GEMINI_EMPTY_JSON_RESPONSE/i.test(details)) return 'GEMINI_EMPTY_RESPONSE';
  if (/Unexpected end of JSON input|Unexpected token|not valid JSON|GEMINI_INVALID_JSON/i.test(details)) return 'GEMINI_INVALID_JSON';
  return 'GEMINI_STORYBOARD_ERROR';
}

// Keep provider refusal telemetry free of the submitted video, prompt, and
// generated content. Different block origins require different diagnoses.
const PROVIDER_BLOCK_REASONS = new Set([
  'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'IMAGE_SAFETY', 'RECITATION'
]);
const PROVIDER_SAFETY_CATEGORIES = new Set([
  'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY'
]);
const safeBlockReason = value => {
  const code = String(value || '').trim().toUpperCase();
  return PROVIDER_BLOCK_REASONS.has(code) ? code : null;
};

function responseError(code, safetyDiagnostic = null) {
  return Object.assign(new Error(code), { code, ...(safetyDiagnostic ? { safetyDiagnostic } : {}) });
}

export function parseStoryboardResponse(response) {
  const promptBlockReason = safeBlockReason(response?.promptFeedback?.blockReason);
  const candidateFinishReason = safeBlockReason(response?.candidates?.[0]?.finishReason);
  if (promptBlockReason || candidateFinishReason) {
    const ratings = [
      ...(Array.isArray(response?.promptFeedback?.safetyRatings) ? response.promptFeedback.safetyRatings : []),
      ...(Array.isArray(response?.candidates?.[0]?.safetyRatings) ? response.candidates[0].safetyRatings : [])
    ];
    const blockedCategories = [...new Set(ratings
      .filter(rating => rating?.blocked === true)
      .map(rating => String(rating?.category || '').toUpperCase())
      .filter(category => PROVIDER_SAFETY_CATEGORIES.has(category)))];
    throw responseError('GEMINI_CONTENT_RESTRICTED', {
      origin: promptBlockReason ? 'prompt_feedback' : 'candidate_finish',
      promptBlockReason, candidateFinishReason, blockedCategories
    });
  }
  const raw = String(response?.text || '').trim();
  if (!raw) throw responseError('GEMINI_EMPTY_RESPONSE');
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = parseModelJson(raw); }
  catch {
    if (/\b(?:I|we)\s+(?:cannot|can't|can’t|am unable|are unable)\b|\b(?:request|prompt|content|images?|material)\b.{0,180}\b(?:not allowed|cannot|can't|unable|prohibited|policy|policies|restricted)\b/is.test(raw)) {
      throw responseError('GEMINI_CONTENT_RESTRICTED', { origin: 'model_text_refusal',
        promptBlockReason: null, candidateFinishReason: null, blockedCategories: [] });
    }
    // A prose response is not a truncated JSON document. Repeating or cropping
    // the same material cannot turn it into verified structured evidence.
    // A short, completed-but-broken JSON reply (Argon does this on material
    // it will not describe) failed identically on every retry and split,
    // costing minutes per chapter. Only a long or length-truncated reply is
    // worth repeating.
    const finish = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
    const shortCompleted = raw.length < 1500 && finish === 'STOP';
    throw responseError(/^[{\[]/.test(json) && !shortCompleted ? 'GEMINI_INVALID_JSON' : 'MODEL_UNSTRUCTURED_RESPONSE');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.actions)) {
    throw responseError('GEMINI_INVALID_JSON');
  }
  if (parsed.available === false) throw responseError('MODEL_UNSTRUCTURED_RESPONSE');
  return parsed;
}

export function isTerminalStoryboardFailure(error) {
  return ['GEMINI_CONTENT_RESTRICTED', 'GEMINI_NO_VERIFIED_EVENTS', 'MODEL_UNSTRUCTURED_RESPONSE', 'GEMINI_QUOTA_OR_CREDITS',
    'GEMINI_CREDITS_DEPLETED', 'GEMINI_RATE_LIMITED', 'GEMINI_DAILY_LIMIT',
    'GEMINI_AUTH_ERROR', 'GEMINI_MODEL_UNAVAILABLE', 'GEMINI_INVALID_REQUEST']
    .includes(storyboardFailureReason(error));
}

export async function generateStoryboardWithRetry(generate, {
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)), onRetry = () => {}
} = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try { return parseStoryboardResponse(await generate()); }
    catch (error) {
      const reason = storyboardFailureReason(error);
      const retryable = ['GEMINI_TEMPORARILY_UNAVAILABLE', 'GEMINI_EMPTY_RESPONSE', 'GEMINI_INVALID_JSON'].includes(reason);
      if (!retryable || isTerminalStoryboardFailure(error) || attempt === 2) throw error;
      onRetry(reason, attempt, error);
      await wait(attempt * 1800);
    }
  }
}

export function canContinuePastChunkFailure(failure) {
  return ['GEMINI_CONTENT_RESTRICTED', 'MODEL_UNSTRUCTURED_RESPONSE', 'CHUNK_ANALYSIS_GAP',
    'GEMINI_EMPTY_RESPONSE', 'GEMINI_INVALID_JSON', 'SECOND_PASS_REVIEW_FAILED']
    .includes(failure?.reason);
}

export function chunkGapResult(failure, chunkIndex, startTime, endTime) {
  const reason = failure?.reason || 'CHUNK_ANALYSIS_GAP';
  const detail = reason === 'GEMINI_CONTENT_RESTRICTED'
    ? 'Gemini içerik kısıtlaması nedeniyle bu bölümü analiz etmedi; seçenek üretilmedi.'
    : 'okunamadı; bu aralık için seçenek üretilmedi.';
  return {
    available: false, actions: [], chunkIndex, chunkStart: startTime, chunkEnd: endTime,
    retryable: failure?.retryable !== false,
    reason,
    analysisGaps: [{ chunkIndex, startTime, endTime, reason }],
    warnings: [`Bölüm ${chunkIndex + 1} (${startTime.toFixed(1)}–${endTime.toFixed(1)} sn) ${detail}`]
  };
}

export function hasDeclaredPartialCoverage(input) {
  const expected = Number(input.expectedChunkCount);
  const completed = Number(input.chunkCount);
  const gaps = input.analysisGaps;
  if (input.partial !== true || !Number.isInteger(expected) || expected < 1 ||
      !Number.isInteger(completed) || completed < 0 || completed >= expected ||
      Number(input.processedChunkCount) !== expected || !Array.isArray(gaps) || !gaps.length) return false;
  const indices = new Set();
  for (const gap of gaps) {
    if (!Number.isInteger(gap.chunkIndex) || gap.chunkIndex < 0 || gap.chunkIndex >= expected ||
        !Number.isFinite(gap.startTime) || !Number.isFinite(gap.endTime) ||
        gap.startTime < 0 || gap.endTime <= gap.startTime || gap.endTime > Number(input.videoDuration) ||
        indices.has(gap.chunkIndex)) return false;
    indices.add(gap.chunkIndex);
  }
  return completed + indices.size === expected;
}
