import { createGameStore, exportGame, importGame, storageError } from './saved-games.js';
import { retryableAnalysisGaps } from './analysis-gap-repair.js';

const sizeText = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const durationText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export const savedGameHasDub = row => row?.dubReady === true && Number(row.mixBytes) > 0;

export function savedGameOperationError(error) {
  if (error?.code === 'GEMINI_CREDITS_DEPLETED') {
    return 'Eksik bölümler analiz edilemedi: Gemini API kredisi veya proje kotası şu anda kullanılamıyor. Kayıtlı video ve mevcut analiz korunuyor. Kullanılabilir bir Gemini anahtarı ekledikten veya kota yenilendikten sonra yeniden dene.';
  }
  return storageError(error);
}

const repairErrorLabels = {
  GEMINI_CONTENT_RESTRICTED: 'Gemini içerik kısıtlaması',
  GEMINI_MODEL_UNAVAILABLE: 'Model bu API anahtarında kullanılamıyor (404)',
  GEMINI_INVALID_REQUEST: 'Model bu analiz biçimini desteklemiyor (400)',
  GEMINI_AUTH_ERROR: 'API anahtarı veya erişim hatası',
  GEMINI_CREDITS_DEPLETED: 'API kredi/kota hatası',
  GEMINI_RATE_LIMITED: 'Hız sınırı / kota',
  GEMINI_DAILY_LIMIT: 'Günlük kota sınırı',
  GEMINI_TEMPORARILY_UNAVAILABLE: 'Gemini geçici olarak kullanılamıyor',
  NETWORK_OR_ANALYSIS_ERROR: 'Bağlantı veya analiz hatası',
  NO_VERIFIED_ACTIONS: 'Doğrulanmış yeni eylem bulunamadı',
  GEMINI_NO_VERIFIED_EVENTS: 'Gemini yanıtladı, ancak doğrulanmış yeni olay üretemedi'
};
export function describeSavedGameRepair(analysis) {
  const run = analysis?.lastRepairAttempt;
  if (!run || !Array.isArray(run.results)) return null;
  const verified = run.results.reduce((count, item) =>
    count + Math.max(0, Number(item?.verifiedActions) || 0), 0);
  const summary = `${run.model}: ${run.recovered}/${run.total} eksik bölüm tamamlandı, ${run.remaining} aralık eksik` +
    (verified ? ` · ${verified} doğrulanmış olay` : ' · yeni doğrulanmış olay yok') + '.';
  const details = run.results.map((item, index) => {
    const range = `${Number(item.startTime).toFixed(1)}–${Number(item.endTime).toFixed(1)} sn`;
    const count = Math.max(0, Number(item.verifiedActions) || 0);
    const result = item.outcome === 'processed'
      ? count ? `Bölüm tamamlandı · ${count} doğrulanmış olay`
        : 'Model yanıtladı, doğrulanmış olay yok; bölüm tamamlanmadı'
      : item.outcome === 'partial'
        ? `Kısmi gözlem · ${count} doğrulanmış olay, kalan saniyeler hâlâ eksik`
      : item.outcome === 'skipped_previous_rejection'
        ? 'Önceki içerik reddi nedeniyle tekrar gönderilmedi'
      : item.outcome === 'skipped_previous_empty'
        ? 'Önceki boş analiz nedeniyle aynı istek gönderilmedi'
      : item.outcome === 'skipped_model_error' ? 'Model hatası nedeniyle gönderilmedi'
      : repairErrorLabels[item.reason] || item.reason || 'Analiz başarısız';
    return `${index + 1}. ${range}: ${result}${item.httpStatus ? ` · HTTP ${item.httpStatus}` : ''}`;
  }).join('\n');
  return { summary, details, error: Number(run.remaining) > 0 };
}

export function mountSavedGames({ root, capture, getCurrentGame = capture, store = createGameStore(), openGame, repairGame, loadRepairModels, isBusy, onBusy, onSaved, onDeleted }) {
  const list = root.querySelector('[data-games-list]');
  const status = root.querySelector('[data-games-status]');
  const storage = root.querySelector('[data-games-storage]');
  const title = root.querySelector('[data-game-title]');
  const fileInput = root.querySelector('[data-games-import]');
  let busy = false;
  let rows = [];
  let controlsGeneration = 0;
  let repairModels = [];
  let repairModelsLoaded = false;
  let repairModelsError = '';
  const chosenModelByGame = new Map();
  const recentRepairReports = new Map();

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('save-error', error);
  }
  async function refreshControls() {
    const generation = ++controlsGeneration;
    const locked = busy || isBusy();
    for (const el of root.querySelectorAll('button,input,select'))
      el.disabled = locked || (!repairModels.length &&
        (el.dataset?.action === 'repair' || el.matches?.('.saved-game-model-picker select')));
    const save = root.querySelector('[data-game-save]');
    const backup = root.querySelector('[data-game-export-current]');
    save.disabled = backup.disabled = title.disabled = true;
    if (locked) return;
    try {
      const current = await getCurrentGame();
      if (generation !== controlsGeneration || busy || isBusy()) return;
      save.disabled = backup.disabled = title.disabled = !current;
      title.placeholder = current?.fileName || 'Oyun adı (isteğe bağlı)';
    } catch (error) {
      if (generation === controlsGeneration) message(storageError(error), true);
    }
  }
  async function storageStatus(request = false) {
    try {
      if (request) await navigator.storage?.persist?.();
      const [persistent, estimate] = await Promise.all([
        navigator.storage?.persisted?.(), navigator.storage?.estimate?.()
      ]);
      storage.textContent = [
        persistent ? 'Cihazda saklama koruması açık.' : 'Tarayıcı saklama koruması vermedi; önemli kayıtlar için yedek indir.',
        estimate?.quota ? `Site depolaması: ${sizeText(estimate.usage || 0)} / ${sizeText(estimate.quota)}.` : ''
      ].join(' ');
    } catch { storage.textContent = 'Tarayıcının saklama koruması doğrulanamadı; önemli kayıtlar için yedek indir.'; }
  }
  function download(game) {
    const blob = exportGame(game);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${game.title.replace(/[^\p{L}\p{N}\s_-]/gu, '').slice(0, 80) || 'kayitli-oyun'}.vqgame`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function refresh() {
    rows = await store.list();
    list.replaceChildren();
    root.querySelector('[data-games-count]').textContent = String(rows.length);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'saved-games-empty';
      empty.textContent = 'Henüz kayıt yok. Tamamlanan analizler video ile birlikte otomatik kaydedilir.';
      list.append(empty);
    }
    for (const row of rows) {
      const card = document.createElement('article');
      card.className = 'saved-game';
      const name = document.createElement('h3');
      name.textContent = row.title;
      const detail = document.createElement('p');
      const gapCount = Number(row.analysisGapCount || 0);
      // Older saves cached zero repairable gaps while provider restrictions were excluded.
      // All declared gaps are now user-initiated retries; trust the durable gap count.
      const repairableCount = gapCount;
      detail.textContent = `${durationText(row.duration)} · ${sizeText(row.totalBytes)} · ${row.sourceKind === 'url' ? 'URL videosu' : 'Cihaz videosu'}${savedGameHasDub(row) ? ' · Dublaj kayıtlı' : ''}${gapCount ? ` · ${gapCount} eksik aralık · kullanıcı isteğiyle yeniden dene` : ''}`;
      let modelPicker = null;
      let modelSelect = null;
      if (repairableCount && repairGame) {
        modelPicker = document.createElement('label');
        modelPicker.className = 'saved-game-model-picker';
        modelPicker.textContent = 'Eksik analiz için Gemini modeli';
        modelSelect = document.createElement('select');
        modelSelect.setAttribute('aria-label', row.title + ' · Gemini modeli');
        if (!repairModels.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = repairModelsError ||
            (repairModelsLoaded ? 'Uygun Gemini modeli bulunamadı' : 'Uygun modeller yükleniyor…');
          modelSelect.append(option);
          modelSelect.disabled = true;
        }
        for (const model of repairModels) {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          modelSelect.append(option);
        }
        const savedChoice = chosenModelByGame.get(row.id);
        const preferred = repairModels.includes('gemini-3.8-flash')
          ? 'gemini-3.8-flash' : repairModels[0] || '';
        modelSelect.value = repairModels.includes(savedChoice) ? savedChoice : preferred;
        modelSelect.addEventListener('change', () => chosenModelByGame.set(row.id, modelSelect.value));
        modelPicker.append(modelSelect);
      }
      const actions = document.createElement('div');
      actions.className = 'saved-game-actions';
      for (const [label, action] of [['Baştan oyna', 'play'], ...(gapCount ? [['Eksik sahneleri göster', 'inspect']] : []), ...(repairableCount && repairGame ? [['Eksik bölümleri analiz et', 'repair']] : []), ['Yedek indir', 'export'], ['Sil', 'delete']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.action = action;
        if (action === 'repair' && !repairModels.length) button.disabled = true;
        button.addEventListener('click', () => void run(async () => {
          if (action === 'delete') {
            if (!confirm(`“${row.title}” kaydını ve kayıtlı videosunu bu cihazdan silmek istiyor musun?`)) return;
            await store.remove(row.id);
            onDeleted(row.id);
            recentRepairReports.delete(row.id);
            await refresh();
            message('Kayıt silindi. İndirdiğin yedek dosyaları silinmedi.');
          } else if (action === 'repair') {
            const game = await store.load(row.id);
            const missing = retryableAnalysisGaps(game.payload.analysis, game.duration);
            if (!missing.length) throw new Error('Bu kayıtta doğrulanmış eksik analiz aralığı yok.');
            const model = modelSelect?.value;
            if (!model || !repairModels.includes(model))
              throw new Error('Önce kullanılabilir bir Gemini analiz modeli seç.');
            message(`${missing.length} eksik aralık ${model} ile yeniden analiz ediliyor…`);
            const analysis = await repairGame(game, update => message(update), model);
            const updated = { ...game, payload: { ...game.payload, analysis } };
            await store.save(updated, row.id);
            const report = describeSavedGameRepair(analysis);
            if (report) recentRepairReports.set(row.id, report);
            await openGame(updated);
            title.value = row.title;
            await refresh();
            message(report?.summary || 'Eksik analiz sonucu kaydedildi.', report?.error || false);
          } else if (action === 'inspect') {
            const inspected = await store.load(row.id);
            const report = describeSavedGameRepair(inspected.payload.analysis);
            if (report) recentRepairReports.set(row.id, report);
            await openGame(inspected);
            await refresh();
            root.ownerDocument?.getElementById('analysisReview')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
            message('Eksik aralıkları ve kaynak sahnelerini analiz kartından inceleyebilirsin.');
          } else if (action === 'play') {
            message('Kayıtlı video açılıyor…');
            await openGame(await store.load(row.id));
            title.value = row.title;
            message('Kayıt açıldı. Video tekrar indirilmedi; yeniden analiz yapılmadı.');
          } else {
            message('Video ve analiz yedekleniyor…');
            download(await store.load(row.id));
            message('Yedek dosyası indirilmeye gönderildi. İndirmenin tamamlandığını tarayıcıdan kontrol et.');
          }
        }));
        actions.append(button);
      }
      card.append(name, detail, ...(modelPicker ? [modelPicker] : []), actions);
      const report = recentRepairReports.get(row.id);
      if (report) {
        const details = document.createElement('details');
        details.className = 'saved-game-repair-report';
        details.open = report.error;
        const summary = document.createElement('summary');
        summary.textContent = report.summary;
        const body = document.createElement('pre');
        body.textContent = report.details;
        details.append(summary, body);
        card.append(details);
      }
      list.append(card);
    }
    refreshControls();
  }
  async function run(operation, automatic = false) {
    if (busy || (!automatic && isBusy())) return false;
    busy = true;
    onBusy(true);
    refreshControls();
    try { await operation(); return true; }
    catch (error) { message(savedGameOperationError(error), true); return false; }
    finally { busy = false; onBusy(false); refreshControls(); }
  }
  async function saveCurrent(automatic = false) {
    return run(async () => {
      const current = await getCurrentGame();
      if (!current) throw new Error('Önce bir video analizi tamamlanmalı.');
      message('Video ve analiz cihazına kaydediliyor; bu işlem bitene kadar sayfayı kapatma…');
      await storageStatus(true);
      const saved = await store.save({ ...current, title: title.value.trim() || current.title }, current.id);
      onSaved(saved, current);
      message('Kaydedildi. Uygulamayı kapatıp açtığında buradan yeniden oynayabilirsin.');
      await refresh();
      void storageStatus();
    }, automatic);
  }
  root.querySelector('[data-game-save]').addEventListener('click', () => void saveCurrent());
  root.querySelector('[data-game-export-current]').addEventListener('click', () => void run(async () => {
    const current = await getCurrentGame();
    if (!current) return;
    download({ ...current, title: title.value.trim() || current.title });
    message('Video ve analiz yedeği indirilmeye gönderildi. İndirmenin tamamlandığını kontrol et.');
  }));
  root.querySelector('[data-games-import-button]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void run(async () => {
      message('Yedek kontrol ediliyor ve cihazına kaydediliyor…');
      const game = await importGame(file);
      await storageStatus(true);
      await store.save(game);
      await refresh();
      message('Yedek geri yüklendi. “Baştan oyna” ile açabilirsin.');
      void storageStatus();
    });
  });
  const updateOnFocus = () => { if (!busy) void refresh().catch(error => message(storageError(error), true)); };
  window.addEventListener('focus', updateOnFocus);
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  void refresh().catch(error => message(storageError(error), true));
  if (loadRepairModels) {
    void Promise.resolve().then(loadRepairModels).then(models => {
      repairModels = [...new Set(Array.isArray(models) ? models : [])]
        .filter(name => /^gemini-[a-z0-9][a-z0-9._-]*$/i.test(name)).sort();
      repairModelsLoaded = true;
      repairModelsError = '';
      if (!busy) return refresh();
    }).catch(() => {
      repairModels = [];
      repairModelsLoaded = true;
      repairModelsError = 'Modeller alınamadı; sayfayı yenile';
      if (!busy) return refresh();
    });
  }
  void storageStatus();
  return {
    saveCurrent, refreshControls,
    setSyncOffset(id, offset) { return store.updateLanguageSync(id, offset); },
    updateDubAudio(id, audio, manifest) { return store.updateDubAudio(id, audio, manifest); },
    resetCurrent() { title.value = ''; refreshControls(); }
  };
}
