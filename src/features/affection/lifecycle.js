import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import { getMessageContentFingerprint } from '../../core/message-fingerprint.js';
import {
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getMemoryField,
  getMemoryFields,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  AFFECTION_STAGE_RANGES,
  clampAffectionValueTenths,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  getStageForValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionFirstEntries,
  normalizeAffectionRoleName,
  recalculateAffectionLedger,
  replaceAffectionRecord,
  sortAffectionRecords,
} from './model.js';
import {
  createBuildRequestId,
  executeCustomAffectionProfileBuild,
  logAffectionProfileBuild,
  resolveAffectionProfileContext,
  AFFECTION_TRANSPORT_POLICY,
  AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
} from './generation.js';
import { syncAffectionInjection } from './injection.js';
import {
  createGenericAffectionStages,
  createProfileDraft,
  getProfileCurrentValueTenths,
  normalizeAffectionProfileStages,
} from './profile.js';
import {
  isAffectionAnalysisActive,
  refreshAffectionPanel,
} from './runtime.js';

export const AFFECTION_PROFILE_BUILDING_MAX_AGE_MS = AFFECTION_PROFILE_BUILD_TIMEOUT_MS + 2 * 60 * 1000;
const AFFECTION_BUILD_TASK_LIMIT = 60;

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

function buildNormalizedFirstLines(firsts) {
  return firsts.map(item => (
    `[affection_first:${item.roleName}|${formatAffectionValueTenths(item.initialValueTenths)}]`
  ));
}

export function rewriteAffectionMemoryFields(memoryText, { changes = [], firsts = [] } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const lines = memory.split(/\r?\n/);
  const filteredLines = lines.filter(line => {
    const key = getMemoryLineKey(line);
    return key !== 'affection' && key !== 'affection_first';
  });
  const normalizedLines = [
    ...buildNormalizedAffectionLines(Array.isArray(changes) ? changes : []),
    ...buildNormalizedFirstLines(Array.isArray(firsts) ? firsts : []),
  ];
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

export function createAffectionBuildTaskKey({ chatId, messageId, fingerprint, roleName }) {
  return [chatId, messageId, fingerprint, normalizeAffectionRoleName(roleName)]
    .map(value => encodeURIComponent(String(value ?? '')))
    .join('::');
}

function pruneAffectionBuildTasks(buildTasks) {
  const entries = Object.entries(isPlainObject(buildTasks) ? buildTasks : {});
  if (entries.length <= AFFECTION_BUILD_TASK_LIMIT) return;
  entries
    .sort(([, left], [, right]) => String(left?.updatedAt || left?.createdAt || '')
      .localeCompare(String(right?.updatedAt || right?.createdAt || '')))
    .slice(0, entries.length - AFFECTION_BUILD_TASK_LIMIT)
    .forEach(([key]) => delete buildTasks[key]);
}

function getDefaultBuildSnapshot(messageId) {
  const settings = getGlobalSettings();
  return {
    chatId: getContextInfo().chatId,
    fingerprint: getMessageContentFingerprint(messageId, settings),
    active: isAffectionAnalysisActive(settings),
  };
}

function collectAffectionBuildCandidates(pending, profiles) {
  const candidates = [];
  const seen = new Set();
  const add = (roleName, initialValueTenths, source) => {
    const normalizedRoleName = normalizeAffectionRoleName(roleName);
    if (!normalizedRoleName || seen.has(normalizedRoleName) || isPlainObject(profiles?.[normalizedRoleName])) return;
    seen.add(normalizedRoleName);
    candidates.push({ roleName: normalizedRoleName, initialValueTenths, source });
  };

  (Array.isArray(pending?.firsts) ? pending.firsts : []).forEach(item => {
    const value = Number(item?.initialValueTenths);
    add(
      item?.roleName,
      Number.isInteger(value) && value >= 0 && value <= 1000 ? value : null,
      'affection_first',
    );
  });
  (Array.isArray(pending?.diagnostics) ? pending.diagnostics : []).forEach(item => {
    if (item?.code === 'first_invalid_initial_value' || item?.code === 'change_without_profile_or_first') {
      add(item.roleName, null, item.code);
    }
  });
  return candidates;
}

function isReusableBuildTask(task, force) {
  if (!isPlainObject(task) || force) return false;
  if (['ready', 'error', 'stale', 'needs_initial_value'].includes(task.buildStatus)) return true;
  if (task.buildStatus !== 'building') return false;
  return Date.now() - Number(task.createdAtMs || 0) < AFFECTION_PROFILE_BUILDING_MAX_AGE_MS;
}

function saveAffectionBuildState(persist) {
  if (persist) {
    saveChatState();
    refreshAffectionPanel();
  }
}

function isAutomaticRecordForMessage(record, messageId) {
  return record?.sourceType !== 'manual_adjustment'
    && Number(record?.sourceMessageId) === Number(messageId);
}

function removeAutomaticRecordsForMessage(records, messageId) {
  return sortAffectionRecords(records).filter(record => !isAutomaticRecordForMessage(record, messageId));
}

function getMatchingAffectionBuildTask(store, {
  chatId,
  messageId,
  fingerprint,
  roleName,
}) {
  const taskKey = createAffectionBuildTaskKey({ chatId, messageId, fingerprint, roleName });
  const task = store.buildTasks?.[taskKey];
  if (!isPlainObject(task)) return null;
  return String(task.chatId || '') === String(chatId || '')
    && Number(task.messageId) === Number(messageId)
    && String(task.fingerprint || '') === String(fingerprint || '')
    && normalizeAffectionRoleName(task.roleName) === normalizeAffectionRoleName(roleName)
    ? task
    : null;
}

function removeAffectionBuildTasksForMessage(store, messageId, { keepTaskKeys = [] } = {}) {
  const keep = new Set(keepTaskKeys);
  let removed = 0;
  Object.entries(store.buildTasks || {}).forEach(([taskKey, task]) => {
    if (Number(task?.messageId) !== Number(messageId) || keep.has(taskKey)) return;
    delete store.buildTasks[taskKey];
    removed += 1;
  });
  return removed;
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

function isMatchingReadyProfileDraft(task, first) {
  const draft = task?.profileDraft;
  return task?.buildStatus === 'ready'
    && isPlainObject(draft)
    && normalizeAffectionRoleName(draft.roleName) === normalizeAffectionRoleName(first?.roleName)
    && Number(draft.initialValueTenths) === Number(first?.initialValueTenths)
    && Array.isArray(draft.stages)
    && draft.stages.length === AFFECTION_STAGE_RANGES.length;
}

function getCurrentTaskState(task, {
  getCurrentSnapshot,
  getCurrentChatState,
}) {
  const snapshot = getCurrentSnapshot(task.messageId);
  if (String(snapshot?.chatId || '') !== task.chatId) {
    return { valid: false, reason: '聊天已切换。', canWrite: false, task: null };
  }
  const currentChatState = getCurrentChatState();
  const currentStore = getAffectionSystemState(currentChatState);
  const currentTask = currentStore.buildTasks[task.taskKey];
  if (!isPlainObject(currentTask) || currentTask.buildRequestId !== task.buildRequestId) {
    return { valid: false, reason: '建档任务已被替换或清理。', canWrite: true, task: currentTask || null };
  }
  if (snapshot?.active !== true) {
    return { valid: false, reason: '好感模块或自动小总结已关闭。', canWrite: true, task: currentTask };
  }
  if (String(snapshot?.fingerprint || '') !== task.fingerprint) {
    return { valid: false, reason: '当前选中 swipe 已变化。', canWrite: true, task: currentTask };
  }
  return { valid: true, reason: '', canWrite: true, task: currentTask };
}

function markBuildTaskStale(task, reason, validation, persist) {
  if (validation.canWrite && isPlainObject(validation.task)) {
    validation.task.buildStatus = 'stale';
    validation.task.error = reason;
    validation.task.updatedAt = formatTimestamp();
    saveAffectionBuildState(persist);
  }
}

async function runAffectionBuildCandidate(candidate, pending, options) {
  const {
    settings,
    chatState,
    chatId,
    persist,
    force,
    getCurrentSnapshot,
    getCurrentChatState,
    requestCustomProfile,
    resolveContextMaterial,
    log,
    transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
  } = options;
  const affection = getAffectionSettings(settings);
  const store = getAffectionSystemState(chatState);
  const taskKey = createAffectionBuildTaskKey({
    chatId,
    messageId: pending.messageId,
    fingerprint: pending.fingerprint,
    roleName: candidate.roleName,
  });
  const existing = store.buildTasks[taskKey];
  if (isReusableBuildTask(existing, force)) return existing;

  const now = formatTimestamp();
  const task = {
    taskKey,
    buildRequestId: createBuildRequestId(),
    chatId,
    messageId: pending.messageId,
    fingerprint: pending.fingerprint,
    roleName: candidate.roleName,
    initialValueTenths: candidate.initialValueTenths,
    buildMode: affection.defaultBuildMode,
    apiMode: affection.profileBuildApiMode,
    buildStatus: candidate.initialValueTenths === null
      ? 'needs_initial_value'
      : affection.defaultBuildMode === 'generic' ? 'ready' : 'building',
    stages: [],
    profileDraft: null,
    source: candidate.source,
    error: candidate.initialValueTenths === null ? '缺少合法 affection_first 初值。' : '',
    createdAt: now,
    createdAtMs: Date.now(),
    updatedAt: now,
  };
  store.buildTasks[taskKey] = task;
  pruneAffectionBuildTasks(store.buildTasks);

  const startedAt = now;
  const startedMs = performance.now();
  if (task.buildStatus === 'needs_initial_value') {
    saveAffectionBuildState(persist);
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'failure',
      startedAt,
      startedMs,
      parsedResult: task,
      error: new Error(task.error),
    });
    return task;
  }

  if (task.buildMode === 'generic') {
    task.stages = createGenericAffectionStages();
    task.profileDraft = createProfileDraft(task, task.stages);
    task.updatedAt = formatTimestamp();
    saveAffectionBuildState(persist);
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'success',
      startedAt,
      startedMs,
      parsedResult: task.profileDraft,
    });
    return task;
  }

  saveAffectionBuildState(persist);
  let result = null;
  let requestMessages = [];
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile,
      resolveContextMaterial,
      transportPolicy,
      onMessagesReady: messages => {
        requestMessages = messages;
      },
    });
    const validation = getCurrentTaskState(task, { getCurrentSnapshot, getCurrentChatState });
    if (!validation.valid) {
      markBuildTaskStale(task, validation.reason, validation, persist);
      logAffectionProfileBuild({
        enabled: log,
        task,
        status: 'failure',
        startedAt,
        startedMs,
        messages: result.messages,
        apiResult: result.apiResult,
        transportPlan: result.apiResult?.transportPlan || null,
        parsedResult: result.parsed,
        error: new Error(`建档结果失效：${validation.reason}`),
      });
      return validation.task || { ...task, buildStatus: 'stale', error: validation.reason };
    }
    validation.task.stages = result.stages;
    validation.task.profileDraft = createProfileDraft(validation.task, result.stages);
    validation.task.buildStatus = 'ready';
    validation.task.error = '';
    validation.task.updatedAt = formatTimestamp();
    saveAffectionBuildState(persist);
    logAffectionProfileBuild({
      enabled: log,
      task: validation.task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      transportPlan: result.apiResult?.transportPlan || null,
      parsedResult: validation.task.profileDraft,
    });
    if (validation.task.confirmed === true) {
      await commitSelectedPendingAffectionUpdates({
        settings,
        chatState: getCurrentChatState(),
        chatId,
        persist,
        getSelectedFingerprint: messageId => getCurrentSnapshot(messageId)?.fingerprint || '',
      });
    }
    return validation.task;
  } catch (error) {
    const validation = getCurrentTaskState(task, { getCurrentSnapshot, getCurrentChatState });
    if (validation.valid) {
      validation.task.buildStatus = 'error';
      validation.task.error = error?.message || String(error);
      validation.task.stages = [];
      validation.task.profileDraft = null;
      validation.task.updatedAt = formatTimestamp();
      saveAffectionBuildState(persist);
    } else {
      markBuildTaskStale(task, validation.reason, validation, persist);
    }
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'failure',
      startedAt,
      startedMs,
      messages: result?.messages || requestMessages,
      apiResult: result?.apiResult || null,
      transportPlan: result?.apiResult?.transportPlan || error?.transportPlan || null,
      error,
    });
    return validation.task || { ...task, buildStatus: 'stale', error: validation.reason };
  }
}

export async function startAffectionProfileBuildsForPending(
  pending,
  {
    settings = getGlobalSettings(),
    chatState = getChatState(),
    chatId = getContextInfo().chatId,
    persist = true,
    force = false,
    getCurrentSnapshot = getDefaultBuildSnapshot,
    getCurrentChatState = () => getChatState(),
    requestCustomProfile = null,
    resolveContextMaterial = resolveAffectionProfileContext,
    log = persist,
    // Automatic pending / confirmed builds default to legacy and ignore global stream setting.
    transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
  } = {},
) {
  if (!pending || !Number.isInteger(Number(pending.messageId)) || !String(pending.fingerprint || '').trim()) return [];
  const store = getAffectionSystemState(chatState);
  const candidates = collectAffectionBuildCandidates(pending, store.profiles);
  const options = {
    settings,
    chatState,
    chatId: String(chatId || ''),
    persist,
    force,
    getCurrentSnapshot,
    getCurrentChatState,
    requestCustomProfile,
    resolveContextMaterial,
    log,
    transportPolicy,
  };
  return Promise.all(candidates.map(candidate => runAffectionBuildCandidate(candidate, pending, options)));
}

function getAffectionPendingItem(store, messageId, fingerprint) {
  const bucket = store.pendingByMessage?.[String(Number(messageId))];
  return isPlainObject(bucket?.items?.[String(fingerprint || '').trim()])
    ? bucket.items[String(fingerprint || '').trim()]
    : null;
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
  const matchingTaskKeys = Object.entries(store.buildTasks || {})
    .filter(([, task]) => (
      Number(task?.messageId) === Number(messageId)
      && String(task?.fingerprint || '') === cleanFingerprint
      && normalizeAffectionRoleName(task?.roleName) === cleanRoleName
    ))
    .map(([taskKey]) => taskKey);
  const matchingPendingCount = [
    ...(Array.isArray(pending.changes) ? pending.changes : []),
    ...(Array.isArray(pending.firsts) ? pending.firsts : []),
  ].filter(item => normalizeAffectionRoleName(item?.roleName) === cleanRoleName).length;
  if (!matchingPendingCount && !matchingTaskKeys.length) return false;
  pending.changes = (Array.isArray(pending.changes) ? pending.changes : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== cleanRoleName);
  pending.firsts = (Array.isArray(pending.firsts) ? pending.firsts : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== cleanRoleName);
  pending.changed = pending.changes.some(item => Number(item?.deltaTenths) !== 0);
  const afterCount = pending.changes.length + pending.firsts.length;
  matchingTaskKeys.forEach(taskKey => delete store.buildTasks[taskKey]);
  if (!afterCount) delete bucket.items[cleanFingerprint];
  if (!Object.keys(bucket.items).length) delete store.pendingByMessage[messageKey];
  markAffectionStoreUpdated(store, persist);
  return true;
}

export async function retryAffectionBuildTask({ taskKey } = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const store = getAffectionSystemState(chatState);
  const task = store.buildTasks?.[String(taskKey || '')];
  if (!isPlainObject(task)) throw new Error('待重试的专属建档任务已经不存在。');
  const pending = getAffectionPendingItem(store, task.messageId, task.fingerprint);
  if (!pending) throw new Error('建档来源回复已经失效，无法重试。');
  return startAffectionProfileBuildsForPending(pending, {
    settings,
    chatState,
    chatId: task.chatId,
    persist,
    force: true,
  });
}

export function updateAffectionBuildTaskInitialValue({
  taskKey,
  initialValueTenths,
} = {}, {
  chatState = getChatState(),
  persist = true,
} = {}) {
  const value = Number(initialValueTenths);
  const store = getAffectionSystemState(chatState);
  const task = store.buildTasks?.[String(taskKey || '')];
  if (!isPlainObject(task)) throw new Error('待处理的首次建档任务已经不存在。');
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error('初始好感必须是 0—100、最多一位小数。');
  }
  const pending = getAffectionPendingItem(store, task.messageId, task.fingerprint);
  if (!pending) throw new Error('建档来源回复已经失效，无法补充初始好感。');
  task.initialValueTenths = value;
  task.error = '';
  task.updatedAt = formatTimestamp();
  const firsts = (Array.isArray(pending.firsts) ? pending.firsts : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== normalizeAffectionRoleName(task.roleName));
  pending.firsts = [...firsts, { roleName: task.roleName, initialValueTenths: value }];
  pending.updatedAt = task.updatedAt;
  markAffectionStoreUpdated(store, persist);
  return task;
}

export async function useGenericAffectionBuildTask({ taskKey } = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const store = getAffectionSystemState(chatState);
  const task = store.buildTasks?.[String(taskKey || '')];
  if (!isPlainObject(task) || !Number.isInteger(Number(task.initialValueTenths))) {
    throw new Error('该建档任务缺少合法初始好感，无法改用通用阶段。');
  }
  task.buildMode = 'generic';
  task.stages = createGenericAffectionStages();
  task.profileDraft = createProfileDraft(task, task.stages);
  task.buildStatus = 'ready';
  task.error = '';
  task.updatedAt = formatTimestamp();
  markAffectionStoreUpdated(store, persist);
  if (task.confirmed === true) {
    await commitSelectedPendingAffectionUpdates({ settings, chatState, chatId: task.chatId, persist });
  }
  refreshAffectionPanel();
  return task;
}

export function parseAffectionUpdateFromMemory(memoryText, { profiles = {} } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const rawAffectionValues = getMemoryFields(memory, 'affection');
  const rawFirstValues = getMemoryFields(memory, 'affection_first');
  if (!rawAffectionValues.length && !rawFirstValues.length) return null;

  const diagnostics = [];

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
  const rawFirstEntries = rawFirstValues.map((value, index) => {
    const entry = parseRawPipeEntry(value, 'initialValue');
    if (entry.extraParts.length) {
      diagnostics.push({
        code: 'first_extra_fields',
        index,
        roleName: entry.roleName,
        message: 'affection_first 只允许角色名与初始好感两段，多余字段已忽略。',
      });
    }
    return entry;
  });

  const normalizedChanges = normalizeAffectionChanges({
    entries: rawAffectionEntries,
  });
  const normalizedFirsts = normalizeAffectionFirstEntries({
    entries: rawFirstEntries,
    existingRoleNames: Object.keys(isPlainObject(profiles) ? profiles : {}),
  });
  diagnostics.push(...normalizedChanges.diagnostics, ...normalizedFirsts.diagnostics);

  const firstByRoleName = new Map(
    normalizedFirsts.items.map(item => [item.roleName, item]),
  );
  const changes = normalizedChanges.items.flatMap(item => {
    const profile = isPlainObject(profiles?.[item.roleName]) ? profiles[item.roleName] : null;
    const first = firstByRoleName.get(item.roleName);
    if (!profile && !first) {
      diagnostics.push({
        code: 'change_without_profile_or_first',
        roleName: item.roleName,
        message: `「${item.roleName}」尚未建档且本轮没有合法 affection_first，无法计算当前好感，已拒绝该 affection。`,
      });
      return [];
    }

    if (first) {
      diagnostics.push({
        code: 'first_suppresses_same_turn_change',
        roleName: item.roleName,
        message: `「${item.roleName}」本轮为首次建档，affection_first 已表示楼层结束后的初始好感；同角色 affection 已忽略。`,
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
  if (
    normalizedChanges.changed
    && !changed
    && !diagnostics.some(item => item.code === 'first_suppresses_same_turn_change')
  ) {
    diagnostics.push({
      code: 'no_resolvable_change',
      message: '本轮没有可计算当前值的 affection，已规范化为无变化。',
    });
  }
  const firsts = normalizedFirsts.items;
  const normalizedMemory = rewriteAffectionMemoryFields(memory, { changes, firsts });

  return {
    changed,
    changes,
    firsts,
    diagnostics,
    raw: {
      affection: rawAffectionValues,
      affectionFirst: rawFirstValues,
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
    changed: analysis.changed === true,
    changes: Array.isArray(analysis.changes) ? analysis.changes.map(item => ({ ...item })) : [],
    firsts: Array.isArray(analysis.firsts) ? analysis.firsts.map(item => ({ ...item })) : [],
    diagnostics: Array.isArray(analysis.diagnostics) ? analysis.diagnostics.map(item => ({ ...item })) : [],
    raw: isPlainObject(analysis.raw) ? { ...analysis.raw } : {},
    origin: ['legacy', 'manual'].includes(origin) ? origin : 'legacy',
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
    startBuild = true,
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const prepared = analysis || prepareAffectionUpdateFromSummaryResult(result, { settings, chatState });
  if (!prepared) {
    console.warn('[蜃灵助手] 本轮小总结未返回 affection / affection_first，已跳过好感 pending。');
    return null;
  }
  const fingerprint = getMessageContentFingerprint(messageId, settings);
  if (!fingerprint) return { ...prepared, pending: null, fingerprint: '' };
  const pending = storePendingAffectionUpdate(
    { messageId, fingerprint, analysis: prepared },
    { chatState, persist },
  );
  if (pending && startBuild) {
    void startAffectionProfileBuildsForPending(pending, {
      settings,
      chatState,
      chatId: getContextInfo().chatId,
      persist,
    }).catch(error => {
      console.error('[蜃灵助手] 好感首次角色预建档失败。', error);
    });
  }
  return { ...prepared, pending, fingerprint };
}

export async function commitAffectionUpdateFromConfirmedSummary(
  result,
  {
    messageId,
    settings = getGlobalSettings(),
    chatState = getChatState(),
    chatId = getContextInfo().chatId,
    persist = true,
    isCurrentChat = () => true,
    // Default remains legacy; confirmed formal path must pass CONFIGURED explicitly.
    transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
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
  const summary = {
    committedRoleNames: [],
    createdRoleNames: [],
  };
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
    if (Number(change?.deltaTenths) !== 0) summary.committedRoleNames.push(roleName);
  });

  const firsts = Array.isArray(prepared.firsts) ? prepared.firsts : [];
  if (firsts.length) {
    const buildPending = {
      messageId: numericMessageId,
      fingerprint,
      changes: [],
      firsts,
    };
    await startAffectionProfileBuildsForPending(buildPending, {
      settings,
      chatState,
      chatId,
      persist,
      transportPolicy,
    });
    if (!isCurrentChat()) return { ...prepared, fingerprint, ...summary };

    for (const first of firsts) {
      const roleName = normalizeAffectionRoleName(first?.roleName);
      if (!roleName || isPlainObject(store.profiles?.[roleName])) continue;
      const task = getMatchingAffectionBuildTask(store, {
        chatId,
        messageId: numericMessageId,
        fingerprint,
        roleName,
      });
      if (!isMatchingReadyProfileDraft(task, first)) {
        throw new Error(`好感首次建档未完成：${roleName || '未知角色'}`);
      }
      const ledger = recalculateAffectionLedger(task.profileDraft.initialValueTenths, task.profileDraft.records);
      store.profiles[roleName] = {
        ...task.profileDraft,
        roleName,
        initialValueTenths: ledger.initialValueTenths,
        valueTenths: ledger.valueTenths,
        records: ledger.records,
        sourceMessageId: numericMessageId,
        sourceFingerprint: fingerprint,
        buildStatus: 'ready',
        updatedAt: timestamp,
      };
      delete store.buildTasks[task.taskKey];
      summary.createdRoleNames.push(roleName);
      changed = true;
    }
  }

  if (changed) {
    store.lastUpdatedAt = timestamp;
    if (persist) saveChatState();
    if (persist && isCurrentChat()) await syncAffectionInjection({ settings, chatState });
    refreshAffectionPanel();
  }
  return {
    ...prepared,
    fingerprint,
    committedRoleNames: [...new Set(summary.committedRoleNames)],
    createdRoleNames: [...new Set(summary.createdRoleNames)],
  };
}

export async function commitSelectedPendingAffectionUpdates({
  settings = getGlobalSettings(),
  chatState = getChatState(),
  chatId = getContextInfo().chatId,
  persist = true,
  getSelectedFingerprint = messageId => getMessageContentFingerprint(messageId, settings),
  messageIds = null,
} = {}) {
  const summary = {
    active: isAffectionAnalysisActive(settings),
    committedMessageIds: [],
    committedRoleNames: [],
    createdRoleNames: [],
    waitingRoleNames: [],
    discardedSwipeCount: 0,
    removedBuildTaskCount: 0,
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
      summary.removedBuildTaskCount += removeAffectionBuildTasksForMessage(store, messageId);
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

    const unresolvedFirsts = [];
    const keepTaskKeys = [];
    (Array.isArray(selected.firsts) ? selected.firsts : []).forEach(first => {
      const roleName = normalizeAffectionRoleName(first?.roleName);
      if (!roleName || isPlainObject(store.profiles?.[roleName])) return;
      const task = getMatchingAffectionBuildTask(store, {
        chatId,
        messageId,
        fingerprint,
        roleName,
      });
      if (isMatchingReadyProfileDraft(task, first)) {
        const draft = task.profileDraft;
        const ledger = recalculateAffectionLedger(draft.initialValueTenths, draft.records);
        store.profiles[roleName] = {
          ...draft,
          roleName,
          initialValueTenths: ledger.initialValueTenths,
          valueTenths: ledger.valueTenths,
          records: ledger.records,
          sourceMessageId: messageId,
          sourceFingerprint: fingerprint,
          buildStatus: 'ready',
          updatedAt: timestamp,
        };
        delete store.buildTasks[task.taskKey];
        summary.createdRoleNames.push(roleName);
        stateChanged = true;
        return;
      }
      if (task?.buildStatus === 'building') {
        task.confirmed = true;
        task.confirmedAt = task.confirmedAt || timestamp;
        task.updatedAt = timestamp;
        unresolvedFirsts.push({ ...first });
        keepTaskKeys.push(task.taskKey);
        summary.waitingRoleNames.push(roleName);
        stateChanged = true;
      }
    });

    summary.removedBuildTaskCount += removeAffectionBuildTasksForMessage(store, messageId, {
      keepTaskKeys,
    });
    if (unresolvedFirsts.length) {
      selected.changes = [];
      selected.changed = false;
      selected.firsts = unresolvedFirsts;
      selected.confirmed = true;
      selected.confirmedAt = selected.confirmedAt || timestamp;
      selected.updatedAt = timestamp;
      store.pendingByMessage[messageKey] = {
        messageId,
        items: { [fingerprint]: selected },
        updatedAt: timestamp,
      };
    } else {
      delete store.pendingByMessage[messageKey];
    }
    summary.committedMessageIds.push(messageId);
    stateChanged = true;
  }

  summary.committedMessageIds = [...new Set(summary.committedMessageIds)];
  summary.committedRoleNames = [...new Set(summary.committedRoleNames)];
  summary.createdRoleNames = [...new Set(summary.createdRoleNames)];
  summary.waitingRoleNames = [...new Set(summary.waitingRoleNames)];
  if (stateChanged) {
    store.lastUpdatedAt = timestamp;
    if (persist) saveChatState();
    if (persist) await syncAffectionInjection({ settings, chatState });
    refreshAffectionPanel();
  }
  return summary;
}
