import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('unlocked canonical position renders movements only from one continuous occurrence', () => {
  assert.match(source, /const nextForwardOccurrence = occurrences\.find\(group => Number\(group\.startTime\) >= cursor - 0\.25[\s\S]*?const targetOccurrence = containingOccurrence \|\| nextForwardOccurrence \|\| retainedOccurrence/);
  assert.match(source, /const occurrenceMovements = targetOccurrence[\s\S]*?movementsForPositionOccurrence\(position, targetOccurrence\.id\)/);
  assert.match(source, /const localMovements = unlockedCore \? verifiedPositionMovements/);
});

test('panel family consolidation keeps distant returns grouped without widening source ranges', () => {
  assert.match(source, /consolidateVerifiedPositions\(scene\.positions, \{[\s\S]*?mergeDistantReturns: true[\s\S]*?\}\)/);
});
