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
  stripMemoryBlock,
} from '../../core/summary.js';
import {
  buildEmotionUpdatePromptSection as buildEmotionUpdatePromptSectionText,
  buildLegacyArchiveEmotionUpdatePromptSection as buildLegacyArchiveEmotionUpdatePromptSectionText,
} from '../../prompts.js';

const EMOTION_PROFILE_PROMPT_ID = 'shenling_assistant_emotion_profile_state';
const PSYCHOLOGY_BLOCK_RE = /<psychology>[\s\S]*?<\/psychology>/gi;
const LIST_BLOCK_RE = /<list>[\s\S]*?<\/list>/gi;
const EMOTION_BLOCK_RE = /<emotion>[\s\S]*?<\/emotion>/gi;
const EMOTION_UPDATE_BLOCK_RE = /<emotion_update>\s*([\s\S]*?)\s*<\/emotion_update>/i;
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

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
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
        changeSummary: String(item.changeSummary || item.change || item.reason || item.summary || '').trim(),
        relationshipToUser: String(item.relationshipToUser || item.relationship || '').trim(),
      };
    })
    .filter(Boolean)
    .filter(item => item.currentStatus || item.changeSummary || item.relationshipToUser);
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

function buildReadableEmotionBlock(updates) {
  if (!Array.isArray(updates) || !updates.length) return '';
  const lines = updates.map(update => {
    const roleName = normalizeRoleName(update.roleName);
    if (!roleName) return '';
    return [
      `${roleName}：`,
      update.currentStatus ? `- 当前状态：${update.currentStatus}` : '',
      update.changeSummary ? `- 本次变化：${update.changeSummary}` : '',
      update.relationshipToUser ? `- 与{{user}}关系：${update.relationshipToUser}` : '',
    ].filter(Boolean).join('\n');
  }).filter(Boolean);
  return lines.length ? `<emotion>\n${lines.join('\n\n')}\n</emotion>` : '';
}

export function applyEmotionUpdateToMemory(memory, result) {
  let nextMemory = String(memory || '').replace(EMOTION_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  const match = String(result || '').match(EMOTION_UPDATE_BLOCK_RE);
  if (!match) return nextMemory;

  try {
    const parsed = extractJsonObject(sanitizeMemoryForEmotionAnalysis(match[1]));
    const changed = parsed?.changed === true || String(parsed?.changed || '').toLowerCase() === 'true';
    if (!changed) return nextMemory;
    const emotionBlock = buildReadableEmotionBlock(normalizeProfileItems(parsed));
    if (!emotionBlock) return nextMemory;
    if (/<\/database>/i.test(nextMemory)) {
      return nextMemory.replace(/<\/database>/i, `</database>\n${emotionBlock}`);
    }
    return nextMemory.replace(/<\/memory>\s*$/i, `${emotionBlock}\n</memory>`).trim();
  } catch (error) {
    console.warn('[蜃灵助手] emotion_update 转写 emotion 失败。', error);
    return nextMemory;
  }
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
        `${name}：`,
        status ? `- 当前状态：${status}` : '',
        relationship ? `- 与{{user}}关系：${relationship}` : '',
        source,
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean);

  if (!lines.length) return '';
  return `<character_profile_state>
以下为蜃灵助手维护的角色情感档案当前最新版。它不是新剧情，只用于保持角色关系、态度与隐秘动机的连续性。

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

export async function processEmotionUpdateFromSummaryResult(result, { messageId } = {}) {
  if (!shouldAnalyzeEmotionProfile()) return;
  try {
    const match = String(result || '').match(EMOTION_UPDATE_BLOCK_RE);
    if (!match) {
      console.warn('[蜃灵助手] 本轮小总结未返回 emotion_update，已跳过情感档案更新。');
      return;
    }
    const parsed = extractJsonObject(sanitizeMemoryForEmotionAnalysis(match[1]));
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
    const match = String(result || '').match(EMOTION_UPDATE_BLOCK_RE);
    if (!match) return;
    const parsed = extractJsonObject(sanitizeMemoryForEmotionAnalysis(match[1]));
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

export function registerEmotionProfileEvents() {
  if (emotionEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();
  const commitHandler = () => {
    void commitSelectedPendingEmotionUpdates().catch(error => {
      console.warn('[蜃灵助手] 情感档案注入刷新失败。', error);
    });
  };
  const syncHandler = () => {
    void syncEmotionProfileInjection().catch(error => {
      console.warn('[蜃灵助手] 情感档案注入刷新失败。', error);
    });
  };
  const refreshHandler = () => refreshPanel();

  [
    tavernEvents.GENERATION_AFTER_COMMANDS,
    tavernEvents.GENERATE_BEFORE_COMBINE_PROMPTS,
  ].filter(Boolean).forEach(eventName => {
    const stop = registerTavernEvent(eventName, commitHandler);
    if (stop) emotionEventStops.push(stop);
  });

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
