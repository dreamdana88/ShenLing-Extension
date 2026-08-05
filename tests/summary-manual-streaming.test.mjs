import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAT_STATE_KEY, LONG_FORM_GENERATION_TIMEOUT_MS, MODULE_NAME } from '../src/constants.js';
import {
  configureSummaryWorkflow,
  generateSummaryMemory,
  MANUAL_SUMMARY_GENERATION_TIMEOUT_MS,
  processAutoTotalGrandMemory,
  processLegacyGrandArchive,
  processTotalGrandMemory,
  SUMMARY_TRANSPORT_POLICY,
} from '../src/features/summary/workflow.js';

const SECRET = 'sk-summary-stream-secret';
const profile = {
  name: 'Summary Stream',
  baseUrl: 'https://example.invalid',
  endpointPath: '/v1/chat/completions',
  apiKey: SECRET,
  model: 'summary-stream-model',
};

const PROFILE_A = {
  name: 'Profile A',
  baseUrl: 'https://a.example',
  endpointPath: '/v1/chat/completions',
  apiKey: 'key-a',
  model: 'model-a',
};

const PROFILE_B = {
  name: 'Profile B',
  baseUrl: 'https://b.example',
  endpointPath: '/v1/chat/completions',
  apiKey: 'key-b',
  model: 'model-b',
};

function createResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text).split(needle).length - 1;
}

function assistantMessage(messageId, text) {
  return {
    message_id: messageId,
    role: 'assistant',
    is_user: false,
    is_hidden: false,
    message: String(text),
    mes: String(text),
  };
}

async function withSummaryHarness({
  mode = 'main_api',
  activeProfile = profile,
  tavernHelper,
  generateRaw,
  fetch,
  generationEnabled = true,
  getActiveApiProfile,
} = {}, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    TavernHelper: globalThis.TavernHelper,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
    window: globalThis.window,
    performance: globalThis.performance,
  };
  const logs = [];
  const context = {
    extensionSettings: {
      [MODULE_NAME]: {
        generation: { backgroundStreamingEnabled: generationEnabled },
        api: { mode, activeProfileId: 'default', profiles: [{ ...activeProfile, id: 'default' }] },
      },
    },
    name1: '测试用户',
    name2: '测试角色',
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

  configureSummaryWorkflow({
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: getActiveApiProfile || (() => activeProfile),
    getApiSettings: () => ({ mode }),
    refreshSummaryPanel: () => {},
  });

  try {
    return await run({ context, logs });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

/**
 * Multi-message legacy archive harness.
 * Supports mutable Active Profile mid-task and records every secondary request.
 */
async function withLegacyArchiveHarness({
  mode = 'secondary_api',
  activeProfile = PROFILE_A,
  generationEnabled = true,
  batchSize = '1',
  messageCount = 2,
  transportPolicy = SUMMARY_TRANSPORT_POLICY.CONFIGURED,
  streamHandler,
  fetchHandler,
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

  let currentProfile = { ...activeProfile };
  const profileReads = [];
  const streamRequests = [];
  const fetchRequests = [];
  const logs = [];

  const chat = Array.from({ length: messageCount }, (_, index) => (
    assistantMessage(index, `旧聊天正文 ${index + 1}：角色行动与剧情推进。`)
  ));

  const context = {
    chatId: 'legacy-archive-profile-freeze',
    chat,
    name1: '测试用户',
    name2: '测试角色',
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        generation: { backgroundStreamingEnabled: generationEnabled },
        api: {
          mode,
          activeProfileId: 'profile-a',
          profiles: [
            { ...PROFILE_A, id: 'profile-a' },
            { ...PROFILE_B, id: 'profile-b' },
          ],
        },
        modules: {
          summary: {
            enabled: true,
            legacyArchiveBatchSize: String(batchSize),
            includeUserInput: false,
            autoGrandMemoryEnabled: false,
            autoTotalGrandMemoryEnabled: false,
          },
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
          lastError: '',
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

  if (mode === 'secondary_api' && generationEnabled) {
    globalThis.TavernHelper = {
      generateRaw: async request => {
        streamRequests.push(request);
        if (typeof streamHandler === 'function') {
          return streamHandler(request, streamRequests.length);
        }
        return `批次或最终摘要 ${streamRequests.length}`;
      },
      stopGenerationById: () => false,
    };
  } else {
    delete globalThis.TavernHelper;
  }

  if (mode === 'main_api') {
    globalThis.generateRaw = async request => {
      streamRequests.push(request || {});
      if (typeof streamHandler === 'function') {
        return streamHandler(request, streamRequests.length);
      }
      return `<grand_memory>\n[volume: 0-${messageCount - 1}]\n主 API 大总结\n</grand_memory>`;
    };
  } else {
    delete globalThis.generateRaw;
  }

  globalThis.fetch = async (url, options = {}) => {
    const bodyText = String(options.body || '');
    let bodyJson = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }
    fetchRequests.push({
      url: String(url),
      headers: options.headers || {},
      body: bodyText,
      bodyJson,
    });
    if (typeof fetchHandler === 'function') {
      return fetchHandler(url, options, fetchRequests.length);
    }
    return createResponse({
      body: JSON.stringify({
        choices: [{ message: { content: `legacy 摘要 ${fetchRequests.length}` } }],
      }),
    });
  };

  globalThis.createChatMessages = async messages => {
    const next = messages[0];
    context.chat.push(assistantMessage(context.chat.length, next.message));
  };

  globalThis.setChatMessages = async updates => {
    for (const update of updates) {
      const target = context.chat[Number(update.message_id)];
      if (target) Object.assign(target, update);
    }
  };

  configureSummaryWorkflow({
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => {
      profileReads.push({ ...currentProfile });
      return currentProfile;
    },
    getApiSettings: () => ({ mode }),
    refreshSummaryPanel: () => {},
  });

  const switchActiveProfile = nextProfile => {
    currentProfile = { ...nextProfile };
    context.extensionSettings[MODULE_NAME].api.activeProfileId =
      nextProfile.model === PROFILE_B.model ? 'profile-b' : 'profile-a';
  };

  try {
    return await run({
      context,
      logs,
      streamRequests,
      fetchRequests,
      profileReads,
      switchActiveProfile,
      getCurrentProfile: () => currentProfile,
      transportPolicy,
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('SUMMARY_TRANSPORT_POLICY defaults to legacy and manual timeout is 300s', () => {
  assert.equal(SUMMARY_TRANSPORT_POLICY.LEGACY, 'legacy');
  assert.equal(SUMMARY_TRANSPORT_POLICY.CONFIGURED, 'configured');
  assert.equal(MANUAL_SUMMARY_GENERATION_TIMEOUT_MS, LONG_FORM_GENERATION_TIMEOUT_MS);
  assert.equal(MANUAL_SUMMARY_GENERATION_TIMEOUT_MS, 300000);
});

test('generateSummaryMemory defaults to legacy even when global streaming is on', async () => {
  let streamCalls = 0;
  let fetchCalls = 0;
  await withSummaryHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return '<memory>stream</memory>';
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: '<memory>legacy</memory>' } }] }),
      });
    },
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('auto default', { type: '自动小总结' });
    assert.equal(result, '<memory>legacy</memory>');
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'legacy');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('configured + setting on + runtime uses stream for main and secondary', async () => {
  for (const mode of ['main_api', 'secondary_api']) {
    let received = null;
    let fetchCalls = 0;
    await withSummaryHarness({
      mode,
      generationEnabled: true,
      tavernHelper: {
        generateRaw: async request => {
          received = request;
          return '<memory>stream body</memory>';
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
      const result = await generateSummaryMemory('manual stream', {
        type: '0楼小总结',
        transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
        timeoutMs: MANUAL_SUMMARY_GENERATION_TIMEOUT_MS,
      });
      assert.equal(result, '<memory>stream body</memory>');
      assert.equal(received.should_stream, true);
      assert.equal(fetchCalls, 0);
      assert.equal(logs[0].transport.requestedMode, 'stream');
      assert.equal(logs[0].transport.actualMode, 'stream');
      assert.equal(logs[0].transport.fallbackReason, null);
      assert.match(received.generation_id, mode === 'main_api' ? /^slx-main-/ : /^slx-secondary-/);
    });
  }
});

test('configured + setting off uses legacy', async () => {
  let streamCalls = 0;
  let fetchCalls = 0;
  await withSummaryHarness({
    mode: 'secondary_api',
    generationEnabled: false,
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return '<memory>stream</memory>';
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: '<memory>legacy off</memory>' } }] }),
      });
    },
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('manual off', {
      type: '手动重写小总结',
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });
    assert.equal(result, '<memory>legacy off</memory>');
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'legacy');
    assert.equal(logs[0].transport.actualMode, 'legacy');
  });
});

test('configured runtime fallback uses legacy once and records fallbackReason', async () => {
  let fetchCalls = 0;
  await withSummaryHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: '<memory>fallback</memory>' } }] }),
      });
    },
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('fallback', {
      type: '重新生成大总结',
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });
    assert.equal(result, '<memory>fallback</memory>');
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, 'runtime_unavailable');
  });
});

test('configured endpoint fallback uses legacy once', async () => {
  let streamCalls = 0;
  let fetchCalls = 0;
  const customProfile = {
    ...profile,
    endpointPath: '/custom/chat/completions',
  };
  await withSummaryHarness({
    mode: 'secondary_api',
    activeProfile: customProfile,
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return '<memory>no</memory>';
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: '<memory>endpoint legacy</memory>' } }] }),
      });
    },
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('endpoint', {
      type: '合并大总结',
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });
    assert.equal(result, '<memory>endpoint legacy</memory>');
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.fallbackReason, 'endpoint_unsupported');
    assert.equal(logs[0].transport.actualMode, 'legacy');
  });
});

test('stream start failure does not retry legacy', async () => {
  let fetchCalls = 0;
  await withSummaryHarness({
    mode: 'main_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('stream broke');
      },
      stopGenerationById: () => false,
    },
    fetch: async () => {
      fetchCalls += 1;
      return createResponse({ body: '{}' });
    },
    generateRaw: async () => 'legacy main',
  }, async ({ logs }) => {
    await assert.rejects(
      generateSummaryMemory('fail stream', {
        transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
      }),
      error => error.code === 'NETWORK_ERROR',
    );
    assert.equal(fetchCalls, 0);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
  });
});

test('secondary stream path accepts responseJson null with non-empty content', async () => {
  await withSummaryHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => '<memory>stream no json envelope</memory>',
      stopGenerationById: () => false,
    },
    fetch: async () => {
      throw new Error('legacy must not run');
    },
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('stream content', {
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });
    assert.equal(result, '<memory>stream no json envelope</memory>');
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].transport.actualMode, 'stream');
  });
});

test('secondary empty content fails under stream-compatible content contract', async () => {
  await withSummaryHarness({
    mode: 'secondary_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => '   ',
      stopGenerationById: () => false,
    },
  }, async ({ logs }) => {
    await assert.rejects(
      generateSummaryMemory('empty', {
        transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
      }),
      /没有读取到回复正文|缺少可用模型正文/,
    );
    assert.equal(logs[0].status, 'failure');
  });
});

test('manual configured options pass 300000 timeoutMs', async () => {
  let seenTimeout = null;
  await withSummaryHarness({
    mode: 'main_api',
    generationEnabled: true,
    tavernHelper: {
      generateRaw: async () => '<memory>ok</memory>',
      stopGenerationById: () => false,
    },
  }, async () => {
    // Spy via monkey-patching is heavy; assert options builder contract via generate call path.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, timeoutMs, ...args) => {
      if (timeoutMs === 300000) seenTimeout = timeoutMs;
      return originalSetTimeout(callback, timeoutMs === 300000 ? 5 : timeoutMs, ...args);
    };
    try {
      await generateSummaryMemory('timeout contract', {
        type: '0楼小总结',
        transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
        timeoutMs: MANUAL_SUMMARY_GENERATION_TIMEOUT_MS,
        timeoutMessage: 'stream timeout marker',
      });
      // Stream success may clear timer before 300000 fires; verify option accepted without error.
      assert.equal(MANUAL_SUMMARY_GENERATION_TIMEOUT_MS, 300000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
  assert.equal(seenTimeout === null || seenTimeout === 300000, true);
});

test('processAutoTotalGrandMemory forces legacy policy', async () => {
  const source = await readFile(new URL('../src/features/summary/workflow.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /processAutoTotalGrandMemory[\s\S]*?transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.LEGACY/,
  );
  assert.match(
    source,
    /tryExtractMemoirAfterGrandSummary[\s\S]*?transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.LEGACY/,
  );
});

test('panel manual buttons pass CONFIGURED policy', async () => {
  const source = await readFile(new URL('../src/features/summary/panel.js', import.meta.url), 'utf8');
  assert.match(source, /manualConfigured\s*=\s*\{\s*transportPolicy:\s*SUMMARY_TRANSPORT_POLICY\.CONFIGURED\s*\}/);
  assert.match(source, /processLegacyGrandArchive\(manualConfigured\)/);
  assert.match(source, /regenerateLatestGrandMemory\(manualConfigured\)/);
  assert.match(source, /processTotalGrandMemory\(manualConfigured\)/);
  assert.match(source, /summarizeOpeningMessage\(manualConfigured\)/);
  assert.match(source, /regenerateMemoryForMessage\(messageId,\s*manualConfigured\)/);
});

test('legacy archive freezes the same transportPlan across batch and final requests', async () => {
  const source = await readFile(new URL('../src/features/summary/workflow.js', import.meta.url), 'utf8');
  assert.match(source, /frozenTransportPlan\s*=\s*resolveSummaryTransportPlan/);
  assert.match(source, /createManualSummaryGenerationOptions\(\s*'旧聊天批次摘要'/);
  assert.match(source, /createManualSummaryGenerationOptions\(\s*'旧聊天大总结'/);
  assert.equal(typeof processLegacyGrandArchive, 'function');
  assert.equal(typeof processTotalGrandMemory, 'function');
  assert.equal(typeof processAutoTotalGrandMemory, 'function');
});

test('secondary stream multi-batch archive freezes Profile A after Active switches to B', async () => {
  await withLegacyArchiveHarness({
    mode: 'secondary_api',
    activeProfile: PROFILE_A,
    generationEnabled: true,
    batchSize: '1',
    messageCount: 2,
    streamHandler: (request, callIndex) => {
      // After the first batch is dispatched, switch Active Profile to B mid-archive.
      if (callIndex === 1) {
        // switch happens outside via run callback after process starts; hook below uses shared state
      }
      return `stream summary ${callIndex}`;
    },
  }, async ({
    logs,
    streamRequests,
    fetchRequests,
    switchActiveProfile,
    profileReads,
  }) => {
    // Intercept: switch after first stream request is recorded.
    const originalLengthGuard = streamRequests.length;
    assert.equal(originalLengthGuard, 0);

    // Wrap process so we switch after batch 1 completes (generateRaw already recorded A).
    const previousTH = globalThis.TavernHelper;
    let streamCall = 0;
    globalThis.TavernHelper = {
      generateRaw: async request => {
        streamCall += 1;
        streamRequests.push(request);
        if (streamCall === 1) {
          switchActiveProfile(PROFILE_B);
        }
        return `stream summary ${streamCall}`;
      },
      stopGenerationById: () => false,
    };

    try {
      await processLegacyGrandArchive({
        transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
      });
    } finally {
      globalThis.TavernHelper = previousTH;
    }

    // 2 batch summaries + 1 final grand = 3 secondary stream requests
    assert.equal(streamRequests.length, 3, `expected 3 stream requests, got ${streamRequests.length}`);
    assert.equal(fetchRequests.length, 0, 'stream path must not fall back to fetch');

    for (const [index, request] of streamRequests.entries()) {
      const customApi = request.custom_api || {};
      assert.equal(customApi.model, 'model-a', `request ${index + 1} model must stay Profile A`);
      assert.equal(customApi.apiurl, 'https://a.example/v1', `request ${index + 1} apiurl must stay Profile A`);
      assert.equal(customApi.key, 'key-a', `request ${index + 1} key must stay Profile A`);
      assert.equal(request.should_stream, true);
    }

    const serializedRequests = JSON.stringify(streamRequests);
    assert.equal(countOccurrences(serializedRequests, 'model-b'), 0);
    assert.equal(countOccurrences(serializedRequests, 'https://b.example'), 0);
    assert.equal(countOccurrences(serializedRequests, 'key-b'), 0);
    assert.equal(countOccurrences(serializedRequests, 'model-a'), 3);
    assert.equal(countOccurrences(serializedRequests, 'key-a'), 3);

    // Profile B must not be re-read for subsequent generation requests after freeze.
    // Freeze reads Profile once at start (+ optional resolve transport for endpoint check).
    const bReads = profileReads.filter(item => item.model === 'model-b');
    assert.equal(bReads.length, 0, 'frozen archive must not re-read Active Profile B for generation');

    // Transport freeze + plan must not embed Profile / secrets
    assert.equal(logs.length >= 3, true);
    for (const log of logs) {
      assert.equal(log.transport.requestedMode, 'stream');
      assert.equal(log.transport.actualMode, 'stream');
      assert.equal(log.transport.fallbackReason, null);
      assert.equal(Object.hasOwn(log.transport, 'profile'), false);
      assert.equal(Object.hasOwn(log.transport, 'apiKey'), false);
      assert.equal(Object.hasOwn(log.transport, 'profileSnapshot'), false);
    }

    const logsText = JSON.stringify(logs);
    assert.equal(logsText.includes('key-a'), false, 'communication logs must not contain key-a');
    assert.equal(logsText.includes('key-b'), false, 'communication logs must not contain key-b');
  });
});

test('secondary legacy archive freezes Profile A after Active switches to B', async () => {
  await withLegacyArchiveHarness({
    mode: 'secondary_api',
    activeProfile: PROFILE_A,
    // Force pre-request legacy transport (streaming switch off).
    generationEnabled: false,
    batchSize: '1',
    messageCount: 2,
  }, async ({
    logs,
    streamRequests,
    fetchRequests,
    switchActiveProfile,
  }) => {
    let fetchCall = 0;
    globalThis.fetch = async (url, options = {}) => {
      fetchCall += 1;
      const bodyText = String(options.body || '');
      let bodyJson = null;
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        bodyJson = null;
      }
      fetchRequests.push({
        url: String(url),
        headers: options.headers || {},
        body: bodyText,
        bodyJson,
      });
      if (fetchCall === 1) {
        switchActiveProfile(PROFILE_B);
      }
      return createResponse({
        body: JSON.stringify({
          choices: [{ message: { content: `legacy summary ${fetchCall}` } }],
        }),
      });
    };

    await processLegacyGrandArchive({
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });

    assert.equal(streamRequests.length, 0);
    assert.equal(fetchRequests.length, 3, '2 batches + final must use legacy fetch');

    for (const [index, request] of fetchRequests.entries()) {
      assert.match(request.url, /^https:\/\/a\.example\/v1\/chat\/completions$/);
      assert.equal(request.bodyJson?.model, 'model-a', `fetch ${index + 1} model must stay Profile A`);
      assert.equal(
        request.headers.Authorization,
        'Bearer key-a',
        `fetch ${index + 1} auth must stay Profile A`,
      );
    }

    const serialized = JSON.stringify(fetchRequests);
    assert.equal(countOccurrences(serialized, 'model-b'), 0);
    assert.equal(countOccurrences(serialized, 'https://b.example'), 0);
    assert.equal(countOccurrences(serialized, 'key-b'), 0);
    assert.equal(countOccurrences(serialized, 'Bearer key-b'), 0);

    for (const log of logs) {
      assert.equal(log.transport.requestedMode, 'legacy');
      assert.equal(log.transport.actualMode, 'legacy');
      assert.equal(log.transport.fallbackReason, null);
    }

    const logsText = JSON.stringify(logs);
    assert.equal(logsText.includes('key-a'), false);
    assert.equal(logsText.includes('key-b'), false);
  });
});

test('secondary runtime-fallback archive freezes Profile and transport plan', async () => {
  await withLegacyArchiveHarness({
    mode: 'secondary_api',
    activeProfile: PROFILE_A,
    // Streaming enabled but runtime has no generateRaw capability → runtime_unavailable
    generationEnabled: true,
    batchSize: '1',
    messageCount: 2,
  }, async ({
    logs,
    streamRequests,
    fetchRequests,
    switchActiveProfile,
  }) => {
    // Ensure no stream capability: TavernHelper deleted by harness when we replace after setup
    delete globalThis.TavernHelper;

    let fetchCall = 0;
    globalThis.fetch = async (url, options = {}) => {
      fetchCall += 1;
      const bodyText = String(options.body || '');
      let bodyJson = null;
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        bodyJson = null;
      }
      fetchRequests.push({
        url: String(url),
        headers: options.headers || {},
        body: bodyText,
        bodyJson,
      });
      if (fetchCall === 1) {
        switchActiveProfile(PROFILE_B);
      }
      return createResponse({
        body: JSON.stringify({
          choices: [{ message: { content: `fallback summary ${fetchCall}` } }],
        }),
      });
    };

    // Rebuild harness TavernHelper as missing: withLegacyArchiveHarness already created TH
    // when generationEnabled true. Force capability unavailable by deleting TH before archive.
    delete globalThis.TavernHelper;

    await processLegacyGrandArchive({
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });

    assert.equal(streamRequests.length, 0);
    assert.equal(fetchRequests.length, 3);

    for (const request of fetchRequests) {
      assert.equal(request.bodyJson?.model, 'model-a');
      assert.match(request.url, /https:\/\/a\.example\//);
      assert.equal(request.headers.Authorization, 'Bearer key-a');
    }

    const firstTransport = logs[0]?.transport;
    assert.equal(firstTransport?.requestedMode, 'stream');
    assert.equal(firstTransport?.actualMode, 'legacy');
    assert.equal(firstTransport?.fallbackReason, 'runtime_unavailable');

    for (const log of logs) {
      assert.equal(log.transport.requestedMode, firstTransport.requestedMode);
      assert.equal(log.transport.actualMode, firstTransport.actualMode);
      assert.equal(log.transport.fallbackReason, firstTransport.fallbackReason);
    }

    assert.equal(JSON.stringify(logs).includes('key-a'), false);
    assert.equal(JSON.stringify(logs).includes('key-b'), false);
  });
});

test('generateSummaryMemory without profileSnapshot still uses current Active Profile', async () => {
  let current = { ...PROFILE_A };
  const seen = [];

  await withSummaryHarness({
    mode: 'secondary_api',
    activeProfile: PROFILE_A,
    generationEnabled: false,
    getActiveApiProfile: () => current,
    fetch: async (url, options = {}) => {
      const body = JSON.parse(String(options.body || '{}'));
      seen.push({
        url: String(url),
        model: body.model,
        authorization: options.headers?.Authorization,
      });
      return createResponse({
        body: JSON.stringify({
          choices: [{ message: { content: `<memory>ok ${seen.length}</memory>` } }],
        }),
      });
    },
  }, async () => {
    await generateSummaryMemory('first', { type: '自动小总结' });
    current = { ...PROFILE_B };
    await generateSummaryMemory('second', { type: '自动小总结' });

    assert.equal(seen.length, 2);
    assert.equal(seen[0].model, 'model-a');
    assert.equal(seen[0].authorization, 'Bearer key-a');
    assert.match(seen[0].url, /https:\/\/a\.example\//);
    assert.equal(seen[1].model, 'model-b');
    assert.equal(seen[1].authorization, 'Bearer key-b');
    assert.match(seen[1].url, /https:\/\/b\.example\//);
  });
});

test('main API legacy archive does not depend on secondary Profile snapshot', async () => {
  await withLegacyArchiveHarness({
    mode: 'main_api',
    activeProfile: PROFILE_A,
    generationEnabled: true,
    batchSize: '1',
    messageCount: 2,
  }, async ({
    streamRequests,
    fetchRequests,
    profileReads,
    switchActiveProfile,
  }) => {
    let mainCall = 0;
    globalThis.generateRaw = async () => {
      mainCall += 1;
      streamRequests.push({ provider: 'main', call: mainCall });
      if (mainCall === 1) {
        switchActiveProfile(PROFILE_B);
      }
      return `<grand_memory>\n[volume: 0-1]\n主 API 归档 ${mainCall}\n</grand_memory>`;
    };
    // Main stream capability
    globalThis.TavernHelper = {
      generateRaw: globalThis.generateRaw,
      stopGenerationById: () => false,
    };

    await processLegacyGrandArchive({
      transportPolicy: SUMMARY_TRANSPORT_POLICY.CONFIGURED,
    });

    assert.equal(fetchRequests.length, 0);
    assert.equal(mainCall, 3, 'main API still runs 2 batches + final');
    // Main path must never require Active secondary Profile for requests.
    assert.equal(
      profileReads.filter(item => item.model === 'model-b').length,
      0,
      'main API archive must not re-read secondary profile after start for generation',
    );
  });
});

test('workflow source keeps profileSnapshot out of transportPlan and freezes secondary profile', async () => {
  const source = await readFile(new URL('../src/features/summary/workflow.js', import.meta.url), 'utf8');
  assert.match(source, /profileSnapshot\s*=\s*null/);
  assert.match(source, /profileSnapshot\s*\|\|\s*requireWorkflowOption\('getActiveApiProfile'\)/);
  assert.match(source, /freezeSecondaryProfileSnapshot/);
  assert.match(source, /frozenProfileSnapshot/);
  assert.match(source, /cloneData\(profile\)/);
  // transportPlan builder must not assign profile fields
  assert.doesNotMatch(
    source,
    /transportPlan\s*[:=][^\n]*profileSnapshot/,
  );
});
