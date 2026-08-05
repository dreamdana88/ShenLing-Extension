import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  markChatScopeChanged,
  resetChatScopeEpochForTests,
} from '../src/core/chat-scope.js';
import {
  processLegacyGrandArchive,
  processTotalGrandMemory,
} from '../src/features/summary/archive.js';
import { SUMMARY_TRANSPORT_POLICY } from '../src/features/summary/generation.js';
import {
  regenerateLatestGrandMemory,
  regenerateMemoryForMessage,
  summarizeOpeningMessage,
} from '../src/features/summary/manual.js';
import { configureSummaryWorkflow } from '../src/features/summary/runtime.js';

const SECRET = 'sk-manual-scope-secret';
const profile = {
  name: 'Manual Scope',
  baseUrl: 'https://scope.example',
  endpointPath: '/v1/chat/completions',
  apiKey: SECRET,
  model: 'scope-model',
};

function assistant(messageId, message, extra = {}) {
  return {
    message_id: messageId,
    role: 'assistant',
    is_user: false,
    is_hidden: false,
    swipe_id: 0,
    message,
    mes: message,
    ...extra,
  };
}

function createChatState(overrides = {}) {
  return {
    summary: {
      runningTask: 'none',
      archiveRecords: [],
      memoryCountSinceArchive: 0,
      memoryCountedMessageIds: [],
      processedMessageFingerprints: {},
      lastError: '',
      legacyArchiveStatus: null,
      ...overrides,
    },
  };
}

function createContext(chatId, characterId, chat, summaryOverrides = {}) {
  return {
    chatId,
    characterId,
    this_chid: characterId,
    name1: '用户',
    name2: '角色',
    chat: [...chat],
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        generation: { backgroundStreamingEnabled: false },
        api: {
          mode: 'main_api',
          activeProfileId: 'default',
          profiles: [{ ...profile, id: 'default' }],
        },
        modules: {
          summary: {
            enabled: true,
            legacyArchiveBatchSize: '1',
            includeUserInput: false,
            autoTotalGrandMemoryEnabled: false,
            autoGrandMemoryEnabled: false,
          },
        },
      },
    },
    chatMetadata: {
      [CHAT_STATE_KEY]: createChatState(summaryOverrides),
      name: chatId,
    },
    saveMetadataDebounced: () => {},
    saveSettingsDebounced: () => {},
    saveChat: async () => {},
  };
}

async function withManualScopeHarness({
  chatA = [assistant(0, 'A 楼正文：角色完成了关键行动。')],
  chatB = [assistant(0, 'B 楼正文：完全不同的内容。')],
  summaryA = {},
  summaryB = {},
  generateImpl,
} = {}, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    TavernHelper: globalThis.TavernHelper,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
    createChatMessages: globalThis.createChatMessages,
    setChatMessages: globalThis.setChatMessages,
    window: globalThis.window,
    performance: globalThis.performance,
  };

  resetChatScopeEpochForTests(0);
  const contextA = createContext('chat-a', 'char-1', chatA, summaryA);
  const contextB = createContext('chat-b', 'char-1', chatB, summaryB);
  let current = contextA;
  const logs = [];
  const hostCalls = { create: [], set: [], generate: 0 };
  let resolveGenerate;
  let rejectGenerate;
  const pendingGenerate = new Promise((resolve, reject) => {
    resolveGenerate = resolve;
    rejectGenerate = reject;
  });

  globalThis.SillyTavern = { getContext: () => current };
  globalThis.window = globalThis;
  if (!globalThis.performance?.now) globalThis.performance = { now: () => Date.now() };
  delete globalThis.TavernHelper;
  delete globalThis.fetch;

  globalThis.generateRaw = async request => {
    hostCalls.generate += 1;
    if (typeof generateImpl === 'function') {
      return generateImpl(request, hostCalls.generate);
    }
    return pendingGenerate;
  };

  globalThis.createChatMessages = async messages => {
    hostCalls.create.push({
      chatId: current.chatId,
      message: messages[0]?.message,
    });
    const next = messages[0];
    current.chat.push(assistant(current.chat.length, next.message));
  };

  globalThis.setChatMessages = async updates => {
    hostCalls.set.push({
      chatId: current.chatId,
      updates: updates.map(item => ({ ...item })),
    });
    for (const update of updates) {
      const target = current.chat[Number(update.message_id)];
      if (target) Object.assign(target, update);
    }
  };

  configureSummaryWorkflow({
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => profile,
    getApiSettings: () => ({ mode: 'main_api' }),
    refreshSummaryPanel: () => {},
  });

  const switchTo = context => {
    current = context;
    markChatScopeChanged();
  };

  try {
    return await run({
      contextA,
      contextB,
      hostCalls,
      logs,
      switchToA: () => switchTo(contextA),
      switchToB: () => switchTo(contextB),
      resolveGenerate,
      rejectGenerate,
      getCurrent: () => current,
      manualOptions: {
        transportPolicy: SUMMARY_TRANSPORT_POLICY.LEGACY,
        guardChatScope: true,
      },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    resetChatScopeEpochForTests(0);
  }
}

test('wiring: manual entries accept guardChatScope; auto total stays unguarded', async () => {
  const workflow = await readFile(new URL('../src/features/summary/workflow.js', import.meta.url), 'utf8');
  const archive = await readFile(new URL('../src/features/summary/archive.js', import.meta.url), 'utf8');
  const manual = await readFile(new URL('../src/features/summary/manual.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/features/summary/panel.js', import.meta.url), 'utf8');
  assert.match(manual, /guardChatScope\s*=\s*false/);
  assert.match(archive, /guardChatScope\s*=\s*false/);
  assert.match(workflow, /markChatScopeChanged\(\)/);
  assert.match(archive, /export async function processTotalGrandMemory\(\{[\s\S]*?guardChatScope\s*=\s*false/);
  assert.match(
    archive,
    /export async function processAutoTotalGrandMemory\([\s\S]*?processTotalGrandMemory\(\{\s*transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.CONFIGURED,\s*\}\)/,
  );
  assert.equal(archive.includes('processAutoTotalGrandMemory') && /processAutoTotalGrandMemory[\s\S]*?guardChatScope:\s*true/.test(archive), false);
  assert.match(panel, /guardChatScope:\s*true/);
});

test('opening summary A→B discards late result and never writes B', async () => {
  await withManualScopeHarness({}, async ({
    contextA,
    contextB,
    hostCalls,
    switchToB,
    resolveGenerate,
    manualOptions,
  }) => {
    const run = summarizeOpeningMessage(manualOptions);
    await Promise.resolve();
    assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'opening_memory');

    switchToB();
    resolveGenerate('<memory>[n:0]\n迟到 0 楼总结\n</memory>');
    await run;

    assert.equal(contextB.chat[0].message, 'B 楼正文：完全不同的内容。');
    assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.lastError, '');
    assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
    assert.equal(contextA.chat[0].message.includes('迟到 0 楼总结'), false);
    assert.equal(hostCalls.generate, 1);
  });
});

test('opening summary A→B→A still discards and allows a new task', async () => {
  await withManualScopeHarness({}, async ({
    contextA,
    hostCalls,
    switchToB,
    switchToA,
    resolveGenerate,
    manualOptions,
  }) => {
    const run = summarizeOpeningMessage(manualOptions);
    await Promise.resolve();
    switchToB();
    switchToA();
    // Returning to A clears stale runningTask the same way CHAT_CHANGED does in production.
    contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask = 'none';
    resolveGenerate('<memory>[n:0]\n旧任务迟到\n</memory>');
    await run;

    assert.equal(contextA.chat[0].message.includes('旧任务迟到'), false);
    assert.equal(hostCalls.generate, 1);

    // New task can start after stale clear.
    let secondDone = false;
    globalThis.generateRaw = async () => {
      hostCalls.generate += 1;
      secondDone = true;
      return '<memory>[n:0]\n新任务结果\n</memory>';
    };
    await summarizeOpeningMessage(manualOptions);
    assert.equal(secondDone, true);
    assert.match(contextA.chat[0].message, /新任务结果/);
    assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
  });
});

test('opening summary target change discards without generation failure toast semantics', async () => {
  await withManualScopeHarness({}, async ({
    contextA,
    hostCalls,
    resolveGenerate,
    manualOptions,
  }) => {
    const run = summarizeOpeningMessage(manualOptions);
    await Promise.resolve();
    contextA.chat[0].message = 'A 楼正文已被编辑。';
    contextA.chat[0].mes = contextA.chat[0].message;
    resolveGenerate('<memory>[n:0]\n应丢弃\n</memory>');
    await run;

    assert.equal(contextA.chat[0].message.includes('应丢弃'), false);
    assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
    assert.match(
      String(contextA.chatMetadata[CHAT_STATE_KEY].summary.lastError || ''),
      /目标内容在任务期间发生变化/,
    );
    assert.equal(hostCalls.generate, 1);
  });
});

test('rewrite memory A→B does not write B same messageId', async () => {
  await withManualScopeHarness({
    chatA: [assistant(1, 'A 可重写正文')],
    chatB: [assistant(1, 'B 同楼号不同正文')],
  }, async ({
    contextA,
    contextB,
    switchToB,
    resolveGenerate,
    manualOptions,
  }) => {
    // getEditableSummaryMessage needs valid id; message_id 1 in array index 0 is awkward.
    // Use message_id matching array index.
    contextA.chat = [assistant(0, 'pad'), assistant(1, 'A 可重写正文')];
    contextB.chat = [assistant(0, 'pad-b'), assistant(1, 'B 同楼号不同正文')];

    const run = regenerateMemoryForMessage(1, manualOptions);
    await Promise.resolve();
    switchToB();
    resolveGenerate('<memory>\n重写迟到\n</memory>');
    await run;

    assert.equal(contextB.chat[1].message, 'B 同楼号不同正文');
    assert.equal(contextA.chat[1].message.includes('重写迟到'), false);
  });
});

test('regenerate grand A→B does not mutate B record or floor', async () => {
  const grandA = '<grand_memory>\n[volume:0-0]\nA grand\n</grand_memory>';
  const grandB = '<grand_memory>\n[volume:0-0]\nB grand\n</grand_memory>';
  await withManualScopeHarness({
    chatA: [assistant(0, 'A body\n<memory>A</memory>', { is_hidden: true }), assistant(1, grandA)],
    chatB: [assistant(0, 'B body', { is_hidden: true }), assistant(1, grandB)],
    summaryA: {
      archiveRecords: [{
        id: 'rec-a',
        summaryMessageId: 1,
        archiveFrom: 0,
        archiveTo: 0,
        memoryFrom: 0,
        memoryTo: 0,
      }],
    },
    summaryB: {
      archiveRecords: [{
        id: 'rec-b',
        summaryMessageId: 1,
        archiveFrom: 0,
        archiveTo: 0,
        memoryFrom: 0,
        memoryTo: 0,
      }],
    },
  }, async ({
    contextA,
    contextB,
    switchToB,
    resolveGenerate,
    manualOptions,
  }) => {
    const run = regenerateLatestGrandMemory(manualOptions);
    await Promise.resolve();
    switchToB();
    resolveGenerate('<grand_memory>\n[volume:0-0]\n迟到 grand\n</grand_memory>');
    await run;

    assert.equal(contextB.chat[1].message, grandB);
    assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords[0].id, 'rec-b');
    assert.equal(contextA.chat[1].message.includes('迟到 grand'), false);
  });
});

test('legacy multi-batch archive stops after scope change with only one request', async () => {
  await withManualScopeHarness({
    chatA: [
      assistant(0, '旧正文 1'),
      assistant(1, '旧正文 2'),
      assistant(2, '旧正文 3'),
    ],
    chatB: [
      assistant(0, 'B1'),
      assistant(1, 'B2'),
      assistant(2, 'B3'),
    ],
  }, async ({
    contextA,
    contextB,
    hostCalls,
    switchToB,
    resolveGenerate,
    manualOptions,
  }) => {
    const run = processLegacyGrandArchive(manualOptions);
    await Promise.resolve();
    assert.equal(hostCalls.generate, 1);
    switchToB();
    resolveGenerate('批次 1 摘要');
    await run;

    assert.equal(hostCalls.generate, 1, 'no batch 2 / final after scope change');
    assert.equal(hostCalls.create.length, 0);
    assert.equal(hostCalls.set.length, 0);
    assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords.length, 0);
    assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords.length, 0);
    assert.equal(contextB.chat.every(item => !item.is_hidden), true);
  });
});

test('manual total grand create-then-switch does not hide or write archive on B', async () => {
  const g1 = '<grand_memory>\n[volume:0-0]\nG1\n</grand_memory>';
  const g2 = '<grand_memory>\n[volume:1-1]\nG2\n</grand_memory>';
  await withManualScopeHarness({
    chatA: [assistant(0, g1), assistant(1, g2)],
    chatB: [assistant(0, g1), assistant(1, g2)],
    summaryA: {
      archiveRecords: [
        { id: 'a1', summaryMessageId: 0, archiveFrom: 0, archiveTo: 0, memoryFrom: 0, memoryTo: 0 },
        { id: 'a2', summaryMessageId: 1, archiveFrom: 1, archiveTo: 1, memoryFrom: 1, memoryTo: 1 },
      ],
    },
    summaryB: {
      archiveRecords: [
        { id: 'b1', summaryMessageId: 0, archiveFrom: 0, archiveTo: 0, memoryFrom: 0, memoryTo: 0 },
        { id: 'b2', summaryMessageId: 1, archiveFrom: 1, archiveTo: 1, memoryFrom: 1, memoryTo: 1 },
      ],
    },
  }, async ({
    contextA,
    contextB,
    hostCalls,
    switchToB,
    resolveGenerate,
    manualOptions,
  }) => {
    // Controllable create: after create resolves, switch to B before hide/metadata.
    let createResolve;
    const createGate = new Promise(resolve => { createResolve = resolve; });
    let createStarted = false;
    globalThis.createChatMessages = async messages => {
      createStarted = true;
      hostCalls.create.push({ chatId: contextA.chatId, message: messages[0]?.message });
      await createGate;
      contextA.chat.push(assistant(contextA.chat.length, messages[0].message));
    };

    const run = processTotalGrandMemory(manualOptions);
    await Promise.resolve();
    resolveGenerate('<grand_memory>\n[volume:0-1]\n合并\n</grand_memory>');
    // Wait until create is entered
    for (let i = 0; i < 20 && !createStarted; i += 1) await Promise.resolve();
    assert.equal(createStarted, true);

    switchToB();
    createResolve();
    await run;

    assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords.every(r => !r.compressedBy), true);
    assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords.length, 2);
    assert.equal(hostCalls.set.filter(item => item.chatId === 'chat-b').length, 0);
    // A may have orphan create (Phase 5C boundary); B must not be hidden/written.
    assert.equal(contextB.chat.every(item => item.is_hidden !== true), true);
  });
});

test('unavailable chat scope fails closed before model request', async () => {
  await withManualScopeHarness({}, async ({ hostCalls, manualOptions, contextA }) => {
    contextA.chatId = '';
    contextA.characterId = '';
    contextA.this_chid = '';
    await assert.rejects(
      summarizeOpeningMessage(manualOptions),
      error => error.code === 'CHAT_SCOPE_UNAVAILABLE',
    );
    assert.equal(hostCalls.generate, 0);
  });
});

function installDeferredSetChatMessages(hostCalls, getCurrent) {
  let resolveWrite;
  const writeGate = new Promise(resolve => { resolveWrite = resolve; });
  let writeStarted = false;
  const successNotices = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    const text = args.map(String).join(' ');
    if (/已为第|已重写|已重新生成/.test(text)) successNotices.push(text);
    return originalInfo(...args);
  };

  globalThis.setChatMessages = async updates => {
    writeStarted = true;
    hostCalls.set.push({
      chatId: getCurrent().chatId,
      updates: updates.map(item => ({ ...item })),
      phase: 'pending',
    });
    await writeGate;
    for (const update of updates) {
      const target = getCurrent().chat[Number(update.message_id)];
      if (target) Object.assign(target, update);
    }
    hostCalls.set.at(-1).phase = 'done';
    hostCalls.set.at(-1).chatIdAfter = getCurrent().chatId;
  };

  return {
    resolveWrite: () => resolveWrite(),
    isWriteStarted: () => writeStarted,
    successNotices,
    restoreConsole: () => { console.info = originalInfo; },
  };
}

async function waitUntil(predicate, attempts = 40) {
  for (let index = 0; index < attempts && !predicate(); index += 1) {
    await Promise.resolve();
  }
}

test('opening host-write pending A→B discards metadata and success path', async () => {
  await withManualScopeHarness({}, async ({
    contextA,
    contextB,
    hostCalls,
    switchToB,
    resolveGenerate,
    getCurrent,
    manualOptions,
  }) => {
    const write = installDeferredSetChatMessages(hostCalls, getCurrent);
    try {
      const run = summarizeOpeningMessage(manualOptions);
      await Promise.resolve();
      resolveGenerate('<memory>[n:0]\n写入后迟到\n</memory>');
      await waitUntil(() => write.isWriteStarted());
      assert.equal(write.isWriteStarted(), true);

      const fingerprintsBeforeB = {
        ...contextB.chatMetadata[CHAT_STATE_KEY].summary.processedMessageFingerprints,
      };
      const lastErrorBeforeB = contextB.chatMetadata[CHAT_STATE_KEY].summary.lastError;

      switchToB();
      write.resolveWrite();
      await run;

      assert.deepEqual(
        contextB.chatMetadata[CHAT_STATE_KEY].summary.processedMessageFingerprints,
        fingerprintsBeforeB,
      );
      assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.lastError, lastErrorBeforeB);
      assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
      // markManualMemoryProcessed must not run against either chat after scope discard.
      assert.equal(
        Object.keys(contextA.chatMetadata[CHAT_STATE_KEY].summary.processedMessageFingerprints || {}).length,
        0,
      );
      assert.equal(write.successNotices.length, 0);
    } finally {
      write.restoreConsole();
    }
  });
});

test('rewrite host-write pending A→B skips markProcessed, Emotion and Plot', async () => {
  await withManualScopeHarness({
    chatA: [assistant(0, 'pad'), assistant(1, 'A 可重写正文')],
    chatB: [assistant(0, 'pad-b'), assistant(1, 'B 同楼号不同正文')],
  }, async ({
    contextA,
    contextB,
    hostCalls,
    switchToB,
    resolveGenerate,
    getCurrent,
    manualOptions,
  }) => {
    contextA.chatMetadata[CHAT_STATE_KEY].emotionProfiles = { profiles: { kept: true }, pendingByMessage: {} };
    contextB.chatMetadata[CHAT_STATE_KEY].emotionProfiles = { profiles: { kept: true }, pendingByMessage: {} };
    contextA.chatMetadata[CHAT_STATE_KEY].outline = { enabled: true, progress: { a: 1 }, progressSources: {} };
    contextB.chatMetadata[CHAT_STATE_KEY].outline = { enabled: true, progress: { b: 1 }, progressSources: {} };

    const write = installDeferredSetChatMessages(hostCalls, getCurrent);
    try {
      const run = regenerateMemoryForMessage(1, manualOptions);
      await Promise.resolve();
      resolveGenerate('<memory>\n重写写入后迟到\n</memory>');
      await waitUntil(() => write.isWriteStarted());
      assert.equal(write.isWriteStarted(), true);

      switchToB();
      write.resolveWrite();
      await run;

      assert.deepEqual(
        contextB.chatMetadata[CHAT_STATE_KEY].summary.processedMessageFingerprints,
        {},
      );
      assert.deepEqual(contextB.chatMetadata[CHAT_STATE_KEY].emotionProfiles, {
        profiles: { kept: true },
        pendingByMessage: {},
      });
      assert.deepEqual(contextB.chatMetadata[CHAT_STATE_KEY].outline.progress, { b: 1 });
      assert.equal(
        Object.keys(contextA.chatMetadata[CHAT_STATE_KEY].summary.processedMessageFingerprints || {}).length,
        0,
      );
      assert.equal(write.successNotices.length, 0);
    } finally {
      write.restoreConsole();
    }
  });
});

test('grand host-write pending A→B does not mutate records or scan metadata', async () => {
  const grandA = '<grand_memory>\n[volume:0-0]\nA grand\n</grand_memory>';
  const grandB = '<grand_memory>\n[volume:0-0]\nB grand\n</grand_memory>';
  await withManualScopeHarness({
    chatA: [assistant(0, 'A body\n<memory>A</memory>', { is_hidden: true }), assistant(1, grandA)],
    chatB: [assistant(0, 'B body', { is_hidden: true }), assistant(1, grandB)],
    summaryA: {
      archiveRecords: [{
        id: 'rec-a',
        summaryMessageId: 1,
        archiveFrom: 0,
        archiveTo: 0,
        memoryFrom: 0,
        memoryTo: 0,
      }],
    },
    summaryB: {
      archiveRecords: [{
        id: 'rec-b',
        summaryMessageId: 1,
        archiveFrom: 0,
        archiveTo: 0,
        memoryFrom: 9,
        memoryTo: 9,
      }],
    },
  }, async ({
    contextA,
    contextB,
    hostCalls,
    switchToB,
    resolveGenerate,
    getCurrent,
    manualOptions,
  }) => {
    const write = installDeferredSetChatMessages(hostCalls, getCurrent);
    const recordA = contextA.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords[0];
    const recordBBefore = structuredClone(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords);
    try {
      const run = regenerateLatestGrandMemory(manualOptions);
      await Promise.resolve();
      resolveGenerate('<grand_memory>\n[volume:0-0]\n写入后迟到 grand\n</grand_memory>');
      await waitUntil(() => write.isWriteStarted());
      assert.equal(write.isWriteStarted(), true);

      switchToB();
      write.resolveWrite();
      await run;

      assert.deepEqual(contextB.chatMetadata[CHAT_STATE_KEY].summary.archiveRecords, recordBBefore);
      assert.equal(recordA.memoryFrom, 0);
      assert.equal(recordA.memoryTo, 0);
      assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'grand_memory');
      assert.equal(contextB.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
      assert.equal(write.successNotices.length, 0);
    } finally {
      write.restoreConsole();
    }
  });
});

test('host-write pending A→B→A still discards post-write metadata commit', async () => {
  await withManualScopeHarness({}, async ({
    contextA,
    hostCalls,
    switchToB,
    switchToA,
    resolveGenerate,
    getCurrent,
    manualOptions,
  }) => {
    const write = installDeferredSetChatMessages(hostCalls, getCurrent);
    try {
      const run = summarizeOpeningMessage(manualOptions);
      await Promise.resolve();
      resolveGenerate('<memory>[n:0]\nA-B-A 写入后迟到\n</memory>');
      await waitUntil(() => write.isWriteStarted());

      switchToB();
      switchToA();
      // Returning to A clears stale runningTask the same way CHAT_CHANGED does.
      contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask = 'none';
      write.resolveWrite();
      await run;

      assert.equal(
        Object.keys(contextA.chatMetadata[CHAT_STATE_KEY].summary.processedMessageFingerprints || {}).length,
        0,
      );
      assert.equal(write.successNotices.length, 0);
      assert.equal(contextA.chatMetadata[CHAT_STATE_KEY].summary.runningTask, 'none');
    } finally {
      write.restoreConsole();
    }
  });
});
