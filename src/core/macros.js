import { getContextSafe } from './chat.js';

function getMacroNames(overrides = {}) {
  const context = getContextSafe();
  const userName = String(overrides.userName || context?.name1 || 'User');
  const charName = String(overrides.charName || context?.name2 || 'Character');
  return { userName, charName };
}

function findMacroEnd(text, startIndex) {
  let depth = 1;
  for (let index = startIndex; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}') {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    }
  }
  return -1;
}

function splitRandomOptions(content) {
  const options = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const pair = content.slice(index, index + 2);
    if (pair === '{{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (pair === '::' && depth === 0) {
      options.push(content.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  options.push(content.slice(start));
  return options.map(item => item.trim()).filter(Boolean);
}

function findRandomMacroStart(text, fromIndex = 0) {
  const matched = /\{\{\s*random\s*::/i.exec(text.slice(fromIndex));
  if (!matched) return null;
  return {
    start: fromIndex + matched.index,
    contentStart: fromIndex + matched.index + matched[0].length,
  };
}

function replaceRandomMacros(text, overrides = {}, depth = 0) {
  if (depth > 10 || typeof text !== 'string' || !/\{\{\s*random\s*::/i.test(text)) return text;
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const randomMacro = findRandomMacroStart(text, cursor);
    if (!randomMacro) {
      output += text.slice(cursor);
      break;
    }

    const { start, contentStart } = randomMacro;
    output += text.slice(cursor, start);
    const end = findMacroEnd(text, contentStart);
    if (end === -1) {
      output += text.slice(start);
      break;
    }

    const options = splitRandomOptions(text.slice(contentStart, end));
    const selected = options.length
      ? options[Math.floor(Math.random() * options.length)]
      : '';
    output += replaceRandomMacros(selected, overrides, depth + 1);
    cursor = end + 2;
  }

  return output;
}

export function replacePromptMacros(text, overrides = {}) {
  if (typeof text !== 'string' || !text) return text;
  const { userName, charName } = getMacroNames(overrides);
  return replaceRandomMacros(text, overrides)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*original\s*\}\}/gi, charName)
    .replace(/<\s*user\s*>/gi, userName)
    .replace(/<\s*char\s*>/gi, charName)
    .replace(/<\s*original\s*>/gi, charName);
}

export function replacePromptMessageMacros(messages, overrides = {}) {
  if (!Array.isArray(messages)) return [];
  return messages.map(message => ({
    ...message,
    content: replacePromptMacros(message?.content, overrides),
  }));
}
