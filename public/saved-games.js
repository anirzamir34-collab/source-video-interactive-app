import { repairableAnalysisGaps } from './analysis-gap-repair.js';

// Store media separately so opening the shelf never reads every video into memory.
const DATABASE = 'videoquest-saved-games';
const STORES = ['games', 'payloads', 'videos', 'mixes'];
const MAGIC = 'VQGAME2\n';
const LEGACY_MAGIC = 'VQGAME1\n';
const MAX_HEADER = 128 * 1024 * 1024;
const secretField = /^(?:.*(?:api[_-]?keys?|secret|secrets|tokens?|authorization|password|cookies?|credentials?|urls?|uris?|href|paths?)|artifactKey|cacheKey|cacheDirectory|workDirectory|jobId|uploadId|__proto__|constructor|prototype)$/i;
const contentField = /^(?:sourceText|originalText|translatedText|turkishText|textTr|text|displaySubtitleText|label|evidence)$/;

function cleanJson(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (secretField.test(key)) return undefined;
    if (typeof item === 'string' && !contentField.test(key) &&
        /^(?:https?:\/\/|file:\/\/|blob:|data:audio\/|\/(?:tmp|workspace|var|home)\/)/i.test(item)) return undefined;
    return item;
  }));
}

const fields = (input, names) => Object.fromEntries(names.filter(name => input?.[name] !== undefined)
  .map(name => [name, input[name]]));

// V1 source dialogue is historical evidence only. Allow source text/timing and
// analysis metadata through, without copying old generated audio or player state.
function sourcePayload(input) {
  const dialogue = input?.dialogue;
  const speechFields = ['id', 'segmentId', 'speakerId', 'speakerName', 'originalText', 'text', 'textTr',
    'turkishText', 'start', 'end', 'startTime', 'endTime', 'gender', 'emotion', 'confidence', 'language', 'words', 'evidence'];
  return cleanJson({
    analysis: input?.analysis || null,
    dialogue: dialogue ? {
      ...fields(dialogue, ['sourceLanguage', 'timestampUnit', 'summaryTr', 'warnings', 'coverageAudit',
        'timestampRepair', 'timingIntegrity', 'transcriptionEngine', 'translationEngine']),
      segments: Array.isArray(dialogue.segments) ? dialogue.segments.map(row => fields(row, speechFields)) : dialogue.segments,
      ...(dialogue.speakers === undefined ? {} : { speakers: Array.isArray(dialogue.speakers)
        ? dialogue.speakers.map(row => fields(row, ['speakerId', 'name', 'speakerName', 'gender', 'confidence', 'evidence']))
        : dialogue.speakers }),
      ...(dialogue.nonSpeechEvents === undefined ? {} : { nonSpeechEvents: Array.isArray(dialogue.nonSpeechEvents)
        ? dialogue.nonSpeechEvents.map(row => fields(row, ['id', 'eventId', 'speakerId', 'type', 'text', 'label',
          'start', 'end', 'startTime', 'endTime', 'confidence', 'evidence'])) : dialogue.nonSpeechEvents })
    } : null
  });
}

function validateTurkishMedia(media, audio, duration) {
  if (media == null) {
    if (audio?.size) throw new Error('Dublaj sesinin medya bilgileri eksik.');
    return;
  }
  if (!media || typeof media !== 'object' || Array.isArray(media) || media.manifest?.version !== 1) {
    throw new Error('Kayıttaki Türkçe medya bilgileri geçersiz.');
  }
  if (!['off', 'source_tr', 'dub_tr'].includes(media.subtitleTrack) ||
      !Number.isFinite(media.syncOffset) || Math.abs(media.syncOffset) > 10 || typeof media.dubEnabled !== 'boolean') {
    throw new Error('Kayıttaki Türkçe medya oynatma ayarları geçersiz.');
  }
  const manifest = media.manifest;
  const source = manifest.sourceTranscript;
  if (source?.version !== 1 || !source.source || typeof source.source.hash !== 'string' || !source.source.hash ||
      !Number.isFinite(source.source.duration) || source.source.duration <= 0 ||
      Math.abs(source.source.duration - duration) > Math.max(2, duration * .01) ||
      !Array.isArray(source.utterances) || !Array.isArray(source.speakers) || !Array.isArray(source.audioEvents)) {
    throw new Error('Kayıttaki kaynak konuşma bilgileri geçersiz.');
  }
  const speakers = new Set();
  for (const speaker of source.speakers) {
    if (typeof speaker?.speakerId !== 'string' || !speaker.speakerId || speakers.has(speaker.speakerId)) {
      throw new Error('Kayıttaki konuşmacı kimlikleri geçersiz.');
    }
    speakers.add(speaker.speakerId);
  }
  const utterances = new Map();
  for (const row of source.utterances) {
    if (typeof row?.segmentId !== 'string' || !row.segmentId || utterances.has(row.segmentId) || !speakers.has(row.speakerId) ||
        typeof row.sourceText !== 'string' || !row.sourceText.trim() || !Number.isFinite(row.sourceStart) ||
        !Number.isFinite(row.sourceEnd) || row.sourceStart < 0 || row.sourceEnd <= row.sourceStart || row.sourceEnd > source.source.duration) {
      throw new Error('Kayıttaki kaynak konuşma aralıkları geçersiz.');
    }
    utterances.set(row.segmentId, row);
  }
  for (const [name, rows] of [['çeviri', manifest.translatedUtterances], ['dublaj', manifest.dubSegments]]) {
    if (!Array.isArray(rows) || (rows.length && rows.length !== utterances.size)) throw new Error(`Kayıttaki ${name} kapsamı eksik.`);
    const seen = new Set();
    for (const row of rows) {
      const original = utterances.get(row?.segmentId);
      if (!original || row.speakerId !== original.speakerId || seen.has(row.segmentId)) throw new Error(`Kayıttaki ${name} kimlikleri geçersiz.`);
      if (name === 'çeviri' && (typeof row.translatedText !== 'string' || !row.translatedText.trim())) throw new Error('Kayıttaki Türkçe çeviri eksik.');
      seen.add(row.segmentId);
    }
  }
  if (!manifest.voiceMapping || typeof manifest.voiceMapping !== 'object' || Array.isArray(manifest.voiceMapping)) throw new Error('Kayıttaki konuşmacı sesleri geçersiz.');
  const voices = new Set();
  for (const [speakerId, voiceId] of Object.entries(manifest.voiceMapping)) {
    if (!speakers.has(speakerId) || typeof voiceId !== 'string' || !voiceId || voices.has(voiceId)) throw new Error('Her konuşmacının sesi ayrı ve sabit olmalı.');
    voices.add(voiceId);
  }
  if (audio?.size && source.utterances.length &&
      (manifest.translatedUtterances.length !== source.utterances.length || manifest.dubSegments.length !== source.utterances.length ||
        source.utterances.some(row => !manifest.voiceMapping[row.speakerId]))) throw new Error('Kayıttaki dublaj kapsamı eksik.');
  if (!manifest.subtitles || typeof manifest.subtitles !== 'object') throw new Error('Kayıttaki altyazı bilgileri eksik.');
  for (const track of ['source_tr', 'dub_tr']) {
    if (!Array.isArray(manifest.subtitles[track])) throw new Error('Kayıttaki altyazı bilgileri geçersiz.');
    for (const cue of manifest.subtitles[track]) {
      if (!utterances.has(cue?.segmentId) || utterances.get(cue.segmentId).speakerId !== cue.speakerId ||
          !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start ||
          cue.end > source.source.duration || typeof cue.text !== 'string' || !cue.text.trim()) throw new Error('Kayıttaki altyazı aralıkları geçersiz.');
    }
  }
  if (audio != null && (!(audio instanceof Blob) || !audio.size || !/^audio\/[\w.+-]+$/.test(audio.type))) throw new Error('Kayıttaki dublaj ses dosyası geçersiz.');
  if (audio?.size && (!manifest.assets?.mix || !Number.isFinite(manifest.assets.mix.duration) ||
      Math.abs(manifest.assets.mix.duration - duration) > Math.max(2, duration * .01) ||
      (manifest.assets.mix.mimeType && manifest.assets.mix.mimeType !== audio.type))) throw new Error('Kayıttaki dublaj sesi kaynak videoyla uyuşmuyor.');
  if (media.dubEnabled && !audio?.size) throw new Error('Kayıttaki dublaj ses dosyası eksik.');
}

export function validateGame(game) {
  if (!game || ![1, 2].includes(game.version)) throw new Error('Bu kayıt biçimi desteklenmiyor.');
  if (!(game.video instanceof Blob) || !game.video.size) throw new Error('Kayıtta video dosyası eksik.');
  if (!Number.isFinite(game.duration) || game.duration <= 0) throw new Error('Kayıt süresi geçersiz.');
  const p = game.payload;
  if (!p || (!p.analysis && !p.dialogue && !game.turkishMedia?.manifest?.sourceTranscript)) throw new Error('Kayıtta analiz bulunamadı.');
  if (p.analysis && (!Array.isArray(p.analysis.actions) || !p.analysis.actions.length)) {
    throw new Error('Kayıttaki oyun analizi geçersiz.');
  }
  if (p.dialogue && !Array.isArray(p.dialogue.segments)) throw new Error('Kayıttaki diyalog geçersiz.');
  validateTurkishMedia(game.turkishMedia, game.dubAudio, game.duration);
  return game;
}

export function prepareGame(input, previous = null) {
  const now = new Date().toISOString();
  const game = {
    version: 2,
    id: previous?.id || crypto.randomUUID(),
    title: String(input.title || input.fileName || 'Kayıtlı oyun').trim().slice(0, 120) || 'Kayıtlı oyun',
    fileName: String(input.fileName || 'video.mp4').slice(0, 240),
    sourceKind: input.sourceKind === 'url' ? 'url' : 'file',
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    duration: Number(input.duration),
    video: input.video,
    dubAudio: input.dubAudio ?? null,
    turkishMedia: input.turkishMedia ? cleanJson({
      manifest: input.turkishMedia.manifest,
      dubEnabled: Boolean(input.turkishMedia.dubEnabled),
      subtitleTrack: input.turkishMedia.subtitleTrack || 'off',
      syncOffset: input.turkishMedia.syncOffset ?? 0
    }) : null,
    payload: sourcePayload(input.payload)
  };
  return validateGame(game);
}

function summary(game) {
  const { video, payload, dubAudio, turkishMedia, ...meta } = game;
  const manifest = turkishMedia?.manifest;
  const mixBytes = dubAudio?.size || 0;
  return {
    ...meta, videoBytes: video.size,
    mixBytes, dubReady: mixBytes > 0 && Boolean(manifest?.assets?.mix),
    totalBytes: video.size + mixBytes,
    actionCount: payload.analysis?.actions.length || 0,
    analysisGapCount: repairableAnalysisGaps(payload.analysis, game.duration).length,
    dialogueCount: manifest?.sourceTranscript?.utterances.length ?? payload.dialogue?.segments.length ?? 0,
    dubCount: manifest?.dubSegments?.length || 0
  };
}

export function createGameStore({ indexedDB = globalThis.indexedDB, database = DATABASE } = {}) {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('Bu tarayıcı cihazda kayıt tutmayı desteklemiyor.')); return; }
      const request = indexedDB.open(database, 2);
      let settled = false;
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onblocked = () => { settled = true; reject(new Error('Kaydı açmak için uygulamanın diğer sekmelerini kapat.')); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        db.onclose = () => { connection = null; };
        resolve(db);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }
  async function transaction(stores, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Kayıt işlemi tamamlanamadı.'));
      tx.onerror = () => {}; // Abort is the final result; no partial success.
      const fail = error => { tx.abort(); reject(error); };
      try { operation(tx, value => { result = value; }, fail); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    async list() {
      const rows = await transaction(['games'], 'readonly', (tx, done) => {
        const request = tx.objectStore('games').getAll();
        request.onsuccess = () => done(request.result);
      });
      // Records written before gap counts were added need their small payload
      // inspected once; never load their video bytes just to draw the shelf.
      const legacy = rows.filter(row => row.analysisGapCount == null);
      if (legacy.length) {
        const payloads = await transaction(['payloads'], 'readonly', (tx, done) => {
          const request = tx.objectStore('payloads').getAll();
          request.onsuccess = () => done(request.result);
        });
        const byId = new Map(payloads.map(row => [row.id, row.payload]));
        legacy.forEach(row => { row.analysisGapCount = repairableAnalysisGaps(
          byId.get(row.id)?.analysis, row.duration).length; });
      }
      // V1 metadata cannot advertise a final mix; raw old rows stay untouched.
      return rows.map(row => ({ ...row,
        dubReady: row.dubReady === true && Number(row.mixBytes) > 0,
        ...(row.version === 1 ? { dubCount: 0, mixBytes: 0, dubReady: false,
          totalBytes: Number(row.videoBytes) || row.totalBytes } : {})
      })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(input, existingId = null) {
      const game = prepareGame(input);
      const meta = summary(game);
      return transaction(STORES, 'readwrite', (tx, done, fail) => {
        const write = previous => {
          try {
            if (previous) { meta.id = previous.id; meta.createdAt = previous.createdAt; }
            tx.objectStore('games').put(meta);
            tx.objectStore('payloads').put({ id: meta.id, payload: game.payload, turkishMedia: game.turkishMedia });
            tx.objectStore('videos').put({ id: meta.id, video: game.video });
            if (game.dubAudio) tx.objectStore('mixes').put({ id: meta.id, dubAudio: game.dubAudio });
            else tx.objectStore('mixes').delete(meta.id);
            done(meta);
          } catch (error) { fail(error); }
        };
        if (!existingId) write(null);
        else {
          const request = tx.objectStore('games').get(existingId);
          request.onsuccess = () => write(request.result);
        }
      });
    },
    async load(id) {
      const game = await transaction(STORES, 'readonly', (tx, done) => {
        const results = {};
        let pending = STORES.length;
        for (const store of STORES) {
          const request = tx.objectStore(store).get(id);
          request.onsuccess = () => {
            results[store] = request.result;
            if (!--pending) done({ ...results.games,
              payload: results.payloads?.payload ? sourcePayload(results.payloads.payload) : undefined,
              turkishMedia: results.payloads?.turkishMedia || null,
              video: results.videos?.video, dubAudio: results.mixes?.dubAudio || null });
          };
        }
      });
      validateGame(game);
      if (game.video.size !== game.videoBytes) throw new Error('Kayıttaki video eksik veya bozuk.');
      if ((game.dubAudio?.size || 0) !== (game.mixBytes || 0)) throw new Error('Kayıttaki dublaj sesi eksik veya bozuk.');
      return game;
    },
    remove(id) {
      return transaction(STORES, 'readwrite', tx => { for (const store of STORES) tx.objectStore(store).delete(id); });
    },
    updateDubAudio(id, audio, manifest) {
      return transaction(['games', 'payloads', 'mixes'], 'readwrite', (tx, done, fail) => {
        const meta = tx.objectStore('games').get(id);
        meta.onsuccess = () => {
          if (!meta.result) { fail(new Error('Kayıt bulunamadı.')); return; }
          const payload = tx.objectStore('payloads').get(id);
          payload.onsuccess = () => {
            try {
              if (!payload.result?.turkishMedia) throw new Error('Kayıtlı Türkçe medya bulunamadı.');
              const media = manifest ? { ...payload.result.turkishMedia, manifest } : payload.result.turkishMedia;
              validateTurkishMedia(media, audio, meta.result.duration);
              if (manifest) tx.objectStore('payloads').put({ ...payload.result, turkishMedia: media });
              tx.objectStore('mixes').put({ id, dubAudio: audio });
              const old = meta.result;
              tx.objectStore('games').put({ ...old, mixBytes: audio.size,
                totalBytes: old.totalBytes - (old.mixBytes || 0) + audio.size,
                updatedAt: new Date().toISOString() });
              done(true);
            } catch (error) { fail(error); }
          };
        };
      });
    },
    updateLanguageSync(id, offset) {
      if (!Number.isFinite(offset) || Math.abs(offset) > 10) throw new Error('Ses eşitleme değeri geçersiz.');
      return transaction(['games', 'payloads'], 'readwrite', (tx, done, fail) => {
        const request = tx.objectStore('payloads').get(id);
        request.onsuccess = () => {
          if (!request.result) { fail(new Error('Kayıt bulunamadı.')); return; }
          const record = request.result;
          if (!record.turkishMedia) { fail(new Error('Bu kayıtta eşitlenecek Türkçe medya bulunamadı.')); return; }
          tx.objectStore('payloads').put({ ...record,
            payload: sourcePayload(record.payload),
            turkishMedia: { ...record.turkishMedia, syncOffset: offset } });
          const meta = tx.objectStore('games').get(id);
          meta.onsuccess = () => {
            if (meta.result) tx.objectStore('games').put({ ...meta.result, updatedAt: new Date().toISOString() });
            done(true);
          };
        };
      });
    },
    async close() { if (connection) (await connection).close(); connection = null; }
  };
}

// Both media assets are appended directly; neither becomes a base64 JSON copy.
export function exportGame(input) {
  const game = prepareGame(input);
  const { video, dubAudio, ...metadata } = game;
  const header = new TextEncoder().encode(JSON.stringify({ ...metadata,
    videoSize: video.size, videoType: video.type, mixSize: dubAudio?.size || 0, mixType: dubAudio?.type || '' }));
  if (header.byteLength > MAX_HEADER) throw new Error('Dublaj verisi yedek dosyası için çok büyük. Cihazdaki kayıt korunuyor.');
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.byteLength);
  return new Blob([MAGIC, length, header, video, ...(dubAudio ? [dubAudio] : [])], { type: 'application/octet-stream' });
}

export async function importGame(file) {
  if (!(file instanceof Blob) || file.size < 12) throw new Error('Geçerli bir .vqgame yedeği seç.');
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const magic = new TextDecoder().decode(prefix.slice(0, 8));
  if (![MAGIC, LEGACY_MAGIC].includes(magic)) throw new Error('Bu dosya bir oyun yedeği değil.');
  const size = new DataView(prefix.buffer).getUint32(8);
  if (!size || size > MAX_HEADER || 12 + size >= file.size) throw new Error('Yedek dosyası eksik veya bozuk.');
  let header;
  try { header = JSON.parse(await file.slice(12, 12 + size).text()); }
  catch { throw new Error('Yedek bilgileri okunamadı.'); }
  const legacy = magic === LEGACY_MAGIC;
  const mixSize = legacy ? 0 : header?.mixSize;
  if (header?.version !== (legacy ? 1 : 2) || !Number.isSafeInteger(header.videoSize) || header.videoSize <= 0 ||
      !Number.isSafeInteger(mixSize) || mixSize < 0 || !Number.isSafeInteger(12 + size + header.videoSize + mixSize) ||
      file.size !== 12 + size + header.videoSize + mixSize) {
    throw new Error('Yedek sürümü veya video boyutu geçersiz.');
  }
  if (typeof header.videoType !== 'string' || !/^(?:video\/[\w.+-]+|application\/octet-stream)?$/.test(header.videoType)) {
    throw new Error('Yedekteki dosya bir video değil.');
  }
  if (!legacy && (typeof header.mixType !== 'string' ||
      (mixSize ? !/^audio\/[\w.+-]+$/.test(header.mixType) : header.mixType !== ''))) {
    throw new Error('Yedekteki dublaj ses biçimi geçersiz.');
  }
  const videoEnd = 12 + size + header.videoSize;
  // Imported IDs cannot overwrite another saved game.
  return prepareGame({ ...header,
    turkishMedia: legacy ? null : header.turkishMedia,
    video: file.slice(12 + size, videoEnd, header.videoType),
    dubAudio: mixSize ? file.slice(videoEnd, file.size, header.mixType) : null });
}

export function storageError(error) {
  if (error?.name === 'QuotaExceededError') return 'Cihazda yeterli boş alan yok. Oyun kaydedilemedi; mevcut kayıtların silinmedi. Alan açıp “Şimdi kaydet” ile tekrar dene veya “Yedek indir” ile dosyaya kaydet.';
  return `Kayıt işlemi tamamlanamadı: ${error?.message || 'Tarayıcı depolaması kullanılamıyor.'}`;
}
