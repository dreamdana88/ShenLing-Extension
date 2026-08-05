import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  isSecondaryEndpointStreamMappable,
} from '../src/core/api.js';
import {
  resolveConfiguredGenerationTransport,
  resetBackgroundStreamingFallbackToastsForTests,
  notifyBackgroundStreamingFallbackOnce,
  generateWithMainApi,
  generateWithSecondaryApi,
} from '../src/core/generation.js';
import {
  defaultGlobalSettings,
  normalizeBackgroundStreamingEnabled,
  normalizeGenerationSettings,
} from '../src/core/settings.js';

function createCapability(status = 'available') {
  if (status !== 'available') {
    return { status, source: '', reason: 'missing' };
  }
  return {
    status: 'available',
    source: 'TavernHelper',
    runtime: {
      generateRaw: async () => 'ok',
      stopGenerationById: () => false,
      events: null,
    },
  };
}

test('background streaming defaults on and preserves explicit false', () => {
  assert.equal(defaultGlobalSettings.generation.backgroundStreamingEnabled, true);
  assert.equal(normalizeBackgroundStreamingEnabled(undefined), true);
  assert.equal(normalizeBackgroundStreamingEnabled(null), true);
  assert.equal(normalizeBackgroundStreamingEnabled('no'), true);
  assert.equal(normalizeBackgroundStreamingEnabled(true), true);
  assert.equal(normalizeBackgroundStreamingEnabled(false), false);

  const migrated = {};
  normalizeGenerationSettings(migrated);
  assert.equal(migrated.generation.backgroundStreamingEnabled, true);

  const closed = { generation: { backgroundStreamingEnabled: false } };
  normalizeGenerationSettings(closed);
  assert.equal(closed.generation.backgroundStreamingEnabled, false);
});

test('transport decision matrix covers setting, runtime and endpoint cases', () => {
  const standardProfile = {
    baseUrl: 'https://example.com',
    endpointPath: '/v1/chat/completions',
    model: 'm',
  };
  const customProfile = {
    baseUrl: 'https://example.com',
    endpointPath: '/custom/chat/completions',
    model: 'm',
  };

  assert.deepEqual(
    resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: false,
      apiMode: 'main_api',
      capability: createCapability('available'),
    }),
    {
      requestedMode: 'legacy',
      actualMode: 'legacy',
      fallbackReason: null,
      apiMode: 'main_api',
    },
  );

  assert.deepEqual(
    resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: true,
      apiMode: 'main_api',
      capability: createCapability('available'),
    }),
    {
      requestedMode: 'stream',
      actualMode: 'stream',
      fallbackReason: null,
      apiMode: 'main_api',
    },
  );

  assert.deepEqual(
    resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: true,
      apiMode: 'secondary_api',
      profile: standardProfile,
      capability: createCapability('available'),
    }),
    {
      requestedMode: 'stream',
      actualMode: 'stream',
      fallbackReason: null,
      apiMode: 'secondary_api',
    },
  );

  assert.deepEqual(
    resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: true,
      apiMode: 'main_api',
      capability: createCapability('unavailable'),
    }),
    {
      requestedMode: 'stream',
      actualMode: 'legacy',
      fallbackReason: 'runtime_unavailable',
      apiMode: 'main_api',
    },
  );

  assert.deepEqual(
    resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: true,
      apiMode: 'secondary_api',
      profile: customProfile,
      capability: createCapability('available'),
    }),
    {
      requestedMode: 'stream',
      actualMode: 'legacy',
      fallbackReason: 'endpoint_unsupported',
      apiMode: 'secondary_api',
    },
  );

  assert.equal(isSecondaryEndpointStreamMappable(standardProfile), true);
  assert.equal(isSecondaryEndpointStreamMappable(customProfile), false);
});

test('transport selector does not call generateRaw or fetch', async () => {
  let generateCalls = 0;
  let fetchCalls = 0;
  const previous = {
    TavernHelper: globalThis.TavernHelper,
    fetch: globalThis.fetch,
  };
  globalThis.TavernHelper = {
    generateRaw: async () => {
      generateCalls += 1;
      return 'x';
    },
    stopGenerationById: () => false,
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: true,
      apiMode: 'secondary_api',
      profile: {
        baseUrl: 'https://example.com',
        endpointPath: '/v1/chat/completions',
      },
      capability: createCapability('available'),
    });
    assert.equal(generateCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    if (previous.TavernHelper === undefined) delete globalThis.TavernHelper;
    else globalThis.TavernHelper = previous.TavernHelper;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
  }
});

test('Core stream remains strict when called with transportMode stream directly', async () => {
  const previous = globalThis.TavernHelper;
  delete globalThis.TavernHelper;
  try {
    await assert.rejects(
      generateWithMainApi({
        messages: [{ role: 'user', content: 'x' }],
        transportMode: 'stream',
      }),
      error => error.code === 'STREAM_UNAVAILABLE',
    );
  } finally {
    if (previous === undefined) delete globalThis.TavernHelper;
    else globalThis.TavernHelper = previous;
  }
});

test('fallback toast fires once per reason in a session', () => {
  resetBackgroundStreamingFallbackToastsForTests();
  const messages = [];
  assert.equal(
    notifyBackgroundStreamingFallbackOnce('runtime_unavailable', message => messages.push(message)),
    true,
  );
  assert.equal(
    notifyBackgroundStreamingFallbackOnce('runtime_unavailable', message => messages.push(message)),
    false,
  );
  assert.equal(messages.length, 1);
  resetBackgroundStreamingFallbackToastsForTests();
});

test('settings UI exposes one unified background streaming toggle', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /后台流式传输（推荐）/);
  assert.match(source, /data-slx-background-streaming/);
  assert.equal((source.match(/data-slx-background-streaming/g) || []).length >= 1, true);
  assert.equal(source.includes('主 API 流式'), false);
  assert.equal(source.includes('副 API 流式开关'), false);
});
