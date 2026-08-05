import { getContextInfo } from './settings.js';

/**
 * Lean Chat Scope Guard (Phase 5A-1).
 *
 * Runtime-only helper: identity + chat-switch epoch.
 * Does not store Feature state, model results, or tasks.
 */

export const CHAT_SCOPE_REASON = Object.freeze({
  CHAT_SCOPE_CHANGED: 'CHAT_SCOPE_CHANGED',
  CHAT_SCOPE_UNAVAILABLE: 'CHAT_SCOPE_UNAVAILABLE',
});

let chatSwitchEpoch = 0;

export function buildChatIdentityKey(characterId, chatId) {
  const character = String(characterId || '').trim();
  const chat = String(chatId || '').trim();
  if (!character || !chat) return '';
  return `${character}\u001f${chat}`;
}

export function getChatSwitchEpoch() {
  return chatSwitchEpoch;
}

/** Bump epoch on CHAT_CHANGED so A→B→A invalidates in-flight tasks. */
export function markChatScopeChanged() {
  chatSwitchEpoch += 1;
  return chatSwitchEpoch;
}

/** Test-only reset. Not used by production Feature code. */
export function resetChatScopeEpochForTests(value = 0) {
  chatSwitchEpoch = Number.isFinite(Number(value)) ? Number(value) : 0;
  return chatSwitchEpoch;
}

/**
 * Capture an immutable scope snapshot for a manual long-running task.
 * Fail closed: empty identityKey means unavailable (do not start work).
 */
export function captureChatScope(info = getContextInfo()) {
  const characterId = String(info?.characterId || '').trim();
  const chatId = String(info?.chatId || '').trim();
  return Object.freeze({
    characterId,
    chatId,
    identityKey: buildChatIdentityKey(characterId, chatId),
    epoch: chatSwitchEpoch,
    capturedAt: Date.now(),
  });
}

export function isChatScopeAvailable(scope) {
  return Boolean(scope && typeof scope === 'object' && String(scope.identityKey || '').trim());
}

/**
 * Compare captured scope against current identity + epoch.
 * Empty current identity is also fail-closed (never matches).
 */
export function evaluateChatScope(
  scope,
  info = getContextInfo(),
  epoch = chatSwitchEpoch,
) {
  if (!isChatScopeAvailable(scope)) {
    return Object.freeze({
      valid: false,
      reason: CHAT_SCOPE_REASON.CHAT_SCOPE_UNAVAILABLE,
    });
  }

  const currentKey = buildChatIdentityKey(info?.characterId, info?.chatId);
  if (!currentKey) {
    return Object.freeze({
      valid: false,
      reason: CHAT_SCOPE_REASON.CHAT_SCOPE_UNAVAILABLE,
    });
  }

  if (
    scope.identityKey !== currentKey
    || Number(scope.epoch) !== Number(epoch)
  ) {
    return Object.freeze({
      valid: false,
      reason: CHAT_SCOPE_REASON.CHAT_SCOPE_CHANGED,
    });
  }

  return Object.freeze({ valid: true, reason: null });
}

export function isChatScopeValid(scope, info = getContextInfo(), epoch = chatSwitchEpoch) {
  return evaluateChatScope(scope, info, epoch).valid;
}
