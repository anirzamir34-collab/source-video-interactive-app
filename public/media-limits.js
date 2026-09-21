export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MEMORY_VIDEO_BYTES = 600 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

export function dialogueUploadLimit(mimeType) {
  if (/^video\/(mp4|quicktime|webm|x-m4v|ogg|3gpp|3gpp2)$/i.test(mimeType)) return MAX_VIDEO_BYTES;
  if (/^audio\/(wav|x-wav|mpeg|mp3|mp4|ogg|webm)$/i.test(mimeType)) return MAX_AUDIO_BYTES;
  return 0;
}

export function canDecodeDialogueLocally(file, duration = 0) {
  // decodeAudioData loads both the compressed video and the decoded soundtrack.
  return file.size <= 128 * 1024 * 1024 && (!duration || duration <= 15 * 60);
}
