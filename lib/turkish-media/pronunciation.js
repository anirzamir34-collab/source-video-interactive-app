import { MediaError } from './errors.js';

// Pronunciation is centralized in a versioned provider dictionary. Transcript
// and translation text are never modified by local search/replace rules.
export function configuredDictionaryLocators(config) {
  const { pronunciationDictionaryId: id, pronunciationDictionaryVersionId: version } = config.elevenLabs;
  if (!id && !version) return [];
  if (typeof id !== 'string' || !id.trim() || typeof version !== 'string' || !version.trim()) {
    throw new MediaError('PRONUNCIATION_DICTIONARY_INVALID', 'Telaffuz sözlüğü kimliği ve sabit sürümü birlikte yapılandırılmalı.', { status: 503 });
  }
  return [{ pronunciation_dictionary_id: id.trim(), version_id: version.trim() }];
}
