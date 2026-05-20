export function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

export function getGlobalFunction(name) {
  const context = getContextSafe();
  return globalThis[name] || globalThis.TavernHelper?.[name] || context?.[name] || null;
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

export function getChatMessagesSafe(range, options = {}) {
  const getChatMessages = getGlobalFunction('getChatMessages');
  if (typeof getChatMessages === 'function') {
    try {
      const getLastMessageIdFunction = getGlobalFunction('getLastMessageId');
      const actualRange = range === undefined && typeof getLastMessageIdFunction === 'function'
        ? `0-${Number(getLastMessageIdFunction())}`
        : range;
      if (actualRange === undefined) throw new Error('未提供聊天范围，转用 context.chat。');
      const result = getChatMessages(actualRange, options);
      return Array.isArray(result) ? result.map(normalizeChatMessage).filter(Boolean) : [];
    } catch (error) {
      console.warn('[蜃灵助手] getChatMessages 调用失败，尝试读取 context.chat。', error);
    }
  }

  const context = getContextSafe();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const normalized = chat.map((message, index) => normalizeChatMessage(message, index)).filter(Boolean);
  if (typeof range === 'number') {
    return normalized.filter(message => message.message_id === range);
  }
  if (typeof range === 'string' && /^\d+-\d+$/.test(range)) {
    const [from, to] = range.split('-').map(Number);
    return normalized.filter(message => message.message_id >= from && message.message_id <= to);
  }
  return normalized;
}

export function getChatMessageById(messageId) {
  return getChatMessagesSafe(Number(messageId), { hide_state: 'all' })[0] || null;
}

export function getLastMessageId() {
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' });
  return messages.length ? Math.max(...messages.map(message => message.message_id)) : -1;
}

export function isLatestMessage(messageId) {
  return Number(messageId) === getLastMessageId();
}

export async function refreshChatMessageDisplay(messageId) {
  const refreshOneMessage = getGlobalFunction('refreshOneMessage');
  if (typeof refreshOneMessage === 'function') {
    await refreshOneMessage(Number(messageId));
  }
}

export async function setChatMessageContent(messageId, message) {
  const numericMessageId = Number(messageId);
  const setChatMessages = getGlobalFunction('setChatMessages');
  if (typeof setChatMessages === 'function') {
    await setChatMessages([{ message_id: numericMessageId, message }], { refresh: 'affected' });
    await refreshChatMessageDisplay(numericMessageId);
    return;
  }

  const context = getContextSafe();
  if (Array.isArray(context?.chat) && context.chat[numericMessageId]) {
    if ('mes' in context.chat[numericMessageId]) {
      context.chat[numericMessageId].mes = message;
    } else {
      context.chat[numericMessageId].message = message;
    }
    const saveChatConditional = getGlobalFunction('saveChatConditional');
    if (typeof saveChatConditional === 'function') {
      await saveChatConditional();
    } else if (typeof context.saveChat === 'function') {
      await context.saveChat();
    }
    await refreshChatMessageDisplay(numericMessageId);
    return;
  }

  throw new Error('当前环境未发现 setChatMessages，无法写回聊天楼层。');
}

export async function createAssistantChatMessage(message) {
  const createChatMessages = getGlobalFunction('createChatMessages');
  if (typeof createChatMessages === 'function') {
    await createChatMessages([{ role: 'assistant', message }], { insert_before: 'end', refresh: 'affected' });
    return getLastMessageId();
  }

  const context = getContextSafe();
  if (Array.isArray(context?.chat)) {
    const nextId = context.chat.length;
    context.chat.push({ name: context.name2 || 'Assistant', is_user: false, role: 'assistant', mes: message, message });
    const saveChatConditional = getGlobalFunction('saveChatConditional');
    if (typeof saveChatConditional === 'function') await saveChatConditional();
    else if (typeof context.saveChat === 'function') await context.saveChat();
    await refreshChatMessageDisplay(nextId);
    return nextId;
  }

  throw new Error('当前环境未发现 createChatMessages，无法创建大总结楼。');
}

export async function setChatMessagesPartial(updates, options = { refresh: 'affected' }) {
  const setChatMessages = getGlobalFunction('setChatMessages');
  if (typeof setChatMessages === 'function') {
    await setChatMessages(updates, options);
    if (options.refresh === 'affected') {
      await Promise.all(updates.map(update => refreshChatMessageDisplay(update.message_id)));
    }
    return;
  }

  const context = getContextSafe();
  if (Array.isArray(context?.chat)) {
    updates.forEach(update => {
      const message = context.chat[Number(update.message_id)];
      if (!message) return;
      Object.assign(message, update);
      if (Object.hasOwn(update, 'message')) message.mes = update.message;
    });
    const saveChatConditional = getGlobalFunction('saveChatConditional');
    if (typeof saveChatConditional === 'function') await saveChatConditional();
    else if (typeof context.saveChat === 'function') await context.saveChat();
    return;
  }

  throw new Error('当前环境未发现 setChatMessages，无法批量更新聊天楼层。');
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
