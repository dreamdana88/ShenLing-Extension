import {
  GRAND_MEMORY_BLOCK_RE,
} from '../constants.js';
import {
  isPlainObject,
} from '../utils/text.js';
import {
  getCurrentCharacterInfo,
} from './character.js';
import {
  getChatMessagesSafe,
  getContextSafe,
  getGlobalFunction,
  getLastMessageId,
} from './chat.js';
import {
  getChatState,
} from './settings.js';
import {
  extractMemoryBlocks,
} from './summary.js';

const DEFAULT_RECENT_MESSAGE_LIMIT = 8;
const DEFAULT_MEMORY_LIMIT = 4;
const DEFAULT_GRAND_MEMORY_LIMIT = 1;
const DEFAULT_WORLD_INFO_LIMIT = 12;
const WORLD_INFO_CACHE_LIMIT = 2;

const WORLD_INFO_STRONG_EXCLUDE_PATTERNS = [
  /状态栏/i,
  /\bMVU\b/i,
  /变量框架/i,
  /变量更新/i,
  /输出格式/i,
  /格式要求/i,
  /前端/i,
  /\bUI\b/i,
  /正则/i,
  /酒馆助手/i,
  /脚本/i,
  /样式/i,
  /模板占位/i,
  /不要输出/i,
  /禁止输出/i,
  /system prompt/i,
];

const WORLD_INFO_SOFT_EXCLUDE_PATTERNS = [
  /\bD0\b/i,
  /depth\s*0/i,
  /深度\s*0/i,
  /系统/i,
  /机制/i,
];

let worldInfoEventsRegistered = false;
const worldInfoEventStops = [];
let activatedWorldInfoCache = [];

function cleanText(value) {
  return String(value ?? '').trim();
}

function pickText(...values) {
  return values.map(cleanText).find(Boolean) || '';
}

function limitText(value, maxLength = 0) {
  const text = cleanText(value);
  if (!maxLength || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function getTavernEventsSafe() {
  const context = getContextSafe();
  return globalThis.tavern_events || context?.tavern_events || context?.event_types || {};
}

function registerTavernEvent(eventName, handler) {
  if (!eventName) return null;
  const eventOn = getGlobalFunction('eventOn');
  if (typeof eventOn === 'function') {
    return eventOn(eventName, handler);
  }

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

export function replaceContextMacros(value, {
  charName = '',
  userName = '',
} = {}) {
  const text = cleanText(value);
  if (!text) return '';
  return text
    .replace(/\{\{char\}\}/gi, charName || '角色')
    .replace(/\{\{original\}\}/gi, charName || '角色')
    .replace(/\{\{user\}\}/gi, userName || 'User');
}

function getUserName() {
  const context = getContextSafe();
  return pickText(context?.name1, context?.powerUserSettings?.name, 'User');
}

export function getUserPersona() {
  const context = getContextSafe();
  const userName = getUserName();
  const charName = getCurrentCharacterInfo().name;
  return replaceContextMacros(pickText(
    context?.powerUserSettings?.persona_description,
    context?.powerUserSettings?.personaDescription,
    context?.persona_description,
  ), { charName, userName });
}

export function getResolvedCharacterCard() {
  const userName = getUserName();
  const character = getCurrentCharacterInfo();
  const charName = character.name || '角色';
  return {
    ...character,
    name: charName,
    description: replaceContextMacros(character.description, { charName, userName }),
    personality: replaceContextMacros(character.personality, { charName, userName }),
    scenario: replaceContextMacros(character.scenario, { charName, userName }),
  };
}

function normalizeChatRecord(message) {
  const userName = getUserName();
  const charInfo = getResolvedCharacterCard();
  const role = message.role || (message.is_user ? 'user' : 'assistant');
  const speaker = role === 'user'
    ? userName
    : pickText(message.name, charInfo.name, 'Assistant');
  return {
    messageId: Number(message.message_id),
    role,
    speaker,
    content: cleanText(message.message),
    isHidden: Boolean(message.is_hidden),
  };
}

export function collectRecentChatMessages({
  limit = DEFAULT_RECENT_MESSAGE_LIMIT,
  includeHidden = false,
  maxContentLength = 1200,
} = {}) {
  const safeLimit = Math.max(0, Number(limit) || DEFAULT_RECENT_MESSAGE_LIMIT);
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' })
    .map(normalizeChatRecord)
    .filter(message => message.content)
    .filter(message => includeHidden || !message.isHidden)
    .slice(safeLimit > 0 ? -safeLimit : 0);

  return messages.map(message => ({
    ...message,
    content: limitText(message.content, maxContentLength),
  }));
}

export function formatRecentChatForContext(messages = []) {
  return messages
    .map(message => `第 ${message.messageId} 楼｜${message.speaker}：${message.content}`)
    .join('\n\n');
}

export function collectRecentMemories({
  limit = DEFAULT_MEMORY_LIMIT,
  beforeMessageId = null,
} = {}) {
  const maxId = Number(beforeMessageId);
  const hasMaxId = Number.isFinite(maxId);
  const safeLimit = Math.max(0, Number(limit) || DEFAULT_MEMORY_LIMIT);
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => message.role === 'assistant')
    .filter(message => !hasMaxId || Number(message.message_id) < maxId)
    .filter(message => !GRAND_MEMORY_BLOCK_RE.test(String(message.message || '')));

  const memories = messages.flatMap(message => extractMemoryBlocks(message.message)
    .map(memory => ({
      messageId: Number(message.message_id),
      content: memory,
    })));

  return safeLimit > 0 ? memories.slice(-safeLimit) : memories;
}

export function collectRecentGrandMemories({
  limit = DEFAULT_GRAND_MEMORY_LIMIT,
  beforeMessageId = null,
} = {}) {
  const maxId = Number(beforeMessageId);
  const hasMaxId = Number.isFinite(maxId);
  const safeLimit = Math.max(0, Number(limit) || DEFAULT_GRAND_MEMORY_LIMIT);
  const grandMemories = getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => message.role === 'assistant')
    .filter(message => !hasMaxId || Number(message.message_id) < maxId)
    .flatMap(message => {
      const match = String(message.message || '').match(GRAND_MEMORY_BLOCK_RE);
      return match ? [{
        messageId: Number(message.message_id),
        content: match[0].trim(),
      }] : [];
    });

  return safeLimit > 0 ? grandMemories.slice(-safeLimit) : grandMemories;
}

function getLatestEmotionRecord(profile) {
  const records = Array.isArray(profile?.records) ? profile.records : [];
  return records.at(-1) || null;
}

export function collectEmotionProfiles({ targetRoleName = '', includeAll = true } = {}) {
  const chatState = getChatState();
  const profiles = chatState?.emotionProfiles?.profiles;
  if (!isPlainObject(profiles)) return [];

  const target = cleanText(targetRoleName).toLowerCase();
  return Object.entries(profiles)
    .filter(([, profile]) => isPlainObject(profile))
    .map(([roleName, profile]) => {
      const latest = getLatestEmotionRecord(profile);
      return {
        roleName: profile.name || roleName,
        currentStatus: pickText(latest?.currentStatus, profile.currentStatus),
        changeSummary: pickText(latest?.changeSummary),
        relationshipToUser: pickText(latest?.relationshipToUser),
        sourceMessageId: latest?.sourceMessageId ?? null,
        updatedAt: pickText(latest?.updatedAt, latest?.createdAt, profile.lastUpdatedAt),
      };
    })
    .filter(profile => profile.currentStatus || profile.changeSummary || profile.relationshipToUser)
    .filter(profile => includeAll || !target || cleanText(profile.roleName).toLowerCase() === target);
}

function getEntryKeys(entry) {
  if (Array.isArray(entry?.key)) return entry.key.map(cleanText).filter(Boolean);
  if (Array.isArray(entry?.keys)) return entry.keys.map(cleanText).filter(Boolean);
  const key = cleanText(entry?.key || entry?.keys);
  return key ? [key] : [];
}

function getEntryLabel(entry) {
  const keys = getEntryKeys(entry);
  return pickText(entry?.comment, entry?.title, entry?.name, keys.join(', '), '未命名条目');
}

function normalizeWorldInfoEntry(entry, index = 0, source = 'event') {
  if (!entry || typeof entry !== 'object') return null;
  const content = cleanText(entry.content || entry.entry || entry.text);
  if (!content) return null;
  return {
    id: pickText(entry.uid, entry.id, entry.hash, `${source}-${index}`),
    title: getEntryLabel(entry),
    content,
    world: cleanText(entry.world || entry.book || entry.worldName),
    comment: cleanText(entry.comment),
    keys: getEntryKeys(entry),
    position: entry.position ?? entry.role ?? null,
    depth: entry.depth ?? entry.order ?? null,
    source,
  };
}

function normalizeWorldInfoEntriesFromPayload(payload, source = 'event') {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map((entry, index) => normalizeWorldInfoEntry(entry, index, source)).filter(Boolean);
  }
  if (payload instanceof Map) {
    return Array.from(payload.values())
      .map((entry, index) => normalizeWorldInfoEntry(entry, index, source))
      .filter(Boolean);
  }
  if (payload.activated?.entries instanceof Map) {
    return Array.from(payload.activated.entries.values())
      .map((entry, index) => normalizeWorldInfoEntry(entry, index, source))
      .filter(Boolean);
  }
  if (Array.isArray(payload.activated?.entries)) {
    return payload.activated.entries
      .map((entry, index) => normalizeWorldInfoEntry(entry, index, source))
      .filter(Boolean);
  }
  if (Array.isArray(payload.entries)) {
    return payload.entries
      .map((entry, index) => normalizeWorldInfoEntry(entry, index, source))
      .filter(Boolean);
  }
  return [];
}

function getWorldInfoFilterText(entry) {
  return [
    entry.title,
    entry.comment,
    entry.world,
    entry.keys?.join(' '),
    entry.content.slice(0, 500),
  ].filter(Boolean).join('\n');
}

function classifyWorldInfoEntry(entry) {
  const text = getWorldInfoFilterText(entry);
  const strongPattern = WORLD_INFO_STRONG_EXCLUDE_PATTERNS.find(pattern => pattern.test(text));
  if (strongPattern) {
    return {
      status: 'filtered',
      reason: `命中机制类关键词：${strongPattern.source}`,
    };
  }

  const softPattern = WORLD_INFO_SOFT_EXCLUDE_PATTERNS.find(pattern => pattern.test(text));
  if (softPattern) {
    return {
      status: 'suspicious',
      reason: `命中可疑关键词：${softPattern.source}`,
    };
  }

  return {
    status: 'used',
    reason: '',
  };
}

export function filterActivatedWorldInfoEntries(entries = [], { limit = DEFAULT_WORLD_INFO_LIMIT } = {}) {
  const used = [];
  const filtered = [];
  const suspicious = [];
  const seen = new Set();
  const safeLimit = Math.max(0, Number(limit) || DEFAULT_WORLD_INFO_LIMIT);

  for (const entry of entries) {
    if (!entry?.content) continue;
    const dedupeKey = [
      entry.world,
      entry.comment,
      entry.title,
      entry.content,
    ].map(cleanText).join('\n');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const classification = classifyWorldInfoEntry(entry);
    const item = {
      ...entry,
      filterStatus: classification.status,
      filterReason: classification.reason,
    };

    if (classification.status === 'filtered') {
      filtered.push(item);
    } else if (classification.status === 'suspicious') {
      suspicious.push(item);
    } else {
      used.push(item);
    }
  }

  return {
    used: safeLimit > 0 ? used.slice(0, safeLimit) : used,
    suspicious,
    filtered,
  };
}

function getCurrentChatCacheKey() {
  const context = getContextSafe();
  return pickText(
    context?.chatId,
    context?.chatMetadata?.name,
    context?.chat?.[0]?.extra?.chat_id,
    'unknown-chat',
  );
}

function rememberActivatedWorldInfo(entries, source) {
  const normalized = normalizeWorldInfoEntriesFromPayload(entries, source);
  const now = new Date().toISOString();
  const chatKey = getCurrentChatCacheKey();
  activatedWorldInfoCache.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chatKey,
    source,
    messageId: getLastMessageId(),
    capturedAt: now,
    entries: normalized,
  });
  activatedWorldInfoCache = activatedWorldInfoCache
    .filter(record => record.chatKey === chatKey)
    .slice(0, WORLD_INFO_CACHE_LIMIT);
  if (normalized.length > 0) {
    console.info(`[蜃灵助手] 已缓存激活世界书：${normalized.length} 条（${source}）。`);
  }
}

export function getActivatedWorldInfoCache() {
  const chatKey = getCurrentChatCacheKey();
  return activatedWorldInfoCache.filter(record => record.chatKey === chatKey);
}

export function clearActivatedWorldInfoCache() {
  activatedWorldInfoCache = [];
}

export function collectCachedWorldInfoContext({ limit = DEFAULT_WORLD_INFO_LIMIT } = {}) {
  const cache = getActivatedWorldInfoCache();
  const entries = cache.flatMap(record => record.entries.map(entry => ({
    ...entry,
    capturedAt: record.capturedAt,
    messageId: record.messageId,
    cacheSource: record.source,
  })));
  const filtered = filterActivatedWorldInfoEntries(entries, { limit });
  return {
    entries: filtered.used,
    diagnostics: {
      source: cache.length ? 'event_cache' : 'event_cache_empty',
      cacheCount: cache.length,
      activatedCount: entries.length,
      filteredCount: filtered.filtered.length,
      suspiciousCount: filtered.suspicious.length,
      usedCount: filtered.used.length,
      filteredEntries: filtered.filtered.map(entry => ({
        title: entry.title,
        world: entry.world,
        reason: entry.filterReason,
      })),
      suspiciousEntries: filtered.suspicious.map(entry => ({
        title: entry.title,
        world: entry.world,
        reason: entry.filterReason,
      })),
      notes: cache.length ? [] : ['尚未捕获到本聊天的世界书激活事件。'],
    },
  };
}

export function registerWorldInfoContextEvents() {
  if (worldInfoEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();

  const activatedStop = registerTavernEvent(tavernEvents.WORLD_INFO_ACTIVATED, entries => {
    rememberActivatedWorldInfo(entries, 'WORLD_INFO_ACTIVATED');
  });
  if (activatedStop) worldInfoEventStops.push(activatedStop);

  const scanDoneStop = registerTavernEvent(tavernEvents.WORLDINFO_SCAN_DONE, eventData => {
    rememberActivatedWorldInfo(eventData, 'WORLDINFO_SCAN_DONE');
  });
  if (scanDoneStop) worldInfoEventStops.push(scanDoneStop);

  const chatChangedStop = registerTavernEvent(tavernEvents.CHAT_CHANGED, () => {
    clearActivatedWorldInfoCache();
  });
  if (chatChangedStop) worldInfoEventStops.push(chatChangedStop);

  worldInfoEventsRegistered = worldInfoEventStops.length > 0;
  if (!worldInfoEventsRegistered) {
    console.warn('[蜃灵助手] 未发现世界书事件接口，上下文感知层暂不能缓存激活世界书。');
  }
}

export function createEmptyWorldInfoContext() {
  return {
    entries: [],
    diagnostics: {
      source: 'event_cache_empty',
      activatedCount: 0,
      filteredCount: 0,
      usedCount: 0,
      notes: ['尚未捕获到本聊天的世界书激活事件。'],
    },
  };
}

export async function resolveShenlingContext(options = {}) {
  const {
    purpose = 'general',
    targetRoleName = '',
    recentMessageLimit = DEFAULT_RECENT_MESSAGE_LIMIT,
    memoryLimit = DEFAULT_MEMORY_LIMIT,
    grandMemoryLimit = DEFAULT_GRAND_MEMORY_LIMIT,
    includeRecentChat = true,
    includeMemories = true,
    includeGrandMemories = true,
    includeEmotionProfile = true,
    includeWorldInfo = false,
    worldInfoLimit = DEFAULT_WORLD_INFO_LIMIT,
    includeAllEmotionProfiles = true,
  } = options;

  const characterCard = getResolvedCharacterCard();
  const userName = getUserName();
  const userPersona = getUserPersona();
  const recentMessages = includeRecentChat
    ? collectRecentChatMessages({ limit: recentMessageLimit })
    : [];
  const memories = includeMemories
    ? collectRecentMemories({ limit: memoryLimit })
    : [];
  const grandMemories = includeGrandMemories
    ? collectRecentGrandMemories({ limit: grandMemoryLimit })
    : [];
  const emotionProfiles = includeEmotionProfile
    ? collectEmotionProfiles({ targetRoleName, includeAll: includeAllEmotionProfiles })
    : [];
  const worldInfo = includeWorldInfo
    ? collectCachedWorldInfoContext({ limit: worldInfoLimit })
    : {
      entries: [],
      diagnostics: {
        source: 'disabled',
        activatedCount: 0,
        filteredCount: 0,
        usedCount: 0,
        notes: [],
      },
    };

  return {
    purpose,
    targetRoleName: cleanText(targetRoleName),
    characterCard,
    userName,
    userPersona,
    recentMessages,
    recentChat: formatRecentChatForContext(recentMessages),
    memories,
    grandMemories,
    emotionProfiles,
    activatedWorldInfo: worldInfo.entries,
    diagnostics: {
      recentMessageCount: recentMessages.length,
      memoryCount: memories.length,
      grandMemoryCount: grandMemories.length,
      emotionProfileCount: emotionProfiles.length,
      worldInfo: worldInfo.diagnostics,
    },
  };
}
