// 回忆录世界书共享管理：聊天绑定解析、稳定 ID 查找与独立读回核对。

import { formatTimestamp } from '../../utils/text.js';
import { getContextSafe } from '../../core/chat.js';
import { getContextInfo, getMemoirState, saveChatState } from '../../core/settings.js';
import { getWorldbookApi } from '../../core/worldbook.js';

const MEMOIR_BOOK_PREFIX = '蜃灵回忆录｜';
const MEMOIR_GREEN_NAME_PREFIX = 'SLX-Memoir-Green-';

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

function resetMemoirBookState(memoir, { clearBinding = true } = {}) {
  memoir.entries = [];
  memoir.sourceProcessed = [];
  memoir.overviewUid = null;
  if (clearBinding) {
    memoir.worldbookId = '';
    memoir.worldbookName = '';
    memoir.bindingDecision = null;
  }
  memoir.updatedAt = formatTimestamp();
}

function rebuildMemoirIndexEntry(worldbookEntry, previous = null) {
  const titleFromName = String(worldbookEntry?.name || '').replace(MEMOIR_GREEN_NAME_PREFIX, '').trim();
  const storyTime = String(worldbookEntry?.extra?.storyTime || previous?.storyTime || '未明').trim() || '未明';
  const rawContent = String(worldbookEntry?.content || previous?.content || '').trim();
  const timePrefix = storyTime !== '未明' ? `【${storyTime}】` : '';
  const content = timePrefix && rawContent.startsWith(timePrefix)
    ? rawContent.slice(timePrefix.length).trim()
    : rawContent;
  return {
    ...(previous || {}),
    memoirId: String(worldbookEntry.extra.memoirId),
    uid: worldbookEntry.uid,
    title: titleFromName || previous?.title || '未命名回忆',
    storyTime,
    importance: ['high', 'medium', 'low'].includes(worldbookEntry?.extra?.importance)
      ? worldbookEntry.extra.importance
      : (previous?.importance || 'medium'),
    participants: Array.isArray(worldbookEntry?.extra?.participants)
      ? worldbookEntry.extra.participants
      : (previous?.participants || []),
    mainKeywords: Array.isArray(worldbookEntry?.strategy?.keys)
      ? worldbookEntry.strategy.keys
      : (previous?.mainKeywords || []),
    filterKeywords: Array.isArray(worldbookEntry?.strategy?.keys_secondary?.keys)
      ? worldbookEntry.strategy.keys_secondary.keys
      : (previous?.filterKeywords || []),
    content,
  };
}

/** 用本地索引生成蜃灵管理的蓝灯正文；世界书同步与正式提交共用。 */
export function buildMemoirBlueContent(entries) {
  const lines = ['【回忆录总览】', '以下是这段旅程中值得铭记的往事：', ''];
  (Array.isArray(entries) ? entries : []).forEach(entry => {
    const digest = entry.digest
      || `${entry.storyTime && entry.storyTime !== '未明' ? `${entry.storyTime}，` : ''}${entry.title}`;
    lines.push(`· ${entry.title}：${digest}`);
    const anchors = Array.isArray(entry.filterKeywords)
      ? [...new Set(entry.filterKeywords.map(word => String(word || '').trim()).filter(Boolean))].slice(0, 4)
      : [];
    if (anchors.length) lines.push(`  唤起词：${anchors.join('、')}`);
  });
  return lines.join('\n');
}

function normalizeManagedContent(content) {
  return String(content || '').replace(/\r\n/g, '\n').trim();
}

async function repairManagedBlueContent(api, worldbookName, book, entries) {
  const blueEntry = (Array.isArray(book) ? book : [])
    .find(entry => entry?.extra?.memoirType === 'blue');
  if (!blueEntry) return false;
  const expectedContent = buildMemoirBlueContent(entries);
  if (normalizeManagedContent(blueEntry.content) === normalizeManagedContent(expectedContent)) {
    return false;
  }

  await api.updateWorldbookWith(worldbookName, list => {
    const next = Array.isArray(list) ? list : [];
    next.forEach(entry => {
      if (entry?.extra?.memoirType === 'blue') entry.content = expectedContent;
    });
    return next;
  });
  const verifiedBook = await api.getWorldbook(worldbookName);
  const verifiedBlue = Array.isArray(verifiedBook)
    ? verifiedBook.find(entry => entry?.extra?.memoirType === 'blue')
    : null;
  if (!verifiedBlue
    || normalizeManagedContent(verifiedBlue.content) !== normalizeManagedContent(expectedContent)) {
    throw new Error(`世界书「${worldbookName}」的蓝灯总览同步后核对失败。`);
  }
  return true;
}

function syncMemoirIndexFromBook(memoir, book) {
  const list = Array.isArray(book) ? book : [];
  const greenEntries = list.filter(entry => entry?.extra?.memoirType === 'green' && entry?.extra?.memoirId);
  const hasBlue = list.some(entry => entry?.extra?.memoirType === 'blue');
  const previousById = new Map(
    (Array.isArray(memoir.entries) ? memoir.entries : [])
      .filter(entry => entry?.memoirId)
      .map(entry => [String(entry.memoirId), entry]),
  );
  const nextEntries = greenEntries.map(entry => (
    rebuildMemoirIndexEntry(entry, previousById.get(String(entry.extra.memoirId)) || null)
  ));
  const toSignature = entries => JSON.stringify(entries.map(entry => ({
    memoirId: entry?.memoirId,
    uid: entry?.uid,
    title: entry?.title,
    storyTime: entry?.storyTime,
    importance: entry?.importance,
    participants: entry?.participants,
    mainKeywords: entry?.mainKeywords,
    filterKeywords: entry?.filterKeywords,
    content: entry?.content,
    digest: entry?.digest,
  })));
  const previousSignature = toSignature(memoir.entries || []);
  const nextSignature = toSignature(nextEntries);
  const shouldResetSource = !greenEntries.length && !hasBlue;
  const sourceResetChanged = shouldResetSource
    && (memoir.sourceProcessed.length > 0 || memoir.overviewUid !== null);
  const changed = previousSignature !== nextSignature || sourceResetChanged;

  memoir.entries = nextEntries;
  if (shouldResetSource) {
    memoir.sourceProcessed = [];
    memoir.overviewUid = null;
  }
  if (changed) memoir.updatedAt = formatTimestamp();
  return changed;
}

/**
 * 以当前真实绑定世界书为事实源同步本地回忆索引。
 * 整本书被删除/解绑时清空旧 entries 与 sourceProcessed，但保留尚未写入的 pending。
 */
export async function reconcileMemoirWorldbookState({ api = getWorldbookApi() } = {}) {
  const memoir = getMemoirState();
  const currentBound = await api.getChatWorldbookName('current');
  const rawNames = await Promise.resolve(api.getWorldbookNames());
  const names = new Set(Array.isArray(rawNames) ? rawNames : []);
  const trackedName = String(memoir.worldbookName || '');

  if (!currentBound || !names.has(currentBound)) {
    const hadTrackedState = !!trackedName
      || memoir.entries.length > 0
      || memoir.sourceProcessed.length > 0
      || memoir.bindingDecision !== null;
    if (hadTrackedState) {
      resetMemoirBookState(memoir);
      saveChatState();
    }
    return { changed: hadTrackedState, reason: currentBound ? 'missing' : 'unbound', worldbookName: '' };
  }

  // 当前绑定尚未被本聊天确认时，不擅自把其他用户世界书接管为回忆录事实源。
  if (!trackedName || trackedName !== currentBound) {
    return { changed: false, reason: 'binding_unconfirmed', worldbookName: currentBound };
  }

  const book = await api.getWorldbook(currentBound);
  if (!Array.isArray(book)) {
    throw new Error(`读取世界书「${currentBound}」失败：返回结果不是条目数组。`);
  }
  const indexChanged = syncMemoirIndexFromBook(memoir, book);
  const blueRepaired = await repairManagedBlueContent(api, currentBound, book, memoir.entries);
  if (indexChanged) saveChatState();
  const changed = indexChanged || blueRepaired;
  return { changed, reason: changed ? 'synced' : 'unchanged', worldbookName: currentBound, blueRepaired };
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
  const rawNames = await Promise.resolve(api.getWorldbookNames());
  const names = new Set(Array.isArray(rawNames) ? rawNames : []);
  const rawCurrentBound = await api.getChatWorldbookName('current');
  const currentBound = rawCurrentBound && names.has(rawCurrentBound) ? rawCurrentBound : null;
  const previousTrackedName = String(memoir.worldbookName || '');
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

  const targetChanged = mode === 'new' || (!!previousTrackedName && previousTrackedName !== worldbookName);
  if (targetChanged || (rawCurrentBound && !currentBound)) {
    // 世界书切换、重建或绑定指向已删除名称时，旧索引不能污染新书；pending 仍保留。
    resetMemoirBookState(memoir, { clearBinding: false });
  }

  if (mode === 'existing') {
    const book = await api.getWorldbook(worldbookName);
    if (!Array.isArray(book)) {
      throw new Error(`读取世界书「${worldbookName}」失败：返回结果不是条目数组。`);
    }
    syncMemoirIndexFromBook(memoir, book);
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
