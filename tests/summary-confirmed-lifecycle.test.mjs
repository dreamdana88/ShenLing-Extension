import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageContentFingerprint } from '../src/core/message-fingerprint.js';
import { getConfirmedSummaryTasks } from '../src/core/settings.js';
import {
  CONFIRMED_SEND_CONTEXT_TTL_MS,
  createConfirmedLifecycleCoordinator,
  createConfirmedTaskKey,
} from '../src/features/summary/confirmed-lifecycle.js';

function user(message) {
  return { role: 'user', message };
}

function assistant(message, swipeId = 0) {
  return { role: 'assistant', message, swipe_id: swipeId };
}

function fingerprint(message) {
  return createMessageContentFingerprint(message?.message ?? '');
}

function createHarness({ chats = null, now = 1_700_000_000_000 } = {}) {
  const chatStore = chats || {
    'chat-a': {
      messages: [user('开场'), assistant('A 的正式候选')],
      state: { identity: { chatId: 'chat-a' }, summary: { confirmedTasks: [] } },
    },
  };
  let currentChatId = Object.keys(chatStore)[0];
  let currentNow = now;
  let saveCount = 0;
  const coordinatorOptions = {
    getSnapshot: () => {
      const current = chatStore[currentChatId];
      return {
        chatIdentity: currentChatId,
        chatState: current.state,
        messages: current.messages,
      };
    },
    saveChatState: () => { saveCount += 1; },
    now: () => currentNow,
    createTimestamp: value => `t:${value}`,
    getAssistantFingerprint: fingerprint,
    getUserFingerprint: fingerprint,
  };
  const coordinator = createConfirmedLifecycleCoordinator(coordinatorOptions);

  return {
    chatStore,
    coordinator,
    createPageCoordinator: () => createConfirmedLifecycleCoordinator(coordinatorOptions),
    get current() { return chatStore[currentChatId]; },
    get currentChatId() { return currentChatId; },
    get now() { return currentNow; },
    get saveCount() { return saveCount; },
    setCurrentChat(chatId) { currentChatId = chatId; },
    advance(milliseconds) { currentNow += milliseconds; },
    taskList(chatId = currentChatId) { return chatStore[chatId].state.summary.confirmedTasks; },
  };
}

function confirmTailUser(harness, message = 'U2：继续剧情', type = 'normal', options = {}, dryRun = false) {
  assert.equal(harness.coordinator.captureGenerationAfterCommands(type, options, dryRun), true);
  harness.current.messages.push(user(message));
  return harness.coordinator.createConfirmedTaskFromMessageSent(harness.current.messages.length - 1);
}

test('normal AFTER_COMMANDS plus tail MESSAGE_SENT creates exactly one minimal pending task', () => {
  const harness = createHarness();
  const task = confirmTailUser(harness);

  assert.equal(task.status, 'PENDING');
  assert.equal(task.chatIdentity, 'chat-a');
  assert.equal(task.originalMessageId, 1);
  assert.equal(task.confirmingUserMessageId, 2);
  assert.equal(task.selectedSwipeId, 0);
  assert.equal(harness.taskList().length, 1);
  assert.equal(harness.saveCount, 1);
  assert.equal(task.createdAt, 't:1700000000000');
  assert.equal(task.updatedAt, 't:1700000000000');
});

test('bare MESSAGE_SENT, isolated Slash-style sends, and generation-start-only paths do not confirm', () => {
  const harness = createHarness();
  harness.current.messages.push(user('裸发送'));
  assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(2), null);
  assert.equal(harness.taskList().length, 0);

  // Slash/extension path: it can append a user message, but has no valid AFTER_COMMANDS context.
  harness.current.messages.push(user('/run extension action'));
  assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(3), null);
  assert.equal(harness.taskList().length, 0);
});

test('expired sending context and a chat switch cannot create a task', () => {
  const harness = createHarness({
    chats: {
      'chat-a': {
        messages: [user('开场 A'), assistant('A 候选')],
        state: { identity: { chatId: 'chat-a' }, summary: { confirmedTasks: [] } },
      },
      'chat-b': {
        messages: [user('开场 B'), assistant('B 候选')],
        state: { identity: { chatId: 'chat-b' }, summary: { confirmedTasks: [] } },
      },
    },
  });
  harness.coordinator.captureGenerationAfterCommands();
  harness.advance(CONFIRMED_SEND_CONTEXT_TTL_MS + 1);
  harness.current.messages.push(user('过期发送'));
  assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(2), null);

  harness.coordinator.captureGenerationAfterCommands();
  harness.setCurrentChat('chat-b');
  harness.current.messages.push(user('不属于 A 的发送'));
  assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(2), null);
  assert.equal(harness.taskList('chat-a').length, 0);
  assert.equal(harness.taskList('chat-b').length, 0);
});

test('Quick Reply-equivalent normal events are idempotent and retain the original task identity', () => {
  const harness = createHarness();
  const first = confirmTailUser(harness, 'Quick Reply：继续');
  assert.equal(harness.coordinator.captureGenerationAfterCommands('normal'), true);
  const duplicate = harness.coordinator.createConfirmedTaskFromMessageSent(2);

  assert.equal(duplicate, null);
  assert.equal(harness.taskList().length, 1);
  assert.equal(harness.taskList()[0].taskKey, first.taskKey);
  assert.equal(harness.taskList()[0].status, 'PENDING');
});

test('task identity is deterministic and includes the selected swipe and confirming user fingerprint', () => {
  const base = {
    chatIdentity: 'chat-a',
    originalMessageId: 7,
    assistantFingerprint: '10:123',
    selectedSwipeId: 2,
    confirmingUserFingerprint: '8:456',
  };
  assert.equal(createConfirmedTaskKey(base), createConfirmedTaskKey(base));
  assert.notEqual(
    createConfirmedTaskKey(base),
    createConfirmedTaskKey({ ...base, selectedSwipeId: 3 }),
  );
  assert.notEqual(
    createConfirmedTaskKey(base),
    createConfirmedTaskKey({ ...base, confirmingUserFingerprint: '9:456' }),
  );
});

test('different chats keep their confirmed queues isolated', () => {
  const harness = createHarness({
    chats: {
      'chat-a': {
        messages: [user('开场 A'), assistant('A 候选')],
        state: { identity: { chatId: 'chat-a' }, summary: { confirmedTasks: [] } },
      },
      'chat-b': {
        messages: [user('开场 B'), assistant('B 候选')],
        state: { identity: { chatId: 'chat-b' }, summary: { confirmedTasks: [] } },
      },
    },
  });
  confirmTailUser(harness, 'A 的 U2');
  harness.setCurrentChat('chat-b');
  confirmTailUser(harness, 'B 的 U2');

  assert.equal(harness.taskList('chat-a').length, 1);
  assert.equal(harness.taskList('chat-b').length, 1);
  assert.notEqual(harness.taskList('chat-a')[0].taskKey, harness.taskList('chat-b')[0].taskKey);
});

test('Swipe, received/rendered/end/stopped-style wakeups do not create tasks without MESSAGE_SENT', () => {
  const harness = createHarness();
  harness.coordinator.captureGenerationAfterCommands();
  harness.current.messages[1] = assistant('A 的新 Swipe 候选', 1);
  harness.coordinator.reconcileCurrentChatTasks();
  harness.coordinator.recoverCurrentChatTasks();

  assert.equal(harness.taskList().length, 0);
});

for (const [name, type, options, dryRun] of [
  ['Swipe', 'swipe', {}, false],
  ['Regenerate', 'regenerate', {}, false],
  ['Continue', 'continue', {}, false],
  ['dryRun', 'normal', {}, true],
  ['automatic_trigger', 'normal', { automatic_trigger: true }, false],
]) {
  test(`${name} AFTER_COMMANDS followed by an isolated MESSAGE_SENT does not create a task`, () => {
    const harness = createHarness();
    assert.equal(harness.coordinator.captureGenerationAfterCommands(type, options, dryRun), false);
    harness.current.messages.push(user(`${name} 的孤立发送`));
    assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(2), null);
    assert.equal(harness.taskList().length, 0);
  });
}

test('a new GENERATION_STARTED clears an earlier normal send context', () => {
  const harness = createHarness();
  assert.equal(harness.coordinator.captureGenerationAfterCommands('normal'), true);
  assert.deepEqual(harness.coordinator.getPendingSendContext(), {
    chatIdentity: 'chat-a',
    messageCount: 2,
    generationType: 'normal',
    capturedAt: 1_700_000_000_000,
  });
  assert.equal(harness.coordinator.clearPendingSendContext(), true);
  harness.current.messages.push(user('旧上下文不应确认'));
  assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(2), null);
});

test('editing a pending assistant reply or changing its selected swipe cancels the old task', () => {
  const harness = createHarness();
  confirmTailUser(harness);
  harness.current.messages[1] = assistant('A 被编辑后的正文', 0);
  assert.deepEqual(harness.coordinator.reconcileCurrentChatTasks(), {
    changed: true,
    cancelled: 1,
    relocated: 0,
  });
  assert.equal(harness.taskList()[0].status, 'CANCELLED');

  const swipeHarness = createHarness();
  confirmTailUser(swipeHarness);
  swipeHarness.current.messages[1] = assistant('A 的正式候选', 1);
  swipeHarness.coordinator.reconcileCurrentChatTasks();
  assert.equal(swipeHarness.taskList()[0].status, 'CANCELLED');
});

test('a deleted leading message can uniquely relocate a task through its adjacent confirming user', () => {
  const harness = createHarness();
  confirmTailUser(harness);
  harness.current.messages.splice(0, 1);

  assert.deepEqual(harness.coordinator.reconcileCurrentChatTasks(), {
    changed: true,
    cancelled: 0,
    relocated: 1,
  });
  const [task] = harness.taskList();
  assert.equal(task.status, 'PENDING');
  assert.equal(task.originalMessageId, 0);
  assert.equal(task.confirmingUserMessageId, 1);
});

test('missing or ambiguous deletion relocation cancels rather than blindly searching the chat', () => {
  const missing = createHarness();
  confirmTailUser(missing);
  missing.current.messages[1] = assistant('被替换成不同正文');
  missing.coordinator.reconcileCurrentChatTasks();
  assert.equal(missing.taskList()[0].status, 'CANCELLED');

  const ambiguous = createHarness();
  confirmTailUser(ambiguous);
  ambiguous.current.messages.splice(0, 1, assistant('A 的正式候选'), user('U2：继续剧情'));
  ambiguous.coordinator.reconcileCurrentChatTasks();
  assert.equal(ambiguous.taskList()[0].status, 'CANCELLED');
});

test('refresh normalizes RUNNING back to PENDING while SUMMARIZED never revives', () => {
  const pending = createHarness();
  confirmTailUser(pending);
  pending.taskList()[0].status = 'RUNNING';
  pending.coordinator.recoverCurrentChatTasks();
  assert.equal(pending.taskList()[0].status, 'PENDING');

  const summarized = createHarness();
  confirmTailUser(summarized);
  summarized.taskList()[0].status = 'SUMMARIZED';
  summarized.current.messages[1] = assistant('编辑后的正文');
  summarized.coordinator.recoverCurrentChatTasks();
  assert.equal(summarized.taskList()[0].status, 'SUMMARIZED');
});

test('ordinary normalize, queue reads, and reconciliation preserve RUNNING', () => {
  const harness = createHarness();
  confirmTailUser(harness);
  harness.taskList()[0].status = 'RUNNING';
  assert.equal(getConfirmedSummaryTasks(harness.current.state)[0].status, 'RUNNING');
  assert.equal(harness.taskList()[0].status, 'RUNNING');
  harness.coordinator.reconcileCurrentChatTasks();
  assert.equal(harness.taskList()[0].status, 'RUNNING');
});

test('same-page chat changes preserve RUNNING after the chat has been recovered once', () => {
  const harness = createHarness({
    chats: {
      'chat-a': {
        messages: [user('开场 A'), assistant('A 候选')],
        state: { identity: { chatId: 'chat-a' }, summary: { confirmedTasks: [] } },
      },
      'chat-b': {
        messages: [user('开场 B'), assistant('B 候选')],
        state: { identity: { chatId: 'chat-b' }, summary: { confirmedTasks: [] } },
      },
    },
  });
  confirmTailUser(harness);
  harness.coordinator.recoverCurrentChatTasks();
  harness.taskList()[0].status = 'RUNNING';
  harness.setCurrentChat('chat-b');
  harness.coordinator.handleChatChanged();
  harness.setCurrentChat('chat-a');
  harness.coordinator.handleChatChanged();
  assert.equal(harness.taskList()[0].status, 'RUNNING');
});

test('a new page session performs the one-time RUNNING recovery', () => {
  const harness = createHarness();
  confirmTailUser(harness);
  harness.taskList()[0].status = 'RUNNING';
  const nextPageCoordinator = harness.createPageCoordinator();
  nextPageCoordinator.recoverCurrentChatTasks();
  assert.equal(harness.taskList()[0].status, 'PENDING');
});

test('B generation, Roll, and Swipe activity cannot rebuild A after A is confirmed', () => {
  const harness = createHarness();
  const taskA = confirmTailUser(harness);
  harness.current.messages.push(assistant('B1 候选', 0));
  harness.coordinator.captureGenerationAfterCommands();
  harness.current.messages[harness.current.messages.length - 1] = assistant('B2 Roll 候选', 1);
  harness.coordinator.recoverCurrentChatTasks();
  harness.current.messages[harness.current.messages.length - 1] = assistant('B3 Swipe 候选', 2);
  harness.coordinator.reconcileCurrentChatTasks();

  assert.equal(harness.taskList().length, 1);
  assert.equal(harness.taskList()[0].taskKey, taskA.taskKey);
  assert.equal(harness.taskList()[0].status, 'PENDING');
});

for (const [name, mutateUser] of [
  ['hidden', message => { message.is_hidden = true; }],
  ['system', message => { message.is_system = true; }],
  ['isSmallSys', message => { message.extra = { isSmallSys: true }; }],
]) {
  test(`${name} tail user does not create a confirmed task`, () => {
    const harness = createHarness();
    assert.equal(harness.coordinator.captureGenerationAfterCommands('normal'), true);
    const confirmingUser = user(`${name} user`);
    mutateUser(confirmingUser);
    harness.current.messages.push(confirmingUser);
    assert.equal(harness.coordinator.createConfirmedTaskFromMessageSent(2), null);
    assert.equal(harness.taskList().length, 0);
  });

  test(`a confirming user changed to ${name} cancels its active task`, () => {
    const harness = createHarness();
    confirmTailUser(harness);
    mutateUser(harness.current.messages[2]);
    harness.coordinator.reconcileCurrentChatTasks();
    assert.equal(harness.taskList()[0].status, 'CANCELLED');
  });
}

test('old metadata loads safely and persisted tasks never retain body, prompt, API key, or error payloads', () => {
  const legacyState = { summary: { smallSummaryCount: 3 } };
  assert.deepEqual(getConfirmedSummaryTasks(legacyState), []);
  assert.deepEqual(legacyState.summary.confirmedTasks, []);

  const harness = createHarness();
  confirmTailUser(harness, 'U2：包含不应持久化的内容');
  const serialized = JSON.stringify(harness.taskList()[0]);
  assert.equal(serialized.includes('A 的正式候选'), false);
  assert.equal(serialized.includes('不应持久化的内容'), false);
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('error'), false);
});
