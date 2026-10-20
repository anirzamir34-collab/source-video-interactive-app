import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntensityTrack, measuredMovementFlavors, isVocalSound, intensityRate } from '../public/intensity-engine.js';
import { movementFlavor } from '../public/movement-tempo.js';

const profile = Array.from({ length: 60 }, (_, t) => [t, t >= 40 ? 80 : t < 20 ? 10 : 30]);

test('moans, breaths and sound-only lines count as voice; real sentences do not', () => {
  assert.ok(isVocalSound({ text: '(moaning)' }));
  assert.ok(isVocalSound({ text: 'ahh ahh mmm' }));
  assert.ok(isVocalSound({ kind: 'vocalization', text: 'x' }));
  assert.equal(isVocalSound({ text: 'Bunu bana neden söylemedin?' }), false);
});

test('intensity follows measured motion and rises with moans', () => {
  const track = buildIntensityTrack({ motionProfile: profile, audioEvents: [{ text: '(moans)', start: 45, end: 47 }], duration: 60 });
  assert.ok(track.at(50).motion > track.at(10).motion);
  assert.ok(track.at(46).voice > 0.5 && track.at(5).voice === 0);
  assert.ok(track.at(46).value > track.at(10).value);
  assert.ok(intensityRate(track.at(46)) > intensityRate(track.at(10)));
});

test('parts of a position that really move faster or slower get tempo flavors', () => {
  const track = buildIntensityTrack({ motionProfile: profile, duration: 60 });
  const parts = [[0, 12], [20, 32], [25, 37], [44, 56]].map(([start, end], index) =>
    ({ id: `p${index}`, loopStartTime: start, loopEndTime: end, movementTempo: 'moderate' }));
  const flavors = measuredMovementFlavors(parts, track);
  assert.equal(flavors.get('p0'), 'slow');
  assert.equal(flavors.get('p3'), 'fast');
  assert.equal(movementFlavor({ ...parts[3], measuredFlavor: flavors.get('p3') }), 'fast');
  assert.equal(movementFlavor({ movementTempo: 'slow', measuredFlavor: 'fast' }), 'slow', 'the analysis wins when it is explicit');
});
