import {
  extractSummarySourceContent,
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  getChatState,
  getEmotionProfileSettings,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getContextSafe,
  getChatMessageById,
} from '../../core/chat.js';
import {
  getMemoryField,
  getMemoryFields,
  normalizeMemoryBlock,
  parsePipeFields,
  stripMemoryBlock,
} from '../../core/summary.js';
import {
  buildEmotionUpdatePromptSection as buildEmotionUpdatePromptSectionText,
  buildLegacyArchiveEmotionUpdatePromptSection as buildLegacyArchiveEmotionUpdatePromptSectionText,
} from '../../prompts.js';

const EMOTION_PROFILE_PROMPT_ID = 'shenling_assistant_emotion_profile_state';
const PSYCHOLOGY_BLOCK_RE = /<psychology>[\s\S]*?<\/psychology>/gi;
const LIST_BLOCK_RE = /<list>[\s\S]*?<\/list>/gi;
const emotionEventStops = [];
let emotionEventsRegistered = false;

let workflowOptions = {
  notify: null,
  refreshPanel: null,
};

export function configureEmotionProfileWorkflow(options = {}) {
  workflowOptions = {
    ...workflowOptions,
    ...options,
  };
}

function notifyEmotion(type, message, title = '情感档案') {
  if (typeof workflowOptions.notify === 'function') {
    workflowOptions.notify(type, message, title);
    return;
  }
  const toastr = globalThis.toastr || globalThis.parent?.toastr;
  if (toastr && typeof toastr[type] === 'function') {
    toastr[type](message, title);
    return;
  }
  const logger = type === 'error' ? console.error : console.info;
  logger(`[蜃灵助手] ${title}：${message}`);
}

function refreshPanel() {
  if (typeof workflowOptions.refreshPanel === 'function') {
    workflowOptions.refreshPanel();
  }
}

function getEmotionProfileStore(chatState = getChatState()) {
  if (!isPlainObject(chatState.emotionProfiles)) {
    chatState.emotionProfiles = {};
  }
  if (!isPlainObject(chatState.emotionProfiles.profiles)) {
    chatState.emotionProfiles.profiles = {};
  }
  if (!isPlainObject(chatState.emotionProfiles.pendingByMessage)) {
    chatState.emotionProfiles.pendingByMessage = {};
  }
  return chatState.emotionProfiles;
}

function normalizeRoleName(value) {
  return String(value || '').trim();
}

function getLatestRecord(profile) {
  return Array.isArray(profile?.records) ? profile.records.at(-1) || null : null;
}

function getRecordField(record, fields) {
  if (!isPlainObject(record)) return '';
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function createEmotionFingerprint(content) {
  let hash = 0;
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${text.length}:${Math.abs(hash)}`;
}

function parseBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeProfileItems(parsed) {
  const items = Array.isArray(parsed?.profiles)
    ? parsed.profiles
    : Array.isArray(parsed?.characters)
      ? parsed.characters
      : Array.isArray(parsed?.updates)
        ? parsed.updates
        : [];

  return items
    .filter(item => isPlainObject(item))
    .map(item => {
      const roleName = normalizeRoleName(item.roleName || item.character || item.name || item.role);
      if (!roleName) return null;
      return {
        roleName,
        currentStatus: String(item.currentStatus || item.currentState || item.status || item.summary || '').trim(),
        changeSummary: String(item.changeSummary || item.change || item.summary || '').trim(),
        relationshipToUser: String(item.relationshipToUser || item.relationship || '').trim(),
      };
    })
    .filter(Boolean)
    .filter(item => item.currentStatus || item.changeSummary || item.relationshipToUser);
}

function parseEmotionUpdateFromBracketLines(text) {
  const wrappedText = normalizeMemoryBlock(text);
  const changedText = getMemoryField(wrappedText, 'emotion_changed');
  if (!changedText) return null;

  const changed = parseBooleanFlag(changedText);
  const profiles = changed
    ? getMemoryFields(wrappedText, 'emotion')
      .map(value => {
        const [roleName, relationshipToUser, currentStatus, changeSummary] = parsePipeFields(value, 4);
        const normalizedRoleName = normalizeRoleName(roleName);
        if (!normalizedRoleName) return null;
        return {
          roleName: normalizedRoleName,
          currentStatus: String(currentStatus || '').trim(),
          changeSummary: String(changeSummary || '').trim(),
          relationshipToUser: String(relationshipToUser || '').trim(),
        };
      })
      .filter(Boolean)
      .filter(item => item.currentStatus || item.changeSummary || item.relationshipToUser)
    : [];

  return { changed, profiles };
}

function buildKnownProfilesSection(store) {
  const profiles = Object.entries(store.profiles || {})
    .filter(([, profile]) => isPlainObject(profile))
    .map(([roleName, profile]) => {
      const latest = getLatestRecord(profile);
      const status = getRecordField(latest, ['currentStatus', 'currentState', 'status', 'summary'])
        || getRecordField(profile, ['currentStatus', 'currentState', 'summary'])
        || '尚未整理';
      return `- ${profile.name || roleName}：${status}`;
    });
  return profiles.length ? profiles.join('\n') : '暂无。';
}

function sanitizeMemoryForEmotionAnalysis(memory) {
  return String(memory || '')
    .replace(PSYCHOLOGY_BLOCK_RE, '')
    .replace(LIST_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getMessageEmotionFingerprint(messageId, settings = getGlobalSettings()) {
  const message = getChatMessageById(Number(messageId));
  if (!message || message.role !== 'assistant') return '';
  const body = stripMemoryBlock(String(message.message || ''));
  const aiContent = extractSummarySourceContent(body, getSummarySettings(settings)).trim();
  return aiContent ? createEmotionFingerprint(aiContent) : '';
}

function normalizePendingBucket(store, messageId) {
  const key = String(Number(messageId));
  if (!isPlainObject(store.pendingByMessage[key])) {
    store.pendingByMessage[key] = {
      messageId: Number(messageId),
      items: {},
      updatedAt: '',
    };
  }
  if (!isPlainObject(store.pendingByMessage[key].items)) {
    store.pendingByMessage[key].items = {};
  }
  return store.pendingByMessage[key];
}

function storePendingEmotionUpdate({ messageId, fingerprint, changed, updates, raw }) {
  const numericMessageId = Number(messageId);
  const cleanFingerprint = String(fingerprint || '').trim();
  if (!Number.isFinite(numericMessageId) || !cleanFingerprint) return null;

  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  const bucket = normalizePendingBucket(store, numericMessageId);
  const updatedAt = formatTimestamp();
  const item = {
    messageId: numericMessageId,
    fingerprint: cleanFingerprint,
    changed: Boolean(changed),
    profiles: Array.isArray(updates) ? updates : [],
    raw: isPlainObject(raw) ? raw : null,
    updatedAt,
  };
  bucket.items[cleanFingerprint] = item;
  bucket.updatedAt = updatedAt;
  store.lastPendingAt = updatedAt;
  saveChatState();
  return item;
}

export function getCurrentPendingEmotionUpdates(settings = getGlobalSettings()) {
  return getCurrentPendingEmotionItems(settings)
    .filter(item => item.changed === true && Array.isArray(item.profiles) && item.profiles.length)
    .map(item => ({
      messageId: item.messageId,
      fingerprint: item.fingerprint,
      updatedAt: item.updatedAt,
      profiles: item.profiles,
    }));
}

export function updateCurrentPendingEmotionProfile({ messageId, roleName, currentStatus, changeSummary, relationshipToUser = '' } = {}, settings = getGlobalSettings()) {
  const numericMessageId = Number(messageId);
  const cleanRoleName = normalizeRoleName(roleName);
  if (!Number.isFinite(numericMessageId) || !cleanRoleName) return false;

  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  const bucket = store.pendingByMessage?.[String(numericMessageId)];
  if (!isPlainObject(bucket) || !isPlainObject(bucket.items)) return false;

  const fingerprint = getMessageEmotionFingerprint(numericMessageId, settings);
  if (!fingerprint) return false;

  const item = bucket.items[fingerprint];
  if (!isPlainObject(item) || !Array.isArray(item.profiles)) return false;

  const profile = item.profiles.find(candidate => normalizeRoleName(candidate.roleName) === cleanRoleName);
  if (!profile) return false;

  profile.currentStatus = String(currentStatus || '').trim();
  profile.changeSummary = String(changeSummary || '').trim();
  if (relationshipToUser !== undefined) {
    profile.relationshipToUser = String(relationshipToUser || '').trim();
  }
  item.updatedAt = formatTimestamp();
  bucket.updatedAt = item.updatedAt;
  store.lastPendingAt = item.updatedAt;
  saveChatState();
  return true;
}

export function getCurrentPendingEmotionMessageIds(settings = getGlobalSettings()) {
  return new Set(getCurrentPendingEmotionItems(settings).map(item => Number(item.messageId)));
}

function getCurrentPendingEmotionItems(settings = getGlobalSettings()) {
  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  return Object.entries(store.pendingByMessage || {})
    .map(([messageId, bucket]) => {
      if (!isPlainObject(bucket) || !isPlainObject(bucket.items)) return null;
      const fingerprint = getMessageEmotionFingerprint(messageId, settings);
      if (!fingerprint) return null;
      const item = bucket.items[fingerprint];
      if (!isPlainObject(item)) return null;
      return {
        messageId: Number(messageId),
        fingerprint,
        changed: item.changed === true,
        updatedAt: item.updatedAt || bucket.updatedAt || '',
        profiles: Array.isArray(item.profiles) ? item.profiles : [],
      };
    })
    .filter(Boolean);
}

export function shouldAnalyzeEmotionProfile(settings = getGlobalSettings()) {
  const emotionSettings = getEmotionProfileSettings(settings);
  return Boolean(emotionSettings.enabled);
}

export function buildEmotionUpdatePromptSection(settings = getGlobalSettings()) {
  if (!shouldAnalyzeEmotionProfile(settings)) return '';
  const store = getEmotionProfileStore();
  return buildEmotionUpdatePromptSectionText({
    knownProfilesText: buildKnownProfilesSection(store),
  });
}

export function buildLegacyArchiveEmotionUpdatePromptSection(settings = getGlobalSettings()) {
  if (!shouldAnalyzeEmotionProfile(settings)) return '';
  const store = getEmotionProfileStore();
  return buildLegacyArchiveEmotionUpdatePromptSectionText({
    knownProfilesText: buildKnownProfilesSection(store),
  });
}

export function buildEmotionProfileInjection(chatState = getChatState()) {
  const store = getEmotionProfileStore(chatState);
  const lines = Object.entries(store.profiles || {})
    .filter(([, profile]) => isPlainObject(profile))
    .map(([roleName, profile]) => {
      const latest = getLatestRecord(profile);
      if (!latest) return '';
      const name = profile.name || roleName;
      const status = getRecordField(latest, ['currentStatus', 'currentState', 'status', 'summary']);
      const relationship = getRecordField(latest, ['relationshipToUser', 'relationship']);
      const source = latest.sourceMessageId === undefined || latest.sourceMessageId === null
        ? ''
        : `- 来源：第 ${latest.sourceMessageId} 楼`;
      return [
        `【${name}】`,
        source,
        status ? `- 当前状态：${status}` : '',
        relationship ? `- 与{{user}}关系：${relationship}` : '',
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);

  if (!lines.length) return '';
  return `<character_profile_state>
以下为蜃灵助手维护的角色情感档案当前最新版。它不是新剧情，只用于保持角色关系、态度与隐秘动机的连续性。

角色条目格式：
【角色名】
- 来源：第 N 楼
- 当前状态：角色当前情感状态
- 与{{user}}关系：当前关系

${lines.join('\n\n')}
</character_profile_state>`;
}

export function appendEmotionProfileRecords(updates, { messageId, fingerprint = '', sourceType = '', save = true } = {}) {
  if (!Array.isArray(updates) || !updates.length) return [];
  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  const createdAt = formatTimestamp();
  const changedRoleNames = [];

  for (const update of updates) {
    const roleName = normalizeRoleName(update.roleName);
    if (!roleName) continue;
    const profile = isPlainObject(store.profiles[roleName])
      ? store.profiles[roleName]
      : { name: roleName, records: [] };
    const records = Array.isArray(profile.records) ? profile.records : [];
    const record = {
      sourceMessageId: Number(messageId),
      sourceFingerprint: String(fingerprint || ''),
      sourceType,
      createdAt,
      updatedAt: createdAt,
      currentStatus: update.currentStatus,
      changeSummary: update.changeSummary,
      relationshipToUser: update.relationshipToUser,
    };
    profile.name = profile.name || roleName;
    profile.currentStatus = update.currentStatus || profile.currentStatus || '';
    profile.lastUpdatedAt = createdAt;
    profile.records = [...records, record];
    store.profiles[roleName] = profile;
    changedRoleNames.push(roleName);
  }

  if (changedRoleNames.length) {
    store.lastUpdatedAt = createdAt;
    if (save) saveChatState();
  }
  return changedRoleNames;
}

export function removeEmotionProfileRecordsForMessage(messageId, { save = true } = {}) {
  const numericMessageId = Number(messageId);
  if (!Number.isFinite(numericMessageId)) return false;

  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  let changed = false;

  for (const [roleName, profile] of Object.entries(store.profiles || {})) {
    if (!isPlainObject(profile)) continue;
    const records = Array.isArray(profile.records) ? profile.records : [];
    const nextRecords = records.filter(record => Number(record?.sourceMessageId) !== numericMessageId);
    if (nextRecords.length === records.length) continue;

    changed = true;
    if (!nextRecords.length) {
      delete store.profiles[roleName];
      continue;
    }

    const latestRecord = nextRecords.at(-1);
    profile.records = nextRecords;
    profile.currentStatus = latestRecord?.currentStatus || profile.currentStatus || '';
    profile.lastUpdatedAt = latestRecord?.updatedAt || latestRecord?.createdAt || profile.lastUpdatedAt || '';
    store.profiles[roleName] = profile;
  }

  if (changed) {
    store.lastUpdatedAt = formatTimestamp();
    if (save) saveChatState();
  }
  return changed;
}

export async function deleteEmotionProfileByRole(roleName) {
  const cleanRoleName = normalizeRoleName(roleName);
  if (!cleanRoleName) return false;

  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  let changed = false;

  if (isPlainObject(store.profiles?.[cleanRoleName])) {
    delete store.profiles[cleanRoleName];
    changed = true;
  }

  for (const [messageId, bucket] of Object.entries(store.pendingByMessage || {})) {
    if (!isPlainObject(bucket) || !isPlainObject(bucket.items)) continue;

    for (const [fingerprint, item] of Object.entries(bucket.items)) {
      if (!isPlainObject(item) || !Array.isArray(item.profiles)) continue;
      const nextProfiles = item.profiles.filter(profile => normalizeRoleName(profile?.roleName) !== cleanRoleName);
      if (nextProfiles.length === item.profiles.length) continue;

      changed = true;
      if (nextProfiles.length) {
        item.profiles = nextProfiles;
      } else {
        delete bucket.items[fingerprint];
      }
    }

    if (!Object.keys(bucket.items).length) {
      delete store.pendingByMessage[messageId];
    }
  }

  if (!changed) return false;
  store.lastUpdatedAt = formatTimestamp();
  saveChatState();
  await syncEmotionProfileInjection();
  refreshPanel();
  notifyEmotion('success', `已删除「${cleanRoleName}」的情感档案。`);
  return true;
}

export async function processEmotionUpdateFromSummaryResult(result, { messageId } = {}) {
  if (!shouldAnalyzeEmotionProfile()) return;
  try {
    const parsed = parseEmotionUpdateFromBracketLines(sanitizeMemoryForEmotionAnalysis(result));
    if (!parsed) {
      console.warn('[蜃灵助手] 本轮小总结未返回 emotion_changed，已跳过情感档案更新。');
      return;
    }
    const changed = parsed?.changed === true || String(parsed?.changed || '').toLowerCase() === 'true';
    const fingerprint = getMessageEmotionFingerprint(messageId);
    if (!fingerprint) return;
    const updates = changed ? normalizeProfileItems(parsed) : [];
    const pending = storePendingEmotionUpdate({
      messageId,
      fingerprint,
      changed: Boolean(changed && updates.length),
      updates,
      raw: parsed,
    });
    if (pending?.changed) {
      notifyEmotion('info', `检测到待确认情感变化：${updates.map(item => item.roleName).join('、')}`);
    }
    await syncEmotionProfileInjection();
    refreshPanel();
  } catch (error) {
    console.error('[蜃灵助手] 情感档案解析失败。', error);
    notifyEmotion('warning', error.message || String(error), '情感档案解析失败');
  }
}

export async function processEmotionUpdateFromArchiveResult(result, { messageId, sourceType = 'legacy_archive' } = {}) {
  if (!shouldAnalyzeEmotionProfile()) return;
  try {
    const parsed = parseEmotionUpdateFromBracketLines(sanitizeMemoryForEmotionAnalysis(result));
    if (!parsed) return;
    const changed = parsed?.changed === true || String(parsed?.changed || '').toLowerCase() === 'true';
    const updates = changed ? normalizeProfileItems(parsed) : [];
    if (!updates.length) return;

    const fingerprint = createEmotionFingerprint(String(result || ''));
    const roleNames = appendEmotionProfileRecords(updates, {
      messageId: Number(messageId),
      fingerprint,
      sourceType,
    });
    if (roleNames.length) {
      notifyEmotion('success', `旧聊天情感档案已生成：${[...new Set(roleNames)].join('、')}`);
    }
    await syncEmotionProfileInjection();
    refreshPanel();
  } catch (error) {
    console.error('[蜃灵助手] 旧聊天情感档案解析失败。', error);
    notifyEmotion('warning', error.message || String(error), '旧聊天情感档案失败');
  }
}

export async function commitSelectedPendingEmotionUpdates({ notify = false } = {}) {
  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  const pendingEntries = Object.entries(store.pendingByMessage || {});
  if (!pendingEntries.length) return;

  let changed = false;
  const committedRoleNames = [];

  for (const [messageId, bucket] of pendingEntries) {
    if (!isPlainObject(bucket) || !isPlainObject(bucket.items)) {
      delete store.pendingByMessage[messageId];
      changed = true;
      continue;
    }

    const fingerprint = getMessageEmotionFingerprint(messageId);
    if (!fingerprint) continue;
    const item = bucket.items[fingerprint];
    if (!isPlainObject(item)) continue;

    removeEmotionProfileRecordsForMessage(messageId, { save: false });
    if (item.changed === true && Array.isArray(item.profiles) && item.profiles.length) {
      committedRoleNames.push(...appendEmotionProfileRecords(item.profiles, {
        messageId: Number(messageId),
        fingerprint,
        save: false,
      }));
    }

    delete store.pendingByMessage[messageId];
    changed = true;
  }

  if (!changed) return;
  store.lastUpdatedAt = formatTimestamp();
  saveChatState();
  await syncEmotionProfileInjection();
  refreshPanel();
  if (notify && committedRoleNames.length) {
    notifyEmotion('success', `情感档案已确认：${[...new Set(committedRoleNames)].join('、')}`);
  }
}

function schedulePendingEmotionCommit() {
  void commitSelectedPendingEmotionUpdates().catch(error => {
    console.warn('[蜃灵助手] 情感档案确认失败。', error);
  });
}

export async function syncEmotionProfileInjection() {
  const context = getContextSafe();
  const setExtensionPrompt = typeof context?.setExtensionPrompt === 'function'
    ? (...args) => context.setExtensionPrompt(...args)
    : typeof globalThis.setExtensionPrompt === 'function'
      ? (...args) => globalThis.setExtensionPrompt(...args)
      : null;
  if (!setExtensionPrompt) return;

  const settings = getGlobalSettings();
  const emotionSettings = getEmotionProfileSettings(settings);
  const content = emotionSettings.enabled
    ? buildEmotionProfileInjection()
    : '';

  if (!content) {
    await setExtensionPrompt(EMOTION_PROFILE_PROMPT_ID, '', -1, 0, false, 0, () => false);
    return;
  }

  await setExtensionPrompt(EMOTION_PROFILE_PROMPT_ID, content, 1, 0, false, 0, () => {
    const latestSettings = getEmotionProfileSettings(getGlobalSettings());
    return Boolean(latestSettings.enabled && buildEmotionProfileInjection());
  });
}

function getTavernEventsSafe() {
  const context = getContextSafe();
  return globalThis.tavern_events || context?.tavern_events || context?.event_types || {};
}

function registerTavernEvent(eventName, handler) {
  if (!eventName) return null;
  const context = getContextSafe();
  if (context?.eventSource?.on) {
    context.eventSource.on(eventName, handler);
    return {
      stop: () => context.eventSource.off?.(eventName, handler),
    };
  }
  const eventSource = globalThis.eventSource || globalThis.parent?.eventSource;
  if (eventSource?.on) {
    eventSource.on(eventName, handler);
    return {
      stop: () => eventSource.off?.(eventName, handler),
    };
  }
  return null;
}

function stripEmotionLinesForSendingText(text) {
  const value = String(text || '');
  if (!/^\s*\[emotion(?:_changed)?\s*:/im.test(value)) return value;
  return value
    .replace(/^\s*\[emotion_changed\s*:[^\r\n]*\]\s*$/gim, '')
    .replace(/^\s*\[emotion\s*:[^\r\n]*\]\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n');
}

function stripEmotionLinesFromSendingContent(content) {
  if (typeof content === 'string') {
    return stripEmotionLinesForSendingText(content);
  }
  if (!Array.isArray(content)) return content;

  let changed = false;
  const nextContent = content.map(part => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
    const text = stripEmotionLinesForSendingText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? nextContent : content;
}

function getSendingContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function isShenlingInternalMemoryTask(chat) {
  const text = chat
    .map(message => getSendingContentText(message?.content))
    .filter(Boolean)
    .join('\n\n');
  return [
    '现在是梦境小总结模块',
    '现在是梦境大归档模块',
    '蜃灵助手的总档案压缩模块',
    '现在是旧聊天归档模块',
  ].some(marker => text.includes(marker));
}

function stripEmotionLinesFromChatCompletionPrompt(eventData) {
  const chat = Array.isArray(eventData?.chat) ? eventData.chat : [];
  if (isShenlingInternalMemoryTask(chat)) return;
  chat.forEach(message => {
    if (!message || typeof message !== 'object') return;
    const content = stripEmotionLinesFromSendingContent(message.content);
    if (content !== message.content) {
      message.content = content;
    }
  });
}

export function registerEmotionProfileEvents() {
  if (emotionEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();
  const syncHandler = () => {
    void syncEmotionProfileInjection().catch(error => {
      console.warn('[蜃灵助手] 情感档案注入刷新失败。', error);
    });
  };
  const refreshHandler = () => refreshPanel();

  const messageSentStop = registerTavernEvent(tavernEvents.MESSAGE_SENT, schedulePendingEmotionCommit);
  if (messageSentStop) emotionEventStops.push(messageSentStop);

  const beforeCombineStop = registerTavernEvent(tavernEvents.GENERATE_BEFORE_COMBINE_PROMPTS, syncHandler);
  if (beforeCombineStop) emotionEventStops.push(beforeCombineStop);

  const chatCompletionPromptReadyStop = registerTavernEvent(
    tavernEvents.CHAT_COMPLETION_PROMPT_READY,
    stripEmotionLinesFromChatCompletionPrompt,
  );
  if (chatCompletionPromptReadyStop) emotionEventStops.push(chatCompletionPromptReadyStop);

  const chatChangedStop = registerTavernEvent(tavernEvents.CHAT_CHANGED, syncHandler);
  if (chatChangedStop) emotionEventStops.push(chatChangedStop);

  [
    tavernEvents.MESSAGE_SWIPED,
    tavernEvents.MESSAGE_UPDATED,
  ].filter(Boolean).forEach(eventName => {
    const stop = registerTavernEvent(eventName, refreshHandler);
    if (stop) emotionEventStops.push(stop);
  });

  emotionEventsRegistered = emotionEventStops.length > 0;
  syncHandler();
}
