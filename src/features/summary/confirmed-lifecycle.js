import { GRAND_MEMORY_BLOCK_RE } from '../../constants.js';
import { getChatMessagesSafe } from '../../core/chat.js';
import {
  createMessageContentFingerprint,
  getAssistantMessageContentFingerprint,
} from '../../core/message-fingerprint.js';
import {
  getChatState,
  getContextInfo,
  getConfirmedSummaryTasks,
  saveChatState,
} from '../../core/settings.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';

export const CONFIRMED_SEND_CONTEXT_TTL_MS = 15_000;

const ACTIVE_TASK_STATUSES = new Set(['PENDING', 'RUNNING', 'FAILED']);
const lifecycleEventStops = [];
let lifecycleEventsRegistered = false;
let runtimeCoordinator = null;

function getMessageId(message, index) {
  const messageId = Number(message?.message_id ?? message?.id ?? index);
  return Number.isInteger(messageId) && messageId >= 0 ? messageId : index;
}

function createRecords(messages) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => ({
    message,
    index,
    messageId: getMessageId(message, index),
  }));
}

function getMessageRole(message) {
  if (message?.role) return String(message.role);
  return message?.is_user ? 'user' : 'assistant';
}

function getSelectedSwipeId(message) {
  const swipeId = Number(message?.swipe_id ?? 0);
  return Number.isInteger(swipeId) && swipeId >= 0 ? swipeId : 0;
}

function isVisibleAssistant(record) {
  const message = record?.message;
  return Boolean(
    message
    && getMessageRole(message) === 'assistant'
    && !message.is_hidden
    && !message.is_system
    && !message.extra?.isSmallSys
    && !GRAND_MEMORY_BLOCK_RE.test(String(message.message ?? message.mes ?? '')),
  );
}

function isVisibleUser(record) {
  const message = record?.message;
  return Boolean(
    message
    && getMessageRole(message) === 'user'
    && !message.is_hidden
    && !message.is_system
    && !message.extra?.isSmallSys,
  );
}

function resolvePayloadMessageId(payload) {
  const direct = Number(payload);
  if (Number.isInteger(direct) && direct >= 0) return direct;
  if (!payload || typeof payload !== 'object') return null;
  const candidate = Number(payload.message_id ?? payload.messageId ?? payload.id);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : null;
}

function createStableKey(parts) {
  let hash = 2166136261;
  const source = parts.join('\u001f');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `confirmed:v1:${(hash >>> 0).toString(36)}`;
}

export function createConfirmedTaskKey({
  chatIdentity,
  originalMessageId,
  assistantFingerprint,
  selectedSwipeId,
  confirmingUserFingerprint,
}) {
  return createStableKey([
    String(chatIdentity),
    String(originalMessageId),
    String(assistantFingerprint),
    String(selectedSwipeId),
    String(confirmingUserFingerprint),
  ]);
}

function getDefaultSnapshot() {
  const info = getContextInfo();
  return {
    chatIdentity: String(info.chatId || '').trim(),
    chatState: getChatState(),
    messages: getChatMessagesSafe(undefined, { hide_state: 'all' }),
  };
}

function createDefaultTimestamp(now) {
  return new Date(now).toISOString();
}

function hasMatchingAssistant(record, task, getAssistantFingerprint) {
  return isVisibleAssistant(record)
    && getSelectedSwipeId(record.message) === task.selectedSwipeId
    && getAssistantFingerprint(record.message) === task.assistantFingerprint;
}

function hasMatchingConfirmingUser(record, task, getUserFingerprint) {
  return Boolean(
    isVisibleUser(record)
    && getUserFingerprint(record.message) === task.confirmingUserFingerprint,
  );
}

export function createConfirmedLifecycleCoordinator(options = {}) {
  const getSnapshot = typeof options.getSnapshot === 'function'
    ? options.getSnapshot
    : getDefaultSnapshot;
  const persist = typeof options.saveChatState === 'function'
    ? options.saveChatState
    : saveChatState;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const createTimestamp = typeof options.createTimestamp === 'function'
    ? options.createTimestamp
    : createDefaultTimestamp;
  const getAssistantFingerprint = typeof options.getAssistantFingerprint === 'function'
    ? options.getAssistantFingerprint
    : getAssistantMessageContentFingerprint;
  const getUserFingerprint = typeof options.getUserFingerprint === 'function'
    ? options.getUserFingerprint
    : message => createMessageContentFingerprint(message?.message ?? message?.mes ?? '');
  const shouldCreateTask = typeof options.shouldCreateTask === 'function'
    ? options.shouldCreateTask
    : () => true;
  const onTaskCreated = typeof options.onTaskCreated === 'function'
    ? options.onTaskCreated
    : () => {};
  const contextTtlMs = Number.isFinite(options.contextTtlMs)
    ? Math.max(0, Number(options.contextTtlMs))
    : CONFIRMED_SEND_CONTEXT_TTL_MS;
  let pendingSendContext = null;
  const recoveredChatIdentities = new Set();

  function getCurrentSnapshot() {
    const snapshot = getSnapshot() || {};
    return {
      chatIdentity: String(snapshot.chatIdentity ?? '').trim(),
      chatState: snapshot.chatState || { summary: {} },
      records: createRecords(snapshot.messages),
    };
  }

  function getTasks(snapshot) {
    return getConfirmedSummaryTasks(snapshot.chatState);
  }

  function clearExpiredSendContext() {
    if (!pendingSendContext) return false;
    if (now() - pendingSendContext.capturedAt <= contextTtlMs) return false;
    pendingSendContext = null;
    return true;
  }

  function clearPendingSendContext() {
    const hadContext = pendingSendContext !== null;
    pendingSendContext = null;
    return hadContext;
  }

  function canCaptureGenerationAfterCommands(type, options, dryRun) {
    return (type === undefined || type === 'normal')
      && dryRun !== true
      && options?.automatic_trigger !== true;
  }

  function captureGenerationAfterCommands(type, options, dryRun) {
    clearPendingSendContext();
    if (!canCaptureGenerationAfterCommands(type, options, dryRun)) return false;
    const snapshot = getCurrentSnapshot();
    if (!snapshot.chatIdentity) return false;
    pendingSendContext = {
      chatIdentity: snapshot.chatIdentity,
      messageCount: snapshot.records.length,
      generationType: type === undefined ? 'normal' : type,
      capturedAt: now(),
    };
    return true;
  }

  function findLatestVisibleAssistantBefore(records, userIndex) {
    for (let index = userIndex - 1; index >= 0; index -= 1) {
      if (isVisibleAssistant(records[index])) return records[index];
    }
    return null;
  }

  function createConfirmedTaskFromMessageSent(payload) {
    clearExpiredSendContext();
    if (!pendingSendContext) return null;

    const snapshot = getCurrentSnapshot();
    if (snapshot.chatIdentity !== pendingSendContext.chatIdentity) {
      pendingSendContext = null;
      return null;
    }

    const tail = snapshot.records.at(-1);
    const payloadMessageId = resolvePayloadMessageId(payload);
    const isFreshTailUser = Boolean(
      tail
      && tail.index === pendingSendContext.messageCount
      && tail.messageId === payloadMessageId
      && isVisibleUser(tail),
    );
    pendingSendContext = null;
    if (!isFreshTailUser) return null;
    if (!shouldCreateTask()) return null;

    const confirmingUserFingerprint = getUserFingerprint(tail.message);
    const assistant = findLatestVisibleAssistantBefore(snapshot.records, tail.index);
    if (!confirmingUserFingerprint || !assistant) return null;

    const assistantFingerprint = getAssistantFingerprint(assistant.message);
    if (!assistantFingerprint) return null;
    const selectedSwipeId = getSelectedSwipeId(assistant.message);
    const taskKey = createConfirmedTaskKey({
      chatIdentity: snapshot.chatIdentity,
      originalMessageId: assistant.messageId,
      assistantFingerprint,
      selectedSwipeId,
      confirmingUserFingerprint,
    });
    const tasks = getTasks(snapshot);
    const existingTask = tasks.find(task => task.taskKey === taskKey);
    if (existingTask) return existingTask;

    const timestamp = createTimestamp(now());
    const task = {
      taskKey,
      chatIdentity: snapshot.chatIdentity,
      originalMessageId: assistant.messageId,
      assistantFingerprint,
      selectedSwipeId,
      confirmingUserMessageId: tail.messageId,
      confirmingUserFingerprint,
      status: 'PENDING',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    tasks.push(task);
    persist();
    onTaskCreated(task);
    return task;
  }

  function findRelocationMatches(records, task) {
    const lowerBound = Math.max(0, Math.min(task.originalMessageId, task.confirmingUserMessageId) - 2);
    const upperBound = Math.max(task.originalMessageId, task.confirmingUserMessageId) + 2;
    return records.filter(record => (
      record.messageId >= lowerBound
      && record.messageId <= upperBound
      && hasMatchingAssistant(record, task, getAssistantFingerprint)
      && hasMatchingConfirmingUser(records[record.index + 1], task, getUserFingerprint)
    ));
  }

  function reconcileCurrentChatTasks() {
    const snapshot = getCurrentSnapshot();
    if (!snapshot.chatIdentity) return { changed: false, cancelled: 0, relocated: 0 };
    const tasks = getTasks(snapshot);
    let changed = false;
    let cancelled = 0;
    let relocated = 0;
    const timestamp = createTimestamp(now());

    tasks.forEach(task => {
      if (task.chatIdentity !== snapshot.chatIdentity || !ACTIVE_TASK_STATUSES.has(task.status)) return;
      const original = snapshot.records.find(record => record.messageId === task.originalMessageId);
      const originalConfirmation = original ? snapshot.records[original.index + 1] : null;
      if (
        hasMatchingAssistant(original, task, getAssistantFingerprint)
        && hasMatchingConfirmingUser(originalConfirmation, task, getUserFingerprint)
      ) {
        if (task.confirmingUserMessageId !== originalConfirmation.messageId) {
          task.confirmingUserMessageId = originalConfirmation.messageId;
          task.updatedAt = timestamp;
          changed = true;
        }
        return;
      }

      const matches = findRelocationMatches(snapshot.records, task);
      if (matches.length === 1) {
        const match = matches[0];
        const confirmingUser = snapshot.records[match.index + 1];
        if (
          task.originalMessageId !== match.messageId
          || task.confirmingUserMessageId !== confirmingUser.messageId
        ) {
          task.originalMessageId = match.messageId;
          task.confirmingUserMessageId = confirmingUser.messageId;
          task.updatedAt = timestamp;
          changed = true;
          relocated += 1;
        }
        return;
      }

      task.status = 'CANCELLED';
      task.updatedAt = timestamp;
      changed = true;
      cancelled += 1;
    });

    if (changed) persist();
    return { changed, cancelled, relocated };
  }

  function recoverCurrentChatTasks() {
    const snapshot = getCurrentSnapshot();
    const before = JSON.stringify(snapshot.chatState?.summary?.confirmedTasks ?? []);
    const tasks = getTasks(snapshot);
    const isFirstRecoveryForChat = snapshot.chatIdentity
      && !recoveredChatIdentities.has(snapshot.chatIdentity);
    let runningRecoveryChanged = false;
    if (isFirstRecoveryForChat) {
      const timestamp = createTimestamp(now());
      tasks.forEach(task => {
        if (task.chatIdentity !== snapshot.chatIdentity || task.status !== 'RUNNING') return;
        task.status = 'PENDING';
        task.updatedAt = timestamp;
        runningRecoveryChanged = true;
      });
      recoveredChatIdentities.add(snapshot.chatIdentity);
    }
    const normalized = JSON.stringify(snapshot.chatState?.summary?.confirmedTasks ?? []);
    const recoveryChanged = runningRecoveryChanged || before !== normalized;
    if (recoveryChanged) persist();
    const reconciliation = reconcileCurrentChatTasks();
    return { changed: recoveryChanged || reconciliation.changed, ...reconciliation };
  }

  function handleChatChanged() {
    pendingSendContext = null;
    return recoverCurrentChatTasks();
  }

  return {
    captureGenerationAfterCommands,
    createConfirmedTaskFromMessageSent,
    reconcileCurrentChatTasks,
    recoverCurrentChatTasks,
    handleChatChanged,
    clearPendingSendContext,
    clearExpiredSendContext,
    getPendingSendContext: () => pendingSendContext && { ...pendingSendContext },
  };
}

export function synchronizeConfirmedTaskAfterReplacement(messageId) {
  const chatState = getChatState();
  const task = getConfirmedSummaryTasks(chatState).find(item => (
    item.status === 'PENDING' && Number(item.originalMessageId) === Number(messageId)
  ));
  const message = getChatMessagesSafe(Number(messageId), { hide_state: 'all' })[0];
  if (!task || !message || getSelectedSwipeId(message) !== task.selectedSwipeId) return false;
  const fingerprint = getAssistantMessageContentFingerprint(message);
  if (!fingerprint || fingerprint === task.assistantFingerprint) return false;
  task.assistantFingerprint = fingerprint;
  task.updatedAt = createDefaultTimestamp(Date.now());
  saveChatState();
  return true;
}

export function registerConfirmedLifecycleEvents(options = {}) {
  if (lifecycleEventsRegistered) return true;
  runtimeCoordinator = createConfirmedLifecycleCoordinator(options);
  runtimeCoordinator.recoverCurrentChatTasks();

  const events = getTavernEventsSafe();
  if (!events.GENERATION_AFTER_COMMANDS || !events.MESSAGE_SENT) {
    console.warn('[蜃灵助手] 未发现 confirmed 生命周期所需事件，已跳过任务捕获。');
    return false;
  }

  const registrations = [
    [events.GENERATION_STARTED, () => runtimeCoordinator.clearPendingSendContext()],
    [events.GENERATION_AFTER_COMMANDS, (type, options, dryRun) => runtimeCoordinator.captureGenerationAfterCommands(type, options, dryRun)],
    [events.MESSAGE_SENT, payload => runtimeCoordinator.createConfirmedTaskFromMessageSent(payload)],
    [events.CHAT_CHANGED, () => runtimeCoordinator.handleChatChanged()],
    [events.MESSAGE_EDITED, () => runtimeCoordinator.reconcileCurrentChatTasks()],
    [events.MESSAGE_UPDATED, () => runtimeCoordinator.reconcileCurrentChatTasks()],
    [events.MESSAGE_DELETED, () => runtimeCoordinator.reconcileCurrentChatTasks()],
  ];
  const registeredEventNames = new Set();
  registrations.forEach(([eventName, handler]) => {
    if (!eventName || registeredEventNames.has(eventName)) return;
    registeredEventNames.add(eventName);
    const stop = registerTavernEvent(eventName, handler);
    if (stop) lifecycleEventStops.push(stop);
  });

  lifecycleEventsRegistered = lifecycleEventStops.length > 0;
  return lifecycleEventsRegistered;
}
