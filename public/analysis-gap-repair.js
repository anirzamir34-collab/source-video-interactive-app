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
    const remaining = (result.analysisGaps || []).map(item => ({ ...item,
      startTime: Number(item.startTime), endTime: Number(item.endTime) }));
    if (remaining.some(item => !Number.isFinite(item.startTime) || !Number.isFinite(item.endTime) ||
      item.endTime <= item.startTime || item.startTime < gap.startTime - 0.05 ||
      item.endTime > gap.endTime + 0.05)) throw new Error('Yeniden analiz edilen aralık tutarsız.');
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
  return { ...analysis,
    actions: [...existing, ...added].sort((a, b) => Number(a.startTime) - Number(b.startTime)),
    analysisGaps: unresolved.sort((a, b) => a.startTime - b.startTime),
    partial: unresolved.length > 0,
    repairedGapCount: Number(analysis.repairedGapCount || 0) + resolved,
    warnings: [...(analysis.warnings || []), ...repairs.flatMap(item => item.result?.warnings || [])]
  };
}


// Targeted re-analysis keeps original observations until verified source spans arrive.
export const SILENT_GAP_MIN_SECONDS = 15;
export const SILENT_GAP_WINDOW_SECONDS = 40;
export const LONG_POSITION_MIN_SECONDS = 14;
export const MAX_AUTO_REPAIR_REQUESTS = 8;
const finiteTime = value => typeof value === 'number' && Number.isFinite(value);
const sourceRow = action => action?.sourceVerified === true && finiteTime(action.startTime) &&
  finiteTime(action.endTime) && action.endTime > action.startTime;

export function findSilentGaps(actions, duration, {
  minSeconds = SILENT_GAP_MIN_SECONDS, windowSeconds = SILENT_GAP_WINDOW_SECONDS, tailIgnoreSeconds = 12
} = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const rows = (Array.isArray(actions) ? actions : []).filter(sourceRow)
    .map(x => [x.startTime, x.endTime]).sort((a, b) => a[0] - b[0]);
  const holes = [];
  let cursor = 0;
  for (const [start,end] of rows) {
    if (start - cursor >= minSeconds) holes.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (duration - cursor >= Math.max(minSeconds, tailIgnoreSeconds)) holes.push([cursor, duration]);
  const windows = [];
  for (const [start,end] of holes) {
    const count = Math.ceil((end-start)/windowSeconds);
    for (let i=0;i<count;i++) {
      windows.push({startTime:Math.round((start+i*(end-start)/count)*1000)/1000,
        endTime:Math.round((start+(i+1)*(end-start)/count)*1000)/1000,
        reason:'SILENT_GAP'});
    }
  }
  return windows;
}

export function findLongPositionRows(actions, {minSeconds = LONG_POSITION_MIN_SECONDS} = {}) {
  return (Array.isArray(actions) ? actions : []).filter(action =>
    sourceRow(action) && action.adultScene === true &&
    String(action.positionId || '').trim() &&
    String(action.choiceSurface || '') !== 'story' &&
    action.endTime - action.startTime >= minSeconds)
    .map(action => ({startTime:action.startTime,endTime:action.endTime,
      reason:'LONG_POSITION', actionId:String(action.actionId || ''),
      positionId:String(action.positionId),positionLabel:String(action.positionLabel || ''),
      positionOccurrenceId:String(action.positionOccurrenceId || '')}));
}
const overlapsSource = (a,b) => a.startTime < b.endTime - .05 && a.endTime > b.startTime + .05;
export function mergeSilentGapActions(existing, repairs) {
  const rows = [...(existing || [])];
  let added=0;
  for (const {gap,result} of repairs || []) {
    if (!result?.available || !Array.isArray(result.actions)) continue;
    for (const action of result.actions) {
      if (!sourceRow(action) || action.startTime < gap.startTime-.05 ||
          action.endTime > gap.endTime+.05 || rows.some(row => overlapsSource(row,action))) continue;
      rows.push(action); added++;
    }
  }
  return {actions:rows.sort((a,b)=>a.startTime-b.startTime),added};
}

// This is a destructive replacement, so insist on explicit visual evidence,
// consistent physical position, bounded times and at least two distinct actions.
// Merely marking a model output sourceVerified is insufficient.
export function refinePositionRow(actions,parent,refined) {
  if (!sourceRow(parent) || !Array.isArray(refined?.actions)) return {actions,replaced:false,sequences:0};
  const children = refined.actions.filter(action =>
    sourceRow(action) &&
    action.startTime >= parent.startTime-.05 && action.endTime <= parent.endTime+.05 &&
    action.gameplayEvidence?.version === 2 &&
    action.gameplayEvidence?.action?.verified === true &&
    Number(action.gameplayEvidence.action.confidence) >= .6 &&
    String(action.gameplayEvidence.action.evidence || '').trim() &&
    String(action.gameplayEvidence.action.key || '').trim() &&
    action.positionId === parent.positionId &&
    (action.choiceSurface || 'panel') === 'panel' &&
    (!parent.subjectTrackId || !action.subjectTrackId || parent.subjectTrackId === action.subjectTrackId) &&
    (!parent.partnerTrackId || !action.partnerTrackId || parent.partnerTrackId === action.partnerTrackId))
    .sort((a,b)=>a.startTime-b.startTime);
  const clean=[];
  for (const child of children) {
    if (clean.some(row => overlapsSource(row,child))) continue;
    clean.push(child);
  }
  const distinct = new Set(clean.map(row => row.gameplayEvidence.action.key));
  if (clean.length < 2 || distinct.size < 2) return {actions,replaced:false,sequences:clean.length};
  const occurrence = String(parent.positionOccurrenceId || '');
  const inherited = clean.map((child,index)=>({...child,
    adultScene:true, adultSceneId:parent.adultSceneId,
    adultSceneStartTime:parent.adultSceneStartTime,adultSceneEndTime:parent.adultSceneEndTime,
    positionId:parent.positionId,positionLabel:parent.positionLabel || child.positionLabel,
    positionOccurrenceId:occurrence || child.positionOccurrenceId,
    actionId:(parent.actionId || 'refined')+'-m'+(index+1)}));
  const rest=actions.filter(row=>row!==parent && row.actionId!==parent.actionId);
  return {actions:[...rest,...inherited].sort((a,b)=>a.startTime-b.startTime),
    replaced:true,sequences:inherited.length};
}
