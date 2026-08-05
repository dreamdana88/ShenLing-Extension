import { getChatMessageById } from '../../core/chat.js';
import { getTavernEventsSafe, registerTavernEvent } from '../../core/tavern-events.js';
import {
  CONFIRMED_SUMMARY_EFFECT_NAMES,
  getChatState,
  getConfirmedSummaryTasks,
  getContextInfo,
  getGlobalSettings,
  getPlotOutlineState,
  saveChatState,
} from '../../core/settings.js';
import { extractMemoryBlocks } from '../../core/summary.js';
import { processAutoGrandMemory } from './archive.js';
import {
  commitEmotionUpdateFromConfirmedSummary,
  shouldAnalyzeEmotionProfile,
} from '../emotion-profile/workflow.js';
import { AFFECTION_TRANSPORT_POLICY } from '../affection/generation.js';
import { commitAffectionUpdateFromConfirmedSummary } from '../affection/lifecycle.js';
import { isAffectionAnalysisActive } from '../affection/runtime.js';
import { applyPlotOutlineProgressUpdate } from '../plot-outline/workflow.js';

const SAFE_EFFECT_REASON_CODE = 'CONFIRMED_EFFECT_FAILED';
let runtimeEffects = null;
let effectsEventsRegistered = false;
const effectsEventStops = [];

function nowTimestamp() {
  return new Date().toISOString();
}

function getChatIdentity() {
  return String(getContextInfo().chatId || '').trim();
}

function ensureEffects(task) {
  if (!task.effects || typeof task.effects !== 'object') task.effects = {};
  CONFIRMED_SUMMARY_EFFECT_NAMES.forEach(name => {
    if (!task.effects[name]) task.effects[name] = 'PENDING';
  });
  return task.effects;
}

function getTaskMemory(task) {
  const message = getChatMessageById(Number(task.originalMessageId));
  const memories = extractMemoryBlocks(String(message?.message || ''));
  return memories.at(-1) || '';
}

export function createConfirmedEffectsCoordinator(options = {}) {
  const getState = options.getChatState || getChatState;
  const saveState = options.saveChatState || saveChatState;
  const getIdentity = options.getChatIdentity || getChatIdentity;
  const getSettings = options.getGlobalSettings || getGlobalSettings;
  const formatTimestamp = options.formatTimestamp || nowTimestamp;
  const defer = options.defer || (callback => window.setTimeout(callback, 0));
  const getMemory = options.getTaskMemory || getTaskMemory;
  const recoveredChatIdentities = new Set();
  const deferredRecoveries = new Map();
  const queued = new Map();
  let scheduled = false;
  let running = false;

  const isEffectEnabled = options.isEffectEnabled || ((name, state, settings) => {
    if (name === 'emotion') return shouldAnalyzeEmotionProfile(settings);
    if (name === 'affection') return isAffectionAnalysisActive(settings);
    return Boolean(getPlotOutlineState(state).enabled);
  });
  const runEffect = options.runEffect || (async (name, { task, memory, state }) => {
    if (name === 'emotion') {
      await commitEmotionUpdateFromConfirmedSummary(memory, {
        messageId: task.originalMessageId,
        fingerprint: task.assistantFingerprint,
        chatState: state,
        isCurrentChat: () => getIdentity() === task.chatIdentity,
      });
      return;
    }
    if (name === 'affection') {
      await commitAffectionUpdateFromConfirmedSummary(memory, {
        messageId: task.originalMessageId,
        chatState: state,
        chatId: task.chatIdentity,
        isCurrentChat: () => getIdentity() === task.chatIdentity,
        // Confirmed formal path only: each first-build request resolves transport independently.
        transportPolicy: AFFECTION_TRANSPORT_POLICY.CONFIGURED,
      });
      return;
    }
    applyPlotOutlineProgressUpdate(memory, state, {
      messageId: task.originalMessageId,
      fingerprint: task.assistantFingerprint,
    });
  });
  const runAutoGrandMemory = options.runAutoGrandMemory || processAutoGrandMemory;
  const logEffectFailure = options.logEffectFailure || (name => {
    console.warn(`[蜃灵助手] confirmed ${name} effect failed.`);
  });

  function recoverEffectsForCurrentChat() {
    const identity = getIdentity();
    if (!identity) return false;
    const state = getState();
    let changed = false;
    const deferred = deferredRecoveries.get(identity);
    if (deferred) {
      const task = getConfirmedSummaryTasks(state).find(item => item.taskKey === deferred.taskKey);
      if (task?.status === 'SUMMARIZED' && task.effects?.[deferred.name] === 'RUNNING') {
        task.effects[deferred.name] = 'PENDING';
        task.updatedAt = formatTimestamp();
        changed = true;
      }
      deferredRecoveries.delete(identity);
    }
    if (recoveredChatIdentities.has(identity)) {
      if (changed) saveState();
      return changed;
    }
    recoveredChatIdentities.add(identity);
    getConfirmedSummaryTasks(state).forEach(task => {
      if (task.chatIdentity !== identity || task.status !== 'SUMMARIZED' || !task.effects) return;
      const effects = ensureEffects(task);
      CONFIRMED_SUMMARY_EFFECT_NAMES.forEach(name => {
        if (effects[name] === 'RUNNING') {
          effects[name] = 'PENDING';
          changed = true;
        }
      });
    });
    if (changed) saveState();
    return changed;
  }

  function getNextTask() {
    const state = getState();
    const identity = getIdentity();
    if (!identity) return null;
    const requestedKeys = new Set(queued.keys());
    return getConfirmedSummaryTasks(state)
      .filter(task => task.chatIdentity === identity && task.status === 'SUMMARIZED')
      .filter(task => requestedKeys.has(task.taskKey) || (
        task.effects && CONFIRMED_SUMMARY_EFFECT_NAMES.some(name => task.effects[name] === 'PENDING')
      ))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0] || null;
  }

  function scheduleConfirmedEffects(taskKey, memory = '') {
    if (!taskKey) return false;
    queued.set(String(taskKey), String(memory || ''));
    if (scheduled || running) return false;
    scheduled = true;
    defer(() => { void drainConfirmedEffects(); });
    return true;
  }

  async function drainConfirmedEffects() {
    scheduled = false;
    if (running) return;
    recoverEffectsForCurrentChat();
    const task = getNextTask();
    if (!task) return;
    running = true;
    try {
      const state = getState();
      const settings = getSettings();
      const memory = queued.get(task.taskKey) || getMemory(task);
      queued.delete(task.taskKey);
      for (const name of CONFIRMED_SUMMARY_EFFECT_NAMES) {
        const effects = ensureEffects(task);
        if (effects[name] === 'SUCCEEDED' || effects[name] === 'SKIPPED') continue;
        if (effects[name] === 'RUNNING') continue;
        if (!isEffectEnabled(name, state, settings)) {
          effects[name] = 'SKIPPED';
          task.updatedAt = formatTimestamp();
          saveState();
          continue;
        }
        if (getIdentity() !== task.chatIdentity) return;
        effects[name] = 'RUNNING';
        task.updatedAt = formatTimestamp();
        saveState();
        try {
          await runEffect(name, { task, memory, state });
          if (getIdentity() !== task.chatIdentity) {
            deferredRecoveries.set(task.chatIdentity, { taskKey: task.taskKey, name });
            return;
          }
          effects[name] = 'SUCCEEDED';
          delete task.effectReasonCodes?.[name];
        } catch {
          if (getIdentity() !== task.chatIdentity) {
            deferredRecoveries.set(task.chatIdentity, { taskKey: task.taskKey, name });
            return;
          }
          effects[name] = 'FAILED';
          task.effectReasonCodes = { ...(task.effectReasonCodes || {}), [name]: SAFE_EFFECT_REASON_CODE };
          logEffectFailure(name);
        }
        task.updatedAt = formatTimestamp();
        saveState();
      }
      if (getIdentity() === task.chatIdentity) {
        await runAutoGrandMemory();
      }
    } finally {
      running = false;
      if (getNextTask()) scheduleConfirmedEffects(getNextTask().taskKey);
    }
  }

  return {
    recoverEffectsForCurrentChat,
    scheduleConfirmedEffects,
    drainConfirmedEffects,
    handleChatChanged: () => {
      const recovered = recoverEffectsForCurrentChat();
      if (recovered || getNextTask()) scheduleConfirmedEffects(getNextTask()?.taskKey);
      return recovered;
    },
    isRunning: () => running,
  };
}

export function registerConfirmedEffects(options = {}) {
  if (!runtimeEffects) runtimeEffects = createConfirmedEffectsCoordinator(options);
  runtimeEffects.recoverEffectsForCurrentChat();
  if (!effectsEventsRegistered) {
    const events = getTavernEventsSafe();
    const stop = events.CHAT_CHANGED && registerTavernEvent(events.CHAT_CHANGED, () => {
      runtimeEffects.handleChatChanged();
    });
    if (stop) effectsEventStops.push(stop);
    effectsEventsRegistered = effectsEventStops.length > 0;
  }
  return runtimeEffects;
}
