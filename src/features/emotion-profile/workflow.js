import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  getChatState,
  getEmotionProfileSettings,
  getGlobalSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getContextSafe,
} from '../../core/chat.js';
import {
  buildEmotionUpdatePromptSection as buildEmotionUpdatePromptSectionText,
} from '../../prompts.js';

const EMOTION_PROFILE_PROMPT_ID = 'shenling_assistant_emotion_profile_state';
const PSYCHOLOGY_BLOCK_RE = /<psychology>[\s\S]*?<\/psychology>/gi;
const LIST_BLOCK_RE = /<list>[\s\S]*?<\/list>/gi;
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
        evidence: String(item.evidence || item.basis || item.trigger || '').trim(),
      };
    })
    .filter(Boolean)
    .filter(item => item.currentStatus || item.changeSummary || item.relationshipToUser || item.evidence);
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

export function shouldAnalyzeEmotionProfile(settings = getGlobalSettings()) {
  const emotionSettings = getEmotionProfileSettings(settings);
  return Boolean(emotionSettings.enabled && emotionSettings.autoAnalyze);
}

export function buildEmotionUpdatePromptSection(settings = getGlobalSettings()) {
  if (!shouldAnalyzeEmotionProfile(settings)) return '';
  const store = getEmotionProfileStore();
  return buildEmotionUpdatePromptSectionText({
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
      const evidence = getRecordField(latest, ['evidence', 'basis', 'trigger']);
      const source = latest.sourceMessageId === undefined || latest.sourceMessageId === null
        ? ''
        : `- 来源：第 ${latest.sourceMessageId} 楼`;
      return [
        `${name}：`,
        status ? `- 当前状态：${status}` : '',
        relationship ? `- 与{{user}}关系：${relationship}` : '',
        evidence ? `- 依据：${evidence}` : '',
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

export function appendEmotionProfileRecords(updates, { messageId } = {}) {
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
      createdAt,
      updatedAt: createdAt,
      currentStatus: update.currentStatus,
      changeSummary: update.changeSummary,
      relationshipToUser: update.relationshipToUser,
      evidence: update.evidence,
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
    saveChatState();
  }
  return changedRoleNames;
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
    if (!changed) return;

    const updates = normalizeProfileItems(parsed);
    const changedRoleNames = appendEmotionProfileRecords(updates, { messageId });
    if (!changedRoleNames.length) return;

    await syncEmotionProfileInjection();
    notifyEmotion('success', `情感档案已更新：${changedRoleNames.join('、')}`);
    refreshPanel();
  } catch (error) {
    console.error('[蜃灵助手] 情感档案解析失败。', error);
    notifyEmotion('warning', error.message || String(error), '情感档案解析失败');
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
  const content = emotionSettings.enabled && emotionSettings.injectEnabled
    ? buildEmotionProfileInjection()
    : '';

  if (!content) {
    await setExtensionPrompt(EMOTION_PROFILE_PROMPT_ID, '', -1, 0, false, 0, () => false);
    return;
  }

  await setExtensionPrompt(EMOTION_PROFILE_PROMPT_ID, content, 1, 0, false, 0, () => {
    const latestSettings = getEmotionProfileSettings(getGlobalSettings());
    return Boolean(latestSettings.enabled && latestSettings.injectEnabled && buildEmotionProfileInjection());
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
  const syncHandler = () => {
    void syncEmotionProfileInjection().catch(error => {
      console.warn('[蜃灵助手] 情感档案注入刷新失败。', error);
    });
  };

  [
    tavernEvents.GENERATION_AFTER_COMMANDS,
    tavernEvents.GENERATE_BEFORE_COMBINE_PROMPTS,
    tavernEvents.CHAT_CHANGED,
  ].filter(Boolean).forEach(eventName => {
    const stop = registerTavernEvent(eventName, syncHandler);
    if (stop) emotionEventStops.push(stop);
  });

  emotionEventsRegistered = emotionEventStops.length > 0;
  syncHandler();
}
