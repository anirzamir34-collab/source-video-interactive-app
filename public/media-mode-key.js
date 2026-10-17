// Keep source-media output identity consistent across first generation,
// explicit voice regeneration and resumed saved games. Provider selection is
// part of output identity: a classic per-speaker dub is not an ElevenLabs
// direct dubbing result, even with identical subtitles and quality.
export function mediaModeKeyFromOptions({ outputs = {}, qualityMode = 'quality' } = {}) {
  return JSON.stringify({
    dub: Boolean(outputs.dub),
    subtitles: Boolean(outputs.subtitles),
    quality: String(qualityMode || 'quality'),
    ...(outputs.dubbingProvider === 'elevenlabs_v1' ? { provider: 'elevenlabs_v1' } : {})
  });
}
