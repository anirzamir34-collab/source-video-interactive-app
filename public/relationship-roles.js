// Vocabulary only: these terms are used after the exact pair's evidence has
// been verified. A matching word never establishes a relationship by itself.
const definitions = [
  ['annesi', 'anne', 'mother'], ['babası', 'baba', 'father'],
  ['kızı', 'kız', 'daughter'], ['oğlu', 'oğul', 'son'],
  ['çocuğu', 'çocuk', 'child'], ['ebeveyni', 'ebeveyn', 'parent'],
  ['dedesi', 'dede', 'büyükbaba', 'büyükbabası', 'grandfather', 'grandpa'],
  ['ninesi', 'nine', 'grandmother', 'grandma'],
  ['büyükannesi', 'büyükanne'], ['anneannesi', 'anneanne', 'maternal grandmother'],
  ['babaannesi', 'babaanne', 'paternal grandmother'],
  ['torunu', 'torun', 'grandchild', 'grandson', 'granddaughter'],
  ['kardeşi', 'kardeş', 'sibling'],
  ['ablası', 'abla', 'older sister'], ['ağabeyi', 'ağabey', 'abi', 'abisi', 'older brother'],
  ['erkek kardeşi', 'erkek kardeş', 'brother'], ['kız kardeşi', 'kız kardeş', 'sister'],
  ['amcası', 'amca', 'paternal uncle'], ['dayısı', 'dayı', 'maternal uncle'],
  ['halası', 'hala', 'paternal aunt'], ['teyzesi', 'teyze', 'maternal aunt'],
  ['yeğeni', 'yeğen', 'niece', 'nephew'], ['kuzeni', 'kuzen', 'cousin'],
  ['akrabası', 'akraba', 'relative'],
  ['eşi', 'eş', 'spouse'], ['karısı', 'karı', 'wife'], ['kocası', 'koca', 'husband'],
  ['sevgilisi', 'sevgili', 'romantic partner'],
  ['kız arkadaşı', 'kız arkadaş', 'girlfriend'], ['erkek arkadaşı', 'erkek arkadaş', 'boyfriend'],
  ['arkadaşı', 'arkadaş', 'friend'], ['dostu', 'dost'],
  ['yakın arkadaşı', 'yakın arkadaş', 'close friend'],
  ['iş arkadaşı', 'iş arkadaş', 'colleague', 'coworker', 'co-worker'],
  ['komşusu', 'komşu', 'neighbor', 'neighbour'],
  ['kayınvalidesi', 'kayınvalide', 'kayın valide', 'kaynana', 'kaynanası', 'kayınana', 'kayın ana', 'mother-in-law'],
  ['kayınpederi', 'kayınpeder', 'kayın peder', 'kayınbaba', 'kayın baba', 'kayınbabası', 'father-in-law'],
  ['gelini', 'gelin', 'daughter-in-law'], ['damadı', 'damat', 'son-in-law'],
  ['eniştesi', 'enişte'], ['yengesi', 'yenge'], ['kayınbiraderi', 'kayınbirader'],
  ['baldızı', 'baldız'], ['görümcesi', 'görümce'], ['eltisi', 'elti'], ['bacanağı', 'bacanak'],
  ['üvey annesi', 'üvey anne', 'stepmother', 'step-mother', 'stepmom', 'step-mom'],
  ['üvey babası', 'üvey baba', 'stepfather', 'step-father', 'stepdad', 'step-dad'],
  ['üvey kızı', 'üvey kız', 'stepdaughter', 'step-daughter'],
  ['üvey oğlu', 'üvey oğul', 'stepson', 'step-son'],
  ['üvey çocuğu', 'üvey çocuk', 'stepchild'],
  ['üvey kardeşi', 'üvey kardeş', 'stepsibling'],
  ['üvey kız kardeşi', 'üvey kız kardeş', 'stepsister'],
  ['üvey erkek kardeşi', 'üvey erkek kardeş', 'stepbrother'],
  ['eski eşi', 'eski eş', 'ex-spouse'], ['eski sevgilisi', 'eski sevgili', 'ex-partner'],
  ['öğretmeni', 'öğretmen', 'teacher'], ['öğrencisi', 'öğrenci', 'student'],
  ['antrenörü', 'antrenör', 'coach'], ['takım arkadaşı', 'takım arkadaş', 'teammate']
];
const key = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
const aliases = new Map(definitions.flatMap(([role, ...names]) => [role, ...names].map(name => [key(name), role])));

export function relationshipRoleNoun(value) {
  return aliases.get(key(value)) || '';
}

// Reverse only what the supplied fact logically proves. For example a
// daughter implies a parent; it does not establish that parent's gender.
const inverse = new Map([
  ...['annesi', 'babası', 'ebeveyni'].map(role => [role, 'çocuğu']),
  ...['kızı', 'oğlu', 'çocuğu'].map(role => [role, 'ebeveyni']),
  ...['üvey annesi', 'üvey babası'].map(role => [role, 'üvey çocuğu']),
  ...['dedesi', 'ninesi', 'büyükannesi', 'anneannesi', 'babaannesi'].map(role => [role, 'torunu']),
  ...['ablası', 'ağabeyi', 'erkek kardeşi', 'kız kardeşi'].map(role => [role, 'kardeşi']),
  ...['amcası', 'dayısı', 'halası', 'teyzesi'].map(role => [role, 'yeğeni']),
  ...['eşi', 'karısı', 'kocası'].map(role => [role, 'eşi']),
  ...['sevgilisi', 'kız arkadaşı', 'erkek arkadaşı'].map(role => [role, 'sevgilisi']),
  ...['kardeşi', 'kuzeni', 'akrabası', 'arkadaşı', 'dostu', 'yakın arkadaşı', 'iş arkadaşı',
    'komşusu', 'üvey kardeşi', 'eski eşi', 'eski sevgilisi', 'takım arkadaşı'].map(role => [role, role]),
  ['öğretmeni', 'öğrencisi'], ['öğrencisi', 'öğretmeni']
]);

export function inverseRelationshipRole(value) {
  return inverse.get(relationshipRoleNoun(value)) || '';
}

const adultSocialRoles = new Set([
  'eşi', 'karısı', 'kocası', 'sevgilisi', 'kız arkadaşı', 'erkek arkadaşı',
  'arkadaşı', 'dostu', 'yakın arkadaşı', 'eski eşi', 'eski sevgilisi'
]);

// Vocabulary classification only. Verification remains bound to exact FACT
// relationship edges and the two observed participant tracks.
export function isSpouseRelationshipRole(value) {
  return ['eşi', 'karısı', 'kocası'].includes(relationshipRoleNoun(value));
}

// Trigger extra *evidence* guidance only for contextual kinship/spouse cues;
// a generic "kız" (girl) or a substring inside an unrelated word is not proof
// that the scene contains a family relationship.
const familyOrSpouseCue = /(?:^|[^\p{L}])(?:anne(?:m|n|si|sini|sinin|ye|yle|den|nin)?|baba(?:m|n|sı|sını|sının|ya|yla|dan|nın)?|kız(?:ı|ım|ın|ının|ları)|oğul|oğlu[\p{L}]{0,8}|üvey|teyze(?:si)?|amca(?:sı)?|dayı(?:sı)?|hala(?:sı)?|kardeş(?:i|im|in)?|yeğen(?:i)?|akraba(?:sı)?|aile(?:si)?|eş(?:i|im|in|ler|leri)|karı(?:sı|m)?|koca(?:sı|m)?|wife|husband|spouse|mother|father|daughter|son)(?=$|[^\p{L}])/u;

export function hasFamilyOrSpouseContext(...contexts) {
  return contexts.some(context => {
    if (context == null) return false;
    const value = typeof context === 'string' ? context : JSON.stringify(context);
    return familyOrSpouseCue.test(value.toLocaleLowerCase('tr-TR'));
  });
}

export function isAdultSocialRelationshipRole(value) {
  return adultSocialRoles.has(relationshipRoleNoun(value));
}

export function isOrdinaryRelationshipAction(action = {}) {
  return action.adultScene !== true && !action.positionId && !action.positionLabel &&
    !['oral', 'manual', 'vaginal', 'anal'].includes(String(action.activityType || '').toLowerCase());
}
