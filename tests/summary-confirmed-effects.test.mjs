import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssistantMessageContentFingerprint } from '../src/core/message-fingerprint.js';
import { normalizeConfirmedSummaryTasks } from '../src/core/settings.js';
import { createConfirmedEffectsCoordinator } from '../src/features/summary/confirmed-effects.js';
import { calculateSafeArchiveTo } from '../src/features/summary/workflow.js';

function task(key = 'task-a', status = 'SUMMARIZED') {
  return {
    taskKey: key,
    chatIdentity: 'chat-a',
    originalMessageId: 2,
    assistantFingerprint: '7:1',
    selectedSwipeId: 0,
    confirmingUserMessageId: 3,
    confirmingUserFingerprint: '1:2',
    status,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

function createHarness(options = {}) {
  const stateA = { summary: { confirmedTasks: [task()], processedMessageFingerprints: {} } };
  const stateB = { summary: { confirmedTasks: [], processedMessageFingerprints: {} } };
  let currentChat = 'chat-a';
  const calls = [];
  const coordinator = createConfirmedEffectsCoordinator({
    getChatState: () => currentChat === 'chat-a' ? stateA : stateB,
    saveChatState: () => {},
    getChatIdentity: () => currentChat,
    getGlobalSettings: () => ({}),
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
    getTaskMemory: () => '<memory>confirmed</memory>',
    isEffectEnabled: options.isEffectEnabled || (() => true),
    runEffect: options.runEffect || (async name => { calls.push(name); }),
    runAutoGrandMemory: options.runAutoGrandMemory || (async () => {}),
    logEffectFailure: options.logEffectFailure || (() => {}),
  });
  return {
    stateA,
    stateB,
    calls,
    coordinator,
    switchTo: identity => { currentChat = identity; },
  };
}

test('confirmed effects run once after SUMMARIZED and repeated schedules do not recommit', async () => {
  const harness = createHarness();
  harness.coordinator.scheduleConfirmedEffects('task-a');
  await harness.coordinator.drainConfirmedEffects();
  await harness.coordinator.drainConfirmedEffects();

  assert.deepEqual(harness.calls, ['emotion', 'affection', 'plot']);
  assert.deepEqual(harness.stateA.summary.confirmedTasks[0].effects, {
    emotion: 'SUCCEEDED',
    affection: 'SUCCEEDED',
    plot: 'SUCCEEDED',
  });
});

test('a failed confirmed effect is isolated while later effects still commit once', async () => {
  const harness = createHarness({
    runEffect: async name => {
      harness.calls.push(name);
      if (name === 'affection') throw new Error('private transport payload');
    },
  });
  harness.coordinator.scheduleConfirmedEffects('task-a');
  await harness.coordinator.drainConfirmedEffects();

  const result = harness.stateA.summary.confirmedTasks[0];
  assert.deepEqual(harness.calls, ['emotion', 'affection', 'plot']);
  assert.equal(result.status, 'SUMMARIZED');
  assert.equal(result.effects.emotion, 'SUCCEEDED');
  assert.equal(result.effects.affection, 'FAILED');
  assert.equal(result.effects.plot, 'SUCCEEDED');
  assert.equal(result.effectReasonCodes.affection, 'CONFIRMED_EFFECT_FAILED');
  assert.equal(JSON.stringify(result).includes('private transport payload'), false);
});

test('disabled feature effects are skipped and are not revived after reopening', async () => {
  let enabled = false;
  const harness = createHarness({ isEffectEnabled: () => enabled });
  harness.coordinator.scheduleConfirmedEffects('task-a');
  await harness.coordinator.drainConfirmedEffects();
  enabled = true;
  await harness.coordinator.drainConfirmedEffects();

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.stateA.summary.confirmedTasks[0].effects, {
    emotion: 'SKIPPED',
    affection: 'SKIPPED',
    plot: 'SKIPPED',
  });
});

test('a first page recovery returns interrupted effects to PENDING, but the same page does not revive RUNNING again', () => {
  const harness = createHarness();
  harness.stateA.summary.confirmedTasks[0].effects = {
    emotion: 'RUNNING',
    affection: 'SUCCEEDED',
    plot: 'PENDING',
  };
  assert.equal(harness.coordinator.recoverEffectsForCurrentChat(), true);
  assert.equal(harness.stateA.summary.confirmedTasks[0].effects.emotion, 'PENDING');
  harness.stateA.summary.confirmedTasks[0].effects.emotion = 'RUNNING';
  assert.equal(harness.coordinator.recoverEffectsForCurrentChat(), false);
  assert.equal(harness.stateA.summary.confirmedTasks[0].effects.emotion, 'RUNNING');
});

test('effect metadata keeps only recognized states and safe failure codes', () => {
  const [normalized] = normalizeConfirmedSummaryTasks([{
    ...task(),
    effects: { emotion: 'RUNNING', affection: 'SUCCEEDED', plot: 'unsafe' },
    effectReasonCodes: { affection: 'CONFIRMED_EFFECT_FAILED', plot: 'raw error payload' },
  }]);
  assert.deepEqual(normalized.effects, {
    emotion: 'RUNNING',
    affection: 'SUCCEEDED',
    plot: 'PENDING',
  });
  assert.deepEqual(normalized.effectReasonCodes, { affection: 'CONFIRMED_EFFECT_FAILED' });
});

test('a chat switch during an effect leaves the other chat untouched and recovers it only after returning', async () => {
  let switched = false;
  const harness = createHarness({
    runEffect: async name => {
      harness.calls.push(name);
      if (name === 'emotion' && !switched) {
        switched = true;
        harness.switchTo('chat-b');
      }
    },
  });
  harness.coordinator.scheduleConfirmedEffects('task-a');
  await harness.coordinator.drainConfirmedEffects();

  assert.deepEqual(harness.stateB.summary.confirmedTasks, []);
  assert.equal(harness.stateA.summary.confirmedTasks[0].effects.emotion, 'RUNNING');
  assert.deepEqual(harness.calls, ['emotion']);

  harness.switchTo('chat-a');
  assert.equal(harness.coordinator.handleChatChanged(), true);
  await harness.coordinator.drainConfirmedEffects();
  assert.deepEqual(harness.stateA.summary.confirmedTasks[0].effects, {
    emotion: 'SUCCEEDED',
    affection: 'SUCCEEDED',
    plot: 'SUCCEEDED',
  });
  assert.deepEqual(harness.calls, ['emotion', 'emotion', 'affection', 'plot']);
});

function summarizedTaskFor(message) {
  return {
    ...task(`task-${message.message_id}`),
    originalMessageId: message.message_id,
    assistantFingerprint: getAssistantMessageContentFingerprint(message),
    selectedSwipeId: Number(message.swipe_id || 0),
  };
}

test('safe archive boundary stops before the confirming user and an unsummarized candidate', () => {
  const first = { message_id: 0, role: 'assistant', swipe_id: 0, message: '已总结回复\n<memory>1</memory>' };
  const messages = [
    first,
    { message_id: 1, role: 'user', message: '确认第一楼' },
    { message_id: 2, role: 'assistant', swipe_id: 0, message: '候选回复' },
  ];
  const state = {
    summary: {
      confirmedTasks: [summarizedTaskFor(first), { ...summarizedTaskFor(messages[2]), status: 'PENDING' }],
      processedMessageFingerprints: {},
      archiveRecords: [],
    },
  };
  assert.equal(calculateSafeArchiveTo(messages, state), 0);
});

test('safe archive boundary advances through only a continuous sequence of summarized assistants', () => {
  const first = { message_id: 0, role: 'assistant', swipe_id: 0, message: '第一楼\n<memory>1</memory>' };
  const second = { message_id: 2, role: 'assistant', swipe_id: 0, message: '第二楼\n<memory>2</memory>' };
  const third = { message_id: 4, role: 'assistant', swipe_id: 0, message: '第三楼候选' };
  const state = {
    summary: {
      confirmedTasks: [summarizedTaskFor(first), summarizedTaskFor(second), { ...summarizedTaskFor(third), status: 'FAILED' }],
      processedMessageFingerprints: {},
      archiveRecords: [],
    },
  };
  assert.equal(calculateSafeArchiveTo([
    first,
    { message_id: 1, role: 'user', message: '确认一' },
    second,
    { message_id: 3, role: 'user', message: '确认二' },
    third,
  ], state), 2);
});
