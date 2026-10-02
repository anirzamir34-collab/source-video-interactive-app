import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashKey } from './cache.js';
import { normalizeScribeTranscript, assertSegmentCoverage } from './model.js';
import { buildSubtitleTracks, toSrt, toWebVtt } from './subtitles.js';
import { translationScenes } from './translation.js';
import { mapSpeakerVoices } from './voice-mapping.js';
import { MediaError } from './errors.js';

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

async function settleStage(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(row => row.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(row => row.value);
}

function normalizedWords(words, text, duration, offset, segmentId) {
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
  return normalized;
}

export function createTurkishMediaPipeline({ config, cache, limiter, elevenLabs, translationProvider, audio }) {
  return async function runPipeline(input, { signal, onStage = async () => {}, stats = {} } = {}) {
    const leases = new Map();
    const lease = key => { if (!leases.has(key)) leases.set(key, cache.acquireLease(key)); };
    const qa = { sourceDuration: null, detectedLanguage: null, speakerCount: 0,
      sourceUtteranceCount: 0, translatedUtteranceCount: 0, generatedDubCount: 0,
      missingDubCount: 0, subtitleCueCount: 0, alignmentSuccessRate: null, failedSegments: [] };
    try {
      Object.assign(stats, { cacheHits: stats.cacheHits || 0, elevenLabsRequestCount: stats.elevenLabsRequestCount || 0, retryCount: stats.retryCount || 0 });
      const stage = (state, progress, message, extra = {}) => onStage({ state, progress, message,
        qualityReport: { ...qa, ...stats }, ...extra });
      const sourceHash = input.source.hash || await sourceFileHash(input.source.path);
      const identity = { sourceHash, version: config.version };
      const finalKey = hashKey({ ...identity, stage: 'final-package', outputs: input.outputs,
        qualityMode: input.qualityMode || config.qualityMode, language: config.language,
        sttModel: config.elevenLabs.sttModel, dubModel: config.elevenLabs.dubModel, fastModel: config.elevenLabs.fastModel,
        translationModel: config.translation.model, translationVersion: config.translationVersion,
        outputFormat: config.elevenLabs.outputFormat, manualVoices: input.voiceMapping || {}, previousVoices: input.previousVoiceMapping || {},
        sceneContext: input.sceneContext || [], dictionary: [config.elevenLabs.pronunciationDictionaryId, config.elevenLabs.pronunciationDictionaryVersionId],
        maxTempo: config.maxTempo });
      const completed = await cache.get(finalKey);
      if (completed) {
        stats.cacheHits += 1;
        return { ...completed, artifactKey: finalKey, qualityReport: { ...completed.qualityReport,
          cacheHits: stats.cacheHits, elevenLabsRequestCount: 0, retryCount: 0 } };
      }
      const workDirectory = input.directory;
      await fs.mkdir(workDirectory, { recursive: true });
      const cached = async (keyData, work) => {
        const key = hashKey(keyData);
        lease(key);
        let value = await cache.get(key);
        if (value) { stats.cacheHits += 1; return { key, value }; }
        value = await cache.singleFlight(key, async () => {
          const existing = await cache.get(key);
          if (existing) { stats.cacheHits += 1; return existing; }
          const result = await work(key);
          await cache.put(key, result.value, { artifacts: result.artifacts || {} });
          return result.value;
        });
        return { key, value };
      };
      await stage('PREPARING_AUDIO', 5, 'Kaynak ses, video zaman çizelgesi korunarak hazırlanıyor.');
      const prepared = await cached({ ...identity, stage: 'source-audio' }, async () => {
        const result = await audio.extractSource(input.source, { directory: workDirectory, signal });
        return { value: { duration: result.duration }, artifacts: { 'original.wav': { path: result.originalPath }, 'speech.flac': { path: result.sttPath } } };
      });
      const originalPath = await cache.getArtifactPath(prepared.key, 'original.wav');
      const sttPath = await cache.getArtifactPath(prepared.key, 'speech.flac');
      if (!originalPath || !sttPath) throw new MediaError('SOURCE_CACHE_CORRUPT', 'Hazırlanan kaynak ses dosyası bulunamadı.');
      const duration = prepared.value.duration;
      qa.sourceDuration = duration;
      await stage('TRANSCRIBING', 15, 'Scribe v2 bütün kaynak konuşmaları çözümlüyor.');
      const transcriptEntry = await cached({ ...identity, stage: 'transcript', model: config.elevenLabs.sttModel, diarize: true }, async () => ({
        value: normalizeScribeTranscript(await elevenLabs.transcribe(sttPath, { signal }), { sourceHash, duration }),
      }));
      const transcript = transcriptEntry.value;
      Object.assign(qa, { sourceDuration: duration, detectedLanguage: transcript.language,
        speakerCount: transcript.speakers.length, sourceUtteranceCount: transcript.utterances.length,
        missingDubCount: input.outputs?.dub ? transcript.utterances.length : 0 });
      await stage('DIARIZING', 30, 'Kaynak konuşmacı kimlikleri ve kelime zamanları hazır.', { sourceTranscript: transcript });
      if (input.outputs?.transcriptOnly) {
        return { version: 1, sourceTranscript: transcript, translatedUtterances: [], voiceMapping: {}, dubSegments: [],
          subtitles: { source_tr: [], dub_tr: [] }, assets: {}, qualityReport: { sourceDuration: duration,
            detectedLanguage: transcript.language, speakerCount: transcript.speakers.length, sourceUtteranceCount: transcript.utterances.length,
            translatedUtteranceCount: 0, generatedDubCount: 0, missingDubCount: 0, transcriptOnly: true, ...stats } };
      }
      await stage('TRANSLATING', 35, 'Konuşmalar sahne bağlamı ve kaynak süreleriyle Türkçeye çevriliyor.');
      const scenes = translationScenes(transcript).map(scene => ({ ...scene, sceneContext: (input.sceneContext || []).filter(context =>
        Number(context.startTime) <= scene.utterances.at(-1).sourceEnd && Number(context.endTime) >= scene.utterances[0].sourceStart) }));
      const translations = (await settleStage(scenes.map(scene => limiter.run(async () => {
        const result = await cached({ ...identity, stage: 'translation', scene, language: config.language,
          model: config.translation.model, translationVersion: config.translationVersion }, async () => {
          let rows = await translationProvider.translateScene(scene, { signal });
          if (rows.some(row => row.estimatedDuration > row.targetDuration * 1.15)) {
            rows = await translationProvider.translateScene(scene, { signal, shorten: true });
          }
          return { value: rows };
        });
        return result.value;
      }, { signal })))).flat();
      assertSegmentCoverage(transcript, translations);
      qa.translatedUtteranceCount = translations.length;
      const dubRequested = input.outputs?.dub === true;
      let voiceMapping = {}, dubSegments = [], mix = null;
      if (dubRequested && transcript.utterances.length) {
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
        for (const turn of transcript.utterances) {
          const translation = translations.find(row => row.segmentId === turn.segmentId);
          const key = hashKey({ ...identity, stage: 'completed-dub-segment', model, voiceId: voiceMapping[turn.speakerId],
            sourceStart: turn.sourceStart, sourceEnd: turn.sourceEnd, text: translation.translatedText,
            outputFormat: config.elevenLabs.outputFormat, translationVersion: config.translationVersion,
            dictionary, maxTempo: config.maxTempo });
          segmentKeys.set(turn.segmentId, key);
          lease(key);
          const ready = await cache.get(key);
          if (ready) {
            const audioPath = await cache.getArtifactPath(key, 'segment.wav');
            if (audioPath) {
              stats.cacheHits += 1;
              Object.assign(translation, ready.translation);
              finishedSegments.set(turn.segmentId, { ...ready.dub, audioPath });
            }
          }
        }
        const batches = dialogueBatches(transcript.utterances.filter(turn => !finishedSegments.has(turn.segmentId)),
          translations, voiceMapping, { characterLimit });
        await stage('GENERATING_DUB', 50, 'Eleven v4, her konuşmacıya sabit sesle Türkçe dublaj üretiyor.');
        async function renderBatch(turns, purpose = 'dialogue') {
          const readyPieces = new Map(), pieceKeys = new Map();
          for (const turn of turns) {
            const key = hashKey({ ...identity, stage: 'generated-turn', purpose, model,
              segmentId: turn.segmentId, partIndex: turn.partIndex, text: turn.text, voiceId: turn.voice_id,
              outputFormat: config.elevenLabs.outputFormat, translationVersion: config.translationVersion, dictionary });
            pieceKeys.set(turn, key); lease(key);
            const ready = await cache.get(key);
            if (ready) {
              const audioPath = await cache.getArtifactPath(key, 'turn.wav');
              if (audioPath) { stats.cacheHits += 1; readyPieces.set(turn, { ...turn, model: ready.model, audioPath }); }
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
          const generation = await cached({ ...identity, stage: purpose, model,
            outputFormat: config.elevenLabs.outputFormat, language: config.language,
            turns: turns.map(turn => ({ segmentId: turn.segmentId, speakerId: turn.speakerId, text: turn.text, voiceId: turn.voice_id })),
            translationVersion: config.translationVersion, dictionary }, async () => {
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
            await cache.put(pieceKeys.get(turn), { model: generation.value.model }, { artifacts: { 'turn.wav': { path: part.audioPath } } });
            results.push({ ...turn, audioPath: part.audioPath, model: generation.value.model });
          }
          return results;
        }
        // Generate bounded scene requests first, then rejoin any long utterance
        // fragments before fitting and aligning its original canonical segment.
        const rendered = (await settleStage(batches.map(turns => limiter.run(() => renderBatch(turns), { signal })))).flat();
        let complete = finishedSegments.size;
        qa.generatedDubCount = complete;
        qa.missingDubCount = transcript.utterances.length - complete;
        dubSegments = await settleStage(transcript.utterances.map(turn => limiter.run(async () => {
          signal?.throwIfAborted();
          if (finishedSegments.has(turn.segmentId)) return finishedSegments.get(turn.segmentId);
          const translation = translations.find(row => row.segmentId === turn.segmentId);
          const voiceId = voiceMapping[turn.speakerId];
          const segmentDirectory = path.join(workDirectory, `segment-${hashKey(turn.segmentId).slice(0, 16)}`);
          await fs.mkdir(segmentDirectory, { recursive: true });
          const segmentKey = segmentKeys.get(turn.segmentId);
          const parts = rendered.filter(row => row.segmentId === turn.segmentId).sort((a, b) => a.partIndex - b.partIndex);
          if (!parts.length || parts.length !== parts[0].partCount) throw new MediaError('DUB_MISSING_SEGMENTS', 'Konuşma parçaları eksik.', { segmentIds: [turn.segmentId] });
          let turnPath = parts.length === 1 ? parts[0].audioPath :
            (await audio.joinDialogueParts(parts.map(row => row.audioPath), { directory: segmentDirectory, signal })).path;
          let fitted;
          try { fitted = await audio.fitDubSegment(turnPath, { targetDuration: turn.sourceEnd - turn.sourceStart, maxTempo: config.maxTempo, signal }); }
          catch (error) {
            if (!['DUB_DURATION_TOO_LONG', 'DUB_REGENERATE_REQUIRED', 'DUB_REGENERATION_REQUIRED', 'AUDIO_REGENERATION_REQUIRED'].includes(error.code)) throw error;
            const actualDuration = await audio.probeDuration(turnPath, { signal });
            const scene = scenes.find(candidate => candidate.utterances.some(row => row.segmentId === turn.segmentId));
            const shortened = await cached({ ...identity, stage: 'duration-translation', segmentKey, scene,
              originalText: translation.translatedText, actualDuration, model: config.translation.model,
              version: config.translationVersion }, async () => ({ value: await translationProvider.translateScene({ ...scene, utterances: [turn] }, {
                signal, shorten: true, measuredDurations: { [turn.segmentId]: actualDuration },
              }) }));
            const revised = shortened.value[0];
            assertSegmentCoverage([turn], shortened.value);
            const revisedBatches = dialogueBatches([turn], [revised], voiceMapping, { characterLimit });
            const revisedParts = [];
            // We already own one stage slot; calling its limiter recursively
            // would deadlock. These requests are sequential within that slot.
            for (const batch of revisedBatches) revisedParts.push(...await renderBatch(batch, 'duration-regeneration'));
            turnPath = revisedParts.length === 1 ? revisedParts[0].audioPath :
              (await audio.joinDialogueParts(revisedParts.map(row => row.audioPath), { directory: path.join(segmentDirectory, 'revised'), signal })).path;
            fitted = await audio.fitDubSegment(turnPath, { targetDuration: revised.targetDuration, maxTempo: config.maxTempo, signal });
            Object.assign(translation, revised);
          }
          await stage('ALIGNING', 60 + Math.round(complete / transcript.utterances.length * 20), 'Üretilen Türkçe ses gerçek kelime zamanlarıyla hizalanıyor.');
          const fittedHash = await sourceFileHash(fitted.path);
          const aligned = await cached({ ...identity, stage: 'alignment', audioHash: fittedHash, text: translation.translatedText,
            segmentId: turn.segmentId }, async () => ({ value: await elevenLabs.align(fitted.path, translation.translatedText, { signal }),
              artifacts: { 'fitted.wav': { path: fitted.path } } }));
          const audioPath = await cache.getArtifactPath(aligned.key, 'fitted.wav');
          const words = normalizedWords(aligned.value.words, translation.translatedText, fitted.duration, turn.sourceStart, turn.segmentId);
          const dub = { segmentId: turn.segmentId, speakerId: turn.speakerId, start: turn.sourceStart, end: turn.sourceEnd,
            duration: fitted.duration, words, audioHash: fittedHash, model, voiceId };
          await cache.put(segmentKey, { dub, translation }, { artifacts: { 'segment.wav': { path: audioPath } } });
          complete += 1;
          qa.generatedDubCount = complete;
          qa.missingDubCount = transcript.utterances.length - complete;
          qa.alignmentSuccessRate = complete / transcript.utterances.length;
          return { ...dub, audioPath };
        }, { signal })));
        dubSegments.sort((a, b) => a.start - b.start);
        assertSegmentCoverage(transcript, translations, dubSegments);
      }
      await stage('BUILDING_SUBTITLES', 85, 'Kaynak ve dublaj hizalı Türkçe altyazılar hazırlanıyor.');
      const subtitles = buildSubtitleTracks(transcript, translations, dubSegments);
      qa.subtitleCueCount = subtitles.source_tr.length + subtitles.dub_tr.length;
      const textArtifacts = {};
      for (const [track, cues] of Object.entries(subtitles)) {
        textArtifacts[`${track}.srt`] = Buffer.from(toSrt(cues), 'utf8');
        textArtifacts[`${track}.vtt`] = Buffer.from(toWebVtt(cues), 'utf8');
      }
      if (dubRequested) {
        await stage('MIXING_AUDIO', 92, 'Kaynak ambience ve Türkçe ses, video zaman çizelgesinde birleştiriliyor.');
        mix = await audio.mixAudio({ sourceAudio: originalPath, dubSegments, duration, directory: workDirectory, signal });
        textArtifacts['mix.wav'] = { path: mix.path };
      }
      const qualityReport = {
        sourceDuration: duration, detectedLanguage: transcript.language, speakerCount: transcript.speakers.length,
        sourceUtteranceCount: transcript.utterances.length, translatedUtteranceCount: translations.length,
        generatedDubCount: dubSegments.length, missingDubCount: dubRequested ? transcript.utterances.length - dubSegments.length : 0,
        subtitleCueCount: subtitles.source_tr.length + subtitles.dub_tr.length,
        alignmentSuccessRate: dubSegments.length ? 1 : (dubRequested && transcript.utterances.length ? 0 : null),
        failedSegments: [], mix: mix?.qa || null, ...stats,
      };
      if (qualityReport.missingDubCount) throw new MediaError('DUB_MISSING_SEGMENTS', 'Türkçe seslerden bazıları eksik; işlem hazır sayılmadı.');
      const artifactKey = finalKey;
      const result = { version: 1, sourceTranscript: transcript, translatedUtterances: translations, voiceMapping,
        dubSegments: dubSegments.map(({ audioPath, ...row }) => row), subtitles, assets: {}, qualityReport, artifactKey };
      await cache.put(artifactKey, result, { artifacts: textArtifacts });
      return result;
    } catch (error) {
      if (error && typeof error === 'object') error.qualityReport = { ...qa, ...stats };
      throw error;
    } finally { for (const release of leases.values()) release(); }
  };
}
