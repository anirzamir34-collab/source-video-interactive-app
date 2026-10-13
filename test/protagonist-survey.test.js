import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProtagonistSurvey, surveySheetIndices } from '../public/protagonist-survey.js';

test('full-video survey samples beginning, middle and end, not only the first chapter', () => {
  assert.deepEqual(surveySheetIndices(1), [0]);
  assert.deepEqual(surveySheetIndices(5), [0, 1, 2, 3, 4]);
  const sampled = surveySheetIndices(31);
  assert.equal(sampled.length, 8);
  assert.equal(sampled[0], 0);
  assert.equal(sampled.at(-1), 30);
  assert.ok(sampled.some(n => n > 10 && n < 20));
});

test('survey can lock the sole clearly observed adult male even when the first sample has none', () => {
  const survey = normalizeProtagonistSurvey({ visibleAdultMale: true, maleCount: 1,
    unambiguous: true, confidence: .95,
    protagonistProfile: 'Yetişkin erkek, kısa koyu saç ve sakal, birkaç sonraki bölümde görünür.',
    visualEvidence: 'Video geneline yayılmış karelerde tekrar görünür.' });
  assert.equal(survey.resolved, true);
  assert.match(survey.profile, /erkek/i);
});

test('ambiguous survey or missing source evidence does not lock a background male', () => {
  for (const value of [
    { visibleAdultMale: false, maleCount: 0, unambiguous: false, confidence: 0 },
    { visibleAdultMale: true, maleCount: 2, unambiguous: false, confidence: .92,
      protagonistProfile: 'İlk karede erkek', visualEvidence: 'Yalnızca ilk karede' },
    { visibleAdultMale: true, maleCount: 2, unambiguous: true, confidence: .55,
      protagonistProfile: 'Arka plandaki erkek', visualEvidence: 'Bir kare' },
    { visibleAdultMale: true, maleCount: 1, unambiguous: true, confidence: .95,
      protagonistProfile: 'Bilinmeyen erkek', visualEvidence: '' },
  ]) {
    assert.equal(normalizeProtagonistSurvey(value).resolved, false);
    assert.equal(normalizeProtagonistSurvey(value).profile, '');
  }
});
