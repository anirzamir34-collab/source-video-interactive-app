// Read-only metadata for an existing choice. No playback callbacks or routing.
const rangeNumber = value => value === null || value === '' || typeof value === 'boolean' ? NaN : Number(value);

export function clipDetailPage(clips = [], requestedPage = 0) {
  const seen = new Set();
  const rows = [];
  for (const clip of Array.isArray(clips) ? clips : []) {
    const start = rangeNumber(clip?.loopStartTime ?? clip?.startTime);
    const end = rangeNumber(clip?.loopEndTime ?? clip?.endTime);
    const id = String(clip?.id ?? clip?.actionId ?? '').trim();
    if (!id || clip?.sourceVerified !== true || !Number.isFinite(start) ||
        !Number.isFinite(end) || start < 0 || end <= start) continue;
    const key = JSON.stringify([id, start, end]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id, start, end, number: rows.length + 1 });
  }
  const pageCount = Math.ceil(rows.length / 4);
  const value = Number(requestedPage);
  const page = Math.max(0, Math.min(pageCount - 1, Number.isFinite(value) ? Math.trunc(value) : 0));
  return {
    rows: rows.slice(page * 4, page * 4 + 4),
    page, pageCount, total: rows.length,
    hasPrevious: page > 0, hasNext: page + 1 < pageCount
  };
}

export function clipDetailTime(seconds) {
  const value = rangeNumber(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const whole = Math.floor(value);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

export function createClipDetails(doc, clips) {
  const initial = clipDetailPage(clips);
  if (!initial.total) return null;
  const details = doc.createElement('details');
  details.className = 'choice-clip-details';
  const summary = doc.createElement('summary');
  summary.textContent = '≡';
  summary.title = `Kesitleri gör · ${initial.total}`;
  summary.setAttribute('aria-label', `Bu seçenekteki ${initial.total} kesitin zamanlarını göster`);
  details.appendChild(summary);
  const list = doc.createElement('ol');
  list.className = 'choice-clip-list';
  list.setAttribute('aria-label', 'Bu seçenekteki kesit zamanları');
  const pager = doc.createElement('div');
  pager.className = 'choice-clip-pager';
  const previous = doc.createElement('button');
  previous.type = 'button'; previous.textContent = '‹';
  previous.setAttribute('aria-label', 'Önceki kesit sayfası');
  const status = doc.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const next = doc.createElement('button');
  next.type = 'button'; next.textContent = '›';
  next.setAttribute('aria-label', 'Sonraki kesit sayfası');
  pager.append(previous, status, next);
  let page = 0;
  let rendered = false;
  const render = () => {
    const result = clipDetailPage(clips, page);
    page = result.page;
    list.replaceChildren();
    for (const row of result.rows) {
      const item = doc.createElement('li');
      const number = doc.createElement('span');
      number.className = 'choice-clip-number';
      number.textContent = `${row.number}.`;
      const times = doc.createElement('span');
      times.textContent = `${clipDetailTime(row.start)} – ${clipDetailTime(row.end)}`;
      item.title = `${row.start.toFixed(3)} – ${row.end.toFixed(3)} sn`;
      item.append(number, times);
      list.appendChild(item);
    }
    previous.disabled = !result.hasPrevious;
    next.disabled = !result.hasNext;
    pager.hidden = result.pageCount <= 1;
    status.textContent = `${result.rows[0]?.number || 0}–${result.rows.at(-1)?.number || 0} / ${result.total}`;
    if (!rendered) { details.append(list, pager); rendered = true; }
  };
  previous.addEventListener('click', () => { if (page > 0) { page -= 1; render(); } });
  next.addEventListener('click', () => { if (page + 1 < initial.pageCount) { page += 1; render(); } });
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    if (!rendered) render();
    const group = details.closest('.movement-choice-grid');
    for (const other of group?.querySelectorAll('.choice-clip-details[open]') || []) {
      if (other !== details) other.open = false;
    }
  });
  return details;
}
