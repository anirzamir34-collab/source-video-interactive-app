// Regression fixtures built from real analyses (labels removed, structure
// kept). Each change to scene building must keep these invariants and the
// recorded panel layout; run with UPDATE_ANALYSIS_SNAPSHOTS=1 to accept an
// intended layout change after reviewing the diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as choiceRouting from '../public/choice-routing.js';
import * as gameplay from '../public/adult-gameplay.js';
import { matchSceneIntroductions, verifiedOpeningCast } from '../public/scene-entry.js';
import { isAdultSocialRelationshipRole } from '../public/relationship-roles.js';
import { sourceIdentityLabel, sourceDisplayLabel, collapseConsecutiveEquivalentCards, bundleAdjacentSourceCards } from '../public/choice-groups.js';
import { interactionEntryGuard } from '../public/interaction-timeline.js';
import { sourceSpeechOverlaps } from '../public/source-transcript.js';
import { assignVerifiedOpeningRoles } from '../public/verified-scene-continuity.js';
import { canonicalizeActionTrackIds } from '../public/character-identity.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const handlerStart = source.indexOf('function prepareAdultScenes()');
const handler = source.slice(handlerStart, source.indexOf('\nfunction adultAnalysisTraceText()', handlerStart));
const mergeStart = source.indexOf('const ADULT_FRAGMENT_MERGE_GAP_SECONDS =');
const mergeSource = source.slice(mergeStart, source.indexOf('\nfunction prepareAdultScenes()', mergeStart));
const directory = new URL('./fixtures/analyses/', import.meta.url);
const snapshotFile = new URL('./fixtures/analysis-layout.snapshot.json', import.meta.url);
const OPENING_FAMILIES = new Set(['oral', 'manual']);

function build(file) {
  const fixture = JSON.parse(fs.readFileSync(new URL(file, directory), 'utf8'));
  const actions = fixture.actions.map(row => ({ ...row.input, actionId: row.actionId, label: row.label,
    startTime: row.startTime, endTime: row.endTime, sourceVerified: row.sourceVerified, confidence: row.confidence }));
  const state = { analysis: { actions, storyContext: fixture.storyContext }, analysisFingerprint: file, sourceContext: null };
  const scope = vm.createContext({ ...gameplay, ...choiceRouting, assignVerifiedOpeningRoles, state, ENGINE_VERSION: 'fixture',
    matchSceneIntroductions, verifiedOpeningCast, isAdultSocialRelationshipRole, sourceSpeechOverlaps, canonicalizeActionTrackIds,
    sourceIdentityLabel, sourceDisplayLabel, collapseConsecutiveEquivalentCards, bundleAdjacentSourceCards, interactionEntryGuard,
    bindActionCharacter: item => item,
    canonicalAdultPosition: item => { const id = gameplay.verifiedAdultPositionFamily(item); return { id, label: id }; },
    adultCategoryFor: item => ({ id: item.activityType || 'other', label: 'x' }),
    activityOccurrenceNamespace: item => item.activityType || 'unclear', activityDisplayLabel: value => value,
    normalizeAdultLabel: value => String(value).toLowerCase(),
    mergeAdultSceneFragments: vm.runInNewContext(`${mergeSource}\nmergeAdultSceneFragments;`),
    isWarmupPosition: position => position.progressionRole === 'foreplay', isBonusPosition: () => false,
    renderAdultAnalysisTrace() {} });
  vm.runInContext(`${handler}\nprepareAdultScenes();`, scope);
  return { actions, scenes: state.adultScenes, trace: state.adultAnalysisTrace };
}

const familyOf = position => String(position.familyId || String(position.id).split(':')[1] || '');
const layout = scenes => scenes.map(scene => ({ scene: scene.id,
  foreplay: scene.foreplay.filter(item => !item.nonIntimate).map(item => item.id),
  positions: scene.positions.map(position => `${familyOf(position)}:${position.progressionRole}`) }));

const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
const snapshots = fs.existsSync(snapshotFile) ? JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) : {};
const updated = {};

for (const file of files) {
  test(`real analysis ${file} keeps the three-panel rules`, () => {
    const { actions, scenes, trace } = build(file);
    const byId = new Map(actions.map(action => [action.actionId, action]));
    for (const scene of scenes) {
      const core = scene.positions.filter(position => position.progressionRole !== 'foreplay');
      const firstCore = Math.min(...core.map(position => Number(position.startTime)));
      for (const item of scene.foreplay.filter(row => !row.nonIntimate)) {
        assert.notEqual(byId.get(item.sourceActionId || item.id)?.choiceSurface, 'story',
          `${scene.id}: story action ${item.id} must not be an approach choice`);
      }
      for (const position of scene.positions) {
        if (position.progressionRole === 'foreplay') {
          assert.ok(!(Number(position.startTime) >= firstCore), `${scene.id}: approach ${position.id} after first sex position`);
        } else {
          assert.ok((position.movements || []).length > 0, `${scene.id}: sex position ${position.id} has no playable move`);
          if (OPENING_FAMILIES.has(familyOf(position))) assert.ok(Number(position.startTime) >= firstCore - 0.05,
            `${scene.id}: opening ${position.id} must be an approach choice`);
        }
      }
      const ranges = scene.positions.flatMap(position => (position.sourceRanges || [])
        .map(range => ({ id: position.id, start: Number(range.startTime), end: Number(range.endTime) })))
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < ranges.length; i++) if (ranges[i].id !== ranges[i - 1].id)
        assert.ok(ranges[i].start >= ranges[i - 1].end - 0.25,
          `${scene.id}: ${ranges[i - 1].id} and ${ranges[i].id} overlap`);
    }
    for (const row of trace.actions.filter(item => item.route === 'POSITION')) {
      const action = byId.get(row.actionId);
      assert.ok(scenes.some(scene => scene.positions.some(position => (position.sourceRanges || []).some(range =>
        Number(range.startTime) < Number(action.endTime) && Number(range.endTime) > Number(action.startTime)))),
      `${row.actionId}: panel action lost from every position`);
    }
    const current = JSON.parse(JSON.stringify(layout(scenes)));
    updated[file] = current;
    if (process.env.UPDATE_ANALYSIS_SNAPSHOTS || !snapshots[file]) return;
    assert.deepEqual(current, snapshots[file], `${file}: panel layout changed; review and update the snapshot if intended`);
  });
}

test.after(() => {
  if (process.env.UPDATE_ANALYSIS_SNAPSHOTS || files.some(file => !snapshots[file]))
    fs.writeFileSync(snapshotFile, `${JSON.stringify({ ...snapshots, ...updated }, null, 2)}\n`);
});
