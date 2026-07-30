import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
import {
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
} from '../../core/generation.js';
import { replacePromptMessageMacros } from '../../core/macros.js';
import {
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getMemoryField,
  getMemoryFields,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import { getMessageContentFingerprint } from '../../core/message-fingerprint.js';
import { registerPendingCommitHandler } from '../../core/pending-commit.js';
import {
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import { getContextSafe } from '../../core/chat.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import {
  buildAffectionProfilePrompt,
  buildAffectionStateInjectionPrompt,
  buildAffectionUpdatePromptSection as buildAffectionUpdatePromptSectionText,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  AFFECTION_STAGE_RANGES,
  clampAffectionValueTenths,
  createManualAffectionAdjustmentRecord,
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

const AFFECTION_PROFILE_BUILD_TIMEOUT_MS = 180000;
const AFFECTION_PROFILE_BUILDING_MAX_AGE_MS = 5 * 60 * 1000;
const AFFECTION_BUILD_TASK_LIMIT = 60;
const AFFECTION_PENDING_COMMIT_HANDLER_ID = 'affection';
export const AFFECTION_STATE_PROMPT_ID = 'shenling_assistant_affection_state';
export const AFFECTION_STATE_INJECT_POSITION = 1;
export const AFFECTION_STATE_INJECT_DEPTH = 0;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  refreshPanel: null,
};

let affectionPendingCommitRegistered = false;
const affectionEventStops = [];
let affectionEventsRegistered = false;

export function configureAffectionWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

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

function getProfileCurrentValueTenths(profile) {
  if (!isPlainObject(profile)) return null;
  return recalculateAffectionLedger(
    profile.initialValueTenths,
    Array.isArray(profile.records) ? profile.records : [],
  ).valueTenths;
}

export function buildKnownAffectionText(profiles = {}) {
  const lines = Object.entries(isPlainObject(profiles) ? profiles : {})
    .filter(([, profile]) => isPlainObject(profile))
    .map(([storedRoleName, profile]) => {
      const roleName = String(profile.roleName || storedRoleName || '').trim();
      if (!roleName) return '';
      const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
      const recent = ledger.records.slice(-3).map(record => {
        const source = record.sourceMessageId === null || record.sourceMessageId === undefined
          ? '手动调整'
          : `第${record.sourceMessageId}楼`;
        const deltaTenths = Number(record.deltaTenths);
        const deltaValue = Number.isInteger(deltaTenths) ? (deltaTenths / 10).toFixed(1) : '0.0';
        const delta = deltaTenths > 0 ? `+${deltaValue}` : deltaValue;
        return `${source}${delta}→${formatAffectionValueTenths(record.valueAfterTenths)}`;
      });
      return `【${roleName}】已建档，当前好感 ${formatAffectionValueTenths(ledger.valueTenths)}/100${recent.length ? `；近期：${recent.join('、')}` : '；暂无正式变化记录'}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : '暂无已建档角色。';
}

function buildAffectionStageBehaviorText(stage) {
  const meaning = String(stage?.meaning || '').trim();
  const behaviors = (Array.isArray(stage?.behaviors) ? stage.behaviors : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return [meaning, behaviors.length ? behaviors.join('；') : '']
    .filter(Boolean)
    .join('；');
}

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

const GENERIC_AFFECTION_STAGE_CONTENT = Object.freeze([
  Object.freeze({
    name: '陌路星辰',
    meaning: '仍是需要保持距离与观察的陌生人。',
    behaviors: ['保持基本礼貌与必要交流', '优先观察 {{user}} 的言行与边界', '不主动透露私人情绪与重要秘密'],
    trend: '开始记住 {{user}} 的习惯，并愿意延长普通交流。',
    boundary: '不提前表现亲密依赖、暧昧占有或无条件信任。',
  }),
  Object.freeze({
    name: '微光初现',
    meaning: '把 {{user}} 视为可以继续接触的熟人与朋友。',
    behaviors: ['愿意回应日常关心与普通邀约', '在力所能及的范围提供帮助', '偶尔分享不敏感的个人想法'],
    trend: '逐渐主动寻找共同话题，并在意 {{user}} 的评价。',
    boundary: '不提前作出恋爱承诺或表现强烈排他性。',
  }),
  Object.freeze({
    name: '情愫暗生',
    meaning: '已产生明确好感，但仍在确认彼此心意。',
    behaviors: ['更主动关注 {{user}} 的情绪变化', '愿意创造单独相处与深入交流的机会', '在关键时刻给予带有个人倾向的支持'],
    trend: '试探彼此边界，并逐渐显露区别于普通朋友的在意。',
    boundary: '不把尚未确认的好感直接演成稳定伴侣关系。',
  }),
  Object.freeze({
    name: '心意相通',
    meaning: '已确认彼此具有亲密倾向，关系进入稳定磨合。',
    behaviors: ['主动表达思念、关心与亲密需求', '把 {{user}} 纳入重要计划与决定', '遇到分歧时愿意沟通并修复关系'],
    trend: '逐步建立更深的承诺、默契与共同生活感。',
    boundary: '不忽略角色自身原则，也不把亲密等同于失去独立性。',
  }),
  Object.freeze({
    name: '灵魂交融',
    meaning: '把 {{user}} 视为深度信赖并愿意长期相伴的爱人。',
    behaviors: ['自然分享最重要的脆弱、秘密与长期愿景', '在尊重彼此主体性的前提下承担共同责任', '以稳定而具体的行动维护双方关系'],
    trend: '继续深化共同经历与长期承诺，而非机械重复示爱。',
    boundary: '不因高好感取消人设、现实矛盾、个人边界或合理分歧。',
  }),
]);

function sanitizeAffectionStageText(value, maxLength) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[(?:emotion|affection|progress|memory|grand_memory)[^\]\r\n]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function createGenericAffectionStages() {
  return AFFECTION_STAGE_RANGES.map((range, index) => ({
    ...range,
    ...GENERIC_AFFECTION_STAGE_CONTENT[index],
    behaviors: [...GENERIC_AFFECTION_STAGE_CONTENT[index].behaviors],
  }));
}

export function normalizeAffectionProfileStages(value) {
  const stages = Array.isArray(value?.stages) ? value.stages : Array.isArray(value) ? value : [];
  if (stages.length !== AFFECTION_STAGE_RANGES.length) {
    throw new Error('专属阶段表必须恰好包含五个阶段。');
  }

  return AFFECTION_STAGE_RANGES.map((range, index) => {
    const source = isPlainObject(stages[index]) ? stages[index] : {};
    const name = sanitizeAffectionStageText(source.name, 24);
    const meaning = sanitizeAffectionStageText(source.meaning, 120);
    const trend = sanitizeAffectionStageText(source.trend, 120);
    const boundary = sanitizeAffectionStageText(source.boundary, 120);
    const behaviors = (Array.isArray(source.behaviors) ? source.behaviors : [])
      .map(item => sanitizeAffectionStageText(item, 100))
      .filter(Boolean);
    if (!name || !meaning || !trend || !boundary || behaviors.length !== 3) {
      throw new Error(`专属阶段表第 ${index + 1} 阶段字段不完整，且 behaviors 必须恰好三条非空文本。`);
    }
    return {
      ...range,
      name,
      meaning,
      behaviors,
      trend,
      boundary,
    };
  });
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const matched = raw.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return (matched?.[1] || raw).trim();
}

function parseAffectionProfileResponse(value) {
  if (isPlainObject(value) && Array.isArray(value.stages)) return value;
  const raw = stripMarkdownFence(value);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('专属阶段表返回不是合法 JSON。');
  }
}

export function createAffectionBuildTaskKey({ chatId, messageId, fingerprint, roleName }) {
  return [chatId, messageId, fingerprint, normalizeAffectionRoleName(roleName)]
    .map(value => encodeURIComponent(String(value ?? '')))
    .join('::');
}

function createBuildRequestId() {
  return `affection-build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function buildAffectionProfileMessages({
  roleName,
  initialValueTenths,
  userRequirement = '',
  contextMaterial,
}) {
  const settings = getGlobalSettings();
  return replacePromptMessageMacros([
    ...resolvePromptMessages(PROMPT_IDS.SUMMARY_SUPPORT_MESSAGES, settings),
    {
      role: 'user',
      content: buildAffectionProfilePrompt({
        roleName,
        initialAffection: formatAffectionValueTenths(initialValueTenths),
        userRequirement,
        contextMaterial,
        template: resolvePromptText(PROMPT_IDS.AFFECTION_PROFILE, settings),
      }),
    },
  ]);
}

async function resolveAffectionProfileContext(roleName) {
  const context = await resolveShenlingContext({
    purpose: 'affectionProfile',
    targetRoleName: roleName,
    recentMessageLimit: 8,
    includeRecentChat: true,
    includeMemories: true,
    includeGrandMemories: true,
    includeEmotionProfile: true,
    includeAllEmotionProfiles: false,
    includeWorldInfo: false,
  });
  return formatShenlingContextForPrompt(context, {
    includeWorldInfo: false,
    includeTimelineArchives: true,
    includeRecentChat: true,
    includeEmotionProfiles: true,
  });
}

async function requestAffectionProfileStages({ messages, apiMode }) {
  const apiResult = apiMode === 'main_api'
    ? await generateWithMainApi({
      messages,
      timeoutMs: AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
      timeoutMessage: '专属阶段表生成超时，请稍后重试。',
    })
    : await generateWithSecondaryApi({
      profile: getWorkflowOption('getActiveApiProfile')?.(getGlobalSettings()),
      messages,
      timeoutMs: AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
      timeoutMessage: '专属阶段表生成超时，请稍后重试。',
    });

  return {
    ...apiResult,
    rawContent: apiResult.content,
  };
}

function createProfileDraft(task, stages) {
  const now = formatTimestamp();
  return {
    roleName: task.roleName,
    initialValueTenths: task.initialValueTenths,
    valueTenths: task.initialValueTenths,
    buildMode: task.buildMode,
    buildStatus: 'ready',
    stages,
    records: [],
    sourceMessageId: task.messageId,
    sourceFingerprint: task.fingerprint,
    createdAt: now,
    updatedAt: now,
  };
}

export function isAffectionAnalysisActive(settings = getGlobalSettings()) {
  const affection = getAffectionSettings(settings);
  const summary = getSummarySettings(settings);
  return Boolean(
    settings?.enabled === true
    && summary.enabled === true
    && affection.enabled === true
    && affection.mode === 'normal'
  );
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
    getWorkflowOption('refreshPanel')?.();
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

function logAffectionProfileBuild({
  enabled = true,
  task,
  status,
  startedAt,
  startedMs,
  messages = [],
  apiResult = null,
  parsedResult = null,
  error = null,
}) {
  if (!enabled) return;
  const generationErrorContext = status === 'failure' ? getGenerationErrorContext(error) : null;
  const errorCode = generationErrorContext?.code || '';
  const errorStage = generationErrorContext?.stage || '';
  const diagnostics = generationErrorContext?.diagnostics || null;
  getWorkflowOption('addCommunicationLog')?.({
    moduleName: task.apiMode === 'main_api' ? '好感度建档 / 主 API' : '好感度建档 / 副 API',
    taskType: task.operation === 'regenerate'
      ? '专属阶段表主动重新生成'
      : task.buildMode === 'generic' ? '通用阶段表预建档' : '专属阶段表预建档',
    status,
    startedAt,
    durationMs: diagnostics?.durationMs ?? Math.round(performance.now() - startedMs),
    profileName: diagnostics?.profileName
      || apiResult?.profileName
      || (task.apiMode === 'main_api' ? '酒馆当前连接' : ''),
    model: diagnostics?.model
      || apiResult?.model
      || (task.apiMode === 'main_api' ? '酒馆主 API' : ''),
    url: diagnostics?.url
      || apiResult?.url
      || (task.apiMode === 'main_api' ? '酒馆当前连接' : ''),
    httpStatus: diagnostics?.httpStatus ?? apiResult?.httpStatus ?? '',
    messages,
    requestBody: apiResult?.requestBody || {
      buildRequestId: task.buildRequestId,
      chatId: task.chatId,
      messageId: task.messageId,
      fingerprint: task.fingerprint,
      roleName: task.roleName,
      initialValueTenths: task.initialValueTenths,
      buildMode: task.buildMode,
    },
    responseText: diagnostics?.responseText || apiResult?.responseText || '',
    rawResultContent: apiResult?.rawContent || '',
    parsedResult,
    ...(status === 'failure' ? { errorCode, errorStage } : {}),
    errorStack: error?.stack || error?.message || error || '',
  });
}

async function executeCustomAffectionProfileBuild(task, {
  requestCustomProfile,
  resolveContextMaterial,
  onMessagesReady = null,
}) {
  const contextMaterial = await resolveContextMaterial(task.roleName);
  const messages = buildAffectionProfileMessages({
    roleName: task.roleName,
    initialValueTenths: task.initialValueTenths,
    userRequirement: task.userRequirement,
    contextMaterial,
  });
  if (typeof onMessagesReady === 'function') {
    onMessagesReady(messages);
  }
  const apiResult = requestCustomProfile
    ? await requestCustomProfile({ task: { ...task }, messages, contextMaterial })
    : await requestAffectionProfileStages({ messages, apiMode: task.apiMode });
  const rawContent = isPlainObject(apiResult) && Object.hasOwn(apiResult, 'rawContent')
    ? apiResult.rawContent
    : apiResult;
  const parsed = parseAffectionProfileResponse(rawContent);
  const stages = normalizeAffectionProfileStages(parsed);
  return {
    messages,
    apiResult: isPlainObject(apiResult) ? apiResult : { rawContent: String(apiResult || '') },
    parsed,
    stages,
  };
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
  };
  return Promise.all(candidates.map(candidate => runAffectionBuildCandidate(candidate, pending, options)));
}

export async function runAffectionProfileBuildApiPreview({ roleName, initialValueTenths } = {}) {
  const normalizedRoleName = normalizeAffectionRoleName(roleName);
  const value = Number(initialValueTenths);
  if (!normalizedRoleName) throw new Error('请输入要测试的角色名。');
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error('初始好感必须是 0—100、最多一位小数。');
  }
  const settings = getGlobalSettings();
  const affection = getAffectionSettings(settings);
  const task = {
    buildRequestId: createBuildRequestId(),
    chatId: getContextInfo().chatId,
    messageId: -1,
    fingerprint: 'explicit-preview',
    roleName: normalizedRoleName,
    initialValueTenths: value,
    buildMode: 'custom',
    apiMode: affection.profileBuildApiMode,
  };
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let result = null;
  let requestMessages = [];
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile: null,
      resolveContextMaterial: resolveAffectionProfileContext,
      onMessagesReady: messages => {
        requestMessages = messages;
      },
    });
    const profileDraft = createProfileDraft(task, result.stages);
    logAffectionProfileBuild({
      task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      parsedResult: profileDraft,
    });
    return profileDraft;
  } catch (error) {
    logAffectionProfileBuild({
      task,
      status: 'failure',
      startedAt,
      startedMs,
      messages: result?.messages || requestMessages,
      apiResult: result?.apiResult || null,
      error,
    });
    throw error;
  }
}

function getAffectionPendingItem(store, messageId, fingerprint) {
  const bucket = store.pendingByMessage?.[String(Number(messageId))];
  return isPlainObject(bucket?.items?.[String(fingerprint || '').trim()])
    ? bucket.items[String(fingerprint || '').trim()]
    : null;
}

function markAffectionStoreUpdated(store, persist) {
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

export async function adjustAffectionProfileValue({
  roleName,
  targetValueTenths,
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const target = Number(targetValueTenths);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`未找到「${cleanRoleName}」的好感档案。`);
  if (!Number.isInteger(target) || target < 0 || target > 1000) {
    throw new Error('当前好感必须是 0—100、最多一位小数。');
  }
  const timestamp = formatTimestamp();
  const record = createManualAffectionAdjustmentRecord({
    initialValueTenths: profile.initialValueTenths,
    records: profile.records,
    targetValueTenths: target,
    recordId: `manual:${Date.now()}:${encodeURIComponent(cleanRoleName)}`,
    createdAt: timestamp,
  });
  if (!record) return { changed: false, profile };
  const ledger = recalculateAffectionLedger(
    profile.initialValueTenths,
    replaceAffectionRecord(profile.records, record),
  );
  store.profiles[cleanRoleName] = {
    ...profile,
    valueTenths: ledger.valueTenths,
    records: ledger.records,
    updatedAt: timestamp,
  };
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  getWorkflowOption('refreshPanel')?.();
  return { changed: true, profile: store.profiles[cleanRoleName], record };
}

export async function deleteAffectionProfile({ roleName } = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  if (!cleanRoleName || !isPlainObject(store.profiles?.[cleanRoleName])) return false;
  delete store.profiles[cleanRoleName];
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  getWorkflowOption('refreshPanel')?.();
  return true;
}

export async function applyAffectionProfileStages({
  roleName,
  stages,
  buildMode = 'custom',
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`未找到「${cleanRoleName}」的好感档案。`);
  const normalizedStages = normalizeAffectionProfileStages(stages);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  store.profiles[cleanRoleName] = {
    ...profile,
    valueTenths: ledger.valueTenths,
    records: ledger.records,
    stages: normalizedStages,
    buildMode: buildMode === 'generic' ? 'generic' : 'custom',
    buildStatus: 'ready',
    updatedAt: formatTimestamp(),
  };
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  getWorkflowOption('refreshPanel')?.();
  return store.profiles[cleanRoleName];
}

export async function regenerateAffectionProfileStages({
  roleName,
  userRequirement = '',
  apiMode = '',
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  requestCustomProfile = null,
  resolveContextMaterial = resolveAffectionProfileContext,
  log = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`未找到「${cleanRoleName}」的好感档案。`);
  const affection = getAffectionSettings(settings);
  const cleanApiMode = ['main_api', 'secondary_api'].includes(apiMode)
    ? apiMode
    : affection.profileBuildApiMode;
  const task = {
    operation: 'regenerate',
    buildRequestId: createBuildRequestId(),
    chatId: getContextInfo().chatId,
    messageId: -1,
    fingerprint: 'manual-regenerate',
    roleName: cleanRoleName,
    initialValueTenths: profile.initialValueTenths,
    buildMode: 'custom',
    apiMode: cleanApiMode,
    userRequirement: String(userRequirement || '').trim().slice(0, 2000),
  };
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let result = null;
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile,
      resolveContextMaterial,
    });
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      parsedResult: { roleName: cleanRoleName, stages: result.stages },
    });
    return {
      roleName: cleanRoleName,
      apiMode: cleanApiMode,
      userRequirement: task.userRequirement,
      stages: result.stages,
    };
  } catch (error) {
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'failure',
      startedAt,
      startedMs,
      messages: result?.messages || [],
      apiResult: result?.apiResult || null,
      error,
    });
    throw error;
  }
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
  getWorkflowOption('refreshPanel')?.();
  return task;
}

export function buildAffectionUpdatePromptSection(
  settings = getGlobalSettings(),
  chatState = getChatState(),
) {
  if (!isAffectionAnalysisActive(settings)) return '';
  const store = getAffectionSystemState(chatState);
  return buildAffectionUpdatePromptSectionText({
    knownAffectionText: buildKnownAffectionText(store.profiles),
    template: resolvePromptText(PROMPT_IDS.AFFECTION_UPDATE, settings),
  });
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
    getWorkflowOption('refreshPanel')?.();
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
    getWorkflowOption('refreshPanel')?.();
  }
  return summary;
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

export function registerAffectionWorkflowEvents() {
  registerPendingCommitHandler(
    AFFECTION_PENDING_COMMIT_HANDLER_ID,
    commitSelectedPendingAffectionUpdates,
  );
  affectionPendingCommitRegistered = true;
  if (affectionEventsRegistered) return true;
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
  return affectionPendingCommitRegistered;
}
