// Only explicit failed intervals authorize a repair request. Ordinary quiet
// moments between actions are not evidence that an analysis was skipped.
export function repairableAnalysisGaps(analysis, duration) {
  const length = Number(duration);
  if (!Number.isFinite(length) || length <= 0) return [];
  return (Array.isArray(analysis?.analysisGaps) ? analysis.analysisGaps : [])
    .map(gap => ({ ...gap, startTime: Number(gap?.startTime), endTime: Number(gap?.endTime) }))
    .filter(gap => Number.isFinite(gap.startTime) && Number.isFinite(gap.endTime) &&
      gap.startTime >= 0 && gap.endTime <= length + 0.1 && gap.endTime > gap.startTime)
    .sort((a, b) => a.startTime - b.startTime);
}

// A saved-game repair is always a deliberate user action. Return declared missing
// intervals, including provider-restricted ones, without fabricating coverage.
// The UI confirms paid retries for previously restricted intervals explicitly.
export function retryableAnalysisGaps(analysis, duration) {
  return repairableAnalysisGaps(analysis, duration);
}

export function mergeRepairedAnalysis(analysis, repairs, duration) {
  const originalGaps = repairableAnalysisGaps(analysis, duration);
  const existing = analysis.actions || [];
  const added = [];
  const unresolved = [];
  let resolved = 0;
  for (const { gap, result } of repairs) {
    if (!originalGaps.some(item => item.startTime === gap.startTime && item.endTime === gap.endTime)) {
      throw new Error('Analiz dışındaki bir aralık yenilenemez.');
    }
    if (!result?.available) { unresolved.push(gap); continue; }
    const remaining = repairedRemainingGaps(result.analysisGaps, gap);
    unresolved.push(...remaining);
    if (!remaining.length) resolved++;
    for (const action of result.actions || []) {
      const start = Number(action.startTime), end = Number(action.endTime);
      if (action.sourceVerified !== true || !Number.isFinite(start) || !Number.isFinite(end) ||
          start < gap.startTime - 0.05 || end > gap.endTime + 0.05 || end <= start ||
          remaining.some(item => start < item.endTime && end > item.startTime) ||
          existing.some(item => start < Number(item.endTime) && end > Number(item.startTime)) ||
          added.some(item => start < Number(item.endTime) && end > Number(item.startTime))) continue;
      added.push(action);
    }
  }
  const attempted = new Set(repairs.map(item => `${item.gap.startTime}:${item.gap.endTime}`));
  unresolved.push(...originalGaps.filter(gap => !attempted.has(`${gap.startTime}:${gap.endTime}`)));
  const replacedWarnings = repairs.filter(item => item.result?.available).map(({ gap }) =>
    Number.isInteger(gap.chunkIndex)
      ? `Bölüm ${gap.chunkIndex + 1} (${Number(gap.startTime).toFixed(1)}–${Number(gap.endTime).toFixed(1)} sn) `
      : '');
  const warnings = (analysis.warnings || []).filter(warning =>
    !replacedWarnings.some(prefix => prefix && typeof warning === 'string' && warning.startsWith(prefix)));
  for (const { gap, result } of repairs) {
    if (!result?.available) continue;
    for (const remaining of result.analysisGaps || []) {
      warnings.push(`Aralık ${Number(remaining.startTime).toFixed(1)}–${Number(remaining.endTime).toFixed(1)} sn hâlâ doğrulanmadı; seçenek üretilmedi.`);
    }
    warnings.push(...(result.warnings || []));
  }
  return { ...analysis,
    actions: [...existing, ...added].sort((a, b) => Number(a.startTime) - Number(b.startTime)),
    analysisGaps: unresolved.sort((a, b) => a.startTime - b.startTime),
    partial: unresolved.length > 0,
    repairedGapCount: Number(analysis.repairedGapCount || 0) + resolved,
    warnings
  };
}

// The still-missing parts the model reports for a repaired interval. Models
// sometimes write them in seconds relative to the interval or slightly past
// its edges; those are moved into the interval instead of failing the whole
// save. An entry that cannot be placed keeps the whole interval missing, so
// nothing unverified is ever marked complete.
export function repairedRemainingGaps(rows, gap) {
  const start = Number(gap.startTime), end = Number(gap.endTime), span = end - start;
  const out = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    let from = Number(item?.startTime), to = Number(item?.endTime);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [{ ...gap }];
    if (from < start - 0.05 && to <= span + 0.05) { from += start; to += start; }
    from = Math.max(start, from); to = Math.min(end, to);
    if (to - from < 0.05) {
      if (Number(item.endTime) < start - 0.05 || Number(item.startTime) > end + 0.05) continue;
      return [{ ...gap }];
    }
    out.push({ ...item, startTime: from, endTime: to });
  }
  return out;
}
