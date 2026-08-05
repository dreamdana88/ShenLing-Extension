import { GRAND_MEMORY_BLOCK_RE } from '../../constants.js';
import { extractSummarySourceContent } from '../../utils/text.js';
import {
  getChatMessageById,
  getChatMessagesSafe,
} from '../../core/chat.js';
import {
  getChatState,
  getContextInfo,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  buildSummaryPromptContent,
  extractMemoryBlocks,
  stripListBlocks,
  stripMemoryBlock,
  stripMemoryEmotionContextLines,
} from '../../core/summary.js';

const summaryWriteIgnores = new Map();

function createSummaryWriteIgnoreKey(messageId, chatIdentity = getContextInfo().chatId) {
  const numericMessageId = Number(messageId);
  const identity = String(chatIdentity || '').trim();
  return Number.isInteger(numericMessageId) && numericMessageId >= 0 && identity
    ? `${identity}\u001f${numericMessageId}`
    : '';
}

export function isSummaryWriteIgnored(messageId, chatIdentity = getContextInfo().chatId) {
  const key = createSummaryWriteIgnoreKey(messageId, chatIdentity);
  return Boolean(key && summaryWriteIgnores.has(key));
}

export function markSummaryWriteIgnored(messageId, durationMs = 1500, chatIdentity = getContextInfo().chatId) {
  const numericMessageId = Number(messageId);
  const key = createSummaryWriteIgnoreKey(numericMessageId, chatIdentity);
  if (!key) return false;
  const previousTimer = summaryWriteIgnores.get(key);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  summaryWriteIgnores.set(key, null);
  if (durationMs > 0) {
    const timer = window.setTimeout(() => {
      if (summaryWriteIgnores.get(key) === timer) summaryWriteIgnores.delete(key);
    }, durationMs);
    summaryWriteIgnores.set(key, timer);
  }
  return true;
}

export function clearSummaryWriteIgnored(messageId, chatIdentity = getContextInfo().chatId) {
  const key = createSummaryWriteIgnoreKey(messageId, chatIdentity);
  if (!key) return false;
  const timer = summaryWriteIgnores.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  return summaryWriteIgnores.delete(key);
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
  const grandMessagesById = new Map(allMessages
    .filter(message => message.role === 'assistant' && GRAND_MEMORY_BLOCK_RE.test(message.message))
    .map(message => [Number(message.message_id), message]));
  const latestArchiveRecord = [...(chatState.summary.archiveRecords || [])]
    .filter(record => {
      const summaryMessageId = Number(record?.summaryMessageId);
      const archiveTo = Number(record?.archiveTo);
      return Number.isInteger(summaryMessageId) &&
        summaryMessageId < Number(messageId) &&
        Number.isInteger(archiveTo) &&
        archiveTo >= -1 &&
        grandMessagesById.has(summaryMessageId);
    })
    .at(-1) || null;
  const latestGrandMemoryMessage = latestArchiveRecord
    ? grandMessagesById.get(Number(latestArchiveRecord.summaryMessageId))
    : [...grandMessagesById.values()].at(-1) || null;
  const latestGrandMemory = latestGrandMemoryMessage?.message.match(GRAND_MEMORY_BLOCK_RE)?.[0]?.trim() || '';
  const archiveBoundary = latestArchiveRecord
    ? Number(latestArchiveRecord.archiveTo)
    : Number(latestGrandMemoryMessage?.message_id ?? -1);
  const allPriorMemories = allMessages
    .filter(message => (
      message.message_id > archiveBoundary &&
      message.role === 'assistant' &&
      !GRAND_MEMORY_BLOCK_RE.test(message.message)
    ))
    .flatMap(message => extractMemoryBlocks(message.message));

  const latestMemories = allPriorMemories.slice(-4);
  const priorMemories = latestMemories.map((memory, index) => {
    const cleanMemory = stripMemoryEmotionContextLines(memory);
    return index < latestMemories.length - 1 ? stripListBlocks(cleanMemory) : cleanMemory;
  });
  return latestGrandMemory && allPriorMemories.length < 4 ? [latestGrandMemory, ...priorMemories] : priorMemories;
}

export function parseGrandMemoryRange(content) {
  const match = String(content || '').match(/^\s*\[volume\s*:\s*(\d+)\s*[-~—–]\s*(\d+)\s*\]\s*$/im);
  if (!match) return null;
  const archiveFrom = Number(match[1]);
  const archiveTo = Number(match[2]);
  if (!Number.isFinite(archiveFrom) || !Number.isFinite(archiveTo) || archiveFrom > archiveTo) return null;
  return { archiveFrom, archiveTo };
}

export function hasMemoryBlock(content) {
  return /<memory>[\s\S]*?<\/memory>/i.test(String(content || ''));
}

export function createScannedSummaryState(
  baseSummary = getChatState().summary,
  {
    summarySettings = getSummarySettings(),
    messages = getChatMessagesSafe(undefined, { hide_state: 'all' }),
  } = {},
) {
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
      compressedBy: baseRecord?.compressedBy ?? null,
      compressedRecordIds: Array.isArray(baseRecord?.compressedRecordIds)
        ? [...baseRecord.compressedRecordIds]
        : undefined,
      createdAt: baseRecord?.createdAt || Date.now(),
    });
  }

  const archiveRecords = [...recordsBySummaryId.values()].sort((a, b) => a.summaryMessageId - b.summaryMessageId);
  const latestArchiveRecord = archiveRecords.at(-1) || null;
  const latestGrandMemoryMessage = [...messages]
    .reverse()
    .find(message => message.role === 'assistant' && GRAND_MEMORY_BLOCK_RE.test(message.message)) || null;
  const lastGrandSummaryMessageId = latestArchiveRecord?.summaryMessageId ?? latestGrandMemoryMessage?.message_id ?? null;
  const archiveFloorBoundary = Number(
    latestArchiveRecord?.archiveTo
    ?? baseSummary.lastArchivedMessageId
    ?? -1,
  );

  const countedMessages = messages.filter(message => (
    message.message_id > archiveFloorBoundary &&
    message.role === 'assistant' &&
    !message.is_hidden &&
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
