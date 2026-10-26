import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import { getAssistantMessageContentFingerprint } from '../src/core/message-fingerprint.js';

let resolveSummaryGroup;

function assistant(message_id, message, extra = {}) {
  return { message_id, role: 'assistant', swipe_id: 0, message, ...extra };
}

function summarizedTask(message, overrides = {}) {
  return {
    taskKey: `t${message.message_id}`,
    chatIdentity: 'chat-a',
    originalMessageId: message.message_id,
    assistantFingerprint: getAssistantMessageContentFingerprint(message),
    selectedSwipeId: 0,
    confirmingUserMessageId: message.message_id - 1,
    confirmingUserFingerprint: '1:2',
    status: 'SUMMARIZED',
    createdAt: 'a',
    updatedAt: 'a',
    ...overrides,
  };
}

function createContext(chatId, chat, summary = {}) {
  return {
    chatId,
    chat,
    extensionSettings: { [MODULE_NAME]: { enabled: true, modules: { summary: {} } } },
    chatMetadata: { [CHAT_STATE_KEY]: { summary } },
    saveMetadataDebounced: () => {},
  };
}

async function withChat(chat, summary, run) {
  const previous = { SillyTavern: globalThis.SillyTavern, window: globalThis.window };
  globalThis.window = globalThis;
  const context = createContext('chat-a', chat, summary);
  globalThis.SillyTavern = { getContext: () => context };
  try {
    resolveSummaryGroup ||= (await import('../src/features/summary/manual.js')).resolveSummaryGroup;
    return run(context.chatMetadata[CHAT_STATE_KEY]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('a single summarized floor resolves to itself', async () => {
  const lead = assistant(2, 'lead\n<memory>m</memory>');
  await withChat([lead], { confirmedTasks: [summarizedTask(lead)] }, chatState => {
    assert.deepEqual(resolveSummaryGroup(2, chatState), [2]);
  });
});

test('member and lead resolve to the same merged group', async () => {
  const member = assistant(2, '成员A');
  const member2 = assistant(4, '成员B');
  const lead = assistant(6, 'lead\n<memory>合并</memory>');
  const chat = [
    assistant(0, '0楼'),
    { message_id: 1, role: 'user', message: 'U1' },
    member,
    { message_id: 3, role: 'user', message: 'U2' },
    member2,
    { message_id: 5, role: 'user', message: 'U3' },
    lead,
  ];
  const summary = {
    confirmedTasks: [summarizedTask(member), summarizedTask(member2), summarizedTask(lead)],
  };
  await withChat(chat, summary, chatState => {
    assert.deepEqual(resolveSummaryGroup(2, chatState), [2, 4, 6]);
    assert.deepEqual(resolveSummaryGroup(4, chatState), [2, 4, 6]);
    assert.deepEqual(resolveSummaryGroup(6, chatState), [2, 4, 6]);
  });
});

test('a cancelled-task hole inside the group is skipped, not a stopper', async () => {
  // Group is floors {2, 6, 8}; floor 4's task was CANCELLED (hole).
  const memberA = assistant(2, '成员A');
  const hole = assistant(4, '空洞楼层');
  const memberB = assistant(6, '成员B');
  const lead = assistant(8, 'lead\n<memory>合并</memory>');
  const chat = [
    assistant(0, '0楼'),
    { message_id: 1, role: 'user', message: 'U' },
    memberA,
    { message_id: 3, role: 'user', message: 'U' },
    hole,
    { message_id: 5, role: 'user', message: 'U' },
    memberB,
    { message_id: 7, role: 'user', message: 'U' },
    lead,
  ];
  const summary = {
    confirmedTasks: [
      summarizedTask(memberA),
      summarizedTask(hole, { status: 'CANCELLED' }),
      summarizedTask(memberB),
      summarizedTask(lead),
    ],
  };
  await withChat(chat, summary, chatState => {
    assert.deepEqual(resolveSummaryGroup(2, chatState), [2, 6, 8]);
    assert.deepEqual(resolveSummaryGroup(8, chatState), [2, 6, 8]);
  });
});

test('the walk back does not cross the previous memory block into an older group', async () => {
  const prevLead = assistant(0, '前组lead\n<memory>前</memory>');
  const member = assistant(2, '成员');
  const lead = assistant(4, 'lead\n<memory>合并</memory>');
  const chat = [prevLead, { message_id: 1, role: 'user', message: 'U' }, member, { message_id: 3, role: 'user', message: 'U' }, lead];
  const summary = {
    confirmedTasks: [summarizedTask(prevLead), summarizedTask(member), summarizedTask(lead)],
  };
  await withChat(chat, summary, chatState => {
    assert.deepEqual(resolveSummaryGroup(4, chatState), [2, 4]);
    assert.deepEqual(resolveSummaryGroup(2, chatState), [2, 4]);
    assert.deepEqual(resolveSummaryGroup(0, chatState), [0]);
  });
});

test('an unmerged floor resolves to a single floor', async () => {
  const solo = assistant(2, '普通楼层');
  await withChat([solo], { confirmedTasks: [] }, chatState => {
    assert.deepEqual(resolveSummaryGroup(2, chatState), [2]);
  });
});

test('archived member floors whose tasks were cleaned up fall back to a single floor', async () => {
  const member = assistant(2, '旧成员');
  const lead = assistant(4, 'lead\n<memory>合并</memory>');
  const chat = [member, { message_id: 3, role: 'user', message: 'U' }, lead];
  // Tasks were pruned by archive cleanup: nothing confirms floor 2 as a member.
  await withChat(chat, { confirmedTasks: [summarizedTask(lead)] }, chatState => {
    assert.deepEqual(resolveSummaryGroup(2, chatState), [2]);
    assert.deepEqual(resolveSummaryGroup(4, chatState), [4]);
  });
});
