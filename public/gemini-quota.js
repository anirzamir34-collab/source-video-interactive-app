export function geminiQuotaFailure(error) {
  const details = `${error?.code || ''} ${String(error?.message || error || '')}`;
  const credits = /prepay|prepayment|no credits|credit balance|credits?.{0,30}(?:deplet|exhaust|insufficient)/i.test(details);
  if (!credits && !/RESOURCE_EXHAUSTED|\b429\b|quota|GEMINI_(?:DAILY_LIMIT|RATE_LIMITED)/i.test(details)) return null;
  const daily = /per[_ -]?day|daily|GEMINI_DAILY_LIMIT/i.test(details);
  const delay = details.match(/retry(?:Delay| in)?[\s"':]*(\d+(?:\.\d+)?)s/i);
  return {
    available: false, retryable: false,
    reason: credits ? 'GEMINI_CREDITS_DEPLETED' : daily ? 'GEMINI_DAILY_LIMIT' : 'GEMINI_RATE_LIMITED',
    retryAfterSeconds: delay ? Math.max(1, Math.ceil(Number(delay[1]))) : 0,
    message: credits ? 'Gemini ödeme bakiyesi yetersiz. Proje faturalandırmasını kontrol et.'
      : daily ? 'Gemini projesinin günlük kotası doldu. Kota yenilendiğinde tamamlanan bölümleri tekrar göndermeden devam edebilirsin.'
        : 'Gemini hız veya token kotasına ulaşıldı. Bu, ödeme bakiyesinin bittiği anlamına gelmez; biraz sonra yeniden dene.'
  };
}
