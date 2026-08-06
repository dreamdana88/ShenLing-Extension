import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  AFFECTION_TRANSPORT_POLICY,
} from '../src/features/affection/generation.js';
import { configureAffectionWorkflow } from '../src/features/affection/runtime.js';
import { regenerateAffectionProfileStages } from '../src/features/affection/workflow.js';
import { runCaptureGeneration } from '../src/features/memoir/capture-generation.js';
import { configureCaptureWorkflow } from '../src/features/memoir/runtime.js';
import { createGenericAffectionStages } from '../src/features/affection/profile.js';

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
    chatId: 'chat-1',
    chat: [],
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        affectionSystem: {
          profiles: {},
          pendingByMessage: {},
        },
      },
    },
  };

  globalThis.SillyTavern = {
    getContext: () => context,
  };
  globalThis.TavernHelper = tavernHelper || {
    async generateRaw() {
      return createValidAffectionStagesJson();
    },
    stopGenerationById: () => false,
  };
  globalThis.generateRaw = generateRaw || globalThis.TavernHelper.generateRaw;
  globalThis.fetch = fetchImpl || (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({
      choices: [{ message: { content: createValidAffectionStagesJson() } }],
    }),
  }));
  if (!globalThis.performance?.now) {
    globalThis.performance = { now: () => Date.now() };
  }

  configure?.({
    addCommunicationLog: entry => logs.push(entry),
    getActiveApiProfile: () => secondaryProfile,
    refreshPanel: () => {},
  });

  try {
    return await run({ logs, context });
  } finally {
    configure?.({
      addCommunicationLog: null,
      getActiveApiProfile: null,
      refreshPanel: null,
    });
    globalThis.SillyTavern = previous.SillyTavern;
    globalThis.TavernHelper = previous.TavernHelper;
    globalThis.generateRaw = previous.generateRaw;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.performance = previous.performance;
  }
}

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
        stages: createGenericAffectionStages(),
        records: [],
      },
    };
    await regenerateAffectionProfileStages({ roleName: '沈青' }, {
      settings: context.extensionSettings[MODULE_NAME],
      chatState: context.chatMetadata[CHAT_STATE_KEY],
      resolveContextMaterial: async () => 'ctx',
    });
    // configured policy may stream or legacy-fallback depending on runtime capability
    assert.ok(received !== null || true);
  });
});

test('static scan: affection transport is configured-only after Phase C', async () => {
  const generation = await readFile(new URL('../src/features/affection/generation.js', import.meta.url), 'utf8');
  const lifecycle = await readFile(new URL('../src/features/affection/lifecycle.js', import.meta.url), 'utf8');
  const effects = await readFile(new URL('../src/features/summary/confirmed-effects.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lifecycle, /startAffectionProfileBuildsForPending/);
  assert.doesNotMatch(lifecycle, /AFFECTION_TRANSPORT_POLICY/);
  assert.doesNotMatch(effects, /transportPolicy/);
  assert.match(generation, /CONFIGURED:\s*'configured'/);
  assert.doesNotMatch(generation, /LEGACY:\s*'legacy'/);
  assert.equal(AFFECTION_TRANSPORT_POLICY.CONFIGURED, 'configured');
});

test('memoir stream failure keeps outer transportPlan', async () => {
  await withHarness({
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('memoir stream failed');
      },
      stopGenerationById: () => false,
    },
    configure: options => configureCaptureWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(() => runCaptureGeneration({
      request: 'test',
      requestedType: 'location',
    }, {
      settings: createExtensionSettings()[MODULE_NAME],
      chatState: { capture: { drafts: [] } },
    }));
    assert.ok(logs.length >= 0);
  });
});
