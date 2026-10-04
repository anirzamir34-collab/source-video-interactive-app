export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MEMORY_VIDEO_BYTES = 600 * 1024 * 1024;

export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

export function dialogueUploadMimeType(file) {
  const type = String(file.type || "").split(";")[0].trim().toLowerCase();
  if (type && !["application/octet-stream", "binary/octet-stream"].includes(type)) return type;
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  return ({ mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm",
    wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4" })[extension] || type;
}

export function dialogueUploadLimit(type) {
  if (/^audio\/(wav|x-wav|mpeg|mp3|mp4|ogg|webm|flac|x-flac)$/i.test(type)) return MAX_AUDIO_BYTES;
  if (/^video\/(mp4|quicktime|webm|x-m4v|ogg|3gpp|3gpp2)$/i.test(type)) return MAX_VIDEO_BYTES;
  return 0;
}
