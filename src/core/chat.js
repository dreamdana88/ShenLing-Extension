export function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getTavernHelperChatCapability(name) {
  const tavernHelper = globalThis.TavernHelper;
  if (typeof tavernHelper?.[name] === 'function') {
    return tavernHelper[name].bind(tavernHelper);
  }

  // TavernHelper 会把同一组函数直接注入其 iframe；保留该已确认的暴露形式，
  // 但只有 TavernHelper 对象缺少对应能力时才会选择它。
  if (typeof globalThis[name] === 'function') {
    return globalThis[name].bind(globalThis);
  }

  return null;
}

function getCompatibilityContext(capabilityName) {
  const context = getContextSafe();
  if (!context || !Array.isArray(context.chat)) {
    throw new Error(`当前环境未发现 ${capabilityName}，且 SillyTavern Compatibility 聊天数据不可用。`);
  }
  return context;
}

export function normalizeChatMessage(message, index = 0) {
  if (!message) return null;
  const messageId = Number(message.message_id ?? message.id ?? index);
  const rawMessage = message.message ?? message.mes ?? message.content ?? '';
  const role = message.role || (message.is_user ? 'user' : 'assistant');
  return {
    ...message,
    message_id: Number.isFinite(messageId) ? messageId : index,
    role,
    message: String(rawMessage || ''),
    is_hidden: Boolean(message.is_hidden ?? message.is_system ?? message.extra?.isSmallSys),
  };
}

function resolveCompatibilityRange(range, lastMessageId) {
  if (range === undefined) return { from: 0, to: lastMessageId };

  const demacroed = String(range).replaceAll('{{lastMessageId}}', String(lastMessageId));
  const match = demacroed.match(/^(-?\d+)(?:-(-?\d+))?$/);
  if (!match || lastMessageId < 0) return null;

  const normalizeId = value => {
    const numeric = Number(value);
    const resolved = numeric < 0 ? lastMessageId + numeric + 1 : numeric;
    return Math.min(Math.max(resolved, 0), lastMessageId);
  };
  const first = normalizeId(match[1]);
  const second = normalizeId(match[2] ?? match[1]);
  return { from: Math.min(first, second), to: Math.max(first, second) };
}

function getCompatibilityChatMessages(range, options) {
  const context = getCompatibilityContext('getChatMessages');
  const resolvedRange = resolveCompatibilityRange(range, context.chat.length - 1);
  if (!resolvedRange) return [];

  const { role = 'all', hide_state: hideState = 'all' } = options;
  return context.chat
    .map((message, index) => normalizeChatMessage(message, index))
    .filter(Boolean)
    .filter(message => message.message_id >= resolvedRange.from && message.message_id <= resolvedRange.to)
    .filter(message => role === 'all' || message.role === role)
    .filter(message => (
      hideState === 'all'
      || (hideState === 'hidden' && message.is_hidden)
      || (hideState === 'unhidden' && !message.is_hidden)
    ));
}

export function getChatMessagesSafe(range, options = {}) {
  const getChatMessages = getTavernHelperChatCapability('getChatMessages');
  if (getChatMessages) {
    const actualRange = range ?? '0-{{lastMessageId}}';
    const result = getChatMessages(actualRange, options);
    if (!Array.isArray(result)) {
      throw new TypeError('TavernHelper.getChatMessages 未返回消息数组。');
    }
    return result.map(normalizeChatMessage).filter(Boolean);
  }

  return getCompatibilityChatMessages(range, options);
}

export function getChatMessageById(messageId) {
  return getChatMessagesSafe(Number(messageId), { hide_state: 'all' })[0] || null;
}

export function getLastMessageId() {
  const getLastMessageIdFunction = getTavernHelperChatCapability('getLastMessageId');
  if (getLastMessageIdFunction) {
    const messageId = Number(getLastMessageIdFunction());
    if (!Number.isInteger(messageId)) {
      throw new TypeError('TavernHelper.getLastMessageId 未返回整数楼层号。');
    }
    if (messageId === 0) {
      const getChatMessages = getTavernHelperChatCapability('getChatMessages');
      if (getChatMessages) {
        const firstMessage = getChatMessages(0, { hide_state: 'all' });
        if (!Array.isArray(firstMessage)) {
          throw new TypeError('TavernHelper.getChatMessages 未返回消息数组。');
        }
        if (firstMessage.length === 0) return -1;
      }
    }
    return messageId;
  }

  return getCompatibilityContext('getLastMessageId').chat.length - 1;
}

export function isLatestMessage(messageId) {
  return Number(messageId) === getLastMessageId();
}

async function saveCompatibilityChat(context) {
  if (typeof context.saveChat !== 'function') {
    throw new Error('SillyTavern Compatibility Provider 缺少 saveChat，无法持久化聊天。');
  }
  await context.saveChat();
}

async function refreshCompatibilityMessages(context, messageIds, refresh = 'affected') {
  if (refresh === 'none') return;
  if (refresh === 'all') {
    if (typeof context.reloadCurrentChat !== 'function') {
      throw new Error('SillyTavern Compatibility Provider 缺少 reloadCurrentChat，无法刷新聊天。');
    }
    await context.reloadCurrentChat();
    return;
  }

  const refreshOneMessage = getTavernHelperChatCapability('refreshOneMessage');
  if (refreshOneMessage) {
    await Promise.all(messageIds.map(messageId => refreshOneMessage(Number(messageId))));
    return;
  }

  if (typeof context.reloadCurrentChat !== 'function') {
    throw new Error('当前环境未发现 refreshOneMessage，且 SillyTavern Compatibility 刷新能力不可用。');
  }
  await context.reloadCurrentChat();
}

export async function refreshChatMessageDisplay(messageId) {
  const refreshOneMessage = getTavernHelperChatCapability('refreshOneMessage');
  if (refreshOneMessage) {
    await refreshOneMessage(Number(messageId));
    return;
  }

  const context = getCompatibilityContext('refreshOneMessage');
  await refreshCompatibilityMessages(context, [Number(messageId)], 'affected');
}

function applyCompatibilityMessageUpdate(rawMessage, update) {
  if (Object.hasOwn(update, 'message')) {
    rawMessage.mes = update.message;
    rawMessage.message = update.message;
    if (Array.isArray(rawMessage.swipes)) {
      rawMessage.swipes[Number(rawMessage.swipe_id ?? 0)] = update.message;
    }
  }
  if (Object.hasOwn(update, 'is_hidden')) {
    rawMessage.is_system = Boolean(update.is_hidden);
    rawMessage.is_hidden = Boolean(update.is_hidden);
  }
}

async function setChatMessagesWithCompatibility(updates, options = {}) {
  const context = getCompatibilityContext('setChatMessages');
  const affectedIds = [];
  updates.forEach(update => {
    const messageId = Number(update.message_id);
    const rawMessage = context.chat[messageId];
    if (!rawMessage) return;
    applyCompatibilityMessageUpdate(rawMessage, update);
    affectedIds.push(messageId);
  });

  await saveCompatibilityChat(context);
  await refreshCompatibilityMessages(context, affectedIds, options.refresh ?? 'affected');
}

export async function setChatMessageContent(messageId, message) {
  const numericMessageId = Number(messageId);
  const setChatMessages = getTavernHelperChatCapability('setChatMessages');
  if (setChatMessages) {
    await setChatMessages([{ message_id: numericMessageId, message }], { refresh: 'affected' });
    return;
  }

  await setChatMessagesWithCompatibility([{ message_id: numericMessageId, message }], { refresh: 'affected' });
}

async function createAssistantMessageWithCompatibility(message) {
  const context = getCompatibilityContext('createChatMessages');
  const messageId = context.chat.length;
  const rawMessage = {
    name: context.name2 || 'Assistant',
    is_user: false,
    is_system: false,
    mes: message,
    message,
  };
  context.chat.push(rawMessage);

  await saveCompatibilityChat(context);
  if (typeof context.addOneMessage === 'function') {
    context.addOneMessage(rawMessage);
    const eventTypes = context.eventTypes || context.event_types;
    if (typeof context.eventSource?.emit === 'function') {
      if (eventTypes?.MESSAGE_RECEIVED) {
        await context.eventSource.emit(eventTypes.MESSAGE_RECEIVED, messageId, 'extension');
      }
      if (eventTypes?.CHARACTER_MESSAGE_RENDERED) {
        await context.eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, messageId);
      }
    }
    return messageId;
  }

  await refreshCompatibilityMessages(context, [messageId], 'affected');
  return messageId;
}

export async function createAssistantChatMessage(message) {
  const createChatMessages = getTavernHelperChatCapability('createChatMessages');
  if (createChatMessages) {
    await createChatMessages([{ role: 'assistant', message }], { insert_before: 'end', refresh: 'affected' });
    return getLastMessageId();
  }

  return createAssistantMessageWithCompatibility(message);
}

export async function setChatMessagesPartial(updates, options = { refresh: 'affected' }) {
  const setChatMessages = getTavernHelperChatCapability('setChatMessages');
  if (setChatMessages) {
    await setChatMessages(updates, options);
    return;
  }

  await setChatMessagesWithCompatibility(updates, options);
}

export function createMessageIdRange(from, to) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function formatMessageIdList(ids) {
  return ids.length > 10 ? `${ids.slice(0, 10).join('、')} 等 ${ids.length} 楼` : ids.join('、');
}
