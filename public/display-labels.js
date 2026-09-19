// Presentation only. Tracking IDs and source analysis remain unchanged.
const participantToken = String.raw`(?:(?:karakter|character|partner|person|kişi)[\s_-]+(?:[a-z]\d*|\d+)(?:\s*\/\s*(?:[a-z]\d*|\d+))*|[iİı]nt[iİı]m(?:ate)?[\s_-]+(?:karakter|character)|ana[\s_-]+karakter|main_male)`;
const bareParticipant = new RegExp(`^(?:${participantToken})$`, 'iu');
const participantInText = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${participantToken}(?:['’](nın|nin|nun|nün|ın|in|un|ün|yı|yi|yu|yü|ı|i|u|ü|na|ne|ya|ye|a|e|yla|yle|la|le|nda|nde|da|de|ndan|nden|dan|den)|\s+(ile))?(?![\p{L}\p{N}_])`, 'giu'
);

export function cleanDisplayLabel(value) {
  // Remove an appended tracking label instead of replacing it with another
  // anonymous identity. Within a sentence use the same grammatical reference.
  return String(value ?? '').split(/\s*·\s*/u)
    .filter(part => !bareParticipant.test(part.trim()))
    .map(part => part.replace(participantInText, (match, suffix, withWord, offset) => {
      const ending = (suffix || '').toLocaleLowerCase('tr-TR');
      let pronoun = 'o';
      if (withWord || ['yla', 'yle', 'la', 'le'].includes(ending)) pronoun = 'onunla';
      else if (['nın', 'nin', 'nun', 'nün', 'ın', 'in', 'un', 'ün'].includes(ending)) pronoun = 'onun';
      else if (['yı', 'yi', 'yu', 'yü', 'ı', 'i', 'u', 'ü'].includes(ending)) pronoun = 'onu';
      else if (['na', 'ne', 'ya', 'ye', 'a', 'e'].includes(ending)) pronoun = 'ona';
      else if (['nda', 'nde', 'da', 'de'].includes(ending)) pronoun = 'onda';
      else if (['ndan', 'nden', 'dan', 'den'].includes(ending)) pronoun = 'ondan';
      return offset === 0 ? pronoun[0].toLocaleUpperCase('tr-TR') + pronoun.slice(1) : pronoun;
    }).trim())
    .filter(Boolean).join(' · ');
}

export function cleanPanelDisplayLabels(root) {
  if (!root) return;
  const walker = root.ownerDocument.createTreeWalker(root, 4); // SHOW_TEXT
  let node;
  while ((node = walker.nextNode())) {
    const cleaned = cleanDisplayLabel(node.data);
    // Preserve layout whitespace between inline elements.
    if (node.data.trim() && node.data.trim() !== cleaned) node.data = cleaned;
  }
  for (const element of root.querySelectorAll('[aria-label], [title]')) {
    for (const attribute of ['aria-label', 'title']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const cleaned = cleanDisplayLabel(value);
      if (cleaned !== value) {
        if (cleaned) element.setAttribute(attribute, cleaned);
        else element.removeAttribute(attribute);
      }
    }
  }
}
