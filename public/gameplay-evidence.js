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
    const routed = choiceSurfaceForAction(action, { panelFamily: playableAdultPanelFamily(action) });
    // The legacy scene preparer may use a transition as an approach entry.
    // In this graph an explicitly STORY-labelled observed body transition is
    // a separate panel interlude, never a narrative dialogue choice.
    const surface = action.actionType === 'body_transition' && routed === 'story' &&
      String(action.choiceSurfaceEvidence || '').trim() && Number(action.choiceSurfaceConfidence) >= .6
      ? 'panel' : routed;
    const phase = surface === 'story' ? 'STORY' : surface === 'approach' ? 'APPROACH'
      : action.actionType === 'aftermath' ? 'AFTERMATH' : action.actionType === 'outcome' ? 'OUTCOME'
        : action.actionType === 'body_transition' ? 'INTERLUDE' : 'CORE';
    const cast = strings([action.subjectTrackId, action.partnerTrackId, ...(action.participantTrackIds || []),
      ...(action.involvedCharacterIds || [])]);
    const id = text(action.actionId || action.id) || `source-${index}`;
    const origin = evidence?.sourceActionId || text(action.sourceActionId || action.observedActionId) || id;
    const specific = evidence?.action;
    const legacyLabel = text(action.label).replace(/^\[object Object\]$/i, '');
    const identityResolution = text(action.identityResolution) || 'unknown';
    const classificationReview = identityResolution === 'conflict' ||
      text(action.classificationReview) !== 'verified' ? 'needs_review' : 'verified';
    // Dialogue may supply the meaning of a narrative choice, but never the
    // observed physical action. These are separate evidence channels.
    const groundedStoryLabel = surface === 'story' && action.storyEvidenceLevel === 'fact' &&
      confidence(action.storyConfidence) >= .6
      ? text(action.narrativeChoiceLabel || action.label) : '';
    const label = specific?.label || groundedStoryLabel ||
      (evidence ? '' : !generic.test(legacyLabel.toLocaleLowerCase('tr-TR')) ? legacyLabel : '');
    const factsBefore = evidence?.before?.facts || {}, factsAfter = evidence?.after?.facts || {};
    rows.push({ id, origin, start, end, phase, surface, cast, evidence,
      // Source labels are not reliable scene boundaries. Only verified
      // continuous timeline topology is allowed to split a chapter.
      chapterKey: evidence?.chapterId || text(action.adultSceneId),
      sceneId: action.adultScene === true
        ? (evidence?.chapterId || text(action.adultSceneId)).replace(/^adult-(?=scene-)/i, '') : '',
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
      movementLabel: text(action.movementType),
      decisionId: evidence?.decisionId || '', before: factsBefore, after: factsAfter,
      confidence: specific?.confidence || confidence(action.confidence),
      provenance: evidence?.provenance || 'legacy-source-analysis',
      identityResolution, classificationReview,
      relationship: identityResolution !== 'conflict' && action.relationshipResolution === 'verified' && action.relationshipSubjectId && action.relationshipTargetId
        ? { from: text(action.relationshipSubjectId), to: text(action.relationshipTargetId),
            label: text(action.relationshipRoleLabel) } : null });
  }
  rows.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  // Some analyses omit an opening's scene id while keeping its source
  // observations continuous up to a verified core scene. Give those opening
  // choices that scene's menu owner without equating conflicting character
  // tracks or changing their source intervals. A gap or earlier core is a
  // hard boundary; an explicitly different scene id is never overwritten.
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.phase !== 'APPROACH' || row.sceneId) continue;
    for (let next = index + 1; next < rows.length; next++) {
      const candidate = rows[next];
      if (candidate.start - rows[next - 1].end > 45 || candidate.phase === 'CORE' && !candidate.sceneId)
        break;
      if (candidate.phase !== 'CORE') continue;
      const otherScene = rows.slice(index + 1, next).some(between =>
        between.sceneId && between.sceneId !== candidate.sceneId);
      const distinctVerifiedCast = row.identityResolution === 'verified' &&
        candidate.identityResolution === 'verified' && row.cast.length >= 2 && candidate.cast.length >= 2 &&
        row.cast.some(id => !candidate.cast.includes(id)) && candidate.cast.some(id => !row.cast.includes(id));
      if (!otherScene && !distinctVerifiedCast && candidate.start - row.end <= 180 &&
          candidate.cast.some(id => row.cast.includes(id)))
        row.sceneId = candidate.sceneId;
      break;
    }
  }
  const chapters = [], choices = [], clips = [], stages = [];
  let chapter, stage, prior;
  const seen = new Set(), groups = new Map();
  for (const row of rows) {
    // Camera cuts, chapter aliases, missing partner tracks, and speaker-only
    // observations never manufacture new chapters. A large unobserved source
    // interval is the only automatic split; future verified scene-boundary
    // records may also split explicitly.
    const chapterKey = 'continuous-source';
    const disconnected = prior && row.start - prior.end > 45;
    if (!chapter || disconnected) {
      chapter = { id: `chapter:${row.id}:${row.start}`, key: chapterKey, startTime: row.start, endTime: row.end,
        stageIds: [], cast: row.cast };
      chapters.push(chapter); stage = null;
    }
    chapter.endTime = Math.max(chapter.endTime, row.end);
    // One core stage contains verified position families and their movement
    // variants. Individual occurrences are nested choices, not new stages.
    // A source event is a chronological stop, not an alternative to every
    // later conversation in the encounter. Only source-supported decisions
    // observed at the same boundary may share a story stage.
    const storyPoint = row.decisionId && prior?.decisionId === row.decisionId &&
      Math.abs(row.start - prior.start) < 2 ? prior.storyPoint : row.id;
    row.storyPoint = storyPoint;
    const stageKey = JSON.stringify([row.phase, row.phase === 'STORY' ? storyPoint : row.sceneId]);
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
      // Never invent 12/14-second cut points. Completing a source observation
      // means reaching its actual validated end, unless a later verified
      // boundary is provided by the analysis.
      previewEndTime: row.end, visualVerified: Boolean(row.evidence?.action?.verified) && row.classificationReview === 'verified',
      identityResolution: row.identityResolution, classificationReview: row.classificationReview,
      occurrenceId: row.occurrence, participantTrackIds: row.cast, evidence: row.evidence,
      before: row.before, after: row.after, confidence: row.confidence, provenance: row.provenance };
    clips.push(clip);
    // Missing occurrence/identity proof keeps records separate. Shared tempo is never proof.
    // A matching sourceActionId alone cannot join different cuts: require
    // actual visual action evidence and a stable occurrence identity.
    const canMerge = Boolean(row.evidence?.action?.verified && row.evidence?.sourceActionId && row.occurrence);
    const key = JSON.stringify([stage.id, canMerge ? row.origin : clip.id,
      canMerge ? row.occurrence : clip.id, row.cast, row.semantic, row.before, row.after]);
    let choice = groups.get(key);
    if (!choice) {
      choice = { id: `choice:${choices.length}:${row.id}`, chapterId: chapter.id, stageId: stage.id,
        phase: row.phase, surface: row.surface, label: row.label, intent: row.intent,
        decisionId: row.decisionId,
        // Source time locates footage; a verified decision or scene owns the
        // menu. Keep a local stage as the fallback when ownership is absent.
        choiceGroupId: row.phase === 'STORY' && row.decisionId
          ? JSON.stringify(['story', chapter.id, row.decisionId])
          : ['APPROACH', 'CORE'].includes(row.phase) && row.sceneId
            ? JSON.stringify([row.surface, chapter.id, row.sceneId]) : stage.id,
        positionId: row.group, positionLabel: row.positionLabel,
        movementLabel: row.movementLabel, occurrenceId: row.occurrence,
        abstained: row.abstained, confidence: row.confidence, cast: row.cast,
        kind: row.decisionId ? 'candidate_decision' : 'source_event',
        sourceActionId: row.origin, classificationReview: row.classificationReview,
        relationship: row.relationship, clipIds: [] };
      groups.set(key, choice); choices.push(choice); stage.choiceIds.push(choice.id);
    }
    choice.clipIds.push(clip.id); prior = row;
  }
  const decisionGroups = new Map();
  for (const choice of choices.filter(row => row.kind === 'candidate_decision')) {
    const id = choice.decisionId;
    if (id) decisionGroups.set(choice.choiceGroupId,
      { id, options: [...(decisionGroups.get(choice.choiceGroupId)?.options || []), choice] });
  }
  const decisions = [...decisionGroups.values()].filter(({ options }) => options.length > 1 &&
    options.every(row => row.choiceGroupId === options[0].choiceGroupId))
    .map(({ id, options }) => ({ id, choiceIds: options.map(row => row.id), stageId: options[0].stageId }));
  const decisionChoices = new Set(decisions.flatMap(row => row.choiceIds));
  for (const choice of choices) choice.kind = decisionChoices.has(choice.id) ? 'story_decision' : 'source_event';
  const sourceEvents = clips.map(clip => ({ clipId: clip.id, sourceActionId: clip.sourceActionId,
    stageId: clip.stageId, startTime: clip.startTime, endTime: clip.endTime,
    occurrenceId: clip.occurrenceId, classificationReview: clip.classificationReview }));
  const data = { version: EVIDENCE_VERSION, duration: Number(analysis.videoDuration) || Math.max(0, ...rows.map(r => r.end)),
    chapters, stages, choices, clips, sourceEvents, decisions, rejected,
    characters: (analysis.storyContext?.characters || []).map(row => ({ id: text(row.participantTrackId || row.id),
      label: text(row.displayName || row.visualDescription), verified: row.evidenceLevel === 'fact' })) };
  return freeze({ ...data, fingerprint: graphFingerprint(data) });
}
