import { GRAND_MEMORY_BLOCK_RE } from '../../constants.js';
import {
  extractSummarySourceContent,
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import { buildCharacterFoundationBlock } from '../../core/character.js';
import {
  getChatMessageById,
  getChatMessagesSafe,
  setChatMessageContent,
} from '../../core/chat.js';
import {
  evaluateChatScope,
} from '../../core/chat-scope.js';
import {
  createMessageContentFingerprint,
  getAssistantMessageContentFingerprint,
} from '../../core/message-fingerprint.js';
import {
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getPlotOutlineState,
  getSummarySettings,
  getWordReplaceSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  buildGrandMemoryMaterialPrompt,
  buildMemorySummaryPrompt,
  buildOpeningSummaryPromptContent,
  extractMemoryBlocks,
  forceGrandMemoryRange,
  forceMemoryNumber,
  normalizeMemoryBlock,
  stripMemoryBlock,
  stripMemoryEmotionControlLines,
} from '../../core/summary.js';
import { applyReplacementRulesByScope } from '../word-replace/core.js';
import {
  buildEmotionUpdatePromptSection,
  processEmotionUpdateFromSummaryResult,
} from '../emotion-profile/workflow.js';
import {
  applyPlotOutlineProgressUpdate,
  buildPlotOutlineProgressPromptSection,
  parsePlotOutlineProgressLine,
  rebuildPlotOutlineProgressFromSources,
  syncPlotOutlineInjection,
} from '../plot-outline/workflow.js';
import { buildArchiveMemoryMaterial } from './archive.js';
import {
  createManualSummaryGenerationOptions,
  generateSummaryMemory,
  joinSummaryExtraInstructions,
  SUMMARY_TRANSPORT_POLICY,
} from './generation.js';
import {
  captureManualChatScopeOrThrow,
  evaluateManualChatGuards,
  finalizeManualGuardDiscard,
} from './manual-guard.js';
import {
  notifySummary,
  refreshSummaryPanelAfterAction,
} from './runtime.js';
import {
  clearSummaryWriteIgnored,
  collectPriorMemoriesForSummary,
  createSimpleFingerprint,
  createSummarySourceMaterial,
  getLatestAssistantSummaryTargetId,
  markSummaryWriteIgnored,
  scanExistingSummaryState,
} from './state.js';

function hydratePlotOutlineProgressSourcesFromExistingMemories(chatState = getChatState()) {
  const outline = getPlotOutlineState(chatState);
  const sources = isPlainObject(outline.progressSources) ? outline.progressSources : {};
  const hasStructuredSources = Object.values(sources)
    .some(source => isPlainObject(source) && ['memory', 'manual'].includes(source.source));
  if (hasStructuredSources) return false;

  const nextSources = {};
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => message.role === 'assistant' && !GRAND_MEMORY_BLOCK_RE.test(message.message));

  messages.forEach(message => {
    const messageId = Number(message.message_id);
    if (!Number.isInteger(messageId) || messageId < 0) return;
    extractMemoryBlocks(message.message).forEach(memory => {
      const parsed = parsePlotOutlineProgressLine(memory);
      if (!parsed || parsed.conditionIds.length === 0) return;
      nextSources[String(messageId)] = {
        source: 'memory',
        messageId,
        fingerprint: createSimpleFingerprint(memory),
        chapterId: parsed.chapterId,
        conditionIds: parsed.conditionIds,
        exitChapterId: parsed.exitChapterId,
        updatedAt: outline.updatedAt || '',
      };
    });
  });

  if (Object.keys(nextSources).length === 0) return false;
  outline.progressSources = nextSources;
  rebuildPlotOutlineProgressFromSources(outline, { advanceCurrentChapter: false });
  outline.updatedAt = formatTimestamp();
  saveChatState();
  return true;
}

async function processPlotOutlineProgressFromMemory(memoryText, { messageId = null } = {}) {
  let result = { changed: false };
  try {
    hydratePlotOutlineProgressSourcesFromExistingMemories(getChatState());
    result = applyPlotOutlineProgressUpdate(memoryText, getChatState(), {
      messageId: Number(messageId),
      fingerprint: createSimpleFingerprint(memoryText),
    });
  } catch (error) {
    console.warn('[蜃灵助手] 剧情大纲进度解析失败。', error);
    return result;
  }
  if (!result.changed) return result;

  try {
    await syncPlotOutlineInjection();
  } catch (error) {
    console.warn('[蜃灵助手] 剧情大纲进度同步注入失败。', error);
  }

  const completedText = result.completedConditionIds?.length
    ? `：${result.chapterId} ${result.completedConditionIds.join(',')}`
    : '';
  if (result.switchedToChapterId) {
    notifySummary('success', `剧情大纲已推进至 ${result.switchedToChapterId}。`, '剧情大纲');
  } else {
    notifySummary('success', `剧情大纲进度已更新${completedText}。`, '剧情大纲');
  }
  if (messageId !== null) {
    console.info(`[蜃灵助手] 第 ${Number(messageId)} 楼小总结已更新剧情大纲进度。`, result);
  }
  refreshSummaryPanelAfterAction();
  return result;
}

function captureManualMessageTarget(messageId) {
  const message = getChatMessageById(Number(messageId));
  if (!message || message.role !== 'assistant') return null;
  return Object.freeze({
    messageId: Number(messageId),
    role: 'assistant',
    swipeId: Number(message.swipe_id ?? 0),
    fingerprint: getAssistantMessageContentFingerprint(message),
  });
}

function isManualMessageTargetValid(target) {
  if (!target) return false;
  const message = getChatMessageById(Number(target.messageId));
  if (!message || message.role !== 'assistant') return false;
  if (Number(message.swipe_id ?? 0) !== Number(target.swipeId)) return false;
  return getAssistantMessageContentFingerprint(message) === target.fingerprint;
}

function captureGrandRecordTarget(record) {
  if (!record) return null;
  const summaryMessageId = Number(record.summaryMessageId);
  const message = getChatMessageById(summaryMessageId);
  return Object.freeze({
    summaryMessageId,
    archiveFrom: record.archiveFrom ?? null,
    archiveTo: record.archiveTo ?? null,
    memoryFrom: record.memoryFrom ?? null,
    memoryTo: record.memoryTo ?? null,
    recordId: record.id ?? null,
    grandFingerprint: createMessageContentFingerprint(String(message?.message || '')),
  });
}

function isGrandRecordTargetValid(target) {
  if (!target) return false;
  const chatState = getChatState();
  const records = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords : [];
  const record = records.find(item => (
    Number(item?.summaryMessageId) === Number(target.summaryMessageId)
    && (target.recordId == null || item?.id === target.recordId)
  ));
  if (!record) return false;
  if (
    Number(record.archiveFrom) !== Number(target.archiveFrom)
    || Number(record.archiveTo) !== Number(target.archiveTo)
  ) {
    return false;
  }
  const message = getChatMessageById(Number(target.summaryMessageId));
  if (!message) return false;
  return createMessageContentFingerprint(String(message.message || '')) === target.grandFingerprint;
}

/** Post-write: record binding still present; Grand floor content is expected to change. */
function isGrandRecordTargetStillBound(target) {
  if (!target) return false;
  const chatState = getChatState();
  const records = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords : [];
  const record = records.find(item => (
    Number(item?.summaryMessageId) === Number(target.summaryMessageId)
    && (target.recordId == null || item?.id === target.recordId)
  ));
  if (!record) return false;
  return (
    Number(record.archiveFrom) === Number(target.archiveFrom)
    && Number(record.archiveTo) === Number(target.archiveTo)
  );
}

export function parseManualSummaryFloor(value, { defaultToLatest = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text && defaultToLatest) return getLatestAssistantSummaryTargetId();
  const messageId = Number.parseInt(text, 10);
  return Number.isInteger(messageId) && messageId >= 0 ? messageId : null;
}

export function getEditableSummaryMessage(messageId) {
  const numericMessageId = Number(messageId);
  if (!Number.isInteger(numericMessageId) || numericMessageId < 0) {
    throw new Error('请输入有效楼层号。');
  }
  const chatMessage = getChatMessageById(numericMessageId);
  if (!chatMessage) throw new Error(`未找到第 ${numericMessageId} 楼。`);
  if (chatMessage.role !== 'assistant') throw new Error(`第 ${numericMessageId} 楼不是 AI 回复。`);
  if (GRAND_MEMORY_BLOCK_RE.test(chatMessage.message)) throw new Error('大总结楼不生成或编辑小总结。');
  return chatMessage;
}

export function markManualMemoryProcessed(messageId, body) {
  const chatState = getChatState();
  chatState.summary.lastSummaryMessageId = Number(messageId);
  chatState.summary.lastSummaryAt = formatTimestamp();
  chatState.summary.lastError = '';
  const material = createSummarySourceMaterial(messageId);
  chatState.summary.processedMessageFingerprints = {
    ...(chatState.summary.processedMessageFingerprints || {}),
    [messageId]: material?.fingerprint || createSimpleFingerprint(body),
  };
  saveChatState();
}

/**
 * Write a manual memory block to a floor.
 * Optional validateAfterWrite runs after the host write settles and before metadata commit.
 * Default path (editor save) keeps the original markIgnored → write → markProcessed behavior.
 */
export async function writeManualMemoryToMessage(messageId, memoryContent, {
  validateAfterWrite = null,
  chatIdentity = undefined,
} = {}) {
  const chatMessage = getEditableSummaryMessage(messageId);
  const body = stripMemoryBlock(chatMessage.message);
  if (!body) throw new Error(`第 ${Number(messageId)} 楼没有可保留的正文。`);

  const memory = normalizeMemoryBlock(memoryContent);
  const ignoreChatId = chatIdentity !== undefined ? chatIdentity : getContextInfo().chatId;
  markSummaryWriteIgnored(Number(messageId), 1500, ignoreChatId);
  await setChatMessageContent(Number(messageId), `${body}\n\n${memory}`);

  if (typeof validateAfterWrite === 'function') {
    const validation = validateAfterWrite();
    if (validation && validation.ok === false) {
      return validation;
    }
  }

  markManualMemoryProcessed(Number(messageId), body);
  return { ok: true, reason: null };
}

export async function summarizeOpeningMessage({
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  guardChatScope = false,
} = {}) {
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const scope = captureManualChatScopeOrThrow(guardChatScope);
  const openingMessage = getChatMessageById(0);
  if (!openingMessage) throw new Error('未找到第 0 楼。');
  if (openingMessage.role !== 'assistant') throw new Error('第 0 楼不是 AI 回复，不能生成小总结。');

  const body = stripMemoryBlock(openingMessage.message);
  const summaryBody = extractSummarySourceContent(body, getSummarySettings());
  if (!summaryBody) throw new Error('第 0 楼没有可总结的正文。');
  const target = guardChatScope ? captureManualMessageTarget(0) : null;
  if (guardChatScope && !target) throw new Error('未找到第 0 楼。');

  chatState.summary.runningTask = 'opening_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', '0楼小总结生成中。', '小总结管理');
  refreshSummaryPanelAfterAction();

  try {
    const characterFoundation = buildCharacterFoundationBlock();
    const promptContent = buildOpeningSummaryPromptContent(summaryBody, characterFoundation);
    const result = await generateSummaryMemory(buildMemorySummaryPrompt(promptContent, [], getSummarySettings(), {
      materialInstructions: [
        '0楼总结素材说明：',
        '【角色基础信息】只用于识别角色、关系、地点与世界观背景，不能当作已经发生的剧情写进 <memory>。',
        '【0楼正文】才是本次需要总结为剧情事实的内容。',
        '如果角色基础信息与0楼正文冲突，以0楼正文为准。',
      ].join('\n'),
    }), createManualSummaryGenerationOptions('0楼小总结', transportPolicy));

    let guard = evaluateManualChatGuards(scope, () => isManualMessageTargetValid(target));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '小总结管理',
        clearIgnoredMessageId: 0,
      });
      return;
    }

    const memory = stripMemoryEmotionControlLines(forceMemoryNumber(result, 0));
    const memoryReplacementResult = applyReplacementRulesByScope(memory, getWordReplaceSettings());
    if (memoryReplacementResult.errors.length > 0) {
      throw new Error(`词汇替换规则错误：${memoryReplacementResult.errors.join('；')}`);
    }
    const ignoreChatId = scope?.chatId ?? getContextInfo().chatId;
    markSummaryWriteIgnored(0, 1500, ignoreChatId);
    await setChatMessageContent(0, `${body}\n\n${memoryReplacementResult.text}`);

    // Host write may race with CHAT_CHANGED; re-check before any metadata / success path.
    guard = evaluateManualChatGuards(scope, () => isManualMessageTargetValid(target));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '小总结管理',
        clearIgnoredMessageId: 0,
      });
      return;
    }

    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = '';
    saveChatState();
    markManualMemoryProcessed(0, body);
    notifySummary('success', '已为第 0 楼写入小总结。', '小总结管理');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    if (scope) {
      const scopeResult = evaluateChatScope(scope);
      if (!scopeResult.valid) {
        clearSummaryWriteIgnored(0, scope.chatId);
        return;
      }
    }
    clearSummaryWriteIgnored(0, scope?.chatId);
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '0楼小总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export async function regenerateMemoryForMessage(messageId, {
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  guardChatScope = false,
} = {}) {
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const scope = captureManualChatScopeOrThrow(guardChatScope);
  const chatMessage = getEditableSummaryMessage(messageId);
  const rawBody = stripMemoryBlock(chatMessage.message);
  if (!rawBody) throw new Error(`第 ${Number(messageId)} 楼没有可总结的正文。`);

  const summary = getSummarySettings();
  const material = createSummarySourceMaterial(Number(messageId), summary, { allowHidden: true });
  if (!material) throw new Error(`第 ${Number(messageId)} 楼净化后没有可总结的正文。`);
  const target = guardChatScope ? captureManualMessageTarget(Number(messageId)) : null;
  if (guardChatScope && !target) throw new Error(`第 ${Number(messageId)} 楼目标不可用。`);

  chatState.summary.runningTask = 'manual_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', `第 ${Number(messageId)} 楼小总结生成中。`, '重写小总结');
  refreshSummaryPanelAfterAction();

  try {
    const priorMemories = collectPriorMemoriesForSummary(Number(messageId));
    const emotionPromptSection = buildEmotionUpdatePromptSection(getGlobalSettings());
    const plotOutlineProgressSection = buildPlotOutlineProgressPromptSection(getChatState());
    const result = await generateSummaryMemory(buildMemorySummaryPrompt(material.promptContent, priorMemories, summary, {
      extraInstructions: joinSummaryExtraInstructions(emotionPromptSection, plotOutlineProgressSection),
    }), createManualSummaryGenerationOptions('手动重写小总结', transportPolicy));

    let guard = evaluateManualChatGuards(scope, () => isManualMessageTargetValid(target));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '重写小总结',
        clearIgnoredMessageId: Number(messageId),
      });
      return;
    }

    const memory = stripMemoryEmotionControlLines(normalizeMemoryBlock(result));
    const memoryReplacementResult = applyReplacementRulesByScope(memory, getWordReplaceSettings());
    if (memoryReplacementResult.errors.length > 0) {
      throw new Error(`词汇替换规则错误：${memoryReplacementResult.errors.join('；')}`);
    }

    // Scheme A: host write first; markProcessed only if post-write scope/target still valid.
    const writeResult = await writeManualMemoryToMessage(Number(messageId), memoryReplacementResult.text, {
      chatIdentity: scope?.chatId,
      validateAfterWrite: () => evaluateManualChatGuards(
        scope,
        () => isManualMessageTargetValid(target),
      ),
    });
    if (writeResult && writeResult.ok === false) {
      finalizeManualGuardDiscard(writeResult.reason, {
        scope,
        title: '重写小总结',
        clearIgnoredMessageId: Number(messageId),
      });
      return;
    }

    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = '';
    saveChatState();
    notifySummary('success', `已重写第 ${Number(messageId)} 楼小总结。`, '重写小总结');
    await processEmotionUpdateFromSummaryResult(result, { messageId: Number(messageId) });
    await processPlotOutlineProgressFromMemory(result, { messageId: Number(messageId) });
    refreshSummaryPanelAfterAction();
  } catch (error) {
    if (scope) {
      const scopeResult = evaluateChatScope(scope);
      if (!scopeResult.valid) {
        clearSummaryWriteIgnored(Number(messageId), scope.chatId);
        return;
      }
    }
    clearSummaryWriteIgnored(Number(messageId), scope?.chatId);
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '重写小总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export async function regenerateLatestGrandMemory({
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  guardChatScope = false,
} = {}) {
  const chatState = getChatState();
  const record = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords.at(-1) : null;
  if (!record) {
    notifySummary('warning', '暂无可重新生成的大总结记录。', '归档管理器');
    return;
  }
  if (chatState.summary.runningTask !== 'none') return;

  const scope = captureManualChatScopeOrThrow(guardChatScope);
  const target = guardChatScope ? captureGrandRecordTarget(record) : null;

  chatState.summary.runningTask = 'grand_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', `正在重新生成第 ${record.summaryMessageId} 楼大总结。`, '归档管理器');
  refreshSummaryPanelAfterAction();

  try {
    const archiveData = buildArchiveMemoryMaterial(record.archiveFrom, record.archiveTo);
    if (!archiveData.material) {
      throw new Error(`归档区间 ${record.archiveFrom}-${record.archiveTo} 未读取到可用 memory 素材。`);
    }

    const prompt = buildGrandMemoryMaterialPrompt(archiveData.memoryFrom, archiveData.memoryTo, archiveData.material, {
      regenerate: true,
      summary: getSummarySettings(),
    });
    const result = await generateSummaryMemory(
      prompt,
      createManualSummaryGenerationOptions('重新生成大总结', transportPolicy),
    );

    let guard = evaluateManualChatGuards(scope, () => isGrandRecordTargetValid(target));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '归档管理器',
        clearIgnoredMessageId: Number(record.summaryMessageId),
      });
      return;
    }

    const grandMemory = forceGrandMemoryRange(result, archiveData.memoryFrom, archiveData.memoryTo);
    const ignoreChatId = scope?.chatId ?? getContextInfo().chatId;
    markSummaryWriteIgnored(Number(record.summaryMessageId), 1500, ignoreChatId);
    await setChatMessageContent(Number(record.summaryMessageId), grandMemory);

    // Floor content intentionally changed; re-check scope + record binding only.
    guard = evaluateManualChatGuards(scope, () => isGrandRecordTargetStillBound(target));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '归档管理器',
        clearIgnoredMessageId: Number(record.summaryMessageId),
      });
      return;
    }

    record.memoryFrom = archiveData.memoryFrom;
    record.memoryTo = archiveData.memoryTo;

    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = '';
    saveChatState();
    scanExistingSummaryState();
    notifySummary('success', `已重新生成第 ${record.summaryMessageId} 楼大总结。`, '归档管理器');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    if (scope) {
      const scopeResult = evaluateChatScope(scope);
      if (!scopeResult.valid) {
        clearSummaryWriteIgnored(Number(record.summaryMessageId), scope.chatId);
        return;
      }
    }
    clearSummaryWriteIgnored(Number(record.summaryMessageId), scope?.chatId);
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '重新生成大总结失败');
    refreshSummaryPanelAfterAction();
  }
}
