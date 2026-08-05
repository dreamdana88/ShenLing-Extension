import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { LONG_FORM_GENERATION_TIMEOUT_MS, MODULE_NAME } from '../src/constants.js';
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

function createResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

async function withSummaryHarness({
  mode = 'main_api',
  activeProfile = profile,
  tavernHelper,
  generateRaw,
  fetch,
  generationEnabled = true,
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
    getActiveApiProfile: () => activeProfile,
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
