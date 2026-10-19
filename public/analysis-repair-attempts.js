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
  const blocked = attempts.find(item => item.reason === 'GEMINI_CONTENT_RESTRICTED');
  if (blocked) return { skip: 'skipped_previous_rejection', reason: blocked.reason,
    httpStatus: blocked.httpStatus || null };
  const empty = attempts.filter(item => item.reason === 'GEMINI_NO_VERIFIED_EVENTS');
  if (empty.some(item => item.samplingStrategy === 'shifted')) {
    return { skip: 'skipped_previous_empty', reason: 'GEMINI_NO_VERIFIED_EVENTS',
      httpStatus: empty.find(item => item.samplingStrategy === 'shifted')?.httpStatus || null };
  }
  return { samplingStrategy: empty.length ? 'shifted' : 'baseline' };
}

export function appendSavedGapRepairHistory(analysis, model, promptVersion, validatorVersion, results) {
  const old = savedGapRepairHistory(analysis);
  const added = (Array.isArray(results) ? results : [])
    .filter(item => !String(item.outcome || '').startsWith('skipped_'))
    .map(item => ({ ...item, model, promptVersion, validatorVersion,
      samplingStrategy: item.samplingStrategy || 'baseline' }));
  return [...old, ...added].slice(-120);
}
