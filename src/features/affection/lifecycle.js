import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import { getMessageContentFingerprint } from '../../core/message-fingerprint.js';
import {
  getAffectionSystemState,
  getChatState,
  getGlobalSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getMemoryFields,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  clampAffectionValueTenths,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionRoleName,
  recalculateAffectionLedger,
  sortAffectionRecords,
} from './model.js';
import { syncAffectionInjection } from './injection.js';
import { getProfileCurrentValueTenths } from './profile.js';
import {
  isAffectionAnalysisActive,
  refreshAffectionPanel,
} from './runtime.js';

function parseRawPipeEntry(value, valueKey) {
  const parts = String(value || '').split('|').map(part => part.trim());
  return {
    roleName: parts[0] || '',
    [valueKey]: parts[1] || '',
    extraParts: parts.slice(2),
  };
}

function getMemoryLineKey(line) {
  return String(line || '').match(/^\s*\[([A-Za-z][\w-]*)\s*:/)?.[1]?.toLowerCase() || '';
}

function buildNormalizedAffectionLines(changes) {
  return changes.map(item => (
    `[affection:${item.roleName}|${formatAffectionDeltaTenths(item.deltaTenths)}|${formatAffectionValueTenths(item.valueAfterTenths)}]`
  ));
}

/**
 * 规范化 memory：删除原 affection / 废弃 affection_first，只回写合法 affection。
 */
export function rewriteAffectionMemoryFields(memoryText, { changes = [] } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const lines = memory.split(/\r?\n/);
  const filteredLines = lines.filter(line => {
    const key = getMemoryLineKey(line);
    return key !== 'affection' && key !== 'affection_first';
  });
  const normalizedLines = buildNormalizedAffectionLines(Array.isArray(changes) ? changes : []);
  if (!normalizedLines.length) return filteredLines.join('\n');

  const progressIndex = filteredLines.findIndex(line => getMemoryLineKey(line) === 'progress');
  const closingIndex = filteredLines.findIndex(line => /^\s*<\/memory>\s*$/i.test(line));
  const boundaryIndex = progressIndex >= 0
    ? progressIndex
    : closingIndex >= 0
      ? closingIndex
      : filteredLines.length;
  let insertionIndex = boundaryIndex;
  for (let index = 0; index < boundaryIndex; index += 1) {
    const key = getMemoryLineKey(filteredLines[index]);
    if (key === 'emotion' || key === 'emotion_changed' || key === 'affection_changed') {
      insertionIndex = index + 1;
    }
  }

  filteredLines.splice(insertionIndex, 0, ...normalizedLines);
  return filteredLines.join('\n');
}

function isAutomaticRecordForMessage(record, messageId) {
  return record?.sourceType !== 'manual_adjustment'
    && Number(record?.sourceMessageId) === Number(messageId);
}

function removeAutomaticRecordsForMessage(records, messageId) {
  return sortAffectionRecords(records).filter(record => !isAutomaticRecordForMessage(record, messageId));
}

function applyPendingAffectionChange(profile, change, { messageId, fingerprint, timestamp }) {
  if (!isPlainObject(profile)) return false;
  const deltaTenths = Number(change?.deltaTenths);
  if (!Number.isInteger(deltaTenths)) return false;

  const currentRecords = Array.isArray(profile.records) ? profile.records : [];
  const previousRecord = currentRecords.find(record => isAutomaticRecordForMessage(record, messageId));
  const recordsWithoutCurrentMessage = removeAutomaticRecordsForMessage(currentRecords, messageId);
  const nextRecords = deltaTenths === 0
    ? recordsWithoutCurrentMessage
    : sortAffectionRecords([
      ...recordsWithoutCurrentMessage,
      {
        recordId: `affection:auto:${messageId}:${encodeURIComponent(normalizeAffectionRoleName(change.roleName))}`,
        sourceMessageId: Number(messageId),
        sourceFingerprint: String(fingerprint || ''),
        deltaTenths,
        sourceType: 'auto',
        createdAt: String(previousRecord?.createdAt || timestamp),
        updatedAt: timestamp,
      },
    ]);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, nextRecords);
  const before = JSON.stringify({
    valueTenths: profile.valueTenths,
    records: currentRecords,
  });
  const after = JSON.stringify({
    valueTenths: ledger.valueTenths,
    records: ledger.records,
  });
  if (before === after) return false;
  profile.valueTenths = ledger.valueTenths;
  profile.records = ledger.records;
  profile.updatedAt = timestamp;
  return true;
}

function getAffectionPendingItem(store, messageId, fingerprint) {
  const bucket = store?.pendingByMessage?.[String(Number(messageId))];
  return isPlainObject(bucket?.items?.[String(fingerprint || '').trim()])
    ? bucket.items[String(fingerprint || '').trim()]
    : null;
}

/**
 * 只解析 affection。废弃 affection_first 仅清洗，不建档。
 */
export function parseAffectionUpdateFromMemory(memoryText, { profiles = {} } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const rawAffectionValues = getMemoryFields(memory, 'affection');
  const rawFirstValues = getMemoryFields(memory, 'affection_first');
  if (!rawAffectionValues.length && !rawFirstValues.length) return null;

  const diagnostics = [];
  if (rawFirstValues.length) {
    diagnostics.push({
      code: 'retired_affection_first_ignored',
      message: '已忽略停用的 affection_first 字段。',
    });
  }

  const rawAffectionEntries = rawAffectionValues.map((value, index) => {
    const entry = parseRawPipeEntry(value, 'delta');
    if (entry.extraParts.length) {
      diagnostics.push({
        code: 'ignored_ai_value_after',
        index,
        roleName: entry.roleName,
        value: entry.extraParts.join('|'),
        message: 'AI 异常输出了 affection 第三段，已忽略并由账本重算。',
      });
    }
    return entry;
  });

  const normalizedChanges = normalizeAffectionChanges({
    entries: rawAffectionEntries,
  });
  diagnostics.push(...normalizedChanges.diagnostics);

  const changes = normalizedChanges.items.flatMap(item => {
    const profile = isPlainObject(profiles?.[item.roleName]) ? profiles[item.roleName] : null;
    if (!profile) {
      diagnostics.push({
        code: 'change_without_profile',
        roleName: item.roleName,
        message: `「${item.roleName}」尚无正式好感档案，已忽略该 affection。`,
      });
      return [];
    }

    const valueBeforeTenths = getProfileCurrentValueTenths(profile);
    return [{
      ...item,
      valueBeforeTenths,
      valueAfterTenths: clampAffectionValueTenths(valueBeforeTenths + item.deltaTenths),
    }];
  });

  const changed = changes.some(item => item.deltaTenths !== 0);
  if (normalizedChanges.changed && !changed && changes.length === 0) {
    diagnostics.push({
      code: 'no_resolvable_change',
      message: '本轮没有可计算当前值的 affection，已规范化为无变化。',
    });
  }

  const normalizedMemory = rewriteAffectionMemoryFields(memory, { changes });

  return {
    changed,
    changes,
    diagnostics,
    raw: {
      affection: rawAffectionValues,
    },
    normalizedMemory,
  };
}

export function storePendingAffectionUpdate(
  { messageId, fingerprint, analysis, origin = 'legacy' } = {},
  { chatState = getChatState(), persist = true } = {},
) {
  const numericMessageId = Number(messageId);
  const cleanFingerprint = String(fingerprint || '').trim();
  if (!Number.isInteger(numericMessageId) || numericMessageId < 0 || !cleanFingerprint || !analysis) {
    return null;
  }
  const changes = Array.isArray(analysis.changes)
    ? analysis.changes.map(item => ({ ...item }))
    : [];
  // 无合法 changes 时不创建空 pending（含仅有废弃 affection_first 的情况）
  if (!changes.length) return null;

  const store = getAffectionSystemState(chatState);
  const messageKey = String(numericMessageId);
  const existingBucket = isPlainObject(store.pendingByMessage[messageKey])
    ? store.pendingByMessage[messageKey]
    : {};
  const items = isPlainObject(existingBucket.items) ? existingBucket.items : {};
  const updatedAt = formatTimestamp();
  const pending = {
    messageId: numericMessageId,
    fingerprint: cleanFingerprint,
    changed: analysis.changed === true || changes.some(item => Number(item?.deltaTenths) !== 0),
    changes,
    diagnostics: Array.isArray(analysis.diagnostics) ? analysis.diagnostics.map(item => ({ ...item })) : [],
    raw: isPlainObject(analysis.raw) ? { ...analysis.raw } : {},
    origin: ['legacy', 'manual', 'confirmed'].includes(origin) ? origin : 'legacy',
    updatedAt,
  };
  items[cleanFingerprint] = pending;
  store.pendingByMessage[messageKey] = {
    messageId: numericMessageId,
    items,
    updatedAt,
  };
  if (persist) saveChatState();
  return pending;
}

export function prepareAffectionUpdateFromSummaryResult(
  result,
  {
    settings = getGlobalSettings(),
    chatState = getChatState(),
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const store = getAffectionSystemState(chatState);
  return parseAffectionUpdateFromMemory(result, { profiles: store.profiles });
}

export function processAffectionUpdateFromSummaryResult(
  result,
  {
    messageId,
    analysis = null,
    settings = getGlobalSettings(),
    chatState = getChatState(),
    persist = true,
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const prepared = analysis || prepareAffectionUpdateFromSummaryResult(result, { settings, chatState });
  if (!prepared) {
    console.warn('[蜃灵助手] 本轮小总结未返回已有档案角色的 affection，已跳过好感 pending。');
    return null;
  }
  const fingerprint = getMessageContentFingerprint(messageId, settings);
  if (!fingerprint) return { ...prepared, pending: null, fingerprint: '' };
  const pending = storePendingAffectionUpdate(
    { messageId, fingerprint, analysis: prepared },
    { chatState, persist },
  );
  return { ...prepared, pending, fingerprint };
}

export function markAffectionStoreUpdated(store, persist) {
  store.lastUpdatedAt = formatTimestamp();
  if (persist) saveChatState();
}

export function updatePendingAffectionDelta({
  messageId,
  fingerprint,
  roleName,
  deltaTenths,
} = {}, {
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const cleanFingerprint = String(fingerprint || '').trim();
  const nextDeltaTenths = Number(deltaTenths);
  if (!cleanRoleName || !cleanFingerprint || !AFFECTION_ALLOWED_DELTA_TENTHS.includes(nextDeltaTenths)) {
    throw new Error('待确认好感变化参数无效。');
  }
  const store = getAffectionSystemState(chatState);
  const pending = getAffectionPendingItem(store, messageId, cleanFingerprint);
  if (!pending) throw new Error('当前选中回复没有可编辑的好感 pending。');
  const change = (Array.isArray(pending.changes) ? pending.changes : [])
    .find(item => normalizeAffectionRoleName(item?.roleName) === cleanRoleName);
  if (!change) throw new Error(`未找到「${cleanRoleName}」的待确认变化。`);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`「${cleanRoleName}」尚无正式好感档案。`);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  change.deltaTenths = nextDeltaTenths;
  change.valueBeforeTenths = ledger.valueTenths;
  change.valueAfterTenths = clampAffectionValueTenths(ledger.valueTenths + nextDeltaTenths);
  pending.changed = pending.changes.some(item => Number(item?.deltaTenths) !== 0);
  pending.updatedAt = formatTimestamp();
  markAffectionStoreUpdated(store, persist);
  return { ...change };
}

export function discardPendingAffectionItem({
  messageId,
  fingerprint,
  roleName,
} = {}, {
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const cleanFingerprint = String(fingerprint || '').trim();
  const messageKey = String(Number(messageId));
  const store = getAffectionSystemState(chatState);
  const bucket = store.pendingByMessage?.[messageKey];
  const pending = getAffectionPendingItem(store, messageId, cleanFingerprint);
  if (!cleanRoleName || !pending || !isPlainObject(bucket?.items)) return false;
  const beforeCount = (Array.isArray(pending.changes) ? pending.changes : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) === cleanRoleName).length;
  if (!beforeCount) return false;
  pending.changes = (Array.isArray(pending.changes) ? pending.changes : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== cleanRoleName);
  pending.changed = pending.changes.some(item => Number(item?.deltaTenths) !== 0);
  if (!pending.changes.length) delete bucket.items[cleanFingerprint];
  if (!Object.keys(bucket.items).length) delete store.pendingByMessage[messageKey];
  markAffectionStoreUpdated(store, persist);
  return true;
}

export async function commitAffectionUpdateFromConfirmedSummary(
  result,
  {
    messageId,
    settings = getGlobalSettings(),
    chatState = getChatState(),
    persist = true,
    isCurrentChat = () => true,
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return { active: false };
  const prepared = prepareAffectionUpdateFromSummaryResult(result, { settings, chatState });
  if (!prepared) return null;
  const numericMessageId = Number(messageId);
  const fingerprint = getMessageContentFingerprint(numericMessageId, settings);
  if (!fingerprint || !isCurrentChat()) return { ...prepared, fingerprint: '' };

  const store = getAffectionSystemState(chatState);
  const timestamp = formatTimestamp();
  const committedRoleNames = [];
  let changed = false;

  prepared.changes.forEach(change => {
    const roleName = normalizeAffectionRoleName(change?.roleName);
    const profile = isPlainObject(store.profiles?.[roleName]) ? store.profiles[roleName] : null;
    if (!profile) return;
    if (applyPendingAffectionChange(profile, change, {
      messageId: numericMessageId,
      fingerprint,
      timestamp,
    })) {
      changed = true;
    }
    if (Number(change?.deltaTenths) !== 0) committedRoleNames.push(roleName);
  });

  if (changed) {
    store.lastUpdatedAt = timestamp;
    if (persist) saveChatState();
    if (persist && isCurrentChat()) await syncAffectionInjection({ settings, chatState });
    refreshAffectionPanel();
  }
  return {
    ...prepared,
    fingerprint,
    committedRoleNames: [...new Set(committedRoleNames)],
  };
}

export async function commitSelectedPendingAffectionUpdates({
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
  getSelectedFingerprint = messageId => getMessageContentFingerprint(messageId, settings),
  messageIds = null,
} = {}) {
  const summary = {
    active: isAffectionAnalysisActive(settings),
    committedMessageIds: [],
    committedRoleNames: [],
    discardedSwipeCount: 0,
  };
  if (!summary.active) return summary;

  const store = getAffectionSystemState(chatState);
  const pendingEntries = Object.entries(store.pendingByMessage || {});
  if (!pendingEntries.length) return summary;
  const selectedMessageIds = Array.isArray(messageIds)
    ? new Set(messageIds.map(Number).filter(Number.isInteger))
    : null;

  let stateChanged = false;
  const timestamp = formatTimestamp();

  for (const [messageKey, bucket] of pendingEntries) {
    const messageId = Number(messageKey);
    if (selectedMessageIds && !selectedMessageIds.has(messageId)) continue;
    if (!Number.isInteger(messageId) || !isPlainObject(bucket) || !isPlainObject(bucket.items)) {
      delete store.pendingByMessage[messageKey];
      stateChanged = true;
      continue;
    }

    const fingerprint = String(getSelectedFingerprint(messageId) || '').trim();
    if (!fingerprint) continue;
    const selected = bucket.items[fingerprint];
    if (!isPlainObject(selected)) {
      summary.discardedSwipeCount += Object.keys(bucket.items).length;
      delete store.pendingByMessage[messageKey];
      stateChanged = true;
      continue;
    }
    if (selected.origin === 'confirmed') continue;

    summary.discardedSwipeCount += Math.max(0, Object.keys(bucket.items).length - 1);
    const selectedChanges = Array.isArray(selected.changes) ? selected.changes : [];
    selectedChanges.forEach(change => {
      const roleName = normalizeAffectionRoleName(change?.roleName);
      const profile = isPlainObject(store.profiles?.[roleName]) ? store.profiles[roleName] : null;
      if (!profile) return;
      if (applyPendingAffectionChange(profile, change, { messageId, fingerprint, timestamp })) {
        stateChanged = true;
      }
      if (Number(change?.deltaTenths) !== 0) summary.committedRoleNames.push(roleName);
    });

    delete store.pendingByMessage[messageKey];
    summary.committedMessageIds.push(messageId);
    stateChanged = true;
  }

  summary.committedMessageIds = [...new Set(summary.committedMessageIds)];
  summary.committedRoleNames = [...new Set(summary.committedRoleNames)];
  if (stateChanged) {
    store.lastUpdatedAt = timestamp;
    if (persist) saveChatState();
    if (persist) await syncAffectionInjection({ settings, chatState });
    refreshAffectionPanel();
  }
  return summary;
}
