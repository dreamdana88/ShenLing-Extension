import { getContextSafe } from './chat.js';

export function getTavernEventsSafe() {
  const context = getContextSafe();
  return globalThis.tavern_events
    || globalThis.TavernHelper?.tavern_events
    || context?.eventTypes
    || context?.tavern_events
    || context?.event_types
    || {};
}

export function registerTavernEvent(eventName, handler) {
  if (!eventName || typeof handler !== 'function') return null;

  if (typeof globalThis.eventOn === 'function') {
    return globalThis.eventOn(eventName, handler);
  }

  const context = getContextSafe();
  if (context?.eventSource?.on) {
    context.eventSource.on(eventName, handler);
    return {
      stop: () => {
        if (typeof context.eventSource.removeListener === 'function') {
          context.eventSource.removeListener(eventName, handler);
          return;
        }
        context.eventSource.off?.(eventName, handler);
      },
    };
  }

  let eventSource = globalThis.eventSource || null;
  if (!eventSource) {
    try {
      eventSource = globalThis.parent?.eventSource || null;
    } catch {
      // 跨域 parent 仅代表该兼容能力不可用，不吞掉已选 Provider 的注册错误。
    }
  }
  if (eventSource?.on) {
    eventSource.on(eventName, handler);
    return {
      stop: () => {
        if (typeof eventSource.removeListener === 'function') {
          eventSource.removeListener(eventName, handler);
          return;
        }
        eventSource.off?.(eventName, handler);
      },
    };
  }
  return null;
}
