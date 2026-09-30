// Parse provider JSON without modifying quoted dialogue or fabricating missing data.
export function stripTrailingJsonCommas(value) {
  const input = String(value || '');
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let cursor = index + 1;
      while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
      if (input[cursor] === '}' || input[cursor] === ']') continue;
    }
    output += char;
  }
  return output;
}

export function parseModelJson(value) {
  const cleaned = String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\`\`\`\s*$/i, '');
  if (!cleaned) throw new Error('GEMINI_EMPTY_JSON_RESPONSE');
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const repaired = stripTrailingJsonCommas(cleaned);
    if (repaired !== cleaned) return JSON.parse(repaired);
    throw firstError;
  }
}

