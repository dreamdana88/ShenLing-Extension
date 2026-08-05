import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  AFFECTION_TRANSPORT_POLICY,
  runAffectionProfileBuildApiPreview,
} from '../src/features/affection/generation.js';
import { startAffectionProfileBuildsForPending } from '../src/features/affection/lifecycle.js';
import { configureAffectionWorkflow } from '../src/features/affection/runtime.js';
import { regenerateAffectionProfileStages } from '../src/features/affection/workflow.js';
import { runCaptureGeneration } from '../src/features/memoir/capture-generation.js';
import { configureCaptureWorkflow } from '../src/features/memoir/runtime.js';

const SECRET = 'sk-policy-secret-never-log';
const secondaryProfile = {
  name: 'Policy Secondary',
  baseUrl: 'https://example.invalid',
  endpointPath: '/v1/chat/completions',
  apiKey: SECRET,
  model: 'policy-model',
};

function createValidAffectionStagesJson() {
  const stages = Array.from({ length: 5 }, (_, index) => ({
    name: `阶段${index + 1}`,
    meaning: `含义${index + 1}`,
    trend: `趋势${index + 1}`,
    boundary: `边界${index + 1}`,
    behaviors: [`行为A${index + 1}`, `行为B${index + 1}`, `行为C${index + 1}`],
  }));
  return JSON.stringify({ stages });
}

function createExtensionSettings(overrides = {}) {
  return {
    [MODULE_NAME]: {
      enabled: true,
      generation: { backgroundStreamingEnabled: true },
      api: {
        mode: 'secondary_api',
        activeProfileId: 'default',
        profiles: [{ ...secondaryProfile, id: 'default' }],
      },
      modules: {
        summary: { enabled: true },
        affection: {
          enabled: true,
          mode: 'normal',
          defaultBuildMode: 'custom',
          profileBuildApiMode: 'secondary_api',
        },
        memoir: { apiMode: 'secondary_api' },
      },
      communicationLog: { maxEntries: 20, entries: [] },
      ...overrides,
    },
  };
}

async function withHarness({
  tavernHelper,
  fetchImpl,
  generateRaw,
  configure,
} = {}, run) {
  const logs = [];
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    TavernHelper: globalThis.TavernHelper,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
  };

  const context = {
    extensionSettings: createExtensionSettings(),
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        identity: {
          characterId: 'c1',
          characterName: '测试角色',
          chatId: 'chat-1',
          chatName: '测试聊天',
        },
        affectionSystem: { profiles: {}, pendingByMessage: {}, buildTasks: {} },
        memoir: { capture: { drafts: [], lastError: '' } },
      },
    },
    chat: [],
    names: { userName: '用户', characterName: '测试角色' },
    saveSettingsDebounced: () => {},
    saveMetadataDebounced: () => {},
  };

  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, select: () => {}, value: '' }),
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => true,
  };
  if (!globalThis.performance?.now) globalThis.performance = { now: () => Date.now() };

  if (tavernHelper) globalThis.TavernHelper = tavernHelper;
  else delete globalThis.TavernHelper;
  if (generateRaw === undefined) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;
  if (fetchImpl === undefined) delete globalThis.fetch;
  else globalThis.fetch = fetchImpl;

  const shared = {
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => secondaryProfile,
    refreshPanel: () => {},
  };
  configure?.(shared, context, logs);

  try {
    return await run({ context, logs, shared });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

async function getRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}

test('manual affection preview uses configured stream when setting and runtime allow', async () => {
  let received = null;
  await withHarness({
    tavernHelper: {
      async generateRaw(request) {
        received = request;
        return createValidAffectionStagesJson();
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      throw new Error('legacy fetch must not run');
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = true;
    await runAffectionProfileBuildApiPreview({
      roleName: '预览角色',
      initialValueTenths: 100,
    });
    assert.equal(received.should_stream, true);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('manual affection preview uses legacy when setting is off', async () => {
  let fetchCalls = 0;
  let streamCalls = 0;
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return createValidAffectionStagesJson();
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          choices: [{ message: { content: createValidAffectionStagesJson() } }],
        }),
      };
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = false;
    await runAffectionProfileBuildApiPreview({
      roleName: '预览角色',
      initialValueTenths: 100,
    });
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'legacy');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('manual regenerate uses configured policy', async () => {
  let received = null;
  await withHarness({
    tavernHelper: {
      async generateRaw(request) {
        received = request;
        return createValidAffectionStagesJson();
      },
      stopGenerationById: () => false,
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ context }) => {
    context.chatMetadata[CHAT_STATE_KEY].affectionSystem.profiles = {
      沈青: {
        roleName: '沈青',
        initialValueTenths: 100,
        valueTenths: 100,
        stages: JSON.parse(createValidAffectionStagesJson()).stages,
        records: [],
      },
    };
    await regenerateAffectionProfileStages({ roleName: '沈青' }, {
      settings: context.extensionSettings[MODULE_NAME],
      chatState: context.chatMetadata[CHAT_STATE_KEY],
      resolveContextMaterial: async () => 'ctx',
    });
    assert.equal(received.should_stream, true);
  });
});

test('automatic pending builds force legacy even when global streaming is on', async () => {
  let fetchCalls = 0;
  let streamCalls = 0;
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return createValidAffectionStagesJson();
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          choices: [{ message: { content: createValidAffectionStagesJson() } }],
        }),
      };
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = true;
    const chatState = context.chatMetadata[CHAT_STATE_KEY];
    const tasks = await startAffectionProfileBuildsForPending({
      messageId: 7,
      fingerprint: 'fp-auto',
      firsts: [{ roleName: '自动角色', initialValueTenths: 150 }],
    }, {
      settings: context.extensionSettings[MODULE_NAME],
      chatState,
      chatId: 'chat-1',
      persist: false,
      force: true,
      getCurrentSnapshot: () => ({ chatId: 'chat-1', fingerprint: 'fp-auto', active: true }),
      getCurrentChatState: () => chatState,
      resolveContextMaterial: async () => 'ctx',
      log: true,
    });
    assert.equal(tasks[0].buildStatus, 'ready');
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'legacy');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('default transport policy is legacy for pending entry', async () => {
  const generation = await readFile(new URL('../src/features/affection/generation.js', import.meta.url), 'utf8');
  const lifecycle = await readFile(new URL('../src/features/affection/lifecycle.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../src/features/affection/workflow.js', import.meta.url), 'utf8');
  assert.match(lifecycle, /transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/);
  assert.match(generation, /transportPolicy:\s*AFFECTION_TRANSPORT_POLICY\.CONFIGURED/);
  assert.match(workflow, /transportPolicy:\s*AFFECTION_TRANSPORT_POLICY\.CONFIGURED/);
  assert.equal(AFFECTION_TRANSPORT_POLICY.LEGACY, 'legacy');
  assert.equal(AFFECTION_TRANSPORT_POLICY.CONFIGURED, 'configured');
});

test('affection configured stream failure keeps transportPlan in failure log', async () => {
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('stream provider failed');
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      throw new Error('legacy must not run after stream start');
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = true;
    await getRejection(runAffectionProfileBuildApiPreview({
      roleName: '失败角色',
      initialValueTenths: 100,
    }));
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].errorCode, 'NETWORK_ERROR');
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].transport.fallbackReason, null);
    assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
  });
});

test('affection configured runtime fallback failure keeps fallbackReason', async () => {
  let fetchCalls = 0;
  await withHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('legacy after fallback failed');
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = true;
    await getRejection(runAffectionProfileBuildApiPreview({
      roleName: '回退角色',
      initialValueTenths: 100,
    }));
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, 'runtime_unavailable');
  });
});

test('affection settings-off legacy failure keeps legacy plan', async () => {
  await withHarness({
    fetchImpl: async () => {
      throw new Error('legacy off failed');
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = false;
    await getRejection(runAffectionProfileBuildApiPreview({
      roleName: '关闭角色',
      initialValueTenths: 100,
    }));
    assert.equal(logs[0].transport.requestedMode, 'legacy');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('affection pre-transport failure does not fabricate stream actualMode', async () => {
  await withHarness({
    tavernHelper: {
      generateRaw: async () => createValidAffectionStagesJson(),
      stopGenerationById: () => false,
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs }) => {
    await getRejection(runAffectionProfileBuildApiPreview({
      roleName: '',
      initialValueTenths: 100,
    }));
    // Validation fails before transport resolve / generate.
    assert.equal(logs.length, 0);
  });
});

function captureStateFixture() {
  return {
    request: '采集一座山神庙',
    requestedType: 'location',
    source: {
      mode: 'recent_chat',
      recentCount: 20,
    },
    optionalContext: {
      includeCharacterCard: false,
      includePersona: false,
      worldbookRefs: [],
    },
    drafts: [],
    lastError: '',
  };
}

function captureMaterialFixture() {
  return {
    messages: [
      { message_id: 0, role: 'user', message: '我们到了山脚。' },
      { message_id: 1, role: 'assistant', message: '庙门半掩。' },
    ],
    names: { userName: '测试用户', characterName: '测试角色' },
  };
}

test('memoir stream failure keeps outer transportPlan', async () => {
  let fetchCalls = 0;
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('capture stream failed');
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('legacy must not run after stream start');
    },
    configure: options => configureCaptureWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = true;
    await getRejection(runCaptureGeneration({
      captureState: captureStateFixture(),
      materialOptions: captureMaterialFixture(),
      apiMode: 'main_api',
      persist: false,
    }));
    assert.equal(fetchCalls, 0);
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].errorCode, 'NETWORK_ERROR');
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('memoir endpoint fallback failure keeps fallbackReason', async () => {
  let fetchCalls = 0;
  let streamCalls = 0;
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        throw new Error('must not stream custom endpoint');
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('endpoint legacy failed');
    },
    configure: options => configureCaptureWorkflow({
      ...options,
      getActiveApiProfile: () => ({
        ...secondaryProfile,
        endpointPath: '/custom/chat/completions',
      }),
    }),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = true;
    await getRejection(runCaptureGeneration({
      captureState: captureStateFixture(),
      materialOptions: captureMaterialFixture(),
      apiMode: 'secondary_api',
      persist: false,
    }));
    assert.equal(streamCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, 'endpoint_unsupported');
  });
});

test('memoir settings-off legacy failure keeps legacy plan', async () => {
  let streamCalls = 0;
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        streamCalls += 1;
        return '{}';
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      throw new Error('settings off legacy failed');
    },
    configure: options => configureCaptureWorkflow(options),
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation.backgroundStreamingEnabled = false;
    await getRejection(runCaptureGeneration({
      captureState: captureStateFixture(),
      materialOptions: captureMaterialFixture(),
      apiMode: 'secondary_api',
      persist: false,
    }));
    assert.equal(streamCalls, 0);
    assert.equal(logs[0].transport.requestedMode, 'legacy');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, null);
  });
});

test('static scan: pending defaults legacy; confirmed formal path can pass configured', async () => {
  const generation = await readFile(new URL('../src/features/affection/generation.js', import.meta.url), 'utf8');
  const lifecycle = await readFile(new URL('../src/features/affection/lifecycle.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../src/features/affection/workflow.js', import.meta.url), 'utf8');
  // Manual entries must explicitly use CONFIGURED.
  assert.match(
    generation,
    /runAffectionProfileBuildApiPreview[\s\S]*?transportPolicy:\s*AFFECTION_TRANSPORT_POLICY\.CONFIGURED/,
  );
  assert.match(
    workflow,
    /regenerateAffectionProfileStages[\s\S]*?transportPolicy:\s*AFFECTION_TRANSPORT_POLICY\.CONFIGURED/,
  );
  // Shared auto entry defaults remain legacy (callers must opt in).
  const autoStart = lifecycle.indexOf('export async function startAffectionProfileBuildsForPending');
  const autoEnd = lifecycle.indexOf('export function markAffectionStoreUpdated', autoStart);
  const autoSection = lifecycle.slice(autoStart, autoEnd > autoStart ? autoEnd : undefined);
  assert.equal(autoSection.includes('AFFECTION_TRANSPORT_POLICY.CONFIGURED'), false);
  assert.match(autoSection, /transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/);

  // commitAffectionUpdateFromConfirmedSummary defaults legacy and forwards transportPolicy.
  assert.match(
    lifecycle,
    /export async function commitAffectionUpdateFromConfirmedSummary[\s\S]*?transportPolicy\s*=\s*AFFECTION_TRANSPORT_POLICY\.LEGACY/,
  );
  assert.match(
    lifecycle,
    /await startAffectionProfileBuildsForPending\(buildPending,\s*\{[\s\S]*?transportPolicy,/,
  );

  const effectsSource = await readFile(
    new URL('../src/features/summary/confirmed-effects.js', import.meta.url),
    'utf8',
  );
  assert.match(
    effectsSource,
    /commitAffectionUpdateFromConfirmedSummary\([\s\S]*?transportPolicy:\s*AFFECTION_TRANSPORT_POLICY\.CONFIGURED/,
  );
});
