import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { timelineChoicesAt, remainingClipsInRange } from '../public/playback-logic.js';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function handler(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  return tail.slice(0, tail.indexOf('\n}') + 2);
}
const action = (id, sceneId, startTime, endTime) => ({
  actionId: id, label: id, sceneId, startTime, endTime, sourceVerified: true
});

for (const offset of [0, 120, 3600]) {
  test(`scene ownership follows chronology at offset ${offset} with repeated ids`, () => {
    const actions = [action('first', 'room', offset, offset + 10),
      action('next', 'room', offset + 10, offset + 20),
      action('outside', 'garden', offset + 20, offset + 30),
      action('return', 'room', offset + 30, offset + 40),
      action('distant', 'room', offset + 200, offset + 210)];
    assert.deepEqual(timelineChoicesAt(actions, offset + 5).map(a => a.actionId), ['first', 'next']);
    assert.deepEqual(timelineChoicesAt(actions, offset + 25).map(a => a.actionId), ['outside']);
    assert.deepEqual(timelineChoicesAt(actions, offset + 35).map(a => a.actionId), ['return']);
    assert.deepEqual(timelineChoicesAt(actions, offset + 100), []);
  });
}

test('missing scene metadata never makes a whole-video option pool', () => {
  const actions = [action('a', '', 0, 10), action('b', '', 10, 20), action('c', '', 60, 70)];
  assert.deepEqual(timelineChoicesAt(actions, 5).map(a => a.actionId), ['a', 'b']);
  assert.deepEqual(timelineChoicesAt(actions, 30), []);
  assert.deepEqual(timelineChoicesAt(actions, 65).map(a => a.actionId), ['c']);
});

test('an overlong annotation cannot reopen an earlier scene across a newer boundary', () => {
  const actions = [action('overlong', 'room', 0, 100), action('outside', 'garden', 20, 30),
    action('return', 'room', 40, 60)];
  assert.deepEqual(timelineChoicesAt(actions, 10), []);
  assert.deepEqual(timelineChoicesAt(actions, 25).map(a => a.actionId), ['outside']);
  assert.deepEqual(timelineChoicesAt(actions, 35), []);
  assert.deepEqual(timelineChoicesAt(actions, 45).map(a => a.actionId), ['return']);
});

test('remaining clips exclude past, invalid, unverified and cross-boundary records', () => {
  const clips = [action('past', '', 10, 15), action('current', '', 15, 20),
    action('next', '', 20, 25), action('outside', '', 24, 35),
    { ...action('unknown', '', 20, 25), sourceVerified: false }, action('invalid', '', null, 25)];
  const original = structuredClone(clips);
  assert.deepEqual(remainingClipsInRange(clips, { startTime: 10, endTime: 30 }, 17).map(c => c.actionId), ['current', 'next']);
  assert.deepEqual(clips, original);
});

test('short narrative barriers and distant returns keep separate scene fragments', () => {
  const scope = vm.createContext({ ADULT_FRAGMENT_MERGE_GAP_SECONDS: 1.5 });
  vm.runInContext(handler('mergeAdultSceneFragments'), scope);
  const chapters = [{ id: 'a', startTime: 0, endTime: 10 },
    { id: 'b', startTime: 11, endTime: 20 }, { id: 'c', startTime: 100, endTime: 110 }];
  assert.equal(scope.mergeAdultSceneFragments(chapters).length, 2);
  const barrier = { startTime: 10, endTime: 11, actionType: 'dialogue', sourceVerified: true };
  assert.equal(scope.mergeAdultSceneFragments(chapters, [barrier]).length, 3);
});

class Element extends EventTarget {
  classes = new Set();
  classList = { add: (...items) => items.forEach(i => this.classes.add(i)), remove() {} };
  pause() { this.paused = true; }
  load() {}
  removeAttribute(name) { delete this[name]; }
  remove() {}
}

function fixture() {
  const state = { sourceGeneration: 1, selectedFile: { name: 'old.mp4' },
    analysisSession: { sourceKey: 'old' }, analysis: { actions: [] }, dialogue: { segments: ['old'] },
    adultSelectionToken: 0, adultSeekRequestId: 0, adultMode: true,
    adultScene: { id: 'old-scene' }, activeAction: { actionId: 'old' }, videoObjectUrl: 'blob:old',
    navigationSeekController: new AbortController(), adultSeekController: new AbortController(),
    activeAdultPreludeId: 'old-clip', panelPendingClipStart: 80 };
  const els = new Proxy({ video: new Element() }, { get(target, key) { return target[key] ||= new Element(); } });
  const storage = { removeItem() {} };
  const scope = vm.createContext({ state, els, DOMException, File, performance, clearTimeout,
    localStorage: storage, sessionStorage: storage, RUNTIME_SAVE_KEY: 'test',
    URL: { revokeObjectURL() {}, createObjectURL: file => `blob:${file.name}` },
    resetDubState() {}, setGameState: value => { state.gameState = value; },
    updateAnalyzeAvailability() {}, renderDebug() {}, resolveUrlBtn: { disabled: false },
    videoUrlInput: { value: 'https://example.com/video' }, setUrlStatus() {}, remoteVideoFileName: () => 'remote.mp4',
    fetch: () => new Promise(resolve => { state.completeResolve = resolve; }),
    probeSeekableVideo: async () => ({ seekable: true }),
    downloadUrlVideo: () => new Promise(resolve => { state.completeDownload = resolve; }) });
  vm.runInContext(['cancelTimelineNavigation', 'cancelAdultSeek', 'clearPanelPlaybackRecovery',
    'clearPreviousGameResidue', 'releaseVideoObjectUrl', 'selectLocalVideoFile', 'resolveVideoUrl',
    'ensureSelectedRemoteFile'].map(handler).join('\n'), scope);
  return scope;
}

test('a new file clears old options, listeners and both pending media operations', () => {
  const f = fixture();
  const nav = f.state.navigationSeekController;
  const panel = f.state.adultSeekController;
  let calls = 0;
  f.state.stopListener = () => { calls += 1; };
  f.els.video.addEventListener('timeupdate', f.state.stopListener);
  const file = new File(['new'], 'new.mp4', { type: 'video/mp4' });
  f.selectLocalVideoFile(file);
  f.els.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(calls, 0);
  assert.equal(nav.signal.aborted, true);
  assert.equal(panel.signal.aborted, true);
  for (const key of ['analysis', 'analysisSession', 'dialogue', 'adultScene', 'activeAction', 'activeAdultPreludeId', 'panelPendingClipStart']) {
    assert.equal(f.state[key], null, key);
  }
  assert.equal(f.state.selectedFile, file);
  assert.equal(f.els.video.src, 'blob:new.mp4');
  assert.equal(f.els.playerSection.classes.has('hidden'), true);
  assert.equal(f.state.sourceGeneration, 2);
});

for (const ok of [true, false]) {
  test(`a late URL response cannot replace a newer local source (ok=${ok})`, async () => {
    const f = fixture();
    const pending = f.resolveVideoUrl();
    const file = new File(['new'], 'new.mp4');
    f.selectLocalVideoFile(file);
    f.state.completeResolve({ ok, json: async () => ({ ok, type: 'video', sourceUrl: 'https://example.com/old.mp4', proxyUrl: '/old' }) });
    await pending;
    assert.equal(f.state.selectedFile, file);
    assert.equal(f.els.video.src, 'blob:new.mp4');
    assert.equal(f.resolveUrlBtn.disabled, false);
  });
}

test('a late remote download cannot attach its file to the next source', async () => {
  const f = fixture();
  f.state.selectedFile = null;
  f.state.selectedRemoteVideo = { proxyUrl: '/old', sourceUrl: 'https://example.com/old', fileName: 'old.mp4' };
  const pending = f.ensureSelectedRemoteFile();
  const file = new File(['new'], 'new.mp4');
  f.selectLocalVideoFile(file);
  f.state.completeDownload(new Blob(['old'], { type: 'video/mp4' }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.state.selectedFile, file);
});
