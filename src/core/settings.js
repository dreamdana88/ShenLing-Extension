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

export const defaultGlobalSettings = Object.freeze({
  schemaVersion: STORAGE_VERSION,
  enabled: true,
  theme: 'light',
  activeModule: 'summary',
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
      mode: 'ask_after_archive',
    },
    parallel: {
      enabled: false,
      triggerMode: 'manual_and_timed',
      thresholdMinutes: 60,
      appendToChat: true,
    },
    replace: getDefaultWordReplaceSettings(),
    emotionProfile: {
      enabled: false,
      autoAnalyze: false,
      injectEnabled: true,
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
    updatedAt: '',
  },
  memoir: {
    worldBookId: '',
    worldBookName: '',
    entryCount: 0,
  },
  parallel: {
    lastParallelEventTime: '',
    lastParallelEventMessageId: null,
  },
  emotionProfiles: {
    profiles: {},
    pendingByMessage: {},
    lastUpdatedAt: '',
    lastInjectedAt: '',
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
  context.extensionSettings[MODULE_NAME].schemaVersion = STORAGE_VERSION;

  return context.extensionSettings[MODULE_NAME];
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
  return state;
}

export function saveChatState() {
  const state = getChatState();
  state.diagnostics.lastSavedAt = formatTimestamp();

  const context = getContextSafe();
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
    chatState.schedule.current = isPlainObject(legacyCurrent) ? legacyCurrent : null;
  }

  if (isPlainObject(chatState.schedule.current)) {
    const current = chatState.schedule.current;
    current.title = String(current.title || '当前日程表');
    current.days = Array.isArray(current.days) ? current.days : [];
    current.days = current.days
      .filter(day => isPlainObject(day))
      .slice(0, 7)
      .map((day, index) => ({
        ...day,
        day: Number.isFinite(Number(day.day)) ? Number(day.day) : index + 1,
        label: String(day.label || `第${index + 1}天`),
        theme: String(day.theme || ''),
        mainOpportunity: String(day.mainOpportunity || ''),
        entryOptions: Array.isArray(day.entryOptions) ? day.entryOptions : [],
        characterMovements: Array.isArray(day.characterMovements) ? day.characterMovements : [],
        note: String(day.note || ''),
      }));
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

