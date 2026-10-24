// Label audit: after the first Gemini pass of a chapter, only the position
// parts whose own data disagree (label vs. body arrangement, a 69 written as
// missionary, an unproven vaginal/anal route, low configuration confidence)
// are sent back once for a visual re-check of the same frames. Everything the
// re-check does not confirm keeps its first-pass event, but an unproven route
// is made neutral. A failed audit never removes a chapter.

const fold = value => String(value || '').toLocaleLowerCase('tr-TR')
  .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g')
  .replace(/ü/g, 'u').replace(/ö/g, 'o').normalize('NFD').replace(/[̀-ͯ]/g, '');

const MAX_AUDIT_CANDIDATES = 10;
const POSITION_CONFIDENCE = 0.78;
const ROUTE_CONFIDENCE = 0.90;

// What the Turkish label itself says, independent of positionId.
export function labelPositionFamily(text = '') {
  const t = fold(text);
  if (/\b69\b|altmis dokuz|karsilikli oral/.test(t)) return 'oral-mutual';
  if (/\b(ters kovboy|ters cowgirl|reverse cowgirl|arkasi donuk)/.test(t)) return 'reverse-cowgirl';
  if (/\b(misyoner|missionary)/.test(t)) return 'missionary';
  if (/\b(kovboy|cowgirl|ustune cik|ustunde)/.test(t)) return 'cowgirl';
  if (/\b(yuzustu|yuzukoyun|prone)/.test(t)) return 'prone-bone';
  if (/\b(dort ayak|doggy|emekle)/.test(t)) return 'rear';
  if (/\b(kasik|spoon|yan yat)/.test(t)) return 'spoon';
  if (/\b(sakso|blowjob|yala|agzina al|oral)/.test(t)) return 'oral';
  return '';
}

// Body arrangement Gemini reported, independent of positionId.
export function structuralFamily(action = {}) {
  const o = String(action.receiverBodyOrientation || '').toLowerCase();
  const s = String(action.receiverSupport || '').toLowerCase();
  if (o === 'on_top_facing') return 'cowgirl';
  if (o === 'on_top_away') return 'reverse-cowgirl';
  if (o === 'face_down_flat') return 'prone-bone';
  if (o === 'on_back' || s === 'back_flat') return 'missionary';
  if (o === 'hands_knees' || s === 'hands_knees') return 'rear';
  if (o === 'side_lying' || s === 'side') return 'spoon';
  return '';
}

const COMPATIBLE = {
  missionary: ['missionary', 'legs-up'],
  'legs-up': ['missionary', 'legs-up'],
  cowgirl: ['cowgirl', 'seated-facing'],
  'seated-facing': ['cowgirl', 'seated-facing'],
  'reverse-cowgirl': ['reverse-cowgirl', 'seated'],
  rear: ['rear', 'standing-rear'],
  'standing-rear': ['rear', 'standing-rear'],
  'prone-bone': ['prone-bone'],
  spoon: ['spoon', 'reverse-spoon'],
  'reverse-spoon': ['spoon', 'reverse-spoon']
};
function familiesAgree(positionId, family) {
  if (!family || !positionId) return true;
  if (family === 'oral' || family === 'oral-mutual') return positionId === 'oral';
  if (positionId === 'oral' || positionId === 'manual') return !COMPATIBLE[family];
  return (COMPATIBLE[positionId] || [positionId]).includes(family);
}

// Where MAIN_MALE's own body has to be for each position.
const MALE_POSTURE = {
  cowgirl: ['lying_back', 'seated'], 'reverse-cowgirl': ['lying_back', 'seated'], 'seated-facing': ['seated', 'lying_back'],
  rear: ['kneeling', 'standing', 'behind', 'on_top'], 'standing-rear': ['standing', 'behind'],
  'prone-bone': ['on_top', 'behind', 'kneeling'], missionary: ['kneeling', 'standing', 'on_top'], 'legs-up': ['kneeling', 'standing', 'on_top']
};
const ON_TOP = new Set(['cowgirl', 'reverse-cowgirl']);

export function auditReasons(action = {}, { transWomanCast = false } = {}) {
  const reasons = [];
  const positionId = String(action.positionId || '').toLowerCase();
  if (!positionId) return reasons;
  const labelText = [action.label, action.positionLabel, action.narrativeChoiceLabel].filter(Boolean).join(' ');
  const said = labelPositionFamily(labelText);
  const body = structuralFamily(action);
  if (said === 'oral-mutual' && !(positionId === 'oral' && action.oralGiver === 'mutual')) reasons.push('sixty_nine_mismatch');
  else if (!familiesAgree(positionId, said)) reasons.push('label_position_mismatch');
  if (!['oral', 'manual'].includes(positionId) && !familiesAgree(positionId, body)) reasons.push('body_position_mismatch');
  if (positionId === 'oral' && !['partner', 'main_male', 'mutual'].includes(String(action.oralGiver || ''))) reasons.push('oral_giver_missing');
  const posture = String(action.mainMalePosture || '').toLowerCase();
  const allowed = MALE_POSTURE[positionId];
  if (allowed && posture && posture !== 'unclear' && !allowed.includes(posture)) reasons.push('male_posture_mismatch');
  else if (allowed && ON_TOP.has(positionId) && posture === 'unclear') reasons.push('male_posture_unclear');
  const configuration = Number(action.positionConfigurationConfidence);
  if (!['oral', 'manual'].includes(positionId) && Number.isFinite(configuration) && configuration < POSITION_CONFIDENCE) reasons.push('low_configuration_confidence');
  const route = String(action.activityType || '').toLowerCase();
  if (['vaginal', 'anal'].includes(route)) {
    const confidence = Number(action.activityTypeConfidence) || 0;
    if (confidence < ROUTE_CONFIDENCE || !String(action.activityEvidence || '').trim()) reasons.push('route_unproven');
    if (route === 'vaginal' && transWomanCast) reasons.push('route_trans_review');
  }
  return reasons;
}

export function labelAuditCandidates(result = {}, options = {}) {
  const actions = Array.isArray(result?.actions) ? result.actions : [];
  return actions
    .filter(action => action?.actionId && action.classificationReview !== 'verified')
    .map(action => ({ action, reasons: auditReasons(action, options) }))
    .filter(row => row.reasons.length)
    // Contradictions first, then unproven routes, then low confidence.
    .sort((a, b) => weight(b.reasons) - weight(a.reasons))
    .slice(0, MAX_AUDIT_CANDIDATES)
    .map(row => ({ ...row.action, auditReasons: row.reasons }));
}
function weight(reasons) {
  return reasons.reduce((sum, reason) => sum + ({ sixty_nine_mismatch: 8, male_posture_mismatch: 7, label_position_mismatch: 6,
    body_position_mismatch: 5, route_trans_review: 4, route_unproven: 3, oral_giver_missing: 2 }[reason] || 1), 0);
}

// The audit only corrects; it never deletes. A candidate the review did not
// return keeps its first-pass event, with an unproven route made neutral.
export function mergeLabelAudit(firstPass = {}, reviewPass = {}, candidates = [], mergeSecondPassReview) {
  const merged = typeof mergeSecondPassReview === 'function'
    ? mergeSecondPassReview(firstPass, reviewPass, candidates)
    : { ...firstPass };
  const present = new Set((merged.actions || []).map(action => String(action.actionId || '')));
  const restored = candidates
    .filter(candidate => !present.has(String(candidate.actionId || '')))
    .map(candidate => {
      const { auditReasons: reasons = [], ...original } = candidate;
      const neutralRoute = reasons.includes('route_unproven') || reasons.includes('route_trans_review');
      return { ...original, labelAudit: 'unconfirmed',
        ...(neutralRoute ? { activityType: 'other', activityTypeConfidence: 0, activityEvidence: '' } : {}) };
    });
  const actions = [...(merged.actions || []).map(action => present.has(String(action.actionId || '')) &&
      candidates.some(candidate => String(candidate.actionId) === String(action.actionId))
    ? { ...action, labelAudit: 'verified' } : action), ...restored]
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  // Only the actions come from the audit; everything else stays first-pass.
  return { ...firstPass, actions,
    secondPassReviewed: true,
    // Restored candidates are not rejections; keep the original warnings.
    warnings: [...new Set([...(firstPass.warnings || []), ...(merged.warnings || [])])].filter(text => !/görsel doğrulama veya kaynak aralığı kontrolünden geçemedi/.test(String(text))),
    classificationReviewRejectedIds: [],
    labelAuditCount: candidates.length };
}
