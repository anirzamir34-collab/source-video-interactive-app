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
  reviewAndHardenAnalysis,
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

test('adult or low-confidence chunks request a visual second review pass', () => {
  assert.equal(shouldSecondPassReview({ actions: [{ startTime: 0, endTime: 1, confidence: 0.9 }] }), false);
  assert.equal(shouldSecondPassReview({ actions: [{ startTime: 0, endTime: 1, confidence: 0.7 }] }), true);
  assert.equal(shouldSecondPassReview({ actions: [{ startTime: 0, endTime: 1, confidence: 0.95, adultScene: true }] }), true);
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
