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
    maxGenerationIdleRecoveryChecks: options.maxGenerationIdleRecoveryChecks,
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

test('a chat switch keeps B untouched, restores A, then consumes A once after return', async () => {
  const stateA = { summary: { confirmedQueueActivatedAt: '2026-07-30T00:00:00.000Z', confirmedTasks: [task('1', '2026-07-30T00:00:01.000Z')], processedMessageFingerprints: {} } };
  const stateB = { summary: { confirmedQueueActivatedAt: '2026-07-30T00:00:00.000Z', confirmedTasks: [], processedMessageFingerprints: {} } };
  let currentChat = 'chat-a';
  let pauseAfterReturn = false;
  const calls = { generate: 0, write: 0, savedB: 0 };
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => currentChat === 'chat-a' ? stateA : stateB,
    saveChatState: () => { if (currentChat === 'chat-b') calls.savedB += 1; },
    getChatIdentity: () => currentChat,
    isGenerating: () => pauseAfterReturn,
    isEnabled: () => true,
    isTargetValid: () => true,
    getSummaryFingerprint: () => 'summary:1',
    generate: async messageId => {
      calls.generate += 1;
      if (calls.generate === 1) currentChat = 'chat-b';
      return { fingerprint: `summary:${messageId}`, memory: '<memory>late</memory>' };
    },
    write: async () => { calls.write += 1; return true; },
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
  });
  await consumer.drainConfirmedQueue();
  assert.equal(stateA.summary.confirmedTasks[0].status, 'RUNNING');
  assert.deepEqual(stateB.summary.confirmedTasks, []);
  assert.equal(calls.write, 0);
  assert.equal(calls.savedB, 0);

  currentChat = 'chat-a';
  pauseAfterReturn = true;
  await consumer.drainConfirmedQueue();
  assert.equal(stateA.summary.confirmedTasks[0].status, 'PENDING');
  pauseAfterReturn = false;
  await consumer.drainConfirmedQueue();
  assert.equal(stateA.summary.confirmedTasks[0].status, 'SUMMARIZED');
  assert.equal(calls.write, 1);
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
  assert.equal(harness.state.summary.confirmedTasks[0].lastErrorCode, 'SUMMARY_GENERATION_FAILED');
});

test('disabling Summary cancels pending tasks and reopening cannot consume them', async () => {
  let enabled = false;
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], { isEnabled: () => enabled });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.equal(harness.state.summary.confirmedTasks[0].reasonCode, 'SUMMARY_DISABLED');
  enabled = true;
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, []);
});

test('disabling Summary while RUNNING discards the returned result without writing', async () => {
  let enabled = true;
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    isEnabled: () => enabled,
    generate: async messageId => {
      enabled = false;
      return { fingerprint: `summary:${messageId}`, memory: '<memory>late</memory>' };
    },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.equal(harness.state.summary.confirmedTasks[0].reasonCode, 'SUMMARY_DISABLED');
  assert.deepEqual(harness.calls.write, []);
});

test('a RUNNING request cancelled while disabled stays cancelled after an immediate reopen', async () => {
  let enabled = true;
  let resolveGenerate;
  const pendingGenerate = new Promise(resolve => { resolveGenerate = resolve; });
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    isEnabled: () => enabled,
    generate: async messageId => {
      harness.calls.generate.push(messageId);
      await pendingGenerate;
      return { fingerprint: `summary:${messageId}`, memory: '<memory>late</memory>' };
    },
  });
  const drain = harness.consumer.drainConfirmedQueue();
  await Promise.resolve();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'RUNNING');
  enabled = false;
  harness.consumer.handleAutoSummaryEnabledChanged(false);
  enabled = true;
  harness.consumer.handleAutoSummaryEnabledChanged(true);
  resolveGenerate();
  await drain;

  assert.equal(harness.state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.equal(harness.state.summary.confirmedTasks[0].reasonCode, 'SUMMARY_DISABLED');
  assert.deepEqual(harness.calls.write, []);
});

test('a cross-chat RUNNING request retains its disable cancellation intent after reopening', async () => {
  const stateA = { summary: { confirmedQueueActivatedAt: '2026-07-30T00:00:00.000Z', confirmedTasks: [task('1', '2026-07-30T00:00:01.000Z')], processedMessageFingerprints: {} } };
  const stateB = { summary: { confirmedQueueActivatedAt: '2026-07-30T00:00:00.000Z', confirmedTasks: [], processedMessageFingerprints: {} } };
  let currentChat = 'chat-a';
  let enabled = true;
  let resolveGenerate;
  const pendingGenerate = new Promise(resolve => { resolveGenerate = resolve; });
  const writes = [];
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => currentChat === 'chat-a' ? stateA : stateB,
    saveChatState: () => {},
    getChatIdentity: () => currentChat,
    isEnabled: () => enabled,
    isGenerating: () => false,
    isTargetValid: () => true,
    getSummaryFingerprint: () => 'summary:1',
    generate: async () => {
      currentChat = 'chat-b';
      await pendingGenerate;
      return { fingerprint: 'summary:1', memory: '<memory>late</memory>' };
    },
    write: async (...args) => { writes.push(args); return true; },
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
  });
  const drain = consumer.drainConfirmedQueue();
  await Promise.resolve();
  enabled = false;
  consumer.handleAutoSummaryEnabledChanged(false);
  enabled = true;
  consumer.handleAutoSummaryEnabledChanged(true);
  resolveGenerate();
  await drain;

  assert.deepEqual(stateB.summary.confirmedTasks, []);
  assert.deepEqual(writes, []);
  currentChat = 'chat-a';
  await consumer.drainConfirmedQueue();
  assert.equal(stateA.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.equal(stateA.summary.confirmedTasks[0].reasonCode, 'SUMMARY_DISABLED');
});

for (const timeoutCode of ['MAIN_TIMEOUT', 'SECONDARY_TIMEOUT']) {
  test(`${timeoutCode} is persisted as the safe Summary transport timeout code`, async () => {
    const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
      generate: async () => {
        const error = new Error('transport timeout');
        error.code = timeoutCode;
        throw error;
      },
    });
    await harness.consumer.drainConfirmedQueue();
    assert.equal(harness.state.summary.confirmedTasks[0].status, 'FAILED');
    assert.equal(harness.state.summary.confirmedTasks[0].lastErrorCode, 'SUMMARY_TRANSPORT_TIMEOUT');
  });
}

test('generation-in-progress defers consumption without changing a pending task', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    isGenerating: () => true,
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'PENDING');
  assert.deepEqual(harness.calls.generate, []);
});

test('a freshly confirmed task waits for GENERATION_ENDED even while isGenerating is briefly false', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')]);
  assert.equal(harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]), true);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, []);
  assert.deepEqual(harness.calls.write, []);

  harness.consumer.handleMainGenerationTerminal();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1]);
  assert.deepEqual(harness.calls.write, [[1, 'summary:1']]);
});

test('GENERATION_STOPPED releases the confirmed task once', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')]);
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, []);

  harness.consumer.handleMainGenerationTerminal();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1]);
});

test('a started generation that fails without a terminal event releases after bounded idle recovery', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    maxGenerationIdleRecoveryChecks: 1,
  });
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  harness.consumer.handleMainGenerationStarted();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, []);

  assert.equal(harness.consumer.recoverAwaitingGenerationAfterIdle(), true);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1]);
});

test('repeated terminal and render wakeups keep a confirmed Summary idempotent', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')]);
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  harness.consumer.handleMainGenerationTerminal();
  harness.consumer.handleMainGenerationTerminal();
  harness.consumer.scheduleConfirmedQueueDrain();
  harness.consumer.scheduleConfirmedQueueDrain();
  await harness.consumer.drainConfirmedQueue();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1]);
  assert.deepEqual(harness.calls.write, [[1, 'summary:1']]);
});

test('a B generation gate keeps Summary writes at zero until it terminates', async () => {
  let generating = true;
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    isGenerating: () => generating,
  });
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.write, []);

  generating = false;
  harness.consumer.handleMainGenerationTerminal();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.write, [[1, 'summary:1']]);
});
