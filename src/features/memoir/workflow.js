// 回忆录世界书业务流程。
// 阶段 3a：确保当前聊天有可写入的回忆录世界书（策略 A）。
//   - 当前聊天已绑定世界书 -> 直接复用那本（回忆条目以前缀 + extra.memoirId 隔离写入，不替换、不停用用户书）。
//   - 当前聊天无绑定 -> 新建「蜃灵回忆录｜<聊天标识>」并绑定。
// SillyTavern 聊天世界书绑定是 1:1，故不采用「新建独立书 + 替换绑定」以免停用用户自己的书。

import { formatTimestamp } from '../../utils/text.js';
import { getContextSafe } from '../../core/chat.js';
import { getContextInfo, getMemoirState, saveChatState } from '../../core/settings.js';
import { getWorldbookApi } from './worldbook-api.js';

const MEMOIR_BOOK_PREFIX = '蜃灵回忆录｜';

function resolveChatId() {
  const context = getContextSafe();
  try {
    if (typeof context?.getCurrentChatId === 'function') {
      const id = context.getCurrentChatId();
      if (id) return String(id);
    }
  } catch {}
  const info = getContextInfo();
  return info.chatId ? String(info.chatId) : '';
}

function buildMemoirBookName(chatId) {
  return `${MEMOIR_BOOK_PREFIX}${chatId}`;
}

/** 该书名是否为蜃灵自建的专属回忆录书（用于区分「专属书」与「共享用户书」）。 */
export function isDedicatedMemoirBook(bookName) {
  return typeof bookName === 'string' && bookName.startsWith(MEMOIR_BOOK_PREFIX);
}

/**
 * 确保当前聊天存在可写入的回忆录世界书，并把绑定信息写回 chatState.memoir。
 * 幂等：已建立则直接复用；不会重复创建或改变已有绑定。
 *
 * @returns {Promise<{ worldbookName: string, mode: 'existing'|'new', dedicated: boolean }>}
 */
export async function ensureMemoirWorldbook() {
  const api = getWorldbookApi();
  const chatId = resolveChatId();
  if (!chatId) {
    throw new Error('未读取到当前聊天标识，无法建立回忆录世界书。');
  }

  const memoir = getMemoirState();
  const currentBound = await api.getChatWorldbookName('current'); // string | null

  let worldbookName;
  let mode;

  if (currentBound) {
    // 策略 A：复用现有绑定书，回忆条目以前缀隔离写入
    worldbookName = currentBound;
    mode = 'existing';
    if (!memoir.prevBoundName) {
      memoir.prevBoundName = currentBound; // 记录首次接管前就存在的绑定，仅诊断
    }
  } else {
    // 无绑定：新建蜃灵专属书并绑定当前聊天
    const desiredName = buildMemoirBookName(chatId);
    worldbookName = await api.getOrCreateChatWorldbook('current', desiredName);
    mode = 'new';
    memoir.prevBoundName = '';
  }

  memoir.worldbookId = worldbookName;
  memoir.worldbookName = worldbookName;
  memoir.updatedAt = formatTimestamp();
  saveChatState();

  return { worldbookName, mode, dedicated: isDedicatedMemoirBook(worldbookName) };
}
