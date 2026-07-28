import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_NAME, CHAT_STATE_KEY } from '../src/constants.js';
import {
  configureScheduleWorkflow,
  runScheduleGeneration,
} from '../src/features/schedule/workflow.js';

const SECRET = 'sk-schedule-timeout-secret-never-log';
const secondaryProfile = {
  name: 'Schedule Secondary',
  baseUrl: 'https://example.invalid/v1',
  endpointPath: '/chat/completions',
  apiKey: SECRET,
  model: 'schedule-model',
};

const MAIN_TIMEOUT_MESSAGE = '日程表生成等待超过 300 秒，已停止等待；主 API 生成可能仍在后台继续。';
const SECONDARY_TIMEOUT_MESSAGE = '日程表生成等待超过 300 秒，副 API 请求已取消，请稍后重试。';
const EXPECTED_TIMEOUT_MS = 300000;

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

function createValidScheduleJson() {
  return JSON.stringify({
    title: '测试七日',
    days: Array.from({ length: 7 }, (_, index) => ({
      theme: `主题${index + 1}`,
      mainOpportunity: `机会${index + 1}`,
      entryOptions: [{ text: `选项${index + 1}` }],
      characterMovements: [{ character: '角色', summary: `行动${index + 1}` }],
    })),
  });
}

function createExtensionSettings(scheduleApiMode = 'secondary_api') {
  return {
    [MODULE_NAME]: {
      api: {
        mode: scheduleApiMode,
        activeProfileId: 'default',
        profiles: [{ id: 'default', ...secondaryProfile }],
      },
      modules: {
        schedule: { apiMode: scheduleApiMode },
      },
    },
  };
}

function createChatMetadata() {
  return {
    [CHAT_STATE_KEY]: {
      identity: {
        characterId: 'c1',
        characterName: '测试角色',
        chatId: 'chat-1',
        chatName: '测试聊天',
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
      summary: {
        archiveRecords: [],
        processedMessageFingerprints: {},
        memoryCountedMessageIds: [],
      },
    },
  };
}

async function withScheduleHarness({
  scheduleApiMode = 'secondary_api',
  generateRaw,
  fetchImpl,
} = {}, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
    window: globalThis.window,
    performance: globalThis.performance,
  };
  const logs = [];
  const context = {
    extensionSettings: createExtensionSettings(scheduleApiMode),
    chatMetadata: createChatMetadata(),
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
  if (!globalThis.performance?.now) {
    globalThis.performance = { now: () => Date.now() };
  }
  if (generateRaw === undefined) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;
  if (fetchImpl === undefined) delete globalThis.fetch;
  else globalThis.fetch = fetchImpl;

  configureScheduleWorkflow({
    addCommunicationLog: log => logs.push(log),
    getActiveApiProfile: () => secondaryProfile,
  });

  try {
    return await run({ context, logs });
  } finally {
    if (previous.SillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous.SillyTavern;
    if (previous.generateRaw === undefined) delete globalThis.generateRaw;
    else globalThis.generateRaw = previous.generateRaw;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    if (previous.performance !== undefined) globalThis.performance = previous.performance;
  }
}

function compressScheduleTimeout(originalSetTimeout, seenTimeouts = []) {
  return (callback, timeoutMs, ...args) => {
    if (Number.isFinite(timeoutMs)) seenTimeouts.push(timeoutMs);
    return originalSetTimeout(
      callback,
      timeoutMs === EXPECTED_TIMEOUT_MS ? 5 : timeoutMs,
      ...args,
    );
  };
}

function assertMainTimeoutMessage(message, { exact = false } = {}) {
  const text = String(message);
  assert.match(text, /超过 300 秒/);
  assert.match(text, /已停止等待/);
  assert.match(text, /主 API.*可能仍在.*继续|主 API 生成可能仍在后台继续/);
  assert.equal(text.includes('请求已取消'), false);
  if (exact) assert.equal(text, MAIN_TIMEOUT_MESSAGE);
}

function assertSecondaryTimeoutMessage(message, { exact = false } = {}) {
  const text = String(message);
  assert.match(text, /超过 300 秒/);
  assert.match(text, /副 API/);
  assert.match(text, /请求已取消/);
  assert.match(text, /稍后重试|请稍后重试/);
  assert.equal(text.includes('可能仍在后台继续'), false);
  assert.equal(text.includes('只是停止等待'), false);
  if (exact) assert.equal(text, SECONDARY_TIMEOUT_MESSAGE);
}

test('Schedule main and secondary generation pass timeoutMs 300000', async () => {
  const seenTimeouts = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = compressScheduleTimeout(originalSetTimeout, seenTimeouts);

  try {
    await withScheduleHarness({
      scheduleApiMode: 'main_api',
      generateRaw: async () => new Promise(() => {}),
    }, async () => {
      await assert.rejects(runScheduleGeneration({ userDirection: '主 API timeoutMs' }));
    });

    await withScheduleHarness({
      scheduleApiMode: 'secondary_api',
      fetchImpl: async () => new Promise(() => {}),
    }, async () => {
      await assert.rejects(runScheduleGeneration({ userDirection: '副 API timeoutMs' }));
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.ok(seenTimeouts.includes(EXPECTED_TIMEOUT_MS));
  assert.equal(seenTimeouts.filter(value => value === EXPECTED_TIMEOUT_MS).length >= 2, true);
  assert.equal(seenTimeouts.includes(180000), false);
});

test('Schedule main API timeout uses wait-only message and MAIN_TIMEOUT diagnostics', async () => {
  const seenTimeouts = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = compressScheduleTimeout(originalSetTimeout, seenTimeouts);

  try {
    await withScheduleHarness({
      scheduleApiMode: 'main_api',
      generateRaw: async () => new Promise(() => {}),
      fetchImpl: async () => {
        throw new Error('secondary must not be called');
      },
    }, async ({ logs }) => {
      await assert.rejects(runScheduleGeneration({ userDirection: '主 API 超时文案' }), error => {
        assert.equal(error.code, 'MAIN_TIMEOUT');
        assert.equal(error.stage, 'send_request');
        assertMainTimeoutMessage(error.message, { exact: true });
        return true;
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, 'failure');
      assert.equal(logs[0].errorCode, 'MAIN_TIMEOUT');
      assert.equal(logs[0].errorStage, 'send_request');
      assertMainTimeoutMessage(logs[0].errorStack);
      assert.ok(Array.isArray(logs[0].messages));
      assert.ok(logs[0].messages.length > 0);
      assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.ok(seenTimeouts.includes(EXPECTED_TIMEOUT_MS));
});

test('Schedule secondary API timeout uses cancel message and SECONDARY_TIMEOUT diagnostics', async () => {
  const seenTimeouts = [];
  const originalSetTimeout = globalThis.setTimeout;
  let fetchSignal = null;
  globalThis.setTimeout = compressScheduleTimeout(originalSetTimeout, seenTimeouts);

  try {
    await withScheduleHarness({
      scheduleApiMode: 'secondary_api',
      generateRaw: async () => {
        throw new Error('main must not be called');
      },
      fetchImpl: async (_url, options) => {
        fetchSignal = options.signal;
        return new Promise(() => {});
      },
    }, async ({ logs }) => {
      await assert.rejects(runScheduleGeneration({ userDirection: '副 API 超时文案' }), error => {
        assert.equal(error.code, 'SECONDARY_TIMEOUT');
        assert.equal(error.stage, 'send_request');
        assertSecondaryTimeoutMessage(error.message, { exact: true });
        return true;
      });
      assert.equal(fetchSignal?.aborted, true);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, 'failure');
      assert.equal(logs[0].errorCode, 'SECONDARY_TIMEOUT');
      assert.equal(logs[0].errorStage, 'send_request');
      assertSecondaryTimeoutMessage(logs[0].errorStack);
      assert.equal(logs[0].profileName, 'Schedule Secondary');
      assert.equal(logs[0].model, 'schedule-model');
      assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
      assert.ok(logs[0].messages.length > 0);
      assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.ok(seenTimeouts.includes(EXPECTED_TIMEOUT_MS));
});

test('Schedule secondary body-stage timeout keeps read_response stage and cancel message', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let fetchSignal = null;
  globalThis.setTimeout = compressScheduleTimeout(originalSetTimeout);

  try {
    await withScheduleHarness({
      scheduleApiMode: 'secondary_api',
      fetchImpl: async (_url, options) => {
        fetchSignal = options.signal;
        return createResponse({
          status: 200,
          text: async () => new Promise(() => {}),
        });
      },
    }, async ({ logs }) => {
      await assert.rejects(runScheduleGeneration({ userDirection: '副 API 正文超时' }), error => {
        assert.equal(error.code, 'SECONDARY_TIMEOUT');
        assert.equal(error.stage, 'read_response');
        assertSecondaryTimeoutMessage(error.message);
        return true;
      });
      assert.equal(fetchSignal?.aborted, true);
      assert.equal(logs[0].errorCode, 'SECONDARY_TIMEOUT');
      assert.equal(logs[0].errorStage, 'read_response');
      assert.equal(logs[0].httpStatus, 200);
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('Schedule main API late success after timeout does not parse or log success', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = compressScheduleTimeout(originalSetTimeout);

  let resolveLate = null;
  const latePromise = new Promise(resolve => {
    resolveLate = resolve;
  });
  const unhandled = [];
  const onUnhandled = reason => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    await withScheduleHarness({
      scheduleApiMode: 'main_api',
      generateRaw: async () => latePromise,
    }, async ({ logs, context }) => {
      await assert.rejects(runScheduleGeneration({ userDirection: '迟到成功' }), error => {
        assert.equal(error.code, 'MAIN_TIMEOUT');
        return true;
      });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].status, 'failure');
      assert.equal(logs[0].errorCode, 'MAIN_TIMEOUT');

      resolveLate(createValidScheduleJson());
      await new Promise(resolve => setTimeout(resolve, 20));

      assert.equal(logs.length, 1);
      assert.equal(logs.some(log => log.status === 'success'), false);
      assert.equal(context.chatMetadata[CHAT_STATE_KEY].schedule.current, null);
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(unhandled, []);
});

test('Schedule main API late failure after timeout has no second failure handling', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = compressScheduleTimeout(originalSetTimeout);

  let rejectLate = null;
  const latePromise = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const unhandled = [];
  const onUnhandled = reason => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    await withScheduleHarness({
      scheduleApiMode: 'main_api',
      generateRaw: async () => latePromise,
    }, async ({ logs }) => {
      await assert.rejects(runScheduleGeneration({ userDirection: '迟到失败' }), error => {
        assert.equal(error.code, 'MAIN_TIMEOUT');
        return true;
      });
      assert.equal(logs.length, 1);

      rejectLate(new Error('late provider failure'));
      await new Promise(resolve => setTimeout(resolve, 20));

      assert.equal(logs.length, 1);
      assert.equal(logs[0].errorCode, 'MAIN_TIMEOUT');
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(unhandled, []);
});

test('Schedule main and secondary success paths keep parser and clean success logs', async () => {
  const scheduleJson = createValidScheduleJson();

  await withScheduleHarness({
    scheduleApiMode: 'main_api',
    generateRaw: async request => {
      assert.ok(Array.isArray(request.prompt));
      assert.ok(request.prompt.length > 0);
      return scheduleJson;
    },
  }, async ({ logs }) => {
    const result = await runScheduleGeneration({ userDirection: '主 API 成功' });
    assert.ok(result.schedule);
    assert.equal(result.schedule.title, '测试七日');
    assert.equal(result.schedule.days.length, 7);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.equal(Object.hasOwn(logs[0], 'errorCode'), false);
    assert.equal(Object.hasOwn(logs[0], 'errorStage'), false);
    assert.ok(logs[0].messages.length > 0);
  });

  await withScheduleHarness({
    scheduleApiMode: 'secondary_api',
    fetchImpl: async () => createResponse({
      body: JSON.stringify({ choices: [{ message: { content: scheduleJson } }] }),
    }),
  }, async ({ logs }) => {
    const result = await runScheduleGeneration({ userDirection: '副 API 成功' });
    assert.ok(result.schedule);
    assert.equal(result.schedule.days.length, 7);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.equal(Object.hasOwn(logs[0], 'errorCode'), false);
    assert.equal(Object.hasOwn(logs[0], 'errorStage'), false);
    assert.equal(logs[0].model, 'schedule-model');
    assert.equal(JSON.stringify(logs[0]).includes(SECRET), false);
  });
});
