import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('requested dubbing keeps its player status control visible while analysis is preparing', () => {
  assert.match(source, /if \(modes\.dubbing\) \{[\s\S]*?dubToggleBtn\.classList\.remove\('hidden'\)[\s\S]*?TR DUBLAJ: HAZIRLANIYOR/);
});

test('requested dubbing exposes incomplete dialogue analysis instead of silently hiding the control', () => {
  assert.match(source, /modes\.dubbing && !dialogue\.segments\.length[\s\S]*?TR DUBLAJ: KONUŞMA ANALİZİ EKSİK/);
  assert.match(source, /dataset\.unavailable = 'true'/);
});

test('successful dialogue analysis restores an enabled dubbing indicator', () => {
  assert.match(source, /modes\.dubbing && dialogue\.segments\.length[\s\S]*?delete els\.dubToggleBtn\.dataset\.unavailable[\s\S]*?TR DUBLAJ: AÇIK/);
});
