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
      enabled: false,
      renderMemory: false,
      renderGrandMemory: false,
      hideRawBlocks: false,
      rendererVersion: 1,
    },
    miniTheater: {
      apiMode: 'secondary_api',
      folders: [],
      prompts: [],
      styles: [],
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
    currentOutlineId: '',
    currentNodeId: '',
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
    activeScheduleId: '',
    drafts: [],
    entries: [],
    lastGeneratedAt: '',
    lastSavedAt: '',
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
  return settings.modules.chatBeautify;
}
