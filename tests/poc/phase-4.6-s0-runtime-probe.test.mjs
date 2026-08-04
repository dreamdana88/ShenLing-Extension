import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const probeSource = await readFile(
  new URL('../../tools/poc/phase-4.6-s0-runtime-probe.js', import.meta.url),
  'utf8',
);

function createHarness({ failGeneration = false } = {}) {
  const logs = [];
  const buttons = [];
  const buttonHandlers = new Map();
  const listeners = new Map();
  const requests = [];
  const stoppedGenerationIds = [];
  const timerState = { created: 0, cleared: 0 };
  let uuidCounter = 0;

  const iframeEvents = {
    GENERATION_STARTED: 'iframe_generation_started',
    STREAM_TOKEN_RECEIVED_FULLY: 'iframe_stream_full',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'iframe_stream_incremental',
    GENERATION_ENDED: 'iframe_generation_ended',
  };
  const tavernEvents = {
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  };

  function emit(eventName, ...args) {
    for (const entry of listeners.get(eventName) || []) {
      if (entry.active) entry.listener(...args);
    }
  }

  const context = {
    console: {
      info(...args) {
        logs.push(args.map(String).join(' '));
      },
    },
    crypto: {
      randomUUID() {
        uuidCounter += 1;
        return `uuid-${uuidCounter}`;
      },
    },
    Date,
    JSON,
    Math,
    Promise,
    String,
    Array,
    Number,
    Object,
    RegExp,
    Error,
    iframe_events: iframeEvents,
    tavern_events: tavernEvents,
    getButtonEvent(name) {
      return `button:${name}`;
    },
    eventOn(eventName, listener) {
      if (String(eventName).startsWith('button:')) {
        buttonHandlers.set(eventName, listener);
      }
      const entry = { active: true, listener, stopCount: 0 };
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(entry);
      return {
        stop() {
          entry.stopCount += 1;
          entry.active = false;
        },
      };
    },
    replaceScriptButtons(value) {
      buttons.push(...value);
    },
    getLastMessageId() {
      return 7;
    },
    stopGenerationById(generationId) {
      stoppedGenerationIds.push(generationId);
      return true;
    },
    stopAllGeneration() {
      return true;
    },
    setTimeout(callback, delay) {
      timerState.created += 1;
      return setTimeout(callback, delay);
    },
    clearTimeout(timer) {
      timerState.cleared += 1;
      clearTimeout(timer);
    },
    async generateRaw(config) {
      requests.push(config);
      if (failGeneration) {
        throw new Error('Authorization: Bearer top-secret api_key=also-secret');
      }

      const messages = config.ordered_prompts || config.prompt || [];
      emit(iframeEvents.GENERATION_STARTED, config.generation_id);
      emit(tavernEvents.CHAT_COMPLETION_PROMPT_READY, { chat: messages, dryRun: false });
      emit(tavernEvents.CHAT_COMPLETION_SETTINGS_READY, {
        model: 'mock-model',
        stream: config.should_stream === true,
        max_tokens: 96,
        temperature: 0.5,
      });
      if (config.should_stream) {
        emit(iframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY, 'S0_', config.generation_id);
        emit(iframeEvents.STREAM_TOKEN_RECEIVED_FULLY, 'S0_OK', config.generation_id);
      }
      const finalContent = String(messages.at(-1)?.content || '');
      const expectedMarker = finalContent.match(/S0_OK_[A-Z]+_[a-z0-9]+/)?.[0] || 'S0_OK';
      emit(iframeEvents.GENERATION_ENDED, expectedMarker, config.generation_id);
      return expectedMarker;
    },
  };
  context.window = context;
  context.window.parent = context;
  context.globalThis = context;

  vm.runInNewContext(probeSource, context, { filename: 'phase-4.6-s0-runtime-probe.js' });

  async function runButton(name) {
    const handler = buttonHandlers.get(`button:${name}`);
    assert.equal(typeof handler, 'function', `missing button handler: ${name}`);
    const previousRunLogCount = logs.filter(line => line.startsWith('[SLX-PHASE46-S0] run ')).length;
    handler();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const nextRunLogCount = logs.filter(line => line.startsWith('[SLX-PHASE46-S0] run ')).length;
      if (nextRunLogCount > previousRunLogCount) return;
    }
    assert.fail(`button did not publish a run result: ${name}`);
  }

  return {
    buttons,
    buttonHandlers,
    listeners,
    logs,
    requests,
    runButton,
    stoppedGenerationIds,
    timerState,
  };
}

function parseRunLogs(logs) {
  return logs
    .filter(line => line.startsWith('[SLX-PHASE46-S0] run '))
    .map(line => JSON.parse(line.slice('[SLX-PHASE46-S0] run '.length)));
}

test('probe registers isolated controls and publishes only bounded runtime identity', () => {
  const harness = createHarness();
  assert.deepEqual(
    harness.buttons.map(button => button.name),
    ['S0 身份', 'S0 prompt 对照', 'S0 ordered 对照', 'S0 主流短测', 'S0 主流取消', 'S0 副流短测'],
  );
  assert.ok(harness.logs.some(line => line.startsWith('[SLX-PHASE46-S0] runtime ')));
  assert.equal(harness.requests.length, 0, 'loading the probe must not start a model request');
});

test('stream probe records unique generation ids, chunk stats, prompt markers, and releases listeners', async () => {
  const harness = createHarness();
  await harness.runButton('S0 主流短测');
  await harness.runButton('S0 ordered 对照');

  const runs = parseRunLogs(harness.logs);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].generationId, runs[1].generationId);
  assert.equal(runs[0].streamRequested, true);
  assert.equal(runs[0].chunkCount, 2);
  assert.equal(runs[0].incrementalChunkCount, 1);
  assert.equal(runs[0].fullChunkCount, 1);
  assert.equal(runs[0].silentObserved, true);
  assert.equal(runs[0].resultContainsExpectedMarker, true);
  assert.deepEqual(
    runs[0].promptEvents[0].messages.map(message => message.role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.deepEqual(
    runs[0].promptEvents[0].messages.flatMap(message => message.markers),
    ['SYS_MARKER_', 'USER_MARKER_', 'ASSISTANT_MARKER_', 'FINAL_USER_MARKER_'],
  );

  for (const eventName of [
    'iframe_generation_started',
    'iframe_stream_full',
    'iframe_stream_incremental',
    'iframe_generation_ended',
    'chat_completion_prompt_ready',
    'chat_completion_settings_ready',
  ]) {
    const probeListeners = harness.listeners.get(eventName) || [];
    assert.ok(probeListeners.length >= 2);
    assert.ok(probeListeners.every(listener => listener.active === false && listener.stopCount === 1));
  }
});

test('cancel probe clears its first-chunk timer and targets only its own generation id', async () => {
  const harness = createHarness();
  await harness.runButton('S0 主流取消');

  const [run] = parseRunLogs(harness.logs);
  assert.equal(run.cancelAfterChunk, true);
  assert.equal(run.cancelAttempted, true);
  assert.equal(run.cancelReturnValue, true);
  assert.deepEqual(harness.stoppedGenerationIds, [run.generationId]);
  assert.ok(harness.timerState.created >= 1);
  assert.equal(harness.timerState.cleared, harness.timerState.created);
});

test('errors are serialized without credential values', async () => {
  const harness = createHarness({ failGeneration: true });
  await harness.runButton('S0 prompt 对照');

  const output = harness.logs.join('\n');
  assert.doesNotMatch(output, /top-secret|also-secret/);
  assert.match(output, /\[REDACTED\]/);
  const [run] = parseRunLogs(harness.logs);
  assert.equal(run.error.name, 'Error');
});
