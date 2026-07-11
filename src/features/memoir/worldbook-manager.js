// 回忆录世界书共享管理：聊天绑定解析、稳定 ID 查找与独立读回核对。

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

function isBindingDecisionCurrent(memoir, chatId, worldbookName) {
  const decision = memoir?.bindingDecision;
  return decision
    && decision.chatId === chatId
    && decision.worldbookName === worldbookName
    && ['reuse', 'dedicated'].includes(decision.mode);
}

function recordBindingDecision(memoir, chatId, worldbookName, mode) {
  memoir.bindingDecision = {
    chatId,
    worldbookName,
    mode,
    confirmedAt: formatTimestamp(),
  };
}

async function createAndBindDedicatedMemoirBook(api, chatId) {
  const baseName = buildMemoirBookName(chatId);
  const rawNames = await Promise.resolve(api.getWorldbookNames());
  const names = new Set(Array.isArray(rawNames) ? rawNames : []);
  let worldbookName = baseName;
  let suffix = 2;
  while (names.has(worldbookName)) {
    worldbookName = `${baseName}｜${suffix}`;
    suffix += 1;
  }

  const created = await api.createWorldbook(worldbookName, []);
  if (created !== true) {
    throw new Error(`创建回忆录世界书「${worldbookName}」失败：同名世界书可能已存在。`);
  }

  try {
    await api.rebindChatWorldbook('current', worldbookName);
  } catch (error) {
    try {
      if (typeof api.deleteWorldbook === 'function') await api.deleteWorldbook(worldbookName);
    } catch {}
    throw new Error(`新世界书已创建但绑定失败：${error.message || String(error)}`);
  }
  return worldbookName;
}

/** 该书名是否为蜃灵自建的专属回忆录书。 */
export function isDedicatedMemoirBook(bookName) {
  return typeof bookName === 'string' && bookName.startsWith(MEMOIR_BOOK_PREFIX);
}

/**
 * 确保当前聊天存在经过用户确认的可写入世界书。
 * 同一聊天确认过同一本书后直接复用；外部绑定变化时重新询问。
 */
export async function ensureMemoirWorldbook({ confirmUseCurrent } = {}) {
  const api = getWorldbookApi();
  const chatId = resolveChatId();
  if (!chatId) {
    throw new Error('未读取到当前聊天标识，无法建立回忆录世界书。');
  }

  const memoir = getMemoirState();
  const currentBound = await api.getChatWorldbookName('current');
  let worldbookName;
  let mode;

  if (currentBound && isBindingDecisionCurrent(memoir, chatId, currentBound)) {
    worldbookName = currentBound;
    mode = 'existing';
  } else if (currentBound) {
    const expectedDedicatedPrefix = buildMemoirBookName(chatId);
    const isCurrentChatDedicated = currentBound === expectedDedicatedPrefix
      || currentBound.startsWith(`${expectedDedicatedPrefix}｜`);
    const isKnownCurrentChatDedicated = isCurrentChatDedicated
      && memoir.worldbookName === currentBound;
    if (isKnownCurrentChatDedicated) {
      worldbookName = currentBound;
      mode = 'existing';
      recordBindingDecision(memoir, chatId, worldbookName, 'dedicated');
    } else {
      if (typeof confirmUseCurrent !== 'function') {
        throw new Error(`当前聊天已绑定世界书「${currentBound}」，写入前需要用户确认。`);
      }
      const useCurrent = await confirmUseCurrent(currentBound);
      memoir.prevBoundName = currentBound;
      if (useCurrent) {
        worldbookName = currentBound;
        mode = 'existing';
        recordBindingDecision(memoir, chatId, worldbookName, 'reuse');
      } else {
        worldbookName = await createAndBindDedicatedMemoirBook(api, chatId);
        mode = 'new';
        recordBindingDecision(memoir, chatId, worldbookName, 'dedicated');
      }
    }
  } else {
    worldbookName = await createAndBindDedicatedMemoirBook(api, chatId);
    mode = 'new';
    memoir.prevBoundName = '';
    recordBindingDecision(memoir, chatId, worldbookName, 'dedicated');
  }

  memoir.worldbookId = worldbookName;
  memoir.worldbookName = worldbookName;
  memoir.updatedAt = formatTimestamp();
  saveChatState();

  return { worldbookName, mode, dedicated: isDedicatedMemoirBook(worldbookName) };
}

/** 从世界书数组中按 extra 稳定 ID 找条目。 */
export function findWorldbookEntryByExtraId(book, idField, id) {
  if (!Array.isArray(book) || !idField || !id) return null;
  const expectedId = String(id);
  return book.find(entry => String(entry?.extra?.[idField] ?? '') === expectedId) || null;
}

/**
 * 独立重新读取世界书，并核对一组稳定 ID。
 * 可供回忆录 memoirId 和后续设定采集 captureId 共用。
 */
export async function verifyWorldbookEntries(
  worldbookName,
  {
    api = getWorldbookApi(),
    idField,
    expectedIds = [],
    typeField = '',
    typeValue = '',
  } = {},
) {
  if (!worldbookName) throw new Error('缺少待核对的世界书名称。');
  if (!idField) throw new Error('缺少世界书条目稳定 ID 字段。');
  if (typeof api.getWorldbook !== 'function') {
    throw new Error('当前 TavernHelper 环境缺少 getWorldbook，无法执行写入读回核对。');
  }

  const book = await api.getWorldbook(worldbookName);
  if (!Array.isArray(book)) {
    throw new Error(`读回世界书「${worldbookName}」失败：返回结果不是条目数组。`);
  }

  const uniqueIds = [...new Set(expectedIds.map(id => String(id || '').trim()).filter(Boolean))];
  const verifiedEntries = [];
  const missingIds = [];
  uniqueIds.forEach(id => {
    const entry = findWorldbookEntryByExtraId(book, idField, id);
    const typeMatches = !entry || !typeField || !typeValue || entry?.extra?.[typeField] === typeValue;
    if (!entry || !typeMatches) {
      missingIds.push(id);
      return;
    }
    verifiedEntries.push(entry);
  });

  return {
    ok: missingIds.length === 0,
    worldbookName,
    book,
    verifiedEntries,
    missingIds,
  };
}

/**
 * 固化“单次更新 → 独立读回 → 稳定 ID 核对”的共享安全链路。
 * 业务模块仍可基于返回的 book 继续核对蓝灯内容或其他单例条目。
 */
export async function updateWorldbookWithVerification(
  worldbookName,
  updater,
  {
    api = getWorldbookApi(),
    idField,
    expectedIds = [],
    typeField = '',
    typeValue = '',
  } = {},
) {
  if (typeof updater !== 'function') throw new Error('缺少世界书更新函数。');
  await api.updateWorldbookWith(worldbookName, updater);
  return verifyWorldbookEntries(worldbookName, {
    api,
    idField,
    expectedIds,
    typeField,
    typeValue,
  });
}
