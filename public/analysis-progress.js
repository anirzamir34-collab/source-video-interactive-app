const LABELS = {
  source: 'Video dosyasının hazırlanması', extract: 'Videodan sesin ayrılması',
  encode: 'Sesin MP3’e dönüştürülmesi', hash: 'MP3 dosyasının kontrolü',
  upload: 'MP3 sesin gönderilmesi', serverAudio: 'Sesin sunucuda hazırlanması',
  transcript: 'Konuşmaların çözümlenmesi', speakers: 'Konuşmacıların belirlenmesi',
  frames: 'Video karelerinin hazırlanması', frameUpload: 'Analiz görüntülerinin gönderilmesi', analysis: 'Sahne ve seçim analizi',
  review: 'Görsel bulguların doğrulanması', integrity: 'Analiz bütünlüğü kontrolü',
  translation: 'Konuşmaların Türkçeye çevrilmesi', voices: 'Konuşmacı seslerinin eşleştirilmesi',
  dub: 'ElevenLabs v4 Türkçe dublaj', align: 'Konuşma sürelerinin eşleştirilmesi',
  subtitles: 'Altyazı zamanlarının hazırlanması', mix: 'Türkçe seslerin birleştirilmesi',
  package: 'Sonuç dosyalarının hazırlanması', save: 'Oyunun kaydedilmesi'
};
const SERVER_STEPS = { QUEUED: 'serverAudio', PREPARING_AUDIO: 'serverAudio', TRANSCRIBING: 'transcript',
  DIARIZING: 'speakers', TRANSLATING: 'translation', ASSIGNING_VOICES: 'voices',
  GENERATING_DUB: 'dub', ALIGNING: 'align', BUILDING_SUBTITLES: 'subtitles',
  MIXING_AUDIO: 'mix', PACKAGING: 'package' };
const MB = value => (value / 1024 / 1024).toFixed(2) + ' MB';
const seconds = value => Math.max(0, Math.floor(value / 1000)) + ' sn';
const ACTIVE = new Set(['working', 'waiting', 'retrying']);

export function createAnalysisProgress({ list, summary, detail, message, bar, container,
  now = Date.now, setTimer = globalThis.setInterval, clearTimer = globalThis.clearInterval } = {}) {
  const rows = new Map();
  let timer = null, active = false, focused = null, startedAt = 0;
  let terminalText = '', finishedAt = null;
  function paint() {
    const running = [...rows.values()].filter(row => ACTIVE.has(row.status));
    const focusedRow = rows.get(focused);
    const focus = active && running.length ? (running.includes(focusedRow) ? focusedRow : running.at(-1)) : focusedRow;
    const complete = [...rows.values()].filter(row => ['done', 'reused'].includes(row.status)).length;
    if (summary) summary.textContent = startedAt ? 'Toplam süre: ' + seconds((finishedAt ?? now()) - startedAt) : '';
    if (message) message.textContent = terminalText || focus?.detail ||
      (active ? 'İşlem hazırlanıyor.' : 'Seçili işlemler tamamlandı.');
    const info = [];
    if (active && focus && Number.isFinite(focus.loaded) && focus.total > 0) info.push(focus.unit === 'bytes'
      ? MB(focus.loaded) + ' / ' + MB(focus.total)
      : focus.unit === 'percent' ? '%' + Math.floor(focus.loaded / focus.total * 100)
      : focus.loaded + ' / ' + focus.total + (focus.unit ? ' ' + focus.unit : ''));
    if (active && focus?.startedAt !== undefined) info.push(seconds(now() - focus.startedAt));
    if (active && running.length > 1) info.push(running.filter(row => row !== focus).map(row => row.label).join(' · '));
    if (active && focus?.lastServerContactAt && now() - focus.lastServerContactAt > 10000)
      info.push('Son sunucu yanıtı ' + seconds(now() - focus.lastServerContactAt) + ' önce');
    if (detail) detail.textContent = info.join(' · ');
    if (bar) {
      if (!active && terminalText) bar.removeAttribute('value');
      else if (focus?.total > 0 && Number.isFinite(focus.loaded)) bar.value = Math.min(100, focus.loaded / focus.total * 100);
      else bar.removeAttribute('value');
    }
  }
  function update(id, changes = {}) {
    if (!LABELS[id]) return;
    let row = rows.get(id);
    if (!row) { row = { id, label: LABELS[id], status: 'pending' }; rows.set(id, row); }
    const status = changes.status || 'working';
    if (ACTIVE.has(status) && !ACTIVE.has(row.status)) { row.startedAt = now(); delete row.endedAt; }
    if (!ACTIVE.has(status) && status !== 'pending' && row.endedAt === undefined) row.endedAt = now();
    Object.assign(row, changes, { status });
    focused = id; container?.classList.remove('hidden'); paint();
  }
  function done(id, text = '') { update(id, { status: 'done', detail: text, ...(rows.get(id)?.total > 0 ? { loaded: rows.get(id).total } : {}) }); }
  function begin({ motion = false, dubbing = true, subtitles = true, remote = false } = {}) {
    if (timer !== null) clearTimer.call(globalThis, timer);
    rows.clear(); active = true; startedAt = now(); terminalText = ''; finishedAt = null;
    const ids = ['source', 'extract', 'encode', 'hash', 'upload', 'serverAudio', 'transcript', 'speakers',
      ...(motion ? ['frames', 'frameUpload', 'analysis', 'review', 'integrity'] : []),
      ...(dubbing || subtitles ? ['translation'] : []),
      ...(dubbing ? ['voices', 'dub', 'align'] : []),
      ...(subtitles ? ['subtitles'] : []), ...(dubbing ? ['mix'] : []), 'package', 'save'];
    for (const id of ids) rows.set(id, { id, label: LABELS[id], status: 'pending' });
    container?.classList.remove('hidden');
    update('source', { status: 'working', detail: remote ? 'Video telefona indiriliyor.' : 'Seçilen cihaz dosyası hazırlanıyor.' });
    timer = setTimer.call(globalThis, paint, 1000);
  }
  function finish(status = 'done', text = '') {
    active = false; finishedAt ??= now(); terminalText = text || terminalText;
    for (const row of rows.values()) if (ACTIVE.has(row.status)) {
      row.status = status === 'done' ? 'done' : status; row.endedAt = now();
      if (text && status !== 'done') row.detail = text;
    }
    if (timer !== null) clearTimer.call(globalThis, timer);
    timer = null; paint();
  }
  function observe(status) {
    if (!rows.size) begin({ motion: false });
    const progress = status.stageProgress || (typeof status.progress === 'object' ? status.progress : null);
    let step;
    if (status.state === 'RECONNECTING') {
      const row = rows.get(focused);
      if (row) update(row.id, { status: 'waiting', detail: status.message });
      return;
    }
    if (status.origin === 'device' || status.state === 'ENCODING_MP3') {
      const encoding = ['loading_encoder', 'decoding', 'encoding', 'finalizing_mp3', 'mp3_ready', 'cached'].includes(status.phase);
      step = encoding ? 'encode' : 'extract';
      if (encoding || status.phase === 'audio_extracted') done('extract', 'Ses kanalı cihazda ayrıldı.');
      if (status.phase === 'audio_extracted') return;
      if (status.phase === 'cached') { done('extract', 'Önceki MP3 kullanılıyor.'); done('encode', 'MP3 hazır.'); return; }
    } else if (status.state === 'HASHING_AUDIO') step = 'hash';
    else if (status.state === 'UPLOADING') {
      done('extract', 'Ses ayrıldı.'); done('encode', 'MP3 hazır.'); done('hash', 'MP3 kontrol edildi.'); step = 'upload';
    } else step = SERVER_STEPS[status.state];
    for (const stage of status.completedStages || []) if (SERVER_STEPS[stage]) done(SERVER_STEPS[stage]);
    if (status.origin === 'server') { done('hash'); done('upload', 'MP3 sunucu tarafından alındı.'); }
    if (step) update(step, { status: status.waiting ? 'waiting' : 'working', detail: status.message || '',
      lastServerContactAt: status.lastServerContactAt,
      loaded: progress?.loaded, total: progress?.total,
      unit: progress?.unit || (step === 'upload' ? 'bytes' : step === 'encode' ? 'percent' : '') });
    if (status.state === 'READY') {
      if (status.transcriptOnly) { done('serverAudio'); done('transcript'); done('speakers'); }
      else {
        for (const id of ['serverAudio', 'transcript', 'speakers', 'translation', 'voices', 'dub', 'align', 'subtitles', 'mix', 'package'])
          if (rows.has(id)) done(id, 'Sonuç hazır.');
      }
    }
    if (['FAILED', 'CANCELLED'].includes(status.state)) finish(status.state === 'FAILED' ? 'failed' : 'cancelled', status.message);
  }
  return { begin, update, done, observe, finish, snapshot: () => [...rows.values()].map(row => ({ ...row })) };
}
