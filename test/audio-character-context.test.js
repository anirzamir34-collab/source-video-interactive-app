import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the actual client audio branch with a simulated provider; no credits
// or media uploads are consumed by these regression tests.
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  session.audioContextStatus =');
const end = source.indexOf('  const remoteStoryboardSource', start);
assert.ok(start >= 0 && end > start);
const branch = source.slice(start, end);
const dialogue = { segments: [{ originalText: 'My name is Meral.', speakerId: 'voice-1', startTime: 1, endTime: 3 }], speakers: [{ speakerId: 'voice-1' }] };

async function run(session = {}, fail = false) {
  let requests = 0;
  const node = () => ({ textContent: '', classList: { toggle() {}, add() {}, remove() {} } });
  const state = { subtitlesEnabled: false, dubbingEnabled: false };
  const scope = vm.createContext({ session, state, file: { name: 'source.mp4' },
    modes: { motion: true, subtitles: false, dubbing: false },
    els: { subtitleToggleBtn: node(), subtitleSpeaker: node(), subtitleText: node(), subtitleOverlay: node(),
      analysisState: node(), analysisOutput: node() },
    selectedRemoteToken: () => '', logEngineEvent() {},
    analyzeSelectedDialogue: async () => { requests += 1; if (fail) throw Error('Unavailable'); return dialogue; }
  });
  await vm.runInContext(`(async () => { ${branch} })()`, scope);
  return { requests, state, session };
}

test('motion-only analysis obtains speech context while leaving subtitles and dubbing disabled', async () => {
  const result = await run();
  assert.equal(result.requests, 1);
  assert.equal(result.state.dialogue, dialogue);
  assert.equal(result.session.audioContextStatus, 'ready');
  assert.equal(result.state.subtitlesEnabled, false);
  assert.equal(result.state.dubbingEnabled, false);
});

test('reanalyzing the same video reuses the already extracted speech', async () => {
  const result = await run({ dialogue });
  assert.equal(result.requests, 0);
  assert.equal(result.state.dialogue, dialogue);
});

test('a speech failure remains explicit and does not fabricate identity data or stop visual-only analysis', async () => {
  const result = await run({}, true);
  assert.equal(result.requests, 1);
  assert.equal(result.session.audioContextStatus, 'unavailable');
  assert.equal(result.state.dialogue, undefined);
});
