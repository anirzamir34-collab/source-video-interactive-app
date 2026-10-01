// Cache bytes are reusable only under the generation contract that created them.
export const DUB_CACHE_ENGINE_VERSION = 2;
export function compatibleSavedDubCache(payload = {}) {
  if (payload.dubCacheEngineVersion !== DUB_CACHE_ENGINE_VERSION) return [];
  const metadata = new Map(payload.dubSegmentMetadata || []);
  const voices = new Map((payload.dubSpeakerVoices || []).map(row => [row.voiceId, row]));
  return (payload.dubCache || []).filter(([id]) => {
    const row = metadata.get(id);
    return row?.provider === 'elevenlabs' && row.model === 'eleven_v3' &&
      typeof row.voiceId === 'string' && voices.has(row.voiceId);
  });
}
