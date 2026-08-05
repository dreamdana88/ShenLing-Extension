import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  CHAT_STATE_KEY,
  LONG_FORM_GENERATION_TIMEOUT_MS,
  MODULE_NAME,
} from '../src/constants.js';
import {
  bindMiniTheaterPanelEvents,
  configureMiniTheaterPanel,
  isMiniTheaterPreviewOpen,
  renderMiniTheaterPanel,
  resetMiniTheaterPanelStateForTests,
  runMiniTheaterGeneration,
  THEATER_GENERATION_TIMEOUT_MS,
} from '../src/features/mini-theater/panel.js';

const SECRET = 'sk-theater-stream-secret-never-log';
const secondaryProfile = {
  name: 'Theater Secondary',
  baseUrl: 'https://example.invalid',
  endpointPath: '/v1/chat/completions',
  apiKey: SECRET,
  model: 'theater-model',
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listJavaScriptFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryUrl = new URL(entry.name, directoryUrl);
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(new URL(`${entry.name}/`, directoryUrl)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryUrl);
    }
  }
  return files;
}

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    dataset: { ...(initial.dataset || {}) },
    value: initial.value ?? '',
    classList: {
      contains: () => false,
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatchEvent(type, event = {}) {
      for (const handler of listeners.get(type) || []) {
        handler({
          target: this,
          currentTarget: this,
          preventDefault() {},
          stopPropagation() {},
          ...event,
        });
      }
    },
    click() {
      this.dispatchEvent('click');
    },
  };
}

function createMiniTheaterRoot() {
  const promptInput = createEventTarget({ value: '请生成一段测试小剧场' });
  const generateButton = createEventTarget({ dataset: { theaterGenerate: '1' } });
  const stopButton = createEventTarget({ dataset: { theaterStopGeneration: '1' } });
  const generateTab = createEventTarget({ dataset: { theaterTab: 'generate' } });
  const theaterRoot = {
    querySelector(selector) {
      if (selector === '[data-theater-prompt-text]') return promptInput;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-theater-generate]') return [generateButton];
      if (selector === '[data-theater-stop-generation]') return [stopButton];
      if (selector === '[data-theater-tab]') return [generateTab];
      return [];
    },
  };
  return {
    promptInput,
    generateButton,
    stopButton,
    generateTab,
    root: {
      querySelector(selector) {
        if (selector === '[data-theater-root]') return theaterRoot;
        return null;
      },
    },
  };
}

function createExtensionSettings() {
  return {
    [MODULE_NAME]: {
      api: {
        mode: 'secondary_api',
        activeProfileId: 'default',
        profiles: [{ ...secondaryProfile, id: 'default' }],
      },
      modules: {
        miniTheater: {
          apiMode: 'secondary_api',
          folders: [],
          prompts: [],
          styles: [],
        },
      },
      communicationLog: { maxEntries: 10, entries: [] },
      generation: {
        backgroundStreamingEnabled: true,
      },
    },
  };
}

async function withTheaterHarness({
  apiMode = 'secondary_api',
  tavernHelper,
  fetchImpl,
  generateRaw,
  profile = secondaryProfile,
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
    toastr: globalThis.toastr,
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
        miniTheater: { results: [], lastGeneratedAt: '' },
      },
    },
    chat: [
      { message_id: 0, role: 'user', message: '你好' },
      { message_id: 1, role: 'assistant', message: '你好呀' },
    ],
    names: { userName: '测试用户', characterName: '测试角色' },
    saveSettingsDebounced: () => {},
    saveMetadataDebounced: () => {},
  };
  context.extensionSettings[MODULE_NAME].modules.miniTheater.apiMode = apiMode;

  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
      remove: () => {},
      select: () => {},
      value: '',
    }),
    body: {
      appendChild: () => {},
      removeChild: () => {},
    },
    execCommand: () => true,
  };
  if (!globalThis.performance?.now) {
    globalThis.performance = { now: () => Date.now() };
  }
  globalThis.toastr = {
    info() {},
    success() {},
    warning() {},
    error() {},
  };

  if (tavernHelper) globalThis.TavernHelper = tavernHelper;
  else delete globalThis.TavernHelper;
  if (generateRaw === undefined) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;
  if (fetchImpl === undefined) delete globalThis.fetch;
  else globalThis.fetch = fetchImpl;

  resetMiniTheaterPanelStateForTests();
  configureMiniTheaterPanel({
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => profile,
    refreshPanel: () => {},
  });

  try {
    return await run({ context, logs });
  } finally {
    resetMiniTheaterPanelStateForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

async function waitFor(predicate, { timeoutMs = 1500, intervalMs = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error('waitFor timeout');
}

async function getRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected promise to reject');
}

/** panelState.promptText is private; seed it through the real input binding. */
function seedPromptText(text = '请生成一段测试小剧场') {
  const fixtures = createMiniTheaterRoot();
  bindMiniTheaterPanelEvents(fixtures.root);
  fixtures.promptInput.value = text;
  fixtures.promptInput.dispatchEvent('input', { target: fixtures.promptInput });
  return fixtures;
}

test('mini-theater keeps the shared 300s timeout contract', () => {
  assert.equal(THEATER_GENERATION_TIMEOUT_MS, LONG_FORM_GENERATION_TIMEOUT_MS);
  assert.equal(THEATER_GENERATION_TIMEOUT_MS, 300000);
});

test('user long-form and manual Summary share the transport resolver; confirmed modules do not', async () => {
  const featureFiles = await listJavaScriptFiles(new URL('../src/features/', import.meta.url));
  const allowed = [
    /mini-theater\/panel\.js$/,
    /diary\/panel\.js$/,
    /schedule\/workflow\.js$/,
    /plot-outline\/workflow\.js$/,
    /affection\/workflow\.js$/,
    /affection\/generation\.js$/,
    /memoir\/workflow\.js$/,
    /memoir\/capture-generation\.js$/,
    /summary\/workflow\.js$/,
    /summary\/generation\.js$/,
  ];
  const forbidden = [
    /emotion-profile\//,
    /confirmed-/,
  ];
  const users = [];
  for (const fileUrl of featureFiles) {
    const source = await readFile(fileUrl, 'utf8');
    if (!source.includes('resolveConfiguredGenerationTransport')) continue;
    const path = fileUrl.pathname.replace(/\\/g, '/');
    users.push(path);
    assert.equal(
      allowed.some(pattern => pattern.test(path)),
      true,
      `unexpected transport resolver user: ${path}`,
    );
    assert.equal(
      forbidden.some(pattern => pattern.test(path)),
      false,
      `forbidden path resolved transport: ${path}`,
    );
  }
  assert.ok(users.length >= 7);
});

test('mini-theater main_api uses TavernHelper stream with ordered prompts and never legacy prompt path', async () => {
  let received = null;
  let legacyCalls = 0;
  await withTheaterHarness({
    apiMode: 'main_api',
    tavernHelper: {
      async generateRaw(request) {
        received = request;
        return '纯文字小剧场正文';
      },
      stopGenerationById() {
        return false;
      },
    },
    generateRaw: async () => {
      legacyCalls += 1;
      return 'legacy must not run';
    },
  }, async ({ logs }) => {
    seedPromptText();
    const result = await runMiniTheaterGeneration();
    assert.equal(result.resultContent, '纯文字小剧场正文');
    assert.equal(result.resultType, 'text');
    assert.equal(received.should_stream, true);
    assert.equal(received.should_silence, true);
    assert.match(received.generation_id, /^slx-main-/);
    assert.ok(Array.isArray(received.ordered_prompts));
    assert.ok(received.ordered_prompts.length > 0);
    assert.equal(Object.hasOwn(received, 'prompt'), false);
    assert.equal(legacyCalls, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].responseText, '纯文字小剧场正文');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].transport.source, 'TavernHelper');
    assert.equal(logs[0].transport.generationId, received.generation_id);
    assert.equal(logs[0].transport.firstChunkMs, null);
    assert.equal(logs[0].transport.chunkCount, 0);
    assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
  });
});

test('mini-theater secondary_api uses custom_api stream, strips fences, and never legacy fetch', async () => {
  let received = null;
  let fetchCalls = 0;
  await withTheaterHarness({
    apiMode: 'secondary_api',
    tavernHelper: {
      async generateRaw(request) {
        received = request;
        return '```text\n围栏内正文\n```';
      },
      stopGenerationById() {
        return false;
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('legacy fetch must not run');
    },
  }, async ({ logs }) => {
    seedPromptText();
    const result = await runMiniTheaterGeneration();
    assert.equal(result.resultContent, '围栏内正文');
    assert.equal(received.should_stream, true);
    assert.equal(received.should_silence, true);
    assert.match(received.generation_id, /^slx-secondary-/);
    assert.deepEqual(received.custom_api, {
      apiurl: 'https://example.invalid/v1',
      model: 'theater-model',
      source: 'openai',
      key: SECRET,
    });
    assert.equal(fetchCalls, 0);
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].transport.actualMode, 'stream');
    assert.equal(logs[0].transport.source, 'TavernHelper');
    assert.equal(JSON.stringify(logs[0].requestBody).includes(SECRET), false);
    assert.equal(JSON.stringify(logs[0].transport).includes(SECRET), false);
  });
});

test('mini-theater detects HTML result type after full Promise settlement', async () => {
  await withTheaterHarness({
    apiMode: 'main_api',
    tavernHelper: {
      async generateRaw() {
        return '<div class="scene">HTML 完整结果</div>';
      },
      stopGenerationById() {
        return false;
      },
    },
  }, async ({ logs }) => {
    seedPromptText();
    const result = await runMiniTheaterGeneration();
    assert.equal(result.resultType, 'html');
    assert.match(result.resultContent, /HTML 完整结果/);
    assert.equal(logs[0].parsedResult.resultType, 'html');
    assert.equal(logs[0].transport.mode || logs[0].transport.actualMode, 'stream');
  });
});

test('mini-theater waits for full Promise before opening preview and shows stop while running', async () => {
  const deferred = createDeferred();
  await withTheaterHarness({
    apiMode: 'main_api',
    tavernHelper: {
      generateRaw: () => deferred.promise,
      stopGenerationById: () => false,
    },
  }, async ({ logs }) => {
    let lastHtml = '';
    configureMiniTheaterPanel({
      addCommunicationLog: log => logs.push(log),
      getActiveApiProfile: () => secondaryProfile,
      refreshPanel: () => {
        lastHtml = renderMiniTheaterPanel();
      },
    });
    const { root, promptInput, generateButton, generateTab } = createMiniTheaterRoot();
    bindMiniTheaterPanelEvents(root);
    generateTab.click();
    promptInput.value = '请生成一段测试小剧场';
    promptInput.dispatchEvent('input', { target: promptInput });

    generateButton.click();
    await waitFor(() => lastHtml.includes('生成中'));
    assert.match(lastHtml, /停止生成/);
    assert.match(lastHtml, /data-theater-stop-generation/);
    assert.equal(isMiniTheaterPreviewOpen(), false);
    assert.equal(logs.length, 0);

    deferred.resolve('延迟完整正文');
    await waitFor(() => isMiniTheaterPreviewOpen() === true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].parsedResult.resultContent, '延迟完整正文');
  });
});

test('mini-theater idle and failed templates do not show stop button', async () => {
  await withTheaterHarness({
    apiMode: 'main_api',
    tavernHelper: {
      async generateRaw() {
        return 'ok';
      },
      stopGenerationById() {
        return false;
      },
    },
  }, async () => {
    const idleHtml = renderMiniTheaterPanel();
    assert.equal(idleHtml.includes('data-theater-stop-generation'), false);
  });
});

test('mini-theater user stop cancels exact generationId and keeps prior result without failed UI', async () => {
  let phase = 'prior';
  const cancelDeferred = createDeferred();
  const stoppedIds = [];
  let generationId = '';

  await withTheaterHarness({
    apiMode: 'main_api',
    tavernHelper: {
      generateRaw: request => {
        if (phase === 'prior') {
          return Promise.resolve('保留的旧结果');
        }
        generationId = request.generation_id;
        return cancelDeferred.promise;
      },
      stopGenerationById: id => {
        stoppedIds.push(id);
        cancelDeferred.reject(new DOMException('user abort', 'AbortError'));
        return true;
      },
    },
  }, async ({ logs }) => {
    let lastHtml = '';
    const toasts = [];
    globalThis.toastr = {
      info: message => toasts.push(message),
      success() {},
      warning() {},
      error() {},
    };
    configureMiniTheaterPanel({
      addCommunicationLog: log => logs.push(log),
      getActiveApiProfile: () => secondaryProfile,
      refreshPanel: () => {
        lastHtml = renderMiniTheaterPanel();
      },
    });
    const { root, promptInput, generateButton, stopButton, generateTab } = createMiniTheaterRoot();
    bindMiniTheaterPanelEvents(root);
    generateTab.click();
    promptInput.value = '请生成一段测试小剧场';
    promptInput.dispatchEvent('input', { target: promptInput });

    generateButton.click();
    await waitFor(() => isMiniTheaterPreviewOpen() === true);
    assert.ok(logs.some(log => log.status === 'success'));

    phase = 'cancel';
    generateButton.click();
    await waitFor(() => lastHtml.includes('停止生成'));
    // Wait until Core has actually started generateRaw so stop maps to stopGenerationById.
    await waitFor(() => Boolean(generationId));
    assert.equal(isMiniTheaterPreviewOpen(), false);
    stopButton.click();
    stopButton.click();
    await waitFor(() => logs.some(log => log.errorCode === 'USER_ABORT'));

    assert.deepEqual(stoppedIds, [generationId]);
    assert.match(generationId, /^slx-main-/);
    const abortLog = logs.find(log => log.errorCode === 'USER_ABORT');
    assert.equal(abortLog.errorStage, 'send_request');
    assert.equal(abortLog.transport.abortReason, 'USER_ABORT');
    assert.equal(abortLog.transport.stopRequested, true);
    assert.equal(isMiniTheaterPreviewOpen(), false);
    assert.equal(lastHtml.includes('is-failed'), false);
    assert.ok(toasts.some(message => String(message).includes('已停止')));
    // Prior success remains available via preview button after cancel.
    assert.match(lastHtml, /data-theater-open-preview/);
  });
});

test('mini-theater stream timeout uses TIMEOUT_ABORT and stream timeout copy for main and secondary', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, timeoutMs, ...args) => originalSetTimeout(
    callback,
    timeoutMs === 300000 ? 8 : timeoutMs === 2000 ? 30 : timeoutMs,
    ...args,
  );

  try {
    for (const apiMode of ['main_api', 'secondary_api']) {
      const deferred = createDeferred();
      const stoppedIds = [];
      const abortError = new Error('timeout stopped');
      abortError.name = 'AbortError';
      await withTheaterHarness({
        apiMode,
        tavernHelper: {
          generateRaw: () => deferred.promise,
          stopGenerationById: id => {
            stoppedIds.push(id);
            deferred.reject(abortError);
            return true;
          },
        },
        fetchImpl: async () => {
          throw new Error('legacy fetch must not run');
        },
        generateRaw: async () => {
          throw new Error('legacy main must not run');
        },
      }, async ({ logs }) => {
        seedPromptText();
        const error = await getRejection(runMiniTheaterGeneration());
        assert.equal(error.code, 'TIMEOUT_ABORT');
        assert.match(error.message, /已请求停止后台流式生成/);
        assert.equal(error.message.includes('主 API 生成可能仍在后台继续'), false);
        assert.equal(stoppedIds.length, 1);
        assert.equal(logs[0].errorCode, 'TIMEOUT_ABORT');
        assert.equal(logs[0].transport.abortReason, 'TIMEOUT_ABORT');
        assert.equal(logs[0].transport.stopRequested, true);
        assert.equal(Object.hasOwn(logs[0], 'parsedResult'), false);
      });
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('mini-theater stop settlement timeout ends bounded with stopSettlementTimedOut diagnostics', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  // Only compress feature timeout; keep stop-grace path short but independent of other suite mocks.
  globalThis.setTimeout = (callback, timeoutMs, ...args) => {
    let delayMs = timeoutMs;
    if (timeoutMs === 300000) delayMs = 5;
    else if (timeoutMs === 2000) delayMs = 40;
    return originalSetTimeout(callback, delayMs, ...args);
  };

  try {
    await withTheaterHarness({
      apiMode: 'main_api',
      tavernHelper: {
        generateRaw: () => new Promise(() => {}),
        stopGenerationById: () => true,
      },
    }, async ({ logs }) => {
      seedPromptText();
      const error = await getRejection(runMiniTheaterGeneration());
      assert.equal(error.code, 'TIMEOUT_ABORT');
      assert.equal(logs[0].errorCode, 'TIMEOUT_ABORT');
      assert.equal(logs[0].transport.stopRequested, true);
      assert.equal(logs[0].transport.stopAccepted, true);
      assert.equal(logs[0].transport.stopSettlementTimedOut, true);
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('mini-theater request-front runtime fallback uses legacy once and records fallbackReason', async () => {
  let fetchCalls = 0;
  let legacyMainCalls = 0;
  await withTheaterHarness({
    apiMode: 'secondary_api',
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          choices: [{ message: { content: 'fallback legacy body' } }],
        }),
      };
    },
    generateRaw: async () => {
      legacyMainCalls += 1;
      return 'legacy main';
    },
  }, async ({ logs, context }) => {
    context.extensionSettings[MODULE_NAME].generation = {
      backgroundStreamingEnabled: true,
    };
    seedPromptText();
    const result = await runMiniTheaterGeneration();
    assert.equal(result.resultContent, 'fallback legacy body');
    assert.equal(fetchCalls, 1);
    assert.equal(legacyMainCalls, 0);
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, 'runtime_unavailable');
  });
});

test('mini-theater non-standard endpoint falls back to legacy fetch once', async () => {
  let generateRawCalls = 0;
  let fetchCalls = 0;
  await withTheaterHarness({
    apiMode: 'secondary_api',
    profile: {
      ...secondaryProfile,
      endpointPath: '/custom/chat/completions',
    },
    tavernHelper: {
      generateRaw: async () => {
        generateRawCalls += 1;
        return 'should not stream';
      },
      stopGenerationById: () => false,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'custom endpoint legacy ok',
      };
    },
  }, async ({ logs }) => {
    seedPromptText();
    const result = await runMiniTheaterGeneration();
    assert.equal(result.resultContent, 'custom endpoint legacy ok');
    assert.equal(generateRawCalls, 0);
    assert.equal(fetchCalls, 1);
    assert.equal(logs[0].transport.requestedMode, 'stream');
    assert.equal(logs[0].transport.actualMode, 'legacy');
    assert.equal(logs[0].transport.fallbackReason, 'endpoint_unsupported');
  });
});

test('mini-theater stream provider rejection never retries legacy and logs once', async () => {
  let fetchCalls = 0;
  let legacyMainCalls = 0;
  await withTheaterHarness({
    apiMode: 'main_api',
    tavernHelper: {
      generateRaw: async () => {
        throw new Error('provider exploded');
      },
      stopGenerationById: () => false,
    },
    generateRaw: async () => {
      legacyMainCalls += 1;
      return 'legacy';
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch');
    },
  }, async ({ logs }) => {
    seedPromptText();
    const error = await getRejection(runMiniTheaterGeneration());
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(fetchCalls, 0);
    assert.equal(legacyMainCalls, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].errorCode, 'NETWORK_ERROR');
    assert.equal(logs[0].transport.actualMode, 'stream');
  });
});
