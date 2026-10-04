import { open, stat } from 'node:fs/promises';

// PCM duration and slices come from sample counts, not container estimates.
// Keep only a small copy buffer in memory even for a full-length soundtrack.
export async function readPcm(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
    let format;
    for (let offset = 12; offset + 8 <= bytesRead;) {
      const id = header.toString('ascii', offset, offset + 4), length = header.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (id === 'fmt ' && length >= 16 && length <= 128 && data + length <= bytesRead) format = Buffer.from(header.subarray(data, data + length));
      if (id === 'data' && format) {
        let code = format.readUInt16LE(0);
        if (code === 65534) {
          if (format.length < 40 || format.subarray(26, 40).toString('hex') !== '000000001000800000aa00389b71') return null;
          code = format.readUInt16LE(24);
        }
        const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4);
        const block = format.readUInt16LE(12), bits = format.readUInt16LE(14);
        if (![1, 3].includes(code) || channels < 1 || channels > 8 || rate < 8000 || rate > 192000 ||
          ![8, 16, 24, 32, 64].includes(bits) || (code === 3 && ![32, 64].includes(bits)) ||
          block !== channels * bits / 8 || format.readUInt32LE(8) !== rate * block ||
          !length || length % block || data + length > size) return null;
        return { file, format, code, channels, rate, block, dataOffset: data, dataBytes: length,
          samples: length / block, duration: length / block / rate };
      }
      offset = data + length + (length % 2);
    }
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

export async function fileExists(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function copyPcm(pcm, output, { start = 0, end = pcm.samples, samples = end - start, signal } = {}) {
  signal?.throwIfAborted();
  if (![start, end, samples].every(Number.isSafeInteger) || start < 0 || end > pcm.samples || end <= start || samples < end - start)
    throw new Error('Invalid PCM sample range.');
  const bytes = samples * pcm.block;
  const formatPad = pcm.format.length % 2;
  const factLength = pcm.code === 3 ? 12 : 0;
  const header = Buffer.alloc(12 + 8 + pcm.format.length + formatPad + factLength + 8);
  if (bytes + header.length - 8 > 0xffffffff) throw new Error('PCM output is too large.');
  header.write('RIFF', 0); header.writeUInt32LE(bytes + header.length - 8, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(pcm.format.length, 16); pcm.format.copy(header, 20);
  let offset = 20 + pcm.format.length + formatPad;
  if (factLength) { header.write('fact', offset); header.writeUInt32LE(4, offset + 4); header.writeUInt32LE(samples, offset + 8); offset += 12; }
  header.write('data', offset); header.writeUInt32LE(bytes, offset + 4);
  let source, target;
  try {
    source = await open(pcm.file, 'r'); target = await open(output, 'w');
    await target.writeFile(header);
    const buffer = Buffer.alloc(Math.min(256 * 1024, (end - start) * pcm.block));
    let copied = 0, remaining = (end - start) * pcm.block;
    while (remaining) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, remaining), pcm.dataOffset + start * pcm.block + copied);
      if (!bytesRead) throw new Error('PCM input ended before its declared sample range.');
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, header.length + copied + written);
        if (!result.bytesWritten) throw new Error('PCM output could not be written.');
        written += result.bytesWritten;
      }
      copied += bytesRead; remaining -= bytesRead;
    }
    if (pcm.code === 1 && pcm.format.readUInt16LE(14) === 8 && samples > end - start) {
      const silence = Buffer.alloc(256 * 1024, 128);
      for (let offset = copied; offset < bytes;) {
        signal?.throwIfAborted();
        const result = await target.write(silence, 0, Math.min(silence.length, bytes - offset), header.length + offset);
        if (!result.bytesWritten) throw new Error('PCM silence could not be written.');
        offset += result.bytesWritten;
      }
    }
    // Extending signed/float PCM yields zero samples without an encoder.
    await target.truncate(header.length + bytes);
    signal?.throwIfAborted();
    return { path: output, duration: samples / pcm.rate, mimeType: 'audio/wav' };
  } finally { await Promise.allSettled([source?.close(), target?.close()]); }
}

export async function mutedPcm(pcm, output, intervals, signal) {
  await copyPcm(pcm, output, { signal });
  const muted = await readPcm(output), handle = await open(output, 'r+');
  const zeros = Buffer.alloc(256 * 1024);
  try {
    for (const row of intervals) {
      let offset = Math.round(row.start * pcm.rate) * pcm.block;
      const end = Math.min(pcm.dataBytes, Math.round(row.end * pcm.rate) * pcm.block);
      while (offset < end) {
        signal?.throwIfAborted();
        const { bytesWritten } = await handle.write(zeros, 0, Math.min(zeros.length, end - offset), muted.dataOffset + offset);
        if (!bytesWritten) throw new Error('PCM mute could not be written.');
        offset += bytesWritten;
      }
    }
  } finally { await handle.close(); }
  return output;
}

export async function composePcm(parts, output, samples, signal) {
  const format = parts[0].pcm;
  // Initialize a sparse timeline, then sum only actual turn samples. It avoids
  // asking a filter to decode/delay dozens of silent full-video soundtracks.
  await copyPcm(format, output, { samples: Math.max(samples, format.samples), signal });
  const timeline = await readPcm(output), target = await open(output, 'r+');
  const buffer = Buffer.alloc(256 * 1024), accumulated = Buffer.alloc(buffer.length);
  try {
    // The copied format template is cleared before any turn is placed.
    const zeros = Buffer.alloc(buffer.length);
    for (let offset = 0; offset < format.dataBytes;) {
      signal?.throwIfAborted();
      const { bytesWritten } = await target.write(zeros, 0, Math.min(zeros.length, format.dataBytes - offset), timeline.dataOffset + offset);
      if (!bytesWritten) throw new Error('PCM timeline could not be initialized.');
      offset += bytesWritten;
    }
    for (const part of parts) {
      signal?.throwIfAborted();
      const source = await open(part.pcm.file, 'r');
      try {
        const placement = Math.round(part.start * format.rate) * format.block;
        for (let offset = 0; offset < part.pcm.dataBytes;) {
          signal?.throwIfAborted();
          const length = Math.min(buffer.length, part.pcm.dataBytes - offset);
          const loaded = await source.read(buffer, 0, length, part.pcm.dataOffset + offset);
          if (loaded.bytesRead !== length) throw new Error('PCM turn is incomplete.');
          accumulated.fill(0, 0, length);
          const existing = await target.read(accumulated, 0, length, timeline.dataOffset + placement + offset);
          if (existing.bytesRead !== length) throw new Error('PCM turn exceeds the timeline.');
          for (let i = 0; i < length; i += 4) accumulated.writeFloatLE(accumulated.readFloatLE(i) + buffer.readFloatLE(i), i);
          let written = 0;
          while (written < length) {
            const result = await target.write(accumulated, written, length - written, timeline.dataOffset + placement + offset + written);
            if (!result.bytesWritten) throw new Error('PCM turn could not be placed.');
            written += result.bytesWritten;
          }
          offset += length;
        }
      } finally { await source.close(); }
    }
  } finally { await target.close(); }
  return output;
}
