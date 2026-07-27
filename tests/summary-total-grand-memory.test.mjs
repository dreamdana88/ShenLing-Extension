import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureSummaryWorkflow,
  createScannedSummaryState,
  createTotalGrandMemoryPlan,
  processTotalGrandMemory,
  shouldTriggerAutoTotalGrandMemory,
} from '../src/features/summary/workflow.js';
import { renderSummarySettingsPanel } from '../src/features/summary/panel.js';
import { CHAT_STATE_KEY } from '../src/constants.js';

function grandMessage(messageId) {
  return {
    message_id: messageId,
    role: 'assistant',
    message: `<grand_memory>\n[volume: ${messageId}-${messageId}]\n总结 ${messageId}\n</grand_memory>`,
  };
}

function archiveRecord(summaryMessageId, extra = {}) {
  return {
    id: `${summaryMessageId}-record`,
    summaryMessageId,
    archiveFrom: summaryMessageId - 1,
    archiveTo: summaryMessageId - 1,
    memoryFrom: summaryMessageId - 1,
    memoryTo: summaryMessageId - 1,
    rangeType: 'memory',
    ...extra,
  };
}

function createPlan(records, missingMessageIds = []) {
  const missing = new Set(missingMessageIds);
  const messages = new Map(records.map(record => [
    Number(record.summaryMessageId),
    missing.has(Number(record.summaryMessageId)) ? null : grandMessage(Number(record.summaryMessageId)),
  ]));
  return createTotalGrandMemoryPlan({
    summary: { archiveRecords: records },
  }, {
    getMessageById: messageId => messages.get(Number(messageId)) || null,
  });
}

function createLifecycleHarness({ failureAt = '' } = {}) {
  const archiveRecords = Array.from({ length: 9 }, (_, messageId) => archiveRecord(messageId, {
    archiveFrom: messageId,
    archiveTo: messageId,
    memoryFrom: messageId,
    memoryTo: messageId,
  }));
  const context = {
    chat: archiveRecords.map(record => grandMessage(record.summaryMessageId)),
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        summary: {
          runningTask: 'none',
          archiveRecords,
        },
      },
    },
    saveMetadataDebounced: () => {},
  };
  const replaceMetadata = () => {
    context.chatMetadata = structuredClone(context.chatMetadata);
  };
  context.createChatMessages = async messages => {
    replaceMetadata();
    if (failureAt === 'create') throw new Error('创建总档案失败');
    const message = messages[0];
    context.chat.push({
      message_id: context.chat.length,
      role: message.role,
      message: message.message,
    });
  };
  context.setChatMessages = async updates => {
    updates.forEach(update => Object.assign(context.chat[Number(update.message_id)], update));
    replaceMetadata();
    if (failureAt === 'hide') throw new Error('隐藏旧楼失败');
  };
  return context;
}

async function runTotalGrandMemoryLifecycle(context, { failureAt = '' } = {}) {
  const previousSillyTavern = globalThis.SillyTavern;
  const previousWindow = globalThis.window;
  const previousCreateChatMessages = globalThis.createChatMessages;
  const previousSetChatMessages = globalThis.setChatMessages;
  configureSummaryWorkflow({
    addCommunicationLog: () => {},
    getApiSettings: () => ({ mode: 'main_api' }),
    getGenerateRawFunction: () => async () => {
      if (failureAt === 'model') throw new Error('模型生成失败');
      return '<grand_memory>\n[volume: 0-8]\n合并结果\n</grand_memory>';
    },
    refreshSummaryPanel: () => {},
  });
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  globalThis.createChatMessages = context.createChatMessages;
  globalThis.setChatMessages = context.setChatMessages;
  try {
    await processTotalGrandMemory();
    return context.chatMetadata[CHAT_STATE_KEY];
  } finally {
    globalThis.SillyTavern = previousSillyTavern;
    globalThis.window = previousWindow;
    if (previousCreateChatMessages === undefined) delete globalThis.createChatMessages;
    else globalThis.createChatMessages = previousCreateChatMessages;
    if (previousSetChatMessages === undefined) delete globalThis.setChatMessages;
    else globalThis.setChatMessages = previousSetChatMessages;
  }
}

test('threshold only counts fresh ordinary grand memories across three merge rounds', () => {
  const firstRound = [archiveRecord(10), archiveRecord(20), archiveRecord(30)];
  assert.equal(createPlan(firstRound.slice(0, 1)).freshCount, 1);
  assert.equal(createPlan(firstRound.slice(0, 2)).freshCount, 2);
  assert.equal(createPlan(firstRound).freshCount, 3);

  const afterFirstMerge = [
    ...firstRound.map(record => ({ ...record, compressedBy: 100 })),
    archiveRecord(100, { rangeType: 'total_grand', compressedRecordIds: [10, 20, 30] }),
  ];
  const afterFirstPlan = createPlan(afterFirstMerge);
  assert.equal(afterFirstPlan.freshCount, 0);
  assert.deepEqual(afterFirstPlan.records.map(item => item.record.summaryMessageId), [100]);

  const secondRound = [...afterFirstMerge, archiveRecord(110), archiveRecord(120), archiveRecord(130)];
  assert.equal(createPlan(secondRound.slice(0, -2)).freshCount, 1);
  assert.equal(createPlan(secondRound.slice(0, -1)).freshCount, 2);
  const secondPlan = createPlan(secondRound);
  assert.equal(secondPlan.freshCount, 3);
  assert.deepEqual(secondPlan.records.map(item => item.record.summaryMessageId), [100, 110, 120, 130]);

  const afterSecondMerge = [
    ...secondRound.map(record => ({ ...record, compressedBy: 200 })),
    archiveRecord(200, { rangeType: 'total_grand', compressedRecordIds: [100, 110, 120, 130] }),
  ];
  const thirdRound = [...afterSecondMerge, archiveRecord(210), archiveRecord(220), archiveRecord(230)];
  const thirdPlan = createPlan(thirdRound);
  assert.equal(thirdPlan.freshCount, 3);
  assert.deepEqual(thirdPlan.records.map(item => item.record.summaryMessageId), [200, 210, 220, 230]);
});

test('consumed, duplicate, and invalid records do not advance the next threshold', () => {
  const records = [
    archiveRecord(10),
    archiveRecord(20, { compressedBy: 100 }),
    archiveRecord(30),
    archiveRecord(30),
    archiveRecord(100, { rangeType: 'total_grand', compressedRecordIds: [10] }),
    archiveRecord(110),
    archiveRecord(120),
  ];
  const plan = createPlan(records, [120]);
  assert.equal(plan.freshCount, 2);
  assert.deepEqual(plan.freshRecords.map(item => item.record.summaryMessageId), [30, 110]);
  assert.deepEqual(plan.records.map(item => item.record.summaryMessageId), [30, 100, 110]);
});

test('automatic trigger uses freshCount instead of total merge material count', () => {
  const baseline = archiveRecord(0, { rangeType: 'total_grand', compressedRecordIds: [0] });
  const beforeThreshold = [baseline, archiveRecord(1), archiveRecord(2)];
  const atThreshold = [...beforeThreshold, archiveRecord(3)];
  const previousSillyTavern = globalThis.SillyTavern;
  const settings = {
    enabled: true,
    modules: {
      summary: {
        autoTotalGrandMemoryEnabled: true,
        totalGrandMemoryInterval: 3,
      },
    },
  };

  try {
    globalThis.SillyTavern = {
      getContext: () => ({ chat: atThreshold.map(record => grandMessage(record.summaryMessageId)) }),
    };
    assert.equal(shouldTriggerAutoTotalGrandMemory({
      summary: { runningTask: 'none', archiveRecords: beforeThreshold },
    }, settings), false);
    assert.equal(shouldTriggerAutoTotalGrandMemory({
      summary: { runningTask: 'none', archiveRecords: atThreshold },
    }, settings), true);
  } finally {
    globalThis.SillyTavern = previousSillyTavern;
  }
});

test('chat-state scanning preserves total-grand consumption metadata for later retries', () => {
  const baseSummary = {
    archiveRecords: [
      archiveRecord(10),
      archiveRecord(20),
      archiveRecord(30),
      archiveRecord(100, { rangeType: 'total_grand', compressedRecordIds: [10, 20, 30] }),
    ],
  };
  const messages = baseSummary.archiveRecords.map(record => grandMessage(record.summaryMessageId));
  const scanned = createScannedSummaryState(baseSummary, { messages });
  const restoredTotal = scanned.archiveRecords.find(record => record.summaryMessageId === 100);
  assert.deepEqual(restoredTotal.compressedRecordIds, [10, 20, 30]);

  const plan = createPlan(scanned.archiveRecords);
  assert.equal(plan.freshCount, 0);
  assert.equal(plan.baselineRecord.summaryMessageId, 100);
});

test('planning has no side effects before a merge succeeds', () => {
  const chatState = {
    summary: {
      archiveRecords: [archiveRecord(10), archiveRecord(20), archiveRecord(30)],
    },
  };
  const before = structuredClone(chatState);
  createPlan(chatState.summary.archiveRecords);
  assert.deepEqual(chatState, before);
});

test('manual merge persists to the replacement chat state and renders separate counts', async () => {
  const context = createLifecycleHarness();
  const stateA = context.chatMetadata[CHAT_STATE_KEY];
  const finalState = await runTotalGrandMemoryLifecycle(context);
  const records = finalState.summary.archiveRecords;
  const totalRecord = records.find(record => record.rangeType === 'total_grand');

  assert.notStrictEqual(finalState, stateA);
  assert.equal(records.length, 10);
  assert.equal(records.filter(record => record.compressedBy === 9).length, 9);
  assert.deepEqual(totalRecord.compressedRecordIds, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(finalState.summary.runningTask, 'none');
  assert.equal(finalState.summary.lastGrandSummaryMessageId, 9);
  assert.equal(createPlan(records).freshCount, 0);
  assert.equal(createPlan(records).count, 1);
  const reloaded = createScannedSummaryState(structuredClone(finalState.summary), { messages: context.chat });
  const reloadedTotal = reloaded.archiveRecords.find(record => record.rangeType === 'total_grand');
  assert.equal(reloaded.archiveRecords.filter(record => record.compressedBy === 9).length, 9);
  assert.deepEqual(reloadedTotal.compressedRecordIds, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(createPlan(reloaded.archiveRecords).freshCount, 0);

  const previousSillyTavern = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => context };
  let html = '';
  try {
    html = renderSummarySettingsPanel({ modules: { summary: { totalGrandMemoryInterval: 3 } } }, finalState);
  } finally {
    globalThis.SillyTavern = previousSillyTavern;
  }
  assert.match(html, /大总结合并[\s\S]*?0 \/ 3/);
  assert.match(html, /活动 1 条｜已合并旧记录 9 条/);
  assert.match(html, /可合并材料：1 条｜本轮新增大总结：0 条｜已合并旧记录 9 条/);
});

test('manual merge button remains based on material count, not fresh threshold progress', () => {
  const records = [
    archiveRecord(100, { rangeType: 'total_grand', compressedRecordIds: [10, 20, 30] }),
    archiveRecord(110),
  ];
  const state = { summary: { runningTask: 'none', archiveRecords: records } };
  const context = { chat: records.map(record => grandMessage(record.summaryMessageId)) };
  const previousSillyTavern = globalThis.SillyTavern;
  const previousGetChatMessages = globalThis.getChatMessages;
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.getChatMessages = range => {
    if (range === undefined) return context.chat;
    return context.chat.filter(message => Number(message.message_id) === Number(range));
  };
  try {
    const html = renderSummarySettingsPanel({ modules: { summary: { totalGrandMemoryInterval: 3 } } }, state);
    assert.equal(createTotalGrandMemoryPlan(state).count, 2);
    assert.equal(createTotalGrandMemoryPlan(state).freshCount, 1);
    assert.match(html, /data-slx-compress-grand-memories >/);
    assert.match(html, /大总结合并[\s\S]*?1 \/ 3/);
  } finally {
    globalThis.SillyTavern = previousSillyTavern;
    if (previousGetChatMessages === undefined) delete globalThis.getChatMessages;
    else globalThis.getChatMessages = previousGetChatMessages;
  }
});

test('failure paths clear the current replacement state without consuming records', async () => {
  for (const failureAt of ['model', 'create', 'hide']) {
    const context = createLifecycleHarness({ failureAt });
    const finalState = await runTotalGrandMemoryLifecycle(context, { failureAt });
    assert.equal(finalState.summary.runningTask, 'none', failureAt);
    assert.equal(finalState.summary.archiveRecords.length, 9, failureAt);
    assert.equal(finalState.summary.archiveRecords.some(record => record.compressedBy), false, failureAt);
    assert.match(finalState.summary.lastError, /失败/, failureAt);
  }
});
