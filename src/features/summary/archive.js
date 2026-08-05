import { GRAND_MEMORY_BLOCK_RE } from '../../constants.js';
import { extractSummarySourceContent } from '../../utils/text.js';
import {
  createAssistantChatMessage,
  createMessageIdRange,
  getChatMessageById,
  getChatMessagesSafe,
  setChatMessageContent,
  setChatMessagesPartial,
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
  getConfirmedSummaryTasks,
  getContextInfo,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  buildGrandMemoryMaterialPrompt,
  buildLegacyArchiveBatchMaterial,
  buildLegacyArchiveBatchPrompt,
  buildLegacyArchiveFinalMaterial,
  buildTotalGrandMemoryMaterialPrompt,
  createLegacyArchiveBatches,
  extractMemoryBlocks,
  forceGrandMemoryRange,
  getLegacyArchiveBatchSize,
  isGrandMemoryOnly,
  parseMemoryNumber,
  stripListBlocks,
  stripMemoryBlock,
} from '../../core/summary.js';
import {
  buildLegacyArchiveEmotionUpdatePromptSection,
  processEmotionUpdateFromArchiveResult,
} from '../emotion-profile/workflow.js';
import { tryExtractMemoirFromGrandSummary } from '../memoir/extraction.js';
import { stageMemoirCandidates } from '../memoir/pending.js';
import {
  createManualSummaryGenerationOptions,
  freezeSecondaryProfileSnapshot,
  generateSummaryMemory,
  resolveSummaryTransportPlan,
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
  getAutoSummaryFingerprint,
  getMessageSummarySource,
  hasMemoryBlock,
  markSummaryWriteIgnored,
  scanExistingSummaryState,
} from './state.js';

const deferredGrandRecoveries = new Set();

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

  const memoryMaterial = entries
    .map(entry => {
      const memory = stripListBlocks(entry.memory);
      const body = entry.body ? `【正文】\n${entry.body}\n\n` : '';
      return [
        `### 记忆编号 ${entry.memoryNumber}`,
        body ? body.trim() : '',
        `【小总结】\n${memory}`,
      ].filter(Boolean).join('\n');
    })
    .join('\n\n')
    .trim();
  const material = memoryMaterial;

  return {
    material,
    memoryFrom: entries[0]?.memoryNumber ?? null,
    memoryTo: entries.at(-1)?.memoryNumber ?? null,
    entryCount: entries.length,
  };
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
  return Number(latestRecord?.archiveTo ?? chatState.summary.lastArchivedMessageId ?? -1);
}

function getCurrentChatIdentity() {
  return String(getContextInfo().chatId || '').trim();
}

function isCurrentChatIdentity(chatIdentity) {
  return Boolean(chatIdentity) && getCurrentChatIdentity() === chatIdentity;
}

function deferGrandRecovery(chatIdentity) {
  if (chatIdentity) deferredGrandRecoveries.add(chatIdentity);
}

function recoverDeferredGrandMemoryForCurrentChat() {
  const chatIdentity = getCurrentChatIdentity();
  if (!deferredGrandRecoveries.has(chatIdentity)) return false;
  const chatState = getChatState();
  deferredGrandRecoveries.delete(chatIdentity);
  if (chatState.summary.runningTask !== 'grand_memory') return false;
  chatState.summary.runningTask = 'none';
  chatState.summary.lastError = '';
  saveChatState();
  return true;
}

export function recoverDeferredAutoGrandMemory() {
  return recoverDeferredGrandMemoryForCurrentChat();
}

function hasMatchingSummarizedConfirmedTask(message, chatState) {
  const matchingTasks = getConfirmedSummaryTasks(chatState)
    .filter(task => Number(task.originalMessageId) === Number(message.message_id));
  if (matchingTasks.some(task => task.status !== 'SUMMARIZED')) return false;
  const completed = matchingTasks.find(task => task.status === 'SUMMARIZED');
  return Boolean(
    completed
    && Number(completed.selectedSwipeId) === Number(message.swipe_id ?? 0)
    && completed.assistantFingerprint === getAssistantMessageContentFingerprint(message),
  );
}

function hasCompatibleHistoricalSummary(message, chatState) {
  if (!hasMemoryBlock(message.message)) return false;
  const recordedFingerprint = chatState.summary.processedMessageFingerprints?.[message.message_id];
  if (!recordedFingerprint) return false;
  const sourceFingerprint = getAutoSummaryFingerprint(message.message_id);
  const assistantFingerprint = getAssistantMessageContentFingerprint(message);
  return recordedFingerprint === sourceFingerprint || recordedFingerprint === assistantFingerprint;
}

export function calculateSafeArchiveTo(messages, chatState = getChatState()) {
  const archiveFrom = getLatestArchiveBoundary(chatState) + 1;
  let safeArchiveTo = null;
  const orderedMessages = [...messages]
    .filter(message => Number(message.message_id) >= archiveFrom)
    .sort((left, right) => Number(left.message_id) - Number(right.message_id));

  for (const message of orderedMessages) {
    if (message.role !== 'assistant' || GRAND_MEMORY_BLOCK_RE.test(String(message.message || ''))) continue;
    if (message.is_hidden) break;
    const completed = hasMatchingSummarizedConfirmedTask(message, chatState)
      || hasCompatibleHistoricalSummary(message, chatState);
    if (!completed) break;
    safeArchiveTo = Number(message.message_id);
  }
  return safeArchiveTo;
}

export function getSafeAutoGrandArchiveTo(chatState = getChatState()) {
  return calculateSafeArchiveTo(getChatMessagesSafe(undefined, { hide_state: 'all' }), chatState);
}

export async function processAutoGrandMemory() {
  const settings = getGlobalSettings();
  const chatState = getChatState();
  const chatIdentity = getCurrentChatIdentity();
  if (!shouldTriggerAutoGrandMemory(chatState, settings)) return;
  if (chatState.summary.runningTask !== 'none') return;

  const archiveTo = getSafeAutoGrandArchiveTo(chatState);
  if (!Number.isInteger(archiveTo)) return;
  const previousArchiveTo = getLatestArchiveBoundary(chatState);
  const archiveFrom = previousArchiveTo >= 0 ? previousArchiveTo + 1 : 0;
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
    const result = await generateSummaryMemory(prompt, {
      type: '自动大总结',
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });
    if (!isCurrentChatIdentity(chatIdentity)) {
      deferGrandRecovery(chatIdentity);
      return;
    }
    const grandMemory = forceGrandMemoryRange(result, archiveData.memoryFrom, archiveData.memoryTo);
    const summaryMessageId = await createAssistantChatMessage(grandMemory);
    if (!isCurrentChatIdentity(chatIdentity)) {
      deferGrandRecovery(chatIdentity);
      return;
    }

    markSummaryWriteIgnored(Number(summaryMessageId));

    const archiveMessageIds = createMessageIdRange(archiveFrom, archiveTo);
    if (archiveMessageIds.length > 0) {
      await setChatMessagesPartial(
        archiveMessageIds.map(message_id => ({ message_id, is_hidden: true })),
        { refresh: 'all' },
      );
    }
    if (!isCurrentChatIdentity(chatIdentity)) {
      deferGrandRecovery(chatIdentity);
      return;
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

    if (!isCurrentChatIdentity(chatIdentity)) {
      deferGrandRecovery(chatIdentity);
      return;
    }
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
    await processAutoTotalGrandMemory();
    await tryExtractMemoirAfterGrandSummary(archiveRecord, grandMemory);
    refreshSummaryPanelAfterAction();
  } catch (error) {
    if (!isCurrentChatIdentity(chatIdentity)) {
      deferGrandRecovery(chatIdentity);
      return;
    }
    chatState.summary.runningTask = 'none';
    chatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '自动大总结失败');
    refreshSummaryPanelAfterAction();
  }
}

// 大总结后提炼回忆候选，暂存到 pending，交用户在回忆录面板确认（不直接写世界书）。
// 用独立 try/catch 包裹：回忆录提炼失败绝不能影响已完成的大总结主流程。
// 自动正式提炼显式 CONFIGURED：受统一后台流式开关控制，每次请求独立解析 transportPlan。
async function tryExtractMemoirAfterGrandSummary(archiveRecord, grandMemoryText) {
  try {
    const result = await tryExtractMemoirFromGrandSummary(archiveRecord, {
      generate: (prompt, opts = {}) => generateSummaryMemory(prompt, {
        ...opts,
        transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
        transportPlan: null,
      }),
      grandMemoryText,
    });
    if (result.skipped) {
      console.log(`[蜃灵回忆录] 提炼跳过：${result.skipped}`);
      return;
    }
    if (!result.memories.length) {
      console.log('[蜃灵回忆录] 提炼完成，但无已完成事件可写入。');
      return;
    }
    stageMemoirCandidates(result);
    notifySummary('info', `回忆录提炼出 ${result.memories.length} 条候选，请到回忆录面板确认。`, '回忆录');
  } catch (error) {
    console.warn('[蜃灵回忆录] 提炼失败（不影响大总结）：', error);
  }
}

export function shouldTriggerAutoTotalGrandMemory(chatState = getChatState(), settings = getGlobalSettings()) {
  const summary = getSummarySettings(settings);
  if (!settings.enabled || !summary.autoTotalGrandMemoryEnabled) return false;
  const threshold = Math.max(2, Number(summary.totalGrandMemoryInterval) || 5);
  const plan = createTotalGrandMemoryPlan(chatState);
  return Boolean(chatState.summary.runningTask === 'none' && plan.freshCount >= threshold);
}

function captureTotalGrandPlanSnapshot(plan) {
  const summaryMessageIds = plan.records.map(item => Number(item.record.summaryMessageId));
  const fingerprints = {};
  for (const item of plan.records) {
    const id = Number(item.record.summaryMessageId);
    fingerprints[id] = createMessageContentFingerprint(String(item.grandMemory || ''));
  }
  return Object.freeze({
    summaryMessageIds: Object.freeze([...summaryMessageIds]),
    fingerprints: Object.freeze({ ...fingerprints }),
    archiveFrom: plan.archiveFrom,
    archiveTo: plan.archiveTo,
    memoryFrom: plan.memoryFrom,
    memoryTo: plan.memoryTo,
    count: plan.count,
  });
}

function isTotalGrandPlanSnapshotValid(snapshot) {
  if (!snapshot) return false;
  const plan = createTotalGrandMemoryPlan();
  if (plan.count !== snapshot.count) return false;
  if (
    Number(plan.archiveFrom) !== Number(snapshot.archiveFrom)
    || Number(plan.archiveTo) !== Number(snapshot.archiveTo)
    || Number(plan.memoryFrom) !== Number(snapshot.memoryFrom)
    || Number(plan.memoryTo) !== Number(snapshot.memoryTo)
  ) {
    return false;
  }
  const ids = plan.records.map(item => Number(item.record.summaryMessageId));
  if (ids.length !== snapshot.summaryMessageIds.length) return false;
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== Number(snapshot.summaryMessageIds[index])) return false;
    const fp = createMessageContentFingerprint(String(plan.records[index].grandMemory || ''));
    if (fp !== snapshot.fingerprints[ids[index]]) return false;
  }
  return true;
}

function captureLegacyArchiveSnapshot(plan, batchSize) {
  return Object.freeze({
    batchSize,
    batchTotal: plan.batchTotal,
    totalMessages: plan.totalMessages,
    archiveFrom: plan.archiveFrom,
    archiveTo: plan.archiveTo,
    entries: Object.freeze(plan.entries.map(entry => Object.freeze({
      messageId: entry.messageId,
      role: entry.role,
      fingerprint: createMessageContentFingerprint(String(entry.content || '')),
    }))),
  });
}

function isLegacyArchiveSnapshotValid(snapshot) {
  if (!snapshot) return false;
  const plan = createLegacyArchivePlan(snapshot.batchSize);
  if (
    plan.batchTotal !== snapshot.batchTotal
    || plan.totalMessages !== snapshot.totalMessages
    || plan.archiveFrom !== snapshot.archiveFrom
    || plan.archiveTo !== snapshot.archiveTo
    || plan.entries.length !== snapshot.entries.length
  ) {
    return false;
  }
  for (let index = 0; index < snapshot.entries.length; index += 1) {
    const expected = snapshot.entries[index];
    const actual = plan.entries[index];
    if (
      expected.messageId !== actual.messageId
      || expected.role !== actual.role
      || createMessageContentFingerprint(String(actual.content || '')) !== expected.fingerprint
    ) {
      return false;
    }
  }
  return true;
}

function getArchiveRecordMemoryBoundary(record, side) {
  const memoryKey = side === 'from' ? 'memoryFrom' : 'memoryTo';
  const archiveKey = side === 'from' ? 'archiveFrom' : 'archiveTo';
  const value = record?.[memoryKey] ?? record?.[archiveKey];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isTotalGrandArchiveRecord(record) {
  return record?.rangeType === 'total_grand' || Array.isArray(record?.compressedRecordIds);
}

function getTotalGrandConsumedRecordIds(records) {
  return new Set(records.flatMap(record => (
    isTotalGrandArchiveRecord(record) && Array.isArray(record.compressedRecordIds)
      ? record.compressedRecordIds.map(Number).filter(Number.isFinite)
      : []
  )));
}

export function createTotalGrandMemoryPlan(
  chatState = getChatState(),
  { getMessageById = getChatMessageById } = {},
) {
  const archiveRecords = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords : [];
  const recordsBySummaryId = new Map();
  for (const record of archiveRecords) {
    const summaryMessageId = Number(record?.summaryMessageId);
    if (!Number.isFinite(summaryMessageId)) continue;
    const message = getMessageById(summaryMessageId);
    const grandMemory = message?.message?.match(GRAND_MEMORY_BLOCK_RE)?.[0]?.trim() || '';
    if (message && grandMemory) {
      recordsBySummaryId.set(summaryMessageId, { record, message, grandMemory });
    }
  }

  const availableRecords = [...recordsBySummaryId.values()]
    .sort((a, b) => Number(a.record.summaryMessageId) - Number(b.record.summaryMessageId));
  const consumedRecordIds = getTotalGrandConsumedRecordIds(archiveRecords);
  const baseline = [...availableRecords].reverse().find(item => isTotalGrandArchiveRecord(item.record)) || null;
  const freshRecords = availableRecords.filter(item => {
    const summaryMessageId = Number(item.record.summaryMessageId);
    return !isTotalGrandArchiveRecord(item.record)
      && !item.record.compressedBy
      && !consumedRecordIds.has(summaryMessageId);
  });
  const records = [...(baseline ? [baseline] : []), ...freshRecords]
    .sort((a, b) => Number(a.record.summaryMessageId) - Number(b.record.summaryMessageId));

  const first = records[0]?.record || null;
  const last = records.at(-1)?.record || null;
  return {
    baselineRecord: baseline?.record || null,
    freshRecords,
    records,
    count: records.length,
    freshCount: freshRecords.length,
    archiveFrom: first ? Number(first.archiveFrom) : null,
    archiveTo: last ? Number(last.summaryMessageId) : null,
    memoryFrom: first ? getArchiveRecordMemoryBoundary(first, 'from') : null,
    memoryTo: last ? getArchiveRecordMemoryBoundary(last, 'to') : null,
  };
}

export function buildTotalGrandMemoryMaterial(records) {
  return records.map((item, index) => {
    const { record, grandMemory } = item;
    const memoryFrom = getArchiveRecordMemoryBoundary(record, 'from');
    const memoryTo = getArchiveRecordMemoryBoundary(record, 'to');
    const memoryLabel = memoryFrom !== null && memoryTo !== null
      ? `记忆 ${memoryFrom}-${memoryTo}`
      : `楼层 ${record.archiveFrom}-${record.archiveTo}`;
    return [
      `### 大总结 ${index + 1}｜第 ${record.summaryMessageId} 楼｜${memoryLabel}`,
      grandMemory,
    ].join('\n');
  }).join('\n\n');
}

export async function processTotalGrandMemory({
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  guardChatScope = false,
} = {}) {
  const settings = getGlobalSettings();
  const summary = getSummarySettings(settings);
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const scope = captureManualChatScopeOrThrow(guardChatScope);
  const plan = createTotalGrandMemoryPlan();
  if (plan.count < 2) {
    notifySummary('warning', '至少需要 2 条未合并的大总结。', '总档案压缩');
    return;
  }
  const planSnapshot = guardChatScope ? captureTotalGrandPlanSnapshot(plan) : null;

  chatState.summary.runningTask = 'total_grand_memory';
  chatState.summary.lastError = '';
  saveChatState();
  notifySummary('info', `正在合并 ${plan.count} 条大总结。`, '总档案压缩');
  refreshSummaryPanelAfterAction();

  try {
    const material = buildTotalGrandMemoryMaterial(plan.records);
    const memoryFrom = plan.memoryFrom ?? plan.archiveFrom;
    const memoryTo = plan.memoryTo ?? plan.archiveTo;
    const prompt = buildTotalGrandMemoryMaterialPrompt(memoryFrom, memoryTo, material, { summary });
    // Manual panel passes configured; auto total keeps its own transportPolicy.
    // 当前路径未启用 Manual Chat Scope Guard。
    // 仅在出现真实、稳定、可复现的问题后单独立项。
    const generationOptions = transportPolicy === SUMMARY_TRANSPORT_POLICY.CONFIGURED
      ? createManualSummaryGenerationOptions('合并大总结', transportPolicy)
      : {
        type: '合并大总结',
        transportPolicy: SUMMARY_TRANSPORT_POLICY.LEGACY,
      };
    const result = await generateSummaryMemory(prompt, generationOptions);

    let guard = evaluateManualChatGuards(scope, () => isTotalGrandPlanSnapshotValid(planSnapshot));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, { scope, title: '总档案压缩' });
      return;
    }

    const grandMemory = forceGrandMemoryRange(result, memoryFrom, memoryTo);
    const summaryMessageId = await createAssistantChatMessage(grandMemory);

    guard = evaluateManualChatGuards(scope, () => isTotalGrandPlanSnapshotValid(planSnapshot));
    if (!guard.ok) {
      // May leave an orphan total floor in A.
      // 宿主多步写入可能形成部分提交。
      // 事务回滚保留在问题 Backlog。
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '总档案压缩',
        clearIgnoredMessageId: Number(summaryMessageId),
      });
      return;
    }

    markSummaryWriteIgnored(Number(summaryMessageId));

    const hideIds = createMessageIdRange(Number(plan.archiveFrom), Number(plan.archiveTo))
      .filter(messageId => messageId !== Number(summaryMessageId));
    if (hideIds.length > 0) {
      await setChatMessagesPartial(
        hideIds.map(message_id => ({ message_id, is_hidden: true })),
        { refresh: 'all' },
      );
    }

    guard = evaluateManualChatGuards(scope, () => isTotalGrandPlanSnapshotValid(planSnapshot));
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '总档案压缩',
        clearIgnoredMessageId: Number(summaryMessageId),
      });
      return;
    }

    const currentChatState = getChatState();
    const oldIds = new Set(plan.records.map(item => Number(item.record.summaryMessageId)));
    currentChatState.summary.archiveRecords = (currentChatState.summary.archiveRecords || []).map(record => (
      oldIds.has(Number(record.summaryMessageId))
        ? { ...record, compressedBy: Number(summaryMessageId) }
        : record
    ));
    currentChatState.summary.archiveRecords.push({
      id: `${summaryMessageId}-${Date.now()}`,
      summaryMessageId,
      archiveFrom: plan.archiveFrom,
      archiveTo: plan.archiveTo,
      memoryFrom,
      memoryTo,
      rangeType: 'total_grand',
      compressedRecordIds: [...oldIds],
      createdAt: Date.now(),
    });

    currentChatState.summary.runningTask = 'none';
    currentChatState.summary.lastArchivedMessageId = plan.archiveTo;
    currentChatState.summary.lastGrandSummaryMessageId = Number(summaryMessageId);
    currentChatState.summary.lastError = '';
    saveChatState();
    scanExistingSummaryState();
    notifySummary('success', `已生成第 ${summaryMessageId} 楼总档案，并合并 ${plan.count} 条大总结。`, '总档案压缩');
    refreshSummaryPanelAfterAction();
  } catch (error) {
    if (scope) {
      const scopeResult = evaluateChatScope(scope);
      if (!scopeResult.valid) return;
    }
    const currentChatState = getChatState();
    currentChatState.summary.runningTask = 'none';
    currentChatState.summary.lastError = error.message || String(error);
    saveChatState();
    notifySummary('error', error.message || String(error), '总档案压缩失败');
    refreshSummaryPanelAfterAction();
  }
}

export async function processAutoTotalGrandMemory() {
  const settings = getGlobalSettings();
  const chatState = getChatState();
  if (!shouldTriggerAutoTotalGrandMemory(chatState, settings)) return;
  await processTotalGrandMemory({
    transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
  });
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

export async function processLegacyGrandArchive({
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  guardChatScope = false,
} = {}) {
  const settings = getGlobalSettings();
  const summary = getSummarySettings(settings);
  const chatState = getChatState();
  if (chatState.summary.runningTask !== 'none') return;

  const scope = captureManualChatScopeOrThrow(guardChatScope);
  const batchSize = getLegacyArchiveBatchSize(summary);
  const plan = createLegacyArchivePlan(batchSize);
  if (!plan.totalMessages) {
    notifySummary('warning', '没有读取到可归档的旧聊天正文。', '旧聊天归档');
    return;
  }
  const archiveSnapshot = guardChatScope ? captureLegacyArchiveSnapshot(plan, batchSize) : null;

  // Freeze transport + secondary Profile for the whole multi-request archive at start.
  const frozenTransportPlan = resolveSummaryTransportPlan({
    transportPolicy,
    settings,
  });
  const frozenProfileSnapshot = frozenTransportPlan.apiMode === 'secondary_api'
    ? freezeSecondaryProfileSnapshot(settings)
    : null;
  const batchGenerationOptions = createManualSummaryGenerationOptions(
    '旧聊天批次摘要',
    transportPolicy,
    frozenTransportPlan,
    frozenProfileSnapshot,
  );
  const finalGenerationOptions = createManualSummaryGenerationOptions(
    '旧聊天大总结',
    transportPolicy,
    frozenTransportPlan,
    frozenProfileSnapshot,
  );

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

  const checkArchiveGuards = () => evaluateManualChatGuards(
    scope,
    () => isLegacyArchiveSnapshotValid(archiveSnapshot),
  );

  try {
    let finalMaterial = '';
    if (plan.batchTotal === 1) {
      finalMaterial = buildLegacyArchiveBatchMaterial(plan.batches[0]);
    } else {
      const batchSummaries = [];
      for (const [index, batch] of plan.batches.entries()) {
        let guard = checkArchiveGuards();
        if (!guard.ok) {
          finalizeManualGuardDiscard(guard.reason, { scope, title: '旧聊天归档' });
          return;
        }
        updateLegacyArchiveStatus({
          phase: 'batching',
          batchIndex: index + 1,
          lastResult: '正在生成批次 ' + (index + 1) + ' / ' + plan.batchTotal,
        });
        const prompt = buildLegacyArchiveBatchPrompt(batch, index, plan.batchTotal);
        const result = await generateSummaryMemory(prompt, batchGenerationOptions);
        guard = checkArchiveGuards();
        if (!guard.ok) {
          finalizeManualGuardDiscard(guard.reason, { scope, title: '旧聊天归档' });
          return;
        }
        batchSummaries.push({
          archiveFrom: batch[0]?.messageId ?? plan.archiveFrom,
          archiveTo: batch.at(-1)?.messageId ?? plan.archiveTo,
          summary: String(result || '').trim(),
        });
      }
      finalMaterial = buildLegacyArchiveFinalMaterial(batchSummaries);
    }

    let guard = checkArchiveGuards();
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, { scope, title: '旧聊天归档' });
      return;
    }

    updateLegacyArchiveStatus({
      phase: 'finalizing',
      batchIndex: plan.batchTotal,
      lastResult: '正在合并最终大总结。',
    });

    const emotionPromptSection = buildLegacyArchiveEmotionUpdatePromptSection(settings);
    const prompt = buildGrandMemoryMaterialPrompt(plan.archiveFrom, plan.archiveTo, finalMaterial, {
      summary,
      extraInstructions: emotionPromptSection,
    });
    const result = await generateSummaryMemory(prompt, finalGenerationOptions);

    guard = checkArchiveGuards();
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, { scope, title: '旧聊天归档' });
      return;
    }

    const grandMemory = forceGrandMemoryRange(result, plan.archiveFrom, plan.archiveTo);
    const summaryMessageId = await createAssistantChatMessage(grandMemory);

    guard = checkArchiveGuards();
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '旧聊天归档',
        clearIgnoredMessageId: Number(summaryMessageId),
      });
      return;
    }

    markSummaryWriteIgnored(Number(summaryMessageId));

    await setChatMessagesPartial(
      plan.entries.map(entry => ({ message_id: entry.messageId, is_hidden: true })),
      { refresh: 'all' },
    );

    guard = checkArchiveGuards();
    if (!guard.ok) {
      finalizeManualGuardDiscard(guard.reason, {
        scope,
        title: '旧聊天归档',
        clearIgnoredMessageId: Number(summaryMessageId),
      });
      return;
    }

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
    await processEmotionUpdateFromArchiveResult(result, {
      messageId: Number(summaryMessageId),
      sourceType: 'legacy_archive',
    });
    await processAutoTotalGrandMemory();
    refreshSummaryPanelAfterAction();
  } catch (error) {
    if (scope) {
      const scopeResult = evaluateChatScope(scope);
      if (!scopeResult.valid) return;
    }
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
