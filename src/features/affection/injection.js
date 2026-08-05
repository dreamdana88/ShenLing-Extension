import { isPlainObject } from '../../utils/text.js';
import { getContextSafe } from '../../core/chat.js';
import {
  getAffectionSystemState,
  getChatState,
  getGlobalSettings,
} from '../../core/settings.js';
import { resolvePromptText } from '../../core/prompt-overrides.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import {
  buildAffectionStateInjectionPrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  formatAffectionValueTenths,
  getStageForValueTenths,
  normalizeAffectionRoleName,
  recalculateAffectionLedger,
} from './model.js';
import {
  buildAffectionStageBehaviorText,
} from './profile.js';
import {
  isAffectionAnalysisActive,
} from './runtime.js';

export const AFFECTION_STATE_PROMPT_ID = 'shenling_assistant_affection_state';
export const AFFECTION_STATE_INJECT_POSITION = 1;
export const AFFECTION_STATE_INJECT_DEPTH = 0;

const affectionEventStops = [];
let affectionEventsRegistered = false;

export function buildAffectionInjection(chatState = getChatState()) {
  const store = getAffectionSystemState(chatState);
  const entries = Object.entries(store.profiles || {})
    .filter(([, profile]) => isPlainObject(profile) && profile.buildStatus === 'ready')
    .map(([storedRoleName, profile]) => {
      const roleName = normalizeAffectionRoleName(profile.roleName || storedRoleName);
      if (!roleName) return '';
      const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
      const stage = getStageForValueTenths(ledger.valueTenths, profile.stages);
      const stageName = String(stage?.name || '').trim();
      const behavior = buildAffectionStageBehaviorText(stage);
      const trend = String(stage?.trend || '').trim();
      const boundary = String(stage?.boundary || '').trim();
      if (!stageName || !behavior || !trend || !boundary) return '';
      return [
        `[蜃灵攻略状态：${roleName}]`,
        `${roleName}对{{user}}的好感度：${formatAffectionValueTenths(ledger.valueTenths)}/100，阶段「${stageName}」。`,
        `当前阶段表现：${behavior}`,
        `变化倾向：${trend}`,
        `禁止：不要播报数值或阶段名称；${boundary}；不要违背角色核心人设。`,
      ].join('\n');
    })
    .filter(Boolean);
  return buildAffectionStateInjectionPrompt({
    entriesText: entries.join('\n\n'),
    template: resolvePromptText(PROMPT_IDS.AFFECTION_INJECTION, getGlobalSettings()),
  });
}

function resolveSetExtensionPrompt() {
  const context = getContextSafe();
  if (typeof context?.setExtensionPrompt === 'function') {
    return (...args) => context.setExtensionPrompt(...args);
  }
  if (typeof globalThis.setExtensionPrompt === 'function') {
    return (...args) => globalThis.setExtensionPrompt(...args);
  }
  return null;
}

async function clearAffectionInjection(setExtensionPrompt) {
  const disabledFilter = () => false;
  await setExtensionPrompt(AFFECTION_STATE_PROMPT_ID, '', -1, 0, false, 0, disabledFilter);
  await setExtensionPrompt(
    AFFECTION_STATE_PROMPT_ID,
    '',
    AFFECTION_STATE_INJECT_POSITION,
    AFFECTION_STATE_INJECT_DEPTH,
    false,
    0,
    disabledFilter,
  );
}

export async function syncAffectionInjection({
  settings = getGlobalSettings(),
  chatState = getChatState(),
  setExtensionPrompt = resolveSetExtensionPrompt(),
  getLatestSettings = () => getGlobalSettings(),
  getLatestChatState = () => getChatState(),
} = {}) {
  if (typeof setExtensionPrompt !== 'function') {
    return { action: 'unavailable', content: '', promptId: AFFECTION_STATE_PROMPT_ID };
  }
  const content = isAffectionAnalysisActive(settings)
    ? buildAffectionInjection(chatState)
    : '';
  if (!content) {
    await clearAffectionInjection(setExtensionPrompt);
    return { action: 'clear', content: '', promptId: AFFECTION_STATE_PROMPT_ID };
  }
  await setExtensionPrompt(
    AFFECTION_STATE_PROMPT_ID,
    content,
    AFFECTION_STATE_INJECT_POSITION,
    AFFECTION_STATE_INJECT_DEPTH,
    false,
    0,
    () => {
      const latestSettings = getLatestSettings();
      return Boolean(
        isAffectionAnalysisActive(latestSettings)
        && buildAffectionInjection(getLatestChatState())
      );
    },
  );
  return { action: 'set', content, promptId: AFFECTION_STATE_PROMPT_ID };
}

export function registerAffectionInjectionEvents() {
  if (affectionEventsRegistered) return affectionEventStops.length > 0;
  const tavernEvents = getTavernEventsSafe();
  const syncHandler = () => {
    void syncAffectionInjection().catch(error => {
      console.warn('[蜃灵助手] 好感攻略状态注入刷新失败。', error);
    });
  };
  [
    tavernEvents.GENERATE_BEFORE_COMBINE_PROMPTS,
    tavernEvents.CHAT_CHANGED,
  ].filter(Boolean).forEach(eventName => {
    const stop = registerTavernEvent(eventName, syncHandler);
    if (stop) affectionEventStops.push(stop);
  });
  affectionEventsRegistered = affectionEventStops.length > 0;
  syncHandler();
  return affectionEventsRegistered;
}
