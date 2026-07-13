import {
  getTavernEventsSafe,
  registerTavernEvent,
} from './tavern-events.js';

const pendingCommitHandlers = new Map();
let pendingCommitEventStop = null;

export function registerPendingCommitHandler(id, handler) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId || typeof handler !== 'function') return () => {};
  pendingCommitHandlers.set(normalizedId, handler);
  return () => {
    if (pendingCommitHandlers.get(normalizedId) === handler) {
      pendingCommitHandlers.delete(normalizedId);
    }
  };
}

export function getPendingCommitHandlerIds() {
  return [...pendingCommitHandlers.keys()];
}

export async function runPendingCommitHandlers(handlerEntries = [], context = {}) {
  const entries = Array.isArray(handlerEntries) ? handlerEntries : [];
  const results = [];

  for (const entry of entries) {
    const id = String(Array.isArray(entry) ? entry[0] : entry?.id || '').trim();
    const handler = Array.isArray(entry) ? entry[1] : entry?.handler;
    if (!id || typeof handler !== 'function') continue;
    try {
      const value = await handler(context);
      results.push({ id, status: 'fulfilled', value });
    } catch (error) {
      results.push({
        id,
        status: 'rejected',
        error: error?.message || String(error),
      });
    }
  }
  return results;
}

export function commitSelectedPendingUpdates(context = {}) {
  return runPendingCommitHandlers([...pendingCommitHandlers.entries()], context);
}

function schedulePendingCommit(payload) {
  void commitSelectedPendingUpdates({ payload }).then(results => {
    results
      .filter(result => result.status === 'rejected')
      .forEach(result => {
        console.warn(`[蜃灵助手] pending 提交处理器「${result.id}」执行失败：${result.error}`);
      });
  });
}

export function registerPendingCommitEvents() {
  if (pendingCommitEventStop) return true;
  const eventName = getTavernEventsSafe().MESSAGE_SENT;
  const stop = registerTavernEvent(eventName, schedulePendingCommit);
  if (!stop) return false;
  pendingCommitEventStop = stop;
  return true;
}

export function isPendingCommitEventRegistered() {
  return Boolean(pendingCommitEventStop);
}
