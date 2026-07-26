import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_STATE_KEY } from '../src/constants.js';
import { getChatState } from '../src/core/settings.js';
import {
  createTemporaryGrandFixtures,
  repairTemporaryGrandRelationship,
  renderTemporarySummaryTools,
} from '../src/features/summary/temporary-tools.js';
import { createTotalGrandMemoryPlan, scanExistingSummaryState } from '../src/features/summary/workflow.js';

function grandMessage(messageId) {
  return { message_id: messageId, role: 'assistant', message: `<grand_memory>\n[volume:${messageId}-${messageId}]\n记录 ${messageId}\n</grand_memory>` };
}

function record(messageId, extra = {}) {
  return { id: `${messageId}-record`, summaryMessageId: messageId, archiveFrom: messageId - 1, archiveTo: messageId - 1, memoryFrom: messageId - 1, memoryTo: messageId - 1, rangeType: 'memory', ...extra };
}

async function withContext(context, fn) {
  const previousSt = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => context };
  try { return await fn(); } finally { globalThis.SillyTavern = previousSt; }
}

function createContext({ records = [], auto = false, postprocess = false } = {}) {
  const context = {
    chat: [],
    chatId: 'temporary-test-chat',
    chatMetadata: { name: 'temporary-test-chat', [CHAT_STATE_KEY]: { summary: { runningTask: 'none', archiveRecords: records } } },
    extensionSettings: { shenling_assistant: { enabled: postprocess, modules: { summary: { enabled: postprocess, autoTotalGrandMemoryEnabled: auto }, wordReplace: { enabled: postprocess } } } },
    saveMetadataDebounced: () => {},
  };
  context.createChatMessages = async messages => {
    messages.forEach(message => context.chat.push({ message_id: context.chat.length, role: message.role, message: message.message }));
  };
  return context;
}

test('temporary tools render without a localStorage activation gate', async () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  try {
    await withContext(createContext(), async () => {
      const html = renderTemporarySummaryTools();
      assert.match(html, /临时大总结诊断工具/);
      assert.match(html, /仅供本次实机测试与历史修复，完成后删除/);
    });
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

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
  const postprocess = createContext({ postprocess: true });
  await withContext(postprocess, async () => {
    await assert.rejects(() => createTemporaryGrandFixtures({ confirmed: true }), /自动小总结与词汇替换后处理/);
    assert.equal(postprocess.chat.length, 0);
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
  const untouched = record(21, { customField: 'must-stay', compressedBy: 77 });
  const context = createContext({ records: [...sources, target, untouched] });
  context.chat = [...sourceIds, 19, 21].map(grandMessage);
  const beforeMessages = structuredClone(context.chat);
  await withContext(context, async () => {
    const signature = `${getChatState().identity.characterId}::${getChatState().identity.chatId}`;
    const result = repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 19, sourceIds, confirmation: '修复第19楼' });
    assert.equal(result.changed, true);
    const state = getChatState();
    assert.equal(state.summary.archiveRecords.filter(item => item.compressedBy === 19).length, 9);
    assert.deepEqual(state.summary.archiveRecords.find(item => item.summaryMessageId === 19).compressedRecordIds, sourceIds);
    assert.equal(createTotalGrandMemoryPlan(state).freshCount, 0);
    assert.deepEqual(state.summary.archiveRecords.find(item => item.summaryMessageId === 21), untouched);
    context.chatMetadata = structuredClone(context.chatMetadata);
    scanExistingSummaryState();
    const reloaded = getChatState();
    assert.deepEqual(reloaded.summary.archiveRecords.find(item => item.summaryMessageId === 19).compressedRecordIds, sourceIds);
    assert.equal(createTotalGrandMemoryPlan(reloaded).freshCount, 0);
    assert.equal(createTotalGrandMemoryPlan(reloaded).count, 1);
    const html = renderTemporarySummaryTools(reloaded);
    assert.match(html, /目标/);
    assert.match(html, /来源/);
    assert.match(html, /compressedRecordIds 1、3、5、7、9、11、13、15、17/);
    assert.equal(repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 19, sourceIds, confirmation: '修复第19楼' }).changed, false);
    assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 19, sourceIds: [19, 1], confirmation: '修复第19楼' }), /无效/);
  });
  assert.deepEqual(context.chat, beforeMessages);
});

test('manual historical repair normalizes DOM string IDs before restoring scanned records', async () => {
  const numericSourceIds = [1, 3, 5, 7, 9, 11, 13, 15, 17];
  const sourceIds = numericSourceIds.map(String);
  const context = createContext({ records: [...numericSourceIds.map(record), record(19)] });
  context.chat = [...numericSourceIds, 19].map(grandMessage);
  await withContext(context, async () => {
    const chatSignature = `${getChatState().identity.characterId}::${getChatState().identity.chatId}`;
    const result = repairTemporaryGrandRelationship({
      chatSignature,
      targetId: '19',
      sourceIds,
      confirmation: '修复第19楼',
    });
    assert.equal(result.changed, true);
    const repaired = getChatState();
    assert.equal(
      numericSourceIds.every(id => repaired.summary.archiveRecords.find(item => item.summaryMessageId === id)?.compressedBy === 19),
      true,
    );
    const target = repaired.summary.archiveRecords.find(item => item.summaryMessageId === 19);
    assert.equal(target.rangeType, 'total_grand');
    assert.deepEqual(target.compressedRecordIds, numericSourceIds);
    assert.equal(createTotalGrandMemoryPlan(repaired).freshCount, 0);
    assert.equal(createTotalGrandMemoryPlan(repaired).count, 1);

    context.chatMetadata = structuredClone(context.chatMetadata);
    scanExistingSummaryState();
    const reloaded = getChatState();
    assert.equal(
      numericSourceIds.every(id => reloaded.summary.archiveRecords.find(item => item.summaryMessageId === id)?.compressedBy === 19),
      true,
    );
    assert.deepEqual(reloaded.summary.archiveRecords.find(item => item.summaryMessageId === 19).compressedRecordIds, numericSourceIds);
    assert.equal(createTotalGrandMemoryPlan(reloaded).freshCount, 0);
    assert.equal(createTotalGrandMemoryPlan(reloaded).count, 1);
  });
});

test('historical repair rejects conflicting source and target relations', async () => {
  const context = createContext({ records: [record(1), record(3), record(9, { compressedRecordIds: [1, 5] })] });
  context.chat = [grandMessage(1), grandMessage(3), grandMessage(9)];
  await withContext(context, async () => {
    const signature = `::temporary-test-chat`;
    assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 9, sourceIds: [1, 3], confirmation: '修复第9楼' }), /冲突/);
    const sourceConflict = createContext({ records: [record(1, { compressedBy: 99 }), record(3), record(9)] });
    sourceConflict.chat = [grandMessage(1), grandMessage(3), grandMessage(9)];
    await withContext(sourceConflict, async () => {
      assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 9, sourceIds: [1, 3], confirmation: '修复第9楼' }), /已被其他总档案/);
    });
    const rangeConflict = createContext({ records: [record(1), record(3), record(9, { rangeType: 'floor' })] });
    rangeConflict.chat = [grandMessage(1), grandMessage(3), grandMessage(9)];
    await withContext(rangeConflict, async () => {
      assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 9, sourceIds: [1, 3], confirmation: '修复第9楼' }), /冲突/);
    });
    assert.throws(() => repairTemporaryGrandRelationship({ chatSignature: signature, targetId: 9, sourceIds: [1], confirmation: '修复第9楼' }), /无效/);
  });
});

test('repair restores archiveRecords when the first metadata save fails', async () => {
  const context = createContext({ records: [record(1), record(3), record(9)] });
  context.chat = [grandMessage(1), grandMessage(3), grandMessage(9)];
  let saveAttempts = 0;
  context.saveMetadataDebounced = () => {
    saveAttempts += 1;
    if (saveAttempts === 1) throw new Error('首次保存失败');
  };
  await withContext(context, async () => {
    const before = structuredClone(getChatState().summary.archiveRecords);
    assert.throws(() => repairTemporaryGrandRelationship({
      chatSignature: '::temporary-test-chat', targetId: 9, sourceIds: [1, 3], confirmation: '修复第9楼',
    }), /首次保存失败/);
    assert.ok(saveAttempts >= 2);
    const restored = getChatState().summary.archiveRecords;
    assert.deepEqual(restored, before);
  });
});
