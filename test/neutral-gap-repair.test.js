import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAP_REPAIR_PROMPT_VERSION, GAP_REPAIR_VALIDATOR_VERSION, GAP_REPAIR_SYSTEM_INSTRUCTION,
  buildGapRepairPrompt, inspectNeutralRepairActions, verifiedNeutralRepairActions,
  uncoveredNeutralRepairIntervals } from '../public/neutral-gap-repair.js';

test('gap-repair uses a separate short neutral timeline prompt', () => {
  const prompt = buildGapRepairPrompt({
    chunkStart: 100, chunkEnd: 160,
    timestamps: '[100,103,106,109]',
    motionProfile: '[{"time":103,"score":7}]',
    sceneBoundaries: '[{"time":110,"kind":"hard-cut"}]'
  });
  assert.equal(GAP_REPAIR_PROMPT_VERSION, 'neutral-timeline-v2');
  assert.equal(GAP_REPAIR_VALIDATOR_VERSION, 'neutral-validator-v2');
  assert.match(GAP_REPAIR_SYSTEM_INSTRUCTION, /non-graphic/);
  assert.match(prompt, /100–160 seconds/);
  assert.match(prompt, /100,103,106,109/);
  assert.match(prompt, /sourceVerified=true/);
  assert.doesNotMatch(prompt, /"confidence":0\.0/);
  assert.match(prompt, /"confidence":number/);
  assert.match(prompt, /Do not report a description based solely/);
  assert.doesNotMatch(prompt, /ADULT SCENE CHOICES|TWO-LEVEL DEEP ANALYSIS/);
  assert.throws(() => buildGapRepairPrompt({ chunkStart: 20, chunkEnd: 10 }), /Invalid gap/);
});

test('only verified non-graphic ordinary story actions can be merged', () => {
  const range = { startTime: 100, endTime: 160 };
  const basic = { startTime: 105, endTime: 115, sourceVerified: true,
    actionType: 'story', choiceSurface: 'story', nonIntimate: true,
    label: 'Kişi odadan çıkıyor', confidence: 0.9 };
  const good = verifiedNeutralRepairActions([
    basic,
    { ...basic, actionType: 'position', startTime: 120, endTime: 125 },
    { ...basic, nonIntimate: false, startTime: 130, endTime: 138 },
    { ...basic, positionId: 'rear', startTime: 142, endTime: 149 },
    { ...basic, sourceVerified: false, startTime: 151, endTime: 158 },
    { ...basic, startTime: 90, endTime: 101 }
  ], range);
  assert.equal(good.length, 1);
  assert.equal(good[0].nonIntimate, true);
  assert.equal(good[0].positionId, '');
  assert.equal(good[0].adultScene, false);
});

test('unobserved seconds remain gaps even when a few neutral events are recovered', () => {
  const range = { startTime: 100, endTime: 160 };
  const clips = [
    { sourceVerified: true, startTime: 105, endTime: 115 },
    { sourceVerified: true, startTime: 112, endTime: 120 },
    { sourceVerified: true, startTime: 140, endTime: 145 }
  ];
  const gaps = uncoveredNeutralRepairIntervals(range, clips);
  assert.deepEqual(gaps.map(x => [x.startTime,x.endTime]), [[100,105],[120,140],[145,160]]);
  assert.ok(gaps.every(x => x.reason === 'NEUTRAL_REPAIR_UNVERIFIED'));
  assert.deepEqual(uncoveredNeutralRepairIntervals(range, []),
    [{ startTime: 100, endTime: 160, reason: 'NEUTRAL_REPAIR_UNVERIFIED' }]);
  assert.deepEqual(uncoveredNeutralRepairIntervals(range, [
    { sourceVerified: true, startTime: 100, endTime: 160 }]), []);
});

test('saved-game server route is versioned and never sends full instruction for repair', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(server, /savedGameRepair\s*\? buildGapRepairPrompt/);
  assert.match(server, /savedGameRepair \? GAP_REPAIR_SYSTEM_INSTRUCTION : GEMINI_VISUAL_SYSTEM_INSTRUCTION/);
  assert.match(server, /inspectNeutralRepairActions\(parsed\?\.actions/);
  assert.match(app, /lastAttempt\?\.promptVersion === GAP_REPAIR_PROMPT_VERSION/);
  assert.match(app, /uncoveredNeutralRepairIntervals\(gap, result\.actions\)/);
  assert.match(app, /promptVersion: GAP_REPAIR_PROMPT_VERSION/);
});

test('repair validator diagnostics expose only counts and preserve honest confidence', () => {
  const example = { sourceVerified: true, nonIntimate: true, actionType: 'story',
    choiceSurface: 'story', startTime: 102, endTime: 108,
    label: 'Kişi odadan çıkıyor' };
  const result = inspectNeutralRepairActions([
    { ...example, confidence: 0 },
    { ...example, confidence: 0.85 },
    { ...example, startTime: 90, endTime: 105, confidence: 0.8 },
    { ...example, sourceVerified: false, confidence: 0.8 },
    { ...example, confidence: 0.8, label: 'x' }
  ], { startTime: 100, endTime: 160 });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].confidence, 0.85);
  assert.equal(result.diagnostics.modelRawActionsCount, 5);
  assert.equal(result.diagnostics.repairValidatorAcceptedCount, 1);
  assert.equal(result.diagnostics.repairValidatorRejected.lowConfidence, 1);
  assert.equal(result.diagnostics.repairValidatorRejected.invalidTime, 1);
  assert.equal(result.diagnostics.repairValidatorRejected.notSourceVerified, 1);
  assert.equal(result.diagnostics.repairValidatorRejected.missingLabel, 1);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /odadan|sourceVerified/);
});
