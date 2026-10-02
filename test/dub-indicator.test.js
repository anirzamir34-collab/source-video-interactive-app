import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `media controller exists: ${start}`);
  return source.slice(from, to);
}

const controllers = [
  section('function onTurkishMediaStatus(', '\nfunction renderMediaControls('),
  section('function renderMediaControls(', '\nfunction updateLanguageSyncControls('),
  section('function updateLanguageSyncControls(', '\nlet languageSyncSave')
].join('\n');

class Element {
  textContent = '';
  value = 0;
  disabled = false;
  dataset = {};
  children = [];
  attributes = new Map();
  classes = new Set(['hidden']);
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    contains: name => this.classes.has(name),
    toggle: (name, enabled) => {
      const next = enabled ?? !this.classes.has(name);
      if (next) this.classes.add(name); else this.classes.delete(name);
      return next;
    }
  };
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); delete this[name]; }
  querySelectorAll() { return this.children; }
}

function finishedMedia() {
  return {
    dubEnabled: true,
    subtitleTrack: 'dub_tr',
    syncOffset: 0.5,
    manifest: {
      version: 1,
      subtitles: { source_tr: [{ start: 1, end: 3, text: 'Kaynak TR' }],
        dub_tr: { cues: [{ start: 1, end: 3, text: 'Dublaj TR' }] } },
      assets: { mix: { url: '/api/turkish-media/jobs/ready-job/assets/mix' },
        sourceSrt: { url: '/api/turkish-media/jobs/ready-job/assets/source-srt' },
        dubVtt: { url: '/api/turkish-media/jobs/ready-job/assets/dub-vtt' } }
    }
  };
}

function fixture(initialCapture = null) {
  let captured = initialCapture;
  const els = new Proxy({}, { get(target, key) { return target[key] ||= new Element(); } });
  els.subtitleTrack.options = ['off', 'source_tr', 'dub_tr'].map(value => ({ value, disabled: false }));
  const exports = new Map(['sourceSrt', 'sourceVtt', 'dubSrt', 'dubVtt'].map(asset => {
    const link = new Element();
    link.dataset.mediaAsset = asset;
    return [asset, link];
  }));
  els.mediaExports.children = [...exports.values()];
  const state = { analysisInProgress: true, dubbingEnabled: false, subtitlesEnabled: false, languageSyncOffset: 0 };
  const events = [];
  const transcripts = [];
  const scope = vm.createContext({
    state, els,
    mediaClient: { capture: () => captured },
    updateSourceTranscript: value => transcripts.push(value),
    renderVoiceMappingPanel() {},
    logEngineEvent: (type, detail) => events.push({ type, detail: JSON.parse(JSON.stringify(detail)) })
  });
  vm.runInContext(controllers, scope);
  return { scope, state, els, events, transcripts, exports, setCapture: value => { captured = value; } };
}

test('pending jobs show progress and cancellation while finished mix controls stay unavailable', () => {
  const f = fixture();
  f.scope.renderMediaControls();
  const transcript = { utterances: [{ sourceText: 'Original speech', sourceStart: 1, sourceEnd: 3 }] };
  f.scope.onTurkishMediaStatus({ state: 'TRANSCRIBED', jobId: 'pending-job', progress: { percent: 37 },
    message: 'Kaynak konuşma hazır; Türkçe ses hazırlanıyor.', sourceTranscript: transcript });
  assert.equal(f.els.mediaJobStatus.classes.has('hidden'), false);
  assert.equal(f.els.mediaJobMessage.textContent, 'Kaynak konuşma hazır; Türkçe ses hazırlanıyor.');
  assert.equal(f.els.mediaJobProgress.value, 37);
  assert.equal(f.els.mediaJobCancelBtn.classes.has('hidden'), false);
  assert.equal(f.els.mediaJobRetryBtn.classes.has('hidden'), true);
  assert.equal(f.els.analysisState.textContent, 'TRANSCRIBED');
  assert.equal(f.els.analysisTitle.textContent, f.els.mediaJobMessage.textContent);
  assert.equal(f.els.dubToggleBtn.classes.has('hidden'), true);
  assert.equal(f.els.subtitleTrack.classes.has('hidden'), true);
  assert.equal(f.els.languageSyncControls.classes.has('hidden'), true);
  assert.equal(f.state.dubbingEnabled, false);
  assert.deepEqual(f.transcripts, [transcript]);
  assert.deepEqual(f.events, [{ type: 'TURKISH_MEDIA_STATUS', detail: { state: 'TRANSCRIBED', jobId: 'pending-job' } }]);
});

test('failed jobs display the actual failure and retry action without exposing playable audio', () => {
  const f = fixture();
  f.scope.renderMediaControls();
  f.scope.onTurkishMediaStatus({ state: 'FAILED', jobId: 'failed-job', progress: 43,
    message: 'Türkçe ses üretimi tamamlanamadı.', error: { code: 'SOURCE_AUDIO_FAILED', message: 'Source audio failed' } });
  assert.equal(f.els.mediaJobStatus.classes.has('hidden'), false);
  assert.equal(f.els.mediaJobMessage.textContent, 'Türkçe ses üretimi tamamlanamadı.');
  assert.equal(f.els.mediaJobProgress.value, 43);
  assert.equal(f.els.mediaJobCancelBtn.classes.has('hidden'), true);
  assert.equal(f.els.mediaJobRetryBtn.classes.has('hidden'), false);
  assert.equal(f.els.dubToggleBtn.classes.has('hidden'), true);
  assert.equal(f.els.dubBufferStatus.classes.has('hidden'), true, 'job failure uses the job panel');
  assert.equal(f.state.turkishMediaStatus.error.code, 'SOURCE_AUDIO_FAILED');
});

test('finished media enables both caption tracks, the final mix toggle, sync offset, and available export links', () => {
  const f = fixture(finishedMedia());
  f.scope.renderMediaControls();
  f.scope.onTurkishMediaStatus({ state: 'READY', jobId: 'ready-job', progress: 100, message: 'Türkçe medya hazır.' });
  assert.equal(f.state.dubbingEnabled, true);
  assert.equal(f.state.subtitlesEnabled, true);
  assert.equal(f.els.subtitleTrack.classes.has('hidden'), false);
  assert.equal(f.els.subtitleTrack.value, 'dub_tr');
  assert.deepEqual(f.els.subtitleTrack.options.map(option => option.disabled), [false, false, false]);
  assert.equal(f.els.dubToggleBtn.classes.has('hidden'), false);
  assert.equal(f.els.dubToggleBtn.textContent, 'TR DUBLAJ: AÇIK');
  assert.equal(f.els.dubToggleBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(f.els.languageSyncControls.classes.has('hidden'), false);
  assert.equal(f.els.languageSyncValue.textContent, 'Ses/yazı +0,50 sn');
  assert.equal(f.els.mediaJobCancelBtn.classes.has('hidden'), true);
  assert.equal(f.els.mediaJobRetryBtn.classes.has('hidden'), true);
  assert.equal(f.els.mediaExports.classes.has('hidden'), false);
  assert.equal(f.exports.get('sourceSrt').href, '/api/turkish-media/jobs/ready-job/assets/source-srt');
  assert.equal(f.exports.get('dubVtt').href, '/api/turkish-media/jobs/ready-job/assets/dub-vtt');
  assert.equal(f.exports.get('sourceVtt').classes.has('hidden'), true);
  assert.equal(f.exports.get('dubSrt').classes.has('hidden'), true);
});

test('subtitle-only results enable source captions and exports without showing final audio controls', () => {
  const media = finishedMedia();
  media.dubEnabled = false;
  media.subtitleTrack = 'source_tr';
  delete media.manifest.assets.mix;
  delete media.manifest.assets.dubVtt;
  media.manifest.subtitles.dub_tr = [];
  const f = fixture(media);
  f.scope.renderMediaControls();
  assert.equal(f.state.dubbingEnabled, false);
  assert.equal(f.state.subtitlesEnabled, true);
  assert.equal(f.els.subtitleTrack.value, 'source_tr');
  assert.deepEqual(f.els.subtitleTrack.options.map(option => option.disabled), [false, false, true]);
  assert.equal(f.els.dubToggleBtn.classes.has('hidden'), true);
  assert.equal(f.els.languageSyncControls.classes.has('hidden'), true);
  assert.equal(f.exports.get('sourceSrt').classes.has('hidden'), false);
  assert.equal(f.exports.get('dubVtt').classes.has('hidden'), true);
});

test('audio playback failures use a separate recovery overlay and preserve the completed job status', () => {
  for (const state of ['PLAYBACK_BLOCKED', 'PLAYBACK_FAILED']) {
    const f = fixture(finishedMedia());
    f.scope.renderMediaControls();
    f.scope.onTurkishMediaStatus({ state: 'READY', progress: 100, message: 'Türkçe medya hazır.' });
    f.scope.onTurkishMediaStatus({ state, message: 'Türkçe sesi yeniden dene veya kaynak sese geç.' });
    assert.equal(f.els.dubBufferStatus.classes.has('hidden'), false);
    assert.equal(f.els.dubBufferMessage.textContent, 'Türkçe sesi yeniden dene veya kaynak sese geç.');
    assert.equal(f.els.mediaJobMessage.textContent, 'Türkçe medya hazır.');
    assert.equal(f.els.mediaJobProgress.value, 100);
    assert.equal(f.els.mediaJobCancelBtn.classes.has('hidden'), true);
    assert.equal(f.els.mediaJobRetryBtn.classes.has('hidden'), true);
    assert.equal(f.state.dubbingEnabled, true, 'playback recovery does not silently switch output mode');
  }
});

test('unknown progress clears a previous percentage while keeping cancellation available', () => {
  const f = fixture();
  f.scope.onTurkishMediaStatus({ state: 'TRANSLATING', progress: 60 });
  f.scope.onTurkishMediaStatus({ state: 'GENERATING', message: 'Türkçe ses hazırlanıyor.' });
  assert.equal(Object.hasOwn(f.els.mediaJobProgress, 'value'), false);
  assert.equal(f.els.mediaJobCancelBtn.classes.has('hidden'), false);
});

test('clearing the source hides media controls and removes previous export URLs', () => {
  const f = fixture(finishedMedia());
  f.scope.renderMediaControls();
  f.setCapture(null);
  f.scope.renderMediaControls();
  assert.equal(f.state.dubbingEnabled, false);
  assert.equal(f.state.subtitlesEnabled, false);
  assert.equal(f.els.subtitleTrack.value, 'off');
  assert.deepEqual(f.els.subtitleTrack.options.map(option => option.disabled), [false, true, true]);
  assert.equal(f.els.dubToggleBtn.classes.has('hidden'), true);
  assert.equal(f.els.mediaExports.classes.has('hidden'), true);
  for (const link of f.exports.values()) {
    assert.equal(link.classes.has('hidden'), true);
    assert.equal(Object.hasOwn(link, 'href'), false);
  }
});
