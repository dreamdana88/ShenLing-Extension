import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RuntimeGenerationError,
  STOP_SETTLEMENT_GRACE_MS,
  createMainGenerationId,
  getRuntimeStreamingCapability,
  runRuntimeStreamingGeneration,
  supportsStreamingGeneration,
} from '../src/core/runtime-generation.js';

const messages = [
  { role: 'system', content: 'SYS_MARKER' },
  { role: 'user', content: 'USER_MARKER' },
  { role: 'assistant', content: 'ASSISTANT_MARKER' },
  { role: 'user', content: 'FINAL_MARKER' },
];

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

function createRuntime({ generateRaw, stopGenerationById } = {}) {
  const listeners = new Map();
  const iframeEvents = {
    STREAM_TOKEN_RECEIVED_FULLY: 'stream-full',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'stream-delta',
  };
  const runtime = {
    iframe_events: iframeEvents,
    eventOn(eventName, listener) {
      const eventListeners = listeners.get(eventName) || new Set();
      eventListeners.add(listener);
      listeners.set(eventName, eventListeners);
      return {
        stop() {
          eventListeners.delete(listener);
          if (eventListeners.size === 0) listeners.delete(eventName);
        },
      };
    },
    emit(eventName, ...args) {
      for (const listener of listeners.get(eventName) || []) listener(...args);
    },
    generateRaw: generateRaw || (async () => 'runtime result'),
    stopGenerationById: stopGenerationById || (() => false),
  };
  return {
    host: { TavernHelper: runtime },
    iframeEvents,
    listenerCount: () => [...listeners.values()]
      .reduce((total, eventListeners) => total + eventListeners.size, 0),
    runtime,
  };
}

async function getRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected promise to reject');
}

test('runtime capability resolves generate and stop atomically from one TavernHelper instance', async () => {
  const calls = [];
  const runtime = {
    label: 'same-runtime',
    generateRaw() {
      calls.push(['generate', this.label]);
      return 'ok';
    },
    stopGenerationById(id) {
      calls.push(['stop', this.label, id]);
      return true;
    },
  };
  const host = { TavernHelper: runtime };
  const capability = getRuntimeStreamingCapability(host);

  assert.equal(capability.status, 'available');
  assert.equal(capability.source, 'TavernHelper');
  assert.equal(supportsStreamingGeneration(host), true);
  assert.equal(await capability.runtime.generateRaw({}), 'ok');
  assert.equal(capability.runtime.stopGenerationById('generation-1'), true);
  assert.deepEqual(calls, [
    ['generate', 'same-runtime'],
    ['stop', 'same-runtime', 'generation-1'],
  ]);
});

test('runtime capability never combines generate and stop from different roots', () => {
  const host = {
    TavernHelper: { generateRaw: async () => 'wrong-root' },
    stopGenerationById: () => true,
  };

  const capability = getRuntimeStreamingCapability(host);
  assert.equal(capability.status, 'unavailable');
  assert.equal(supportsStreamingGeneration(host), false);
  assert.match(capability.reason, /同一运行时对象/);
});

test('runtime capability distinguishes absence from discovery failure', () => {
  assert.equal(getRuntimeStreamingCapability({}).status, 'unavailable');

  const host = {};
  Object.defineProperty(host, 'TavernHelper', {
    get() {
      throw new Error('namespace getter failed');
    },
  });
  const capability = getRuntimeStreamingCapability(host);
  assert.equal(capability.status, 'error');
  assert.match(capability.error.message, /namespace getter failed/);
});

test('generation ids are unique and keep the main transport prefix', () => {
  let value = 0;
  const host = { crypto: { randomUUID: () => `uuid-${value += 1}` } };
  const first = createMainGenerationId(host);
  const second = createMainGenerationId(host);

  assert.equal(first, 'slx-main-uuid-1');
  assert.equal(second, 'slx-main-uuid-2');
  assert.notEqual(first, second);
});

test('stream success preserves ordered prompts, resolves full text, records chunks, and cleans resources', async () => {
  let received = null;
  let stopCalls = 0;
  const harness = createRuntime({
    generateRaw: async request => {
      received = request;
      harness.runtime.emit(harness.iframeEvents.STREAM_TOKEN_RECEIVED_FULLY, '一', request.generation_id);
      harness.runtime.emit(harness.iframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY, '一', request.generation_id);
      harness.runtime.emit(harness.iframeEvents.STREAM_TOKEN_RECEIVED_FULLY, '一二', request.generation_id);
      harness.runtime.emit(harness.iframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY, '二', request.generation_id);
      return '完整结果';
    },
    stopGenerationById: () => {
      stopCalls += 1;
      return false;
    },
  });

  const result = await runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: 'ordered-generation',
    timeoutMs: 10,
  });

  assert.deepEqual(received, {
    ordered_prompts: messages,
    should_stream: true,
    should_silence: true,
    generation_id: 'ordered-generation',
  });
  assert.strictEqual(received.ordered_prompts, messages);
  assert.equal(result.responseText, '完整结果');
  assert.strictEqual(result.requestBody, received);
  assert.equal(result.transport.mode, 'stream');
  assert.equal(result.transport.generationId, 'ordered-generation');
  assert.equal(result.transport.chunkCount, 2);
  assert.ok(Number.isFinite(result.transport.firstChunkMs));
  assert.equal(harness.listenerCount(), 0);

  await delay(20);
  assert.equal(stopCalls, 0, 'success must clear its timeout timer');
});

test('provider rejection becomes NETWORK_ERROR and cleans listeners', async () => {
  const original = new Error('provider failed');
  const harness = createRuntime({
    generateRaw: async () => {
      throw original;
    },
  });

  const error = await getRejection(runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: 'failed-generation',
  }));

  assert.ok(error instanceof RuntimeGenerationError);
  assert.equal(error.code, 'NETWORK_ERROR');
  assert.equal(error.cause, original);
  assert.equal(harness.listenerCount(), 0);
});

test('a pre-aborted signal never starts or stops generation and leaves no resources', async () => {
  const controller = new AbortController();
  controller.abort('already cancelled');
  let generateCalls = 0;
  let stopCalls = 0;
  const harness = createRuntime({
    generateRaw: () => {
      generateCalls += 1;
      return 'unexpected';
    },
    stopGenerationById: () => {
      stopCalls += 1;
      return true;
    },
  });

  const error = await getRejection(runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: 'pre-aborted-generation',
    timeoutMs: 10,
    signal: controller.signal,
  }));

  assert.equal(error.code, 'USER_ABORT');
  assert.equal(error.diagnostics.stopRequested, false);
  assert.equal(error.diagnostics.stopAccepted, null);
  assert.equal(generateCalls, 0);
  assert.equal(stopCalls, 0);
  assert.equal(harness.listenerCount(), 0);
});

test('same-turn user abort orders generate before stop, waits for rejection, and cleans resources', async () => {
  const deferred = createDeferred();
  const controller = new AbortController();
  const stoppedIds = [];
  const callOrder = [];
  let generationStarted = false;
  const abortError = new DOMException('runtime aborted', 'AbortError');
  const harness = createRuntime({
    generateRaw: () => {
      callOrder.push('generate');
      generationStarted = true;
      return deferred.promise;
    },
    stopGenerationById: id => {
      assert.equal(generationStarted, true, 'stop must not run before generateRaw starts');
      callOrder.push('stop');
      stoppedIds.push(id);
      deferred.reject(abortError);
      return true;
    },
  });

  const pending = runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: 'user-cancel-generation',
    timeoutMs: 100,
    signal: controller.signal,
  });
  controller.abort('manual stop');
  const error = await getRejection(pending);

  assert.ok(error instanceof RuntimeGenerationError);
  assert.equal(error.code, 'USER_ABORT');
  assert.equal(error.generationId, 'user-cancel-generation');
  assert.equal(error.cause, abortError);
  assert.deepEqual(stoppedIds, ['user-cancel-generation']);
  assert.deepEqual(callOrder, ['generate', 'stop']);
  assert.equal(error.diagnostics.stopRequested, true);
  assert.equal(error.diagnostics.stopAccepted, true);
  assert.equal(error.diagnostics.stopSettlementTimedOut, false);
  assert.equal(error.diagnostics.abortReason, 'USER_ABORT');
  assert.equal(harness.listenerCount(), 0);
});

test('timeout cancels the matching generation, waits for rejection, and cleans resources', async () => {
  const deferred = createDeferred();
  const stoppedIds = [];
  const abortError = new DOMException('timeout aborted', 'AbortError');
  const harness = createRuntime({
    generateRaw: () => deferred.promise,
    stopGenerationById: id => {
      stoppedIds.push(id);
      deferred.reject(abortError);
      return true;
    },
  });

  const error = await getRejection(runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: 'timeout-generation',
    timeoutMs: 5,
  }));

  assert.ok(error instanceof RuntimeGenerationError);
  assert.equal(error.code, 'TIMEOUT_ABORT');
  assert.equal(error.generationId, 'timeout-generation');
  assert.equal(error.cause, abortError);
  assert.deepEqual(stoppedIds, ['timeout-generation']);
  assert.equal(error.diagnostics.stopAccepted, true);
  assert.equal(error.diagnostics.stopSettlementTimedOut, false);
  assert.equal(error.diagnostics.abortReason, 'TIMEOUT_ABORT');
  assert.equal(harness.listenerCount(), 0);
});

test('stop accepted with no settlement exits after the bounded grace and safely consumes late resolve and reject', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  const deferredResolve = createDeferred();
  const deferredReject = createDeferred();
  process.on('unhandledRejection', onUnhandled);

  try {
    const harnesses = [deferredResolve, deferredReject].map(deferred => createRuntime({
      generateRaw: () => deferred.promise,
      stopGenerationById: () => true,
    }));
    const startedAt = Date.now();
    const errors = await Promise.all(harnesses.map((harness, index) => getRejection(
      runRuntimeStreamingGeneration({
        capability: getRuntimeStreamingCapability(harness.host),
        messages,
        generationId: `late-settlement-${index}`,
        timeoutMs: 5,
      }),
    )));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs >= STOP_SETTLEMENT_GRACE_MS);
    assert.ok(elapsedMs < STOP_SETTLEMENT_GRACE_MS + 1000);
    for (const [index, error] of errors.entries()) {
      assert.equal(error.code, 'TIMEOUT_ABORT');
      assert.equal(error.diagnostics.stopAccepted, true);
      assert.equal(error.diagnostics.stopSettlementTimedOut, true);
      assert.equal(harnesses[index].listenerCount(), 0);
    }

    const finalDiagnostics = errors.map(error => ({ ...error.diagnostics }));
    deferredResolve.resolve('late success');
    deferredReject.reject(new Error('late rejection'));
    await delay(20);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(errors.map(error => ({ ...error.diagnostics })), finalDiagnostics);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('stop=false exits promptly with explicit diagnostics and cleans resources', async () => {
  const harness = createRuntime({
    generateRaw: () => new Promise(() => {}),
    stopGenerationById: () => false,
  });

  const error = await getRejection(runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: 'missing-cancel-target',
    timeoutMs: 5,
  }));

  assert.equal(error.code, 'TIMEOUT_ABORT');
  assert.equal(error.diagnostics.stopRequested, true);
  assert.equal(error.diagnostics.stopAccepted, false);
  assert.equal(error.diagnostics.stopError, '');
  assert.equal(error.diagnostics.stopSettlementTimedOut, false);
  assert.equal(error.diagnostics.abortReason, 'TIMEOUT_ABORT');
  assert.equal(harness.listenerCount(), 0);
});

test('stop throw and rejected stop result remain bounded with their original diagnostics', async () => {
  const stopErrors = [
    new Error('stop threw'),
    new Error('stop rejected'),
  ];
  const controllers = [new AbortController(), new AbortController()];
  const harnesses = stopErrors.map((stopError, index) => createRuntime({
    generateRaw: () => new Promise(() => {}),
    stopGenerationById: index === 0
      ? () => { throw stopError; }
      : () => Promise.reject(stopError),
  }));

  const pending = harnesses.map((harness, index) => runRuntimeStreamingGeneration({
    capability: getRuntimeStreamingCapability(harness.host),
    messages,
    generationId: `stop-error-${index}`,
    timeoutMs: 100,
    signal: controllers[index].signal,
  }));
  controllers.forEach(controller => controller.abort());
  const errors = await Promise.all(pending.map(getRejection));

  for (const [index, error] of errors.entries()) {
    assert.equal(error.code, 'USER_ABORT');
    assert.equal(error.cause, stopErrors[index]);
    assert.equal(error.diagnostics.stopRequested, true);
    assert.equal(error.diagnostics.stopAccepted, null);
    assert.equal(error.diagnostics.stopError, stopErrors[index].message);
    assert.equal(error.diagnostics.stopSettlementTimedOut, false);
    assert.equal(harnesses[index].listenerCount(), 0);
  }
});
