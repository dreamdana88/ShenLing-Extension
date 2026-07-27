import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureSummaryWorkflow,
  generateSummaryMemory,
} from '../src/features/summary/workflow.js';

const profile = {
  name: 'Summary Secondary',
  baseUrl: 'https://example.invalid/v1',
  endpointPath: '/chat/completions',
  apiKey: 'test-secret-key',
  model: 'summary-model',
};

function createResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

async function withSummaryHarness({ mode = 'main_api', activeProfile = profile, generateRaw, fetch } = {}, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
    window: globalThis.window,
  };
  const logs = [];
  const context = {
    extensionSettings: {},
    name1: '测试用户',
    name2: '测试角色',
  };

  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
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
    if (previous.SillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous.SillyTavern;
    if (previous.generateRaw === undefined) delete globalThis.generateRaw;
    else globalThis.generateRaw = previous.generateRaw;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
  }
}

test('Summary main API preserves prompt messages, trim result, log fields, and prompt contract', async () => {
  let requestBody = null;
  await withSummaryHarness({
    generateRaw: async request => {
      requestBody = request;
      return '  <memory>主 API 结果</memory>\n';
    },
  }, async ({ logs }) => {
    const result = await generateSummaryMemory({
      __shenlingPromptBundle: true,
      systemContent: '系统 {{char}}',
      userContent: '用户 {{user}}',
    }, { type: '主 API 隔离测试' });

    assert.equal(result, '<memory>主 API 结果</memory>');
    assert.deepEqual(requestBody.prompt, logs[0].messages);
    assert.equal(requestBody.prompt.at(-2).content, '系统 测试角色');
    assert.equal(requestBody.prompt.at(-1).content, '用户 测试用户');
    assert.equal(logs[0].moduleName, '自动总结 / 主 API');
    assert.equal(logs[0].taskType, '主 API 隔离测试');
    assert.equal(logs[0].requestBody, requestBody);
    assert.equal(logs[0].responseText, '  <memory>主 API 结果</memory>\n');
    assert.equal(logs[0].parsedResult, '  <memory>主 API 结果</memory>\n');
  });
});

test('Summary apiMode explicit override selects only the requested provider', async () => {
  const calls = [];
  const fetch = async () => {
    calls.push('secondary');
    return createResponse({ body: JSON.stringify({ choices: [{ message: { content: ' secondary ' } }] }) });
  };
  const generateRaw = async () => {
    calls.push('main');
    return ' main ';
  };

  await withSummaryHarness({ mode: 'secondary_api', generateRaw, fetch }, async () => {
    assert.equal(await generateSummaryMemory('默认副 API'), 'secondary');
    assert.equal(await generateSummaryMemory('显式主 API', { apiMode: 'main_api' }), 'main');
    assert.equal(await generateSummaryMemory('显式副 API', { apiMode: 'secondary_api' }), 'secondary');
    assert.equal(await generateSummaryMemory('无效覆盖', { apiMode: 'invalid_mode' }), 'secondary');
  });
  assert.deepEqual(calls, ['secondary', 'main', 'secondary', 'secondary']);
});

test('Summary secondary API preserves URL, Bearer, model, messages, stream, and success log', async () => {
  let calledUrl = '';
  let calledOptions = null;
  await withSummaryHarness({
    mode: 'secondary_api',
    fetch: async (url, options) => {
      calledUrl = url;
      calledOptions = options;
      return createResponse({ body: JSON.stringify({ choices: [{ message: { content: '  副 API 结果  ' } }] }) });
    },
  }, async ({ logs }) => {
    assert.equal(await generateSummaryMemory('副 API prompt', { type: '副 API 隔离测试' }), '副 API 结果');
    const requestBody = JSON.parse(calledOptions.body);
    assert.equal(calledUrl, 'https://example.invalid/chat/completions');
    assert.equal(calledOptions.headers.Authorization, 'Bearer test-secret-key');
    assert.equal(requestBody.model, 'summary-model');
    assert.equal(requestBody.stream, false);
    assert.deepEqual(requestBody.messages, logs[0].messages);
    assert.equal(logs[0].httpStatus, 200);
    assert.equal(logs[0].url, calledUrl);
    assert.equal(logs[0].responseText.includes('副 API 结果'), true);
    assert.equal(JSON.stringify(logs[0]).includes('test-secret-key'), false);
  });
});

test('Summary preserves old rejection of HTTP 200 non-JSON secondary responses', async () => {
  await withSummaryHarness({
    mode: 'secondary_api',
    fetch: async () => createResponse({ body: 'plain text is not a summary response' }),
  }, async ({ logs }) => {
    await assert.rejects(
      generateSummaryMemory('non-json'),
      /接口返回成功，但没有读取到回复正文：plain text is not a summary response/,
    );
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].url, 'https://example.invalid/chat/completions');
  });
});

test('Summary exposes provider errors and never falls back between APIs', async () => {
  const mainFailure = new Error('main provider failed');
  let secondaryCalls = 0;
  await withSummaryHarness({
    generateRaw: async () => { throw mainFailure; },
    fetch: async () => { secondaryCalls += 1; return createResponse(); },
  }, async ({ logs }) => {
    await assert.rejects(generateSummaryMemory('main failure'), error => error === mainFailure);
    assert.equal(logs[0].status, 'failure');
    assert.equal(secondaryCalls, 0);
  });

  let mainCalls = 0;
  const fetchFailure = new Error('secondary fetch failed');
  await withSummaryHarness({
    mode: 'secondary_api',
    generateRaw: async () => { mainCalls += 1; return 'unexpected'; },
    fetch: async () => { throw fetchFailure; },
  }, async ({ logs }) => {
    await assert.rejects(generateSummaryMemory('secondary fetch failure'), error => error === fetchFailure);
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].url, '');
    assert.equal(logs[0].requestBody, null);
    assert.equal(mainCalls, 0);
  });
});

test('Summary exposes secondary HTTP and missing-content errors without an active timeout', async () => {
  await withSummaryHarness({
    mode: 'secondary_api',
    fetch: async () => createResponse({ ok: false, status: 429, statusText: 'Too Many Requests', body: '{"error":"slow down"}' }),
  }, async () => {
    await assert.rejects(generateSummaryMemory('http failure'), /HTTP 429 Too Many Requests/);
  });

  await withSummaryHarness({
    mode: 'secondary_api',
    fetch: async () => createResponse({ body: JSON.stringify({ choices: [{ message: { content: '' } }] }) }),
  }, async () => {
    await assert.rejects(generateSummaryMemory('missing content'), /副 API 响应缺少模型正文/);
  });
});
