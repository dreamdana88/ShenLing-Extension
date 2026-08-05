import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMessageContentFingerprint,
  getAssistantMessageContentFingerprint,
} from '../src/core/message-fingerprint.js';
import { createConfirmedEffectsCoordinator } from '../src/features/summary/confirmed-effects.js';
import { createConfirmedSummaryConsumer } from '../src/features/summary/confirmed-consumer.js';
import { createConfirmedLifecycleCoordinator } from '../src/features/summary/confirmed-lifecycle.js';
import { calculateSafeArchiveTo } from '../src/features/summary/archive.js';

function user(message) {
  return { role: 'user', message };
}

function assistant(message, swipe_id = 0) {
  return { role: 'assistant', message, swipe_id };
}

function fingerprint(message) {
  return createMessageContentFingerprint(message?.message ?? '');
}

function createHarness() {
  const messages = [user('U1'), assistant('A1')];
  const state = {
    summary: {
      confirmedQueueActivatedAt: '2026-07-31T00:00:00.000Z',
      confirmedTasks: [],
      processedMessageFingerprints: {},
      memoryCountedMessageIds: [],
      archiveRecords: [],
    },
  };
  const calls = { generate: [], write: [], effects: [] };
  let now = Date.parse('2026-07-31T00:00:01.000Z');

  const lifecycle = createConfirmedLifecycleCoordinator({
    getSnapshot: () => ({ chatIdentity: 'chat-a', chatState: state, messages }),
    saveChatState: () => {},
    now: () => now++,
    createTimestamp: value => new Date(value).toISOString(),
    getAssistantFingerprint: fingerprint,
    getUserFingerprint: fingerprint,
    shouldCreateTask: () => true,
  });

  const effects = createConfirmedEffectsCoordinator({
    getChatState: () => state,
    saveChatState: () => {},
    getChatIdentity: () => 'chat-a',
    getGlobalSettings: () => ({}),
    defer: () => {},
    isEffectEnabled: () => true,
    runAutoGrandMemory: async () => {},
    runEffect: async (name, { task }) => {
      calls.effects.push([name, task.taskKey]);
    },
  });

  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => state,
    saveChatState: () => {},
    getChatIdentity: () => 'chat-a',
    isGenerating: () => false,
    isEnabled: () => true,
    defer: () => {},
    scheduleGenerationIdleRecoveryCheck: () => {},
    isTargetValid: task => (
      task.chatIdentity === 'chat-a'
      && messages[task.originalMessageId]?.role === 'assistant'
    ),
    getSummaryFingerprint: messageId => `summary:${messageId}`,
    generate: async messageId => {
      calls.generate.push(messageId);
      return { fingerprint: `summary:${messageId}`, memory: `<memory>${messageId}</memory>` };
    },
    write: async (messageId, summaryFingerprint) => {
      calls.write.push([messageId, summaryFingerprint]);
      return true;
    },
    onSummaryCommitted: (task, result) => effects.scheduleConfirmedEffects(task.taskKey, result?.memory || ''),
  });

  return { messages, state, calls, lifecycle, consumer, effects };
}

async function confirmAndConsume(harness, userMessage) {
  const { messages, lifecycle, consumer, effects } = harness;
  consumer.handleMainGenerationStarted();
  assert.equal(lifecycle.captureGenerationAfterCommands('normal'), true);
  messages.push(user(userMessage));
  const task = lifecycle.createConfirmedTaskFromMessageSent(messages.length - 1);
  assert.ok(task);
  assert.equal(consumer.holdConfirmedTaskUntilGenerationTerminal(task), true);
  assert.equal(await consumer.drainConfirmedQueue(), undefined);
  assert.equal(consumer.handleMainGenerationTerminal(), true);
  await consumer.drainConfirmedQueue();
  await effects.drainConfirmedEffects();
  return harness.state.summary.confirmedTasks.find(item => item.taskKey === task.taskKey);
}

test('complete confirmed lifecycle summarizes and commits A once across B Roll/Swipe, then confirms B once', async () => {
  const harness = createHarness();
  const { messages, state, calls, lifecycle, consumer } = harness;

  // A1 is provisional: Roll then Swipe back to the final A must not confirm anything.
  messages[1] = assistant('A2', 1);
  assert.equal(lifecycle.captureGenerationAfterCommands('regenerate'), false);
  assert.equal(lifecycle.captureGenerationAfterCommands('swipe'), false);
  messages[1] = assistant('A-final', 0);
  assert.equal(state.summary.confirmedTasks.length, 0);

  const taskA = await confirmAndConsume(harness, 'U2');
  assert.equal(taskA.originalMessageId, 1);
  assert.deepEqual(calls.generate, [1]);
  assert.equal(taskA.status, 'SUMMARIZED');
  assert.deepEqual(calls.generate, [1]);
  assert.deepEqual(calls.write, [[1, 'summary:1']]);
  assert.deepEqual(calls.effects.map(([name]) => name), ['emotion', 'affection', 'plot']);
  assert.deepEqual(taskA.effects, { emotion: 'SUCCEEDED', affection: 'SUCCEEDED', plot: 'SUCCEEDED' });

  // B is generated after U2. Its Roll/Swipe events may wake drains, but cannot rebuild A.
  messages.push(assistant('B1', 0));
  lifecycle.captureGenerationAfterCommands('continue');
  lifecycle.captureGenerationAfterCommands('regenerate');
  lifecycle.captureGenerationAfterCommands('swipe');
  messages[3] = assistant('B-final', 2);
  consumer.handleMainGenerationTerminal();
  await consumer.drainConfirmedQueue();
  assert.equal(state.summary.confirmedTasks.length, 1);
  assert.deepEqual(calls.generate, [1]);
  assert.deepEqual(calls.effects.map(([name]) => name), ['emotion', 'affection', 'plot']);

  const taskB = await confirmAndConsume(harness, 'U3');
  assert.notEqual(taskA.taskKey, taskB.taskKey);
  assert.equal(taskB.originalMessageId, 3);
  assert.equal(state.summary.confirmedTasks.length, 2);
  assert.deepEqual(calls.generate, [1, 3]);
  assert.deepEqual(calls.write, [[1, 'summary:1'], [3, 'summary:3']]);
  assert.equal(calls.effects.filter(([, taskKey]) => taskKey === taskA.taskKey).length, 3);
});

test('Continue and Regenerate cannot use a stale send context to confirm an earlier candidate', () => {
  const harness = createHarness();
  const { messages, state, lifecycle } = harness;
  assert.equal(lifecycle.captureGenerationAfterCommands('normal'), true);
  assert.equal(lifecycle.captureGenerationAfterCommands('continue'), false);
  messages.push(user('孤立 U2'));
  assert.equal(lifecycle.createConfirmedTaskFromMessageSent(2), null);
  assert.equal(state.summary.confirmedTasks.length, 0);

  assert.equal(lifecycle.captureGenerationAfterCommands('regenerate'), false);
  messages.push(user('孤立 U3'));
  assert.equal(lifecycle.createConfirmedTaskFromMessageSent(3), null);
  assert.equal(state.summary.confirmedTasks.length, 0);
});

function summarizedTask(message, status = 'SUMMARIZED') {
  return {
    taskKey: `task:${message.message_id}`,
    chatIdentity: 'chat-a',
    originalMessageId: message.message_id,
    assistantFingerprint: getAssistantMessageContentFingerprint(message),
    selectedSwipeId: message.swipe_id ?? 0,
    confirmingUserMessageId: message.message_id + 1,
    confirmingUserFingerprint: '1:1',
    status,
    createdAt: `2026-07-31T00:00:0${message.message_id}.000Z`,
    updatedAt: `2026-07-31T00:00:0${message.message_id}.000Z`,
  };
}

test('three Grand archive rounds continue from archiveTo and stop at a PENDING or FAILED gap', () => {
  const a = { message_id: 0, role: 'assistant', swipe_id: 0, message: 'A\n<memory>[n:1] A</memory>' };
  const b = { message_id: 2, role: 'assistant', swipe_id: 0, message: 'B\n<memory>[n:2] B</memory>' };
  const firstGrand = { message_id: 3, role: 'assistant', message: '<grand_memory>Grand A</grand_memory>' };
  const c = { message_id: 4, role: 'assistant', swipe_id: 0, message: 'C 未完成' };
  const d = { message_id: 6, role: 'assistant', swipe_id: 0, message: 'D\n<memory>[n:4] D</memory>' };
  const state = {
    summary: {
      lastArchivedMessageId: -1,
      archiveRecords: [],
      processedMessageFingerprints: {},
      confirmedTasks: [summarizedTask(a)],
    },
  };
  const messages = [a, user('U1'), b, firstGrand, c, user('U2'), d];

  assert.equal(calculateSafeArchiveTo(messages, state), 0);
  state.summary.archiveRecords.push({ id: 'grand-a', summaryMessageId: 3, archiveFrom: 0, archiveTo: 0 });
  state.summary.lastArchivedMessageId = 0;
  state.summary.confirmedTasks.push(summarizedTask(b));
  assert.equal(calculateSafeArchiveTo(messages, state), 2);

  state.summary.archiveRecords.push({ id: 'grand-b', summaryMessageId: 7, archiveFrom: 1, archiveTo: 2 });
  state.summary.lastArchivedMessageId = 2;
  state.summary.confirmedTasks.push(summarizedTask(c, 'PENDING'), summarizedTask(d));
  assert.equal(calculateSafeArchiveTo(messages, state), null);
  state.summary.confirmedTasks.find(task => task.originalMessageId === 4).status = 'FAILED';
  assert.equal(calculateSafeArchiveTo(messages, state), null);
});
