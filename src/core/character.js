import { getContextSafe } from './chat.js';

function pickText(...values) {
  return values
    .map(value => String(value ?? '').trim())
    .find(Boolean) || '';
}

export function getCurrentCharacterInfo() {
  const context = getContextSafe();
  const characterId = context?.characterId ?? context?.this_chid ?? context?.chid;
  const characters = context?.characters || globalThis.characters || [];
  const numericCharacterId = String(characterId ?? '').trim() === '' ? NaN : Number(characterId);
  const characterData = Number.isInteger(numericCharacterId)
    ? characters[numericCharacterId]
    : null;
  const fallbackCharacter = context?.character || {};
  const data = characterData?.data || fallbackCharacter?.data || {};

  return {
    name: pickText(characterData?.name, fallbackCharacter?.name, context?.name2),
    description: pickText(characterData?.description, data.description, fallbackCharacter?.description),
    personality: pickText(characterData?.personality, data.personality, fallbackCharacter?.personality),
    scenario: pickText(characterData?.scenario, data.scenario, fallbackCharacter?.scenario),
  };
}

export function buildCharacterFoundationBlock() {
  const info = getCurrentCharacterInfo();
  const lines = [
    info.name ? `角色名：${info.name}` : '',
    info.description ? `Char Description:\n${info.description}` : '',
    info.personality ? `Char Personality:\n${info.personality}` : '',
    info.scenario ? `Scenario:\n${info.scenario}` : '',
  ].filter(Boolean);

  return lines.length ? lines.join('\n\n') : '';
}
