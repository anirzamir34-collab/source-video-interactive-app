import test from 'node:test';
import assert from 'node:assert/strict';
import { savedGameOperationError } from '../public/saved-games-ui.js';

test('analysis quota failure is described as analysis failure, not lost storage', () => {
  const error = Object.assign(new Error('Provider reported a quota error'),
    { code: 'GEMINI_CREDITS_DEPLETED' });
  const copy = savedGameOperationError(error);
  assert.match(copy, /Gemini API kredisi veya proje kotası/);
  assert.match(copy, /Kayıtlı video ve mevcut analiz korunuyor/);
  assert.doesNotMatch(copy, /Kayıt işlemi tamamlanamadı/);
});

test('actual storage errors still explain the storage problem', () => {
  assert.match(savedGameOperationError(new DOMException('No space', 'QuotaExceededError')),
    /Cihazda yeterli boş alan yok/);
});
