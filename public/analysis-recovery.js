// Shared transport/coverage rules. Missing provider data is never an action.
export function storyboardFailureReason(error) {
  const code = String(error?.code || '');
  if (/^(?:GEMINI_|MODEL_)/.test(code)) return code;
  const details = `${code} ${String(error?.message || error || '')}`;
  if (/PROHIBITED_CONTENT|\bSAFETY\b|BLOCKLIST|GEMINI_CONTENT_RESTRICTED/i.test(details)) return 'GEMINI_CONTENT_RESTRICTED';
  if (/RESOURCE_EXHAUSTED|429|quota|credit/i.test(details)) return 'GEMINI_QUOTA_OR_CREDITS';
  if (/503|UNAVAILABLE|high demand/i.test(details)) return 'GEMINI_TEMPORARILY_UNAVAILABLE';
  if (/GEMINI_EMPTY_JSON_RESPONSE/i.test(details)) return 'GEMINI_EMPTY_RESPONSE';
  if (/Unexpected end of JSON input|Unexpected token|not valid JSON|GEMINI_INVALID_JSON/i.test(details)) return 'GEMINI_INVALID_JSON';
  return 'GEMINI_STORYBOARD_ERROR';
}

function responseError(code) {
  return Object.assign(new Error(code), { code });
}

export function parseStoryboardResponse(response) {
  const finish = [response?.candidates?.[0]?.finishReason, response?.promptFeedback?.blockReason].filter(Boolean).join(' ');
  if (/SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY|RECITATION/i.test(finish)) {
    throw responseError('GEMINI_CONTENT_RESTRICTED');
  }
  const raw = String(response?.text || '').trim();
  if (!raw) throw responseError('GEMINI_EMPTY_RESPONSE');
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(json); }
  catch {
    if (/\b(?:I|we)\s+(?:cannot|can't|can’t|am unable|are unable)\b|\b(?:request|prompt|content|images?|material)\b.{0,180}\b(?:not allowed|cannot|can't|unable|prohibited|policy|policies|restricted)\b/is.test(raw)) {
      throw responseError('GEMINI_CONTENT_RESTRICTED');
    }
    // A prose response is not a truncated JSON document. Repeating or cropping
    // the same material cannot turn it into verified structured evidence.
    throw responseError(/^[{\[]/.test(json) ? 'GEMINI_INVALID_JSON' : 'MODEL_UNSTRUCTURED_RESPONSE');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.actions)) {
    throw responseError('GEMINI_INVALID_JSON');
  }
  if (parsed.available === false) throw responseError('MODEL_UNSTRUCTURED_RESPONSE');
  return parsed;
}

export function isTerminalStoryboardFailure(error) {
  return ['GEMINI_CONTENT_RESTRICTED', 'MODEL_UNSTRUCTURED_RESPONSE', 'GEMINI_QUOTA_OR_CREDITS']
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
      onRetry(reason, attempt);
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
  return {
    available: false, actions: [], chunkIndex, chunkStart: startTime, chunkEnd: endTime,
    retryable: failure?.retryable !== false,
    reason: failure?.reason || 'CHUNK_ANALYSIS_GAP',
    analysisGaps: [{ chunkIndex, startTime, endTime, reason: failure?.reason || 'CHUNK_ANALYSIS_GAP' }],
    warnings: [`Bölüm ${chunkIndex + 1} (${startTime.toFixed(1)}–${endTime.toFixed(1)} sn) okunamadı; bu aralık için seçenek üretilmedi.`]
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
