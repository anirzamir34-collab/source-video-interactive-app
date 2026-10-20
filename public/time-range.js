// "12:30", "1:02:05", "12" (minutes) or "12.5" -> seconds; '' -> null.
export function parseClock(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 60;
  const parts = raw.split(/[:.]/).map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) return NaN;
  if (parts.slice(1).some(part => part >= 60)) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Returns { start, end } in seconds or { error } in Turkish.
export function resolveCutRange(startText, endText, duration) {
  const total = Number(duration) || 0;
  const start = parseClock(startText) ?? 0;
  const end = parseClock(endText) ?? total;
  if (Number.isNaN(start) || Number.isNaN(end)) return { error: 'Süreyi dakika:saniye olarak yaz (ör. 12:30).' };
  if (total && start >= total) return { error: `Başlangıç videonun süresinden (${formatClock(total)}) sonra.` };
  const clampedEnd = total ? Math.min(end, total) : end;
  if (!Number.isFinite(clampedEnd) || clampedEnd <= 0) return { error: 'Bitiş zamanını yaz.' };
  if (clampedEnd - start < 5) return { error: 'Bitiş, başlangıçtan en az 5 saniye sonra olmalı.' };
  if (start <= 0 && total && clampedEnd >= total - 0.5) return { error: 'Başlangıç ya da bitiş yaz; boş bırakırsan tüm video analiz edilir.' };
  return { start, end: clampedEnd };
}
