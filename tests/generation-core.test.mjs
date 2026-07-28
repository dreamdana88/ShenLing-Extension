import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  GenerationTransportError,
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
} from '../src/core/generation.js';

const ABSENT = Symbol('absent');
const SECRET = 'sk-test-secret-never-log';
const messages = [
  { role: 'system', content: 'system prompt must not enter diagnostics' },
  { role: 'user', content: 'private user message must not enter diagnostics' },
];

const secondaryProfile = {
  name: 'Core Secondary',
  baseUrl: 'https://example.invalid/v1',
  endpointPath: '/chat/completions',
  apiKey: SECRET,
  model: 'core-model',
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
  return { promise, reject, resolve };
}

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

async function withGlobals({
  generateRaw = ABSENT,
  contextGenerateRaw = ABSENT,
  getContext = ABSENT,
  fetch = ABSENT,
} = {}, run) {
  const previous = new Map();
  for (const key of ['generateRaw', 'SillyTavern', 'fetch']) {
    previous.set(key, {
      exists: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
  }

  if (generateRaw === ABSENT) delete globalThis.generateRaw;
  else globalThis.generateRaw = generateRaw;

  if (getContext !== ABSENT) {
    globalThis.SillyTavern = { getContext };
  } else {
    globalThis.SillyTavern = {
      getContext: () => (
        contextGenerateRaw === ABSENT
          ? {}
          : { generateRaw: contextGenerateRaw }
      ),
    };
  }

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

async function getRejection(promise) {
  let rejection = null;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection, 'expected promise to reject');
  return rejection;
}

function assertTransportError(error, code, stage) {
  assert.ok(error instanceof Error);
  assert.ok(error instanceof GenerationTransportError);
  assert.equal(error.name, 'GenerationTransportError');
  assert.equal(error.code, code);
  assert.equal(error.stage, stage);
  assert.ok(Object.isFrozen(error.diagnostics));
  assert.ok(Number.isFinite(error.diagnostics.durationMs));
  assert.ok(error.diagnostics.durationMs >= 0);
}

function assertSecretAbsent(error) {
  const context = getGenerationErrorContext(error);
  const values = [
    error.message,
    error.stack,
    error.code,
    error.stage,
    JSON.stringify(error),
    JSON.stringify(error.diagnostics),
    JSON.stringify(context),
  ];
  for (const value of values) {
    assert.equal(String(value).includes(SECRET), false);
  }
}

async function waitForCondition(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail('condition was not met before timeout');
    }
    await delay(5);
  }
}

async function createLocalGenerationServer() {
  const records = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    const record = {
      aborted: false,
      closedBeforeEnd: false,
      path: request.url,
    };
    records.push(record);
    request.on('aborted', () => {
      record.aborted = true;
    });
    response.on('close', () => {
      record.closedBeforeEnd = !response.writableEnded;
    });

    const sendJson = content => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content } }],
      }));
    };

    if (request.url === '/success') {
      sendJson('node success');
      return;
    }

    if (request.url === '/slow-headers') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) sendJson('late headers');
      }, 120);
      timers.add(timer);
      return;
    }

    if (request.url === '/slow-body') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"choices":[{"message":{"content":"');
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.end('node slow body"}}]}');
      }, 120);
      timers.add(timer);
      return;
    }

    response.writeHead(404);
    response.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    records,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

test('GenerationTransportError exposes a frozen whitelist context and preserves cause identity', () => {
  const cause = new Error('original provider stack');
  const error = new GenerationTransportError('transport failed', {
    code: 'TEST_CODE',
    stage: 'send_request',
    diagnostics: {
      provider: 'secondary',
      url: [
        'https://user:pass@example.invalid/path?safe=1',
        'Key=key-secret',
        'API_KEY=api-key-secret',
        'ApiKey=apikey-secret',
        'Token=token-secret',
        'ACCESS_TOKEN=access-token-secret',
        'Auth=auth-secret',
        'Authorization=authorization-secret',
        'Cookie=cookie-secret',
        'Session=session-secret',
      ].join('&'),
      responseText: 'Authorization: Bearer header-secret token=body-secret',
      durationMs: 3,
      apiKey: SECRET,
      headers: { Authorization: `Bearer ${SECRET}` },
      profile: secondaryProfile,
      requestBody: { messages },
      messages,
    },
    cause,
  });

  assertTransportError(error, 'TEST_CODE', 'send_request');
  assert.equal(error.cause, cause);
  assert.equal(error.diagnostics.url.includes('user:pass'), false);
  for (const secret of [
    'key-secret',
    'api-key-secret',
    'apikey-secret',
    'token-secret',
    'access-token-secret',
    'auth-secret',
    'authorization-secret',
    'cookie-secret',
    'session-secret',
  ]) {
    assert.equal(error.diagnostics.url.includes(secret), false);
  }
  assert.equal(error.diagnostics.url.includes('safe=1'), true);
  assert.equal(error.diagnostics.responseText.includes('header-secret'), false);
  assert.equal(error.diagnostics.responseText.includes('body-secret'), false);
  assert.deepEqual(
    Object.keys(error.diagnostics).sort(),
    ['durationMs', 'provider', 'responseText', 'responseTextTruncated', 'url'],
  );
  assertSecretAbsent(error);

  const context = getGenerationErrorContext(error);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.diagnostics));
  assert.notEqual(context.diagnostics, error.diagnostics);
  assert.equal(context.code, 'TEST_CODE');
  assert.equal(context.stage, 'send_request');
  assert.throws(() => {
    context.diagnostics.provider = 'main';
  }, TypeError);
  assert.equal(getGenerationErrorContext(new Error('ordinary')), null);

  const invalidUrlError = new GenerationTransportError('invalid URL', {
    diagnostics: { url: 'not a parseable URL' },
  });
  assert.equal(invalidUrlError.diagnostics.url, '');
});

test('main API keeps its success contract and has no default timeout', async () => {
  let received = null;
  await withGlobals({
    generateRaw: async request => {
      received = request;
      await delay(20);
      return ' main result ';
    },
  }, async () => {
    const result = await generateWithMainApi({ messages });
    assert.deepEqual(received, { prompt: messages });
    assert.strictEqual(received.prompt, messages);
    assert.deepEqual(Object.keys(result).sort(), [
      'content',
      'model',
      'profileName',
      'requestBody',
      'responseText',
      'url',
    ]);
    assert.equal(result.content, ' main result ');
    assert.strictEqual(result.requestBody.prompt, messages);
  });
});

test('runWithTimeout clears its timer after an early main success', async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCalls = 0;
  globalThis.clearTimeout = timer => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  };

  try {
    await withGlobals({
      generateRaw: async () => 'early success',
    }, async () => {
      const result = await generateWithMainApi({
        messages,
        timeoutMs: 1000,
      });
      assert.equal(result.content, 'early success');
      assert.equal(clearCalls, 1);
    });
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('main API reports a missing provider without selecting another transport', async () => {
  let secondaryCalls = 0;
  await withGlobals({
    fetch: async () => {
      secondaryCalls += 1;
      return createResponse();
    },
  }, async () => {
    const error = await getRejection(generateWithMainApi({ messages }));
    assertTransportError(error, 'MAIN_PROVIDER_MISSING', 'resolve_provider');
    assert.equal(error.diagnostics.provider, 'main');
    assert.equal(error.diagnostics.messageCount, 2);
    assert.equal(secondaryCalls, 0);
  });
});

test('main provider failures retain the original cause and never fall back', async () => {
  const original = new Error('provider-specific failure');
  let secondaryCalls = 0;
  await withGlobals({
    generateRaw: async () => {
      throw original;
    },
    fetch: async () => {
      secondaryCalls += 1;
      return createResponse();
    },
  }, async () => {
    const error = await getRejection(generateWithMainApi({ messages }));
    assertTransportError(error, 'MAIN_PROVIDER_FAILED', 'send_request');
    assert.equal(error.cause, original);
    assert.match(error.message, /provider-specific failure/);
    assert.match(original.stack, /provider-specific failure/);
    assert.match(error.stack, /GenerationTransportError/);
    assert.equal(secondaryCalls, 0);
  });
});

test('main timeout remains wait-only and a late resolve cannot settle twice', async () => {
  let underlyingFinished = false;
  const previousAbortController = globalThis.AbortController;
  const previousStopGeneration = globalThis.stopGeneration;
  const previousStopGenerationById = globalThis.stopGenerationById;
  let stopCalls = 0;
  globalThis.AbortController = class UnexpectedAbortController {
    constructor() {
      throw new Error('main API must not create AbortController');
    }
  };
  globalThis.stopGeneration = () => {
    stopCalls += 1;
  };
  globalThis.stopGenerationById = () => {
    stopCalls += 1;
  };

  try {
    await withGlobals({
      generateRaw: async () => {
        await delay(25);
        underlyingFinished = true;
        return 'late result';
      },
    }, async () => {
      const error = await getRejection(generateWithMainApi({
        messages,
        timeoutMs: 5,
        timeoutMessage: 'main timeout marker',
      }));
      assertTransportError(error, 'MAIN_TIMEOUT', 'send_request');
      assert.equal(error.message, 'main timeout marker');
      assert.equal(underlyingFinished, false);
      assert.equal(stopCalls, 0);
      await delay(35);
      assert.equal(underlyingFinished, true);
      assert.equal(stopCalls, 0);
    });
  } finally {
    globalThis.AbortController = previousAbortController;
    if (previousStopGeneration === undefined) delete globalThis.stopGeneration;
    else globalThis.stopGeneration = previousStopGeneration;
    if (previousStopGenerationById === undefined) {
      delete globalThis.stopGenerationById;
    } else {
      globalThis.stopGenerationById = previousStopGenerationById;
    }
  }
});

test('main timeout safely observes a late provider rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    await withGlobals({
      generateRaw: async () => {
        await delay(20);
        throw new Error('late rejection');
      },
    }, async () => {
      const error = await getRejection(generateWithMainApi({
        messages,
        timeoutMs: 5,
      }));
      assertTransportError(error, 'MAIN_TIMEOUT', 'send_request');
      await delay(35);
      assert.deepEqual(unhandled, []);
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('main API uses the SillyTavern context provider only when the global provider is absent', async () => {
  let contextCalls = 0;
  await withGlobals({
    contextGenerateRaw: async ({ prompt }) => {
      contextCalls += 1;
      assert.strictEqual(prompt, messages);
      return 'context result';
    },
  }, async () => {
    const result = await generateWithMainApi({ messages });
    assert.equal(result.content, 'context result');
    assert.equal(contextCalls, 1);
  });
});

test('main API prefers global generateRaw and never calls getContext when it exists', async () => {
  let contextCalls = 0;
  let generateCalls = 0;
  await withGlobals({
    generateRaw: async ({ prompt }) => {
      generateCalls += 1;
      assert.strictEqual(prompt, messages);
      return 'global result';
    },
    getContext: () => {
      contextCalls += 1;
      throw new Error('getContext must not be called when global generateRaw exists');
    },
  }, async () => {
    const result = await generateWithMainApi({ messages });
    assert.equal(result.content, 'global result');
    assert.equal(generateCalls, 1);
    assert.equal(contextCalls, 0);
  });
});

test('main API getContext resolution failure becomes MAIN_PROVIDER_RESOLUTION_FAILED without fallback', async () => {
  // 使用现有 sanitizer 可识别的 Authorization 形态，验证 message 清洗而非臆造新脱敏规则。
  const original = new Error(`context resolution failed Authorization: Bearer ${SECRET}`);
  let secondaryCalls = 0;
  await withGlobals({
    getContext: () => {
      throw original;
    },
    fetch: async () => {
      secondaryCalls += 1;
      return createResponse();
    },
  }, async () => {
    const error = await getRejection(generateWithMainApi({ messages }));
    assertTransportError(error, 'MAIN_PROVIDER_RESOLUTION_FAILED', 'resolve_provider');
    assert.equal(error.cause, original);
    assert.match(error.message, /解析酒馆主 API Provider 失败/);
    assert.match(error.message, /Authorization:\s*\[REDACTED\]/);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(`Bearer ${SECRET}`), false);
    assert.equal(error.diagnostics.provider, 'main');
    assert.equal(error.diagnostics.messageCount, 2);
    assert.equal(Object.hasOwn(error.diagnostics, 'url'), false);
    assert.equal(Object.hasOwn(error.diagnostics, 'profileName'), false);
    assert.equal(getGenerationErrorContext(error)?.code, 'MAIN_PROVIDER_RESOLUTION_FAILED');
    // cause 保留原始身份（可含敏感原文）；对外 message / diagnostics 不得泄漏。
    assert.equal(String(error.cause?.message || '').includes(SECRET), true);
    assert.equal(JSON.stringify(error.diagnostics).includes(SECRET), false);
    assert.equal(secondaryCalls, 0);
  });
});

test('main API missing provider remains MAIN_PROVIDER_MISSING when getContext returns no generateRaw', async () => {
  await withGlobals({
    getContext: () => ({ someOtherField: true }),
  }, async () => {
    const error = await getRejection(generateWithMainApi({ messages }));
    assertTransportError(error, 'MAIN_PROVIDER_MISSING', 'resolve_provider');
    assert.notEqual(error.code, 'MAIN_PROVIDER_RESOLUTION_FAILED');
    assert.equal(getGenerationErrorContext(error)?.stage, 'resolve_provider');
  });
});

test('secondary preflight errors use stable codes and do not copy profile secrets', async () => {
  await withGlobals({}, async () => {
    const missingProfile = await getRejection(generateWithSecondaryApi({ messages }));
    assertTransportError(
      missingProfile,
      'SECONDARY_PROFILE_MISSING',
      'resolve_provider',
    );

    const missingModel = await getRejection(generateWithSecondaryApi({
      profile: {
        ...secondaryProfile,
        model: '',
        privateExtra: SECRET,
      },
      messages,
    }));
    assertTransportError(
      missingModel,
      'SECONDARY_MODEL_MISSING',
      'build_request',
    );
    assert.equal(missingModel.diagnostics.profileName, 'Core Secondary');
    assert.equal(JSON.stringify(missingModel.diagnostics).includes(SECRET), false);
    assert.equal('privateExtra' in missingModel.diagnostics, false);

    const original = new Error('base URL getter failed');
    const brokenProfile = {
      name: 'Broken URL',
      model: 'core-model',
      apiKey: SECRET,
      get baseUrl() {
        throw original;
      },
    };
    const urlFailure = await getRejection(generateWithSecondaryApi({
      profile: brokenProfile,
      messages,
    }));
    assertTransportError(
      urlFailure,
      'SECONDARY_URL_BUILD_FAILED',
      'build_request',
    );
    assert.equal(urlFailure.cause, original);
    assertSecretAbsent(urlFailure);
  });
});

test('secondary fetch failures retain cause, redact URL secrets, and never use main API', async () => {
  const original = new Error('network route failed');
  const originalClearTimeout = globalThis.clearTimeout;
  let mainCalls = 0;
  let clearCalls = 0;
  let fetchSignal = null;
  const profile = {
    ...secondaryProfile,
    baseUrl: `https://user:${SECRET}@example.invalid/v1?Token=${SECRET}&API_KEY=${SECRET}`,
    endpointPath: '/chat/completions',
    hiddenProfileField: SECRET,
  };
  globalThis.clearTimeout = timer => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  };

  try {
    await withGlobals({
      generateRaw: async () => {
        mainCalls += 1;
        return 'unexpected';
      },
      fetch: async (_url, options) => {
        fetchSignal = options.signal;
        throw original;
      },
    }, async () => {
      const error = await getRejection(generateWithSecondaryApi({
        profile,
        messages,
        timeoutMs: 1000,
      }));
      assertTransportError(error, 'SECONDARY_FETCH_FAILED', 'send_request');
      assert.equal(error.cause, original);
      assert.equal(mainCalls, 0);
      assert.ok(fetchSignal instanceof AbortSignal);
      assert.equal(fetchSignal.aborted, false);
      assert.equal(clearCalls, 1);
      assert.equal(error.diagnostics.url.includes('user:'), false);
      assert.equal(error.diagnostics.url.includes(SECRET), false);
      assert.equal(error.diagnostics.messageCount, 2);
      assert.equal(error.diagnostics.stream, false);
      assert.equal('requestBody' in error.diagnostics, false);
      assert.equal('messages' in error.diagnostics, false);
      assert.equal('headers' in error.diagnostics, false);
      assert.equal('profile' in error.diagnostics, false);
      assertSecretAbsent(error);
    });
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('secondary response-header timeout aborts promptly at send_request and safely observes a late rejection', async () => {
  const deferredFetch = createDeferred();
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  let fetchSignal = null;
  let mainCalls = 0;
  process.on('unhandledRejection', onUnhandled);

  try {
    await withGlobals({
      generateRaw: async () => {
        mainCalls += 1;
        return 'unexpected';
      },
      fetch: async (_url, options) => {
        fetchSignal = options.signal;
        return deferredFetch.promise;
      },
    }, async () => {
      const startedAt = Date.now();
      const error = await getRejection(generateWithSecondaryApi({
        profile: secondaryProfile,
        messages,
        timeoutMs: 10,
        timeoutMessage: 'secondary timeout marker',
      }));
      const elapsedMs = Date.now() - startedAt;
      assertTransportError(error, 'SECONDARY_TIMEOUT', 'send_request');
      assert.equal(error.message, 'secondary timeout marker');
      assert.ok(fetchSignal instanceof AbortSignal);
      assert.equal(fetchSignal.aborted, true);
      assert.equal(error.diagnostics.httpStatus, null);
      assert.equal(error.diagnostics.responseText, '');
      assert.equal(elapsedMs < 150, true);
      assert.equal(mainCalls, 0);
      assertSecretAbsent(error);

      deferredFetch.reject(new Error('late fetch rejection'));
      await delay(20);
      assert.deepEqual(unhandled, []);
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('secondary response-body timeout aborts promptly at read_response and safely observes a late resolve', async () => {
  const deferredBody = createDeferred();
  let fetchSignal = null;
  await withGlobals({
    fetch: async (_url, options) => {
      fetchSignal = options.signal;
      return createResponse({
        status: 200,
        text: async () => deferredBody.promise,
      });
    },
  }, async () => {
    const startedAt = Date.now();
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
      timeoutMs: 10,
      timeoutMessage: 'body timeout marker',
    }));
    const elapsedMs = Date.now() - startedAt;
    assertTransportError(error, 'SECONDARY_TIMEOUT', 'read_response');
    assert.equal(error.message, 'body timeout marker');
    assert.ok(fetchSignal instanceof AbortSignal);
    assert.equal(fetchSignal.aborted, true);
    assert.equal(error.diagnostics.httpStatus, 200);
    assert.equal(error.diagnostics.responseText, '');
    assert.equal(error.diagnostics.responseTextTruncated, false);
    assert.equal(elapsedMs < 150, true);

    deferredBody.resolve('late plain-text body');
    await delay(20);
  });
});

test('secondary slow response.text remains unlimited when timeoutMs is absent', async () => {
  let fetchOptions = null;
  await withGlobals({
    fetch: async (_url, options) => {
      fetchOptions = options;
      return createResponse({
      text: async () => {
        await delay(30);
        return 'slow plain-text success';
      },
      });
    },
  }, async () => {
    const startedAt = Date.now();
    const result = await generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    });
    assert.equal(result.content, 'slow plain-text success');
    assert.equal(Date.now() - startedAt >= 20, true);
    assert.equal(Object.prototype.hasOwnProperty.call(fetchOptions, 'signal'), false);
  });
});

test('secondary success before timeout clears its timer and leaves signal active', async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCalls = 0;
  let fetchSignal = null;
  globalThis.clearTimeout = timer => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  };

  try {
    await withGlobals({
      fetch: async (_url, options) => {
        fetchSignal = options.signal;
        return createResponse({ body: 'early secondary success' });
      },
    }, async () => {
      const result = await generateWithSecondaryApi({
        profile: secondaryProfile,
        messages,
        timeoutMs: 1000,
      });
      assert.equal(result.content, 'early secondary success');
      assert.ok(fetchSignal instanceof AbortSignal);
      assert.equal(fetchSignal.aborted, false);
      assert.equal(clearCalls, 1);
    });
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('secondary body-read failures retain their original cause', async () => {
  const original = new Error('body stream failed');
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCalls = 0;
  let fetchSignal = null;
  globalThis.clearTimeout = timer => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  };

  try {
    await withGlobals({
      fetch: async (_url, options) => {
        fetchSignal = options.signal;
        return createResponse({
          status: 206,
          statusText: 'Partial Content',
          text: async () => {
            throw original;
          },
        });
      },
    }, async () => {
      const error = await getRejection(generateWithSecondaryApi({
        profile: secondaryProfile,
        messages,
        timeoutMs: 1000,
      }));
      assertTransportError(
        error,
        'SECONDARY_BODY_READ_FAILED',
        'read_response',
      );
      assert.equal(error.cause, original);
      assert.equal(error.diagnostics.httpStatus, 206);
      assert.match(error.message, /body stream failed/);
      assert.ok(fetchSignal instanceof AbortSignal);
      assert.equal(fetchSignal.aborted, false);
      assert.equal(clearCalls, 1);
    });
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('secondary HTTP 429 with a slow body times out at read_response before HTTP classification', async () => {
  const deferredBody = createDeferred();
  let fetchSignal = null;
  await withGlobals({
    fetch: async (_url, options) => {
      fetchSignal = options.signal;
      return createResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => deferredBody.promise,
      });
    },
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
      timeoutMs: 10,
    }));
    assertTransportError(error, 'SECONDARY_TIMEOUT', 'read_response');
    assert.notEqual(error.code, 'SECONDARY_HTTP_ERROR');
    assert.equal(error.diagnostics.httpStatus, 429);
    assert.equal(fetchSignal.aborted, true);

    deferredBody.resolve('{"error":"late rate-limit body"}');
    await delay(20);
  });
});

test('secondary response-body completion and timeout obey first-settlement wins', async () => {
  let earlySignal = null;
  await withGlobals({
    fetch: async (_url, options) => {
      earlySignal = options.signal;
      return createResponse({
        text: async () => {
          await delay(5);
          return 'body completed first';
        },
      });
    },
  }, async () => {
    const result = await generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
      timeoutMs: 50,
    });
    assert.equal(result.content, 'body completed first');
    assert.equal(earlySignal.aborted, false);
  });

  let timeoutSignal = null;
  await withGlobals({
    fetch: async (_url, options) => {
      timeoutSignal = options.signal;
      return createResponse({
        text: async () => {
          await delay(40);
          return 'body completed too late';
        },
      });
    },
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
      timeoutMs: 5,
    }));
    assertTransportError(error, 'SECONDARY_TIMEOUT', 'read_response');
    assert.equal(timeoutSignal.aborted, true);
    await delay(50);
  });
});

test('secondary HTTP errors expose safe status and redacted, bounded response diagnostics', async () => {
  const responseBody = [
    `Authorization: Bearer ${SECRET}`,
    `Bearer ${SECRET}`,
    `api_key=${SECRET}`,
    `apikey=${SECRET}`,
    `access_token=${SECRET}`,
    `token=${SECRET}`,
    `cookie=${SECRET}`,
    `session=${SECRET}`,
    'x'.repeat(17000),
    'full-response-tail-marker',
  ].join('\n');

  await withGlobals({
    fetch: async () => createResponse({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      body: responseBody,
    }),
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    }));
    assertTransportError(error, 'SECONDARY_HTTP_ERROR', 'read_response');
    assert.equal(error.diagnostics.httpStatus, 429);
    assert.equal(error.diagnostics.responseText.length, 16384);
    assert.equal(error.diagnostics.responseTextTruncated, true);
    assert.equal(error.diagnostics.responseText.includes(SECRET), false);
    assert.equal(error.message.includes('full-response-tail-marker'), false);
    assert.equal(error.message, '副 API 请求失败（HTTP 429 Too Many Requests）。');
    assertSecretAbsent(error);
  });

  await withGlobals({
    fetch: async () => createResponse({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: '{"error":"server failed"}',
    }),
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    }));
    assertTransportError(error, 'SECONDARY_HTTP_ERROR', 'read_response');
    assert.equal(error.diagnostics.httpStatus, 500);
    assert.equal(error.diagnostics.responseTextTruncated, false);
  });
});

test('secondary successful responses without usable content use extract_content diagnostics', async () => {
  await withGlobals({
    fetch: async () => createResponse({ body: '' }),
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    }));
    assertTransportError(
      error,
      'SECONDARY_CONTENT_MISSING',
      'extract_content',
    );
    assert.equal(error.diagnostics.httpStatus, 200);
    assert.equal(error.diagnostics.responseText, '');
    assert.equal(error.diagnostics.responseTextTruncated, false);
    assert.match(error.message, /接口响应中缺少可用模型正文/);
  });

  const body = JSON.stringify({ choices: [{ message: { content: '' } }] });
  await withGlobals({
    fetch: async () => createResponse({ body }),
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    }));
    assertTransportError(
      error,
      'SECONDARY_CONTENT_MISSING',
      'extract_content',
    );
    assert.equal(error.diagnostics.responseText, body);
  });
});

test('secondary JSON and non-JSON successes preserve request and return contracts', async () => {
  const calls = [];
  await withGlobals({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return createResponse({ body: 'plain-text success' });
    },
  }, async () => {
    const result = await generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    });
    assert.equal(result.content, 'plain-text success');
    assert.equal(result.responseJson, null);
    assert.deepEqual(Object.keys(result).sort(), [
      'content',
      'httpStatus',
      'model',
      'profileName',
      'requestBody',
      'responseJson',
      'responseText',
      'url',
    ]);
    const requestBody = JSON.parse(calls[0].options.body);
    assert.deepEqual(requestBody, {
      model: 'core-model',
      messages,
      stream: false,
    });
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(calls[0].options, 'signal'),
      false,
    );
  });

  const jsonBody = JSON.stringify({
    choices: [{ message: { content: 'json success' } }],
  });
  await withGlobals({
    fetch: async () => createResponse({ body: jsonBody }),
  }, async () => {
    const result = await generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    });
    assert.equal(result.content, 'json success');
    assert.deepEqual(result.responseJson, JSON.parse(jsonBody));
  });
});

test('real Node fetch aborts localhost slow headers and slow bodies while preserving success paths', async () => {
  const localServer = await createLocalGenerationServer();
  const profileFor = endpointPath => ({
    ...secondaryProfile,
    apiKey: 'local-test-key',
    baseUrl: localServer.baseUrl,
    endpointPath,
  });

  try {
    const success = await generateWithSecondaryApi({
      profile: profileFor('/success'),
      messages,
      timeoutMs: 500,
    });
    assert.equal(success.content, 'node success');

    const headerTimeout = await getRejection(generateWithSecondaryApi({
      profile: profileFor('/slow-headers'),
      messages,
      timeoutMs: 25,
    }));
    assertTransportError(
      headerTimeout,
      'SECONDARY_TIMEOUT',
      'send_request',
    );
    await waitForCondition(() => (
      localServer.records
        .filter(record => record.path === '/slow-headers')
        .some(record => record.aborted || record.closedBeforeEnd)
    ));

    const bodyTimeout = await getRejection(generateWithSecondaryApi({
      profile: profileFor('/slow-body'),
      messages,
      timeoutMs: 25,
    }));
    assertTransportError(
      bodyTimeout,
      'SECONDARY_TIMEOUT',
      'read_response',
    );
    assert.equal(bodyTimeout.diagnostics.httpStatus, 200);
    await waitForCondition(() => (
      localServer.records
        .filter(record => record.path === '/slow-body')
        .some(record => record.aborted || record.closedBeforeEnd)
    ));

    const noTimeoutSlowBody = await generateWithSecondaryApi({
      profile: profileFor('/slow-body'),
      messages,
    });
    assert.equal(noTimeoutSlowBody.content, 'node slow body');

    const abortedHeaderRecord = localServer.records
      .find(record => record.path === '/slow-headers');
    const abortedBodyRecord = localServer.records
      .find(record => (
        record.path === '/slow-body'
        && (record.aborted || record.closedBeforeEnd)
      ));
    assert.ok(abortedHeaderRecord.aborted || abortedHeaderRecord.closedBeforeEnd);
    assert.ok(abortedBodyRecord.aborted || abortedBodyRecord.closedBeforeEnd);
  } finally {
    await localServer.close();
  }
});
