import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import { buildApiUrl } from '../../core/api.js';
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
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
  getOpenAiResponseContent,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import { getMessageContentFingerprint } from '../../core/message-fingerprint.js';
import {
  buildAffectionProfilePrompt,
  buildAffectionUpdatePromptSection as buildAffectionUpdatePromptSectionText,
  SUMMARY_SUPPORT_MESSAGES,
} from '../../prompts.js';
import {
  AFFECTION_STAGE_RANGES,
  clampAffectionValueTenths,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionFirstEntries,
  normalizeAffectionRoleName,
  recalculateAffectionLedger,
} from './model.js';

const AFFECTION_PROFILE_BUILD_TIMEOUT_MS = 180000;
const AFFECTION_PROFILE_BUILDING_MAX_AGE_MS = 5 * 60 * 1000;
const AFFECTION_BUILD_TASK_LIMIT = 60;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getGenerateRawFunction: null,
  refreshPanel: null,
};

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

function withAffectionBuildTimeout(promise) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('专属阶段表生成超时，请稍后重试。')),
      AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

function buildAffectionProfileMessages({ roleName, initialValueTenths, contextMaterial }) {
  return replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    {
      role: 'user',
      content: buildAffectionProfilePrompt({
        roleName,
        initialAffection: formatAffectionValueTenths(initialValueTenths),
        contextMaterial,
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

async function requestAffectionProfileMainApi(messages) {
  const generateRaw = getWorkflowOption('getGenerateRawFunction')?.();
  if (typeof generateRaw !== 'function') {
    throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
  }
  const requestBody = { prompt: messages };
  const responseText = await withAffectionBuildTimeout(
    Promise.resolve().then(() => generateRaw(requestBody)),
  );
  return {
    profileName: '酒馆当前连接',
    model: '酒馆主 API',
    url: '酒馆当前连接',
    requestBody,
    responseText: String(responseText || ''),
    rawContent: String(responseText || ''),
  };
}

async function requestAffectionProfileSecondaryApi(messages) {
  const profile = getWorkflowOption('getActiveApiProfile')?.(getGlobalSettings());
  if (!profile) throw new Error('当前环境未提供副 API 配置。');
  if (!String(profile.model || '').trim()) throw new Error('请先在设置页选择生成模型。');
  const url = buildApiUrl(profile);
  const requestBody = {
    model: String(profile.model).trim(),
    messages,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (String(profile.apiKey || '').trim()) {
    headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
  }
  const response = await withAffectionBuildTimeout(
    fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) }),
  );
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
  }
  return {
    profileName: profile.name || '未命名副 API',
    model: profile.model,
    url,
    httpStatus: `${response.status} ${response.statusText}`,
    requestBody,
    responseText,
    responseJson,
    rawContent: responseJson ? getOpenAiResponseContent(responseJson) : responseText,
  };
}

async function requestAffectionProfileStages({ messages, apiMode }) {
  return apiMode === 'main_api'
    ? requestAffectionProfileMainApi(messages)
    : requestAffectionProfileSecondaryApi(messages);
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
  getWorkflowOption('addCommunicationLog')?.({
    moduleName: task.apiMode === 'main_api' ? '好感度建档 / 主 API' : '好感度建档 / 副 API',
    taskType: task.buildMode === 'generic' ? '通用阶段表预建档' : '专属阶段表预建档',
    status,
    startedAt,
    durationMs: Math.round(performance.now() - startedMs),
    profileName: apiResult?.profileName || (task.apiMode === 'main_api' ? '酒馆当前连接' : ''),
    model: apiResult?.model || (task.apiMode === 'main_api' ? '酒馆主 API' : ''),
    url: apiResult?.url || (task.apiMode === 'main_api' ? '酒馆当前连接' : ''),
    httpStatus: apiResult?.httpStatus || '',
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
    responseText: apiResult?.responseText || '',
    rawResultContent: apiResult?.rawContent || '',
    parsedResult,
    errorStack: error?.stack || error?.message || error || '',
  });
}

async function executeCustomAffectionProfileBuild(task, {
  requestCustomProfile,
  resolveContextMaterial,
}) {
  const contextMaterial = await resolveContextMaterial(task.roleName);
  const messages = buildAffectionProfileMessages({
    roleName: task.roleName,
    initialValueTenths: task.initialValueTenths,
    contextMaterial,
  });
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
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile,
      resolveContextMaterial,
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
      messages: result?.messages || [],
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
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile: null,
      resolveContextMaterial: resolveAffectionProfileContext,
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
      messages: result?.messages || [],
      apiResult: result?.apiResult || null,
      error,
    });
    throw error;
  }
}

export function buildAffectionUpdatePromptSection(
  settings = getGlobalSettings(),
  chatState = getChatState(),
) {
  if (!isAffectionAnalysisActive(settings)) return '';
  const store = getAffectionSystemState(chatState);
  return buildAffectionUpdatePromptSectionText({
    knownAffectionText: buildKnownAffectionText(store.profiles),
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
  { messageId, fingerprint, analysis } = {},
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
    console.warn('[蜃灵助手] 本轮小总结未返回 affection / affection_first，已跳过好感 pending。');
    return null;
  }
  const fingerprint = getMessageContentFingerprint(messageId, settings);
  if (!fingerprint) return { ...prepared, pending: null, fingerprint: '' };
  const pending = storePendingAffectionUpdate(
    { messageId, fingerprint, analysis: prepared },
    { chatState, persist },
  );
  if (pending) {
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
