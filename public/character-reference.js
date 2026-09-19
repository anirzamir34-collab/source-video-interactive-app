import { relationshipRoleNoun } from './relationship-roles.js';
// Inflect an already verified target reference; never infer a person or action.
const cases = {
  onun: 'genitive', onu: 'accusative', ona: 'dative', onunla: 'instrumental',
  onda: 'locative', ondan: 'ablative', o: 'plain'
};
export function verifiedRoleNoun(value) {
  return relationshipRoleNoun(value);
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

export function resolveLeadingCharacterReference(label, { name = '', role = '', ownerName = '', targetIds = [], allowGeneric = false } = {}) {
  const source = String(label || '').trim();
  const roleNoun = verifiedRoleNoun(role);
  const owner = roleNoun && ownerName ? inflect(ownerName, 'genitive', false) : '';
  const reference = roleNoun ? `${owner ? `${owner} ` : ''}${roleNoun}` : String(name || '').trim();
  if (!source || !reference) return source;
  const isRole = Boolean(verifiedRoleNoun(role));
  let value = source;
  for (const rawId of [...targetIds, ...(roleNoun && name ? [name] : [])]) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const aliases = [id, id.replace(/_/g, ' ')];
    const partner = /^PARTNER[_-](\w+)$/iu.exec(id);
    if (partner) aliases.push(`Karakter ${partner[1]}`, `Partner ${partner[1]}`);
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A spoken name is part of the observed action, not a replaceable target
      // reference (for example "Ayşe diye seslen").
      if (alias === name && new RegExp(`^${escaped}\\s+(?:diye|olarak|adıyla)(?=\\s|$)`, 'iu').test(value)) continue;
      value = value.replace(new RegExp(`^${escaped}(?:['’](n?[ıiuü]n|y?[ıiuü]|[ny]?[ae]|[ny]?l[ae]|n?d[ae]n?)|\\s+(ile))?(?=\\s|$)`, 'iu'), (_, suffix, withWord) => {
        if (withWord) return 'Onunla';
        if (!suffix) return 'O';
        if (/n$/iu.test(suffix) && !/d[ae]n$/iu.test(suffix)) return 'Onun';
        if (/l[ae]$/iu.test(suffix)) return 'Onunla';
        if (/d[ae]n$/iu.test(suffix)) return 'Ondan';
        if (/d[ae]$/iu.test(suffix)) return 'Onda';
        return /[ae]$/iu.test(suffix) ? 'Ona' : 'Onu';
      });
    }
  }
  if (roleNoun && allowGeneric) {
    const genericForms = [
      ['kadınla', 'erkekle', 'adamla', 'kızla', 'kişiyle'],
      ['kadının', 'erkeğin', 'adamın', 'kızın', 'kişinin'],
      ['kadından', 'erkekten', 'adamdan', 'kızdan', 'kişiden'],
      ['kadında', 'erkekte', 'adamda', 'kızda', 'kişide'],
      ['kadını', 'erkeği', 'adamı', 'kızı', 'kişiyi'],
      ['kadına', 'erkeğe', 'adama', 'kıza', 'kişiye'],
      ['kadın', 'erkek', 'adam', 'kız', 'kişi']
    ];
    const pronouns = ['Onunla', 'Onun', 'Ondan', 'Onda', 'Onu', 'Ona', 'O'];
    for (const [index, forms] of genericForms.entries()) {
      value = value.replace(new RegExp(`^(?:(?:genç|yaşlı|olgun|yetişkin)\\s+)?(?:${forms.join('|')})(?:\\s+(ile))?(?=\\s|$)`, 'iu'),
        (_, withWord) => withWord ? 'Onunla' : pronouns[index]);
    }
  }
  return value.replace(/^(Onunla|Onun|Ondan|Onda|Onu|Ona|O)(?=\s|$)/iu, word => {
    const result = inflect(reference, cases[word.toLocaleLowerCase('tr-TR')], isRole);
    return result ? (isRole ? result[0].toLocaleUpperCase('tr-TR') + result.slice(1) : result) : word;
  });
}

export function relationshipChoiceLabel(label, role, ownerName = '') {
  const noun = verifiedRoleNoun(role);
  const value = String(label || '').trim();
  if (!noun || !value) return value;
  const owner = ownerName ? inflect(ownerName, 'genitive', false) : '';
  const escaped = noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizedValue = value.toLocaleLowerCase('tr-TR');
  const rolePresent = new RegExp(`(?<![\\p{L}])${escaped}(?:n(?:[ıiuü]n|[ıiuü]|[ae]|d[ae]n?)|yl[ae])?(?![\\p{L}])`, 'u').test(normalizedValue);
  if (rolePresent) {
    if (!owner || normalizedValue.includes(`${owner} ${noun}`.toLocaleLowerCase('tr-TR'))) return value;
    // Group choices need the reference person even when the model has already
    // supplied an unqualified role such as "Eşiyle konuş".
    if (new RegExp(`^${escaped}(?:n(?:[ıiuü]n|[ıiuü]|[ae]|d[ae]n?)|yl[ae])?(?![\\p{L}])`, 'u').test(normalizedValue)) {
      return `${owner} ${value[0].toLocaleLowerCase('tr-TR')}${value.slice(1)}`;
    }
  }
  const reference = owner ? `${owner} ${noun}` : noun[0].toLocaleUpperCase('tr-TR') + noun.slice(1);
  return `${reference} · ${value}`;
}
