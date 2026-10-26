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
    onSummaryCommitted: options.onSummaryCommitted,
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
    generationIdleRecoveryIntervalMs: options.generationIdleRecoveryIntervalMs,
    scheduleGenerationIdleRecoveryCheck: options.scheduleGenerationIdleRecoveryCheck || (() => {}),
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

test('a successful confirmed Summary schedules its downstream effects only after it is persisted as SUMMARIZED', async () => {
  let observedStatus = '';
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    onSummaryCommitted: confirmedTask => {
      observedStatus = confirmedTask.status;
    },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'SUMMARIZED');
  assert.equal(observedStatus, 'SUMMARIZED');
});

test('a confirmed Summary is counted once for the automatic Grand Memory interval', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')]);
  await harness.consumer.drainConfirmedQueue();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.state.summary.memoryCountedMessageIds, [1]);
  assert.equal(harness.state.summary.memoryCountSinceArchive, 1);
  assert.equal(harness.state.summary.smallSummaryCount, 1);
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

for (const timeoutCode of ['MAIN_TIMEOUT', 'SECONDARY_TIMEOUT', 'TIMEOUT_ABORT', 'SUMMARY_TRANSPORT_TIMEOUT']) {
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
  harness.consumer.handleMainGenerationStarted();
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
  harness.consumer.handleMainGenerationStarted();
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
  harness.consumer.handleMainGenerationStarted();
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, []);

  assert.equal(harness.consumer.recoverAwaitingGenerationAfterIdle(), true);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generate, [1]);
});

test('generation idle recovery uses an injected non-zero interval instead of drain defer timing', () => {
  const delays = [];
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')], {
    generationIdleRecoveryIntervalMs: 125,
    scheduleGenerationIdleRecoveryCheck: (_callback, delay) => { delays.push(delay); },
  });
  harness.consumer.handleMainGenerationStarted();
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  assert.deepEqual(delays, [125]);
});

test('repeated terminal and render wakeups keep a confirmed Summary idempotent', async () => {
  const harness = createHarness([task('1', '2026-07-30T00:00:01.000Z')]);
  harness.consumer.handleMainGenerationStarted();
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
  harness.consumer.handleMainGenerationStarted();
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[0]);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.write, []);

  generating = false;
  harness.consumer.handleMainGenerationTerminal();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.write, [[1, 'summary:1']]);
});

test('a B terminal cannot release A gate, while returning to A restarts bounded idle recovery', async () => {
  const stateA = { summary: { confirmedQueueActivatedAt: '2026-07-30T00:00:00.000Z', confirmedTasks: [task('1', '2026-07-30T00:00:01.000Z')], processedMessageFingerprints: {} } };
  const stateB = { summary: { confirmedQueueActivatedAt: '2026-07-30T00:00:00.000Z', confirmedTasks: [], processedMessageFingerprints: {} } };
  let currentChat = 'chat-a';
  const recoveryCallbacks = [];
  const writes = [];
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => currentChat === 'chat-a' ? stateA : stateB,
    saveChatState: () => {},
    getChatIdentity: () => currentChat,
    isEnabled: () => true,
    isGenerating: () => false,
    isTargetValid: () => true,
    getSummaryFingerprint: () => 'summary:1',
    generate: async () => ({ fingerprint: 'summary:1', memory: '<memory>A</memory>' }),
    write: async (...args) => { writes.push(args); return true; },
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
    maxGenerationIdleRecoveryChecks: 1,
    scheduleGenerationIdleRecoveryCheck: callback => { recoveryCallbacks.push(callback); },
  });
  consumer.handleMainGenerationStarted();
  consumer.holdConfirmedTaskUntilGenerationTerminal(stateA.summary.confirmedTasks[0]);

  currentChat = 'chat-b';
  consumer.handleMainGenerationStarted();
  consumer.handleMainGenerationTerminal();
  recoveryCallbacks.shift()();
  assert.equal(stateA.summary.confirmedTasks[0].status, 'PENDING');
  assert.deepEqual(writes, []);

  currentChat = 'chat-a';
  assert.equal(consumer.handleChatChanged(), true);
  recoveryCallbacks.shift()();
  await consumer.drainConfirmedQueue();
  assert.equal(stateA.summary.confirmedTasks[0].status, 'SUMMARIZED');
  assert.equal(writes.length, 1);
});

// ── Phase 2: 合并小总结（intervalMessages > 1）────────────────────────

function createGroupHarness(tasks, options = {}) {
  const state = {
    summary: {
      confirmedQueueActivatedAt: options.activatedAt ?? '2026-07-30T00:00:00.000Z',
      confirmedTasks: tasks,
      processedMessageFingerprints: {},
    },
  };
  const calls = { generateGroup: [], writeGroup: [], save: 0 };
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => state,
    saveChatState: () => { calls.save += 1; },
    getChatIdentity: options.getChatIdentity || (() => 'chat-a'),
    isGenerating: options.isGenerating || (() => false),
    isEnabled: options.isEnabled || (() => true),
    isTargetValid: options.isTargetValid || (() => true),
    getSummaryFingerprint: options.getSummaryFingerprint || (messageId => `summary:${messageId}`),
    generate: options.generate,
    write: options.write,
    getBatchSize: options.getBatchSize || (() => 3),
    generateGroup: options.generateGroup || (async messageIds => {
      calls.generateGroup.push(messageIds);
      return {
        fingerprints: Object.fromEntries(messageIds.map(id => [id, `summary:${id}`])),
        memory: '<memory>merged</memory>',
      };
    }),
    writeGroup: options.writeGroup || (async (messageIds, fingerprints, memory) => {
      calls.writeGroup.push([messageIds, memory]);
      return true;
    }),
    onSummaryCommitted: options.onSummaryCommitted,
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
    scheduleGenerationIdleRecoveryCheck: options.scheduleGenerationIdleRecoveryCheck || (() => {}),
  });
  return { state, calls, consumer };
}

test('N=3 with only 2 pending tasks does not generate; the 3rd task triggers one merged summary on the last floor', async () => {
  const harness = createGroupHarness([
    task('2', '2026-07-30T00:00:01.000Z'),
    task('4', '2026-07-30T00:00:02.000Z'),
  ]);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generateGroup, []);
  assert.deepEqual(harness.state.summary.confirmedTasks.map(item => item.status), ['PENDING', 'PENDING']);

  harness.state.summary.confirmedTasks.push(task('6', '2026-07-30T00:00:03.000Z'));
  const committedStatuses = [];
  const consumerWithCommit = createConfirmedSummaryConsumer({
    getChatState: () => harness.state,
    saveChatState: () => {},
    getChatIdentity: () => 'chat-a',
    isGenerating: () => false,
    isEnabled: () => true,
    isTargetValid: () => true,
    getSummaryFingerprint: messageId => `summary:${messageId}`,
    getBatchSize: () => 3,
    generateGroup: async messageIds => {
      harness.calls.generateGroup.push(messageIds);
      return {
        fingerprints: Object.fromEntries(messageIds.map(id => [id, `summary:${id}`])),
        memory: '<memory>merged</memory>',
      };
    },
    writeGroup: async (messageIds, fingerprints, memory) => {
      harness.calls.writeGroup.push([messageIds, memory]);
      return true;
    },
    onSummaryCommitted: committed => {
      committedStatuses.push([
        committed.status,
        harness.state.summary.confirmedTasks.map(item => item.status).join(','),
      ]);
    },
    formatTimestamp: () => '2026-07-30T00:00:01.000Z',
    defer: () => {},
  });
  await consumerWithCommit.drainConfirmedQueue();

  assert.deepEqual(harness.calls.generateGroup, [[2, 4, 6]]);
  assert.deepEqual(harness.calls.writeGroup, [[[2, 4, 6], '<memory>merged</memory>']]);
  assert.deepEqual(harness.state.summary.confirmedTasks.map(item => item.status), ['SUMMARIZED', 'SUMMARIZED', 'SUMMARIZED']);
  assert.deepEqual(harness.state.summary.confirmedTasks[0].effects, { affection: 'SKIPPED', emotion: 'SKIPPED', plot: 'SKIPPED' });
  assert.deepEqual(harness.state.summary.confirmedTasks[1].effects, { affection: 'SKIPPED', emotion: 'SKIPPED', plot: 'SKIPPED' });
  assert.equal(harness.state.summary.memoryCountSinceArchive, 1);
  assert.equal(harness.state.summary.smallSummaryCount, 1);
  assert.equal(harness.state.summary.lastSummaryMessageId, 6);
  assert.deepEqual(committedStatuses, [['SUMMARIZED', 'SUMMARIZED,SUMMARIZED,SUMMARIZED']]);
});

test('N=3 group generation gate: any gated member blocks the whole group until released', async () => {
  const harness = createGroupHarness([
    task('2', '2026-07-30T00:00:01.000Z'),
    task('4', '2026-07-30T00:00:02.000Z'),
    task('6', '2026-07-30T00:00:03.000Z'),
  ]);
  harness.consumer.handleMainGenerationStarted();
  harness.consumer.holdConfirmedTaskUntilGenerationTerminal(harness.state.summary.confirmedTasks[2]);
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generateGroup, []);

  harness.consumer.handleMainGenerationTerminal();
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.generateGroup, [[2, 4, 6]]);
});

test('N=3 group failure marks lead and members FAILED with the same error code', async () => {
  const harness = createGroupHarness([
    task('2', '2026-07-30T00:00:01.000Z'),
    task('4', '2026-07-30T00:00:02.000Z'),
    task('6', '2026-07-30T00:00:03.000Z'),
  ], {
    generateGroup: async () => { throw new Error('transport failure'); },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.state.summary.confirmedTasks.map(item => item.status), ['FAILED', 'FAILED', 'FAILED']);
  assert.deepEqual(
    harness.state.summary.confirmedTasks.map(item => item.lastErrorCode),
    ['SUMMARY_GENERATION_FAILED', 'SUMMARY_GENERATION_FAILED', 'SUMMARY_GENERATION_FAILED'],
  );
});

test('N=3 member fingerprint change after generation returns lead to PENDING without writing', async () => {
  let fingerprint4 = 'summary:4';
  const harness = createGroupHarness([
    task('2', '2026-07-30T00:00:01.000Z'),
    task('4', '2026-07-30T00:00:02.000Z'),
    task('6', '2026-07-30T00:00:03.000Z'),
  ], {
    getSummaryFingerprint: messageId => (Number(messageId) === 4 ? fingerprint4 : `summary:${messageId}`),
    generateGroup: async messageIds => {
      const firstCall = harness.calls.generateGroup.length === 0;
      const generatedFingerprints = Object.fromEntries(
        messageIds.map(id => [id, `summary:${id}`]),
      );
      if (firstCall) fingerprint4 = 'summary:4-changed';
      harness.calls.generateGroup.push(messageIds);
      return {
        // Fingerprints captured at generation time (before the edit) — stale for id 4.
        fingerprints: firstCall
          ? generatedFingerprints
          : Object.fromEntries(
              messageIds.map(id => [id, Number(id) === 4 ? fingerprint4 : `summary:${id}`]),
            ),
        memory: '<memory>merged</memory>',
      };
    },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.calls.writeGroup, []);
  assert.equal(harness.state.summary.confirmedTasks[2].status, 'PENDING');
  assert.equal(harness.state.summary.confirmedTasks[2].executionToken, undefined);
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'PENDING');
  assert.equal(harness.state.summary.confirmedTasks[1].status, 'PENDING');

  // Next drain regroups with the new content (member 4 keeps the new text).
  harness.state.summary.confirmedTasks.push(task('8', '2026-07-30T00:00:04.000Z'));
  await harness.consumer.drainConfirmedQueue();
  assert.deepEqual(harness.state.summary.confirmedTasks.map(item => item.status), ['SUMMARIZED', 'SUMMARIZED', 'SUMMARIZED', 'PENDING']);
});

test('N=3 lead target invalid after generation cancels lead and keeps members PENDING', async () => {
  let leadValid = true;
  const harness = createGroupHarness([
    task('2', '2026-07-30T00:00:01.000Z'),
    task('4', '2026-07-30T00:00:02.000Z'),
    task('6', '2026-07-30T00:00:03.000Z'),
  ], {
    isTargetValid: candidate => (Number(candidate.originalMessageId) === 6 ? leadValid : true),
    generateGroup: async messageIds => {
      leadValid = false;
      return {
        fingerprints: Object.fromEntries(messageIds.map(id => [id, `summary:${id}`])),
        memory: '<memory>merged</memory>',
      };
    },
  });
  await harness.consumer.drainConfirmedQueue();
  assert.equal(harness.state.summary.confirmedTasks[2].status, 'CANCELLED');
  assert.equal(harness.state.summary.confirmedTasks[0].status, 'PENDING');
  assert.equal(harness.state.summary.confirmedTasks[1].status, 'PENDING');
  assert.deepEqual(harness.calls.writeGroup, []);
});
