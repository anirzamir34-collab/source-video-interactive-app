import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildDubSpeakerRoster, validateDubVoicePlan, dubSpeakerKey } from '../public/dub-speakers.js';
import { allocateSpeakerVoices } from '../lib/voice-allocation.js';
import { activeDubSegments, dubSpeechEnd } from '../public/dub-overlap.js';

const speakers = [{ speakerId: 'ayse', gender: 'female' }, { speakerId: 'elif', gender: 'female' },
  { speakerId: 'ali', gender: 'male' }, { speakerId: 'can', gender: 'male' }];
const voices = ['female', 'female', 'male', 'male'].map((gender, index) => ({ voice_id: `voice-${index}`, gender, name: `Voice ${index}` }));
const options = { genderOf: voice => voice.gender, score: (voice, gender) => voice.gender === gender ? 100 : 0 };
const line = (speakerId, startTime = 0, endTime = 5) => ({ speakerId, startTime, endTime, turkishText: 'Merhaba.' });

test('two women and two men receive four unique voices regardless of catalog order', () => {
  const plan = allocateSpeakerVoices(speakers, voices, options);
  assert.equal(new Set(plan.map(row => row.voiceId)).size, 4);
  for (const row of plan) assert.equal(voices.find(voice => voice.voice_id === row.voiceId).gender, row.gender);
  assert.deepEqual(allocateSpeakerVoices(speakers, [...voices].reverse(), options), plan);
  assert.equal(validateDubVoicePlan(speakers, plan).size, 4);
});

test('speaker identity keeps one gender across uncertain lines and isolated conflicting annotations', () => {
  const segments = [
    { ...line('a', 0, 10), gender: 'female', confidence: 0.9 },
    { ...line('a', 12, 13), gender: 'male', confidence: 0.3 },
    { ...line('b'), gender: 'uncertain' }
  ];
  assert.deepEqual(buildDubSpeakerRoster(segments, [{ speakerId: 'b', gender: 'male' }]), [
    { speakerId: 'a', gender: 'female' }, { speakerId: 'b', gender: 'male' }
  ]);
});

test('zero-confidence labels cannot outweigh grounded speaker evidence', () => {
  const segments = [
    { ...line('a', 0, .5), gender: 'male', confidence: .9 },
    { ...line('a', 1, 15), gender: 'female', confidence: 0 },
    { ...line('b'), gender: 'female', confidence: 0 }
  ];
  assert.deepEqual(buildDubSpeakerRoster(segments, [{ speakerId: 'b', gender: 'male' }]), [
    { speakerId: 'a', gender: 'male' }, { speakerId: 'b', gender: 'male' }
  ]);
});

test('matching reserves scarce voices and never gives unknown speakers an already assigned voice', () => {
  const roster = [{ speakerId: 'unknown', gender: 'uncertain' }, ...speakers.slice(0, 2)];
  const catalog = [voices[0], voices[1], voices[2]];
  const plan = allocateSpeakerVoices(roster, catalog, options);
  assert.equal(plan[0].voiceId, voices[2].voice_id);
  assert.equal(new Set(plan.map(row => row.voiceId)).size, 3);
});

test('retry preserves exact previous assignments; missing or duplicate pinned voices fail visibly', () => {
  const previous = allocateSpeakerVoices(speakers, voices, options);
  assert.deepEqual(allocateSpeakerVoices(speakers, [{ voice_id: 'better', gender: 'female' }, ...voices], { ...options, previous }), previous);
  assert.throws(() => allocateSpeakerVoices(speakers, voices.slice(1), { ...options, previous }), /atanmış bir ses/);
  assert.throws(() => allocateSpeakerVoices(speakers, voices, { ...options, previous: [previous[0], { ...previous[1], voiceId: previous[0].voiceId }] }), /atanmış bir ses/);
});

test('insufficient voices never fall back to shared gender voices or partial assignments', () => {
  assert.throws(() => allocateSpeakerVoices(speakers, voices.slice(0, 3), options), /yeterli farklı/);
  const plan = allocateSpeakerVoices(speakers, voices, options);
  assert.throws(() => validateDubVoicePlan(speakers, plan.slice(0, 3)), /eksik/);
  plan[1].voiceId = plan[0].voiceId;
  assert.throws(() => validateDubVoicePlan(speakers, plan), /ayrı ve sabit/);
});

test('unknown catalog metadata cannot outrank a known matching voice or silently replace it', () => {
  const roster = [{ speakerId: 'a', gender: 'male' }];
  const unknown = { voice_id: 'unknown', gender: 'uncertain' };
  const opts = { ...options, score: voice => voice.voice_id === 'unknown' ? 1000 : 1 };
  assert.equal(allocateSpeakerVoices(roster, [unknown, voices[2]], opts)[0].voiceId, voices[2].voice_id);
  assert.throws(() => allocateSpeakerVoices(roster, [unknown, voices[0]], opts), /yeterli farklı/);
});

test('simultaneous speakers retain full speech windows while one speaker never talks over itself', () => {
  const segments = [line('a', 0, 5), line('b', 1, 3), line('a', 4, 7)];
  assert.equal(activeDubSegments(segments, 2).length, 2);
  assert.deepEqual(activeDubSegments(segments, 4.5), [segments[2]]);
  assert.equal(dubSpeechEnd(segments[0], segments), 4);
  assert.equal(dubSpeechEnd(segments[1], segments), 3);
});

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('client voice planning uses original timed evidence instead of the first annotation of a merged block', async () => {
  const raw = [{ ...line('a', 0, .5), gender: 'female', confidence: .4 },
    { ...line('a', .5, 10), gender: 'male', confidence: .95 }];
  const state = { dialogue: { segments: raw, dubSegments: [{ ...raw[0], endTime: 10 }] },
    dubRequestController: new AbortController(), dubSpeakerVoices: new Map() };
  let requested;
  const context = vm.createContext({ state, buildDubSpeakerRoster, validateDubVoicePlan, dubSpeakerKey,
    AbortSignal, dubTimeline: () => state.dialogue.dubSegments, elevenLabsHeaders: value => value,
    fetch: async (_url, request) => {
      requested = JSON.parse(request.body).speakers;
      return { ok: true, json: async () => ({ available: true, assignments: allocateSpeakerVoices(requested, voices, options) }) };
    }
  });
  vm.runInContext(fn('ensureDubVoicePlan'), context);
  const plan = await context.ensureDubVoicePlan();
  assert.deepEqual(requested, [{ speakerId: 'a', gender: 'male' }]);
  assert.equal(plan.get('a').gender, 'male');
});

test('concurrent client requests share one complete voice plan and obsolete results cannot overwrite it', async () => {
  let finish;
  let requests = 0;
  const assignments = allocateSpeakerVoices(speakers, voices, options);
  const state = { dialogue: { segments: speakers.map(row => ({ ...line(row.speakerId), gender: row.gender })) },
    dubRequestController: new AbortController(), dubSpeakerVoices: new Map() };
  const context = vm.createContext({ state, buildDubSpeakerRoster, validateDubVoicePlan, dubSpeakerKey,
    AbortSignal, dubTimeline: () => state.dialogue.segments, elevenLabsHeaders: value => value,
    fetch: async () => { requests++; return new Promise(resolve => { finish = resolve; }); }
  });
  vm.runInContext(fn('ensureDubVoicePlan'), context);
  const first = context.ensureDubVoicePlan();
  const second = context.ensureDubVoicePlan();
  await tick();
  assert.equal(requests, 1);
  finish({ ok: true, json: async () => ({ available: true, assignments }) });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(one.size, 4);
  await context.ensureDubVoicePlan();
  assert.equal(requests, 1);
  state.dubSpeakerVoices = new Map();
  const stale = context.ensureDubVoicePlan();
  state.dubRequestController.abort();
  state.dubRequestController = new AbortController();
  state.dialogue = { segments: [line('new')] };
  finish({ ok: true, json: async () => ({ available: true, assignments }) });
  assert.equal(await stale, null);
  assert.equal(state.dubSpeakerVoices.size, 0);
});

test('overlapping captions show every current speaker and preserve text without HTML interpretation', () => {
  const span = () => ({ textContent: '', classList: { add() {}, remove() {} } });
  const els = { video: { currentTime: 2 }, subtitleOverlay: span(), subtitleSpeaker: span(), subtitleText: span() };
  const state = { subtitlesEnabled: true, dialogue: { segments: [
    { ...line('a'), speakerName: 'Ayşe', turkishText: '<Merhaba>' },
    { ...line('b', 1, 3), speakerName: 'Elif', turkishText: 'Nasılsın?' }
  ] } };
  const context = vm.createContext({ state, els, activeDubSegments, dubSpeakerKey });
  vm.runInContext(fn('renderSubtitle'), context);
  context.renderSubtitle();
  assert.equal(els.subtitleText.textContent, 'Ayşe: <Merhaba>\nElif: Nasılsın?');
  assert.equal(els.subtitleSpeaker.textContent, '');
  els.video.currentTime = 4;
  context.renderSubtitle();
  assert.equal(els.subtitleSpeaker.textContent, 'Ayşe');
  assert.equal(els.subtitleText.textContent, '<Merhaba>');
});
