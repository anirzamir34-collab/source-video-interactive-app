// Failure-only interpretation of existing aggregate counters. Never turn
// unverified provider observations into playable choices, or log source media.
const count = value => Math.max(0, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0);

export function explainNoVerifiedActions(diagnostics = {}) {
  const model = count(diagnostics.modelRawActionsCount);
  const server = count(diagnostics.serverNormalizerAcceptedCount);
  const serverVerified = count(diagnostics.serverSourceVerifiedActionsCount);
  const clientInput = count(diagnostics.clientNormalizerInputCount);
  const clientVerified = count(diagnostics.clientSourceVerifiedInputCount);
  const clientAccepted = count(diagnostics.clientNormalizerAcceptedCount);
  const accepted = count(diagnostics.hardeningAcceptedCount);
  let reason;
  if (!model) {
    reason = 'Gemini yanıtları yapısal olarak tamamlandı ancak model hiçbir kaynak aksiyonu üretmedi.';
  } else if (!server) {
    reason = 'Gemini aksiyon adayları üretti; zaman, etiket veya güven kontrollerinden hiçbiri sunucuda geçemedi.';
  } else if (!serverVerified || !clientVerified) {
    reason = 'Adaylar sunucuya ulaştı ancak kaynak doğrulaması işaretlenmedi. Doğrulanmamış kartlar gösterilmedi.';
  } else if (!clientAccepted) {
    reason = 'Kaynak-doğrulanmış adaylar vardı ancak istemcinin zaman veya karakter sahipliği kontrolleri hepsini eledi.';
  } else if (!accepted) {
    reason = 'İstemcide kabul edilen adayların tamamı bütünlük denetiminde elendi.';
  } else {
    reason = 'Oynanabilir seçenek hazırlanamamasının kesin aşaması belirlenemedi.';
  }
  const stageCounts = `Aksiyon sayıları: Gemini ${model} · sunucu ${server} (kaynak doğrulanmış ${serverVerified}) · istemci girdisi ${clientInput} (doğrulanmış ${clientVerified}) · istemci kabulü ${clientAccepted} · bütünlük ${accepted}.`;
  const rejected = diagnostics.serverNormalizerRejected || {};
  const serverRejections = [`yapı/zaman ${count(rejected.invalidStructure)}`,
    `güven ${count(rejected.lowConfidence)}`, `tekrar ${count(rejected.duplicates)}`].join(' · ');
  return {
    reason,
    detail: [stageCounts, `Sunucu eleme nedenleri: ${serverRejections}.`,
      'Bu sonuç videoda hiçbir hareket olmadığı anlamına gelmez; doğrulanmış oynatılabilir kayıt elde edilemedi.'].join('\n')
  };
}
