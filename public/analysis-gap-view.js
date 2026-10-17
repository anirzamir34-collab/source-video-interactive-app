import { repairableAnalysisGaps } from './analysis-gap-repair.js';

const descriptions = {
  GEMINI_CONTENT_RESTRICTED: 'Gemini bu bölüm için içerik kısıtlaması bildirdi. Hangi tek karenin neden olduğu servis yanıtında belirtilmiyor.',
  MODEL_UNSTRUCTURED_RESPONSE: 'Model kullanılabilir yapılandırılmış analiz döndürmedi.',
  GEMINI_EMPTY_RESPONSE: 'Model boş yanıt döndürdü.',
  GEMINI_NO_VERIFIED_EVENTS: 'Gemini isteğe yanıt verdi ancak bu aralık için doğrulanmış yeni sahne olayı üretemedi. Eksik bölüm tamamlanmadı.',
  NEUTRAL_REPAIR_UNVERIFIED: 'Bu aralıkta sıradan, doğrulanabilir bir olay bulunamadı; görsel devamlılık ve oyun seçenekleri hâlâ doğrulanmadı.',
  GEMINI_INVALID_JSON: 'Model yanıtı okunabilir analiz biçiminde değildi.',
  GEMINI_CREDITS_DEPLETED: 'Analiz kredisi veya kota tükendi.',
  CHUNK_ANALYSIS_GAP: 'Bu bölümün analizi tamamlanamadı.'
};

export function analysisReviewItems(analysis, duration) {
  const gaps = repairableAnalysisGaps(analysis, duration).map(gap => ({
    startTime: gap.startTime, endTime: gap.endTime,
    title: Number.isInteger(gap.chunkIndex) ? `Eksik bölüm ${gap.chunkIndex + 1}` : 'Eksik analiz aralığı',
    detail: descriptions[gap.reason] || `Analiz tamamlanamadı (${String(gap.reason || 'bilinmeyen neden')}).`
  }));
  const omitted = (Array.isArray(analysis?.warnings) ? analysis.warnings : [])
    .filter(item => item && typeof item === 'object' && item.code === 'VERIFIED_APPROACH_REJECTED')
    .map(item => ({ startTime: Number(item.sourceStartTime), endTime: Number(item.sourceEndTime),
      title: `Oyuna alınmayan bulgu ${String(item.actionId || '')}`,
      detail: `Sahne eşleşmesi: ${String(item.membershipReason || 'belirsiz')}. Kaynak aralık incelenebilir.` }))
    .filter(item => Number.isFinite(item.startTime) && Number.isFinite(item.endTime) &&
      item.startTime >= 0 && item.endTime > item.startTime && item.endTime <= duration + .1);
  return [...gaps, ...omitted].sort((a, b) => a.startTime - b.startTime);
}

const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// Preview the exact source range on the user's device. No frames or video are uploaded.
export function mountAnalysisReview(container, analysis, sourceVideo, duration) {
  container.replaceChildren();
  const items = analysisReviewItems(analysis, duration);
  if (!items.length || !(sourceVideo instanceof Blob)) {
    container.hidden = true;
    return () => {};
  }
  container.hidden = false;
  const heading = document.createElement('h3');
  heading.textContent = `İncelenecek kaynak aralıklar (${items.length})`;
  const note = document.createElement('p');
  note.textContent = 'Aralığı açınca kayıtlı videonun ilgili sahnesi cihazında oynatılır. Servis belirli bir kareyi işaretlemediyse bütün aralık gösterilir.';
  const list = document.createElement('div');
  const player = document.createElement('video');
  player.controls = true;
  player.playsInline = true;
  player.preload = 'metadata';
  player.hidden = true;
  let url = null;
  let selected = null;
  player.addEventListener('timeupdate', () => {
    if (selected && player.currentTime >= selected.endTime) player.pause();
  });
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${item.title} · ${clock(item.startTime)}–${clock(item.endTime)}`;
    const detail = document.createElement('p');
    detail.textContent = item.detail;
    button.addEventListener('click', () => {
      selected = item;
      if (!url) {
        url = URL.createObjectURL(sourceVideo);
        player.src = url;
      }
      player.hidden = false;
      const seek = () => { player.currentTime = Math.max(0, item.startTime); };
      if (player.readyState >= 1) seek();
      else player.addEventListener('loadedmetadata', seek, { once: true });
      player.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    });
    const row = document.createElement('div');
    row.className = 'analysis-review-row';
    row.append(button, detail);
    list.append(row);
  }
  container.append(heading, note, list, player);
  return () => {
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (url) URL.revokeObjectURL(url);
    container.replaceChildren();
    container.hidden = true;
  };
}
