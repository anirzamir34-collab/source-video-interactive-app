// Inflect an already verified target reference; never infer a person or action.
const cases = {
  onun: 'genitive', onu: 'accusative', ona: 'dative', onunla: 'instrumental',
  onda: 'locative', ondan: 'ablative', o: 'plain'
};
const roleNouns = new Set(['sevgilisi', 'kız arkadaşı', 'erkek arkadaşı', 'eşi', 'karısı', 'kocası',
  'annesi', 'babası', 'kızı', 'oğlu', 'kardeşi', 'ablası', 'ağabeyi', 'amcası', 'dayısı', 'halası', 'teyzesi']);

export function verifiedRoleNoun(value) {
  const role = String(value || '').trim().toLocaleLowerCase('tr-TR');
  return roleNouns.has(role) ? role : '';
}

function inflect(reference, grammaticalCase, isRole) {
  if (grammaticalCase === 'plain') return reference;
  const lower = reference.toLocaleLowerCase('tr-TR');
  // Some established names end in a palatal l; spelling alone would produce
  // the wrong suffix (for example Meral'ın). A final consonant+y in foreign
  // names such as Danny is pronounced as a vowel.
  const palatalEnding = ['meral', 'kemal', 'celal', 'bilal', 'hilal'].includes(lower);
  const finalYVowel = /[^aeıioöuüy]y$/u.test(lower);
  const vowel = palatalEnding || finalYVowel ? 'i' : [...lower].reverse().find(letter => 'aeıioöuü'.includes(letter));
  if (!vowel) return '';
  const high = 'aı'.includes(vowel) ? 'ı' : 'ei'.includes(vowel) ? 'i' : 'ou'.includes(vowel) ? 'u' : 'ü';
  const low = 'aıou'.includes(vowel) ? 'a' : 'e';
  const endsVowel = finalYVowel || /[aeıioöuü]$/u.test(lower);
  const stop = /[çfhkpsşt]$/u.test(lower) ? 't' : 'd';
  const endings = isRole ? {
    genitive: `n${high}n`, accusative: `n${high}`, dative: `n${low}`,
    instrumental: 'yla', locative: `nd${low}`, ablative: `nd${low}n`
  } : {
    genitive: `${endsVowel ? 'n' : ''}${high}n`, accusative: `${endsVowel ? 'y' : ''}${high}`,
    dative: `${endsVowel ? 'y' : ''}${low}`, instrumental: `${endsVowel ? 'y' : ''}l${low}`,
    locative: `${stop}${low}`, ablative: `${stop}${low}n`
  };
  if (isRole && grammaticalCase === 'instrumental') endings.instrumental = `yl${low}`;
  return `${reference}${isRole ? '' : "'"}${endings[grammaticalCase] || ''}`;
}

export function resolveLeadingCharacterReference(label, { name = '', role = '', targetIds = [] } = {}) {
  const source = String(label || '').trim();
  const reference = verifiedRoleNoun(role) || String(name || '').trim();
  if (!source || !reference) return source;
  const isRole = Boolean(verifiedRoleNoun(role));
  let value = source;
  for (const rawId of targetIds) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const aliases = [id, id.replace(/_/g, ' ')];
    const partner = /^PARTNER[_-](\w+)$/iu.exec(id);
    if (partner) aliases.push(`Karakter ${partner[1]}`, `Partner ${partner[1]}`);
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      value = value.replace(new RegExp(`^${escaped}(?:['’](n?[ıiuü]n|y?[ıiuü]|[ny]?[ae]|[ny]?l[ae]|n?d[ae]n?))?(?=\\s|$)`, 'iu'), (_, suffix) => {
        if (!suffix) return 'O';
        if (/n$/iu.test(suffix) && !/d[ae]n$/iu.test(suffix)) return 'Onun';
        if (/l[ae]$/iu.test(suffix)) return 'Onunla';
        if (/d[ae]n$/iu.test(suffix)) return 'Ondan';
        if (/d[ae]$/iu.test(suffix)) return 'Onda';
        return /[ae]$/iu.test(suffix) ? 'Ona' : 'Onu';
      });
    }
  }
  return value.replace(/^(Onunla|Onun|Ondan|Onda|Onu|Ona|O)(?=\s|$)/iu, word => {
    const result = inflect(reference, cases[word.toLocaleLowerCase('tr-TR')], isRole);
    return result ? (isRole ? result[0].toLocaleUpperCase('tr-TR') + result.slice(1) : result) : word;
  });
}
