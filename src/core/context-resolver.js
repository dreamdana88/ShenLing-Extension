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

export function createEmptyWorldInfoContext() {
  return {
    entries: [],
    diagnostics: {
      source: 'not_implemented',
      activatedCount: 0,
      filteredCount: 0,
      usedCount: 0,
      notes: ['世界书 dry run / 激活缓存将在 Step Context B 接入。'],
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
    ? createEmptyWorldInfoContext()
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
