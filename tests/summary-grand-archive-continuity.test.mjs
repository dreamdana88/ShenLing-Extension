import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSafeArchiveTo,
  configureSummaryWorkflow,
  createScannedSummaryState,
  processAutoGrandMemory,
  recoverDeferredAutoGrandMemory,
} from '../src/features/summary/workflow.js';
import { getAssistantMessageContentFingerprint } from '../src/core/message-fingerprint.js';
import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';

function assistant(message_id, message, extra = {}) {
  return { message_id, role: 'assistant', swipe_id: 0, message, ...extra };
}

function createContext(chatId, chat, summary) {
  return {
    chatId,
    chat,
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        modules: {
          summary: {
            enabled: true,
            autoGrandMemoryEnabled: true,
            grandMemoryInterval: 1,
          },
        },
      },
    },
    chatMetadata: { [CHAT_STATE_KEY]: { summary } },
    saveMetadataDebounced: () => {},
  };
}

async function withGrandHarness(run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    window: globalThis.window,
    generateRaw: globalThis.generateRaw,
    createChatMessages: globalThis.createChatMessages,
    setChatMessages: globalThis.setChatMessages,
  };
  const first = assistant(0, 'A 已总结\n<memory>[n:1] A</memory>');
  const second = assistant(2, 'B 候选');
  const stateA = {
    runningTask: 'none',
    memoryCountSinceArchive: 1,
    memoryCountedMessageIds: [0],
    processedMessageFingerprints: { 0: getAssistantMessageContentFingerprint(first) },
    archiveRecords: [],
  };
  const contextA = createContext('chat-a', [first, { message_id: 1, role: 'user', message: 'U1' }, second], stateA);
  const contextB = createContext('chat-b', [assistant(0, 'B 聊天原消息')], {
    runningTask: 'none', memoryCountSinceArchive: 0, memoryCountedMessageIds: [], processedMessageFingerprints: {}, archiveRecords: [],
  });
  let current = contextA;
  configureSummaryWorkflow({ addCommunicationLog: () => {}, getApiSettings: () => ({ mode: 'main_api' }), refreshSummaryPanel: () => {} });
  globalThis.SillyTavern = { getContext: () => current };
  globalThis.window = globalThis;
  globalThis.createChatMessages = async messages => {
    const next = messages[0];
    current.chat.push(assistant(current.chat.length, next.message));
  };
  globalThis.setChatMessages = async updates => {
    updates.forEach(update => Object.assign(current.chat[Number(update.message_id)], update));
  };
  try {
    await run({ contextA, contextB, setCurrent: context => { current = context; }, getCurrent: () => current });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('automatic Grand continues from archiveTo, preserving the user and candidate until their later safe archive', async () => {
  await withGrandHarness(async ({ contextA }) => {
    globalThis.generateRaw = async () => '<grand_memory>\n[volume: 1-1]\n第一次\n</grand_memory>';
    await processAutoGrandMemory();
    const firstRecord = contextA.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords[0];
    assert.deepEqual([firstRecord.archiveFrom, firstRecord.archiveTo, firstRecord.summaryMessageId], [0, 0, 3]);
    assert.equal(contextA.chat[0].is_hidden, true);
    assert.equal(contextA.chat[1].is_hidden, undefined);
    assert.equal(contextA.chat[2].is_hidden, undefined);

    contextA.chat[2].message = 'B 已总结\n<memory>[n:2] B</memory>';
    const summary = contextA.chatMetadata[CHAT_STATE_KEY].summary;
    summary.memoryCountSinceArchive = 1;
    summary.memoryCountedMessageIds = [2];
    summary.processedMessageFingerprints[2] = getAssistantMessageContentFingerprint(contextA.chat[2]);
    globalThis.generateRaw = async () => '<grand_memory>\n[volume: 2-2]\n第二次\n</grand_memory>';
    await processAutoGrandMemory();

    const secondRecord = contextA.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords.at(-1);
    assert.deepEqual([secondRecord.archiveFrom, secondRecord.archiveTo], [1, 2]);
    assert.equal(contextA.chat[1].is_hidden, true);
    assert.equal(contextA.chat[2].is_hidden, true);
  });
});

test('scan retains unarchived summarized floors located before a later Grand message', () => {
  const archived = assistant(0, 'A\n<memory>[n:1] A</memory>', { is_hidden: true });
  const laterSummary = assistant(2, 'B\n<memory>[n:2] B</memory>');
  const grand = assistant(3, '<grand_memory>\n[volume: 1-1]\nGrand\n</grand_memory>');
  const scanned = createScannedSummaryState({
    lastArchivedMessageId: 0,
    archiveRecords: [{ id: 'first', summaryMessageId: 3, archiveFrom: 0, archiveTo: 0 }],
  }, { messages: [archived, { message_id: 1, role: 'user', message: 'U1' }, laterSummary, grand] });
  assert.deepEqual(scanned.memoryCountedMessageIds, [2]);
  assert.equal(scanned.memoryCountSinceArchive, 1);
});

test('a failed gap stops the safe boundary while later unarchived summaries remain countable', () => {
  const first = assistant(0, 'A\n<memory>A</memory>');
  const later = assistant(4, 'C\n<memory>C</memory>');
  const state = {
    summary: {
      lastArchivedMessageId: -1,
      archiveRecords: [],
      processedMessageFingerprints: {},
      confirmedTasks: [
        { taskKey: 'a', chatIdentity: 'chat-a', originalMessageId: 0, assistantFingerprint: getAssistantMessageContentFingerprint(first), selectedSwipeId: 0, confirmingUserMessageId: 1, confirmingUserFingerprint: '1:1', status: 'SUMMARIZED', createdAt: 'a', updatedAt: 'a' },
        { taskKey: 'b', chatIdentity: 'chat-a', originalMessageId: 2, assistantFingerprint: '1:2', selectedSwipeId: 0, confirmingUserMessageId: 3, confirmingUserFingerprint: '1:3', status: 'FAILED', createdAt: 'b', updatedAt: 'b' },
      ],
    },
  };
  assert.equal(calculateSafeArchiveTo([first, { message_id: 1, role: 'user', message: 'U1' }, assistant(2, '失败候选'), { message_id: 3, role: 'user', message: 'U2' }, later], state), 0);
  const scanned = createScannedSummaryState({ lastArchivedMessageId: 0, archiveRecords: [] }, {
    messages: [archivedMessage(0), { message_id: 1, role: 'user', message: 'U1' }, assistant(2, '失败候选'), { message_id: 3, role: 'user', message: 'U2' }, later],
  });
  assert.deepEqual(scanned.memoryCountedMessageIds, [4]);
});

function archivedMessage(message_id) {
  return assistant(message_id, 'A\n<memory>A</memory>', { is_hidden: true });
}

test('an automatic Grand result returned after switching to B neither creates nor hides in B, and A recovers on return', async () => {
  await withGrandHarness(async ({ contextA, contextB, setCurrent }) => {
    let resolveGeneration;
    globalThis.generateRaw = async () => new Promise(resolve => { resolveGeneration = resolve; });
    const run = processAutoGrandMemory();
    await Promise.resolve();
    assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'grand_memory');
    setCurrent(contextB);
    resolveGeneration('<grand_memory>\n[volume: 1-1]\n晚到\n</grand_memory>');
    await run;
    assert.equal(contextB.chat.length, 1);
    assert.deepEqual(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords, []);
    setCurrent(contextA);
    assert.equal(recoverDeferredAutoGrandMemory(), true);
    assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
  });
});
