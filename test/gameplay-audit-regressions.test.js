import test from 'node:test';
import assert from 'node:assert/strict';
import { playableAdultPanelFamily } from '../public/adult-gameplay.js';
import { choiceSurfaceForAction } from '../public/choice-routing.js';
import { verifiedOpeningCast } from '../public/scene-entry.js';

const position = overrides => ({
  sourceVerified: true, adultScene: false, actionType: 'position',
  positionId: 'missionary', positionLabel: 'Misyoner',
  startTime: 30, endTime: 40, confidence: 0.94,
  classificationReview: 'verified', ...overrides
});

test('a verified explicit position still reaches the game panel when the optional scene flag is omitted', () => {
  const source = position();
  const family = playableAdultPanelFamily(source);
  assert.equal(family, 'missionary');
  assert.equal(choiceSurfaceForAction(source, { panelFamily: family }), 'panel');
});

test('missing-scene-flag fallback never promotes dialogue, ordinary contact, speculation or unverified footage', () => {
  for (const source of [
    position({ sourceVerified: false }),
    position({ actionType: 'touch' }),
    position({ actionType: 'dialogue' }),
    position({ confidence: 0.5 }),
    position({ classificationReview: 'pending', positionEvidence: '' }),
    position({ positionId: '', positionLabel: '' })
  ]) {
    assert.equal(playableAdultPanelFamily(source), '');
  }
  assert.equal(choiceSurfaceForAction(position({ actionType: 'dialogue' })), 'story');
});

test('first-pass position evidence can support a high-confidence source position without an optional scene flag', () => {
  assert.equal(playableAdultPanelFamily(position({
    classificationReview: 'pending', positionEvidence: 'Verified footage interval'
  })), 'missionary');
});

test('standalone openings reuse only an explicit cast or a uniquely verified target track', () => {
  const characters = [{ participantTrackId: 'PARTNER_A', evidenceLevel: 'fact' }];
  const known = { sourceVerified: true, subjectTrackId: 'MAIN_MALE',
    partnerTrackId: 'PARTNER_A' };
  const expected = JSON.stringify(['MAIN_MALE', 'PARTNER_A', []]);
  assert.equal(verifiedOpeningCast(known, characters), expected);
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_A' }, characters), expected);
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_A',
    groupScene: true }, characters), '');
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_A',
    identityResolution: 'conflict' }, characters), '');
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_B' }, characters), '');
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_A' }, [
    ...characters, ...characters
  ]), '');
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_A' }, [
    { ...characters[0], identityConflict: true }
  ]), '');
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: '', primaryCharacterId: 'PARTNER_A' }, [
    { ...characters[0], evidenceLevel: 'inference' }
  ]), '');
  assert.equal(verifiedOpeningCast({ ...known, sourceVerified: false }, characters), '');
  assert.equal(verifiedOpeningCast({ ...known, subjectTrackId: '' }, characters), '');
  assert.equal(verifiedOpeningCast({ ...known, partnerTrackId: 'MAIN_MALE' }, characters), '');
});

test('camera cut metadata cannot erase an independently verified continuous position loop', () => {
  const shot = position({
    adultScene: true, actionType: 'camera_transition', positionId: 'rear',
    positionLabel: 'Rear', positionEvidence: 'Continuous identical pose across the recorded frames.',
    movementType: 'measured movement', positionConfigurationConfidence: .95,
    loopStartTime: 30, loopEndTime: 38
  });
  assert.equal(playableAdultPanelFamily(shot), 'rear');
  assert.equal(playableAdultPanelFamily({ ...shot, classificationReview: 'pending' }), '');
  assert.equal(playableAdultPanelFamily({ ...shot, loopEndTime: 32 }), '');
});
