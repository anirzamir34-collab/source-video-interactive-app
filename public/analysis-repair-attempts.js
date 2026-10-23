// Keep the paid repair history when the latest saved-game report is replaced.
const matched = (item, gap, model, promptVersion, validatorVersion) =>
  item?.model === model && item?.promptVersion === promptVersion &&
  item?.validatorVersion === validatorVersion &&
  Number(item.startTime) === Number(gap.startTime) &&
  Number(item.endTime) === Number(gap.endTime);

export function savedGapRepairHistory(analysis = {}) {
  const history = Array.isArray(analysis.repairAttemptHistory) ? [...analysis.repairAttemptHistory] : [];
  const last = analysis.lastRepairAttempt;
  for (const item of Array.isArray(last?.results) ? last.results : []) {
    if (item.outcome === 'skipped_model_error') continue;
    // Older saves kept only the skipped report, losing the actual previous
    // rejection. Its reason is still evidence of a completed baseline attempt.
    if (item.outcome === 'skipped_previous_empty' &&
        item.reason !== 'GEMINI_NO_VERIFIED_EVENTS') continue;
    if (item.outcome === 'skipped_previous_rejection' &&
        item.reason !== 'GEMINI_CONTENT_RESTRICTED') continue;
    const entry = { ...item, model: last.model, promptVersion: last.promptVersion,
      validatorVersion: last.validatorVersion, samplingStrategy: item.samplingStrategy || 'baseline' };
    if (!history.some(old => matched(old, entry, entry.model, entry.promptVersion, entry.validatorVersion) &&
      old.samplingStrategy === entry.samplingStrategy && old.reason === entry.reason)) history.push(entry);
  }
  return history.slice(-120);
}

export function planSavedGapRepair(analysis, gap, model, promptVersion, validatorVersion) {
  const attempts = savedGapRepairHistory(analysis).filter(item =>
    matched(item, gap, model, promptVersion, validatorVersion));
  // Never silently skip an explicit user retry after two provider refusals.
  // Advance only when the previous request actually yielded a model response;
  // quota, network and model-access failures did not inspect the frames.
  const responded = attempts.filter(item =>
    ['GEMINI_CONTENT_RESTRICTED', 'GEMINI_NO_VERIFIED_EVENTS',
      'MODEL_UNSTRUCTURED_RESPONSE'].includes(item.reason) ||
    ['processed', 'partial'].includes(item.outcome));
  const used = new Set(responded.map(item => item.samplingStrategy || 'baseline'));
  let index = 0;
  const strategyAt = value => value === 0 ? 'baseline'
    : value === 1 ? 'shifted' : `alternate-${value}`;
  while (used.has(strategyAt(index))) index++;
  return { samplingStrategy: strategyAt(index) };
}

export function appendSavedGapRepairHistory(analysis, model, promptVersion, validatorVersion, results) {
  const old = savedGapRepairHistory(analysis);
  const added = (Array.isArray(results) ? results : [])
    .filter(item => !String(item.outcome || '').startsWith('skipped_'))
    .map(item => ({ ...item, model, promptVersion, validatorVersion,
      samplingStrategy: item.samplingStrategy || 'baseline' }));
  return [...old, ...added].slice(-120);
}
