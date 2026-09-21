export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MEMORY_VIDEO_BYTES = 600 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

export function dialogueUploadMimeType(file) {
  const type = String(file.type || '').split(';')[0].trim().toLowerCase();
  if (type && !['application/octet-stream', 'binary/octet-stream'].includes(type)) return type;
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  return ({ mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
    ogv: 'video/ogg', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4' })[extension] || type;
}

export function dialogueUploadLimit(mimeType) {
  if (/^video\/(mp4|quicktime|webm|x-m4v|ogg|3gpp|3gpp2)$/i.test(mimeType)) return MAX_VIDEO_BYTES;
  if (/^audio\/(wav|x-wav|mpeg|mp3|mp4|ogg|webm)$/i.test(mimeType)) return MAX_AUDIO_BYTES;
  return 0;
}

export function canDecodeDialogueLocally(file, duration = 0) {
  // decodeAudioData loads both the compressed video and the decoded soundtrack.
  return file.size <= 128 * 1024 * 1024 && (!duration || duration <= 15 * 60);
}
