import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_NAME, CHAT_STATE_KEY } from '../src/constants.js';
import {
  configureScheduleWorkflow,
  runScheduleGeneration,
} from '../src/features/schedule/workflow.js';
import {
  configureMiniTheaterPanel,
  bindMiniTheaterPanelEvents,
  isMiniTheaterPreviewOpen,
  renderMiniTheaterPanel,
  runMiniTheaterGeneration,
} from '../src/features/mini-theater/panel.js';
import {
  configurePlotOutlineWorkflow,
  runPlotOutlineGeneration,
} from '../src/features/plot-outline/workflow.js';
import {
  configureDiaryPanel,
  bindDiaryPanelEvents,
  runDiaryGeneration,
} from '../src/features/diary/panel.js';
import {
  configureAffectionWorkflow,
  runAffectionProfileBuildApiPreview,
  startAffectionProfileBuildsForPending,
  createGenericAffectionStages,
} from '../src/features/affection/workflow.js';
import {
  configureCaptureWorkflow,
  runCaptureGeneration,
  parseCaptureGenerationResponse,
} from '../src/features/memoir/workflow.js';
import {
  configureSummaryWorkflow,
  generateSummaryMemory,
} from '../src/features/summary/workflow.js';
import { getGenerationErrorContext } from '../src/core/generation.js';

const SECRET = 'sk-feature-failure-secret-never-log';
const secondaryProfile = {
  name: 'Feature Secondary',
  baseUrl: 'https://example.invalid/v1',
  endpointPath: '/chat/completions',
  apiKey: SECRET,
  model: 'feature-model',
};

function createResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  body = '',
  text,
} = {}) {
  return {
    ok,
    status,
    statusText,
    text: text || (async () => body),
  };
}

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
      api: {
        mode: 'secondary_api',
        activeProfileId: 'default',
        profiles: [{ id: 'default', ...secondaryProfile }],
      },
      modules: {
        schedule: { apiMode: 'secondary_api' },
        plotOutline: { apiMode: 'secondary_api' },
        miniTheater: {
          apiMode: 'secondary_api',
          folders: [],
          prompts: [],
          styles: [],
        },
        affection: {
          enabled: true,
          defaultBuildMode: 'custom',
          profileBuildApiMode: 'secondary_api',
        },
        summary: {
          enabled: true,
        },
      },
      ...overrides,
    },
  };
}

function createChatMetadata(overrides = {}) {
  return {
    [CHAT_STATE_KEY]: {
      identity: {
        characterId: 'c1',
        characterName: '测试角色',
        chatId: 'chat-1',
        chatName: '测试聊天',
      },
      diary: {
        books: [],
        entries: [],
        settings: { apiMode: 'secondary' },
      },
      miniTheater: {
        results: [],
      },
      outline: {
        enabled: false,
        userDirection: '',
        storyCore: {},
        chapters: [],
        currentChapterId: '',
        progress: {},
        progressSources: {},
      },
      schedule: {
        current: null,
        lastGeneratedAt: '',
      },
      affectionSystem: {
        profiles: {},
        pendingByMessage: {},
        buildTasks: {},
      },
      memoir: {
        capture: {
          request: '',
          requestedType: 'auto',
          source: {
            mode: 'recent_chat',
            recentCount: 20,
            fromFloor: null,
            toFloor: null,
            summaryId: null,
          },
          optionalContext: {
            includeCharacterCard: false,
            includePersona: false,
            worldbookRefs: [],
          },
          drafts: [],
          lastError: '',
        },
      },
      summary: {
        archiveRecords: [],
        processedMessageFingerprints: {},
        memoryCountedMessageIds: [],
      },
      ...overrides,
    },
  };
}

async function withHarness({
  mode = 'secondary_api',
  extensionSettings,
  chatMetadata,
  generateRaw,
  fetchImpl,
  configure,
} = {}, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
  };
  const logs = [];
  const resolvedSettings = extensionSettings || createExtensionSettings();
  if (!extensionSettings) {
    resolvedSettings[MODULE_NAME].api.mode = mode;
  }
  const context = {
    extensionSettings: resolvedSettings,
    chatMetadata: chatMetadata || createChatMetadata(),
    name1: '测试用户',
    name2: '测试角色',
    characterId: 'c1',
    chatId: 'chat-1',
    chat: [],
    saveSettingsDebounced: () => {},
    saveMetadataDebounced: () => {},
  };

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
  if (generateRaw === undefined) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;
  if (fetchImpl === undefined) delete globalThis.fetch;
  else globalThis.fetch = fetchImpl;

  const sharedOptions = {
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => secondaryProfile,
    getApiSettings: () => ({ mode }),
    refreshPanel: () => {},
    refreshSummaryPanel: () => {},
  };
  configure?.(sharedOptions, context, logs);

  try {
    return await run({ context, logs, sharedOptions });
  } finally {
    if (previous.SillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous.SillyTavern;
    if (previous.generateRaw === undefined) delete globalThis.generateRaw;
    else globalThis.generateRaw = previous.generateRaw;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.performance !== undefined) globalThis.performance = previous.performance;
  }
}

function assertNoSecret(value) {
  assert.equal(JSON.stringify(value).includes(SECRET), false);
}

function assertTransportFailureLog(log, {
  code,
  stage,
  hasMessages = true,
} = {}) {
  assert.equal(log.status, 'failure');
  assert.equal(log.errorCode, code);
  assert.equal(log.errorStage, stage);
  if (hasMessages) {
    assert.ok(Array.isArray(log.messages));
    assert.ok(log.messages.length > 0, 'failure log should keep request messages');
  }
  assertNoSecret(log);
  assert.equal(Object.hasOwn(log, 'diagnostics'), false);
  assert.equal(Object.hasOwn(log, 'cause'), false);
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
  const generateTab = createEventTarget({ dataset: { theaterTab: 'generate' } });
  const theaterRoot = {
    querySelector(selector) {
      if (selector === '[data-theater-prompt-text]') return promptInput;
      if (selector === '[data-theater-clear-source]') return null;
      if (selector === '[data-theater-pick-prompt]') return null;
      if (selector === '[data-theater-pick-style]') return null;
      if (selector === '[data-theater-prompt-search]') return null;
      if (selector === '[data-theater-sort]') return null;
      if (selector === '[data-theater-new-folder]') return null;
      if (selector === '[data-theater-delete-folder]') return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-theater-generate]') return [generateButton];
      if (selector === '[data-theater-tab]') return [generateTab];
      return [];
    },
  };
  return {
    promptInput,
    generateButton,
    generateTab,
    root: {
      querySelector(selector) {
        if (selector === '[data-theater-root]') return theaterRoot;
        return null;
      },
    },
  };
}

function createDiaryRoot() {
  const roleInput = createEventTarget({ value: '测试角色' });
  const dateInput = createEventTarget({ value: '第1天' });
  const userContent = createEventTarget({ value: '' });
  const generateButton = createEventTarget({ dataset: { slxCreateUnifiedDiaryDraft: '1' } });
  return {
    generateButton,
    root: {
      addEventListener() {},
      querySelector(selector) {
        if (selector === '[data-slx-diary-compose-role]') return roleInput;
        if (selector === '[data-slx-diary-compose-date]') return dateInput;
        if (selector === '[data-slx-diary-compose-user-content]') return userContent;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-slx-create-unified-diary-draft]') return [generateButton];
        return [];
      },
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

// ── Schedule ──────────────────────────────────────────────────────────

test('Schedule secondary fetch failure enriches failure log and rethrows original transport error', async () => {
  const fetchFailure = new Error('network down');
  await withHarness({
    fetchImpl: async () => { throw fetchFailure; },
    configure: options => configureScheduleWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(runScheduleGeneration({ userDirection: '测试方向' }), error => {
      assert.equal(error.name, 'GenerationTransportError');
      assert.equal(error.code, 'SECONDARY_FETCH_FAILED');
      assert.equal(error.stage, 'send_request');
      assert.equal(error.cause, fetchFailure);
      return true;
    });
    assert.equal(logs.length, 1);
    assertTransportFailureLog(logs[0], {
      code: 'SECONDARY_FETCH_FAILED',
      stage: 'send_request',
    });
    assert.equal(logs[0].moduleName, '日程表 / 副 API');
    assert.equal(logs[0].model, 'feature-model');
    assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
    assert.ok(logs[0].requestBody?.contextDiagnostics);
    assert.equal(logs[0].requestBody.contextDiagnostics.purpose, 'schedule');
  });
});

test('Schedule secondary body timeout keeps Phase 4E-2B failure diagnostics', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let fetchSignal = null;
  globalThis.setTimeout = (callback, timeoutMs, ...args) => originalSetTimeout(
    callback,
    timeoutMs === 300000 ? 5 : timeoutMs,
    ...args,
  );

  try {
    await withHarness({
      fetchImpl: async (_url, options) => {
        fetchSignal = options.signal;
        return createResponse({
          status: 200,
          text: async () => new Promise(() => {}),
        });
      },
      configure: options => configureScheduleWorkflow(options),
    }, async ({ logs }) => {
      await assert.rejects(
        runScheduleGeneration({ userDirection: '正文超时日志' }),
        error => {
          assert.equal(error.code, 'SECONDARY_TIMEOUT');
          assert.equal(error.stage, 'read_response');
          return true;
        },
      );
      assert.equal(fetchSignal.aborted, true);
      assert.equal(logs.length, 1);
      assertTransportFailureLog(logs[0], {
        code: 'SECONDARY_TIMEOUT',
        stage: 'read_response',
      });
      assert.equal(logs[0].profileName, 'Feature Secondary');
      assert.equal(logs[0].model, 'feature-model');
      assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
      assert.equal(logs[0].httpStatus, 200);
      assert.ok(Number.isFinite(logs[0].durationMs));
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('Schedule success path does not write errorCode or errorStage', async () => {
  const scheduleJson = JSON.stringify({
    title: '测试七日',
    days: Array.from({ length: 7 }, (_, index) => ({
      theme: `主题${index + 1}`,
      mainOpportunity: `机会${index + 1}`,
      entryOptions: [{ text: `选项${index + 1}` }],
      characterMovements: [{ character: '角色', summary: `行动${index + 1}` }],
    })),
  });
  await withHarness({
    fetchImpl: async () => createResponse({
      body: JSON.stringify({ choices: [{ message: { content: scheduleJson } }] }),
    }),
    configure: options => configureScheduleWorkflow(options),
  }, async ({ logs }) => {
    const result = await runScheduleGeneration({ userDirection: '成功路径' });
    assert.ok(result.schedule);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.equal(Object.hasOwn(logs[0], 'errorCode'), false);
    assert.equal(Object.hasOwn(logs[0], 'errorStage'), false);
  });
});

// ── Mini Theater ──────────────────────────────────────────────────────

test('Mini Theater secondary stream provider failure enriches failure log and keeps failed UI semantics', async () => {
  const previousTavernHelper = globalThis.TavernHelper;
  globalThis.TavernHelper = {
    async generateRaw() {
      throw new Error('HTTP 429 Too Many Requests: slow down');
    },
    stopGenerationById() {
      return false;
    },
  };

  try {
    await withHarness({
      fetchImpl: async () => {
        throw new Error('legacy fetch must not run for mini-theater stream');
      },
      configure: options => configureMiniTheaterPanel(options),
    }, async ({ logs, context }) => {
      context.extensionSettings[MODULE_NAME].modules.miniTheater.apiMode = 'secondary_api';
      const { root, promptInput, generateButton, generateTab } = createMiniTheaterRoot();
      bindMiniTheaterPanelEvents(root);
      promptInput.dispatchEvent('input', { target: promptInput });
      generateButton.click();
      await waitFor(() => logs.length === 1);
      assertTransportFailureLog(logs[0], {
        code: 'NETWORK_ERROR',
        stage: 'send_request',
      });
      assert.match(String(logs[0].errorStack || ''), /429|slow down/i);
      assert.equal(logs[0].transport?.actualMode, 'stream');
      assert.ok(logs[0].requestBody?.contextDiagnostics);
      assert.equal(logs[0].requestBody.contextDiagnostics.purpose, 'miniTheater');
      assert.ok(Object.hasOwn(logs[0].requestBody, 'selectedStyle'));
      generateTab.click();
      const html = renderMiniTheaterPanel();
      assert.match(html, /is-failed/);
      assert.equal(isMiniTheaterPreviewOpen(), false);
    });
  } finally {
    if (previousTavernHelper === undefined) delete globalThis.TavernHelper;
    else globalThis.TavernHelper = previousTavernHelper;
  }
});

// ── Plot Outline ──────────────────────────────────────────────────────

test('Plot Outline secondary URL build failure keeps messages and context diagnostics', async () => {
  const badProfile = {
    ...secondaryProfile,
    baseUrl: '',
  };
  await withHarness({
    configure: options => configurePlotOutlineWorkflow({
      ...options,
      getActiveApiProfile: () => badProfile,
    }),
  }, async ({ logs }) => {
    await assert.rejects(runPlotOutlineGeneration({ userDirection: '剧情测试' }), error => {
      assert.equal(error.code, 'SECONDARY_URL_BUILD_FAILED');
      assert.equal(error.stage, 'build_request');
      return true;
    });
    assert.equal(logs.length, 1);
    assertTransportFailureLog(logs[0], {
      code: 'SECONDARY_URL_BUILD_FAILED',
      stage: 'build_request',
    });
    assert.ok(logs[0].requestBody?.contextDiagnostics);
    assert.equal(logs[0].requestBody.contextDiagnostics.purpose, 'plotOutline');
    assert.equal(logs[0].model, 'feature-model');
    assert.ok(logs[0].messages.length > 0);
  });
});

// ── Diary ─────────────────────────────────────────────────────────────

test('Diary secondary body-read failure enriches failure log without running parser', async () => {
  await withHarness({
    fetchImpl: async () => createResponse({
      status: 200,
      text: async () => {
        throw new Error('body unreadable');
      },
    }),
    configure: options => configureDiaryPanel(options),
  }, async ({ logs, context }) => {
    context.chatMetadata[CHAT_STATE_KEY].diary.settings = { apiMode: 'secondary' };
    const { root, generateButton } = createDiaryRoot();
    bindDiaryPanelEvents(root);
    generateButton.click();
    await waitFor(() => logs.length === 1);
    assertTransportFailureLog(logs[0], {
      code: 'SECONDARY_BODY_READ_FAILED',
      stage: 'read_response',
    });
    assert.equal(logs[0].moduleName, '日程日记 / 副 API');
    assert.equal(logs[0].profileName, 'Feature Secondary');
    assert.equal(logs[0].model, 'feature-model');
    assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
    assert.equal(logs[0].requestBody, null);
  });
});

// ── Affection ─────────────────────────────────────────────────────────

test('Affection keeps constructed messages when Core fails before returning apiResult', async () => {
  const fetchFailure = new Error('affection fetch failed');
  await withHarness({
    fetchImpl: async () => { throw fetchFailure; },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    const chatState = context.chatMetadata[CHAT_STATE_KEY];
    chatState.affectionSystem = {
      profiles: {},
      pendingByMessage: {},
      buildTasks: {},
    };
    context.extensionSettings[MODULE_NAME].modules.affection = {
      enabled: true,
      defaultBuildMode: 'custom',
      profileBuildApiMode: 'secondary_api',
    };

    const tasks = await startAffectionProfileBuildsForPending({
      messageId: 3,
      fingerprint: 'fp-affection-1',
      firsts: [{ roleName: '测试角色', initialValueTenths: 100 }],
    }, {
      settings: context.extensionSettings[MODULE_NAME],
      chatState,
      chatId: 'chat-1',
      persist: false,
      force: true,
      getCurrentSnapshot: () => ({
        chatId: 'chat-1',
        fingerprint: 'fp-affection-1',
        active: true,
      }),
      getCurrentChatState: () => chatState,
      resolveContextMaterial: async () => 'affection-context',
      log: true,
    });

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].buildStatus, 'error');
    assert.equal(logs.length, 1);
    assertTransportFailureLog(logs[0], {
      code: 'SECONDARY_FETCH_FAILED',
      stage: 'send_request',
    });
    assert.ok(logs[0].messages.length > 0);
    assert.equal(logs[0].model, 'feature-model');
    assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
    // Automatic pending builds must force legacy even when global streaming is on.
    assert.equal(logs[0].transport?.requestedMode, 'legacy');
    assert.equal(logs[0].transport?.actualMode, 'legacy');
    assert.equal(logs[0].transport?.fallbackReason, null);
  });
});

test('Affection generic mode does not call the model and custom inject is preserved', async () => {
  let fetchCalls = 0;
  let customCalls = 0;
  await withHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return createResponse({
        body: JSON.stringify({ choices: [{ message: { content: createValidAffectionStagesJson() } }] }),
      });
    },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs, context }) => {
    const chatState = context.chatMetadata[CHAT_STATE_KEY];
    context.extensionSettings[MODULE_NAME].modules.affection = {
      enabled: true,
      defaultBuildMode: 'generic',
      profileBuildApiMode: 'secondary_api',
    };

    const genericTasks = await startAffectionProfileBuildsForPending({
      messageId: 4,
      fingerprint: 'fp-generic',
      firsts: [{ roleName: '通用角色', initialValueTenths: 200 }],
    }, {
      settings: context.extensionSettings[MODULE_NAME],
      chatState,
      chatId: 'chat-1',
      persist: false,
      force: true,
      getCurrentSnapshot: () => ({
        chatId: 'chat-1',
        fingerprint: 'fp-generic',
        active: true,
      }),
      getCurrentChatState: () => chatState,
      log: true,
    });
    assert.equal(genericTasks[0].buildStatus, 'ready');
    assert.equal(fetchCalls, 0);
    assert.deepEqual(
      genericTasks[0].stages.map(stage => stage.stageId),
      createGenericAffectionStages().map(stage => stage.stageId),
    );

    context.extensionSettings[MODULE_NAME].modules.affection.defaultBuildMode = 'custom';
    const customTasks = await startAffectionProfileBuildsForPending({
      messageId: 5,
      fingerprint: 'fp-custom',
      firsts: [{ roleName: '注入角色', initialValueTenths: 300 }],
    }, {
      settings: context.extensionSettings[MODULE_NAME],
      chatState,
      chatId: 'chat-1',
      persist: false,
      force: true,
      getCurrentSnapshot: () => ({
        chatId: 'chat-1',
        fingerprint: 'fp-custom',
        active: true,
      }),
      getCurrentChatState: () => chatState,
      requestCustomProfile: async ({ messages }) => {
        customCalls += 1;
        assert.ok(Array.isArray(messages));
        assert.ok(messages.length > 0);
        return {
          rawContent: createValidAffectionStagesJson(),
          profileName: 'custom-inject',
          model: 'custom-model',
          url: 'custom://inject',
          httpStatus: 200,
          responseText: createValidAffectionStagesJson(),
          requestBody: { injected: true },
        };
      },
      resolveContextMaterial: async () => 'custom-context',
      log: true,
    });
    assert.equal(customTasks[0].buildStatus, 'ready');
    assert.equal(customCalls, 1);
    assert.equal(fetchCalls, 0);
    const customLog = logs.find(log => log.taskType === '专属阶段表预建档' && log.status === 'success');
    assert.ok(customLog);
    assert.equal(customLog.profileName, 'custom-inject');
    assert.equal(Object.hasOwn(customLog, 'errorCode'), false);
  });
});

test('Affection preview rethrows transport error with non-empty messages', async () => {
  await withHarness({
    fetchImpl: async () => { throw new Error('preview fail'); },
    configure: options => configureAffectionWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(
      runAffectionProfileBuildApiPreview({ roleName: '预览角色', initialValueTenths: 15 }),
      error => {
        assert.equal(error.code, 'SECONDARY_FETCH_FAILED');
        return true;
      },
    );
    assert.equal(logs[0].status, 'failure');
    assert.ok(logs[0].messages.length > 0);
    assert.equal(logs[0].errorCode, 'SECONDARY_FETCH_FAILED');
  });
});

// ── Memoir Capture ────────────────────────────────────────────────────

test('Memoir Capture HTTP 500 keeps prepared messages and safe responseText', async () => {
  await withHarness({
    fetchImpl: async () => createResponse({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: `{"error":"boom","apiKey":"${SECRET}"}`,
    }),
    configure: options => configureCaptureWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(runCaptureGeneration({
      captureState: {
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
      },
      materialOptions: {
        messages: [
          { message_id: 0, role: 'user', message: '我们到了山脚。' },
          { message_id: 1, role: 'assistant', message: '庙门半掩。' },
        ],
        names: { userName: '测试用户', characterName: '测试角色' },
      },
      apiMode: 'secondary_api',
      persist: false,
    }), error => {
      assert.equal(error.code, 'SECONDARY_HTTP_ERROR');
      return true;
    });
    assert.equal(logs.length, 1);
    assertTransportFailureLog(logs[0], {
      code: 'SECONDARY_HTTP_ERROR',
      stage: 'read_response',
    });
    assert.equal(logs[0].httpStatus, 500);
    assert.match(String(logs[0].responseText || ''), /boom|error/i);
    assert.equal(String(logs[0].responseText || '').includes(SECRET), false);
  });
});

test('Memoir Capture preflight and parser errors stay Feature Errors without transport codes', async () => {
  await withHarness({
    fetchImpl: async () => {
      throw new Error('should not fetch on preflight failure');
    },
    configure: options => configureCaptureWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(runCaptureGeneration({
      captureState: {
        request: '',
        requestedType: 'npc',
        source: { mode: 'recent_chat', recentCount: 20 },
        optionalContext: {
          includeCharacterCard: false,
          includePersona: false,
          worldbookRefs: [],
        },
        drafts: [],
        lastError: '',
      },
      apiMode: 'secondary_api',
      persist: false,
    }), error => {
      assert.equal(error.name, 'CapturePreflightError');
      assert.equal(getGenerationErrorContext(error), null);
      return true;
    });
    assert.equal(logs[0].errorCode, '');
    assert.equal(logs[0].errorStage, '');
  });

  await withHarness({
    fetchImpl: async () => createResponse({
      body: JSON.stringify({ choices: [{ message: { content: 'not-json-at-all' } }] }),
    }),
    configure: options => configureCaptureWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(runCaptureGeneration({
      captureState: {
        request: '采集 NPC',
        requestedType: 'npc',
        source: { mode: 'recent_chat', recentCount: 20 },
        optionalContext: {
          includeCharacterCard: false,
          includePersona: false,
          worldbookRefs: [],
        },
        drafts: [],
        lastError: '',
      },
      materialOptions: {
        messages: [
          { message_id: 0, role: 'user', message: '你好' },
          { message_id: 1, role: 'assistant', message: '你好啊' },
        ],
      },
      apiMode: 'secondary_api',
      persist: false,
    }), error => {
      assert.equal(error.name, 'CaptureParseError');
      assert.equal(getGenerationErrorContext(error), null);
      return true;
    });
    assert.equal(logs[0].errorCode, '');
    assert.equal(logs[0].errorStage, '');
    assert.ok(logs[0].messages.length > 0);
    const parsed = parseCaptureGenerationResponse('not-json-at-all');
    assert.equal(parsed.ok, false);
  });
});

// ── Summary ───────────────────────────────────────────────────────────

test('Summary main provider failure logs MAIN_PROVIDER_FAILED without secondary fallback', async () => {
  const mainFailure = new Error('main provider failed');
  let secondaryCalls = 0;
  await withHarness({
    mode: 'main_api',
    generateRaw: async () => { throw mainFailure; },
    fetchImpl: async () => {
      secondaryCalls += 1;
      return createResponse();
    },
    configure: options => configureSummaryWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(generateSummaryMemory('main failure', { type: '主 API 失败日志' }), error => {
      assert.equal(error.code, 'MAIN_PROVIDER_FAILED');
      assert.equal(error.stage, 'send_request');
      assert.equal(error.cause, mainFailure);
      return true;
    });
    assert.equal(secondaryCalls, 0);
    assertTransportFailureLog(logs[0], {
      code: 'MAIN_PROVIDER_FAILED',
      stage: 'send_request',
    });
    assert.equal(logs[0].taskType, '主 API 失败日志');
    assert.ok(logs[0].messages.length > 0);
  });
});

test('Summary secondary HTTP error enriches failure log; content is authoritative over responseJson', async () => {
  let mainCalls = 0;
  await withHarness({
    mode: 'secondary_api',
    generateRaw: async () => {
      mainCalls += 1;
      return 'unexpected';
    },
    fetchImpl: async () => createResponse({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      body: '{"error":"unavailable"}',
    }),
    configure: options => configureSummaryWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(generateSummaryMemory('secondary http', { type: '副 API HTTP' }), error => {
      assert.equal(error.code, 'SECONDARY_HTTP_ERROR');
      return true;
    });
    assert.equal(mainCalls, 0);
    assertTransportFailureLog(logs[0], {
      code: 'SECONDARY_HTTP_ERROR',
      stage: 'read_response',
    });
    assert.equal(logs[0].httpStatus, 503);
  });

  // S3-B: non-JSON body with non-empty content is accepted (stream-compatible content contract).
  await withHarness({
    mode: 'secondary_api',
    fetchImpl: async () => createResponse({ body: 'plain text summary body' }),
    configure: options => configureSummaryWorkflow(options),
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('non-json content');
    assert.equal(result, 'plain text summary body');
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
    assert.ok(logs[0].messages.length > 0);
  });
});

test('Summary success path remains free of errorCode and errorStage', async () => {
  await withHarness({
    mode: 'main_api',
    generateRaw: async () => '  <memory>成功</memory>\n',
    configure: options => configureSummaryWorkflow(options),
  }, async ({ logs }) => {
    const result = await generateSummaryMemory('success', { type: '成功日志' });
    assert.equal(result, '<memory>成功</memory>');
    assert.equal(logs[0].status, 'success');
    assert.equal(Object.hasOwn(logs[0], 'errorCode'), false);
    assert.equal(Object.hasOwn(logs[0], 'errorStage'), false);
  });
});

// ── Ordinary Feature Errors across Features ───────────────────────────

test('Schedule and Summary ordinary Feature Errors keep empty transport codes', async () => {
  await withHarness({
    fetchImpl: async () => createResponse({
      body: JSON.stringify({ choices: [{ message: { content: '这不是 JSON 日程表' } }] }),
    }),
    configure: options => configureScheduleWorkflow(options),
  }, async ({ logs }) => {
    await assert.rejects(runScheduleGeneration({ userDirection: 'parser fail' }), /合法 JSON|不是合法 JSON/);
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].errorCode, '');
    assert.equal(logs[0].errorStage, '');
    assert.ok(logs[0].messages.length > 0);
  });

  await withHarness({
    mode: 'secondary_api',
    fetchImpl: async () => createResponse({
      body: JSON.stringify({ choices: [{ message: { content: '' } }] }),
    }),
    configure: options => configureSummaryWorkflow(options),
  }, async ({ logs }) => {
    // empty content is still a Transport Error (SECONDARY_CONTENT_MISSING) from Core.
    // Use the Feature-layer non-JSON rejection path already covered above for ordinary Feature Error.
    await assert.rejects(generateSummaryMemory('empty content'));
    // Confirm log still recorded and not swallowed.
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'failure');
  });
});

async function withCompressedLongFormTimeout(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const seenTimeouts = [];
  globalThis.setTimeout = (callback, timeoutMs, ...args) => originalSetTimeout(
    callback,
    (seenTimeouts.push(timeoutMs), timeoutMs === 300000 ? 5 : timeoutMs),
    ...args,
  );
  try {
    return await run(seenTimeouts);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

function createCaptureTimeoutInput() {
  return {
    captureState: {
      request: '采集一座山神庙',
      requestedType: 'location',
      source: { mode: 'recent_chat', recentCount: 20 },
      optionalContext: {
        includeCharacterCard: false,
        includePersona: false,
        worldbookRefs: [],
      },
      drafts: [],
      lastError: '',
    },
    materialOptions: {
      messages: [
        { message_id: 0, role: 'user', message: '我们到了山脚。' },
        { message_id: 1, role: 'assistant', message: '庙门半掩。' },
      ],
      names: { userName: '测试用户', characterName: '测试角色' },
    },
    persist: false,
  };
}

test('Mini Theater main and secondary stream calls pass the shared 300-second timeout to Core', async () => {
  for (const mode of ['main_api', 'secondary_api']) {
    await withCompressedLongFormTimeout(async seenTimeouts => {
      let settleReject = null;
      const previousTavernHelper = globalThis.TavernHelper;
      globalThis.TavernHelper = {
        generateRaw: () => new Promise((_resolve, reject) => {
          settleReject = reject;
        }),
        stopGenerationById: () => {
          settleReject?.(new DOMException('stream timeout stopped', 'AbortError'));
          return true;
        },
      };
      try {
        await withHarness({
          mode,
          generateRaw: async () => {
            throw new Error('legacy main generateRaw must not run for mini-theater stream');
          },
          fetchImpl: async () => {
            throw new Error('legacy fetch must not run for mini-theater stream');
          },
          configure: options => configureMiniTheaterPanel(options),
        }, async ({ context }) => {
          context.extensionSettings[MODULE_NAME].modules.miniTheater.apiMode = mode;
          const { root, promptInput } = createMiniTheaterRoot();
          bindMiniTheaterPanelEvents(root);
          promptInput.dispatchEvent('input', { target: promptInput });
          await assert.rejects(runMiniTheaterGeneration(), error => {
            assert.equal(error.code, 'TIMEOUT_ABORT');
            assert.match(error.message, /已请求停止后台流式生成/);
            assert.equal(error.message.includes('主 API 生成可能仍在后台继续'), false);
            return true;
          });
        });
        assert.ok(seenTimeouts.includes(300000));
      } finally {
        if (previousTavernHelper === undefined) delete globalThis.TavernHelper;
        else globalThis.TavernHelper = previousTavernHelper;
      }
    });
  }
});

test('Plot Outline main and secondary calls pass the shared 300-second timeout to Core', async () => {
  for (const mode of ['main_api', 'secondary_api']) {
    await withCompressedLongFormTimeout(async seenTimeouts => {
      await withHarness({
        mode,
        generateRaw: mode === 'main_api' ? async () => new Promise(() => {}) : undefined,
        fetchImpl: mode === 'secondary_api' ? async () => new Promise(() => {}) : undefined,
        configure: options => configurePlotOutlineWorkflow(options),
      }, async ({ context }) => {
        context.extensionSettings[MODULE_NAME].modules.plotOutline.apiMode = mode;
        await assert.rejects(
          runPlotOutlineGeneration({ userDirection: '剧情大纲超时合同' }),
          error => {
            assert.equal(error.code, mode === 'main_api' ? 'MAIN_TIMEOUT' : 'SECONDARY_TIMEOUT');
            return true;
          },
        );
      });
      assert.ok(seenTimeouts.includes(300000));
    });
  }
});

test('Diary main and secondary calls pass the shared 300-second timeout to Core', async () => {
  for (const mode of ['main', 'secondary']) {
    await withCompressedLongFormTimeout(async seenTimeouts => {
      await withHarness({
        mode: mode === 'main' ? 'main_api' : 'secondary_api',
        generateRaw: mode === 'main' ? async () => new Promise(() => {}) : undefined,
        fetchImpl: mode === 'secondary' ? async () => new Promise(() => {}) : undefined,
        configure: options => configureDiaryPanel(options),
      }, async ({ context }) => {
        context.chatMetadata[CHAT_STATE_KEY].diary.settings = { apiMode: mode };
        await assert.rejects(
          runDiaryGeneration({
            messages: [{ role: 'user', content: '日记超时合同' }],
            taskType: '日记超时合同',
            fallbackDate: '第1天',
          }),
          error => {
            assert.equal(error.code, mode === 'main' ? 'MAIN_TIMEOUT' : 'SECONDARY_TIMEOUT');
            return true;
          },
        );
      });
      assert.ok(seenTimeouts.includes(300000));
    });
  }
});

test('Affection profile build main and secondary calls pass the shared 300-second timeout to Core', async () => {
  for (const mode of ['main_api', 'secondary_api']) {
    await withCompressedLongFormTimeout(async seenTimeouts => {
      await withHarness({
        mode,
        generateRaw: mode === 'main_api' ? async () => new Promise(() => {}) : undefined,
        fetchImpl: mode === 'secondary_api' ? async () => new Promise(() => {}) : undefined,
        configure: options => configureAffectionWorkflow(options),
      }, async ({ context }) => {
        context.extensionSettings[MODULE_NAME].modules.affection.profileBuildApiMode = mode;
        await assert.rejects(
          runAffectionProfileBuildApiPreview({ roleName: '超时角色', initialValueTenths: 100 }),
          error => {
            assert.equal(error.code, mode === 'main_api' ? 'MAIN_TIMEOUT' : 'SECONDARY_TIMEOUT');
            return true;
          },
        );
      });
      assert.ok(seenTimeouts.includes(300000));
    });
  }
});

test('Memoir Capture main and secondary calls pass the shared 300-second timeout to Core', async () => {
  for (const mode of ['main_api', 'secondary_api']) {
    await withCompressedLongFormTimeout(async seenTimeouts => {
      await withHarness({
        mode,
        generateRaw: mode === 'main_api' ? async () => new Promise(() => {}) : undefined,
        fetchImpl: mode === 'secondary_api' ? async () => new Promise(() => {}) : undefined,
        configure: options => configureCaptureWorkflow(options),
      }, async () => {
        await assert.rejects(
          runCaptureGeneration({ ...createCaptureTimeoutInput(), apiMode: mode }),
          error => {
            assert.equal(error.code, mode === 'main_api' ? 'MAIN_TIMEOUT' : 'SECONDARY_TIMEOUT');
            return true;
          },
        );
      });
      assert.ok(seenTimeouts.includes(300000));
    });
  }
});
