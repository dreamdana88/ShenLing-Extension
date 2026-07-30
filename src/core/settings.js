import {
  CHAT_STATE_KEY,
  DEFAULT_SUMMARY_EXCLUDE_TAGS,
  DEFAULT_SUMMARY_INCLUDE_TAGS,
  MODULE_NAME,
  STORAGE_VERSION,
  SUMMARY_PROMPT_VERSION,
} from '../constants.js';
import {
  DEFAULT_GRAND_MEMORY_TEMPLATE,
  DEFAULT_MEMORY_PROMPT_TEMPLATE,
} from '../prompts.js';
import {
  createDefaultPromptOverrides,
  migrateLegacySummaryPromptSettings,
  normalizePromptOverrideSettings,
} from './prompt-overrides.js';
import {
  cloneData,
  formatTimestamp,
  getSummarySourceTags,
  isPlainObject,
  mergeDefaults,
} from '../utils/text.js';
import { getContextSafe } from './chat.js';
import {
  getDefaultWordReplaceSettings,
  normalizeReplacementRules,
  REPLACEMENT_DEFAULTS_VERSION,
} from '../features/word-replace/core.js';
import { normalizeScheduleCurrent } from '../features/schedule/model.js';
import { normalizeAffectionRoleName } from '../features/affection/model.js';

// ── 设定采集状态模型 ────────────────────────────────────────────────

// 设定采集持久化状态模型。保持纯数据职责，不读取 DOM、设置或世界书 API。

export const CAPTURE_TYPES = Object.freeze(['auto', 'npc', 'item', 'location', 'other']);
export const CAPTURE_SOURCE_MODES = Object.freeze(['recent_chat', 'floor_range', 'grand_plus_after']);
export const CAPTURE_POSITIONS = Object.freeze([
  'before_character_definition',
  'after_character_definition',
]);

const DRAFT_TYPES = CAPTURE_TYPES.filter(type => type !== 'auto');
const DEFAULT_RECENT_COUNT = 20;
const DEFAULT_ORDER = 100;

export function createDefaultCaptureState() {
  return {
    request: '',
    requestedType: 'auto',
    source: {
      mode: 'recent_chat',
      recentCount: DEFAULT_RECENT_COUNT,
      fromFloor: null,
      toFloor: null,
      summaryId: null,
    },
    optionalContext: {
      includeCharacterCard: false,
      includePersona: false,
      worldbookRefs: [],
    },
    drafts: [],
    lastError: '',
  };
}

export function createCaptureId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `capture-${globalThis.crypto.randomUUID()}`;
    }
  } catch {}
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12) || 'fallback';
  return `capture-${time}-${random}`;
}

function isCaptureStateObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCaptureId(value) {
  return typeof value === 'string'
    && /^capture-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function normalizeFiniteInteger(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalizeCaptureStateFloor(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
}

function normalizeWorldbookRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const refs = [];
  value.forEach((item) => {
    if (!isCaptureStateObject(item)) return;
    const worldbookName = String(item.worldbookName ?? '').trim();
    const uid = Number(item.uid);
    if (!worldbookName || !Number.isInteger(uid) || uid < 0) return;
    const key = `${worldbookName}\u0000${uid}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      worldbookName,
      uid,
      entryNameSnapshot: String(item.entryNameSnapshot ?? '').trim(),
    });
  });
  return refs;
}

export function normalizeCaptureDraft(value) {
  const draft = isCaptureStateObject(value) ? value : {};
  const type = DRAFT_TYPES.includes(draft.type) ? draft.type : 'other';
  const position = CAPTURE_POSITIONS.includes(draft.position)
    ? draft.position
    : 'after_character_definition';
  return {
    captureId: isCaptureId(draft.captureId) ? draft.captureId : createCaptureId(),
    type,
    title: String(draft.title ?? '').trim(),
    mainKeywords: normalizeKeywords(draft.mainKeywords),
    filterKeywords: normalizeKeywords(draft.filterKeywords),
    content: String(draft.content ?? '').trim(),
    position,
    order: normalizeFiniteInteger(draft.order, DEFAULT_ORDER),
  };
}

export function normalizeCaptureState(value) {
  const state = isCaptureStateObject(value) ? value : {};
  const source = isCaptureStateObject(state.source) ? state.source : {};
  const optionalContext = isCaptureStateObject(state.optionalContext) ? state.optionalContext : {};
  const recentCount = normalizeFiniteInteger(source.recentCount, DEFAULT_RECENT_COUNT);
  return {
    request: String(state.request ?? ''),
    requestedType: CAPTURE_TYPES.includes(state.requestedType) ? state.requestedType : 'auto',
    source: {
      mode: CAPTURE_SOURCE_MODES.includes(source.mode) ? source.mode : 'recent_chat',
      recentCount: Math.min(200, Math.max(5, recentCount)),
      fromFloor: normalizeCaptureStateFloor(source.fromFloor),
      toFloor: normalizeCaptureStateFloor(source.toFloor),
      summaryId: typeof source.summaryId === 'string' ? source.summaryId : null,
    },
    optionalContext: {
      includeCharacterCard: optionalContext.includeCharacterCard === true,
      includePersona: optionalContext.includePersona === true,
      worldbookRefs: normalizeWorldbookRefs(optionalContext.worldbookRefs),
    },
    drafts: Array.isArray(state.drafts) ? state.drafts.map(normalizeCaptureDraft) : [],
    lastError: String(state.lastError ?? ''),
  };
}

export function appendCaptureDrafts(existing, incoming) {
  const current = Array.isArray(existing) ? existing.map(normalizeCaptureDraft) : [];
  const knownIds = new Set(current.map(draft => draft.captureId));
  const additions = [];
  (Array.isArray(incoming) ? incoming : []).forEach((value) => {
    const draft = normalizeCaptureDraft(value);
    if (knownIds.has(draft.captureId)) return;
    knownIds.add(draft.captureId);
    additions.push(draft);
  });
  return [...current, ...additions];
}

export function removeCaptureDrafts(existing, captureIds) {
  const ids = captureIds instanceof Set
    ? captureIds
    : new Set(Array.isArray(captureIds) ? captureIds : []);
  return (Array.isArray(existing) ? existing : [])
    .map(normalizeCaptureDraft)
    .filter(draft => !ids.has(draft.captureId));
}

export function clearCaptureDrafts() {
  return [];
}

export const defaultGlobalSettings = Object.freeze({
  schemaVersion: STORAGE_VERSION,
  enabled: true,
  theme: 'light',
  activeModule: 'summary',
  promptOverrides: createDefaultPromptOverrides(),
  ui: {
    lastOpenedAt: '',
    sourceRulesCollapsed: true,
    showFloatingButton: true,
    floatingButtonPosition: {
      desktop: null,
      mobile: null,
    },
  },
  modules: {
    summary: {
      enabled: false,
      autoGrandMemoryEnabled: false,
      grandMemoryInterval: 6,
      autoTotalGrandMemoryEnabled: false,
      totalGrandMemoryInterval: 5,
      legacyArchiveBatchSize: '',
      includeUserInput: false,
      intervalMessages: 1,
      sourceTags: {
        includeTags: [...DEFAULT_SUMMARY_INCLUDE_TAGS],
        excludeTags: [...DEFAULT_SUMMARY_EXCLUDE_TAGS],
      },
      promptTemplateVersion: SUMMARY_PROMPT_VERSION,
      grandPromptTemplate: DEFAULT_GRAND_MEMORY_TEMPLATE,
      promptTemplate: DEFAULT_MEMORY_PROMPT_TEMPLATE,
    },
    memoir: {
      enabled: false,
      apiMode: 'secondary_api',
    },
    replace: getDefaultWordReplaceSettings(),
    emotionProfile: {
      enabled: false,
      autoAnalyze: false,
      injectEnabled: true,
    },
    affection: {
      enabled: false,
      mode: 'normal',
      defaultBuildMode: 'custom',
      profileBuildApiMode: 'secondary_api',
    },
    chatBeautify: {
      enabled: true,
      theme: 'light',
      renderMemory: true,
      renderGrandMemory: false,
      showRawAlongside: false,
      rendererVersion: 2,
    },
    miniTheater: {
      apiMode: 'secondary_api',
      folders: [],
      prompts: [],
      styles: [],
    },
    plotOutline: {
      apiMode: 'secondary_api',
      chapterCount: 'auto',
    },
    schedule: {
      apiMode: 'secondary_api',
    },
  },
  communicationLog: {
    maxEntries: 10,
    entries: [],
  },
  api: {
    mode: 'secondary_api',
    activeProfileId: 'default',
    lastTestAt: '',
    lastTestStatus: '',
    profiles: [
      {
        id: 'default',
        name: '默认副 API',
        baseUrl: '',
        apiKey: '',
        model: '',
        endpointPath: '/v1/chat/completions',
        availableModels: [],
      },
    ],
  },
  diagnostics: {
    globalProbe: '',
    lastSavedAt: '',
  },
});

export const defaultChatState = Object.freeze({
  schemaVersion: STORAGE_VERSION,
  identity: {
    characterId: '',
    characterName: '',
    chatId: '',
    chatName: '',
  },
  summary: {
    smallSummaryCount: 0,
    memoryCountSinceArchive: 0,
    memoryCountedMessageIds: [],
    processedMessageFingerprints: {},
    lastSummaryMessageId: null,
    lastGrandSummaryMessageId: null,
    lastArchivedMessageId: null,
    lastSummaryAt: '',
    lastArchiveId: '',
    archiveRecords: [],
    legacyArchiveStatus: {
      phase: 'idle',
      totalMessages: 0,
      batchSize: 30,
      batchTotal: 0,
      batchIndex: 0,
      lastResult: '',
    },
    runningTask: 'none',
    lastError: '',
    confirmedTasks: [],
  },
  outline: {
    enabled: false,
    userDirection: '',
    storyCore: {
      logline: '',
      conflict: '',
      tone: '',
    },
    chapters: [],
    currentChapterId: '',
    progress: {},
    progressSources: {},
    updatedAt: '',
  },
  memoir: {
    worldbookId: '',        // 绑定的回忆录世界书名（TavernHelper 世界书名即 id）
    worldbookName: '',       // 展示名，通常同 worldbookId
    prevBoundName: '',       // 切换到蜃灵专属书前的原绑定名；原书不删除
    overviewUid: null,       // 兼容预留字段；当前蓝灯按 name/extra 定位
    bindingDecision: null,   // { chatId, worldbookName, mode:'reuse'|'dedicated', confirmedAt }
    sourceProcessed: [],     // 已处理的大总结标识列表，避免同源重复提炼
    entries: [],             // 已写入绿灯条目索引：{ memoirId, title, digest, storyTime, importance, participants, mainKeywords, filterKeywords, uid, createdAt, updatedAt }
    pending: null,           // 待确认批次：{ sourceKey, sourceKeys:[], candidates:[], generatedAt }；新批次追加而非覆盖
    capture: createDefaultCaptureState(), // 用户主动发起的设定采集表单与草稿；与 pending 独立
    updatedAt: '',
  },
  emotionProfiles: {
    profiles: {},
    pendingByMessage: {},
    lastUpdatedAt: '',
    lastInjectedAt: '',
  },
  affectionSystem: {
    profiles: {},
    pendingByMessage: {},
    buildTasks: {},
  },
  schedule: {
    current: null,
    lastGeneratedAt: '',
  },
  diary: {
    activeBookId: '',
    books: [],
    entries: [],
    lastGeneratedAt: '',
    lastSavedAt: '',
  },
  miniTheater: {
    results: [],
    lastGeneratedAt: '',
  },
  diagnostics: {
    chatProbe: '',
    lastSavedAt: '',
  },
});

export const CONFIRMED_SUMMARY_TASK_STATUSES = Object.freeze([
  'PENDING',
  'RUNNING',
  'SUMMARIZED',
  'FAILED',
  'CANCELLED',
]);

function normalizeConfirmedTaskMessageId(value) {
  const messageId = Number(value);
  return Number.isInteger(messageId) && messageId >= 0 ? messageId : null;
}

function normalizeConfirmedTaskFingerprint(value) {
  const fingerprint = String(value ?? '').trim();
  return /^[0-9]+:[0-9]+$/.test(fingerprint) ? fingerprint : '';
}

function normalizeConfirmedTaskTimestamp(value) {
  return String(value ?? '').trim().slice(0, 64);
}

function normalizeConfirmedTaskStatus(value) {
  if (value === 'RUNNING') return 'PENDING';
  return CONFIRMED_SUMMARY_TASK_STATUSES.includes(value) ? value : 'CANCELLED';
}

export function normalizeConfirmedSummaryTasks(value) {
  if (!Array.isArray(value)) return [];

  const taskKeys = new Set();
  const tasks = [];
  value.forEach(rawTask => {
    if (!isPlainObject(rawTask)) return;
    const taskKey = String(rawTask.taskKey ?? '').trim();
    const chatIdentity = String(rawTask.chatIdentity ?? '').trim();
    const originalMessageId = normalizeConfirmedTaskMessageId(rawTask.originalMessageId);
    const confirmingUserMessageId = normalizeConfirmedTaskMessageId(rawTask.confirmingUserMessageId);
    const assistantFingerprint = normalizeConfirmedTaskFingerprint(rawTask.assistantFingerprint);
    const confirmingUserFingerprint = normalizeConfirmedTaskFingerprint(rawTask.confirmingUserFingerprint);
    const selectedSwipeId = normalizeConfirmedTaskMessageId(rawTask.selectedSwipeId);
    if (
      !taskKey
      || taskKeys.has(taskKey)
      || !chatIdentity
      || originalMessageId === null
      || confirmingUserMessageId === null
      || selectedSwipeId === null
      || !assistantFingerprint
      || !confirmingUserFingerprint
    ) return;

    taskKeys.add(taskKey);
    tasks.push({
      taskKey,
      chatIdentity,
      originalMessageId,
      assistantFingerprint,
      selectedSwipeId,
      confirmingUserMessageId,
      confirmingUserFingerprint,
      status: normalizeConfirmedTaskStatus(rawTask.status),
      createdAt: normalizeConfirmedTaskTimestamp(rawTask.createdAt),
      updatedAt: normalizeConfirmedTaskTimestamp(rawTask.updatedAt),
    });
  });
  return tasks;
}

export function getConfirmedSummaryTasks(chatState = getChatState()) {
  if (!isPlainObject(chatState.summary)) {
    chatState.summary = cloneData(defaultChatState.summary);
  }
  chatState.summary = mergeDefaults(chatState.summary, cloneData(defaultChatState.summary));
  chatState.summary.confirmedTasks = normalizeConfirmedSummaryTasks(chatState.summary.confirmedTasks);
  return chatState.summary.confirmedTasks;
}

export function getContextInfo() {
  const context = getContextSafe();
  const characterId = String(
    context?.characterId
      ?? context?.this_chid
      ?? context?.chid
      ?? context?.character?.avatar
      ?? '',
  );
  const chatId = String(
    context?.chatId
      ?? context?.chatMetadata?.name
      ?? context?.chat?.[0]?.extra?.chat_id
      ?? '',
  );

  return {
    characterId,
    characterName: context?.name2 || context?.character?.name || '未读取',
    chatId,
    chatName: context?.chatMetadata?.name || chatId || '未读取',
  };
}

export function getGlobalSettings() {
  const context = getContextSafe();
  if (!context?.extensionSettings) {
    return cloneData(defaultGlobalSettings);
  }

  context.extensionSettings[MODULE_NAME] = mergeDefaults(
    context.extensionSettings[MODULE_NAME],
    cloneData(defaultGlobalSettings),
  );
  const settings = context.extensionSettings[MODULE_NAME];
  settings.schemaVersion = STORAGE_VERSION;
  if (isPlainObject(settings.modules)) delete settings.modules.parallel;
  if (settings.activeModule === 'parallel') settings.activeModule = 'summary';
  normalizePromptOverrideSettings(settings);
  const migratedPrompts = migrateLegacySummaryPromptSettings(settings, {
    memoryDefault: DEFAULT_MEMORY_PROMPT_TEMPLATE,
    grandDefault: DEFAULT_GRAND_MEMORY_TEMPLATE,
  });
  if (migratedPrompts) {
    getContextSafe()?.saveSettingsDebounced?.();
  }

  return settings;
}

export function saveGlobalSettings() {
  const settings = getGlobalSettings();
  settings.diagnostics.lastSavedAt = formatTimestamp();
  getContextSafe()?.saveSettingsDebounced?.();
}

export function getChatState() {
  const context = getContextSafe();
  const info = getContextInfo();

  if (!context?.chatMetadata) {
    const fallback = cloneData(defaultChatState);
    fallback.identity = info;
    return fallback;
  }

  context.chatMetadata[CHAT_STATE_KEY] = mergeDefaults(
    context.chatMetadata[CHAT_STATE_KEY],
    cloneData(defaultChatState),
  );

  const state = context.chatMetadata[CHAT_STATE_KEY];
  state.schemaVersion = STORAGE_VERSION;
  state.identity = info;
  delete state.parallel;
  return state;
}

export function saveChatState() {
  const state = getChatState();
  state.diagnostics.lastSavedAt = formatTimestamp();

  const context = getContextSafe();
  // 无 chatMetadata（尚无激活聊天）时不要触发 saveMetadata，否则 ST 会弹“聊天无法保存”。
  if (!context?.chatMetadata) {
    return;
  }
  if (typeof context?.saveMetadataDebounced === 'function') {
    context.saveMetadataDebounced();
  } else {
    context?.saveSettingsDebounced?.();
  }
}

export function getStorageDiagnostics() {
  const context = getContextSafe();
  const settings = getGlobalSettings();
  const chatState = getChatState();

  return {
    globalKey: MODULE_NAME,
    chatKey: CHAT_STATE_KEY,
    hasExtensionSettings: Boolean(context?.extensionSettings),
    hasChatMetadata: Boolean(context?.chatMetadata),
    canSaveGlobal: typeof context?.saveSettingsDebounced === 'function',
    canSaveChat: typeof context?.saveMetadataDebounced === 'function',
    globalLastSavedAt: settings.diagnostics.lastSavedAt || '尚未保存',
    chatLastSavedAt: chatState.diagnostics.lastSavedAt || '尚未保存',
    globalProbe: settings.diagnostics.globalProbe || '尚未写入',
    chatProbe: chatState.diagnostics.chatProbe || '尚未写入',
  };
}

export function getDefaultSummaryPromptTemplate() {
  return DEFAULT_MEMORY_PROMPT_TEMPLATE;
}

export function getDefaultGrandMemoryPromptTemplate() {
  return DEFAULT_GRAND_MEMORY_TEMPLATE;
}

export function shouldResetSummaryPromptTemplate(summary) {
  const prompt = String(summary.promptTemplate || '');
  return (
    summary.promptTemplateVersion !== SUMMARY_PROMPT_VERSION ||
    prompt.includes('请为以下最新剧情生成一段简洁的小总结') ||
    prompt.includes('<psychology>') ||
    prompt.includes('<list>') ||
    !prompt.includes('##浓缩梦境') ||
    !prompt.includes('[number:')
  );
}

export function shouldResetGrandMemoryPromptTemplate(summary) {
  const prompt = String(summary.grandPromptTemplate || '');
  return (
    !prompt.includes('[volume:') ||
    !prompt.includes('[chronicle:') ||
    !prompt.includes('[arc:') ||
    !prompt.includes('[faction:')
  );
}

export function getSummarySettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = cloneData(defaultGlobalSettings.modules);
  }
  settings.modules.summary = mergeDefaults(
    settings.modules.summary,
    cloneData(defaultGlobalSettings.modules.summary),
  );
  const summary = settings.modules.summary;
  delete summary.startMessageId;
  if (shouldResetSummaryPromptTemplate(summary)) {
    summary.promptTemplate = getDefaultSummaryPromptTemplate();
    summary.promptTemplateVersion = SUMMARY_PROMPT_VERSION;
    getContextSafe()?.saveSettingsDebounced?.();
  }
  if (shouldResetGrandMemoryPromptTemplate(summary)) {
    summary.grandPromptTemplate = getDefaultGrandMemoryPromptTemplate();
    getContextSafe()?.saveSettingsDebounced?.();
  }
  getSummarySourceTags(summary);
  return summary;
}

export function getEmotionProfileSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = {};
  }
  settings.modules.emotionProfile = mergeDefaults(
    settings.modules.emotionProfile,
    cloneData(defaultGlobalSettings.modules.emotionProfile),
  );
  return settings.modules.emotionProfile;
}

export function getAffectionSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = {};
  }

  const source = isPlainObject(settings.modules.affection)
    ? settings.modules.affection
    : {};
  const legacyModeOff = source.mode === 'off';
  const mode = ['normal', 'reverse'].includes(source.mode) ? source.mode : 'normal';
  const defaultBuildModeSource = source.defaultBuildMode ?? source.buildMode;
  const profileBuildApiModeSource = source.profileBuildApiMode ?? source.apiMode;

  settings.modules.affection = {
    enabled: legacyModeOff ? false : source.enabled === true,
    mode,
    defaultBuildMode: ['custom', 'generic'].includes(defaultBuildModeSource)
      ? defaultBuildModeSource
      : 'custom',
    profileBuildApiMode: ['secondary_api', 'main_api'].includes(profileBuildApiModeSource)
      ? profileBuildApiModeSource
      : 'secondary_api',
  };
  return settings.modules.affection;
}

export function getAffectionProfileKey(roleName) {
  return normalizeAffectionRoleName(roleName);
}

function normalizeAffectionProfiles(value) {
  const entries = Array.isArray(value)
    ? value.map(profile => [profile?.roleName || '', profile])
    : isPlainObject(value)
      ? Object.entries(value)
      : [];
  const profiles = {};

  entries.forEach(([storedKey, profile]) => {
    if (!isPlainObject(profile)) return;
    const roleName = getAffectionProfileKey(profile.roleName || storedKey);
    if (!roleName || Object.hasOwn(profiles, roleName)) return;
    profiles[roleName] = {
      ...profile,
      roleName,
    };
  });
  return profiles;
}

export function getAffectionSystemState(chatState = getChatState()) {
  const source = isPlainObject(chatState.affectionSystem)
    ? chatState.affectionSystem
    : {};
  chatState.affectionSystem = {
    profiles: normalizeAffectionProfiles(source.profiles),
    pendingByMessage: isPlainObject(source.pendingByMessage) ? source.pendingByMessage : {},
    buildTasks: isPlainObject(source.buildTasks) ? source.buildTasks : {},
  };
  return chatState.affectionSystem;
}

export function getWordReplaceSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = cloneData(defaultGlobalSettings.modules);
  }
  settings.modules.replace = mergeDefaults(
    settings.modules.replace,
    cloneData(defaultGlobalSettings.modules.replace),
  );

  const replace = settings.modules.replace;
  replace.rules = normalizeReplacementRules(replace.rules, replace.defaultsVersion);
  replace.defaultsVersion = REPLACEMENT_DEFAULTS_VERSION;
  if (!isPlainObject(replace.expandedGroups)) {
    replace.expandedGroups = cloneData(defaultGlobalSettings.modules.replace.expandedGroups);
  }
  replace.importCollapsed = replace.importCollapsed !== false;
  return replace;
}

export function getChatBeautifySettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = {};
  }
  settings.modules.chatBeautify = mergeDefaults(
    settings.modules.chatBeautify,
    cloneData(defaultGlobalSettings.modules.chatBeautify),
  );
  const chatBeautify = settings.modules.chatBeautify;
  if (Number(chatBeautify.rendererVersion || 0) < 2) {
    chatBeautify.enabled = true;
    chatBeautify.renderMemory = true;
    chatBeautify.showRawAlongside = false;
    delete chatBeautify.hideRawBlocks;
    chatBeautify.rendererVersion = 2;
  }
  if (!['light', 'dark'].includes(chatBeautify.theme)) {
    chatBeautify.theme = 'light';
  }
  return settings.modules.chatBeautify;
}

export function getPlotOutlineSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = {};
  }
  settings.modules.plotOutline = mergeDefaults(
    settings.modules.plotOutline,
    cloneData(defaultGlobalSettings.modules.plotOutline),
  );
  const plotOutline = settings.modules.plotOutline;
  if (!['secondary_api', 'main_api'].includes(plotOutline.apiMode)) {
    plotOutline.apiMode = 'secondary_api';
  }
  if (!['auto', '4', '5', '6', '8'].includes(String(plotOutline.chapterCount))) {
    plotOutline.chapterCount = 'auto';
  }
  return plotOutline;
}

export function getScheduleSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = {};
  }
  settings.modules.schedule = mergeDefaults(
    settings.modules.schedule,
    cloneData(defaultGlobalSettings.modules.schedule),
  );
  const schedule = settings.modules.schedule;
  if (!['secondary_api', 'main_api'].includes(schedule.apiMode)) {
    schedule.apiMode = 'secondary_api';
  }
  return schedule;
}

export function getMemoirSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = {};
  }
  settings.modules.memoir = mergeDefaults(
    settings.modules.memoir,
    cloneData(defaultGlobalSettings.modules.memoir),
  );
  const memoir = settings.modules.memoir;
  memoir.enabled = memoir.enabled === true;
  if (!['secondary_api', 'main_api'].includes(memoir.apiMode)) {
    memoir.apiMode = 'secondary_api';
  }
  return memoir;
}

export function getMemoirState(chatState = getChatState()) {
  if (!isPlainObject(chatState.memoir)) {
    chatState.memoir = cloneData(defaultChatState.memoir);
  }
  chatState.memoir = mergeDefaults(chatState.memoir, cloneData(defaultChatState.memoir));
  if (!Array.isArray(chatState.memoir.sourceProcessed)) {
    chatState.memoir.sourceProcessed = [];
  }
  if (!Array.isArray(chatState.memoir.entries)) {
    chatState.memoir.entries = [];
  }
  if (chatState.memoir.pending !== null && !isPlainObject(chatState.memoir.pending)) {
    chatState.memoir.pending = null;
  }
  if (chatState.memoir.bindingDecision !== null && !isPlainObject(chatState.memoir.bindingDecision)) {
    chatState.memoir.bindingDecision = null;
  }
  chatState.memoir.capture = normalizeCaptureState(chatState.memoir.capture);
  return chatState.memoir;
}

export function getPlotOutlineState(chatState = getChatState()) {
  if (!isPlainObject(chatState.outline)) {
    chatState.outline = cloneData(defaultChatState.outline);
  }
  chatState.outline = mergeDefaults(chatState.outline, cloneData(defaultChatState.outline));
  if (!Array.isArray(chatState.outline.chapters)) {
    chatState.outline.chapters = [];
  }
  if (!isPlainObject(chatState.outline.progress)) {
    chatState.outline.progress = {};
  }
  if (!isPlainObject(chatState.outline.progressSources)) {
    chatState.outline.progressSources = {};
  }
  if (Object.keys(chatState.outline.progressSources).length === 0) {
    Object.entries(chatState.outline.progress).forEach(([chapterId, chapterProgress]) => {
      if (!isPlainObject(chapterProgress)) return;
      Object.entries(chapterProgress).forEach(([conditionId, done]) => {
        if (!done) return;
        chatState.outline.progressSources[`legacy:${chapterId}:${conditionId}`] = {
          source: 'legacy',
          chapterId,
          conditionIds: [conditionId],
          updatedAt: chatState.outline.updatedAt || '',
        };
      });
    });
  }
  if (!isPlainObject(chatState.outline.storyCore)) {
    chatState.outline.storyCore = cloneData(defaultChatState.outline.storyCore);
  }
  return chatState.outline;
}

export function getScheduleState(chatState = getChatState()) {
  if (!isPlainObject(chatState.schedule)) {
    chatState.schedule = cloneData(defaultChatState.schedule);
  }
  chatState.schedule = mergeDefaults(chatState.schedule, cloneData(defaultChatState.schedule));

  if (!isPlainObject(chatState.schedule.current)) {
    const legacyEntries = Array.isArray(chatState.schedule.entries) ? chatState.schedule.entries : [];
    const activeId = String(chatState.schedule.activeScheduleId || '');
    const legacyCurrent = legacyEntries.find(item => isPlainObject(item) && String(item.id || '') === activeId)
      || legacyEntries.find(item => isPlainObject(item));
    chatState.schedule.current = isPlainObject(legacyCurrent) && Array.isArray(legacyCurrent.days) && legacyCurrent.days.length
      ? legacyCurrent
      : null;
  }

  if (isPlainObject(chatState.schedule.current)) {
    chatState.schedule.current = normalizeScheduleCurrent(chatState.schedule.current);
  } else {
    chatState.schedule.current = null;
  }

  delete chatState.schedule.activeScheduleId;
  delete chatState.schedule.drafts;
  delete chatState.schedule.entries;
  delete chatState.schedule.lastSavedAt;

  chatState.schedule.lastGeneratedAt = String(chatState.schedule.lastGeneratedAt || '');
  return chatState.schedule;
}
