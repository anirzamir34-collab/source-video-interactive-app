// A short, fixed description of each canonical position from the
// protagonist's point of view. It comes from the verified position family,
// never from free model text, so it is always the same for the same pose.
const BRIEF = Object.freeze({
  missionary: 'Sırtüstü yatıyor, sen üstündesin; yüz yüzesiniz.',
  'legs-up': 'Sırtüstü yatıyor, bacakları havada; sen önündesin.',
  cowgirl: 'Senin üstünde, yüzü sana dönük; kucağında hareket ediyor.',
  'reverse-cowgirl': 'Senin üstünde, sırtı sana dönük.',
  rear: 'Elleri ve dizleri üzerinde; sen arkasındasın.',
  'standing-rear': 'Ayakta öne eğilmiş; sen arkasındasın.',
  'prone-bone': 'Yüzüstü düz yatıyor; sen arkasında, üstündesin.',
  spoon: 'Yan yatıyor, sırtı sana dönük; sen arkasındasın.',
  'reverse-spoon': 'Yan yatıyor, yüzü sana dönük.',
  'seated-facing': 'Oturur halde karşılıklı; kucağında.',
  seated: 'Oturur pozisyonda.',
  standing: 'Ayakta, karşılıklı.',
  manual: 'Elle uyarma.',
});

export function positionBrief(position = {}) {
  const family = String(position.familyId || position.positionId || '').toLowerCase();
  if (family === 'oral') {
    const giver = String(position.oralGiver || position.movements?.find(item => item?.oralGiver)?.oralGiver || '').toLowerCase();
    return giver === 'main_male' ? 'Ona oral yapıyorsun.' : giver === 'partner' ? 'Sana oral yapıyor.' : 'Oral.';
  }
  const brief = BRIEF[family] || '';
  const route = String(position.routeNamespace || position.activityType || '').toLowerCase();
  return brief && route === 'anal' ? `${brief} Anal.` : brief;
}
