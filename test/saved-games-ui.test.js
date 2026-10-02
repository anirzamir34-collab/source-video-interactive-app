import test from 'node:test';
import assert from 'node:assert/strict';
import { savedGameOperationError, savedGameHasDub, mountSavedGames } from '../public/saved-games-ui.js';

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

test('the shelf advertises dubbing only when a real stored final mix is present', () => {
  assert.equal(savedGameHasDub({ dubCount: 40 }), false);
  assert.equal(savedGameHasDub({ dubReady: true, mixBytes: 0 }), false);
  assert.equal(savedGameHasDub({ dubReady: false, mixBytes: 100 }), false);
  assert.equal(savedGameHasDub({ dubReady: true, mixBytes: 100 }), true);
});

function deferred() {
  let resolve;
  return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) };
}

function uiFixture(t, capture) {
  const original = new Map(['document', 'window', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const element = () => ({ textContent: '', value: '', placeholder: '', disabled: false, files: [], children: [],
    classList: { toggle() {} }, listeners: new Map(), addEventListener(name, callback) { this.listeners.set(name, callback); },
    replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
  const selectors = ['games-list', 'games-status', 'games-storage', 'game-title', 'games-import', 'games-count', 'game-save', 'game-export-current', 'games-import-button'];
  const elements = new Map(selectors.map(name => [`[data-${name}]`, element()]));
  const root = { querySelector: selector => elements.get(selector), querySelectorAll: () => [...elements.values()] };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {} } });
  t.after(() => { for (const [name, descriptor] of original) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const saved = [], busy = [];
  const store = { list: async () => [], save: async input => { saved.push(input); return { id: 'saved-id' }; },
    updateLanguageSync: async (id, offset) => ({ id, offset }) };
  const ui = mountSavedGames({ root, capture, store, openGame() {}, isBusy: () => false,
    onBusy: value => busy.push(value), onSaved() {}, onDeleted() {} });
  return { ui, saved, busy, elements };
}

test('saving waits for asynchronous capture to materialize the final audio Blob', async t => {
  const prepared = deferred();
  const f = uiFixture(t, () => prepared.promise);
  const saving = f.ui.saveCurrent();
  await Promise.resolve();
  assert.equal(f.saved.length, 0);
  assert.equal(f.elements.get('[data-game-save]').disabled, true);
  const audio = new Blob(['final mix'], { type: 'audio/wav' });
  prepared.resolve({ title: 'Yeni oyun', fileName: 'source.mp4', video: new Blob(['source']), dubAudio: audio });
  assert.equal(await saving, true);
  assert.equal(f.saved[0].dubAudio, audio);
  assert.deepEqual(f.busy, [true, false]);
  assert.deepEqual(await f.ui.setSyncOffset('saved-id', 1.25), { id: 'saved-id', offset: 1.25 });
});

test('late asynchronous capture cannot reenable controls after a newer source has no completed game', async t => {
  const previous = deferred();
  let current = previous.promise;
  const f = uiFixture(t, () => current);
  const old = f.ui.refreshControls();
  current = null;
  await f.ui.refreshControls();
  previous.resolve({ title: 'Eski kaynak', fileName: 'old.mp4' });
  await old;
  assert.equal(f.elements.get('[data-game-save]').disabled, true);
  assert.equal(f.elements.get('[data-game-export-current]').disabled, true);
  assert.equal(f.elements.get('[data-game-title]').disabled, true);
});
