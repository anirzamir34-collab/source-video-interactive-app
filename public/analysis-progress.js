const LABELS = {
  source: 'Video dosyasının hazırlanması', extract: 'Videodan sesin ayrılması',
  encode: 'Sesin MP3’e dönüştürülmesi', hash: 'MP3 dosyasının kontrolü',
  upload: 'MP3 sesin gönderilmesi', serverAudio: 'Sesin sunucuda hazırlanması',
  transcript: 'Konuşmaların çözümlenmesi', speakers: 'Konuşmacıların belirlenmesi',
  frames: 'Video karelerinin hazırlanması', frameUpload: 'Analiz görüntülerinin gönderilmesi', analysis: 'Sahne ve seçim analizi',
  review: 'Görsel bulguların doğrulanması', integrity: 'Analiz bütünlüğü kontrolü',
  translation: 'Konuşmaların Türkçeye çevrilmesi', voices: 'Konuşmacı seslerinin eşleştirilmesi',
  dub: 'ElevenLabs v4 Türkçe dublaj', align: 'Ses ve kelime zamanlarının hizalanması',
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
  const doc = list?.ownerDocument || globalThis.document;
  function paint() {
    if (!list || !doc) return;
    list.replaceChildren();
    const running = [];
    for (const row of rows.values()) {
      const element = doc.createElement('li'); element.dataset.status = row.status;
      const name = doc.createElement('strong'); name.textContent = row.label;
      const state = doc.createElement('span'); state.className = 'analysis-step-state';
      const age = row.startedAt === undefined ? '' : ' · ' + seconds((row.endedAt ?? now()) - row.startedAt);
      const labels = { pending: 'Sırada', working: 'Çalışıyor', waiting: 'Yanıt bekleniyor',
        retrying: 'Yeniden deneniyor', done: 'Tamamlandı', reused: 'Önceki sonuç', failed: 'Hata', cancelled: 'İptal edildi' };
      state.textContent = (labels[row.status] || row.status) + age;
      const info = doc.createElement('small'); info.textContent = row.detail || '';
      if (row.lastServerContactAt && ACTIVE.has(row.status)) info.textContent +=
        ' · Son sunucu yanıtı ' + seconds(now() - row.lastServerContactAt) + ' önce';
      if (Number.isFinite(row.loaded) && row.total > 0) {
        const amount = row.unit === 'bytes' ? MB(row.loaded) + ' / ' + MB(row.total)
          : row.unit === 'percent' ? '%' + Math.floor(row.loaded / row.total * 100)
          : row.loaded + ' / ' + row.total + (row.unit ? ' ' + row.unit : '');
        info.textContent = [amount, info.textContent].filter(Boolean).join(' · ');
      }
      element.append(name, state, info);
      if (row.total > 0 && Number.isFinite(row.loaded)) {
        const progress = doc.createElement('progress'); progress.max = row.total;
        progress.value = Math.min(row.total, Math.max(0, row.loaded));
        progress.setAttribute('aria-label', row.label); element.append(progress);
      }
      list.append(element);
      if (ACTIVE.has(row.status)) running.push(row.label);
    }
    const complete = [...rows.values()].filter(row => ['done', 'reused'].includes(row.status)).length;
    if (summary) summary.textContent = complete + ' / ' + rows.size + ' işlem tamamlandı' +
      (startedAt ? ' · ' + seconds(now() - startedAt) : '');
    if (message) message.textContent = running.length ? 'Devam eden: ' + running.join(' · ')
      : active ? 'Bir sonraki işlem hazırlanıyor.' : complete === rows.size ? 'Seçili işlemler tamamlandı.' : 'İşlem durdu.';
    const focus = rows.get(focused);
    if (detail) detail.textContent = focus ? (focus.detail || focus.label) +
      (focus.startedAt === undefined ? '' : ' · ' + seconds((focus.endedAt ?? now()) - focus.startedAt)) : '';
    if (bar) {
      if (focus?.total > 0 && Number.isFinite(focus.loaded)) bar.value = Math.min(100, focus.loaded / focus.total * 100);
      else bar.removeAttribute('value');
    }
  }
  function update(id, changes = {}) {
    if (!LABELS[id]) return;
    let row = rows.get(id);
    if (!row) { row = { id, label: LABELS[id], status: 'pending' }; rows.set(id, row); }
    const status = changes.status || 'working';
    if (ACTIVE.has(status) && !ACTIVE.has(row.status)) { row.startedAt = now(); delete row.endedAt; }
    if (!ACTIVE.has(status) && status !== 'pending') row.endedAt = now();
    Object.assign(row, changes, { status });
    focused = id; container?.classList.remove('hidden'); paint();
  }
  function done(id, text = '') { update(id, { status: 'done', detail: text, ...(rows.get(id)?.total > 0 ? { loaded: rows.get(id).total } : {}) }); }
  function begin({ motion = false, dubbing = true, subtitles = true, remote = false } = {}) {
    if (timer !== null) clearTimer.call(globalThis, timer);
    rows.clear(); active = true; startedAt = now();
    const ids = ['source', 'extract', 'encode', 'hash', 'upload', 'serverAudio', 'transcript', 'speakers',
      ...(motion ? ['frames', 'frameUpload', 'analysis', 'review', 'integrity'] : []),
      ...(dubbing || subtitles ? ['translation'] : []),
      ...(dubbing ? ['voices', 'dub', 'align'] : []),
      ...(dubbing || subtitles ? ['subtitles'] : []), ...(dubbing ? ['mix'] : []), 'package', 'save'];
    for (const id of ids) rows.set(id, { id, label: LABELS[id], status: 'pending' });
    container?.classList.remove('hidden');
    update('source', { status: 'working', detail: remote ? 'Video telefona indiriliyor.' : 'Seçilen cihaz dosyası hazırlanıyor.' });
    timer = setTimer.call(globalThis, paint, 1000);
  }
  function finish(status = 'done', text = '') {
    active = false;
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
