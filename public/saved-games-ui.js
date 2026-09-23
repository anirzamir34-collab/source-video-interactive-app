import { createGameStore, exportGame, importGame, storageError } from './saved-games.js';
import { repairableAnalysisGaps } from './analysis-gap-repair.js';

const sizeText = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const durationText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function mountSavedGames({ root, capture, openGame, repairGame, isBusy, onBusy, onSaved, onDeleted }) {
  const store = createGameStore();
  const list = root.querySelector('[data-games-list]');
  const status = root.querySelector('[data-games-status]');
  const storage = root.querySelector('[data-games-storage]');
  const title = root.querySelector('[data-game-title]');
  const fileInput = root.querySelector('[data-games-import]');
  let busy = false;
  let rows = [];

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('save-error', error);
  }
  function refreshControls() {
    const locked = busy || isBusy();
    for (const el of root.querySelectorAll('button,input')) el.disabled = locked;
    const current = capture();
    root.querySelector('[data-game-save]').disabled = locked || !current;
    root.querySelector('[data-game-export-current]').disabled = locked || !current;
    title.disabled = locked || !current;
    title.placeholder = current?.fileName || 'Oyun adı (isteğe bağlı)';
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
      detail.textContent = `${durationText(row.duration)} · ${sizeText(row.totalBytes)} · ${row.sourceKind === 'url' ? 'URL videosu' : 'Cihaz videosu'}${row.dubCount ? ' · Dublaj kayıtlı' : ''}${gapCount ? ` · ${gapCount} eksik aralık` : ''}`;
      const actions = document.createElement('div');
      actions.className = 'saved-game-actions';
      for (const [label, action] of [['Baştan oyna', 'play'], ...(gapCount && repairGame ? [['Eksik bölümleri analiz et', 'repair']] : []), ['Yedek indir', 'export'], ['Sil', 'delete']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.action = action;
        button.addEventListener('click', () => void run(async () => {
          if (action === 'delete') {
            if (!confirm(`“${row.title}” kaydını ve kayıtlı videosunu bu cihazdan silmek istiyor musun?`)) return;
            await store.remove(row.id);
            onDeleted(row.id);
            await refresh();
            message('Kayıt silindi. İndirdiğin yedek dosyaları silinmedi.');
          } else if (action === 'repair') {
            const game = await store.load(row.id);
            const missing = repairableAnalysisGaps(game.payload.analysis, game.duration);
            if (!missing.length) throw new Error('Bu kayıtta doğrulanmış eksik analiz aralığı yok.');
            message(`${missing.length} eksik aralık yeniden analiz ediliyor…`);
            const analysis = await repairGame(game, update => message(update));
            const updated = { ...game, payload: { ...game.payload, analysis } };
            await store.save(updated, row.id);
            await openGame(updated);
            title.value = row.title;
            await refresh();
            message(analysis.analysisGaps?.length
              ? `${analysis.analysisGaps.length} aralık hâlâ eksik. Başarılı sonuçlar aynı kayda eklendi.`
              : 'Eksik aralıklar tamamlandı ve aynı kayda eklendi.');
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
      card.append(name, detail, actions);
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
    catch (error) { message(storageError(error), true); return false; }
    finally { busy = false; onBusy(false); refreshControls(); }
  }
  async function saveCurrent(automatic = false) {
    return run(async () => {
      const current = capture();
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
    const current = capture();
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
  void storageStatus();
  return {
    saveCurrent, refreshControls,
    resetCurrent() { title.value = ''; refreshControls(); }
  };
}
