import { getContextSafe, getChatMessagesSafe } from '../../core/chat.js';
import { createMessageContentFingerprint, getAssistantMessageContentFingerprint } from '../../core/message-fingerprint.js';
import { getChatState, getConfirmedSummaryTasks, getContextInfo, saveChatState } from '../../core/settings.js';
import { getTavernEventsSafe, registerTavernEvent } from '../../core/tavern-events.js';
import { getAutoSummaryFingerprint, shouldRunAutoSummary } from './workflow.js';

const consumerEventStops = [];
let consumerEventsRegistered = false;
let runtimeConsumer = null;

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
  const now = options.now || Date.now;
  const formatTimestamp = options.formatTimestamp || nowTimestamp;
  const defer = options.defer || (callback => window.setTimeout(callback, 0));
  const maxIdleDefers = Number.isInteger(options.maxIdleDefers) ? options.maxIdleDefers : 3;
  let scheduled = false;
  let running = false;
  let idleDefers = 0;
  let sequence = 0;

  function activateQueue(state) {
    if (state.summary.confirmedQueueActivatedAt) return false;
    state.summary.confirmedQueueActivatedAt = formatTimestamp();
    getConfirmedSummaryTasks(state).forEach(task => {
      if (task.status === 'PENDING' && task.createdAt < state.summary.confirmedQueueActivatedAt) {
        task.status = 'CANCELLED';
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
    if (!isEnabled()) return;
    if (isGenerating()) {
      if (idleDefers < maxIdleDefers) {
        idleDefers += 1;
        scheduleConfirmedQueueDrain();
      }
      return;
    }
    idleDefers = 0;
    const identity = getIdentity();
    const task = getConfirmedSummaryTasks(state)
      .filter(item => item.chatIdentity === identity && item.status === 'PENDING')
      .filter(item => item.createdAt >= state.summary.confirmedQueueActivatedAt)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0];
    if (!task) return;
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
    try {
      const result = await generate(task.originalMessageId);
      const latestState = getState();
      const latestTask = getConfirmedSummaryTasks(latestState).find(item => item.taskKey === task.taskKey);
      if (getIdentity() !== task.chatIdentity) {
        if (latestTask?.status === 'RUNNING' && latestTask.executionToken === executionToken) {
          latestTask.status = 'PENDING';
          latestTask.updatedAt = formatTimestamp();
          delete latestTask.executionToken;
          saveState();
        }
        return;
      }
      if (
        latestTask?.status !== 'RUNNING'
        || latestTask.executionToken !== executionToken
        || !isTargetValid(latestTask)
      ) {
        if (latestTask?.status === 'RUNNING') {
          latestTask.status = 'CANCELLED';
          latestTask.updatedAt = formatTimestamp();
          delete latestTask.executionToken;
          saveState();
        }
        return;
      }
      const wrote = await write(task.originalMessageId, result.fingerprint, result.memory);
      if (!wrote) {
        latestTask.status = 'CANCELLED';
      } else {
        latestState.summary.processedMessageFingerprints = {
          ...(latestState.summary.processedMessageFingerprints || {}),
          [task.originalMessageId]: result.fingerprint,
        };
        latestState.summary.lastSummaryMessageId = Number(task.originalMessageId);
        latestState.summary.lastSummaryAt = formatTimestamp();
        latestTask.status = 'SUMMARIZED';
      }
      latestTask.updatedAt = formatTimestamp();
      delete latestTask.executionToken;
      saveState();
    } catch (error) {
      const latestTask = getConfirmedSummaryTasks(getState()).find(item => item.taskKey === task.taskKey);
      if (latestTask?.status === 'RUNNING' && latestTask.executionToken === executionToken) {
        latestTask.status = 'FAILED';
        latestTask.updatedAt = formatTimestamp();
        delete latestTask.executionToken;
        saveState();
      }
    } finally {
      running = false;
      scheduleConfirmedQueueDrain();
    }
  }

  return { activateQueue, scheduleConfirmedQueueDrain, drainConfirmedQueue, isRunning: () => running };
}

export function registerConfirmedSummaryConsumer(options = {}) {
  if (consumerEventsRegistered) return runtimeConsumer;
  runtimeConsumer = createConfirmedSummaryConsumer(options);
  runtimeConsumer.activateQueue(getChatState());
  const events = getTavernEventsSafe();
  [
    events.GENERATION_ENDED,
    events.GENERATION_STOPPED,
    events.MESSAGE_RECEIVED,
    events.CHARACTER_MESSAGE_RENDERED,
    events.CHAT_CHANGED,
  ].filter(Boolean).forEach(eventName => {
    const stop = registerTavernEvent(eventName, () => runtimeConsumer.scheduleConfirmedQueueDrain());
    if (stop) consumerEventStops.push(stop);
  });
  consumerEventsRegistered = true;
  runtimeConsumer.scheduleConfirmedQueueDrain();
  return runtimeConsumer;
}
