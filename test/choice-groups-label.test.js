import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDisplayLabel } from '../public/choice-groups.js';

test('verified provider position label is preserved instead of a canonical fallback', () => {
  assert.equal(sourceDisplayLabel({
    sourceVerified: true,
    positionLabel: 'Kucakta yüz yüze',
    partnerLabel: 'Koyu renk saçlı'
  }, 'Kovboy Pozisyonu'), 'Kucakta yüz yüze');
});

test('partner suffix is added only when the caller explicitly needs disambiguation', () => {
  const group = { sourceVerified: true, positionLabel: 'Misyoner', partnerLabel: 'Partner A' };
  assert.equal(sourceDisplayLabel(group, 'Misyoner Pozisyonu'), 'Misyoner');
  assert.equal(sourceDisplayLabel(group, 'Misyoner Pozisyonu', { distinguishPartner: true }), 'Misyoner');
  assert.equal(sourceDisplayLabel({ ...group, partnerLabel: 'Meral' }, 'Misyoner Pozisyonu',
    { distinguishPartner: true }), 'Misyoner · Meral');
});
