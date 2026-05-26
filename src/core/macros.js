import { getContextSafe } from './chat.js';

function getMacroNames(overrides = {}) {
  const context = getContextSafe();
  const userName = String(overrides.userName || context?.name1 || 'User');
  const charName = String(overrides.charName || context?.name2 || 'Character');
  return { userName, charName };
}

export function replacePromptMacros(text, overrides = {}) {
  if (typeof text !== 'string' || !text) return text;
  const { userName, charName } = getMacroNames(overrides);
  return text
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*original\s*\}\}/gi, charName);
}

export function replacePromptMessageMacros(messages, overrides = {}) {
  if (!Array.isArray(messages)) return [];
  return messages.map(message => ({
    ...message,
    content: replacePromptMacros(message?.content, overrides),
  }));
}
