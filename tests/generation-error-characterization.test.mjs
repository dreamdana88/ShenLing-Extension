import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GenerationTransportError,
  generateWithMainApi,
  generateWithSecondaryApi,
} from '../src/core/generation.js';

const ABSENT = Symbol('absent');
const SECRET = 'sk-char-secret-never-log';
const messages = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'user message' },
];
const profile = {
  name: 'Char Secondary',
  baseUrl: 'https://example.invalid/v1',
  endpointPath: '/chat/completions',
  apiKey: SECRET,
  model: 'char-model',
};

async function withGlobals({ generateRaw = ABSENT, tavernHelper = ABSENT, getContext = ABSENT, fetch = ABSENT } = {}, run) {
  const previous = new Map();
  for (const key of ['generateRaw', 'TavernHelper', 'SillyTavern', 'fetch']) {
    previous.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
  }
  if (generateRaw === ABSENT) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;
  if (tavernHelper === ABSENT) delete globalThis.TavernHelper;
  else globalThis.TavernHelper = tavernHelper;
  globalThis.SillyTavern = { getContext: getContext === ABSENT ? () => ({}) : getContext };
  if (fetch === ABSENT) delete globalThis.fetch;
  else globalThis.fetch = fetch;
  try {
    return await run();
  } finally {
    for (const [key, state] of previous) {
      if (state.exists) globalThis[key] = state.value;
      else delete globalThis[key];
    }
  }
}

async function capture(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

// durationMs is checked for presence and then removed; generationId is random.
function snapshot(error) {
  assert.ok(error instanceof GenerationTransportError);
  const { durationMs, generationId, ...diagnostics } = error.diagnostics;
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
  if (generationId !== undefined) diagnostics.generationId = typeof generationId;
  return {
    message: error.message,
    code: error.code,
    stage: error.stage,
    diagnostics,
    hasCause: 'cause' in error,
  };
}

const never = () => new Promise(() => {});
const boom = new Error(`boom with ${SECRET}`);
const failingHelper = {
  get generateRaw() { throw boom; },
  stopGenerationById: () => false,
};
const rejectingHelper = {
  generateRaw: async () => { throw boom; },
  stopGenerationById: () => false,
};
const abortableFetch = (url, { signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
const okResponse ={ ok: true, status: 200, statusText: 'OK' };
const main = (globals, options = {}) => withGlobals(globals, () => capture(
  generateWithMainApi({ messages, ...options }),
));
const secondary = (globals, options = {}, overrides = {}) => withGlobals(globals, () => capture(
  generateWithSecondaryApi({ profile, messages, ...options, ...overrides }),
));

const scenarios = {
  'main stream: provider resolution failed': () => main(
    { tavernHelper: failingHelper },
    { transportMode: 'stream' },
  ),
  'main stream: capability unavailable': () => main({}, { transportMode: 'stream' }),
  'main stream: send_request failure': () => main(
    { tavernHelper: rejectingHelper },
    { transportMode: 'stream' },
  ),
  'main legacy: provider resolution failed': () => main({
    getContext: () => { throw boom; },
  }),
  'main legacy: provider missing': () => main({}),
  'main legacy: timeout': () => main({ generateRaw: never }, { timeoutMs: 5, timeoutMessage: `timeout ${SECRET}` }),
  'main legacy: provider failed': () => main({ generateRaw: async () => { throw boom; } }),
  'secondary legacy: profile missing': () => withGlobals({}, () => capture(generateWithSecondaryApi({ messages }))),
  'secondary stream: profile missing': () => withGlobals({}, () => capture(
    generateWithSecondaryApi({ messages, transportMode: 'stream' }),
  )),
  'secondary: model missing': () => secondary({}, {}, { profile: { ...profile, model: '' } }),
  'secondary: url build failed': () => secondary({}, {}, {
    profile: {
      name: 'Broken URL', model: 'm', apiKey: SECRET, get baseUrl() { throw boom; },
    },
  }),
  'secondary stream: provider resolution failed': () => secondary(
    { tavernHelper: failingHelper },
    { transportMode: 'stream' },
  ),
  'secondary stream: capability unavailable': () => secondary({}, { transportMode: 'stream' }),
  'secondary stream: endpoint unsupported': () => secondary(
    { tavernHelper: rejectingHelper },
    { transportMode: 'stream' },
    { profile: { ...profile, endpointPath: '/custom/weird/path' } },
  ),
  'secondary stream: custom_api build failed': () => {
    let reads = 0;
    const flaky = {
      ...profile,
      get model() {
        reads += 1;
        if (reads > 1) throw boom;
        return 'char-model';
      },
    };
    return secondary(
      { tavernHelper: rejectingHelper },
      { transportMode: 'stream' },
      { profile: flaky },
    );
  },
  'secondary stream: content missing': () => secondary({
    tavernHelper: { generateRaw: async () => '  ', stopGenerationById: () => false },
  }, { transportMode: 'stream' }),
  'secondary stream: send_request failure': () => secondary(
    { tavernHelper: rejectingHelper },
    { transportMode: 'stream' },
  ),
  'secondary legacy: already aborted': () => {
    const controller = new AbortController();
    controller.abort();
    return secondary({ fetch: never }, { signal: controller.signal });
  },
  'secondary legacy: header timeout': () => secondary(
    { fetch: never },
    { timeoutMs: 5, timeoutMessage: `timeout ${SECRET}` },
  ),
  'secondary legacy: body timeout': () => secondary({
    fetch: async () => ({ ...okResponse, text: never }),
  }, { timeoutMs: 5 }),
  'secondary legacy: user abort in flight': () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    return secondary({ fetch: abortableFetch }, { signal: controller.signal });
  },
  'secondary legacy: body read failed': () => secondary({
    fetch: async () => ({ ...okResponse, text: async () => { throw boom; } }),
  }),
  'secondary legacy: fetch failed': () => secondary({ fetch: async () => { throw boom; } }),
  'secondary legacy: http error': () => secondary({
    fetch: async () => ({
      ok: false, status: 429, statusText: `Slow ${SECRET}`, text: async () => `denied token=${SECRET}`,
    }),
  }),
  'secondary legacy: content missing': () => secondary({
    fetch: async () => ({
      ...okResponse,
      text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }),
    }),
  }),
};

// Frozen from the pre-refactor implementation: every GenerationTransportError site.
const expected = {
  "main stream: provider resolution failed": {
    "message": "解析酒馆主 API 流式 Provider 失败：boom with sk-char-secret-never-log",
    "code": "MAIN_PROVIDER_RESOLUTION_FAILED",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2,
      "stream": true
    },
    "hasCause": true
  },
  "main stream: capability unavailable": {
    "message": "当前环境缺少成对的 generateRaw 与 stopGenerationById，无法使用主 API 流式传输。",
    "code": "STREAM_UNAVAILABLE",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2,
      "stream": true
    },
    "hasCause": false
  },
  "main stream: send_request failure": {
    "message": "酒馆主 API 流式生成失败：boom with sk-char-secret-never-log",
    "code": "NETWORK_ERROR",
    "stage": "send_request",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2,
      "stream": true,
      "generationId": "string"
    },
    "hasCause": true
  },
  "main legacy: provider resolution failed": {
    "message": "解析酒馆主 API Provider 失败：boom with sk-char-secret-never-log",
    "code": "MAIN_PROVIDER_RESOLUTION_FAILED",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2
    },
    "hasCause": true
  },
  "main legacy: provider missing": {
    "message": "当前环境未发现 generateRaw，无法调用酒馆主 API。",
    "code": "MAIN_PROVIDER_MISSING",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2
    },
    "hasCause": false
  },
  "main legacy: timeout": {
    "message": "timeout sk-char-secret-never-log",
    "code": "MAIN_TIMEOUT",
    "stage": "send_request",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2
    },
    "hasCause": false
  },
  "main legacy: provider failed": {
    "message": "酒馆主 API 生成失败：boom with sk-char-secret-never-log",
    "code": "MAIN_PROVIDER_FAILED",
    "stage": "send_request",
    "diagnostics": {
      "provider": "main",
      "messageCount": 2
    },
    "hasCause": true
  },
  "secondary legacy: profile missing": {
    "message": "当前环境未提供副 API 配置。",
    "code": "SECONDARY_PROFILE_MISSING",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "secondary",
      "messageCount": 2,
      "stream": false
    },
    "hasCause": false
  },
  "secondary stream: profile missing": {
    "message": "当前环境未提供副 API 配置。",
    "code": "SECONDARY_PROFILE_MISSING",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "secondary",
      "messageCount": 2,
      "stream": true
    },
    "hasCause": false
  },
  "secondary: model missing": {
    "message": "请先在设置页选择生成模型。",
    "code": "SECONDARY_MODEL_MISSING",
    "stage": "build_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "messageCount": 2,
      "stream": false
    },
    "hasCause": false
  },
  "secondary: url build failed": {
    "message": "无法构建副 API 请求地址：boom with [REDACTED]",
    "code": "SECONDARY_URL_BUILD_FAILED",
    "stage": "build_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Broken URL",
      "model": "m",
      "url": "",
      "messageCount": 2,
      "stream": false
    },
    "hasCause": true
  },
  "secondary stream: provider resolution failed": {
    "message": "解析副 API 流式 Provider 失败：boom with [REDACTED]",
    "code": "STREAM_UNAVAILABLE",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": true
    },
    "hasCause": true
  },
  "secondary stream: capability unavailable": {
    "message": "当前环境缺少成对的 generateRaw 与 stopGenerationById，无法使用副 API 流式传输。",
    "code": "STREAM_UNAVAILABLE",
    "stage": "resolve_provider",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": true
    },
    "hasCause": false
  },
  "secondary stream: endpoint unsupported": {
    "message": "当前副 API 的 endpointPath 无法安全映射到 TavernHelper custom_api。请使用标准 /v1/chat/completions 或 /chat/completions，或关闭后台流式并继续使用 legacy 模式。",
    "code": "STREAM_ENDPOINT_UNSUPPORTED",
    "stage": "build_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/custom/weird/path",
      "baseUrl": "https://example.invalid/v1",
      "endpointPath": "/custom/weird/path",
      "messageCount": 2,
      "stream": true,
      "transportMode": "stream"
    },
    "hasCause": true
  },
  "secondary stream: custom_api build failed": {
    "message": "无法构建副 API custom_api：boom with [REDACTED]",
    "code": "SECONDARY_URL_BUILD_FAILED",
    "stage": "build_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": true
    },
    "hasCause": true
  },
  "secondary stream: content missing": {
    "message": "副 API 接口响应中缺少可用模型正文。",
    "code": "SECONDARY_CONTENT_MISSING",
    "stage": "extract_content",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": true,
      "responseText": "",
      "responseTextTruncated": false,
      "generationId": "string"
    },
    "hasCause": false
  },
  "secondary stream: send_request failure": {
    "message": "副 API 流式生成失败：boom with [REDACTED]",
    "code": "NETWORK_ERROR",
    "stage": "send_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": true,
      "generationId": "string"
    },
    "hasCause": true
  },
  "secondary legacy: already aborted": {
    "message": "副 API 生成已取消。",
    "code": "USER_ABORT",
    "stage": "send_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": false,
      "stopRequested": true,
      "abortReason": "USER_ABORT"
    },
    "hasCause": true
  },
  "secondary legacy: header timeout": {
    "message": "timeout [REDACTED]",
    "code": "SECONDARY_TIMEOUT",
    "stage": "send_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "httpStatus": null,
      "messageCount": 2,
      "stream": false,
      "responseText": "",
      "responseTextTruncated": false
    },
    "hasCause": false
  },
  "secondary legacy: body timeout": {
    "message": "生成超时，请稍后重试。",
    "code": "SECONDARY_TIMEOUT",
    "stage": "read_response",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "httpStatus": 200,
      "messageCount": 2,
      "stream": false,
      "responseText": "",
      "responseTextTruncated": false
    },
    "hasCause": false
  },
  "secondary legacy: user abort in flight": {
    "message": "副 API 生成已取消。",
    "code": "USER_ABORT",
    "stage": "send_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "httpStatus": null,
      "messageCount": 2,
      "stream": false,
      "stopRequested": true,
      "abortReason": "USER_ABORT"
    },
    "hasCause": true
  },
  "secondary legacy: body read failed": {
    "message": "读取副 API 响应正文失败：boom with [REDACTED]",
    "code": "SECONDARY_BODY_READ_FAILED",
    "stage": "read_response",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "httpStatus": 200,
      "messageCount": 2,
      "stream": false
    },
    "hasCause": true
  },
  "secondary legacy: fetch failed": {
    "message": "副 API 请求发送失败：boom with [REDACTED]",
    "code": "SECONDARY_FETCH_FAILED",
    "stage": "send_request",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "messageCount": 2,
      "stream": false
    },
    "hasCause": true
  },
  "secondary legacy: http error": {
    "message": "副 API 请求失败（HTTP 429 Slow [REDACTED]）。",
    "code": "SECONDARY_HTTP_ERROR",
    "stage": "read_response",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "httpStatus": 429,
      "messageCount": 2,
      "stream": false,
      "responseText": "denied token=[REDACTED]]]",
      "responseTextTruncated": false
    },
    "hasCause": false
  },
  "secondary legacy: content missing": {
    "message": "副 API 接口响应中缺少可用模型正文。",
    "code": "SECONDARY_CONTENT_MISSING",
    "stage": "extract_content",
    "diagnostics": {
      "provider": "secondary",
      "profileName": "Char Secondary",
      "model": "char-model",
      "url": "https://example.invalid/chat/completions",
      "httpStatus": 200,
      "messageCount": 2,
      "stream": false,
      "responseText": "{\"choices\":[{\"message\":{\"content\":\"\"}}]}",
      "responseTextTruncated": false
    },
    "hasCause": false
  }
};

assert.deepEqual(Object.keys(expected), Object.keys(scenarios));

for (const [name, run] of Object.entries(scenarios)) {
  test(`generation error characterization: ${name}`, async () => {
    assert.deepEqual(snapshot(await run()), expected[name]);
  });
}
