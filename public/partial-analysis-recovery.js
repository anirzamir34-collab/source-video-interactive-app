import { chunkGapResult } from './analysis-recovery.js';

// Quota exhaustion must not turn unexamined footage into invented actions.
// Mark every incomplete source chapter as a declared gap, so existing verified
// choices can be played and saved while paid analysis remains unavailable.
export function recoverVerifiedChunksOnCreditExhaustion({
  chunkResults, plan, timestamps, duration, framesPerSheet = 12
} = {}) {
  if (!Array.isArray(chunkResults) || !Array.isArray(plan) || !plan.length ||
      !Array.isArray(timestamps) || !Number.isFinite(duration) || duration <= 0) {
    return { recovered: false, completed: 0, gapCount: 0 };
  }
  const completed = chunkResults.filter(row => row?.available === true).length;
  if (!completed) return { recovered: false, completed: 0, gapCount: 0 };
  const replacements = [];
  for (let index = 0; index < plan.length; index++) {
    if (chunkResults[index]?.available === true || chunkResults[index]?.analysisGaps?.length) continue;
    const part = plan[index];
    const firstFrame = Number(part?.firstSheet) * framesPerSheet;
    const nextFrame = (Number(part?.firstSheet) + Number(part?.sheetCount)) * framesPerSheet;
    const start = index === 0 ? 0 : Number(timestamps[firstFrame] ?? NaN);
    const end = Number(timestamps[nextFrame] ?? duration);
    if (!Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end <= start || end > duration + 0.1) {
      return { recovered: false, completed, gapCount: 0 };
    }
    replacements.push({
      index, gap: chunkGapResult({ reason: 'GEMINI_CREDITS_DEPLETED', retryable: true },
        index, start, end)
    });
  }
  for (const { index, gap } of replacements) chunkResults[index] = gap;
  return {
    recovered: chunkResults.length >= plan.length &&
      plan.every((_, index) => chunkResults[index]?.available === true ||
        chunkResults[index]?.analysisGaps?.length),
    completed, gapCount: plan.length - completed
  };
}
