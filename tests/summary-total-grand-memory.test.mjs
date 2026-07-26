import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScannedSummaryState,
  createTotalGrandMemoryPlan,
  shouldTriggerAutoTotalGrandMemory,
} from '../src/features/summary/workflow.js';

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
  const baseline = archiveRecord(100, { rangeType: 'total_grand', compressedRecordIds: [10, 20, 30] });
  const beforeThreshold = [baseline, archiveRecord(110), archiveRecord(120)];
  const atThreshold = [...beforeThreshold, archiveRecord(130)];
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
