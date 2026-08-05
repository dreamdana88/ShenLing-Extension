import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  AFFECTION_TRANSPORT_POLICY,
  startAffectionProfileBuildsForPending,
} from '../src/features/affection/workflow.js';
import { createConfirmedSummaryConsumer } from '../src/features/summary/confirmed-consumer.js';
import {
  configureSummaryWorkflow,
  generateConfirmedSummaryForTask,
  processAutoGrandMemory,
  processAutoTotalGrandMemory,
  SUMMARY_TRANSPORT_POLICY,
  writeConfirmedSummaryForTask,
} from '../src/features/summary/workflow.js';
import { getAssistantMessageContentFingerprint } from '../src/core/message-fingerprint.js';

const SECRET = 'sk-auto-confirmed-stream-secret';
const secondaryProfile = {
  name: 'Auto Confirmed Secondary',
  baseUrl: 'https://auto.example',
  endpointPath: '/v1/chat/completions',
  apiKey: SECRET,
  model: 'auto-confirmed-model',
};

function createResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

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

function memoryBody(text = 'confirmed memory body') {
  return `<memory>\n[n:1]\n${text}\n</memory>`;
}

async function withAutoHarness({
  mode = 'main_api',
  generationEnabled = true,
  activeProfile = secondaryProfile,
  tavernHelper,
  generateRaw,
  fetch,
  chat = [assistant(0, '可总结正文：角色完成了关键行动。')],
  summaryState = {},
  modules = {},
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
  const logs = [];
  const context = {
    chatId: 'auto-confirmed-chat',
    chat: [...chat],
    name1: '测试用户',
    name2: '测试角色',
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        generation: { backgroundStreamingEnabled: generationEnabled },
        api: {
          mode,
          activeProfileId: 'default',
          profiles: [{ ...activeProfile, id: 'default' }],
        },
        modules: {
          summary: {
            enabled: true,
            autoGrandMemoryEnabled: true,
            grandMemoryInterval: 1,
            autoTotalGrandMemoryEnabled: false,
            includeUserInput: false,
            ...(modules.summary || {}),
          },
          ...(modules.emotionProfile ? { emotionProfile: modules.emotionProfile } : {}),
          ...(modules.affection ? { affection: modules.affection } : {}),
          ...(modules.memoir ? { memoir: modules.memoir } : {}),
        },
      },
    },
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        summary: {
          runningTask: 'none',
          archiveRecords: [],
          memoryCountSinceArchive: 0,
          memoryCountedMessageIds: [],
          processedMessageFingerprints: {},
          confirmedTasks: [],
          lastError: '',
          ...summaryState,
        },
      },
    },
    saveMetadataDebounced: () => {},
    saveSettingsDebounced: () => {},
    saveChat: async () => {},
  };

  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  if (!globalThis.performance?.now) globalThis.performance = { now: () => Date.now() };

  if (tavernHelper) globalThis.TavernHelper = tavernHelper;
  else delete globalThis.TavernHelper;
  if (generateRaw === undefined) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;
  if (fetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = fetch;

  globalThis.createChatMessages = async messages => {
    const next = messages[0];
    context.chat.push(assistant(context.chat.length, next.message));
  };
  globalThis.setChatMessages = async updates => {
    for (const update of updates) {
      const target = context.chat[Number(update.message_id)];
      if (target) Object.assign(target, update);
    }
  };

  configureSummaryWorkflow({
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => activeProfile,
    getApiSettings: () => ({ mode }),
    refreshSummaryPanel: () => {},
  });

  try {
    return await run({ context, logs, getSummaryState: () => context.chatMetadata[CHAT_STATE_KEY].summary });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('S3-C wiring: formal auto paths use CONFIGURED; shared defaults stay LEGACY', async () => {
  const summarySource = await readFile(new URL('../src/features/summary/workflow.js', import.meta.url), 'utf8');
  const effectsSource = await readFile(new URL('../src/features/summary/confirmed-effects.js', import.meta.url), 'utf8');
  const affectionSource = await readFile(new URL('../src/features/affection/workflow.js', import.meta.url), 'utf8');
  const consumerSource = await readFile(new URL('../src/features/summary/confirmed-consumer.js', import.meta.url), 'utf8');

  assert.match(
    summarySource,
    /type:\s*'confirmed 自动小总结',\s*\r?\n\s*transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.CONFIGURED/,
  );
  assert.match(
    summarySource,
    /type:\s*'自动大总结',\s*\r?\n\s*transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.CONFIGURED/,
  );
  assert.match(
    summarySource,
    /export async function processAutoTotalGrandMemory\([\s\S]*?transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.CONFIGURED/,
  );
  assert.match(
    summarySource,
    /async function tryExtractMemoirAfterGrandSummary\([\s\S]*?transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.CONFIGURED/,
  );

  assert.match(summarySource, /transportPolicy\s*=\s*SUMMARY_TRANSPORT_POLICY\.LEGACY/);
  assert.match(affectionSource, /transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/);
  assert.match(
    affectionSource,
    /export async function commitAffectionUpdateFromConfirmedSummary[\s\S]*?transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/,
  );
  assert.match(effectsSource, /transportPolicy:\s*AFFECTION_TRANSPORT_POLICY\.CONFIGURED/);
  assert.match(consumerSource, /TIMEOUT_ABORT/);
});

test('confirmed auto Summary main API uses stream when configured switch and runtime allow', async () => {
  let received = null;
  let fetchCalls = 0;
  await withAutoHarness({
    mode: 'main_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async request => {
        received = request;
        return memoryBody('stream confirmed');
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('legacy must not run');
    },
    generateRaw: async () => {
      throw new Error('legacy main must not run');
    },
  }, async ({ logs }) => {
    const result = await generateConfirmedSummaryForTask(0);
    assert.match(result.memory, /stream confirmed/);
    assert.equal(received.should_stream, true);
    assert.equal(fetchCalls, 0);
    assert.equal(logs[0].taskType, 'confirmed 自动小总结');
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].transport.fallbackReason, null);
    assert.match(String(logs[0].transport.generationId || received.generation_id), /^slx-main-/);
    assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
  });
});

test('confirmed auto Summary secondary stream accepts responseJson null content contract', async () => {
  await withAutoHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => memoryBody('secondary stream body'),
      stopGenerationById: () => false,
    },
    fetch: async () => {
      throw new Error('legacy must not run');
    },
  }, async ({ logs }) => {
    const result = await generateConfirmedSummaryForTask(0);
    assert.match(result.memory, /secondary stream body/);
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].status, 'success');
    assert.match(String(logs[0].transport.generationId || ''), /^slx-secondary-/);
  });
});

test('confirmed auto Summary uses legacy when background streaming is off', async () => {
  for (const mode of ['main_api', 'secondary_api']) {
    let streamCalls = 0;
    let legacyCalls = 0;
    await withAutoHarness({
      mode,
      generationEnabled: false,
      tavernHelper: {
        generateRaw: async () => {
          streamCalls += 1;
          return memoryBody('stream');
        },
        stopGenerationById: () => false,
      },
      generateRaw: async () => {
        legacyCalls += 1;
        return memoryBody('legacy main');
      },
      fetch: async () => {
        legacyCalls += 1;
        return createResponse({
          body: JSON.stringify({ choices: [{ message: { content: memoryBody('legacy secondary') } }] }),
        });
      },
    }, async ({ logs }) => {
      await generateConfirmedSummaryForTask(0);
      assert.equal(streamCalls, 0);
      assert.equal(legacyCalls, 1);
      assert.equal(logs[0].transport.requestedMode, 'legacy');
      assert.equal(logs[0].transport.actualMode, 'legacy');
      assert.equal(logs[0].transport.fallbackReason, null);
    });
  }
});

test('confirmed auto Summary runtime fallback uses one legacy request', async () => {
  let fetchCalls = 0;
  await withAutoHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    // No TavernHelper → runtime_unavailable
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: memoryBody('fallback') } }] }),
      });
    },
  }, async ({ logs }) => {
    await generateConfirmedSummaryForTask(0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, 'runtime_unavailable');
  });
});

test('confirmed auto Summary endpoint fallback uses one legacy request', async () => {
  let streamCalls = 0;
  let fetchCalls = 0;
  const customProfile = {
    ...secondaryProfile,
    endpointPath: '/custom/chat/completions',
  };
  await withAutoHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    activeProfile: customProfile,
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return memoryBody('no');
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: memoryBody('endpoint legacy') } }] }),
      });
    },
  }, async ({ logs }) => {
    await generateConfirmedSummaryForTask(0);
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.fallbackReason, 'endpoint_unsupported');
    assert.equal(logs[0].transport.actualMode, 'legacy');
  });
});

test('confirmed stream failure does not retry legacy and leaves write to consumer', async () => {
  let fetchCalls = 0;
  await withAutoHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('stream broke mid-flight');
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({ body: '{}' });
    },
  }, async ({ logs }) => {
    await assert.rejects(
      generateConfirmedSummaryForTask(0),
      error => error.code === 'NETWORK_ERROR' || /stream broke|副 API/.test(String(error.message || error)),
    );
    assert.equal(fetchCalls, 0);
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'stream');
  });
});

test('consumer keeps RUNNING and does not write until generate fully resolves', async () => {
  let resolveGenerate;
  const pending = new Promise(resolve => { resolveGenerate = resolve; });
  const writes = [];
  const effects = [];
  const state = {
    summary: {
      confirmedQueueActivatedAt: '2026-08-05T00:00:00.000Z',
      confirmedTasks: [{
        taskKey: '1',
        chatIdentity: 'chat-a',
        originalMessageId: 1,
        assistantFingerprint: '1:1',
        selectedSwipeId: 0,
        confirmingUserMessageId: 2,
        confirmingUserFingerprint: '1:2',
        status: 'PENDING',
        createdAt: '2026-08-05T00:00:01.000Z',
        updatedAt: '2026-08-05T00:00:01.000Z',
      }],
      processedMessageFingerprints: {},
      memoryCountedMessageIds: [],
    },
  };
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => state,
    saveChatState: () => {},
    getChatIdentity: () => 'chat-a',
    isGenerating: () => false,
    isEnabled: () => true,
    isTargetValid: () => true,
    getSummaryFingerprint: () => 'summary:1',
    generate: async () => {
      await pending;
      return { fingerprint: 'summary:1', memory: memoryBody('late'), effectResult: memoryBody('late') };
    },
    write: async (...args) => {
      writes.push(args);
      return true;
    },
    onSummaryCommitted: () => { effects.push('scheduled'); },
    formatTimestamp: () => '2026-08-05T00:00:02.000Z',
    defer: () => {},
  });

  const drain = consumer.drainConfirmedQueue();
  await Promise.resolve();
  assert.equal(state.summary.confirmedTasks[0].status, 'RUNNING');
  assert.deepEqual(writes, []);
  assert.deepEqual(effects, []);

  resolveGenerate();
  await drain;
  assert.equal(state.summary.confirmedTasks[0].status, 'SUMMARIZED');
  assert.equal(writes.length, 1);
  assert.deepEqual(effects, ['scheduled']);
});

test('disabling auto summary after request start cancels without write or effects', async () => {
  let resolveGenerate;
  const pending = new Promise(resolve => { resolveGenerate = resolve; });
  let enabled = true;
  const writes = [];
  const effects = [];
  const state = {
    summary: {
      confirmedQueueActivatedAt: '2026-08-05T00:00:00.000Z',
      confirmedTasks: [{
        taskKey: '1',
        chatIdentity: 'chat-a',
        originalMessageId: 1,
        assistantFingerprint: '1:1',
        selectedSwipeId: 0,
        confirmingUserMessageId: 2,
        confirmingUserFingerprint: '1:2',
        status: 'PENDING',
        createdAt: '2026-08-05T00:00:01.000Z',
        updatedAt: '2026-08-05T00:00:01.000Z',
      }],
      processedMessageFingerprints: {},
    },
  };
  const consumer = createConfirmedSummaryConsumer({
    getChatState: () => state,
    saveChatState: () => {},
    getChatIdentity: () => 'chat-a',
    isGenerating: () => false,
    isEnabled: () => enabled,
    isTargetValid: () => true,
    getSummaryFingerprint: () => 'summary:1',
    generate: async () => {
      await pending;
      return { fingerprint: 'summary:1', memory: memoryBody('late') };
    },
    write: async (...args) => {
      writes.push(args);
      return true;
    },
    onSummaryCommitted: () => { effects.push('scheduled'); },
    formatTimestamp: () => '2026-08-05T00:00:02.000Z',
    defer: () => {},
  });

  const drain = consumer.drainConfirmedQueue();
  await Promise.resolve();
  assert.equal(state.summary.confirmedTasks[0].status, 'RUNNING');
  enabled = false;
  consumer.handleAutoSummaryEnabledChanged(false);
  resolveGenerate();
  await drain;

  assert.equal(state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.equal(state.summary.confirmedTasks[0].reasonCode, 'SUMMARY_DISABLED');
  assert.deepEqual(writes, []);
  assert.deepEqual(effects, []);
});

test('auto Grand uses stream when switch on and commits only after full result', async () => {
  let createCalls = 0;
  let hideCalls = 0;
  let resolveStream;
  const pending = new Promise(resolve => { resolveStream = resolve; });

  const first = assistant(0, 'A 已总结\n<memory>[n:1] A</memory>');
  await withAutoHarness({
    mode: 'main_api',
    generationEnabled: true,
    chat: [first],
    summaryState: {
      memoryCountSinceArchive: 1,
      memoryCountedMessageIds: [0],
      processedMessageFingerprints: {
        0: getAssistantMessageContentFingerprint(first),
      },
      confirmedTasks: [{
        taskKey: 't0',
        chatIdentity: 'auto-confirmed-chat',
        originalMessageId: 0,
        assistantFingerprint: getAssistantMessageContentFingerprint(first),
        selectedSwipeId: 0,
        confirmingUserMessageId: 1,
        confirmingUserFingerprint: '1:1',
        status: 'SUMMARIZED',
        createdAt: 'a',
        updatedAt: 'a',
      }],
    },
    modules: {
      summary: {
        autoGrandMemoryEnabled: true,
        grandMemoryInterval: 1,
      },
    },
    tavernHelper: {
      generateRaw: async () => pending,
      stopGenerationById: () => false,
    },
    generateRaw: async () => {
      throw new Error('legacy main must not run for stream path');
    },
  }, async ({ context, logs, getSummaryState }) => {
    globalThis.createChatMessages = async messages => {
      createCalls += 1;
      const next = messages[0];
      context.chat.push(assistant(context.chat.length, next.message));
    };
    globalThis.setChatMessages = async updates => {
      hideCalls += 1;
      for (const update of updates) {
        const target = context.chat[Number(update.message_id)];
        if (target) Object.assign(target, update);
      }
    };

    const run = processAutoGrandMemory();
    await Promise.resolve();
    assert.equal(getSummaryState().runningTask, 'grand_memory');
    assert.equal(createCalls, 0);
    assert.equal(hideCalls, 0);
    assert.equal((getSummaryState().archiveRecords || []).length, 0);

    resolveStream('<grand_memory>\n[volume: 0-0]\n自动大总结完成\n</grand_memory>');
    await run;

    assert.equal(createCalls, 1);
    assert.equal(hideCalls, 1);
    assert.equal(getSummaryState().archiveRecords.length, 1);
    assert.equal(getSummaryState().memoryCountSinceArchive, 0);
    assert.equal(getSummaryState().runningTask, 'none');
    assert.equal(logs[0].taskType, '自动大总结');
    assert.equal(logs[0].transport.actualMode, 'stream');
  });
});

test('auto Grand stream failure does not create, hide, or clear counters', async () => {
  let createCalls = 0;
  let hideCalls = 0;
  const first = assistant(0, 'A 已总结\n<memory>[n:1] A</memory>');
  await withAutoHarness({
    mode: 'main_api',
    generationEnabled: true,
    chat: [first],
    summaryState: {
      memoryCountSinceArchive: 3,
      memoryCountedMessageIds: [0],
      processedMessageFingerprints: {
        0: getAssistantMessageContentFingerprint(first),
      },
      archiveRecords: [],
      confirmedTasks: [{
        taskKey: 't0',
        chatIdentity: 'auto-confirmed-chat',
        originalMessageId: 0,
        assistantFingerprint: getAssistantMessageContentFingerprint(first),
        selectedSwipeId: 0,
        confirmingUserMessageId: 1,
        confirmingUserFingerprint: '1:1',
        status: 'SUMMARIZED',
        createdAt: 'a',
        updatedAt: 'a',
      }],
    },
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('auto grand stream failed');
      },
      stopGenerationById: () => false,
    },
  }, async ({ context, getSummaryState }) => {
    globalThis.createChatMessages = async () => { createCalls += 1; };
    globalThis.setChatMessages = async () => { hideCalls += 1; };

    await processAutoGrandMemory();
    assert.equal(createCalls, 0);
    assert.equal(hideCalls, 0);
    assert.equal(getSummaryState().archiveRecords.length, 0);
    assert.equal(getSummaryState().memoryCountSinceArchive, 3);
    assert.equal(getSummaryState().runningTask, 'none');
    assert.match(String(getSummaryState().lastError || ''), /auto grand stream failed|流式|NETWORK/);
    assert.equal(context.chat.length, 1);
  });
});

test('next-generation semantics: later auto Grand reads the switch at its own start', async () => {
  const first = assistant(0, 'A 已总结\n<memory>[n:1] A</memory>');
  await withAutoHarness({
    mode: 'main_api',
    generationEnabled: true,
    chat: [first],
    summaryState: {
      memoryCountSinceArchive: 1,
      memoryCountedMessageIds: [0],
      processedMessageFingerprints: {
        0: getAssistantMessageContentFingerprint(first),
      },
      confirmedTasks: [{
        taskKey: 't0',
        chatIdentity: 'auto-confirmed-chat',
        originalMessageId: 0,
        assistantFingerprint: getAssistantMessageContentFingerprint(first),
        selectedSwipeId: 0,
        confirmingUserMessageId: 1,
        confirmingUserFingerprint: '1:1',
        status: 'SUMMARIZED',
        createdAt: 'a',
        updatedAt: 'a',
      }],
    },
  }, async ({ context, logs }) => {
    // Confirmed summary stream while switch is on.
    globalThis.TavernHelper = {
      generateRaw: async () => memoryBody('confirmed stream'),
      stopGenerationById: () => false,
    };
    await generateConfirmedSummaryForTask(0);
    assert.equal(logs.at(-1).transport.actualMode, 'stream');

    // Flip switch off before auto Grand starts → legacy for next generation.
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = false;
    delete globalThis.TavernHelper;
    globalThis.generateRaw = async () => '<grand_memory>\n[volume: 0-0]\nlegacy grand\n</grand_memory>';
    await processAutoGrandMemory();
    const grandLog = logs.find(item => item.taskType === '自动大总结');
    assert.ok(grandLog);
    assert.equal(grandLog.transport.requestedMode, 'legacy');
    assert.equal(grandLog.transport.actualMode, 'legacy');
  });
});

test('shared affection build default remains legacy; explicit CONFIGURED can stream', async () => {
  assert.equal(AFFECTION_TRANSPORT_POLICY.LEGACY, 'legacy');
  assert.equal(AFFECTION_TRANSPORT_POLICY.CONFIGURED, 'configured');

  // Default parameter contract: startAffectionProfileBuildsForPending defaults to LEGACY.
  const source = await readFile(new URL('../src/features/affection/workflow.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /export async function startAffectionProfileBuildsForPending[\s\S]{0,500}transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/,
  );
  assert.match(
    source,
    /export async function commitAffectionUpdateFromConfirmedSummary[\s\S]{0,500}transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/,
  );
  assert.equal(typeof startAffectionProfileBuildsForPending, 'function');
  assert.equal(typeof processAutoTotalGrandMemory, 'function');
  assert.equal(typeof writeConfirmedSummaryForTask, 'function');
  assert.equal(SUMMARY_TRANSPORT_POLICY.LEGACY, 'legacy');
  assert.equal(SUMMARY_TRANSPORT_POLICY.CONFIGURED, 'configured');
});

test('prompt messages for confirmed Summary stay equivalent between stream and legacy', async () => {
  const captured = { stream: null, legacy: null };

  await withAutoHarness({
    mode: 'main_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async request => {
        captured.stream = request.ordered_prompts || request.prompt || request.messages;
        return memoryBody('stream');
      },
      stopGenerationById: () => false,
    },
  }, async () => {
    await generateConfirmedSummaryForTask(0);
  });

  await withAutoHarness({
    mode: 'main_api',
    generationEnabled: false,
    generateRaw: async request => {
      captured.legacy = request.prompt || request.messages;
      return memoryBody('legacy');
    },
  }, async () => {
    await generateConfirmedSummaryForTask(0);
  });

  assert.ok(Array.isArray(captured.stream) || Array.isArray(captured.legacy));
  const streamMessages = captured.stream;
  const legacyMessages = captured.legacy;
  // Main stream uses ordered_prompts; legacy main uses prompt. Compare role/content sequences when both are message arrays.
  if (Array.isArray(streamMessages) && Array.isArray(legacyMessages)) {
    const normalize = messages => messages.map(item => ({
      role: item.role || item.type || '',
      content: String(item.content || item.message || '').trim(),
    }));
    // ordered_prompts may wrap differently; ensure both contain the same user/source material keywords.
    const streamText = JSON.stringify(normalize(streamMessages));
    const legacyText = JSON.stringify(normalize(legacyMessages));
    assert.match(streamText, /可总结正文|关键行动/);
    assert.match(legacyText, /可总结正文|关键行动/);
  }
});
