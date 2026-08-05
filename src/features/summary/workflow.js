import {
  GRAND_MEMORY_BLOCK_RE,
  SUMMARY_EVENT_DELAY_MS,
} from '../../constants.js';
import {
  getChatMessageById,
  getLastMessageId,
  isLatestMessage,
  setChatMessageContent,
} from '../../core/chat.js';
import { markChatScopeChanged } from '../../core/chat-scope.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import {
  abortConfirmedTaskReplacement,
  prepareConfirmedTaskForReplacement,
  synchronizeConfirmedTaskAfterReplacement,
} from './confirmed-lifecycle.js';
import {
  getChatState,
  getGlobalSettings,
  getSummarySettings,
  getWordReplaceSettings,
} from '../../core/settings.js';
import { applyReplacementRulesByScope } from '../word-replace/core.js';
import {
  buildEmotionUpdatePromptSection,
} from '../emotion-profile/workflow.js';
import { prepareAffectionUpdateFromSummaryResult } from '../affection/lifecycle.js';
import { buildAffectionUpdatePromptSection } from '../affection/workflow.js';
import {
  buildPlotOutlineProgressPromptSection,
} from '../plot-outline/workflow.js';
import {
  buildMemorySummaryPrompt,
  normalizeMemoryBlock,
  stripMemoryChangedControlLines,
} from '../../core/summary.js';
import { recoverDeferredAutoGrandMemory } from './archive.js';
import {
  generateSummaryMemory,
  joinSummaryExtraInstructions,
  SUMMARY_TRANSPORT_POLICY,
} from './generation.js';
import {
  refreshSummaryPanelAfterAction,
} from './runtime.js';
import {
  clearStaleSummaryRunningTask,
  collectPriorMemoriesForSummary,
  createSummarySourceMaterial,
  isSummaryWriteIgnored,
  markSummaryWriteIgnored,
  scanExistingSummaryState,
} from './state.js';

const immediateWordReplaceEventStops = [];
const immediateWordReplaceTimers = new Map();
let immediateWordReplaceEventsRegistered = false;

export function shouldRunAutoSummary(settings = getGlobalSettings()) {
  return Boolean(settings.enabled && getSummarySettings(settings).enabled);
}

export function shouldRunWordReplace(settings = getGlobalSettings()) {
  return Boolean(settings.enabled && getWordReplaceSettings(settings).enabled);
}

export function shouldRunMessagePostprocess(settings = getGlobalSettings()) {
  return shouldRunAutoSummary(settings) || shouldRunWordReplace(settings);
}

export async function processImmediateWordReplace(messageId) {
  const settings = getGlobalSettings();
  const wordReplace = getWordReplaceSettings(settings);
  if (!shouldRunWordReplace(settings) || isSummaryWriteIgnored(Number(messageId))) return false;

  const chatMessage = getChatMessageById(Number(messageId));
  if (!chatMessage || chatMessage.role !== 'assistant' || chatMessage.is_hidden) return false;
  if (GRAND_MEMORY_BLOCK_RE.test(chatMessage.message)) return false;

  const replacementResult = applyReplacementRulesByScope(chatMessage.message, wordReplace);
  if (replacementResult.errors.length > 0) {
    console.warn(`[蜃灵助手] 词汇替换规则错误：${replacementResult.errors.join('；')}`);
    return false;
  }
  if (!replacementResult.changed) return false;

  const hasControlledReplacement = prepareConfirmedTaskForReplacement(Number(messageId), replacementResult.text);
  markSummaryWriteIgnored(Number(messageId));
  try {
    await setChatMessageContent(Number(messageId), replacementResult.text);
  } catch (error) {
    if (hasControlledReplacement) abortConfirmedTaskReplacement(Number(messageId));
    throw error;
  }
  synchronizeConfirmedTaskAfterReplacement(Number(messageId));
  refreshSummaryPanelAfterAction();
  return true;
}

export async function generateConfirmedSummaryForTask(messageId) {
  const settings = getGlobalSettings();
  const summary = getSummarySettings(settings);
  const material = createSummarySourceMaterial(Number(messageId), summary);
  if (!material) throw new Error(`第 ${Number(messageId)} 楼没有可总结的正文。`);
  const priorMemories = collectPriorMemoriesForSummary(Number(messageId));
  const chatState = getChatState();
  const prompt = buildMemorySummaryPrompt(material.promptContent, priorMemories, summary, {
    extraInstructions: joinSummaryExtraInstructions(
      buildEmotionUpdatePromptSection(settings),
      buildAffectionUpdatePromptSection(settings, chatState),
      buildPlotOutlineProgressPromptSection(chatState),
    ),
  });
  const effectResult = await generateSummaryMemory(prompt, {
    type: 'confirmed 自动小总结',
    transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
  });
  const affectionAnalysis = prepareAffectionUpdateFromSummaryResult(effectResult, { settings, chatState });
  const memory = stripMemoryChangedControlLines(
    affectionAnalysis?.normalizedMemory || normalizeMemoryBlock(effectResult),
  );
  const memoryReplacementResult = applyReplacementRulesByScope(memory, getWordReplaceSettings(settings));
  if (memoryReplacementResult.errors.length > 0) {
    throw new Error(`词汇替换规则错误：${memoryReplacementResult.errors.join('；')}`);
  }
  return {
    fingerprint: material.fingerprint,
    memory: memoryReplacementResult.text,
    effectResult,
  };
}

export async function writeConfirmedSummaryForTask(messageId, expectedFingerprint, memory) {
  const material = createSummarySourceMaterial(Number(messageId));
  if (!material || material.fingerprint !== expectedFingerprint) return false;
  markSummaryWriteIgnored(Number(messageId));
  await setChatMessageContent(Number(messageId), `${material.body}\n\n${memory}`);
  return true;
}

export function scheduleImmediateWordReplace(messageId) {
  const numericMessageId = Number(messageId);
  if (!Number.isFinite(numericMessageId)) return;
  if (numericMessageId <= 0) return;
  if (!shouldRunWordReplace()) return;
  if (isSummaryWriteIgnored(numericMessageId)) return;
  if (!isLatestMessage(numericMessageId)) return;

  const oldTimer = immediateWordReplaceTimers.get(numericMessageId);
  if (oldTimer !== undefined) {
    window.clearTimeout(oldTimer);
  }
  const timer = window.setTimeout(() => {
    immediateWordReplaceTimers.delete(numericMessageId);
    void processImmediateWordReplace(numericMessageId);
  }, SUMMARY_EVENT_DELAY_MS);
  immediateWordReplaceTimers.set(numericMessageId, timer);
}

export function resolveEventMessageId(payload) {
  if (Number.isFinite(Number(payload))) return Number(payload);
  if (payload && typeof payload === 'object') {
    const candidate = payload.message_id ?? payload.id ?? payload.messageId;
    if (Number.isFinite(Number(candidate))) return Number(candidate);
  }
  const latestId = getLastMessageId();
  return latestId >= 0 ? latestId : null;
}

export function registerImmediateWordReplaceEvents() {
  if (immediateWordReplaceEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();
  const eventNames = [tavernEvents.MESSAGE_RECEIVED, tavernEvents.CHARACTER_MESSAGE_RENDERED].filter(Boolean);
  if (eventNames.length === 0) {
    console.warn('[蜃灵助手] 未发现 SillyTavern 事件接口，词汇替换暂不能监听新楼层。');
    return;
  }

  const handleMessage = payload => {
    const messageId = resolveEventMessageId(payload);
    if (messageId !== null) scheduleImmediateWordReplace(messageId);
  };
  const handleChatChanged = () => {
    // Epoch first so in-flight manual tasks become invalid even on A→B→A.
    markChatScopeChanged();
    immediateWordReplaceTimers.forEach(timer => window.clearTimeout(timer));
    immediateWordReplaceTimers.clear();
    clearStaleSummaryRunningTask('聊天切换');
    recoverDeferredAutoGrandMemory();
    scanExistingSummaryState();
  };

  eventNames.forEach(eventName => {
    const stop = registerTavernEvent(eventName, handleMessage);
    if (stop) immediateWordReplaceEventStops.push(stop);
  });
  const chatChangedStop = registerTavernEvent(tavernEvents.CHAT_CHANGED, handleChatChanged);
  if (chatChangedStop) immediateWordReplaceEventStops.push(chatChangedStop);

  immediateWordReplaceEventsRegistered = immediateWordReplaceEventStops.length > 0;
  if (!immediateWordReplaceEventsRegistered) {
    console.warn('[蜃灵助手] 找到了事件名称，但未能注册词汇替换监听器。');
  }
}
