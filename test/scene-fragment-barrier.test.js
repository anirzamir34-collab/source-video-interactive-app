import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assignVerifiedOpeningRoles } from '../public/verified-scene-continuity.js';
import { createInteractionState, transitionInteraction } from '../public/interaction-engine.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
const end = source.indexOf('\nfunction prepareAdultScenes()', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const warmupStart = source.indexOf('function isWarmupPosition(');
const warmupEnd = source.indexOf('\nfunction isBonusPosition(', warmupStart);
vm.runInContext(source.slice(warmupStart, warmupEnd), context);

const chapter = (id, startTime, endTime) => ({ id, startTime, endTime,
  postSceneTime: endTime, foreplay: [], positions: [], outcomes: [] });

test('an excluded source interval separates nearby interactive chapters', () => {
  const scenes = [chapter('first', 10, 20), chapter('second', 35, 45)];
  assert.equal(context.mergeAdultSceneFragments(scenes).length, 1);
  assert.equal(context.mergeAdultSceneFragments(scenes, [], [{ startTime: 22, endTime: 33 }]).length, 2);
});

test('a distant return and verified intervening dialogue keep chapters separate', () => {
  const first = chapter('first', 10, 20);
  const distant = chapter('distant', 60, 70);
  assert.equal(context.mergeAdultSceneFragments([first, distant]).length, 2);
  const nearby = chapter('nearby', 30, 40);
  assert.equal(context.mergeAdultSceneFragments([first, nearby], [{
    sourceVerified: true, actionType: 'dialogue', startTime: 22, endTime: 26
  }]).length, 2);
});

test('adjacent same-pair chapters merge despite different redundant participant lists', () => {
  const clip = (startTime, endTime, participantTrackIds = []) => ({
    startTime, endTime, sourceVerified: true, familyId: 'oral',
    subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A',
    participantTrackIds, groupScene: false
  });
  // Real Android diagnosis: the opening at 71.5–188 had no CORE group,
  // while the next 188–884.8 chapter had the first CORE position.
  const opening = { ...chapter('adult-scene-001', 71.5, 188),
    foreplay: [clip(71.5, 110.6, ['MAIN_MALE', 'PARTNER_A'])],
    positions: [clip(110.6, 188, ['MAIN_MALE', 'PARTNER_A'])] };
  const continuing = { ...chapter('adult-001', 188, 884.8),
    positions: [{ ...clip(188, 387.1, []), familyId: 'oral' },
      { ...clip(387.1, 769.6, ['PARTNER_A']), familyId: 'standing-rear' }] };
  const result = context.mergeAdultSceneFragments([opening, continuing]);
  assert.equal(result.length, 1);
  assert.equal(result[0].startTime, 71.5);
  assert.equal(result[0].endTime, 884.8);
  assert.deepEqual(Array.from(result[0].positions, item => [item.startTime, item.endTime]),
    [[110.6, 188], [188, 387.1], [387.1, 769.6]]);
  assert.deepEqual(Array.from(result[0].sourceSceneIds), ['adult-scene-001', 'adult-001']);
});

test('an actually different partner and group cast still separate chapters', () => {
  const pair = (partnerTrackId, participantTrackIds = [], groupScene = false) => ({
    subjectTrackId: 'MAIN_MALE', partnerTrackId, participantTrackIds,
    groupScene, sourceVerified: true, startTime: 10, endTime: 20
  });
  const a = { ...chapter('a', 10, 20), positions: [pair('PARTNER_A')] };
  const different = { ...chapter('b', 20, 30),
    positions: [{ ...pair('PARTNER_B'), startTime: 20, endTime: 30 }] };
  assert.equal(context.mergeAdultSceneFragments([a, different]).length, 2);
  const group = { ...chapter('group', 20, 30),
    positions: [{ ...pair('PARTNER_A', ['PARTNER_A', 'PARTNER_B'], true),
      startTime: 20, endTime: 30 }] };
  assert.equal(context.mergeAdultSceneFragments([a, group]).length, 2);
});

test('merged Android-style opening reaches a real next CORE group when progress fills', () => {
  const warmup = { id: 'warmup', familyId: 'oral', startTime: 110.6, endTime: 387.1,
    sourceVerified: true, subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A',
    movements: [{ sourceVerified: true, movementTempo: 'moderate' }],
    sourceRanges: [{ startTime: 110.6, endTime: 387.1 }] };
  const core = { id: 'next-position', familyId: 'standing-rear',
    startTime: 387.1, endTime: 769.6, sourceVerified: true,
    subjectTrackId: 'MAIN_MALE', partnerTrackId: 'PARTNER_A',
    movements: [{ sourceVerified: true, movementTempo: 'moderate' }],
    sourceRanges: [{ startTime: 387.1, endTime: 769.6 }] };
  const merged = context.mergeAdultSceneFragments([
    { ...chapter('early', 71.5, 188), positions: [{ ...warmup,
      endTime: 188, sourceRanges: [{ startTime: 110.6, endTime: 188 }],
      participantTrackIds: ['MAIN_MALE','PARTNER_A'] }] },
    { ...chapter('late', 188, 884.8), positions: [{ ...warmup,
      startTime: 188, sourceRanges: [{ startTime: 188, endTime: 387.1 }],
      participantTrackIds: [] }, core] }
  ]);
  assert.equal(merged.length, 1);
  const positions = assignVerifiedOpeningRoles(merged[0].positions);
  assert.deepEqual(Array.from(positions, item => context.isWarmupPosition(item)), [true,true,false]);
  const runtime = createInteractionState({ id: merged[0].id, groups: positions.map(item => ({
    id: item.id, sourceVerified: true, phase: context.isWarmupPosition(item) ? 'APPROACH' : 'CORE',
    sourceRanges: item.sourceRanges, movements: []
  })), choices: [] }, { currentTime: 110.6 });
  const full = transitionInteraction(runtime, { type: 'progress', value: 100 });
  assert.equal(full.currentPhase, 'CORE');
  assert.ok(full.unlockedGroupIds.includes('next-position'));
  assert.equal(full.panelVisible, true);
});

test('verified ordinary choices before the playable scene opening remain in the story UI', () => {
  const beginning = source.indexOf('function isUnownedTimelineChoice(');
  const ending = source.indexOf('\nfunction futureActions()', beginning);
  assert.ok(beginning >= 0 && ending > beginning);
  const scene = { id: 'merged', startTime: 71.5, endTime: 884.8,
    dialogue: [{ id: 'opening-dialogue', sourceActionId: 'tl-001',
      sourceVerified: true }, { id: 'within-scene', sourceActionId: 'tl-006',
      sourceVerified: true }],
    foreplay: [{ id: 'warmup-choice', sourceActionId: 'tl-005',
      sourceVerified: true }] };
  const state = { adultScenes: [scene], completedAdultSceneIds: new Set() };
  const ctx = vm.createContext({ state,
    choiceSurfaceForAction: action => action.choiceSurface,
    playableAdultPanelFamily: () => '',
    sceneOwnsStoryChoice: (row, action) => row.dialogue.some(item =>
      item.sourceActionId === action.actionId),
    sceneOwnsApproachChoice: (row, action) => row.foreplay.some(item =>
      item.sourceActionId === action.actionId)
  });
  vm.runInContext(source.slice(beginning, ending), ctx);
  assert.equal(ctx.isUnownedTimelineChoice({ actionId: 'tl-001', sourceVerified: true,
    choiceSurface: 'story', startTime: 4.608, endTime: 21.5 }), true);
  assert.equal(ctx.isUnownedTimelineChoice({ actionId: 'tl-006', sourceVerified: true,
    choiceSurface: 'story', startTime: 82.5, endTime: 110.6 }), false);
  assert.equal(ctx.isUnownedTimelineChoice({ actionId: 'tl-005', sourceVerified: true,
    choiceSurface: 'approach', startTime: 71.5, endTime: 82.5 }), false);
  assert.equal(ctx.isUnownedTimelineChoice({ actionId: 'tl-001', sourceVerified: false,
    choiceSurface: 'story', startTime: 4.608, endTime: 21.5 }), false);
});
