import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('unlocked canonical position renders movements only from one continuous occurrence', () => {
  assert.match(source, /const nextForwardOccurrence = occurrences\.find\(group => Number\(group\.startTime\) >= cursor - 0\.25[\s\S]*?const targetOccurrence = requestedOccurrence \|\| containingOccurrence \|\| nextForwardOccurrence \|\| retainedOccurrence/);
  assert.match(source, /const occurrenceMovements = targetOccurrence[\s\S]*?movementsForPositionOccurrence\(position, targetOccurrence\.id\)/);
  assert.match(source, /const localMovements = unlockedCore \? verifiedPositionMovements/);
});

test('panel family consolidation keeps distant source occurrences separate', () => {
  assert.match(source, /consolidateVerifiedPositions\(scene\.positions, \{[\s\S]*?mergeDistantReturns: false[\s\S]*?\}\)/);
});


test('foreplay-only adult fragments survive until they can merge with the first core position', () => {
  assert.match(source, /if \(!positions\.length\) \{[\s\S]*?verifiedForeplay[\s\S]*?foreplay: verifiedForeplay[\s\S]*?positions: \[\]/);
  assert.match(source, /\.filter\(scene => scene\.positions\.length \|\| scene\.foreplay\.length\)/);
  assert.match(source, /mergeAdultSceneFragments\([\s\S]*?\)\.filter\(scene => scene\.positions\?\.length \|\| scene\.foreplay\?\.length\)/);
});

test('first intimate approach uses its own overlay instead of the core panel or dialogue choices', () => {
  assert.match(source, /const target = dialogueOnly \? els\.choices : els\.approachChoices/);
  assert.match(source, /panelVisible: progressivePanelVisible/);
  assert.match(source, /overlayVisible: progressiveOverlayVisible/);
});
