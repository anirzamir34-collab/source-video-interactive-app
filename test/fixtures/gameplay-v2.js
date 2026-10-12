// Synthetic stage rehearsal. Contains no user footage or private analysis.
export function observation(id, startTime, options = {}) {
  const { phase = 'APPROACH', duration = 7.2, ...extra } = options;
  const actionType = { STORY: 'dialogue', APPROACH: 'touch', CORE: 'position', OUTCOME: 'outcome', AFTERMATH: 'aftermath' }[phase];
  return { actionId: id, label: `Gözlenen eylem ${id}`, startTime, endTime: startTime + duration,
    sourceVerified: true, confidence: .95, subjectTrackId: 'performer-a', partnerTrackId: 'performer-b',
    participantTrackIds: ['performer-a', 'performer-b'], actionType, adultSceneId: 'rehearsal',
    ...(phase === 'CORE' ? { choiceSurface: 'panel', positionId: 'seated-facing',
      activityType: 'seated-facing', activityTypeConfidence: .95, activityEvidence: 'Verified neutral rehearsal pose',
      positionConfigurationConfidence: .95, positionEvidence: 'Verified source configuration',
      classificationReview: 'verified', positionLabel: 'Kaynak duruşu' } : {}),
    ...(phase === 'OUTCOME' ? { outcomeType: 'climax' } : {}),
    ...extra };
}
export function evidence(id, extra = {}) {
  return { version: 2, sourceActionId: id, chapterId: 'rehearsal', occurrenceId: 'occurrence-1',
    action: { verified: true, key: id, label: `Gözlenen eylem ${id}`, confidence: .95,
      evidence: 'Synthetic source frames verify this action.' }, ...extra };
}
export const visual = facts => ({ verified: true, confidence: .95, evidence: 'Synthetic visible state.', facts });
export const analysis = actions => ({ videoDuration: Math.max(120, ...actions.map(row => row.endTime + 5)), actions });
