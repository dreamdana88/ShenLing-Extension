import {
  GRAND_MEMORY_BLOCK_RE,
} from '../constants.js';
import {
  isPlainObject,
  extractSummarySourceContent,
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
  getSummarySettings,
} from './settings.js';
import {
  extractMemoryBlocks,
} from './summary.js';

const DEFAULT_RECENT_MESSAGE_LIMIT = 8;
const DEFAULT_MEMORY_LIMIT = 4;
const DEFAULT_GRAND_MEMORY_LIMIT = 1;
const DEFAULT_WORLD_INFO_LIMIT = 12;
const WORLD_INFO_CACHE_LIMIT = 2;
const DEFAULT_DRY_RUN_MAX_CONTEXT = 8192;
const WORLD_INFO_IMPORT_CANDIDATES = [
  '../../../../../world-info.js',
  '../../../../world-info.js',
  '../../../world-info.js',
];
const SCRIPT_IMPORT_CANDIDATES = [
  '../../../../../script.js',
  '../../../../script.js',
  '../../../script.js',
];

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
let worldInfoModulePromise = null;
let scriptModulePromise = null;
let dryRunWorldInfoScanDepth = 0;

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

function normalizeLimit(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  if (limit === 0) return fallback;
  return Math.max(0, limit);
}

function normalizeMessageId(value) {
  const messageId = Number(value);
  return Number.isFinite(messageId) ? messageId : null;
}

function takeLastItems(items = [], limit = 0) {
  if (!Array.isArray(items) || limit <= 0) return [];
  return items.slice(-limit);
}

function createWorldInfoDiagnostics(overrides = {}) {
  return {
    source: 'unknown',
    mode: '',
    cacheCount: 0,
    rawSourceCounts: {},
    worldInfoBeforeLength: 0,
    worldInfoAfterLength: 0,
    injectionTextLength: 0,
    activatedCount: 0,
    filteredCount: 0,
    suspiciousCount: 0,
    usedCount: 0,
    filteredEntries: [],
    suspiciousEntries: [],
    notes: [],
    ...overrides,
  };
}

function createWorldInfoContextResult({
  entries = [],
  worldInfoBefore = '',
  worldInfoAfter = '',
  injectionText = '',
  diagnostics = {},
} = {}) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const before = cleanText(worldInfoBefore);
  const after = cleanText(worldInfoAfter);
  const injection = cleanText(injectionText);
  return {
    entries: safeEntries,
    worldInfoBefore: before,
    worldInfoAfter: after,
    injectionText: injection,
    diagnostics: createWorldInfoDiagnostics({
      worldInfoBeforeLength: before.length,
      worldInfoAfterLength: after.length,
      injectionTextLength: injection.length,
      usedCount: safeEntries.length,
      ...diagnostics,
    }),
  };
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

async function importFirstAvailable(candidates) {
  let lastError = null;
  for (const path of candidates) {
    try {
      return await import(path);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('未找到可导入模块。');
}

async function getWorldInfoModule() {
  if (!worldInfoModulePromise) {
    worldInfoModulePromise = importFirstAvailable(WORLD_INFO_IMPORT_CANDIDATES).catch(error => {
      worldInfoModulePromise = null;
      throw error;
    });
  }
  return worldInfoModulePromise;
}

async function getScriptModule() {
  if (!scriptModulePromise) {
    scriptModulePromise = importFirstAvailable(SCRIPT_IMPORT_CANDIDATES).catch(error => {
      scriptModulePromise = null;
      throw error;
    });
  }
  return scriptModulePromise;
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
  const rawContent = cleanText(message.message);
  const summaryContent = extractSummarySourceContent(rawContent, getSummarySettings());
  return {
    messageId: normalizeMessageId(message.message_id),
    role,
    speaker,
    content: summaryContent || rawContent,
    isHidden: Boolean(message.is_hidden),
    source: 'chat',
  };
}

export function collectRecentChatMessages({
  limit = DEFAULT_RECENT_MESSAGE_LIMIT,
  includeHidden = false,
  maxContentLength = 0,
} = {}) {
  const safeLimit = normalizeLimit(limit, DEFAULT_RECENT_MESSAGE_LIMIT);
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

export function formatRecentChatForPrompt(messages = []) {
  return formatRecentChatForContext(messages);
}

export function formatUserPersonaForPrompt(persona = '') {
  return cleanText(persona);
}

export function collectRecentMemories({
  limit = DEFAULT_MEMORY_LIMIT,
  beforeMessageId = null,
  includeHidden = false,
} = {}) {
  const maxId = Number(beforeMessageId);
  const hasMaxId = Number.isFinite(maxId);
  const safeLimit = normalizeLimit(limit, DEFAULT_MEMORY_LIMIT);
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => message.role === 'assistant')
    .filter(message => includeHidden || !message.is_hidden)
    .filter(message => !hasMaxId || Number(message.message_id) < maxId)
    .filter(message => !GRAND_MEMORY_BLOCK_RE.test(String(message.message || '')));

  const memories = messages.flatMap(message => extractMemoryBlocks(message.message)
    .map(memory => ({
      messageId: normalizeMessageId(message.message_id),
      content: memory,
      archiveType: 'memory',
      isHidden: Boolean(message.is_hidden),
      source: 'chat_memory',
    })));

  return takeLastItems(memories, safeLimit);
}

export function collectRecentGrandMemories({
  limit = DEFAULT_GRAND_MEMORY_LIMIT,
  beforeMessageId = null,
  includeHidden = false,
} = {}) {
  const maxId = Number(beforeMessageId);
  const hasMaxId = Number.isFinite(maxId);
  const safeLimit = normalizeLimit(limit, DEFAULT_GRAND_MEMORY_LIMIT);
  const grandMemories = getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => message.role === 'assistant')
    .filter(message => includeHidden || !message.is_hidden)
    .filter(message => !hasMaxId || Number(message.message_id) < maxId)
    .flatMap(message => {
      const match = String(message.message || '').match(GRAND_MEMORY_BLOCK_RE);
      return match ? [{
        messageId: normalizeMessageId(message.message_id),
        content: match[0].trim(),
        archiveType: 'grand_memory',
        isHidden: Boolean(message.is_hidden),
        source: 'chat_grand_memory',
      }] : [];
    });

  return takeLastItems(grandMemories, safeLimit);
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

function normalizeOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getWorldInfoPositionRank(position) {
  switch (normalizeOptionalNumber(position)) {
    case 0: return 0; // before character
    case 1: return 1; // after character
    case 4: return 2; // at depth
    case 2: return 3; // author's note top
    case 3: return 4; // author's note bottom
    case 5: return 5; // example messages top
    case 6: return 6; // example messages bottom
    case 7: return 7; // outlet
    default: return 99;
  }
}

function compareOptionalNumber(a, b, fallback = Number.MAX_SAFE_INTEGER) {
  return (normalizeOptionalNumber(a) ?? fallback) - (normalizeOptionalNumber(b) ?? fallback);
}

function sortWorldInfoEntriesForMaterial(entries = []) {
  return [...entries].sort((a, b) => (
    getWorldInfoPositionRank(a.position) - getWorldInfoPositionRank(b.position)
    || compareOptionalNumber(a.depth, b.depth)
    || compareOptionalNumber(a.role, b.role)
    || compareOptionalNumber(a.order, b.order)
    || compareOptionalNumber(a.sourceIndex, b.sourceIndex)
    || cleanText(a.title).localeCompare(cleanText(b.title))
  ));
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
    position: normalizeOptionalNumber(entry.position ?? entry.extensions?.position),
    depth: normalizeOptionalNumber(entry.depth ?? entry.extensions?.depth),
    role: normalizeOptionalNumber(entry.role ?? entry.extensions?.role),
    order: normalizeOptionalNumber(entry.order ?? entry.insertion_order ?? entry.insertorder),
    sourceIndex: index,
    source,
  };
}

function getCollectionSize(collection) {
  if (!collection) return 0;
  if (Array.isArray(collection)) return collection.length;
  if (collection instanceof Set || collection instanceof Map) return collection.size;
  return 0;
}

function getCollectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Set || collection instanceof Map) return Array.from(collection.values());
  return [];
}

function getWorldInfoPayloadSourceCounts(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return {
    payload: Array.isArray(payload) || payload instanceof Set || payload instanceof Map
      ? getCollectionSize(payload)
      : 0,
    sortedEntries: getCollectionSize(payload.sortedEntries),
    allActivatedEntries: getCollectionSize(payload.allActivatedEntries),
    activatedEntries: getCollectionSize(payload.activated?.entries),
    entries: getCollectionSize(payload.entries),
    newAll: getCollectionSize(payload.new?.all),
    newSuccessful: getCollectionSize(payload.new?.successful),
    activatedTextLength: cleanText(payload.activated?.text).length,
    worldInfoBeforeLength: cleanText(payload.worldInfoBefore).length,
    worldInfoAfterLength: cleanText(payload.worldInfoAfter).length,
  };
}

function getWorldInfoInjectionFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      worldInfoBefore: '',
      worldInfoAfter: '',
      injectionText: '',
    };
  }

  const worldInfoBefore = cleanText(payload.worldInfoBefore);
  const worldInfoAfter = cleanText(payload.worldInfoAfter);
  const activatedText = cleanText(payload.activated?.text);
  const injectionText = [worldInfoBefore, worldInfoAfter].filter(Boolean).join('\n\n')
    || activatedText;

  return {
    worldInfoBefore,
    worldInfoAfter,
    injectionText,
  };
}

function dedupeWorldInfoEntries(entries = []) {
  const seen = new Set();
  return entries.filter(entry => {
    if (!entry?.content) return false;
    const dedupeKey = [
      entry.world,
      entry.comment,
      entry.title,
      entry.content,
    ].map(cleanText).join('\n');
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

function normalizeWorldInfoEntriesFromPayload(payload, source = 'event') {
  if (!payload) return [];
  if (Array.isArray(payload) || payload instanceof Set || payload instanceof Map) {
    return getCollectionValues(payload)
      .map((entry, index) => normalizeWorldInfoEntry(entry, index, source))
      .filter(Boolean);
  }

  const sources = [
    ['allActivatedEntries', payload.allActivatedEntries],
    ['activated.entries', payload.activated?.entries],
    ['entries', payload.entries],
  ];

  return dedupeWorldInfoEntries(sources.flatMap(([sourceField, collection]) => (
    getCollectionValues(collection)
      .map((entry, index) => ({
        ...normalizeWorldInfoEntry(entry, index, source),
        sourceField,
      }))
      .filter(entry => entry?.content)
  )));
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
  const safeLimit = normalizeLimit(limit, DEFAULT_WORLD_INFO_LIMIT);

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

  const sortedUsed = sortWorldInfoEntriesForMaterial(used);

  return {
    used: safeLimit > 0 ? sortedUsed.slice(0, safeLimit) : sortedUsed,
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
  const rawSourceCounts = getWorldInfoPayloadSourceCounts(entries);
  const injection = getWorldInfoInjectionFromPayload(entries);
  const normalized = normalizeWorldInfoEntriesFromPayload(entries, source);
  const now = new Date().toISOString();
  const chatKey = getCurrentChatCacheKey();
  activatedWorldInfoCache.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chatKey,
    source,
    messageId: getLastMessageId(),
    capturedAt: now,
    rawSourceCounts,
    ...injection,
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
  const latestInjection = cache.find(record => record.injectionText) || null;
  const entries = cache.flatMap(record => record.entries.map(entry => ({
    ...entry,
    capturedAt: record.capturedAt,
    messageId: record.messageId,
    cacheSource: record.source,
  })));
  const filtered = filterActivatedWorldInfoEntries(entries, { limit });
  return createWorldInfoContextResult({
    entries: filtered.used,
    worldInfoBefore: latestInjection?.worldInfoBefore || '',
    worldInfoAfter: latestInjection?.worldInfoAfter || '',
    injectionText: latestInjection?.injectionText || '',
    diagnostics: {
      source: cache.length ? 'event_cache' : 'event_cache_empty',
      mode: 'cache_only',
      cacheCount: cache.length,
      rawSourceCounts: cache[0]?.rawSourceCounts || {},
      worldInfoBeforeLength: cleanText(latestInjection?.worldInfoBefore).length,
      worldInfoAfterLength: cleanText(latestInjection?.worldInfoAfter).length,
      injectionTextLength: cleanText(latestInjection?.injectionText).length,
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
  });
}

function getCharacterCardFieldsForWorldInfo() {
  const context = getContextSafe();
  const fallback = getResolvedCharacterCard();
  try {
    const fields = typeof context?.getCharacterCardFields === 'function'
      ? context.getCharacterCardFields()
      : null;
    if (fields && typeof fields === 'object') {
      return {
        personaDescription: fields.persona || getUserPersona(),
        characterDescription: fields.description || fallback.description || '',
        characterPersonality: fields.personality || fallback.personality || '',
        characterDepthPrompt: fields.charDepthPrompt || '',
        scenario: fields.scenario || fallback.scenario || '',
        creatorNotes: fields.creatorNotes || '',
        trigger: 'normal',
      };
    }
  } catch (error) {
    console.warn('[蜃灵助手] 读取角色卡扫描字段失败，使用基础字段兜底。', error);
  }

  return {
    personaDescription: getUserPersona(),
    characterDescription: fallback.description || '',
    characterPersonality: fallback.personality || '',
    characterDepthPrompt: '',
    scenario: fallback.scenario || '',
    creatorNotes: '',
    trigger: 'normal',
  };
}

async function getWorldInfoMaxContext() {
  const context = getContextSafe();
  if (typeof context?.getMaxContextSize === 'function') {
    return Number(context.getMaxContextSize()) || DEFAULT_DRY_RUN_MAX_CONTEXT;
  }
  if (typeof globalThis.getMaxContextSize === 'function') {
    return Number(globalThis.getMaxContextSize()) || DEFAULT_DRY_RUN_MAX_CONTEXT;
  }
  try {
    const scriptModule = await getScriptModule();
    if (typeof scriptModule?.getMaxContextSize === 'function') {
      return Number(scriptModule.getMaxContextSize()) || DEFAULT_DRY_RUN_MAX_CONTEXT;
    }
  } catch {
    // Optional import; fallback below.
  }
  return DEFAULT_DRY_RUN_MAX_CONTEXT;
}

function shouldIncludeNamesForWorldInfo(worldInfoModule = null) {
  if (typeof worldInfoModule?.world_info_include_names === 'boolean') {
    return worldInfoModule.world_info_include_names;
  }
  if (typeof globalThis.world_info_include_names === 'boolean') {
    return globalThis.world_info_include_names;
  }
  return true;
}

function buildWorldInfoScanChat(messages = collectRecentChatMessages(), {
  includeNames = true,
  targetRoleName = '',
} = {}) {
  const chatForScan = messages
    .filter(message => message.content)
    .map(message => (includeNames ? `${message.speaker}: ${message.content}` : message.content))
    .reverse();
  const cleanRoleName = cleanText(targetRoleName);
  if (cleanRoleName) {
    chatForScan.unshift(cleanRoleName);
  }
  return chatForScan;
}

export async function collectDryRunWorldInfoContext({
  limit = DEFAULT_WORLD_INFO_LIMIT,
  recentMessages = null,
  targetRoleName = '',
} = {}) {
  try {
    const worldInfoModule = await getWorldInfoModule();
    const checkWorldInfo = worldInfoModule?.checkWorldInfo || globalThis.checkWorldInfo;
    if (typeof checkWorldInfo !== 'function') {
      throw new Error('当前环境未发现 checkWorldInfo。');
    }

    const chatForScan = buildWorldInfoScanChat(
      Array.isArray(recentMessages) ? recentMessages : collectRecentChatMessages(),
      {
        includeNames: shouldIncludeNamesForWorldInfo(worldInfoModule),
        targetRoleName,
      },
    );
    if (!chatForScan.length) {
      return createWorldInfoContextResult({
        entries: [],
        worldInfoBefore: '',
        worldInfoAfter: '',
        injectionText: '',
        diagnostics: {
          source: 'dry_run_empty_chat',
          mode: 'dry_run',
          cacheCount: 0,
          activatedCount: 0,
          filteredCount: 0,
          suspiciousCount: 0,
          usedCount: 0,
          notes: ['最近聊天为空，跳过世界书 dry run。'],
        },
      });
    }

    const maxContext = await getWorldInfoMaxContext();
    dryRunWorldInfoScanDepth += 1;
    let result = null;
    try {
      result = await checkWorldInfo(
        chatForScan,
        maxContext,
        true,
        getCharacterCardFieldsForWorldInfo(),
      );
    } finally {
      dryRunWorldInfoScanDepth = Math.max(0, dryRunWorldInfoScanDepth - 1);
    }
    const rawSourceCounts = getWorldInfoPayloadSourceCounts(result);
    const injection = getWorldInfoInjectionFromPayload(result);
    const entries = normalizeWorldInfoEntriesFromPayload(result, 'dry_run');
    const filtered = filterActivatedWorldInfoEntries(entries, { limit });
    return createWorldInfoContextResult({
      entries: filtered.used,
      worldInfoBefore: injection.worldInfoBefore,
      worldInfoAfter: injection.worldInfoAfter,
      injectionText: injection.injectionText,
      diagnostics: {
        source: 'dry_run',
        mode: 'dry_run',
        cacheCount: 0,
        rawSourceCounts,
        worldInfoBeforeLength: injection.worldInfoBefore.length,
        worldInfoAfterLength: injection.worldInfoAfter.length,
        injectionTextLength: injection.injectionText.length,
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
        notes: cleanText(targetRoleName) ? [`dry run 扫描已加入日记角色名关键词：${cleanText(targetRoleName)}`] : [],
      },
    });
  } catch (error) {
    return createWorldInfoContextResult({
      entries: [],
      worldInfoBefore: '',
      worldInfoAfter: '',
      injectionText: '',
      diagnostics: {
        source: 'dry_run_failed',
        mode: 'dry_run',
        cacheCount: 0,
        activatedCount: 0,
        filteredCount: 0,
        suspiciousCount: 0,
        usedCount: 0,
        notes: [`世界书 dry run 不可用：${error.message || String(error)}`],
      },
    });
  }
}

export async function collectWorldInfoContext({
  limit = DEFAULT_WORLD_INFO_LIMIT,
  mode = 'cache_first',
  recentMessages = null,
  targetRoleName = '',
} = {}) {
  if (mode === 'dry_run') {
    const dryRun = await collectDryRunWorldInfoContext({ limit, recentMessages, targetRoleName });
    dryRun.diagnostics.mode = mode;
    if (dryRun.entries.length || dryRun.diagnostics.source !== 'dry_run_failed') return dryRun;
    const cachedFallback = collectCachedWorldInfoContext({ limit });
    cachedFallback.diagnostics.mode = mode;
    return cachedFallback;
  }

  const cached = collectCachedWorldInfoContext({ limit });
  cached.diagnostics.mode = mode;
  if (mode === 'cache_only') return cached;
  if (cached.entries.length || cached.injectionText) return cached;

  const dryRun = await collectDryRunWorldInfoContext({ limit, recentMessages, targetRoleName });
  dryRun.diagnostics.mode = mode;

  if (dryRun.entries.length || dryRun.diagnostics.source !== 'dry_run_failed') return dryRun;

  return createWorldInfoContextResult({
    entries: cached.entries,
    worldInfoBefore: cached.worldInfoBefore || '',
    worldInfoAfter: cached.worldInfoAfter || '',
    injectionText: cached.injectionText || '',
    diagnostics: {
      ...cached.diagnostics,
      source: 'event_cache_empty_dry_run_failed',
      mode,
      notes: [
        ...(cached.diagnostics.notes || []),
        ...(dryRun.diagnostics.notes || []),
      ],
    },
  });
}

export function registerWorldInfoContextEvents() {
  if (worldInfoEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();

  const activatedStop = registerTavernEvent(tavernEvents.WORLD_INFO_ACTIVATED, entries => {
    rememberActivatedWorldInfo(entries, 'WORLD_INFO_ACTIVATED');
  });
  if (activatedStop) worldInfoEventStops.push(activatedStop);

  const scanDoneStop = registerTavernEvent(tavernEvents.WORLDINFO_SCAN_DONE, eventData => {
    if (dryRunWorldInfoScanDepth > 0) return;
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
  return createWorldInfoContextResult({
    entries: [],
    worldInfoBefore: '',
    worldInfoAfter: '',
    injectionText: '',
    diagnostics: {
      source: 'event_cache_empty',
      mode: 'cache_only',
      cacheCount: 0,
      activatedCount: 0,
      filteredCount: 0,
      suspiciousCount: 0,
      usedCount: 0,
      notes: ['尚未捕获到本聊天的世界书激活事件。'],
    },
  });
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
    worldInfoMode = 'cache_first',
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
    ? await collectWorldInfoContext({
      limit: worldInfoLimit,
      mode: worldInfoMode,
      recentMessages,
      targetRoleName,
    })
    : createWorldInfoContextResult({
      entries: [],
      worldInfoBefore: '',
      worldInfoAfter: '',
      injectionText: '',
      diagnostics: {
        source: 'disabled',
        mode: 'disabled',
        cacheCount: 0,
        activatedCount: 0,
        filteredCount: 0,
        suspiciousCount: 0,
        usedCount: 0,
        notes: [],
      },
    });
  const timelineArchives = [
    ...grandMemories,
    ...memories,
  ].sort((a, b) => Number(a.messageId ?? 0) - Number(b.messageId ?? 0));

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
    timelineArchives,
    emotionProfiles,
    worldInfo,
    activatedWorldInfo: worldInfo.entries,
    worldInfoBefore: worldInfo.worldInfoBefore || '',
    worldInfoAfter: worldInfo.worldInfoAfter || '',
    worldInfoInjectionText: worldInfo.injectionText || '',
    diagnostics: {
      recentMessageCount: recentMessages.length,
      memoryCount: memories.length,
      grandMemoryCount: grandMemories.length,
      emotionProfileCount: emotionProfiles.length,
      worldInfo: worldInfo.diagnostics,
      hiddenPolicy: {
        recentChat: 'visible_only',
        memories: 'visible_only',
        grandMemories: 'visible_only',
      },
      sorting: {
        recentChat: 'message_id_ascending',
        timelineArchives: 'message_id_ascending',
        worldInfo: 'tavern_order_best_effort',
      },
    },
  };
}

export function createPromptSection(title, content) {
  const text = cleanText(content);
  return text ? `【${title}】\n${text}` : '';
}

export function formatCharacterCardForPrompt(characterCard) {
  if (!characterCard) return '';
  return [
    characterCard.name ? `角色名：${characterCard.name}` : '',
    characterCard.description ? `角色描述：\n${characterCard.description}` : '',
    characterCard.personality ? `角色性格：\n${characterCard.personality}` : '',
    characterCard.scenario ? `场景设定：\n${characterCard.scenario}` : '',
  ].filter(Boolean).join('\n\n');
}

export function formatMemoryItemsForPrompt(items = [], _options = {}) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map(item => {
    const source = Number.isFinite(Number(item.messageId)) ? `第 ${item.messageId} 楼` : '未记录楼层';
    return `### ${source}\n${cleanText(item.content)}`;
  }).join('\n\n');
}

export function formatEmotionProfilesForPrompt(items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map(item => [
    `### ${item.roleName || '未命名角色'}`,
    item.sourceMessageId === null || item.sourceMessageId === undefined ? '' : `来源：第 ${item.sourceMessageId} 楼`,
    item.currentStatus ? `当前状态：${item.currentStatus}` : '',
    item.changeSummary ? `最近变化：${item.changeSummary}` : '',
    item.relationshipToUser ? `与用户关系：${item.relationshipToUser}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function formatTimelineArchivesForPrompt(memories = [], grandMemories = []) {
  const items = [
    ...(Array.isArray(grandMemories) ? grandMemories.map(item => ({ ...item, archiveType: 'grand_memory' })) : []),
    ...(Array.isArray(memories) ? memories.map(item => ({ ...item, archiveType: 'memory' })) : []),
  ].sort((a, b) => Number(a.messageId ?? 0) - Number(b.messageId ?? 0));

  if (!items.length) return '';
  return items.map(item => {
    const source = Number.isFinite(Number(item.messageId)) ? `第 ${item.messageId} 楼` : '未记录楼层';
    return `### ${source}｜${item.archiveType}\n${cleanText(item.content)}`;
  }).join('\n\n');
}

export function formatWorldInfoForPrompt(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return '';
  return entries.map(entry => [
    `### ${entry.title || '未命名条目'}`,
    cleanText(entry.content),
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function formatWorldInfoInjectionForPrompt(context = {}) {
  const before = cleanText(context.worldInfoBefore);
  const after = cleanText(context.worldInfoAfter);
  const injectionText = cleanText(context.worldInfoInjectionText);

  if (before || after) {
    return [
      before ? `### worldInfoBefore\n${before}` : '',
      after ? `### worldInfoAfter\n${after}` : '',
    ].filter(Boolean).join('\n\n');
  }

  return injectionText;
}

export function formatWorldInfoMaterialForPrompt(context = {}, { mode = 'injection_first' } = {}) {
  const entriesMaterial = formatWorldInfoForPrompt(context.activatedWorldInfo);
  const injectionMaterial = formatWorldInfoInjectionForPrompt(context);
  if (mode === 'entries_only') return entriesMaterial;
  if (mode === 'injection_only') return injectionMaterial;
  if (mode === 'full') return [entriesMaterial, injectionMaterial].filter(Boolean).join('\n\n');
  return injectionMaterial || entriesMaterial;
}

export function buildDiaryContextMaterial(context = {}, options = {}) {
  const sections = [
    createPromptSection('当前角色卡基础信息', formatCharacterCardForPrompt(context.characterCard)),
    createPromptSection('用户 Persona', formatUserPersonaForPrompt(context.userPersona)),
    createPromptSection('当前世界信息', formatWorldInfoMaterialForPrompt(context, {
      mode: options.worldInfoMaterialMode,
    })),
    createPromptSection('近期梦境档案', formatTimelineArchivesForPrompt(context.memories, context.grandMemories)),
    createPromptSection('最近主要剧情', context.recentChat || formatRecentChatForPrompt(context.recentMessages)),
    createPromptSection('情感档案', formatEmotionProfilesForPrompt(context.emotionProfiles)),
  ].filter(Boolean);

  return sections.join('\n\n---\n\n');
}

export async function resolveDiaryContext(options = {}) {
  const {
    worldInfoMaterialMode = 'injection_first',
    ...contextOptions
  } = options;
  const context = await resolveShenlingContext({
    purpose: 'diary',
    recentMessageLimit: 8,
    memoryLimit: 4,
    grandMemoryLimit: 1,
    includeWorldInfo: true,
    includeEmotionProfile: true,
    includeMemories: true,
    includeGrandMemories: true,
    ...contextOptions,
  });

  return {
    ...context,
    material: buildDiaryContextMaterial(context, { worldInfoMaterialMode }),
  };
}
