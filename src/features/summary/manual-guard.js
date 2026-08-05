import {
  captureChatScope,
  evaluateChatScope,
  isChatScopeAvailable,
} from '../../core/chat-scope.js';
import {
  getChatState,
  getContextInfo,
  saveChatState,
} from '../../core/settings.js';
import {
  notifySummary,
  refreshSummaryPanelAfterAction,
} from './runtime.js';
import { clearSummaryWriteIgnored } from './state.js';

/** Manual long-task target / scope mismatch codes (not Generation failures). */
export const MANUAL_CHAT_GUARD_REASON = Object.freeze({
  CHAT_SCOPE_CHANGED: 'CHAT_SCOPE_CHANGED',
  CHAT_SCOPE_UNAVAILABLE: 'CHAT_SCOPE_UNAVAILABLE',
  CHAT_TARGET_CHANGED: 'CHAT_TARGET_CHANGED',
});

export const MANUAL_TARGET_DISCARD_MESSAGE = '目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。';

export function captureManualChatScopeOrThrow(guardChatScope) {
  if (!guardChatScope) return null;
  const scope = captureChatScope();
  if (!isChatScopeAvailable(scope)) {
    const error = new Error('当前聊天身份不可用，无法启动手动总结。');
    error.code = MANUAL_CHAT_GUARD_REASON.CHAT_SCOPE_UNAVAILABLE;
    throw error;
  }
  return scope;
}

export function evaluateManualChatGuards(scope, isTargetValid = null) {
  if (!scope) return { ok: true, reason: null };
  const scopeResult = evaluateChatScope(scope);
  if (!scopeResult.valid) {
    return { ok: false, reason: scopeResult.reason };
  }
  if (typeof isTargetValid === 'function' && !isTargetValid()) {
    return { ok: false, reason: MANUAL_CHAT_GUARD_REASON.CHAT_TARGET_CHANGED };
  }
  return { ok: true, reason: null };
}

/**
 * Scope mismatch: silent discard (no toast, no write to current or left chat).
 * Target mismatch while still in original chat: clear runningTask + neutral lastError.
 */
export function finalizeManualGuardDiscard(reason, {
  scope = null,
  title = '手动总结',
  clearIgnoredMessageId = null,
  clearIgnoredChatId = null,
  onTargetDiscard = null,
} = {}) {
  if (clearIgnoredMessageId !== null && clearIgnoredMessageId !== undefined) {
    // Prefer the original task chatId so we never clear B's ignore key by accident.
    const chatIdentity = clearIgnoredChatId
      ?? (scope && Object.hasOwn(scope, 'chatId') ? scope.chatId : undefined)
      ?? getContextInfo().chatId;
    clearSummaryWriteIgnored(Number(clearIgnoredMessageId), chatIdentity);
  }
  if (
    reason === MANUAL_CHAT_GUARD_REASON.CHAT_SCOPE_CHANGED
    || reason === MANUAL_CHAT_GUARD_REASON.CHAT_SCOPE_UNAVAILABLE
  ) {
    return { discarded: true, silent: true };
  }
  if (reason === MANUAL_CHAT_GUARD_REASON.CHAT_TARGET_CHANGED) {
    if (scope && evaluateChatScope(scope).valid) {
      if (typeof onTargetDiscard === 'function') {
        onTargetDiscard();
      } else {
        const chatState = getChatState();
        chatState.summary.runningTask = 'none';
        chatState.summary.lastError = MANUAL_TARGET_DISCARD_MESSAGE;
        saveChatState();
      }
      notifySummary('warning', MANUAL_TARGET_DISCARD_MESSAGE, title);
      refreshSummaryPanelAfterAction();
    }
    return { discarded: true, silent: false };
  }
  return { discarded: false, silent: false };
}
