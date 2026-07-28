import assert from 'node:assert/strict';
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

  globalThis.SillyTavern = {
    getContext: () => (
      contextGenerateRaw === ABSENT
        ? {}
        : { generateRaw: contextGenerateRaw }
    ),
  };

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
    await delay(35);
    assert.equal(underlyingFinished, true);
  });
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
  let mainCalls = 0;
  const profile = {
    ...secondaryProfile,
    baseUrl: `https://user:${SECRET}@example.invalid/v1?Token=${SECRET}&API_KEY=${SECRET}`,
    endpointPath: '/chat/completions',
    hiddenProfileField: SECRET,
  };

  await withGlobals({
    generateRaw: async () => {
      mainCalls += 1;
      return 'unexpected';
    },
    fetch: async () => {
      throw original;
    },
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile,
      messages,
    }));
    assertTransportError(error, 'SECONDARY_FETCH_FAILED', 'send_request');
    assert.equal(error.cause, original);
    assert.equal(mainCalls, 0);
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
});

test('secondary timeout still covers only the fetch response-header wait', async () => {
  let fetchFinished = false;
  await withGlobals({
    fetch: async () => {
      await delay(25);
      fetchFinished = true;
      return createResponse({ body: 'late body' });
    },
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
      timeoutMs: 5,
      timeoutMessage: 'secondary timeout marker',
    }));
    assertTransportError(error, 'SECONDARY_TIMEOUT', 'send_request');
    assert.equal(fetchFinished, false);
    await delay(35);
    assert.equal(fetchFinished, true);
  });
});

test('slow response.text remains outside the secondary timeout in Phase 4E-2A', async () => {
  await withGlobals({
    fetch: async () => createResponse({
      text: async () => {
        await delay(30);
        return 'slow plain-text success';
      },
    }),
  }, async () => {
    const startedAt = Date.now();
    const result = await generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
      timeoutMs: 5,
    });
    assert.equal(result.content, 'slow plain-text success');
    assert.equal(Date.now() - startedAt >= 20, true);
  });
});

test('secondary body-read failures retain their original cause', async () => {
  const original = new Error('body stream failed');
  await withGlobals({
    fetch: async () => createResponse({
      status: 206,
      statusText: 'Partial Content',
      text: async () => {
        throw original;
      },
    }),
  }, async () => {
    const error = await getRejection(generateWithSecondaryApi({
      profile: secondaryProfile,
      messages,
    }));
    assertTransportError(
      error,
      'SECONDARY_BODY_READ_FAILED',
      'read_response',
    );
    assert.equal(error.cause, original);
    assert.equal(error.diagnostics.httpStatus, 206);
    assert.match(error.message, /body stream failed/);
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
