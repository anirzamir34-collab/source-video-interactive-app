import { choiceSurfaceForAction } from './choice-routing.js';
import { playableAdultPanelFamily } from './adult-gameplay.js';

export const EVIDENCE_VERSION = 2;
const text = value => typeof value === 'string' ? value.trim().slice(0, 500) : '';
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const confidence = value => Math.max(0, Math.min(1, numeric(value) || 0));
const strings = values => [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].sort();
const generic = /^(?:slow|fast|moderate|unclear|movement|position|tempo_change|rhythm|yavaş|hızlı|ritmik|yoğun|sert|derin|tempoyu yükselt|ritmik hareket et)$/iu;

/** Provider extension shared by server normalization and saved/legacy analysis.
 * No evidence is inferred from a title, audio, a neighbouring row or a UI phase.
 */
export function normalizeGameplayEvidence(value) {
  if (!value || value.version !== EVIDENCE_VERSION) return null;
  const visual = input => input?.verified === true && confidence(input.confidence) >= .6 && text(input.evidence)
    ? { verified: true, confidence: confidence(input.confidence), evidence: text(input.evidence),
        facts: Object.fromEntries(Object.entries(input.facts || {}).filter(([key, v]) =>
          /^(?:location|clothing|appearance|posture|sceneState)(?::[\w-]+)?$/.test(key) && text(v))
          .map(([key, v]) => [key, text(v)])) } : null;
  const action = value.action;
  return {
    version: EVIDENCE_VERSION, sourceActionId: text(value.sourceActionId),
    chapterId: text(value.chapterId), occurrenceId: text(value.occurrenceId),
    decisionId: text(value.decisionId), intent: text(value.intent),
    action: action?.verified === true && confidence(action.confidence) >= .6 && text(action.evidence) && text(action.label)
      ? { verified: true, key: text(action.key), label: text(action.label), evidence: text(action.evidence),
          confidence: confidence(action.confidence) } : null,
    before: visual(value.before), after: visual(value.after),
    provenance: text(value.provenance) || 'source-analysis'
  };
}

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
export function graphFingerprint(value) {
  const str = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) hash = Math.imul(hash ^ str.charCodeAt(i), 16777619);
  return `vq2-${(hash >>> 0).toString(16)}-${str.length}`;
}

/** @typedef {{id:string,startTime:number,endTime:number,sourceActionId:string,
 * cast:string[],before:Object,after:Object,confidence:number,provenance:string}} SourceClip */
/** Compile source observations once. UI and playback never mutate this graph. */
export function createGameplayGraph(analysis = {}) {
  const rejected = [], rows = [];
  for (const [index, action] of (analysis.actions || []).entries()) {
    const start = numeric(action.startTime), end = numeric(action.endTime);
    if (action.sourceVerified !== true || start === null || end === null || start < 0 || end <= start ||
        (analysis.videoDuration > 0 && end > analysis.videoDuration + .05) || confidence(action.confidence) < .6) {
      rejected.push({ id: text(action.actionId), reason: 'UNVERIFIED_SOURCE_INTERVAL' }); continue;
    }
    const evidence = normalizeGameplayEvidence(action.gameplayEvidence);
    const surface = choiceSurfaceForAction(action, { panelFamily: playableAdultPanelFamily(action) });
    const phase = surface === 'story' ? 'STORY' : surface === 'approach' ? 'APPROACH'
      : action.actionType === 'aftermath' ? 'AFTERMATH' : action.actionType === 'outcome' ? 'OUTCOME' : 'CORE';
    const cast = strings([action.subjectTrackId, action.partnerTrackId, ...(action.participantTrackIds || []),
      ...(action.involvedCharacterIds || [])]);
    const id = text(action.actionId || action.id) || `source-${index}`;
    const origin = evidence?.sourceActionId || text(action.sourceActionId || action.observedActionId) || id;
    const specific = evidence?.action;
    const legacyLabel = text(action.label);
    // Dialogue may supply the meaning of a narrative choice, but never the
    // observed physical action. These are separate evidence channels.
    const groundedStoryLabel = surface === 'story' && action.storyEvidenceLevel === 'fact' &&
      confidence(action.storyConfidence) >= .6
      ? text(action.narrativeChoiceLabel || action.label) : '';
    const label = specific?.label || groundedStoryLabel ||
      (evidence ? '' : !generic.test(legacyLabel.toLocaleLowerCase('tr-TR')) ? legacyLabel : '');
    const factsBefore = evidence?.before?.facts || {}, factsAfter = evidence?.after?.facts || {};
    rows.push({ id, origin, start, end, phase, surface, cast, evidence,
      // A narrative beat inside an encounter belongs to that encounter; the
      // choice surface must not create a separate chapter.
      chapterKey: evidence?.chapterId || text(action.adultSceneId),
      occurrence: evidence?.occurrenceId || text(action.positionOccurrenceId),
      group: text(action.positionId),
      semantic: specific ? JSON.stringify([specific.key, specific.label]) : (label ? `${text(action.actionType)}:${label}` : id),
      label: label || `Kaynak kesiti · ${start.toFixed(1)}–${end.toFixed(1)} sn`,
      abstained: !label,
      // A verified story label can be an intent; an unsupported generic title
      // cannot manufacture a narrative fork.
      intent: evidence?.intent || (action.storyEvidenceLevel === 'fact' && confidence(action.storyConfidence) >= .6
        ? text(action.narrativeChoiceLabel || action.narrativeReason) : ''),
      positionLabel: text(action.positionLabel),
      decisionId: evidence?.decisionId || '', before: factsBefore, after: factsAfter,
      confidence: specific?.confidence || confidence(action.confidence),
      provenance: evidence?.provenance || 'legacy-source-analysis',
      relationship: action.relationshipResolution === 'verified' && action.relationshipSubjectId && action.relationshipTargetId
        ? { from: text(action.relationshipSubjectId), to: text(action.relationshipTargetId),
            label: text(action.relationshipRoleLabel) } : null });
  }
  rows.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const chapters = [], choices = [], clips = [], stages = [];
  let chapter, stage, prior;
  const seen = new Set(), groups = new Map();
  for (const row of rows) {
    // The story/interaction surface is presentation, not a scene boundary.
    // Only source encounter identity, cast or a proven temporal gap may split it.
    const chapterKey = JSON.stringify([row.chapterKey, row.cast]);
    if (!chapter || chapter.key !== chapterKey || row.start - prior.end > 45) {
      chapter = { id: `chapter:${row.id}:${row.start}`, key: chapterKey, startTime: row.start, endTime: row.end,
        stageIds: [], cast: row.cast };
      chapters.push(chapter); stage = null;
    }
    chapter.endTime = Math.max(chapter.endTime, row.end);
    // One core stage contains verified position families and their movement
    // variants. Individual occurrences are nested choices, not new stages.
    const stageKey = JSON.stringify([row.phase, row.phase === 'STORY' ? row.decisionId : '']);
    if (!stage || stage.key !== stageKey) {
      stage = { id: `stage:${row.id}:${row.start}`, key: stageKey, chapterId: chapter.id, phase: row.phase,
        surface: row.surface, choiceIds: [], startTime: row.start, endTime: row.end };
      chapter.stageIds.push(stage.id); stages.push(stage);
    }
    stage.endTime = Math.max(stage.endTime, row.end);
    const clipKey = JSON.stringify([chapter.id, stage.id, row.phase, row.occurrence, row.origin, row.start, row.end, row.cast, row.semantic, row.before, row.after]);
    if (seen.has(clipKey)) { prior = row; continue; }
    seen.add(clipKey);
    const clip = { id: `clip:${clips.length}:${row.id}`, actionId: row.id, sourceActionId: row.origin,
      startTime: row.start, endTime: row.end, chapterId: chapter.id, stageId: stage.id, cast: row.cast,
      // Source and playback clocks are distinct. A long source observation
      // remains intact while its interactive preview has a bounded duration.
      previewEndTime: row.end - row.start > (row.surface === 'story' ? 16 : 28)
        ? Math.min(row.end, row.start + (row.surface === 'story' ? 12 : 14)) : row.end,
      before: row.before, after: row.after, confidence: row.confidence, provenance: row.provenance };
    clips.push(clip);
    // Missing occurrence/identity proof keeps records separate. Shared tempo is never proof.
    const key = JSON.stringify([stage.id, row.origin, row.occurrence || clip.id, row.cast, row.semantic, row.before, row.after]);
    let choice = groups.get(key);
    if (!choice) {
      choice = { id: `choice:${choices.length}:${row.id}`, chapterId: chapter.id, stageId: stage.id,
        phase: row.phase, surface: row.surface, label: row.label, intent: row.intent,
        positionId: row.group, positionLabel: row.positionLabel, occurrenceId: row.occurrence,
        abstained: row.abstained, confidence: row.confidence, cast: row.cast,
        relationship: row.relationship, clipIds: [] };
      groups.set(key, choice); choices.push(choice); stage.choiceIds.push(choice.id);
    }
    choice.clipIds.push(clip.id); prior = row;
  }
  const data = { version: EVIDENCE_VERSION, duration: Number(analysis.videoDuration) || Math.max(0, ...rows.map(r => r.end)),
    chapters, stages, choices, clips, rejected,
    characters: (analysis.storyContext?.characters || []).map(row => ({ id: text(row.participantTrackId || row.id),
      label: text(row.displayName || row.visualDescription), verified: row.evidenceLevel === 'fact' })) };
  return freeze({ ...data, fingerprint: graphFingerprint(data) });
}
