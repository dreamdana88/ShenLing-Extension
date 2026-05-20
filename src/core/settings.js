import {
  CHAT_STATE_KEY,
  DEFAULT_GRAND_MEMORY_TEMPLATE,
  DEFAULT_SUMMARY_EXCLUDE_TAGS,
  DEFAULT_SUMMARY_INCLUDE_TAGS,
  MODULE_NAME,
  STORAGE_VERSION,
  SUMMARY_PROMPT_VERSION,
} from '../constants.js';
import {
  cloneData,
  formatTimestamp,
  mergeDefaults,
} from '../utils/text.js';
import { getContextSafe } from './chat.js';

export const defaultGlobalSettings = Object.freeze({
  schemaVersion: STORAGE_VERSION,
  enabled: true,
  theme: 'light',
  activeModule: 'summary',
  ui: {
    lastOpenedAt: '',
    sourceRulesCollapsed: true,
  },
  modules: {
    summary: {
      enabled: false,
      autoGrandMemoryEnabled: false,
      grandMemoryInterval: 6,
      legacyArchiveBatchSize: '',
      includeUserInput: false,
      intervalMessages: 1,
      sourceTags: {
        includeTags: [...DEFAULT_SUMMARY_INCLUDE_TAGS],
        excludeTags: [...DEFAULT_SUMMARY_EXCLUDE_TAGS],
      },
      promptTemplateVersion: SUMMARY_PROMPT_VERSION,
      grandPromptTemplate: DEFAULT_GRAND_MEMORY_TEMPLATE,
      promptTemplate: [
        '##浓缩梦境',
        '',
        '必须输出<memory>结构化总结，并严格使用以下格式进行封装：',
        '',
        '<memory>',
        '<number>',
        '自然顺序编号，如 `1`、`2`，承接上轮递增。',
        '</number>',
        '',
        '<worldstate>',
        '时间：${精确日期 + 当前时段}',
        '地点：${所在地点}',
        '人物：${列举在场角色}',
        '</worldstate>',
        '',
        '<currentTask>',
        '一句话简述当前主线目标',
        '</currentTask>',
        '',
        '<plot>',
        '以自然语言用第三人称客观梳理总结本轮演出剧情 (200 token)，必须包含：用户输入内容、关键事件/情节进展、重要互动、情绪变化、特殊世界规则发现或剧情推进。',
        '{{user}}：${本次正文中1句最重要台词(可无)}',
        '主要角色：${本次正文中1句最重要台词(可无)}',
        '</plot>',
        '',
        '<psychology>',
        '（非{{user}}主要角色情感变化）：',
        '${角色名}',
        '- 情感分层：{(日常/深入/高峰)简要描述+变化方向}',
        '- 情感关系：{人物关系的变化倾向(30字)}',
        '</psychology>',
        '',
        '<list>',
        '根据非{{user}}角色的人设、职业背景、生活作息等，简要列出角色当天全部日程表与行动安排（至就寝），随时间推进进行check',
        '',
        '格式:',
        '${日期}-${角色名}',
        '${早/中/晚}:${序号}.${日程安排内容} ${预期完成时间（x时-y时）}',
        '隐私:${想隐藏的秘密}',
        '好奇:${想探究的好奇}',
        '当前目标:${一句话简述近期要达成的目标}',
        '</list>',
        '',
        '<database>',
        '- 重要物品/概念解锁:',
        '记录本轮中首次出现的、重要的物品或概念。',
        '</database>',
        '</memory>',
        '',
        '重要：<memory>内容应足够独立，即使没有正文，也能让人了解故事发展。总字数不超过400字。',
      ].join('\n'),
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
