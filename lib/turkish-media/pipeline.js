import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashKey } from './cache.js';
import { normalizeScribeTranscript, applySpeakerHints, assertSegmentCoverage } from './model.js';
import { buildSubtitleTracks, normalizeDubWords, toSrt, toWebVtt } from './subtitles.js';
import { translationScenes } from './translation.js';
import { createDirectDubbing } from './direct-dubbing.js';
import { mapSpeakerVoices } from './voice-mapping.js';
import { MediaError } from './errors.js';
import { createStageLogger, configuredLogSecrets } from './stage-logging.js';
import { nativeDialogueWords, fitNativeDialogueWords } from './dialogue-alignment.js';
import { dubEndLimit, dubTimingGroups, planDubWindows, dubTimingDiagnostics, DUB_TIMING_VERSION } from './timing.js';

const mediaLogStages = ['source_audio', 'scribe', 'speaker_mapping', 'turkish_translation',
  'elevenlabs_v4', 'forced_alignment', 'subtitle_generation', 'final_mix'];
const cacheLogStages = { 'source-audio': 'source_audio', transcript: 'scribe',
  translation: 'turkish_translation', 'duration-translation': 'turkish_translation',
  'voice-map': 'speaker_mapping', dialogue: 'elevenlabs_v4', 'duration-regeneration': 'elevenlabs_v4' };

export async function sourceFileHash(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function splitDialogueText(text, characterLimit) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > characterLimit) {
    const window = remaining.slice(0, characterLimit + 1);
    const boundaries = [...window.matchAll(/[.!?…](?:\s+|$)/gu)];
    const sentenceEnd = boundaries.at(-1);
    const whitespace = [...window.matchAll(/\s+/gu)].filter(match => match.index <= characterLimit).at(-1);
    let cut = sentenceEnd ? sentenceEnd.index + sentenceEnd[0].length : whitespace?.index;
    if (cut > characterLimit) cut = whitespace?.index;
    if (!(cut > 0)) throw new MediaError('DIALOGUE_WORD_TOO_LONG', 'Tek kelime sağlayıcının metin sınırını aşıyor.');
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

export function dialogueBatches(utterances, translations, voiceMapping, { characterLimit = 2000, voiceLimit = 10 } = {}) {
  characterLimit = Math.min(2000, Math.floor(characterLimit));
  if (!(characterLimit > 0)) throw new MediaError('DIALOGUE_TEXT_LIMIT', 'Sağlayıcının metin sınırı geçersiz.');
  const translated = new Map(translations.map(row => [row.segmentId, row]));
  const batches = [];
  let current = [];
  let count = 0;
  for (const utterance of utterances) {
    const row = translated.get(utterance.segmentId);
    if (!row?.translatedText) throw new MediaError('DIALOGUE_TRANSLATION_MISSING', 'Dublaj için Türkçe konuşma eksik.', { segmentIds: [utterance.segmentId] });
    const voiceId = voiceMapping[utterance.speakerId];
    if (!voiceId) throw new MediaError('VOICE_MAPPING_MISSING', 'Konuşmacı için ses ataması bulunamadı.');
    const parts = splitDialogueText(row.translatedText, characterLimit);
    for (const [partIndex, text] of parts.entries()) {
    const voices = new Set([...current.map(turn => turn.voice_id), voiceId]);
    const previous = current.at(-1);
    if (current.length && (count + text.length > characterLimit || voices.size > voiceLimit ||
      (previous.segmentId !== utterance.segmentId && utterance.sourceStart < Math.max(...current.map(turn => turn.sourceEnd)) - 0.04) ||
      utterance.sourceStart - previous.sourceEnd > 12)) {
      batches.push(current); current = []; count = 0;
    }
    current.push({ ...utterance, text, voice_id: voiceId, partIndex, partCount: parts.length });
    count += text.length;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

async function settleStage(tasks, cancellation) {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve(task).catch(error => {
    if ([401, 403].includes(error?.status) || /^(?:PROVIDER_HTTP_40[13]|ELEVENLABS_.*PERMISSION_MISSING|GEMINI_CREDITS_EXHAUSTED)$/.test(error?.code || ''))
      cancellation?.abort(error);
    throw error;
  })));
  const failed = results.find(row => row.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(row => row.value);
}

function normalizedWords(words, text, duration, offset, segmentId, windowEnd) {
  if (!Array.isArray(words) || !words.length) throw new MediaError('ALIGNMENT_MISSING_WORDS', 'Türkçe ses için kelime hizalaması bulunamadı.', { segmentIds: [segmentId] });
  const normalized = words.map(word => {
    const start = Number(word.start), end = Number(word.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.05) {
      throw new MediaError('ALIGNMENT_INVALID_TIMING', 'Üretilen sesin hizalama zamanları geçersiz.', { segmentIds: [segmentId] });
    }
    return { text: String(word.text || ''), start: offset + start, end: offset + Math.min(end, duration) };
  });
  const canonical = value => String(value).normalize('NFC').toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]/gu, '');
  if (canonical(normalized.map(word => word.text).join('')) !== canonical(text)) {
    throw new MediaError('ALIGNMENT_TEXT_MISMATCH', 'Hizalama bütün Türkçe kelimeleri korumadı.', { segmentIds: [segmentId] });
  }
  return normalizeDubWords(normalized, { start: offset, end: windowEnd, segmentId });
}

export function createTurkishMediaPipeline({ config, cache, limiter, elevenLabs, translationProvider, directDubbing, audio, log }) {
  return async function runPipeline(input, { signal: callerSignal, onStage = async () => {}, stats = {}, jobId, onLog = log } = {}) {
    const cancellation = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, cancellation.signal]) : cancellation.signal;
    const privateTexts = new Set();
    const protectText = text => { if (typeof text === 'string' && text.length) privateTexts.add(text); };
    const protectRows = value => {
      protectText(value?.text);
      for (const row of Array.isArray(value) ? value : value?.utterances || []) {
        protectText(row.sourceText); protectText(row.translatedText); protectText(row.displaySubtitleText);
      }
    };
    const logging = createStageLogger({ jobId, write: onLog, secrets: configuredLogSecrets(config),
      privateValues: () => [...privateTexts] });
    return logging.run('pipeline', {}, async () => {
    const leases = new Map();
    const lease = key => { if (!leases.has(key)) leases.set(key, cache.acquireLease(key)); };
    const qa = { sourceDuration: null, detectedLanguage: null, speakerCount: 0,
      sourceUtteranceCount: 0, translatedUtteranceCount: 0, generatedDubCount: 0,
      missingDubCount: 0, subtitleCueCount: 0, alignmentSuccessRate: null, failedSegments: [] };
    try {
      Object.assign(stats, { cacheHits: stats.cacheHits || 0, elevenLabsRequestCount: stats.elevenLabsRequestCount || 0, retryCount: stats.retryCount || 0 });
      const completedStages = new Set();
      let previousStage;
      const stage = (state, progress, message, extra = {}) => {
        // Transitions happen only after the previous work has resolved. The
        // legacy overall percentage remains for older clients; current UI uses
        // only measured counts in stageProgress, never those stage weights.
        if (previousStage && previousStage !== state) completedStages.add(previousStage);
        previousStage = state;
        return onStage({ state, progress, message, stageProgress: null,
          completedStages: [...completedStages], qualityReport: { ...qa, ...stats }, ...extra });
      };
      const sourceHash = input.source.hash || await sourceFileHash(input.source.path);
      const sourceIdentity = { sourceHash, version: config.version,
        ...(Number.isFinite(input.source.timelineDuration) ? { timelineDuration: input.source.timelineDuration } : {}) };
      const identity = { ...sourceIdentity,
        ...(config.credentialScope ? { credentialScope: config.credentialScope } : {}) };
      const finalKey = hashKey({ ...identity, stage: 'final-package', outputs: input.outputs, playbackFormat: input.outputs?.dub ? 'mp3-ducked-v6-speaker-fundamental' : 'mp3-ducked-v5-voice-profile',
        qualityMode: input.qualityMode || config.qualityMode, language: config.language,
        sttModel: config.elevenLabs.sttModel, diarizationThreshold: 0.32,
        dubModel: config.elevenLabs.dubModel, fastModel: config.elevenLabs.fastModel,
        translationProvider: config.translation.provider,
        translationModel: config.translation.model, translationVersion: config.translationVersion,
        outputFormat: config.elevenLabs.outputFormat, manualVoices: input.voiceMapping || {}, previousVoices: input.previousVoiceMapping || {},
        speakerHints: input.speakerHints || {}, sceneContext: input.sceneContext || [], dictionary: [config.elevenLabs.pronunciationDictionaryId, config.elevenLabs.pronunciationDictionaryVersionId],
        maxTempo: config.maxTempo, timingVersion: DUB_TIMING_VERSION });
      const completed = await cache.get(finalKey);
      if (completed) {
        stats.cacheHits += 1;
        for (const name of mediaLogStages) {
          const noDub = !input.outputs?.dub && ['speaker_mapping', 'elevenlabs_v4', 'forced_alignment', 'final_mix'].includes(name);
          const noSpeech = !completed.sourceTranscript.utterances.length && ['speaker_mapping', 'turkish_translation', 'elevenlabs_v4', 'forced_alignment'].includes(name);
          logging.instant(name, { cacheScope: 'final-package' }, { outcome: noDub || noSpeech ? 'skipped' : 'cache_hit',
            reason: noDub ? 'dub_not_requested' : noSpeech ? 'no_source_speech' : 'final_package_reused' });
        }
        return { ...completed, artifactKey: finalKey, qualityReport: { ...completed.qualityReport,
          cacheHits: stats.cacheHits, elevenLabsRequestCount: 0, retryCount: 0,
          geminiRequestCount: 0, geminiUsage: { requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 } } };
      }
      const workDirectory = input.directory;
      await fs.mkdir(workDirectory, { recursive: true });
      const cached = async (keyData, work) => {
        const access = async ({ setOutcome = () => {} } = {}) => {
        const key = hashKey(keyData);
        lease(key);
        let cacheOutcome = 'shared_result';
        let value = await cache.get(key);
        if (value) {
          stats.cacheHits += 1; protectRows(value); setOutcome('cache_hit');
          return { key, value, cacheOutcome: 'cache_hit' };
        }
        value = await cache.singleFlight(key, async () => {
          const existing = await cache.get(key);
          if (existing) { stats.cacheHits += 1; cacheOutcome = 'cache_hit'; return existing; }
          cacheOutcome = 'completed';
          const result = await work(key);
          protectRows(result.value);
          await cache.put(key, result.value, { artifacts: result.artifacts || {} });
          return result.value;
        });
        protectRows(value); setOutcome(cacheOutcome);
        return { key, value, cacheOutcome };
        };
        const name = cacheLogStages[keyData.stage];
        return name ? logging.run(name, { cacheScope: keyData.stage, model: keyData.model,
          segmentId: keyData.segmentId, segmentIds: (keyData.scene?.utterances || keyData.turns || []).map(row => row.segmentId),
          purpose: keyData.stage }, access) : access();
      };
      await stage('PREPARING_AUDIO', 5, 'Kaynak ses, video zaman çizelgesi korunarak hazırlanıyor.');
      // Separate cache version: older completed WAV-based media jobs remain
      // intact; new MP3-only uploads can reuse one small source file for both
      // Scribe and FFmpeg's sample-accurate decoder/mix filter graph.
      const prepared = await cached({ ...sourceIdentity, stage: 'source-audio', extractionMode: 'native-mp3-direct-bed-v2' }, async () => {
        const result = await audio.extractSource(input.source, { directory: workDirectory, signal });
        const nativeMp3 = result.originalPath === result.sttPath &&
          path.extname(result.originalPath).toLowerCase() !== '.wav';
        const originalArtifact = nativeMp3 ? 'original.mp3' : 'original.wav';
        const speechArtifact = nativeMp3 ? originalArtifact
          : path.extname(result.sttPath).toLowerCase() === '.mp3' ? 'speech.mp3'
            : path.extname(result.sttPath).toLowerCase() === '.m4a' ? 'speech.m4a' : 'speech.flac';
        return {
          value: { duration: result.duration, originalArtifact, speechArtifact },
          artifacts: { [originalArtifact]: { path: result.originalPath },
            ...(speechArtifact === originalArtifact ? {} : { [speechArtifact]: { path: result.sttPath } }) }
        };
      });
      const originalPath = await cache.getArtifactPath(prepared.key, prepared.value.originalArtifact || 'original.wav');
      const sttPath = prepared.value.speechArtifact === prepared.value.originalArtifact ? originalPath
        : await cache.getArtifactPath(prepared.key, prepared.value.speechArtifact || 'speech.flac');
      if (!originalPath || !sttPath) throw new MediaError('SOURCE_CACHE_CORRUPT', 'Hazırlanan kaynak ses dosyası bulunamadı.');
      const duration = prepared.value.duration;
      qa.sourceDuration = duration;
      await stage('TRANSCRIBING', 15, 'Scribe v2 bütün kaynak konuşmaları çözümlüyor.');
      const transcriptEntry = await cached({ ...identity, stage: 'transcript', model: config.elevenLabs.sttModel,
        diarize: true, diarizationThreshold: 0.32 }, async () => ({
        value: normalizeScribeTranscript(await elevenLabs.transcribe(sttPath, { signal }), { sourceHash, duration }),
      }));
      const transcript = input.outputs?.transcriptOnly
        ? transcriptEntry.value
        : applySpeakerHints(transcriptEntry.value, input.speakerHints || {});
      if (input.outputs?.dub && !input.outputs?.transcriptOnly &&
          transcript.speakers.some(speaker => !['male', 'female'].includes(speaker.gender)) &&
          typeof audio.inferSpeakerProfiles === 'function') {
        const profiles = await audio.inferSpeakerProfiles(originalPath, transcript, { signal });
        for (const speaker of transcript.speakers) {
          if (['male', 'female'].includes(speaker.gender)) continue;
          const profile = profiles[speaker.speakerId];
          if (!['male', 'female'].includes(profile?.gender)) continue;
          speaker.gender = profile.gender;
          speaker.profileEvidence = profile.evidence;
          for (const utterance of transcript.utterances) {
            if (utterance.speakerId === speaker.speakerId) utterance.gender = profile.gender;
          }
        }
      }
      Object.assign(qa, { sourceDuration: duration, detectedLanguage: transcript.language,
        speakerCount: transcript.speakers.length, sourceUtteranceCount: transcript.utterances.length,
        unverifiedSpeakerIds: transcript.speakers.filter(speaker => !['male', 'female'].includes(speaker.gender))
          .map(speaker => speaker.speakerId),
        missingDubCount: input.outputs?.dub ? transcript.utterances.length : 0 });
      await stage('DIARIZING', 30, 'Kaynak konuşmacı kimlikleri ve kelime zamanları hazır.', { sourceTranscript: transcript });
      if (input.outputs?.transcriptOnly) {
        for (const name of mediaLogStages.slice(2)) logging.instant(name, {}, { outcome: 'skipped', reason: 'transcript_only' });
        return { version: 1, sourceTranscript: transcript, translatedUtterances: [], voiceMapping: {}, dubSegments: [],
          subtitles: { source_tr: [], dub_tr: [] }, assets: {}, qualityReport: { sourceDuration: duration,
            detectedLanguage: transcript.language, speakerCount: transcript.speakers.length, sourceUtteranceCount: transcript.utterances.length,
            translatedUtteranceCount: 0, generatedDubCount: 0, missingDubCount: 0, transcriptOnly: true, ...stats } };
      }
      if (['elevenlabs', 'elevenlabs_v1'].includes(input.outputs?.dubbingProvider)) {
        if (!input.outputs.dub) throw new MediaError('DIRECT_DUBBING_REQUIRES_AUDIO', 'Doğrudan dublaj için Türkçe ses çıktısı seçilmeli.');
        await stage('TRANSLATING', 38, 'ElevenLabs sesi doğrudan Türkçeye çevirip dublajlıyor.');
        const direct = await directDubbing({
          audioPath: input.source.path, directory: workDirectory, jobId, signal, duration,
          modelId: input.outputs.dubbingProvider === 'elevenlabs_v1' ? 'dubbing_v1' : 'dubbing_v2',
          resume: input.directDubbingResume,
          onProject: async value => {
            await stage('TRANSLATING', 40, 'ElevenLabs Türkçe dublaj projesi hazırlanıyor.', { directDubbingProject: value });
          },
          onProgress: () => stage('SYNTHESIZING', 72, 'ElevenLabs Türkçe sesi üretiyor.'),
        });
        const mix = await audio.prepareDirectDub(direct.dubbedPath, { duration, directory: workDirectory, signal });
        const subtitles = input.outputs.subtitles === false ? { source_tr: [], dub_tr: [] } : direct.subtitles;
        const artifacts = input.outputs.subtitles === false ? {} : direct.artifacts;
        artifacts['mix.mp3'] = { path: mix.path };
        const translations = direct.rows.map(row => ({
          segmentId: row.segmentId, speakerId: row.speakerId, sourceStart: row.start, sourceEnd: row.end,
          translatedText: row.text, displaySubtitleText: row.text, sourceText: row.sourceText,
        }));
        const qualityReport = {
          sourceDuration: duration, detectedLanguage: transcript.language, speakerCount: transcript.speakers.length,
          sourceUtteranceCount: transcript.utterances.length, translatedUtteranceCount: translations.length,
          generatedDubCount: direct.rows.length, missingDubCount: 0,
          subtitleCueCount: subtitles.source_tr.length + subtitles.dub_tr.length,
          skippedTranscriptSegments: direct.skippedTranscriptSegments,
          subtitleUnavailable: direct.subtitleUnavailable, mix: mix.qa,
          dubbingProvider: input.outputs.dubbingProvider, dubbingModel: direct.modelId, failedSegments: [], ...stats,
        };
        const result = { version: 1, outputs: input.outputs, sourceTranscript: transcript,
          translatedUtterances: translations, voiceMapping: {}, dubSegments: [], subtitles, assets: {},
          qualityReport, artifactKey: finalKey };
        await stage('PACKAGING', 98, 'Doğrudan dublaj ve altyazı kaydediliyor.');
        await cache.put(finalKey, result, { artifacts });
        await stage('PACKAGING', 100, direct.subtitleUnavailable
          ? 'Türkçe dublaj hazır; ElevenLabs altyazı zamanlarını döndürmedi.' : 'Doğrudan Türkçe dublaj hazır.');
        return result;
      }
      await stage('TRANSLATING', 35, 'Konuşmalar sahne bağlamı ve kaynak süreleriyle Türkçeye çevriliyor.');
      const scenes = translationScenes(transcript).map(scene => ({ ...scene, sceneContext: (input.sceneContext || []).filter(context =>
        Number(context.startTime) <= scene.utterances.at(-1).sourceEnd && Number(context.endTime) >= scene.utterances[0].sourceStart) }));
      let translatedScenes = 0;
      await stage('TRANSLATING', 35, 'Türkçe çeviri yanıtları bekleniyor.', {
        stageProgress: { loaded: 0, total: scenes.length, unit: 'bölüm' } });
      if (!scenes.length) logging.instant('turkish_translation', {}, { outcome: 'skipped', reason: 'no_source_speech' });
      const translationKey = scene => ({ ...identity, stage: 'translation', scene, language: config.language,
        model: config.translation.model, translationVersion: config.translationVersion });
      // Keep the original scene cache key for completed work from earlier runs.
      // Large Scribe scenes can exceed Gemini's combined thinking/output budget;
      // store smaller parts individually so a later failure never bills them again.
      const translateSceneSafely = async scene => {
        signal?.throwIfAborted();
        const utterances = scene.utterances;
        const characters = utterances.reduce((sum, row) => sum + row.sourceText.length, 0);
        const split = async () => {
          const middle = Math.floor(utterances.length / 2);
          const scoped = rows => ({
            ...scene, utterances: rows,
            sceneContext: (scene.sceneContext || []).filter(context =>
              Number(context.startTime) <= rows.at(-1).sourceEnd &&
              Number(context.endTime) >= rows[0].sourceStart),
          });
          const parts = [
            { ...scoped(utterances.slice(0, middle)),
              nextContext: [...utterances.slice(middle, middle + 6), ...(scene.nextContext || [])].slice(0, 6) },
            { ...scoped(utterances.slice(middle)),
              previousContext: [...(scene.previousContext || []), ...utterances.slice(Math.max(0, middle - 6), middle)].slice(-6) },
          ];
          const rows = [];
          for (const part of parts) {
            signal?.throwIfAborted();
            const entry = await cached(translationKey(part), async () => ({
              value: await translateSceneSafely(part)
            }));
            rows.push(...entry.value);
          }
          return rows;
        };
        if (utterances.length > 12 || characters > 1600 && utterances.length > 1) return split();
        try {
          const rows = await translationProvider.translateScene(scene, { signal });
          protectRows(rows);
          return rows;
        } catch (error) {
          if (utterances.length > 1 && ['TRANSLATION_INCOMPLETE', 'TRANSLATION_INVALID_JSON',
            'TRANSLATION_MISSING_SEGMENTS', 'TRANSLATION_SEGMENT_MISMATCH'].includes(error?.code)) return split();
          throw error;
        }
      };
      const translations = (await settleStage(scenes.map(scene => limiter.run(async () => {
        const result = await cached(translationKey(scene), async () => ({
          value: await translateSceneSafely(scene)
        }));
        translatedScenes += 1;
        await stage('TRANSLATING', 35, 'Tamamlanan Türkçe çeviri bölümleri alındı.', {
          stageProgress: { loaded: translatedScenes, total: scenes.length, unit: 'bölüm' } });
        return result.value;
      }, { signal })), cancellation)).flat();
      assertSegmentCoverage(transcript, translations);
      qa.translatedUtteranceCount = translations.length;
      const dubRequested = input.outputs?.dub === true;
      let voiceMapping = {}, dubSegments = [], mix = null;
      if (dubRequested && transcript.utterances.length) {
        await stage('ASSIGNING_VOICES', 45, 'ElevenLabs ses kataloğu kontrol ediliyor ve konuşmacılar eşleştiriliyor.');
        const qualityMode = input.qualityMode || config.qualityMode;
        const capability = await elevenLabs.validateCapabilities({ qualityMode, language: config.language, signal });
        const voiceEntry = await cached({ ...identity, stage: 'voice-map', manual: input.voiceMapping || {},
          previous: input.previousVoiceMapping || {}, speakers: transcript.speakers }, async () => ({ value: mapSpeakerVoices(
            transcript.speakers, await elevenLabs.listVoices({ signal }), input.previousVoiceMapping, input.voiceMapping,
          ) }));
        voiceMapping = voiceEntry.value;
        const characterLimit = Math.min(2000, capability?.maxTextLength || 2000);
        const dictionary = [config.elevenLabs.pronunciationDictionaryId, config.elevenLabs.pronunciationDictionaryVersionId];
        const model = qualityMode === 'fast' ? config.elevenLabs.fastModel : config.elevenLabs.dubModel;
        const segmentKeys = new Map(), finishedSegments = new Map();
        const timingGroups = dubTimingGroups(transcript);
        const timingIdentities = new Map();
        for (const group of timingGroups) {
          const identity = group.map(turn => ({ segmentId: turn.segmentId, start: turn.sourceStart, end: turn.sourceEnd,
            text: translations.find(row => row.segmentId === turn.segmentId).translatedText }));
          for (const turn of group) timingIdentities.set(turn.segmentId, identity);
        }
        const completedSegmentKey = (turn, text) => hashKey({ ...identity, stage: 'completed-dub-segment', model,
          voiceId: voiceMapping[turn.speakerId], sourceStart: turn.sourceStart, sourceEnd: turn.sourceEnd,
          text, outputFormat: config.elevenLabs.outputFormat, translationVersion: config.translationVersion,
          dictionary, wordTiming: input.outputs?.subtitles !== false, maxTempo: config.maxTempo,
          timingVersion: DUB_TIMING_VERSION, timingGroup: timingIdentities.get(turn.segmentId) });
        for (const turn of transcript.utterances) {
          const translation = translations.find(row => row.segmentId === turn.segmentId);
          const key = completedSegmentKey(turn, translation.translatedText);
          segmentKeys.set(turn.segmentId, key);
          lease(key);
          const ready = await cache.get(key);
          if (ready) {
            const audioPath = await cache.getArtifactPath(key, 'segment.wav');
            if (audioPath) {
              let words;
              try { words = input.outputs?.subtitles === false ? [] : normalizeDubWords(ready.dub.words, { start: ready.dub.start,
                end: ready.dub.end, segmentId: turn.segmentId }); }
              catch (error) {
                if (!['INVALID_DUB_WORD_ALIGNMENT', 'DUB_WORD_ALIGNMENT_REQUIRED'].includes(error?.code)) throw error;
                logging.instant('dialogue_timing', { segmentId: turn.segmentId },
                  { outcome: 'skipped', reason: 'invalid_cached_word_clock' });
                continue;
              }
              stats.cacheHits += 1;
              Object.assign(translation, ready.translation);
              finishedSegments.set(turn.segmentId, { ...ready.dub, words, audioPath });
              for (const name of ['elevenlabs_v4', 'forced_alignment']) logging.instant(name,
                { segmentId: turn.segmentId, cacheScope: 'completed-dub-segment' }, { outcome: 'cache_hit', reason: 'completed_segment_reused' });
            }
          }
        }
        // A partial phrase cache cannot reserve obsolete internal boundaries.
        // Refit that phrase from its cached generated audio as a whole.
        for (const group of timingGroups) if (group.some(turn => finishedSegments.has(turn.segmentId)) &&
          !group.every(turn => finishedSegments.has(turn.segmentId)))
          for (const turn of group) finishedSegments.delete(turn.segmentId);
        const batches = dialogueBatches(transcript.utterances.filter(turn => !finishedSegments.has(turn.segmentId)),
          translations, voiceMapping, { characterLimit });
        let renderedBatches = 0;
        await stage('GENERATING_DUB', 50, 'ElevenLabs v4 ses üretim yanıtı bekleniyor.', {
          stageProgress: { loaded: 0, total: batches.length, unit: 'ses bölümü' } });
        async function renderBatch(turns, purpose = 'dialogue') {
          for (const turn of turns) protectText(turn.text);
          const generationIdentity = { ...identity, stage: purpose, model,
            outputFormat: config.elevenLabs.outputFormat, language: config.language,
            turns: turns.map(turn => ({ segmentId: turn.segmentId, speakerId: turn.speakerId, text: turn.text, voiceId: turn.voice_id })),
            translationVersion: config.translationVersion, dictionary };
          const readyPieces = new Map(), pieceKeys = new Map();
          for (const turn of turns) {
            const key = hashKey({ ...identity, stage: 'generated-turn', purpose, model,
              segmentId: turn.segmentId, partIndex: turn.partIndex, text: turn.text, voiceId: turn.voice_id,
              outputFormat: config.elevenLabs.outputFormat, translationVersion: config.translationVersion, dictionary });
            pieceKeys.set(turn, key); lease(key);
            const ready = await cache.get(key);
            if (ready) {
              const audioPath = await cache.getArtifactPath(key, 'turn.wav');
              if (audioPath) {
                stats.cacheHits += 1; readyPieces.set(turn, { ...turn, model: ready.model, audioPath,
                  nativeWords: ready.nativeWords, nativeDuration: ready.nativeDuration });
                logging.instant('elevenlabs_v4', { segmentId: turn.segmentId, count: 1, purpose, cacheScope: 'generated-turn' },
                  { outcome: 'cache_hit', reason: 'generated_turn_reused' });
              }
            }
          }
          // Upgrade earlier cached turns from the original generation response,
          // without synthesizing them again or requiring Forced Alignment access.
          if ([...readyPieces.values()].some(part => !part.nativeWords)) {
            const previous = await cache.get(hashKey(generationIdentity));
            if (previous?.nativeAlignment) for (const [index, turn] of turns.entries()) {
              const part = readyPieces.get(turn);
              if (!part || part.nativeWords) continue;
              const duration = await audio.probeDuration(part.audioPath, { signal });
              const words = nativeDialogueWords(previous.nativeAlignment, previous.voiceSegments, index, turn.text, duration);
              if (words) {
                Object.assign(part, { nativeWords: words, nativeDuration: duration });
                await cache.put(pieceKeys.get(turn), { model: part.model, nativeWords: words, nativeDuration: duration },
                  { artifacts: { 'turn.wav': { path: part.audioPath } } });
              }
            }
          }
          if (readyPieces.size === turns.length) return turns.map(turn => readyPieces.get(turn));
          if (readyPieces.size) {
            const missing = turns.filter(turn => !readyPieces.has(turn));
            const generated = await renderBatch(missing, purpose);
            return turns.map(turn => readyPieces.get(turn) || generated.find(row =>
              row.segmentId === turn.segmentId && row.partIndex === turn.partIndex));
          }
          const batchDirectory = path.join(workDirectory, `${purpose}-${hashKey(turns).slice(0, 16)}`);
          await fs.mkdir(batchDirectory, { recursive: true });
          const generation = await cached(generationIdentity, async () => {
            const generated = await elevenLabs.synthesizeDialogue(turns, { qualityMode, signal });
            return { value: { voiceSegments: generated.voiceSegments, nativeAlignment: generated.alignment,
              model: generated.model, mimeType: generated.mimeType, outputFormat: generated.outputFormat },
              artifacts: { 'dialogue.audio': generated.audio } };
          });
          const generatedPath = await cache.getArtifactPath(generation.key, 'dialogue.audio');
          const split = await audio.splitDialogueTurns(generatedPath, { voiceSegments: generation.value.voiceSegments,
            inputCount: turns.length, directory: batchDirectory, signal });
          if (split.length !== turns.length) throw new MediaError('DUB_MISSING_SEGMENTS', 'Üretilen sesin konuşma sayısı kaynakla eşleşmiyor.');
          const results = [];
          for (const [index, turn] of turns.entries()) {
            const part = split.find(row => row.dialogueInputIndex === index);
            if (!part) throw new MediaError('DUB_MISSING_SEGMENTS', 'Dublaj konuşması bulunamadı.', { segmentIds: [turn.segmentId] });
            const nativeWords = nativeDialogueWords(generation.value.nativeAlignment, generation.value.voiceSegments,
              index, turn.text, part.duration);
            const timing = { nativeWords, nativeDuration: part.duration };
            await cache.put(pieceKeys.get(turn), { model: generation.value.model, ...timing }, { artifacts: { 'turn.wav': { path: part.audioPath } } });
            results.push({ ...turn, audioPath: part.audioPath, model: generation.value.model, ...timing });
          }
          return results;
        }
        // Generate bounded scene requests first, then rejoin any long utterance
        // fragments before fitting and aligning its original canonical segment.
        let rendered = (await settleStage(batches.map(turns => limiter.run(async () => {
          const pieces = await renderBatch(turns);
          renderedBatches += 1;
          await stage('GENERATING_DUB', 50, 'Üretilen Türkçe ses bölümleri alındı.', {
            stageProgress: { loaded: renderedBatches, total: batches.length, unit: 'ses bölümü' } });
          return pieces;
        }, { signal })), cancellation)).flat();
        let complete = finishedSegments.size;
        qa.generatedDubCount = complete;
        qa.missingDubCount = transcript.utterances.length - complete;
        const fittedTurns = new Map();
        const fitInputs = new Map();
        const unfinishedTurns = transcript.utterances.filter(turn => !finishedSegments.has(turn.segmentId));
        const durationError = error => ['DUB_DURATION_TOO_LONG', 'DUB_REGENERATE_REQUIRED', 'DUB_REGENERATION_REQUIRED', 'AUDIO_REGENERATION_REQUIRED'].includes(error?.code);
        async function prepareFits(turns, { adaptiveTempo = false } = {}) {
          const failures = [];
          const fitMessage = adaptiveTempo ? 'Konuşmaların temposu kaynak süreye uyarlanıyor.' : 'Konuşma süreleri ve duraklamaları düzenleniyor.';
          await stage('ALIGNING', 60, fitMessage, { stageProgress: {
            loaded: fittedTurns.size + finishedSegments.size, total: transcript.utterances.length, unit: 'konuşma' } });
          await settleStage(turns.map(turn => limiter.run(async () => {
            const parts = rendered.filter(row => row.segmentId === turn.segmentId).sort((a, b) => a.partIndex - b.partIndex);
            if (!parts.length || parts.length !== parts[0].partCount) throw new MediaError('DUB_MISSING_SEGMENTS', 'Konuşma parçaları eksik.', { segmentIds: [turn.segmentId] });
            const segmentDirectory = path.join(workDirectory, `segment-${hashKey(turn.segmentId).slice(0, 16)}`);
            await fs.mkdir(segmentDirectory, { recursive: true });
            const signature = hashKey(parts.map(row => ({ path: row.audioPath, text: row.text })));
            if (fitInputs.get(turn.segmentId)?.signature === signature) return;
            const turnPath = parts.length === 1 ? parts[0].audioPath :
              (await audio.joinDialogueParts(parts.map(row => row.audioPath), { directory: segmentDirectory, signal })).path;
            const translation = translations.find(row => row.segmentId === turn.segmentId);
            const native = fitNativeDialogueWords(parts, translation.translatedText, { tempo: 1,
              duration: parts.reduce((sum, part) => sum + (part.nativeDuration || 0), 0) });
            const speechRange = native ? { start: Math.min(...native.map(word => word.start)), end: Math.max(...native.map(word => word.end)) } : undefined;
            const rawDuration = parts.every(part => part.nativeDuration > 0) ?
              parts.reduce((sum, part) => sum + part.nativeDuration, 0) : await audio.probeDuration(turnPath, { signal });
            const measuredDuration = speechRange ? Math.min(rawDuration, speechRange.end + .03) - Math.max(0, speechRange.start - .03) : rawDuration;
            fitInputs.set(turn.segmentId, { parts, turnPath, native, speechRange, measuredDuration, signature });
          }, { signal })), cancellation);
          const durations = new Map([...fitInputs].map(([id, input]) => [id, input.measuredDuration]));
          const windows = planDubWindows(transcript, durations, config.maxTempo);
          await settleStage(turns.map(turn => limiter.run(async () => {
            const input = fitInputs.get(turn.segmentId);
            const { parts, turnPath, native, speechRange } = input;
            let { start, end } = windows.get(turn.segmentId);
            const previous = fittedTurns.get(turn.segmentId);
            if (previous?.signature === input.signature && previous.start === start && previous.windowEnd === end) return;
            const fit = stop => logging.run('duration_fit', { segmentId: turn.segmentId,
              purpose: adaptiveTempo ? 'adaptive-fit' : 'preferred-fit', actualDuration: input.measuredDuration,
              targetDuration: stop - start }, () => audio.fitDubSegment(turnPath, { targetDuration: stop - start,
                maxTempo: config.maxTempo, speechRange, speechWords: native, adaptiveTempo, signal }));
            const windowEnd = end;
            if (adaptiveTempo && start === turn.sourceStart && end === turn.sourceEnd)
              end = Math.min(dubEndLimit(transcript, turn), Math.max(end, start + input.measuredDuration));
            let fitted;
            try { fitted = await fit(end); }
            catch (error) {
              if (!durationError(error)) throw error;
              const actual = error.actualDuration || await audio.probeDuration(turnPath, { signal });
              const limit = dubEndLimit(transcript, turn);
              if (start === turn.sourceStart && windowEnd === turn.sourceEnd && limit > end &&
                (adaptiveTempo || actual <= (limit - start) * config.maxTempo)) {
                end = Math.min(limit, Math.max(end, start + actual));
                try { fitted = await fit(end); }
                catch (next) { if (!durationError(next)) throw next; }
              }
              if (!fitted) { fittedTurns.delete(turn.segmentId); failures.push({ turn, actual, targetDuration: end - start }); return; }
            }
            fittedTurns.set(turn.segmentId, { parts, fitted, start, end, windowEnd, signature: input.signature });
            await stage('ALIGNING', 60, fitMessage, { stageProgress: {
              loaded: fittedTurns.size + finishedSegments.size, total: transcript.utterances.length, unit: 'konuşma' } });
          }, { signal })), cancellation);
          return failures.sort((a, b) => a.turn.sourceStart - b.turn.sourceStart);
        }
        let failures = await prepareFits(unfinishedTurns);
        // A long Turkish sentence squeezed into a short verified window can
        // sound clipped at 3–5x tempo. Reword only such measured outliers, once,
        // and only if the provider returns a materially shorter full sentence.
        // Short answers cannot be shortened without losing source information.
        const shortenCandidates = failures.filter(({ turn, actual, targetDuration }) =>
          actual > targetDuration * 1.8 &&
          String(translations.find(row => row.segmentId === turn.segmentId)?.translatedText || '').length > 18);
        if (shortenCandidates.length) {
          const rewritten = await settleStage(shortenCandidates.map(({ turn, actual, targetDuration }) => limiter.run(async () => {
            const original = translations.find(row => row.segmentId === turn.segmentId);
            const revised = await cached({ ...identity, stage: 'duration-translation', segmentId: turn.segmentId,
              originalText: original.translatedText, actual, targetDuration,
              translationVersion: config.translationVersion }, async () => {
              const rows = await translationProvider.translateScene({ utterances: [turn], speakers: transcript.speakers,
                sceneContext: (input.sceneContext || []).filter(row =>
                  Number(row.startTime) < turn.sourceEnd && Number(row.endTime) > turn.sourceStart) }, {
                signal, shorten: true,
                previousTranslations: { [turn.segmentId]: original.translatedText },
                measuredDurations: { [turn.segmentId]: actual },
                targetDurations: { [turn.segmentId]: targetDuration }
              });
              protectRows(rows);
              assertSegmentCoverage({ utterances: [turn] }, rows);
              return { value: rows[0] };
            });
            return { turn, original, candidate: revised.value };
          }, { signal })), cancellation);
          const changed = rewritten.filter(({ original, candidate }) =>
            candidate?.translatedText && candidate.translatedText.length <= original.translatedText.length * .85);
          if (changed.length) {
            await stage('ALIGNING', 60, 'Uzun Türkçe replikler kaynak süreye uygun biçimde yeniden söyleniyor.');
            for (const { turn, original, candidate } of changed) {
              Object.assign(original, candidate);
              segmentKeys.set(turn.segmentId, completedSegmentKey(turn, original.translatedText));
              fitInputs.delete(turn.segmentId);
              fittedTurns.delete(turn.segmentId);
            }
            const changedIds = new Set(changed.map(row => row.turn.segmentId));
            rendered = rendered.filter(row => !changedIds.has(row.segmentId));
            const changedTurns = changed.map(row => row.turn);
            const freshBatches = dialogueBatches(changedTurns, translations, voiceMapping, { characterLimit });
            rendered.push(...(await settleStage(freshBatches.map(batch => limiter.run(() =>
              renderBatch(batch, 'duration-regeneration'), { signal })), cancellation)).flat());
            qa.shortenedDubCount = changed.length;
            failures = [
              ...failures.filter(row => !changedIds.has(row.turn.segmentId)),
              ...await prepareFits(changedTurns)
            ];
          }
        }
        if (failures.length) {
          await stage('ALIGNING', 60, 'Kalan konuşmaların temposu kaynak süreye uyarlanıyor.', {
            stageProgress: { loaded: fittedTurns.size + finishedSegments.size, total: transcript.utterances.length, unit: 'konuşma' } });
          const remaining = await prepareFits(unfinishedTurns, { adaptiveTempo: true });
          if (remaining.length) throw new MediaError('DUB_FIT_FAILED', 'Ses süreleri dönüştürücü tarafından doğrulanamadı.',
            { status: 422, segmentIds: remaining.map(row => row.turn.segmentId) });
        }
        qa.adaptiveTempoCount = [...fittedTurns.values()].filter(row => row.fitted.tempo > config.maxTempo).length;
        qa.maxDubTempo = Math.max(1, ...[...fittedTurns.values()].map(row => row.fitted.tempo));
        await stage('ALIGNING', 60, 'Konuşma süreleri ve gerçek kelime zamanları eşleştiriliyor.', {
          stageProgress: { loaded: complete, total: transcript.utterances.length, unit: 'konuşma' } });
        dubSegments = await settleStage(transcript.utterances.map(turn => limiter.run(async () => {
          signal?.throwIfAborted();
          if (finishedSegments.has(turn.segmentId)) return finishedSegments.get(turn.segmentId);
          const translation = translations.find(row => row.segmentId === turn.segmentId);
          const voiceId = voiceMapping[turn.speakerId];
          const segmentKey = segmentKeys.get(turn.segmentId);
          const { parts, fitted, start, end } = fittedTurns.get(turn.segmentId);
          const nativeWords = fitNativeDialogueWords(parts, translation.translatedText, fitted);
          await stage('ALIGNING', 60 + Math.round(complete / transcript.utterances.length * 20),
            input.outputs?.subtitles === false ? 'Türkçe ses kaynak süreye yerleştiriliyor.' : nativeWords ? 'ElevenLabs ses zamanları kaynak konuşmalara yerleştiriliyor.' : 'Kelime hizalama yanıtı bekleniyor.', {
            stageProgress: { loaded: complete, total: transcript.utterances.length, unit: 'konuşma' } });
          const fittedHash = await sourceFileHash(fitted.path);
          protectText(translation.translatedText);
          const { audioPath, words } = input.outputs?.subtitles === false
            ? { audioPath: fitted.path, words: [] }
            : await logging.run(nativeWords ? 'dialogue_timing' : 'forced_alignment', { segmentId: turn.segmentId }, async ({ setOutcome }) => {
          const aligned = await cached({ ...identity, stage: 'alignment', audioHash: fittedHash, text: translation.translatedText,
            segmentId: turn.segmentId }, async () => ({ value: nativeWords ? { words: nativeWords, source: 'dialogue-timestamps' }
              : await elevenLabs.align(fitted.path, translation.translatedText, { signal }),
              artifacts: { 'fitted.wav': { path: fitted.path } } }));
          setOutcome(aligned.cacheOutcome);
          const audioPath = await cache.getArtifactPath(aligned.key, 'fitted.wav');
          const words = normalizedWords(aligned.value.words, translation.translatedText, fitted.duration, start, turn.segmentId, end);
          return { audioPath, words };
          });
          const dub = { segmentId: turn.segmentId, speakerId: turn.speakerId, start, end,
            originalSpeechStart: turn.sourceStart, originalSpeechEnd: turn.sourceEnd, tempo: fitted.tempo,
            duration: fitted.duration, words, audioHash: fittedHash, model, voiceId };
          await cache.put(segmentKey, { dub, translation }, { artifacts: { 'segment.wav': { path: audioPath } } });
          complete += 1;
          qa.generatedDubCount = complete;
          qa.missingDubCount = transcript.utterances.length - complete;
          qa.alignmentSuccessRate = input.outputs?.subtitles === false ? null : complete / transcript.utterances.length;
          await stage('ALIGNING', 80, input.outputs?.subtitles === false ? 'Konuşmanın ses süresi doğrulandı.' : 'Tamamlanan konuşmaların kelime zamanları doğrulandı.', {
            stageProgress: { loaded: complete, total: transcript.utterances.length, unit: 'konuşma' } });
          return { ...dub, audioPath };
        }, { signal })), cancellation);
        dubSegments.sort((a, b) => a.start - b.start);
        assertSegmentCoverage(transcript, translations, dubSegments);
      } else {
        for (const name of ['speaker_mapping', 'elevenlabs_v4', 'forced_alignment']) logging.instant(name, {},
          { outcome: 'skipped', reason: dubRequested ? 'no_source_speech' : 'dub_not_requested' });
      }
      let subtitles = { source_tr: [], dub_tr: [] }, textArtifacts = {};
      if (input.outputs?.subtitles !== false) {
        await stage('BUILDING_SUBTITLES', 85, 'Türkçe altyazılar hazırlanıyor.');
        ({ subtitles, textArtifacts } = await logging.run('subtitle_generation', {}, async () => {
          const subtitles = buildSubtitleTracks(transcript, translations, dubSegments);
          qa.subtitleCueCount = subtitles.source_tr.length + subtitles.dub_tr.length;
          const textArtifacts = {};
          for (const [track, cues] of Object.entries(subtitles)) {
            textArtifacts[`${track}.srt`] = Buffer.from(toSrt(cues), 'utf8');
            textArtifacts[`${track}.vtt`] = Buffer.from(toWebVtt(cues), 'utf8');
          }
          return { subtitles, textArtifacts };
        }));
      } else logging.instant('subtitle_generation', {}, { outcome: 'skipped', reason: 'subtitles_not_requested' });
      if (dubRequested) {
        await stage('MIXING_AUDIO', 92, 'Kaynak ambience ve Türkçe ses, video zaman çizelgesinde birleştiriliyor.');
        mix = await logging.run('final_mix', { count: dubSegments.length }, () =>
          audio.mixAudio({ sourceAudio: originalPath, dubSegments, duration, directory: workDirectory, signal, format: 'mp3',
            onProgress: seconds => stage('MIXING_AUDIO', 92,
              'Kaynak ambience ve Türkçe ses, video zaman çizelgesinde birleştiriliyor.', {
                stageProgress: { loaded: Math.min(duration, seconds), total: duration, unit: 'sn' }
              }) }));
        textArtifacts[mix.mimeType === 'audio/mpeg' ? 'mix.mp3' : 'mix.wav'] = { path: mix.path };
      } else logging.instant('final_mix', {}, { outcome: 'skipped', reason: 'dub_not_requested' });
      const qualityReport = {
        sourceDuration: duration, detectedLanguage: transcript.language, speakerCount: transcript.speakers.length,
        unverifiedSpeakerIds: qa.unverifiedSpeakerIds,
        sourceUtteranceCount: transcript.utterances.length, translatedUtteranceCount: translations.length,
        generatedDubCount: dubSegments.length, missingDubCount: dubRequested ? transcript.utterances.length - dubSegments.length : 0,
        subtitleCueCount: subtitles.source_tr.length + subtitles.dub_tr.length,
        alignmentSuccessRate: input.outputs?.subtitles === false ? null : dubSegments.length ? 1 : (dubRequested && transcript.utterances.length ? 0 : null),
        adaptiveTempoCount: dubSegments.filter(row => row.tempo > config.maxTempo).length,
        shortenedDubCount: qa.shortenedDubCount || 0,
        maxDubTempo: Math.max(1, ...dubSegments.map(row => row.tempo || 1)),
        ...dubTimingDiagnostics(dubSegments),
        failedSegments: [], mix: mix?.qa || null, ...stats,
      };
      if (qualityReport.missingDubCount) throw new MediaError('DUB_MISSING_SEGMENTS', 'Türkçe seslerden bazıları eksik; işlem hazır sayılmadı.');
      const artifactKey = finalKey;
      await stage('PACKAGING', 98, 'Dublaj ve altyazı sonuç dosyaları kaydediliyor.');
      const result = { version: 1, outputs: { dub: dubRequested, subtitles: input.outputs?.subtitles !== false }, sourceTranscript: transcript, translatedUtterances: translations, voiceMapping,
        dubSegments: dubSegments.map(({ audioPath, ...row }) => row), subtitles, assets: {}, qualityReport, artifactKey };
      await cache.put(artifactKey, result, { artifacts: textArtifacts });
      completedStages.add('PACKAGING');
      await stage('PACKAGING', 100, 'Sonuç dosyaları hazır.', { stageProgress: { loaded: 1, total: 1, unit: 'paket' } });
      return result;
    } catch (error) {
      if (error && typeof error === 'object') error.qualityReport = { ...qa, ...stats };
      throw error;
    } finally { for (const release of leases.values()) release(); }
    });
  };
}
