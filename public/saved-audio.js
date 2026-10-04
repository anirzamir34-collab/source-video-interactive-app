// Older final mixes used IEEE float WAV. Convert only that legacy format to
// signed 16-bit PCM for native playback, retaining every frame and channel.
export async function repairSavedAudio(blob, onProgress = () => {}, boundaries = []) {
  if (!(blob instanceof Blob) || !/audio\/(?:wav|wave|x-wav)/i.test(blob.type)) return blob;
  const tag = (view, offset) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));
  const first = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (first.byteLength < 12 || tag(first, 0) !== 'RIFF' || tag(first, 8) !== 'WAVE') return blob;
  let offset = 12, format, data;
  while (offset + 8 <= blob.size) {
    const chunk = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    const name = tag(chunk, 0), size = chunk.getUint32(4, true), start = offset + 8;
    if (start + size > blob.size) throw new Error('Kayıtlı WAV dosyası eksik; kayıt korunuyor.');
    if (name === 'fmt ') {
      if (size < 16) throw new Error('Kayıtlı WAV başlığı geçersiz.');
      const header = new DataView(await blob.slice(start, start + Math.min(size, 40)).arrayBuffer());
      let code = header.getUint16(0, true);
      if (code === 65534 && size >= 40) code = header.getUint16(24, true);
      format = { code, channels: header.getUint16(2, true), rate: header.getUint32(4, true),
        block: header.getUint16(12, true), bits: header.getUint16(14, true) };
    }
    if (name === 'data') data = { start, size };
    offset = start + size + (size % 2);
  }
  const float = format?.code === 3 && format.bits === 32;
  const integer = format?.code === 1 && format.bits === 16;
  if (!float && !(integer && boundaries.length)) return blob;
  const stride = float ? 4 : 2;
  if (!data || !data.size || !format.channels || format.channels > 8 || !format.rate ||
      format.block !== format.channels * stride || data.size % format.block) throw new Error('Kayıtlı float WAV biçimi geçersiz.');
  const outputSize = data.size / stride * 2;
  const edges = [...new Set(boundaries.filter(value => Number.isFinite(value) && value >= 0).map(value => Math.round(value * format.rate)))].sort((a, b) => a - b);
  const fade = Math.max(1, Math.round(format.rate * .005));
  let edge = 0;
  const header = new ArrayBuffer(44), view = new DataView(header);
  const putTag = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  putTag(0, 'RIFF'); view.setUint32(4, 36 + outputSize, true); putTag(8, 'WAVE');
  putTag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true); view.setUint32(24, format.rate, true);
  view.setUint32(28, format.rate * format.channels * 2, true);
  view.setUint16(32, format.channels * 2, true); view.setUint16(34, 16, true);
  putTag(36, 'data'); view.setUint32(40, outputSize, true);
  const parts = [header], chunkSize = Math.floor(1024 * 1024 / format.block) * format.block;
  for (let at = 0; at < data.size; at += chunkSize) {
    const input = new DataView(await blob.slice(data.start + at, data.start + Math.min(data.size, at + chunkSize)).arrayBuffer());
    const output = new DataView(new ArrayBuffer(input.byteLength / stride * 2));
    for (let i = 0; i < input.byteLength / stride; i++) {
      let value = float ? input.getFloat32(i * stride, true) : input.getInt16(i * stride, true) / 32768;
      const frame = Math.floor((at / stride + i) / format.channels);
      while (edge < edges.length && edges[edge] < frame) edge++;
      const distance = Math.min(Math.abs(frame - (edges[edge] ?? Infinity)), Math.abs(frame - (edges[edge - 1] ?? -Infinity)));
      if (distance < fade) value *= distance / fade;
      if (!Number.isFinite(value)) throw new Error('Kayıtlı seste geçersiz örnek bulundu; kayıt korunuyor.');
      const clipped = Math.max(-1, Math.min(1, value));
      output.setInt16(i * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
    }
    parts.push(output.buffer);
    onProgress(Math.min(1, (at + input.byteLength) / data.size));
  }
  return new Blob(parts, { type: blob.type });
}
