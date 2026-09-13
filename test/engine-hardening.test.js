import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANALYSIS_SCHEMA_VERSION,
  ENGINE_VERSION,
  actionConfidence,
  advanceAdultPhase,
  analysisFingerprint,
  appendEngineEvent,
  applyRuntimeSnapshot,
  canPlayAction,
  createRuntimeSnapshot,
  isCompatibleRuntimeSnapshot,
  mergeSecondPassReview,
  reviewAndHardenAnalysis,
  secondPassReviewCandidates,
  shouldSecondPassReview,
  validateActionInterval
} from '../public/engine-hardening.js';

test('timeline validator rejects broken ranges and movement outside parent position', () => {
  assert.equal(validateActionInterval({ startTime: 5, endTime: 4 }, 20).valid, false);
  const action = {
    startTime: 10,
    endTime: 22,
    positionId: 'missionary',
    positionStartTime: 10,
    positionEndTime: 22,
    loopStartTime: 9,
    loopEndTime: 20
  };
  assert.ok(validateActionInterval(action, 30).reasons.includes('LOOP_OUTSIDE_POSITION'));
});

test('second visual pass is selective: only critical positions, conflicts and finals', () => {
  const genericLow = { actionId: 'g', startTime: 0, endTime: 2, confidence: 0.6 };
  const foreplayHigh = { actionId: 'f', startTime: 2, endTime: 5, confidence: 0.95, adultScene: true, actionType: 'touch' };
  const coreHigh = {
    actionId: 'p-high', startTime: 10, endTime: 25, confidence: 0.95, adultScene: true,
    adultSceneId: 's', actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner'
  };
  const coreLow = { ...coreHigh, actionId: 'p-low', startTime: 30, endTime: 45, confidence: 0.78 };
  const oralLow = {
    actionId: 'oral', startTime: 46, endTime: 58, confidence: 0.76, adultScene: true,
    adultSceneId: 's', actionType: 'position', positionId: 'oral', positionLabel: 'Oral'
  };
  const final = {
    actionId: 'final', startTime: 60, endTime: 65, confidence: 0.96, adultScene: true,
    adultSceneId: 's', actionType: 'outcome', outcomeType: 'climax'
  };

  assert.equal(shouldSecondPassReview({ actions: [genericLow, foreplayHigh, coreHigh, oralLow] }), false);
  assert.deepEqual(secondPassReviewCandidates({ actions: [genericLow, coreLow, final] }).map(x => x.actionId), ['p-low', 'final']);
  assert.equal(shouldSecondPassReview({ actions: [final] }), true);
});

test('overlapping incompatible positions force a second pass even at high confidence', () => {
  const missionary = {
    actionId: 'm', startTime: 10, endTime: 25, confidence: 0.95, adultSceneId: 's',
    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner'
  };
  const cowgirl = {
    actionId: 'c', startTime: 12, endTime: 24, confidence: 0.94, adultSceneId: 's',
    actionType: 'position', positionId: 'cowgirl', positionLabel: 'Kovboy'
  };
  assert.deepEqual(secondPassReviewCandidates({ actions: [missionary, cowgirl] }).map(x => x.actionId), ['m', 'c']);
});

test('every explicit vaginal or anal claim receives one visual route recheck', () => {
  const ambiguous = {
    actionId: 'route-low', startTime: 10, endTime: 25, confidence: 0.98, adultSceneId: 's',
    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',
    activityType: 'vaginal', activityTypeConfidence: 0.72, activityEvidence: ''
  };
  const clear = { ...ambiguous, actionId: 'route-high', activityTypeConfidence: 0.96, activityEvidence: 'direct visible route evidence' };
  const anal = { ...clear, actionId: 'route-anal', startTime: 30, endTime: 45, activityType: 'anal' };
  assert.deepEqual(secondPassReviewCandidates({ actions: [ambiguous] }).map(x => x.actionId), ['route-low']);
  assert.deepEqual(secondPassReviewCandidates({ actions: [clear, anal] }).map(x => x.actionId), ['route-high', 'route-anal']);
});

test('same position with conflicting anal and vaginal claims forces route review', () => {
  const vaginal = {
    actionId: 'v', startTime: 10, endTime: 25, confidence: 0.97, adultSceneId: 's',
    actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',
    activityType: 'vaginal', activityTypeConfidence: 0.97, activityEvidence: 'direct visible route evidence'
  };
  const anal = { ...vaginal, actionId: 'a', startTime: 12, endTime: 24, activityType: 'anal' };
  assert.deepEqual(secondPassReviewCandidates({ actions: [vaginal, anal] }).map(x => x.actionId), ['v', 'a']);
});

test('hardening downgrades unsupported penetrative route instead of keeping a false explicit label', () => {
  const { analysis, integrity } = reviewAndHardenAnalysis({
    videoDuration: 40,
    actions: [{
      actionId: 'route', label: 'Vajinal seks', startTime: 10, endTime: 25, confidence: 0.98,
      adultScene: true, adultSceneId: 's', actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',
      positionStartTime: 10, positionEndTime: 25, loopStartTime: 10, loopEndTime: 25,
      activityType: 'vaginal', activityTypeConfidence: 0.55, activityEvidence: ''
    }]
  });
  assert.equal(analysis.actions[0].activityType, 'other');
  assert.equal(analysis.actions[0].label, 'Misyoner');
  assert.ok(integrity.issues.some(issue => issue.code === 'UNVERIFIED_ACTIVITY_TYPE'));
});

test('selective review preserves safe first-pass actions and rejects invented review ids', () => {
  const safe = { actionId: 'safe', label: 'Dokun', startTime: 1, endTime: 3, confidence: 0.95 };
  const risky = { actionId: 'risky', label: 'Misyoner', startTime: 10, endTime: 20, confidence: 0.78 };
  const reviewedRisky = { ...risky, confidence: 0.93, positionId: 'missionary' };
  const invented = { actionId: 'invented', label: 'Uydurma', startTime: 30, endTime: 40, confidence: 1 };
  const merged = mergeSecondPassReview(
    { actions: [safe, risky], warnings: ['first'] },
    { actions: [reviewedRisky, invented], warnings: ['review'] },
    [risky]
  );
  assert.deepEqual(merged.actions.map(x => x.actionId), ['safe', 'risky']);
  assert.equal(merged.actions.find(x => x.actionId === 'risky').confidence, 0.93);
  assert.deepEqual(merged.warnings, ['first', 'review']);
});

test('hardening rejects incomplete chunk coverage', () => {
  const { integrity } = reviewAndHardenAnalysis({
    videoDuration: 100,
    chunkCount: 2,
    expectedChunkCount: 3,
    actions: [{ actionId: 'a', label: 'A', startTime: 1, endTime: 3, confidence: 0.9 }]
  });
  assert.equal(integrity.fatal, true);
  assert.ok(integrity.issues.some(issue => issue.code === 'INCOMPLETE_CHUNK_COVERAGE'));
});

test('hardening drops early final that appears before a verified core position', () => {
  const { analysis } = reviewAndHardenAnalysis({
    videoDuration: 120,
    chunkCount: 1,
    expectedChunkCount: 1,
    actions: [
      {
        actionId: 'outcome-early', label: 'Final', startTime: 10, endTime: 15,
        adultScene: true, adultSceneId: 'scene-1', actionType: 'outcome', outcomeType: 'climax',
        outcomeStartTime: 10, outcomeEndTime: 15, confidence: 0.95
      },
      {
        actionId: 'core', label: 'Misyoner', startTime: 40, endTime: 65,
        adultScene: true, adultSceneId: 'scene-1', actionType: 'position', positionId: 'missionary',
        positionLabel: 'Misyoner', positionStartTime: 40, positionEndTime: 65,
        loopStartTime: 40, loopEndTime: 65, confidence: 0.95
      }
    ]
  });
  assert.deepEqual(analysis.actions.map(action => action.actionId), ['core']);
  assert.equal(analysis.schemaVersion, ANALYSIS_SCHEMA_VERSION);
  assert.equal(analysis.engineVersion, ENGINE_VERSION);
});

test('conflicting overlapping positions keep the higher-confidence candidate', () => {
  const { analysis } = reviewAndHardenAnalysis({
    videoDuration: 60,
    actions: [
      {
        actionId: 'm', label: 'Misyoner', startTime: 10, endTime: 25,
        adultScene: true, adultSceneId: 's', actionType: 'position', positionId: 'missionary', positionLabel: 'Misyoner',
        positionStartTime: 10, positionEndTime: 25, loopStartTime: 10, loopEndTime: 25, confidence: 0.91
      },
      {
        actionId: 'c', label: 'Kovboy', startTime: 12, endTime: 24,
        adultScene: true, adultSceneId: 's', actionType: 'position', positionId: 'cowgirl', positionLabel: 'Kovboy',
        positionStartTime: 12, positionEndTime: 24, loopStartTime: 12, loopEndTime: 24, confidence: 0.78
      }
    ]
  });
  assert.deepEqual(analysis.actions.map(action => action.actionId), ['m']);
});

test('state machine is monotonic and centralized permission guard blocks invalid final', () => {
  assert.equal(advanceAdultPhase('positions', 'foreplay'), 'positions');
  assert.equal(advanceAdultPhase('positions', 'reward'), 'reward');

  const action = { startTime: 20, endTime: 25, outcomeStartTime: 20, outcomeEndTime: 25 };
  assert.equal(canPlayAction({ kind: 'outcome', action, phase: 'positions', outcomeReady: true, videoDuration: 60 }).allowed, false);
  assert.equal(canPlayAction({ kind: 'outcome', action, phase: 'final', outcomeReady: false, videoDuration: 60 }).allowed, false);
  assert.equal(canPlayAction({ kind: 'outcome', action, phase: 'final', outcomeReady: true, videoDuration: 60 }).allowed, true);
});

test('runtime save only restores into the exact analysis/engine version', () => {
  const sourceState = {
    gameState: 'DECISION_PENDING', gameCursorTime: 44, currentActionIndex: 3,
    consumedActionIds: new Set(['a']), completedAdultSceneIds: new Set(['s1']),
    maleSceneProgress: 55, femaleSceneProgress: 48, adultClimaxProgress: 21,
    adultCorePlaySeconds: 31, adultVisitedPositionIds: new Set(['p1']),
    adultMovementPlayCounts: new Map([['m1', 2]]), adultPreludePlayCounts: new Map([['f1', 1]]),
    adultComboCount: 2, adultPhaseMachine: 'positions', adultLastUiPhase: 'positions',
    adultScene: { id: 'scene-active' }
  };
  const snapshot = createRuntimeSnapshot(sourceState, 'fingerprint');
  assert.equal(isCompatibleRuntimeSnapshot(snapshot, 'fingerprint'), true);
  assert.equal(isCompatibleRuntimeSnapshot(snapshot, 'other'), false);
  const target = {};
  applyRuntimeSnapshot(target, snapshot);
  assert.equal(target.gameCursorTime, 44);
  assert.equal(target.adultVisitedPositionIds.has('p1'), true);
  assert.equal(target.adultMovementPlayCounts.get('m1'), 2);
  assert.equal(target.restoredAdultSceneId, 'scene-active');
});

test('event log is bounded and fingerprint is stable', () => {
  const log = [];
  for (let index = 0; index < 10; index += 1) appendEngineEvent(log, 'TEST', { index }, 4);
  assert.equal(log.length, 4);
  const analysis = { videoDuration: 10, actions: [{ actionId: 'a', startTime: 1, endTime: 2 }] };
  assert.equal(analysisFingerprint(analysis), analysisFingerprint(analysis));
  assert.equal(actionConfidence({ confidence: 2 }), 1);
});
