import { getContextSafe, getChatMessagesSafe } from '../../core/chat.js';
import { createMessageContentFingerprint, getAssistantMessageContentFingerprint } from '../../core/message-fingerprint.js';
import { getChatState, getConfirmedSummaryTasks, getContextInfo, saveChatState } from '../../core/settings.js';
import { getTavernEventsSafe, registerTavernEvent } from '../../core/tavern-events.js';
import { getAutoSummaryFingerprint, shouldRunAutoSummary } from './workflow.js';

const consumerEventStops = [];
let consumerEventsRegistered = false;
let runtimeConsumer = null;
const GENERATION_GATE_IDLE_RECOVERY_INTERVAL_MS = 250;
const MAX_GENERATION_GATE_IDLE_RECOVERY_CHECKS = 3;

function nowTimestamp() {
  return new Date().toISOString();
}

function getChatIdentity() {
  return String(getContextInfo().chatId || '').trim();
}

function isValidUser(message) {
  return message?.role === 'user' && !message.is_hidden && !message.is_system && !message.extra?.isSmallSys;
}

function isCurrentTaskTarget(task) {
  const messages = getChatMessagesSafe(undefined, { hide_state: 'all' });
  const assistant = messages.find(message => Number(message.message_id) === Number(task.originalMessageId));
  const confirmingUser = messages.find(message => Number(message.message_id) === Number(task.confirmingUserMessageId));
  return Boolean(
    assistant?.role === 'assistant'
    && !assistant.is_hidden
    && Number(assistant.swipe_id ?? 0) === Number(task.selectedSwipeId)
    && getAssistantMessageContentFingerprint(assistant) === task.assistantFingerprint
    && isValidUser(confirmingUser)
    && createMessageContentFingerprint(confirmingUser.message) === task.confirmingUserFingerprint,
  );
}

function defaultIsGenerating() {
  const context = getContextSafe();
  const probe = context?.isGenerating || globalThis.isGenerating;
  return typeof probe === 'function' ? probe() === true : false;
}

export function createConfirmedSummaryConsumer(options = {}) {
  const getState = options.getChatState || getChatState;
  const saveState = options.saveChatState || saveChatState;
  const getIdentity = options.getChatIdentity || getChatIdentity;
  const isGenerating = options.isGenerating || defaultIsGenerating;
  const isEnabled = options.isEnabled || shouldRunAutoSummary;
  const isTargetValid = options.isTargetValid || isCurrentTaskTarget;
  const getSummaryFingerprint = options.getSummaryFingerprint || getAutoSummaryFingerprint;
  const generate = options.generate;
  const write = options.write;
  const onSummaryCommitted = options.onSummaryCommitted;
  const now = options.now || Date.now;
  const formatTimestamp = options.formatTimestamp || nowTimestamp;
  const defer = options.defer || (callback => window.setTimeout(callback, 0));
  const maxIdleDefers = Number.isInteger(options.maxIdleDefers) ? options.maxIdleDefers : 3;
  const generationIdleRecoveryIntervalMs = Number.isFinite(options.generationIdleRecoveryIntervalMs)
    ? Math.max(1, Number(options.generationIdleRecoveryIntervalMs))
    : GENERATION_GATE_IDLE_RECOVERY_INTERVAL_MS;
  const scheduleGenerationIdleRecoveryCheck = options.scheduleGenerationIdleRecoveryCheck
    || ((callback, delay) => window.setTimeout(callback, delay));
  const maxGenerationIdleRecoveryChecks = Number.isInteger(options.maxGenerationIdleRecoveryChecks)
    ? Math.max(1, options.maxGenerationIdleRecoveryChecks)
    : MAX_GENERATION_GATE_IDLE_RECOVERY_CHECKS;
  let scheduled = false;
  let running = false;
  let idleDefers = 0;
  let sequence = 0;
  const deferredRecoveries = new Map();
  const generationGates = new Map();
  const activeGenerationAttempts = new Map();
  const cancelledExecutionTokens = new Set();
  let activeExecution = null;
  let generationIdleRecoveryScheduled = false;
  let generationAttemptSequence = 0;

  function createExecutionKey(chatIdentity, taskKey, executionToken) {
    return [chatIdentity, taskKey, executionToken].join('\u001f');
  }

  function hasCancellationIntent(chatIdentity, taskKey, executionToken) {
    return cancelledExecutionTokens.has(createExecutionKey(chatIdentity, taskKey, executionToken));
  }

  function clearCancellationIntent(chatIdentity, taskKey, executionToken) {
    cancelledExecutionTokens.delete(createExecutionKey(chatIdentity, taskKey, executionToken));
  }

  function cancelTask(task, reasonCode = '') {
    task.status = 'CANCELLED';
    task.updatedAt = formatTimestamp();
    delete task.executionToken;
    generationGates.delete(task.taskKey);
    if (reasonCode) task.reasonCode = reasonCode;
  }

  function holdConfirmedTaskUntilGenerationTerminal(task) {
    if (!task?.taskKey || !task.chatIdentity || task.status !== 'PENDING') return false;
    const attempt = activeGenerationAttempts.get(task.chatIdentity);
    if (!attempt) return false;
    generationGates.set(task.taskKey, {
      chatIdentity: task.chatIdentity,
      generationAttemptId: attempt.id,
      idleRecoveryChecks: 0,
    });
    scheduleGenerationIdleRecovery();
    return true;
  }

  function isAwaitingGenerationTerminal(task) {
    return generationGates.has(task?.taskKey);
  }

  function scheduleGenerationIdleRecovery() {
    if (generationIdleRecoveryScheduled) return false;
    generationIdleRecoveryScheduled = true;
    scheduleGenerationIdleRecoveryCheck(() => {
      generationIdleRecoveryScheduled = false;
      recoverAwaitingGenerationAfterIdle();
    }, generationIdleRecoveryIntervalMs);
    return true;
  }

  function handleMainGenerationStarted() {
    const identity = getIdentity();
    if (!identity) return false;
    activeGenerationAttempts.set(identity, {
      id: `generation:${++generationAttemptSequence}`,
    });
    return true;
  }

  function handleMainGenerationTerminal() {
    const identity = getIdentity();
    const attempt = activeGenerationAttempts.get(identity);
    if (!attempt) return false;
    activeGenerationAttempts.delete(identity);
    let released = false;
    generationGates.forEach((gate, taskKey) => {
      if (gate.chatIdentity !== identity || gate.generationAttemptId !== attempt.id) return;
      generationGates.delete(taskKey);
      released = true;
    });
    if (released) scheduleConfirmedQueueDrain();
    return released;
  }

  function recoverAwaitingGenerationAfterIdle() {
    const identity = getIdentity();
    let awaitingFurtherRecovery = false;
    let released = false;
    const attempt = activeGenerationAttempts.get(identity);
    generationGates.forEach((gate, taskKey) => {
      if (gate.chatIdentity !== identity || gate.generationAttemptId !== attempt?.id) return;
      gate.idleRecoveryChecks += 1;
      if (isGenerating()) {
        if (gate.idleRecoveryChecks < maxGenerationIdleRecoveryChecks) awaitingFurtherRecovery = true;
        return;
      }
      generationGates.delete(taskKey);
      released = true;
    });
    if (released) scheduleConfirmedQueueDrain();
    if (awaitingFurtherRecovery) scheduleGenerationIdleRecovery();
    return released;
  }

  function handleChatChanged() {
    const identity = getIdentity();
    const attempt = activeGenerationAttempts.get(identity);
    if (!attempt) return false;
    let restarted = false;
    generationGates.forEach(gate => {
      if (gate.chatIdentity !== identity || gate.generationAttemptId !== attempt.id) return;
      gate.idleRecoveryChecks = 0;
      restarted = true;
    });
    if (restarted) scheduleGenerationIdleRecovery();
    return restarted;
  }

  function restoreDeferredRecovery() {
    const identity = getIdentity();
    const recovery = deferredRecoveries.get(identity);
    if (!recovery) return false;
    const task = getConfirmedSummaryTasks(getState()).find(item => item.taskKey === recovery.taskKey);
    deferredRecoveries.delete(identity);
    if (task?.status !== 'RUNNING' || task.executionToken !== recovery.executionToken) return false;
    if (recovery.summaryDisabled || !isEnabled()) {
      cancelTask(task, 'SUMMARY_DISABLED');
    } else {
      task.status = 'PENDING';
      task.updatedAt = formatTimestamp();
      delete task.executionToken;
    }
    saveState();
    return true;
  }

  function cancelPendingTasksWhenDisabled(state, identity) {
    let changed = false;
    getConfirmedSummaryTasks(state).forEach(task => {
      if (task.chatIdentity !== identity || task.status !== 'PENDING') return;
      cancelTask(task, 'SUMMARY_DISABLED');
      changed = true;
    });
    if (changed) saveState();
    return changed;
  }

  function handleAutoSummaryEnabledChanged(enabled) {
    if (enabled) return scheduleConfirmedQueueDrain();
    if (activeExecution) {
      cancelledExecutionTokens.add(createExecutionKey(
        activeExecution.chatIdentity,
        activeExecution.taskKey,
        activeExecution.executionToken,
      ));
    }
    const state = getState();
    return cancelPendingTasksWhenDisabled(state, getIdentity());
  }

  function activateQueue(state) {
    if (state.summary.confirmedQueueActivatedAt) return false;
    state.summary.confirmedQueueActivatedAt = formatTimestamp();
    getConfirmedSummaryTasks(state).forEach(task => {
      if (task.status === 'PENDING' && task.createdAt < state.summary.confirmedQueueActivatedAt) {
        cancelTask(task, 'PRE_ACTIVATION');
        task.updatedAt = state.summary.confirmedQueueActivatedAt;
      }
    });
    saveState();
    return true;
  }

  function scheduleConfirmedQueueDrain() {
    if (scheduled || running) return false;
    scheduled = true;
    defer(() => { void drainConfirmedQueue(); });
    return true;
  }

  async function drainConfirmedQueue() {
    scheduled = false;
    if (running) return;
    const state = getState();
    activateQueue(state);
    const identity = getIdentity();
    restoreDeferredRecovery();
    if (!isEnabled()) {
      cancelPendingTasksWhenDisabled(state, identity);
      return;
    }
    if (isGenerating()) {
      if (idleDefers < maxIdleDefers) {
        idleDefers += 1;
        scheduleConfirmedQueueDrain();
      }
      return;
    }
    idleDefers = 0;
    const task = getConfirmedSummaryTasks(state)
      .filter(item => item.chatIdentity === identity && item.status === 'PENDING')
      .filter(item => item.createdAt >= state.summary.confirmedQueueActivatedAt)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0];
    if (!task) return;
    if (isAwaitingGenerationTerminal(task)) return;
    if (!isTargetValid(task)) {
      task.status = 'CANCELLED';
      task.updatedAt = formatTimestamp();
      saveState();
      scheduleConfirmedQueueDrain();
      return;
    }
    const fingerprint = getSummaryFingerprint(task.originalMessageId);
    if (!fingerprint) {
      task.status = 'CANCELLED';
      task.updatedAt = formatTimestamp();
      saveState();
      return;
    }
    if (state.summary.processedMessageFingerprints?.[task.originalMessageId] === fingerprint) {
      task.status = 'SUMMARIZED';
      task.updatedAt = formatTimestamp();
      saveState();
      void Promise.resolve(onSummaryCommitted?.(task)).catch(error => {
        console.warn('[蜃灵助手] confirmed Summary 下游 effect 调度失败。', error);
      });
      scheduleConfirmedQueueDrain();
      return;
    }
    if (typeof generate !== 'function' || typeof write !== 'function') return;

    const executionToken = `confirmed:${++sequence}`;
    task.status = 'RUNNING';
    task.executionToken = executionToken;
    task.updatedAt = formatTimestamp();
    saveState();
    running = true;
    activeExecution = {
      chatIdentity: task.chatIdentity,
      taskKey: task.taskKey,
      executionToken,
    };
    try {
      const result = await generate(task.originalMessageId);
      const latestState = getState();
      const cancellationRequested = hasCancellationIntent(task.chatIdentity, task.taskKey, executionToken);
      if (getIdentity() !== task.chatIdentity) {
        deferredRecoveries.set(task.chatIdentity, {
          taskKey: task.taskKey,
          executionToken,
          summaryDisabled: cancellationRequested || !isEnabled(),
        });
        clearCancellationIntent(task.chatIdentity, task.taskKey, executionToken);
        return;
      }
      const latestTask = getConfirmedSummaryTasks(latestState).find(item => item.taskKey === task.taskKey);
      if (cancellationRequested || !isEnabled()) {
        if (latestTask?.status === 'RUNNING' && latestTask.executionToken === executionToken) {
          cancelTask(latestTask, 'SUMMARY_DISABLED');
          saveState();
        }
        clearCancellationIntent(task.chatIdentity, task.taskKey, executionToken);
        return;
      }
      if (
        latestTask?.status !== 'RUNNING'
        || latestTask.executionToken !== executionToken
        || !isTargetValid(latestTask)
      ) {
        if (latestTask?.status === 'RUNNING') {
          cancelTask(latestTask);
          saveState();
        }
        return;
      }
      const wrote = await write(task.originalMessageId, result.fingerprint, result.memory);
      if (!wrote) {
        cancelTask(latestTask);
      } else {
        const messageId = Number(task.originalMessageId);
        const countedMessageIds = Array.isArray(latestState.summary.memoryCountedMessageIds)
          ? latestState.summary.memoryCountedMessageIds
          : [];
        const alreadyCounted = countedMessageIds.includes(messageId)
          || Object.hasOwn(latestState.summary.processedMessageFingerprints || {}, messageId);
        latestState.summary.processedMessageFingerprints = {
          ...(latestState.summary.processedMessageFingerprints || {}),
          [task.originalMessageId]: result.fingerprint,
        };
        if (!alreadyCounted) {
          latestState.summary.memoryCountedMessageIds = [...countedMessageIds, messageId];
          latestState.summary.memoryCountSinceArchive = Number(latestState.summary.memoryCountSinceArchive || 0) + 1;
          latestState.summary.smallSummaryCount = Number(latestState.summary.smallSummaryCount || 0) + 1;
        }
        latestState.summary.lastSummaryMessageId = Number(task.originalMessageId);
        latestState.summary.lastSummaryAt = formatTimestamp();
        latestTask.status = 'SUMMARIZED';
      }
      latestTask.updatedAt = formatTimestamp();
      delete latestTask.executionToken;
      saveState();
      if (latestTask.status === 'SUMMARIZED') {
        void Promise.resolve(onSummaryCommitted?.(latestTask, {
          memory: result.memory,
          effectMemory: result.effectResult || result.memory,
        })).catch(error => {
          console.warn('[蜃灵助手] confirmed Summary 下游 effect 调度失败。', error);
        });
      }
    } catch (error) {
      const cancellationRequested = hasCancellationIntent(task.chatIdentity, task.taskKey, executionToken);
      if (getIdentity() !== task.chatIdentity) {
        deferredRecoveries.set(task.chatIdentity, {
          taskKey: task.taskKey,
          executionToken,
          summaryDisabled: cancellationRequested || !isEnabled(),
        });
        clearCancellationIntent(task.chatIdentity, task.taskKey, executionToken);
        return;
      }
      const latestTask = getConfirmedSummaryTasks(getState()).find(item => item.taskKey === task.taskKey);
      if (latestTask?.status === 'RUNNING' && latestTask.executionToken === executionToken) {
        if (cancellationRequested || !isEnabled()) {
          cancelTask(latestTask, 'SUMMARY_DISABLED');
        } else {
          latestTask.status = 'FAILED';
          latestTask.lastErrorCode = [
            'MAIN_TIMEOUT',
            'SECONDARY_TIMEOUT',
            'TIMEOUT_ABORT',
            'SUMMARY_TRANSPORT_TIMEOUT',
          ].includes(error?.code)
            ? 'SUMMARY_TRANSPORT_TIMEOUT'
            : 'SUMMARY_GENERATION_FAILED';
          latestTask.updatedAt = formatTimestamp();
          delete latestTask.executionToken;
        }
        saveState();
      }
      clearCancellationIntent(task.chatIdentity, task.taskKey, executionToken);
    } finally {
      if (activeExecution?.executionToken === executionToken) activeExecution = null;
      running = false;
      scheduleConfirmedQueueDrain();
    }
  }

  return {
    activateQueue,
    handleAutoSummaryEnabledChanged,
    holdConfirmedTaskUntilGenerationTerminal,
    handleMainGenerationStarted,
    handleMainGenerationTerminal,
    handleChatChanged,
    recoverAwaitingGenerationAfterIdle,
    scheduleConfirmedQueueDrain,
    drainConfirmedQueue,
    isRunning: () => running,
  };
}

export function scheduleConfirmedQueueDrain() {
  return runtimeConsumer?.scheduleConfirmedQueueDrain() ?? false;
}

export function handleAutoSummaryEnabledChanged(enabled) {
  return runtimeConsumer?.handleAutoSummaryEnabledChanged(Boolean(enabled)) ?? false;
}

export function registerConfirmedSummaryConsumer(options = {}) {
  if (consumerEventsRegistered) return runtimeConsumer;
  runtimeConsumer = createConfirmedSummaryConsumer(options);
  runtimeConsumer.activateQueue(getChatState());
  const events = getTavernEventsSafe();
  [
    events.GENERATION_STARTED,
    events.GENERATION_ENDED,
    events.GENERATION_STOPPED,
    events.MESSAGE_RECEIVED,
    events.CHARACTER_MESSAGE_RENDERED,
    events.CHAT_CHANGED,
  ].filter(Boolean).forEach(eventName => {
    const handler = eventName === events.GENERATION_STARTED
      ? () => runtimeConsumer.handleMainGenerationStarted()
      : (eventName === events.GENERATION_ENDED || eventName === events.GENERATION_STOPPED)
        ? () => runtimeConsumer.handleMainGenerationTerminal()
        : eventName === events.CHAT_CHANGED
          ? () => {
            runtimeConsumer.handleChatChanged();
            runtimeConsumer.scheduleConfirmedQueueDrain();
          }
          : () => runtimeConsumer.scheduleConfirmedQueueDrain();
    const stop = registerTavernEvent(eventName, handler);
    if (stop) consumerEventStops.push(stop);
  });
  consumerEventsRegistered = true;
  runtimeConsumer.scheduleConfirmedQueueDrain();
  return runtimeConsumer;
}
