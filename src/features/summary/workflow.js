import {
  GRAND_MEMORY_BLOCK_RE,
  SUMMARY_EVENT_DELAY_MS,
} from '../../constants.js';
import {
  extractSummarySourceContent,
  formatTimestamp,
} from '../../utils/text.js';
import { buildApiUrl } from '../../core/api.js';
import {
  createAssistantChatMessage,
  createMessageIdRange,
  getChatMessageById,
  getChatMessagesSafe,
  getContextSafe,
  getGlobalFunction,
  getLastMessageId,
  isLatestMessage,
  setChatMessageContent,
  setChatMessagesPartial,
} from '../../core/chat.js';
import {
  getChatState,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  buildGrandMemoryMaterialPrompt,
  buildLegacyArchiveBatchMaterial,
  buildLegacyArchiveBatchPrompt,
  buildLegacyArchiveFinalMaterial,
  buildMemorySummaryMessages,
  buildMemorySummaryPrompt,
  buildSummaryPromptContent,
  createLegacyArchiveBatches,
  extractMemoryBlocks,
  forceGrandMemoryRange,
  forceMemoryNumber,
  getLegacyArchiveBatchSize,
  getOpenAiResponseContent,
  isGrandMemoryOnly,
  normalizeMemoryBlock,
  parseMemoryNumber,
  stripListBlocks,
  stripMemoryBlock,
} from '../../core/summary.js';

const summaryEventStops = [];
const summaryProcessTimers = new Map();
const summaryWriteIgnoreIds = new Set();
let summaryEventsRegistered = false;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getApiSettings: null,
  getGenerateRawFunction: null,
  refreshSummaryPanel: null,
};

export function configureSummaryWorkflow(options = {}) {
  workflowOptions = {
    ...workflowOptions,
    ...options,
  };
}

function requireWorkflowOption(name) {
  const value = workflowOptions[name];
  if (typeof value !== 'function') {
    throw new Error(`总结流程缺少依赖：${name}`);
  }
  return value;
}

function refreshSummaryPanelAfterAction() {
  if (typeof workflowOptions.refreshSummaryPanel === 'function') {
    workflowOptions.refreshSummaryPanel();
  }
}

export function notifySummary(type, message, title = '自动总结') {
  const toastr = globalThis.toastr || globalThis.parent?.toastr;
  if (toastr && typeof toastr[type] === 'function') {
    toastr[type](message, title);
    return;
  }
  const logger = type === 'error' ? console.error : console.info;
  logger(`[蜃灵助手] ${title}：${message}`);
}

export function markSummaryWriteIgnored(messageId, durationMs = 1500) {
  const numericMessageId = Number(messageId);
  summaryWriteIgnoreIds.add(numericMessageId);
  if (durationMs > 0) {
    window.setTimeout(() => summaryWriteIgnoreIds.delete(numericMessageId), durationMs);
  }
}

export function clearSummaryWriteIgnored(messageId) {
  summaryWriteIgnoreIds.delete(Number(messageId));
}

export function createSimpleFingerprint(content) {
  let hash = 0;
  const text = String(content || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return `${text.length}:${hash}`;
}

export function buildArchiveMemoryMaterial(archiveFrom, archiveTo) {
  const messages = createMessageIdRange(archiveFrom, archiveTo)
    .flatMap(messageId => getChatMessagesSafe(messageId, { hide_state: 'all' }))
    .filter(message => message.role === 'assistant' && !isGrandMemoryOnly(message.message));

  const entries = messages.flatMap(message => {
    const memories = extractMemoryBlocks(message.message);
    const body = extractSummarySourceContent(stripMemoryBlock(message.message), getSummarySettings());
    if (memories.length > 0) {
      return memories.map(memory => ({
        messageId: message.message_id,
        memoryNumber: parseMemoryNumber(memory),
        body: '',
        hasMemory: true,
        memory,
      }));
    }

    return body
      ? [{ messageId: message.message_id, memoryNumber: null, body: '', hasMemory: false, memory: `<memory>\n${body}\n</memory>` }]
      : [];
  });

  let nextMemoryNumber = 0;
  entries.forEach(entry => {
    if (!Number.isInteger(entry.memoryNumber)) {
      entry.memoryNumber = nextMemoryNumber;
    }
    nextMemoryNumber = Math.max(nextMemoryNumber, entry.memoryNumber + 1);
  });

  const recentMemoryIndexes = entries
    .map((entry, index) => (entry.hasMemory ? index : -1))
    .filter(index => index >= 0)
    .slice(-2);

  for (const index of recentMemoryIndexes) {
    const message = messages.find(item => item.message_id === entries[index].messageId);
    if (message) entries[index].body = extractSummarySourceContent(stripMemoryBlock(message.message), getSummarySettings());
  }

  const material = entries
    .map(entry => {
      const memory = stripListBlocks(entry.memory);
      const body = entry.body ? `【正文】\n${entry.body}\n\n` : '';
      return `### 记忆编号 ${entry.memoryNumber}\n${body}【小总结】\n${memory}`;
    })
    .join('\n\n')
    .trim();

  return {
    material,
    memoryFrom: entries[0]?.memoryNumber ?? null,
    memoryTo: entries.at(-1)?.memoryNumber ?? null,
    entryCount: entries.length,
  };
}

export function shouldRunAutoSummary(settings = getGlobalSettings()) {
  return Boolean(settings.enabled && getSummarySettings(settings).enabled);
}

export function hasMessageBeenCountedForMemory(chatState, messageId) {
  return (
    chatState.summary.memoryCountedMessageIds.includes(messageId) ||
    Object.hasOwn(chatState.summary.processedMessageFingerprints || {}, String(messageId))
  );
}

export function collectPriorMemoriesForSummary(messageId) {
  if (!Number.isFinite(Number(messageId)) || Number(messageId) <= 0) return [];

  const chatState = getChatState();
  const allMessages = getChatMessagesSafe(`0-${Number(messageId) - 1}`, { hide_state: 'all' });
  const latestArchiveBoundary = [...(chatState.summary.archiveRecords || [])]
    .filter(record => Number(record.summaryMessageId) < Number(messageId))
    .at(-1)?.summaryMessageId ?? -1;
  const latestGrandMemoryMessage = [...allMessages]
    .reverse()
    .find(message => message.role === 'assistant' && GRAND_MEMORY_BLOCK_RE.test(message.message)) || null;
  const latestGrandMemory = latestGrandMemoryMessage?.message.match(GRAND_MEMORY_BLOCK_RE)?.[0]?.trim() || '';
  const archiveBoundary = Math.max(Number(latestArchiveBoundary), Number(latestGrandMemoryMessage?.message_id ?? -1));
  const allPriorMemories = allMessages
    .filter(message => (
      message.message_id > archiveBoundary &&
      message.role === 'assistant' &&
      !GRAND_MEMORY_BLOCK_RE.test(message.message)
    ))
    .flatMap(message => extractMemoryBlocks(message.message));

  const latestMemories = allPriorMemories.slice(-4);
  const priorMemories = latestMemories.map((memory, index) => (
    index < latestMemories.length - 1 ? stripListBlocks(memory) : memory
  ));
  return latestGrandMemory && allPriorMemories.length < 4 ? [latestGrandMemory, ...priorMemories] : priorMemories;
}

export async function generateSummaryMemory(prompt, { type = '自动小总结' } = {}) {
  const settings = getGlobalSettings();
  const api = requireWorkflowOption('getApiSettings')(settings);
  const addCommunicationLog = requireWorkflowOption('addCommunicationLog');
  const startedAt = performance.now();
  const messages = buildMemorySummaryMessages(prompt);

  if (api.mode === 'main_api') {
    const requestBody = {
      user_input: prompt,
      ordered_prompts: messages.slice(0, -1),
      should_silence: true,
      max_chat_history: 0,
    };
    try {
      const generateRaw = requireWorkflowOption('getGenerateRawFunction')();
      if (typeof generateRaw !== 'function') {
        throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
      }
      const result = await generateRaw(requestBody);
      addCommunicationLog({
        moduleName: '自动总结 / 主 API',
        taskType: type,
        status: 'success',
        startedAt: formatTimestamp(),
        durationMs: Math.round(performance.now() - startedAt),
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url: '酒馆当前连接',
        messages,
        requestBody,
        responseText: result,
        parsedResult: result,
      });
      return String(result || '').trim();
    } catch (error) {
      addCommunicationLog({
        moduleName: '自动总结 / 主 API',
        taskType: type,
        status: 'failure',
        startedAt: formatTimestamp(),
        durationMs: Math.round(performance.now() - startedAt),
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url: '酒馆当前连接',
        messages,
        requestBody,
        errorStack: error.stack || error.message || error,
      });
      throw error;
    }
  }

  const profile = requireWorkflowOption('getActiveApiProfile')(settings);
  let url = '';
  let requestBody = null;
  try {
    url = buildApiUrl(profile);
    if (!String(profile.model || '').trim()) {
      throw new Error('请先在设置页选择总结模型。');
    }
    requestBody = {
      model: String(profile.model).trim(),
      messages,
      stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (String(profile.apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text();
    let parsedResult = null;
    try {
      parsedResult = responseText ? JSON.parse(responseText) : null;
    } catch {
      parsedResult = null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
    }
    const content = getOpenAiResponseContent(parsedResult).trim();
    if (!content) {
      throw new Error(`接口返回成功，但没有读取到回复正文：${responseText}`);
    }
    addCommunicationLog({
      moduleName: '自动总结 / 副 API',
      taskType: type,
      status: 'success',
      startedAt: formatTimestamp(),
      durationMs: Math.round(performance.now() - startedAt),
      profileName: profile.name,
      model: profile.model,
      url,
      httpStatus: response.status,
      messages,
      requestBody,
      responseText,
      parsedResult: content,
    });
    return content;
  } catch (error) {
    addCommunicationLog({
      moduleName: '自动总结 / 副 API',
      taskType: type,
      status: 'failure',
      startedAt: formatTimestamp(),
      durationMs: Math.round(performance.now() - startedAt),
      profileName: profile.name,
      model: profile.model,
      url,
      messages,
      requestBody,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

export function parseGrandMemoryRange(content) {
  const match = String(content || '').match(/编号范围[:：]\s*(\d+)\s*[-~—–]\s*(\d+)/);
  if (!match) return null;
  const archiveFrom = Number(match[1]);
  const archiveTo = Number(match[2]);
  if (!Number.isFinite(archiveFrom) || !Number.isFinite(archiveTo) || archiveFrom > archiveTo) return null;
  return { archiveFrom, archiveTo };
}

export function hasMemoryBlock(content) {
  return /<memory>[\s\S]*?<\/memory>/i.test(String(content || ''));
}

export function createScannedSummaryState(baseSummary = getChatState().summary) {
  const summarySettings = getSummarySettings();
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' });
  const messagesById = new Map(messages.map(message => [message.message_id, message]));
  const validBaseRecords = (baseSummary.archiveRecords || []).filter(record => {
    const message = messagesById.get(Number(record.summaryMessageId));
    return Boolean(message && GRAND_MEMORY_BLOCK_RE.test(message.message));
  });
  const recordsBySummaryId = new Map(validBaseRecords.map(record => [Number(record.summaryMessageId), record]));
  const grandMemoryMessages = messages.filter(
    message => message.role === 'assistant' && GRAND_MEMORY_BLOCK_RE.test(message.message),
  );

  for (const [index, message] of grandMemoryMessages.entries()) {
    const memoryRange = parseGrandMemoryRange(message.message);
    const positionalArchiveFrom = index === 0 ? 0 : grandMemoryMessages[index - 1].message_id + 1;
    const positionalArchiveTo = message.message_id - 1;
    const baseRecord = recordsBySummaryId.get(message.message_id);
    const archiveFrom = baseRecord?.archiveFrom ?? (positionalArchiveFrom <= positionalArchiveTo ? positionalArchiveFrom : undefined);
    const archiveTo = baseRecord?.archiveTo ?? (positionalArchiveFrom <= positionalArchiveTo ? positionalArchiveTo : undefined);
    if (archiveFrom === undefined || archiveTo === undefined || archiveFrom > archiveTo) continue;
    recordsBySummaryId.set(message.message_id, {
      id: baseRecord?.id || `${message.message_id}-scanned`,
      summaryMessageId: message.message_id,
      archiveFrom,
      archiveTo,
      memoryFrom: baseRecord?.memoryFrom ?? memoryRange?.archiveFrom ?? null,
      memoryTo: baseRecord?.memoryTo ?? memoryRange?.archiveTo ?? null,
      rangeType: baseRecord?.rangeType || 'memory',
      createdAt: baseRecord?.createdAt || Date.now(),
    });
  }

  const archiveRecords = [...recordsBySummaryId.values()].sort((a, b) => a.summaryMessageId - b.summaryMessageId);
  const latestArchiveRecord = archiveRecords.at(-1) || null;
  const latestGrandMemoryMessage = [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && GRAND_MEMORY_BLOCK_RE.test(message.message)) || null;
  const lastGrandSummaryMessageId = latestArchiveRecord?.summaryMessageId ?? latestGrandMemoryMessage?.message_id ?? null;
  const archiveFloorBoundary = lastGrandSummaryMessageId ?? 0;

  const countedMessages = messages.filter(message => (
    message.message_id > archiveFloorBoundary &&
    message.role === 'assistant' &&
    !GRAND_MEMORY_BLOCK_RE.test(message.message) &&
    hasMemoryBlock(message.message)
  ));
  const memoryCountedMessageIds = countedMessages.map(message => message.message_id);
  const processedMessageFingerprints = countedMessages.reduce((fingerprints, message) => {
    const body = stripMemoryBlock(message.message);
    const summaryBody = extractSummarySourceContent(body, summarySettings) || body;
    fingerprints[message.message_id] = createSimpleFingerprint(summaryBody);
    return fingerprints;
  }, {});
  const allMemoryMessageIds = messages
    .filter(message => message.role === 'assistant' && !GRAND_MEMORY_BLOCK_RE.test(message.message) && hasMemoryBlock(message.message))
    .map(message => message.message_id);

  return {
    memoryCountSinceArchive: memoryCountedMessageIds.length,
    memoryCountedMessageIds,
    processedMessageFingerprints,
    smallSummaryCount: allMemoryMessageIds.length,
    lastSummaryMessageId: memoryCountedMessageIds.at(-1) ?? null,
    lastGrandSummaryMessageId,
    lastArchivedMessageId: latestArchiveRecord?.archiveTo ?? baseSummary.lastArchivedMessageId ?? null,
    archiveRecords,
  };
}

export function scanExistingSummaryState() {
  const chatState = getChatState();
  const scannedState = createScannedSummaryState(chatState.summary);
  chatState.summary = {
    ...chatState.summary,
    ...scannedState,
  };
  saveChatState();
  return chatState;
}

export function clearStaleSummaryRunningTask(reason = '') {
  const chatState = getChatState();
  if (!chatState.summary.runningTask || chatState.summary.runningTask === 'none') return false;
  chatState.summary.runningTask = 'none';
  chatState.summary.lastError = reason ? `已重置未完成任务：${reason}` : chatState.summary.lastError;
  saveChatState();
  return true;
}

export function getMessageSummarySource(message, summary = getSummarySettings()) {
  const body = stripMemoryBlock(String(message?.message || ''));
  return extractSummarySourceContent(body, summary).trim();
}

export function getPreviousUserSummarySource(messageId, summary = getSummarySettings()) {
  const numericMessageId = Number(messageId);
  if (!Number.isFinite(numericMessageId) || numericMessageId <= 0) return '';
  const priorMessages = getChatMessagesSafe(`0-${numericMessageId - 1}`, { hide_state: 'all' });
  const latestUserMessage = [...priorMessages]
    .reverse()
    .find(message => message.role === 'user' && !message.is_hidden);
  return latestUserMessage ? getMessageSummarySource(latestUserMessage, summary) : '';
}

export function createSummarySourceMaterial(messageId, summary = getSummarySettings(), { allowHidden = false } = {}) {
  const chatMessage = getChatMessageById(Number(messageId));
  if (!chatMessage || chatMessage.role !== 'assistant' || (!allowHidden && chatMessage.is_hidden)) return null;
  if (GRAND_MEMORY_BLOCK_RE.test(chatMessage.message)) return null;

  const body = stripMemoryBlock(chatMessage.message);
  const aiContent = extractSummarySourceContent(body, summary).trim();
  if (!aiContent) return null;

  const userContent = summary.includeUserInput ? getPreviousUserSummarySource(Number(messageId), summary) : '';
  const promptContent = buildSummaryPromptContent(aiContent, userContent);
  const fingerprintContent = userContent ? `${userContent}\n\n${aiContent}` : aiContent;
  return {
    body,
    aiContent,
    userContent,
    promptContent,
    fingerprint: createSimpleFingerprint(fingerprintContent),
  };
}

export function getAutoSummaryFingerprint(messageId) {
  return createSummarySourceMaterial(messageId)?.fingerprint || null;
}

export function getLatestAssistantSummaryTargetId() {
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' });
  const latest = [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && !message.is_hidden && !GRAND_MEMORY_BLOCK_RE.test(message.message));
  return latest?.message_id ?? null;
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

export async function writeManualMemoryToMessage(messageId, memoryContent) {
  const chatMessage = getEditableSummaryMessage(messageId);
  const body = stripMemoryBlock(chatMessage.message);
  if (!body) throw new Error(`第 ${Number(messageId)} 楼没有可保留的正文。`);

  const memory = normalizeMemoryBlock(memoryContent);
  markSummaryWriteIgnored(Number(messageId));
  await setChatMessageContent(Number(messageId), `${body}\n\n${memory}`);
  markManualMemoryProcessed(Number(messageId), body);
}

export async function summarizeOpeningMessage() {
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const openingMessage = getChatMessageById(0);
  if (!openingMessage) throw new Error('未找到第 0 楼。');
  if (openingMessage.role !== 'assistant') throw new Error('第 0 楼不是 AI 回复，不能生成小总结。');

  const body = stripMemoryBlock(openingMessage.message);
  const summaryBody = extractSummarySourceContent(body, getSummarySettings());
  if (!summaryBody) throw new Error('第 0 楼没有可总结的正文。');

  chatState.summary.runningTask = 'opening_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', '0楼小总结生成中。', '小总结管理');
  refreshSummaryPanelAfterAction();

  try {
    const result = await generateSummaryMemory(buildMemorySummaryPrompt(summaryBody, [], getSummarySettings()), { type: '0楼小总结' });
    const memory = forceMemoryNumber(result, 0);
    markSummaryWriteIgnored(0);
    await setChatMessageContent(0, `${body}\n\n${memory}`);
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = '';
    saveChatState();
    markManualMemoryProcessed(0, body);
    notifySummary('success', '已为第 0 楼写入小总结。', '小总结管理');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    clearSummaryWriteIgnored(0);
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '0楼小总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export async function regenerateMemoryForMessage(messageId) {
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const chatMessage = getEditableSummaryMessage(messageId);
  const rawBody = stripMemoryBlock(chatMessage.message);
  if (!rawBody) throw new Error(`第 ${Number(messageId)} 楼没有可总结的正文。`);

  const summary = getSummarySettings();
  const material = createSummarySourceMaterial(Number(messageId), summary, { allowHidden: true });
  if (!material) throw new Error(`第 ${Number(messageId)} 楼净化后没有可总结的正文。`);

  chatState.summary.runningTask = 'manual_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', `第 ${Number(messageId)} 楼小总结生成中。`, '重写小总结');
  refreshSummaryPanelAfterAction();

  try {
    const priorMemories = collectPriorMemoriesForSummary(Number(messageId));
    const result = await generateSummaryMemory(buildMemorySummaryPrompt(material.promptContent, priorMemories, summary), {
      type: '手动重写小总结',
    });
    await writeManualMemoryToMessage(Number(messageId), result);
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = '';
    saveChatState();
    notifySummary('success', `已重写第 ${Number(messageId)} 楼小总结。`, '重写小总结');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    clearSummaryWriteIgnored(Number(messageId));
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '重写小总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export function shouldTriggerAutoGrandMemory(chatState = getChatState(), settings = getGlobalSettings()) {
  const summary = getSummarySettings(settings);
  return Boolean(
    settings.enabled &&
    summary.autoGrandMemoryEnabled &&
    Number(chatState.summary.memoryCountSinceArchive || 0) >= Math.max(1, Number(summary.grandMemoryInterval) || 1)
  );
}

export function getLatestArchiveBoundary(chatState = getChatState()) {
  const archiveRecords = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords : [];
  const latestRecord = archiveRecords.at(-1) || null;
  return Number(latestRecord?.summaryMessageId ?? chatState.summary.lastGrandSummaryMessageId ?? -1);
}

export async function processAutoGrandMemory() {
  const settings = getGlobalSettings();
  const chatState = getChatState();
  if (!shouldTriggerAutoGrandMemory(chatState, settings)) return;
  if (chatState.summary.runningTask !== 'none') return;

  const archiveTo = getLastMessageId();
  const previousGrandSummaryMessageId = getLatestArchiveBoundary(chatState);
  const archiveFrom = previousGrandSummaryMessageId >= 0 ? previousGrandSummaryMessageId + 1 : 0;
  if (archiveFrom > archiveTo) return;

  chatState.summary.runningTask = 'grand_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', '大总结生成中。');
  refreshSummaryPanelAfterAction();

  try {
    const archiveData = buildArchiveMemoryMaterial(archiveFrom, archiveTo);
    if (!archiveData.material) {
      throw new Error(`归档区间 ${archiveFrom}-${archiveTo} 未读取到可用 memory 素材。`);
    }

    const prompt = buildGrandMemoryMaterialPrompt(archiveData.memoryFrom, archiveData.memoryTo, archiveData.material, {
      summary: getSummarySettings(),
    });
    const result = await generateSummaryMemory(prompt, { type: '自动大总结' });
    const grandMemory = forceGrandMemoryRange(result, archiveData.memoryFrom, archiveData.memoryTo);
    const summaryMessageId = await createAssistantChatMessage(grandMemory);

    markSummaryWriteIgnored(Number(summaryMessageId));

    const archiveMessageIds = createMessageIdRange(archiveFrom, archiveTo);
    if (archiveMessageIds.length > 0) {
      await setChatMessagesPartial(
        archiveMessageIds.map(message_id => ({ message_id, is_hidden: true })),
        { refresh: 'all' },
      );
    }

    const archiveRecord = {
      id: `${summaryMessageId}-${Date.now()}`,
      summaryMessageId,
      archiveFrom,
      archiveTo,
      memoryFrom: archiveData.memoryFrom,
      memoryTo: archiveData.memoryTo,
      createdAt: Date.now(),
    };

    chatState.summary.runningTask = 'none';
    chatState.summary.memoryCountSinceArchive = 0;
    chatState.summary.memoryCountedMessageIds = [];
    chatState.summary.lastArchivedMessageId = archiveTo;
    chatState.summary.lastGrandSummaryMessageId = Number(summaryMessageId);
    chatState.summary.archiveRecords = [...(chatState.summary.archiveRecords || []), archiveRecord];
    chatState.summary.lastError = '';
    saveChatState();
    scanExistingSummaryState();
    notifySummary('success', `已生成第 ${summaryMessageId} 楼大总结，并隐藏 ${archiveFrom}-${archiveTo}。`);
    refreshSummaryPanelAfterAction();
  } catch (error) {
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '自动大总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export async function regenerateLatestGrandMemory() {
  const chatState = getChatState();
  const record = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords.at(-1) : null;
  if (!record) {
    notifySummary('warning', '暂无可重新生成的大总结记录。', '归档管理器');
    return;
  }
  if (chatState.summary.runningTask !== 'none') return;

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
    const result = await generateSummaryMemory(prompt, { type: '重新生成大总结' });
    const grandMemory = forceGrandMemoryRange(result, archiveData.memoryFrom, archiveData.memoryTo);
    markSummaryWriteIgnored(Number(record.summaryMessageId));
    await setChatMessageContent(Number(record.summaryMessageId), grandMemory);
    record.memoryFrom = archiveData.memoryFrom;
    record.memoryTo = archiveData.memoryTo;

    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = '';
    saveChatState();
    scanExistingSummaryState();
    notifySummary('success', `已重新生成第 ${record.summaryMessageId} 楼大总结。`, '归档管理器');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    clearSummaryWriteIgnored(Number(record.summaryMessageId));
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '重新生成大总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export function cleanLegacyArchiveMessageContent(message, summary = getSummarySettings()) {
  return getMessageSummarySource(message, summary);
}

export function collectLegacyArchiveMessages(summary = getSummarySettings()) {
  return getChatMessagesSafe(undefined, { hide_state: 'all' })
    .map(message => ({
      message,
      role: message.role === 'user' || message.is_user ? 'user' : 'assistant',
    }))
    .filter(record => !record.message.is_hidden && !isGrandMemoryOnly(record.message.message))
    .filter(record => summary.includeUserInput || record.role === 'assistant')
    .map(record => ({
      messageId: record.message.message_id,
      role: record.role,
      content: cleanLegacyArchiveMessageContent(record.message, summary),
    }))
    .filter(entry => entry.content);
}

export function createLegacyArchivePlan(batchSize = getLegacyArchiveBatchSize(getSummarySettings())) {
  const entries = collectLegacyArchiveMessages();
  const batches = createLegacyArchiveBatches(entries, batchSize);
  return {
    entries,
    batches,
    batchSize,
    batchTotal: batches.length,
    totalMessages: entries.length,
    archiveFrom: entries[0]?.messageId ?? null,
    archiveTo: entries.at(-1)?.messageId ?? null,
  };
}

export function updateLegacyArchiveStatus(patch = {}) {
  const chatState = getChatState();
  chatState.summary.legacyArchiveStatus = {
    ...(chatState.summary.legacyArchiveStatus || {}),
    ...patch,
  };
  saveChatState();
  refreshSummaryPanelAfterAction();
  return chatState.summary.legacyArchiveStatus;
}

export async function processLegacyGrandArchive() {
  const settings = getGlobalSettings();
  const summary = getSummarySettings(settings);
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const batchSize = getLegacyArchiveBatchSize(summary);
  const plan = createLegacyArchivePlan(batchSize);
  if (!plan.totalMessages) {
    notifySummary('warning', '没有读取到可归档的旧聊天正文。', '旧聊天归档');
    return;
  }

  chatState.summary.runningTask = 'legacy_grand_memory';
  chatState.summary.lastError = '';
  chatState.summary.legacyArchiveStatus = {
    phase: 'running',
    totalMessages: plan.totalMessages,
    batchSize,
    batchTotal: plan.batchTotal,
    batchIndex: 0,
    lastResult: '准备归档 ' + plan.totalMessages + ' 楼。',
  };
  saveChatState();
  notifySummary('info', '旧聊天归档开始：' + plan.batchTotal + ' 批。', '旧聊天归档');
  refreshSummaryPanelAfterAction();

  try {
    let finalMaterial = '';
    if (plan.batchTotal === 1) {
      finalMaterial = buildLegacyArchiveBatchMaterial(plan.batches[0]);
    } else {
      const batchSummaries = [];
      for (const [index, batch] of plan.batches.entries()) {
        updateLegacyArchiveStatus({
          phase: 'batching',
          batchIndex: index + 1,
          lastResult: '正在生成批次 ' + (index + 1) + ' / ' + plan.batchTotal,
        });
        const prompt = buildLegacyArchiveBatchPrompt(batch, index, plan.batchTotal);
        const result = await generateSummaryMemory(prompt, { type: '旧聊天批次摘要' });
        batchSummaries.push({
          archiveFrom: batch[0]?.messageId ?? plan.archiveFrom,
          archiveTo: batch.at(-1)?.messageId ?? plan.archiveTo,
          summary: String(result || '').trim(),
        });
      }
      finalMaterial = buildLegacyArchiveFinalMaterial(batchSummaries);
    }

    updateLegacyArchiveStatus({
      phase: 'finalizing',
      batchIndex: plan.batchTotal,
      lastResult: '正在合并最终大总结。',
    });

    const prompt = buildGrandMemoryMaterialPrompt(plan.archiveFrom, plan.archiveTo, finalMaterial, { summary });
    const result = await generateSummaryMemory(prompt, { type: '旧聊天大总结' });
    const grandMemory = forceGrandMemoryRange(result, plan.archiveFrom, plan.archiveTo);
    const summaryMessageId = await createAssistantChatMessage(grandMemory);

    markSummaryWriteIgnored(Number(summaryMessageId));

    await setChatMessagesPartial(
      plan.entries.map(entry => ({ message_id: entry.messageId, is_hidden: true })),
      { refresh: 'all' },
    );

    const archiveRecord = {
      id: String(summaryMessageId) + '-' + Date.now(),
      summaryMessageId,
      archiveFrom: plan.archiveFrom,
      archiveTo: plan.archiveTo,
      memoryFrom: null,
      memoryTo: null,
      rangeType: 'floor',
      createdAt: Date.now(),
    };

    chatState.summary.runningTask = 'none';
    chatState.summary.memoryCountSinceArchive = 0;
    chatState.summary.memoryCountedMessageIds = [];
    chatState.summary.lastArchivedMessageId = plan.archiveTo;
    chatState.summary.lastGrandSummaryMessageId = Number(summaryMessageId);
    chatState.summary.archiveRecords = [...(chatState.summary.archiveRecords || []), archiveRecord];
    chatState.summary.legacyArchiveStatus = {
      phase: 'done',
      totalMessages: plan.totalMessages,
      batchSize,
      batchTotal: plan.batchTotal,
      batchIndex: plan.batchTotal,
      lastResult: '已生成第 ' + summaryMessageId + ' 楼旧聊天大总结，并隐藏 ' + plan.totalMessages + ' 楼。',
    };
    chatState.summary.lastError = '';
    saveChatState();
    scanExistingSummaryState();
    notifySummary('success', '已生成第 ' + summaryMessageId + ' 楼旧聊天大总结。', '旧聊天归档');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    chatState.summary.legacyArchiveStatus = {
      ...(chatState.summary.legacyArchiveStatus || {}),
      phase: 'error',
      lastResult: error.message || String(error),
    };
    saveChatState();
    notifySummary('error', error.message || String(error), '旧聊天归档失败');
    refreshSummaryPanelAfterAction();
  }
}

export async function processAutoSummary(messageId, expectedFingerprint) {
  const settings = getGlobalSettings();
  const summary = getSummarySettings(settings);
  const chatState = getChatState();
  if (!shouldRunAutoSummary(settings)) return;
  if (summaryWriteIgnoreIds.has(Number(messageId))) return;
  if (chatState.summary.runningTask !== 'none') return;
  if (!isLatestMessage(Number(messageId))) return;

  const chatMessage = getChatMessageById(Number(messageId));
  if (!chatMessage || chatMessage.role !== 'assistant' || chatMessage.is_hidden) return;
  if (GRAND_MEMORY_BLOCK_RE.test(chatMessage.message)) return;

  const material = createSummarySourceMaterial(Number(messageId), summary);
  if (!material) {
    notifySummary('info', '已跳过第 ' + Number(messageId) + ' 楼：没有可总结正文。');
    return;
  }

  const fingerprint = material.fingerprint;
  if (expectedFingerprint && fingerprint !== expectedFingerprint) return;
  if ((chatState.summary.processedMessageFingerprints || {})[messageId] === fingerprint) return;

  chatState.summary.runningTask = 'memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', '小总结生成中。');

  try {
    const priorMemories = collectPriorMemoriesForSummary(Number(messageId));
    const prompt = buildMemorySummaryPrompt(material.promptContent, priorMemories, summary);
    const result = await generateSummaryMemory(prompt, { type: '自动小总结' });
    const memory = normalizeMemoryBlock(result);
    const nextMessage = `${material.body}\n\n${memory}`;

    markSummaryWriteIgnored(Number(messageId));
    await setChatMessageContent(Number(messageId), nextMessage);

    const alreadyCounted = hasMessageBeenCountedForMemory(chatState, Number(messageId));
    chatState.summary.runningTask = 'none';
    chatState.summary.lastSummaryMessageId = Number(messageId);
    chatState.summary.lastSummaryAt = formatTimestamp();
    chatState.summary.lastError = '';
    chatState.summary.processedMessageFingerprints = {
      ...(chatState.summary.processedMessageFingerprints || {}),
      [messageId]: fingerprint,
    };
    if (!alreadyCounted) {
      chatState.summary.memoryCountedMessageIds = [...chatState.summary.memoryCountedMessageIds, Number(messageId)];
      chatState.summary.memoryCountSinceArchive += 1;
      chatState.summary.smallSummaryCount += 1;
    }
    saveChatState();
    notifySummary('success', `已为第 ${Number(messageId)} 楼写入小总结。`);
    await processAutoGrandMemory();
    refreshSummaryPanelAfterAction();
  } catch (error) {
    clearSummaryWriteIgnored(Number(messageId));
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error));
    console.error('[蜃灵助手] 自动小总结失败。', error);
  }
}

export function scheduleAutoSummary(messageId) {
  const numericMessageId = Number(messageId);
  if (!Number.isFinite(numericMessageId)) return;
  if (!shouldRunAutoSummary()) return;
  if (summaryWriteIgnoreIds.has(numericMessageId)) return;
  if (!isLatestMessage(numericMessageId)) return;

  const expectedFingerprint = getAutoSummaryFingerprint(numericMessageId);
  if (!expectedFingerprint) return;

  const oldTimer = summaryProcessTimers.get(numericMessageId);
  if (oldTimer !== undefined) {
    window.clearTimeout(oldTimer);
  }
  const timer = window.setTimeout(() => {
    summaryProcessTimers.delete(numericMessageId);
    void processAutoSummary(numericMessageId, expectedFingerprint);
  }, SUMMARY_EVENT_DELAY_MS);
  summaryProcessTimers.set(numericMessageId, timer);
}

export function getTavernEventsSafe() {
  const context = getContextSafe();
  return globalThis.tavern_events || context?.tavern_events || context?.event_types || {};
}

export function registerTavernEvent(eventName, handler) {
  if (!eventName) return null;
  const eventOn = getGlobalFunction('eventOn');
  if (typeof eventOn === 'function') {
    return eventOn(eventName, handler);
  }

  const context = getContextSafe();
  if (context?.eventSource?.on) {
    context.eventSource.on(eventName, handler);
    return {
      stop: () => context.eventSource.off?.(eventName, handler),
    };
  }
  return null;
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

export function registerAutoSummaryEvents() {
  if (summaryEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();
  const eventNames = [tavernEvents.MESSAGE_RECEIVED, tavernEvents.CHARACTER_MESSAGE_RENDERED].filter(Boolean);
  if (eventNames.length === 0) {
    console.warn('[蜃灵助手] 未发现 SillyTavern 事件接口，自动小总结暂不能监听新楼层。');
    return;
  }

  const handleMessage = payload => {
    const messageId = resolveEventMessageId(payload);
    if (messageId !== null) scheduleAutoSummary(messageId);
  };
  const handleChatChanged = () => {
    summaryProcessTimers.forEach(timer => window.clearTimeout(timer));
    summaryProcessTimers.clear();
    clearStaleSummaryRunningTask('聊天切换');
    scanExistingSummaryState();
  };

  eventNames.forEach(eventName => {
    const stop = registerTavernEvent(eventName, handleMessage);
    if (stop) summaryEventStops.push(stop);
  });
  const chatChangedStop = registerTavernEvent(tavernEvents.CHAT_CHANGED, handleChatChanged);
  if (chatChangedStop) summaryEventStops.push(chatChangedStop);

  summaryEventsRegistered = summaryEventStops.length > 0;
  if (!summaryEventsRegistered) {
    console.warn('[蜃灵助手] 找到了事件名称，但未能注册监听器，自动小总结暂不会运行。');
  }
}
