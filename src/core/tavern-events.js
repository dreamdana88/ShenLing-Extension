import { getContextSafe } from './chat.js';

export function getTavernEventsSafe() {
  const context = getContextSafe();
  return globalThis.tavern_events || context?.tavern_events || context?.event_types || {};
}

export function registerTavernEvent(eventName, handler) {
  if (!eventName || typeof handler !== 'function') return null;
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
