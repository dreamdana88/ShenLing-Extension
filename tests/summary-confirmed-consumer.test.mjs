import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfirmedSummaryConsumer } from '../src/features/summary/confirmed-consumer.js';

function task(key, createdAt) {
  return {
    taskKey: key,
    chatIdentity: 'chat-a',
    originalMessageId: Number(key),
    assistantFingerprint: '1:1',
    selectedSwipeId: 0,
    confirmingUserMessageId: Number(key) + 1,
    confirmingUserFingerprint: '1:2',
    status: 'PENDING',
    createdAt,
    updatedAt: createdAt,
  };
}

function createHarness(tasks, options = {}) {
  const state = {
    summary: {
      confirmedQueueActivatedAt: options.activatedAt ?? '2026-07-30T00:00:00.000Z',
      confirmedTasks: tasks,
      processedMessageFingerprints: {},
    },
  };
  const calls = { generate: [], write: [], save: 0 };
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => state,
    saveChatState: () => { calls.save += 1; },
    getChatIdentity: options.getChatIdentity || (() => 'chat-a'),
    isGenerating: options.isGenerating || (() => false),
    isEnabled: options.isEnabled || (() => true),
    isTargetValid: options.isTargetValid || (() => true),
    getSummaryFingerprint: messageId => `summary:${messageId}`,
    generate: options.generate || (async messageId => {
      calls.generate.push(messageId);
      return { fingerprint: `summary:${messageId}`, memory: `<memory>${messageId}</memory>` };
    }),
    write: options.write || (async (messageId, fingerprint) => {
      calls.write.push([messageId, fingerprint]);
      return true;
    }),
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
  });
  return { state, calls, consumer };
}

test('activation cancels pre-activation observation tasks without calling Summary', async () => {
  const harness = createHarness([task('1', '2026-07-29T00:00:00.000Z')], { activatedAt: '' });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.deepEqual(harness.calls.generate, []);
});

test('confirmed tasks consume in created order and only one task runs at a time', async () => {
  const harness = createHarness([
    task('1', '2026-07-30T00:00:01.000Z'),
    task('3', '2026-07-30T00:00:02.000Z'),
  ]);
  await harness.consumer.drainConfirmedQueue();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1, 3]);
  assert.deepEqual(harness.state.summary.confirmedTasks.map(item => item.status), ['SUMMARIZED', 'SUMMARIZED']);
});

test('a duplicate drain cannot issue a second Summary request for the same task', async () => {
  let resolveGenerate;
  const pendingGenerate = new Promise(resolve => { resolveGenerate = resolve; });
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    generate: async messageId => {
      harness.calls.generate.push(messageId);
      await pendingGenerate;
      return { fingerprint: `summary:${messageId}`, memory: '<memory>ok</memory>' };
    },
  });
  const firstDrain = harness.consumer.drainConfirmedQueue();
  await Promise.resolve();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1]);
  resolveGenerate();
  await firstDrain;
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'SUMMARIZED');
});

test('a changed target after the request returns is cancelled without writing', async () => {
  let valid = true;
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    isTargetValid: () => valid,
    generate: async messageId => {
      valid = false;
      return { fingerprint: `summary:${messageId}`, memory: '<memory>late</memory>' };
    },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.deepEqual(harness.calls.write, []);
});

test('a chat switch during the request returns the task to PENDING without cross-chat writing', async () => {
  let currentChat = 'chat-a';
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    getChatIdentity: () => currentChat,
    generate: async messageId => {
      currentChat = 'chat-b';
      return { fingerprint: `summary:${messageId}`, memory: '<memory>late</memory>' };
    },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'PENDING');
  assert.deepEqual(harness.calls.write, []);
});

test('Summary failure becomes FAILED and does not block the next pending task', async () => {
  const harness = createHarness([
    task('1', '2026-07-30T00:00:01.000Z'),
    task('3', '2026-07-30T00:00:02.000Z'),
  ], {
    generate: async messageId => {
      harness.calls.generate.push(messageId);
      if (messageId === 1) throw new Error('transport failure');
      return { fingerprint: `summary:${messageId}`, memory: '<memory>ok</memory>' };
    },
  });
  await harness.consumer.drainConfirmedQueue();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1, 3]);
  assert.deepEqual(harness.state.summary.confirmedTasks.map(item => item.status), ['FAILED', 'SUMMARIZED']);
});

test('generation-in-progress defers consumption without changing a pending task', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    isGenerating: () => true,
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'PENDING');
  assert.deepEqual(harness.calls.generate, []);
});
