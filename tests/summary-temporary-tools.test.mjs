import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_STATE_KEY } from '../src/constants.js';
import { getChatState } from '../src/core/settings.js';
import {
  TEMP_SUMMARY_TOOLS_KEY,
  createTemporaryGrandFixtures,
  repairTemporaryGrandRelationship,
} from '../src/features/summary/temporary-tools.js';
import { createTotalGrandMemoryPlan } from '../src/features/summary/workflow.js';

function grandMessage(messageId) {
  return { message_id: messageId, role: 'assistant', message: `<grand_memory>\n[volume:${messageId}-${messageId}]\n记录 ${messageId}\n</grand_memory>` };
}

function record(messageId, extra = {}) {
  return { id: `${messageId}-record`, summaryMessageId: messageId, archiveFrom: messageId - 1, archiveTo: messageId - 1, memoryFrom: messageId - 1, memoryTo: messageId - 1, rangeType: 'memory', ...extra };
}

async function withContext(context, fn) {
  const previousSt = globalThis.SillyTavern;
  const previousStorage = globalThis.localStorage;
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.localStorage = { getItem: key => key === TEMP_SUMMARY_TOOLS_KEY ? 'enabled' : null };
  try { return await fn(); } finally { globalThis.SillyTavern = previousSt; globalThis.localStorage = previousStorage; }
}

function createContext({ records = [], auto = false } = {}) {
  const context = {
    chat: [],
    chatId: 'temporary-test-chat',
    chatMetadata: { name: 'temporary-test-chat', [CHAT_STATE_KEY]: { summary: { runningTask: 'none', archiveRecords: records } } },
    extensionSettings: { shenling_assistant: { modules: { summary: { autoTotalGrandMemoryEnabled: auto } } } },
    saveMetadataDebounced: () => {},
  };
  context.createChatMessages = async messages => {
    messages.forEach(message => context.chat.push({ message_id: context.chat.length, role: message.role, message: message.message }));
  };
  return context;
}

test('temporary fixture creates three scan-recognized grand memories without AI', async () => {
  const context = createContext();
  await withContext(context, async () => {
    const result = await createTemporaryGrandFixtures({ confirmed: true });
    const state = getChatState();
    assert.equal(result.createdGrandIds.length, 3);
    assert.equal(context.chat.filter(message => /蜃灵临时测试数据/.test(message.message)).length, 6);
    assert.equal(state.summary.archiveRecords.length, 3);
    assert.equal(createTotalGrandMemoryPlan(state).freshCount, 3);
    assert.equal(createTotalGrandMemoryPlan(state).count, 3);
    assert.equal(state.summary.archiveRecords.every(item => !item.compressedBy && item.rangeType !== 'total_grand'), true);
  });
});

test('fixture rejects auto merge, existing grand memories, and chat switches', async () => {
  await withContext(createContext({ auto: true }), async () => {
    await assert.rejects(() => createTemporaryGrandFixtures({ confirmed: true }), /关闭自动大总结合并/);
  });
  const existing = createContext();
  existing.chat.push(grandMessage(0));
  await withContext(existing, async () => {
    await assert.rejects(() => createTemporaryGrandFixtures({ confirmed: true }), /已有大总结/);
  });
  const switched = createContext();
  switched.createChatMessages = async messages => {
    switched.chat.push({ message_id: switched.chat.length, role: messages[0].role, message: messages[0].message });
    switched.chatId = 'other-chat';
    switched.chatMetadata.name = 'other-chat';
  };
  await withContext(switched, async () => {
    await assert.rejects(() => createTemporaryGrandFixtures({ confirmed: true }), /切换聊天/);
  });
});

test('manual historical repair is explicit, idempotent, and preserves messages', async () => {
  const sourceIds = [1, 3, 5, 7, 9, 11, 13, 15, 17];
  const sources = sourceIds.map(record);
  const target = record(19);
  const context = createContext({ records: [...sources, target] });
  context.chat = [...sourceIds, 19].map(grandMessage);
  const beforeMessages = structuredClone(context.chat);
  await withContext(context, async () => {
    const signature = `${getChatState().identity.characterId}::${getChatState().identity.chatId}`;
    const result = repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 19, sourceIds, confirmation: '修复第19楼' });
    assert.equal(result.changed, true);
    const state = getChatState();
    assert.equal(state.summary.archiveRecords.filter(item => item.compressedBy === 19).length, 9);
    assert.deepEqual(state.summary.archiveRecords.find(item => item.summaryMessageId === 19).compressedRecordIds, sourceIds);
    assert.equal(createTotalGrandMemoryPlan(state).freshCount, 0);
    assert.equal(repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 19, sourceIds, confirmation: '修复第19楼' }).changed, false);
    assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 19, sourceIds: [19, 1], confirmation: '修复第19楼' }), /无效/);
  });
  assert.deepEqual(context.chat, beforeMessages);
});

test('historical repair rejects conflicting source and target relations', async () => {
  const context = createContext({ records: [record(1), record(3), record(9, { compressedRecordIds: [1] })] });
  context.chat = [grandMessage(1), grandMessage(3), grandMessage(9)];
  await withContext(context, async () => {
    const signature = `::temporary-test-chat`;
    assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 9, sourceIds: [1, 3], confirmation: '修复第9楼' }), /冲突/);
  });
});
