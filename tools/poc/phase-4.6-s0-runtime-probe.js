// Phase 4.6-S0 开发期手动探针：不被生产入口 import、不自动发起 API 请求，也不读取或保存 API Key。
(() => {
  'use strict';

  const PROBE_PREFIX = '[SLX-PHASE46-S0]';
  const RESULT_KEY = '__SLX_PHASE46_S0_RESULTS__';
  const AUTO_RUN_MODE = 'none';
  const BUTTONS = Object.freeze({
    identity: 'S0 身份',
    prompt: 'S0 prompt 对照',
    ordered: 'S0 ordered 对照',
    mainStream: 'S0 主流短测',
    mainCancel: 'S0 主流取消',
    secondaryStream: 'S0 副流短测',
  });
  const MARKERS = Object.freeze([
    'SYS_MARKER_',
    'USER_MARKER_',
    'ASSISTANT_MARKER_',
    'FINAL_USER_MARKER_',
  ]);

  const state = {
    probeVersion: 1,
    installedAt: new Date().toISOString(),
    runtime: null,
    runs: [],
  };

  function boundedText(value, limit = 600) {
    return String(value ?? '')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/(?:api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, 'credential=[REDACTED]')
      .slice(0, limit);
  }

  function summarizeFunction(value) {
    if (typeof value !== 'function') {
      return { exists: false, type: typeof value };
    }

    let source = '';
    try {
      source = Function.prototype.toString.call(value).slice(0, 900);
    } catch {
      source = '';
    }

    return {
      exists: true,
      type: typeof value,
      name: String(value.name || ''),
      length: Number(value.length),
      source: boundedText(source, 900),
    };
  }

  function serializeError(error) {
    if (!error) return null;
    return {
      name: boundedText(error.name || 'Error', 120),
      message: boundedText(error.message || error, 600),
      code: boundedText(error.code || '', 120),
      stage: boundedText(error.stage || '', 120),
      causeName: boundedText(error.cause?.name || '', 120),
      causeMessage: boundedText(error.cause?.message || '', 300),
    };
  }

  function publish(kind, value) {
    try {
      window[RESULT_KEY] = state;
    } catch {
      // The console output remains available if the iframe global cannot be inspected.
    }
    try {
      window.parent[RESULT_KEY] = state;
    } catch {
      // Sandboxed script iframes may reject parent writes.
    }
    console.info(`${PROBE_PREFIX} ${kind}`, JSON.stringify(value));
  }

  function buildRuntimeIdentity() {
    let context = null;
    let contextError = '';
    try {
      context = globalThis.SillyTavern?.getContext?.() || null;
    } catch (error) {
      contextError = boundedText(error?.message || error, 300);
    }

    return {
      recordedAt: new Date().toISOString(),
      generateRaw: summarizeFunction(globalThis.generateRaw),
      stopGenerationById: summarizeFunction(globalThis.stopGenerationById),
      stopAllGeneration: summarizeFunction(globalThis.stopAllGeneration),
      contextGenerateRaw: summarizeFunction(context?.generateRaw),
      eventOn: summarizeFunction(globalThis.eventOn),
      contextError,
    };
  }

  function makeGenerationId(label) {
    const suffix = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    return `slx-s0-${label}-${suffix}`;
  }

  function buildMarkerMessages(runTag, instruction) {
    return [
      { role: 'system', content: `SYS_MARKER_${runTag}\n${instruction}` },
      { role: 'user', content: `USER_MARKER_${runTag}\nThis is a transport audit.` },
      { role: 'assistant', content: `ASSISTANT_MARKER_${runTag}\nAcknowledged.` },
      { role: 'user', content: `FINAL_USER_MARKER_${runTag}\nReturn only S0_OK_${runTag}.` },
    ];
  }

  function contentLength(content) {
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
      return content.reduce((total, item) => {
        if (typeof item === 'string') return total + item.length;
        if (typeof item?.text === 'string') return total + item.text.length;
        return total;
      }, 0);
    }
    return 0;
  }

  function summarizePromptMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((message, index) => {
      const content = message?.content;
      let markerText = '';
      if (typeof content === 'string') {
        markerText = content;
      } else if (Array.isArray(content)) {
        markerText = content
          .map(item => (typeof item === 'string' ? item : String(item?.text || '')))
          .join('');
      }
      const detectedMarkers = MARKERS.filter(marker => markerText.includes(marker));
      if (detectedMarkers.includes('FINAL_USER_MARKER_')) {
        const genericUserIndex = detectedMarkers.indexOf('USER_MARKER_');
        if (genericUserIndex >= 0) detectedMarkers.splice(genericUserIndex, 1);
      }
      return {
        index,
        role: String(message?.role || ''),
        length: contentLength(content),
        markers: detectedMarkers,
      };
    });
  }

  function stopListeners(listeners) {
    for (const listener of listeners) {
      try {
        listener?.stop?.();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  function safeLastMessageId() {
    try {
      return typeof globalThis.getLastMessageId === 'function'
        ? globalThis.getLastMessageId()
        : null;
    } catch {
      return null;
    }
  }

  async function runGenerationProbe({ label, channel, config, expectedMarker, cancelAfterFirstChunk = false }) {
    const startedAt = Date.now();
    const generationId = config.generation_id;
    const run = {
      label,
      channel,
      streamRequested: config.should_stream === true,
      generationId,
      startedAt: new Date(startedAt).toISOString(),
      firstChunkMs: null,
      chunkCount: 0,
      fullChunkCount: 0,
      incrementalChunkCount: 0,
      generationStartedObserved: false,
      generationEndedObserved: false,
      eventGenerationIds: [],
      promptEvents: [],
      settingsEvents: [],
      messageIdBefore: safeLastMessageId(),
      messageIdAfter: null,
      resultType: '',
      resultLength: 0,
      resultContainsExpectedMarker: false,
      cancelSupported: typeof globalThis.stopGenerationById === 'function',
      cancelAttempted: false,
      cancelReturnValue: null,
      cancelAfterChunk: false,
      resolvedAfterCancel: false,
      rejectedAfterCancel: false,
      durationMs: 0,
      error: null,
    };
    const listeners = [];
    let firstChunkResolve;
    let firstChunkSettled = false;
    const firstChunkPromise = new Promise(resolve => {
      firstChunkResolve = resolve;
    });
    const recordGenerationId = id => {
      if (typeof id === 'string' && !run.eventGenerationIds.includes(id)) {
        run.eventGenerationIds.push(id);
      }
    };
    const recordChunk = (text, id, kind) => {
      if (id !== generationId) return;
      recordGenerationId(id);
      run.chunkCount += 1;
      if (kind === 'full') run.fullChunkCount += 1;
      if (kind === 'incremental') run.incrementalChunkCount += 1;
      if (run.firstChunkMs === null) {
        run.firstChunkMs = Date.now() - startedAt;
      }
      if (!firstChunkSettled) {
        firstChunkSettled = true;
        firstChunkResolve({ observed: true, length: String(text || '').length });
      }
    };

    try {
      if (typeof globalThis.eventOn === 'function' && globalThis.iframe_events) {
        listeners.push(
          eventOn(iframe_events.GENERATION_STARTED, id => {
            if (id !== generationId) return;
            run.generationStartedObserved = true;
            recordGenerationId(id);
          }),
          eventOn(iframe_events.STREAM_TOKEN_RECEIVED_FULLY, (text, id) => recordChunk(text, id, 'full')),
          eventOn(iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY, (text, id) => recordChunk(text, id, 'incremental')),
          eventOn(iframe_events.GENERATION_ENDED, (_text, id) => {
            if (id !== generationId) return;
            run.generationEndedObserved = true;
            recordGenerationId(id);
          }),
        );
      }

      if (typeof globalThis.eventOn === 'function' && globalThis.tavern_events) {
        listeners.push(
          eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, eventData => {
            run.promptEvents.push({
              dryRun: eventData?.dryRun === true,
              messages: summarizePromptMessages(eventData?.chat),
            });
          }),
          eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, data => {
            run.settingsEvents.push({
              model: boundedText(data?.model || '', 200),
              stream: data?.stream === true,
              maxTokens: Number.isFinite(data?.max_tokens) ? data.max_tokens : null,
              temperature: Number.isFinite(data?.temperature)
                ? data.temperature
                : Number.isFinite(data?.temprature) ? data.temprature : null,
            });
          }),
        );
      }

      if (typeof globalThis.generateRaw !== 'function') {
        throw new Error('generateRaw is not available in this script runtime.');
      }

      const generationPromise = Promise.resolve().then(() => globalThis.generateRaw(config));
      if (cancelAfterFirstChunk) {
        let firstChunkTimer = null;
        const firstChunkTimeout = new Promise(resolve => {
          firstChunkTimer = setTimeout(() => resolve({ observed: false, length: 0 }), 30000);
        });
        const firstChunk = await Promise.race([firstChunkPromise, firstChunkTimeout]);
        if (firstChunkTimer !== null) clearTimeout(firstChunkTimer);
        run.cancelAfterChunk = firstChunk.observed === true;
        run.cancelAttempted = true;
        run.cancelReturnValue = typeof globalThis.stopGenerationById === 'function'
          ? globalThis.stopGenerationById(generationId)
          : null;
      }

      try {
        const result = await generationPromise;
        const resultText = typeof result === 'string'
          ? result
          : typeof result?.content === 'string' ? result.content : '';
        run.resultType = Array.isArray(result) ? 'array' : typeof result;
        run.resultLength = resultText.length;
        run.resultContainsExpectedMarker = expectedMarker
          ? resultText.includes(expectedMarker)
          : false;
        run.resolvedAfterCancel = cancelAfterFirstChunk;
      } catch (error) {
        run.rejectedAfterCancel = cancelAfterFirstChunk;
        throw error;
      }
    } catch (error) {
      run.error = serializeError(error);
    } finally {
      if (!firstChunkSettled) {
        firstChunkSettled = true;
        firstChunkResolve({ observed: false, length: 0 });
      }
      stopListeners(listeners);
      run.messageIdAfter = safeLastMessageId();
      run.durationMs = Date.now() - startedAt;
      run.silentObserved = (
        run.messageIdBefore !== null
        && run.messageIdAfter !== null
        && run.messageIdBefore === run.messageIdAfter
      );
      state.runs.push(run);
      publish('run', run);
    }

    return run;
  }

  function makeShortRunTag(label) {
    return `${label}_${Date.now().toString(36)}`;
  }

  async function runPromptPath() {
    const runTag = makeShortRunTag('PROMPT');
    const expected = `S0_OK_${runTag}`;
    const messages = buildMarkerMessages(runTag, 'Preserve the four supplied messages and follow the final instruction.');
    return runGenerationProbe({
      label: 'main-prompt-nonstream',
      channel: 'main',
      config: {
        prompt: messages,
        should_stream: false,
        should_silence: true,
        generation_id: makeGenerationId('main-prompt'),
      },
      expectedMarker: expected,
    });
  }

  async function runOrderedPath({ stream = false } = {}) {
    const runTag = makeShortRunTag(stream ? 'STREAM' : 'ORDERED');
    const expected = `S0_OK_${runTag}`;
    const messages = buildMarkerMessages(runTag, 'Preserve the four supplied messages and follow the final instruction.');
    return runGenerationProbe({
      label: stream ? 'main-ordered-stream-short' : 'main-ordered-nonstream',
      channel: 'main',
      config: {
        ordered_prompts: messages,
        should_stream: stream,
        should_silence: true,
        generation_id: makeGenerationId(stream ? 'main-stream' : 'main-ordered'),
      },
      expectedMarker: expected,
    });
  }

  async function runMainCancel() {
    const runTag = makeShortRunTag('CANCEL');
    const messages = buildMarkerMessages(
      runTag,
      'Write at least 500 numbered one-sentence lines. Do not stop early.',
    );
    return runGenerationProbe({
      label: 'main-ordered-stream-cancel',
      channel: 'main',
      config: {
        ordered_prompts: messages,
        should_stream: true,
        should_silence: true,
        generation_id: makeGenerationId('main-cancel'),
      },
      expectedMarker: '',
      cancelAfterFirstChunk: true,
    });
  }

  function readSecondaryConfigInteractively() {
    const apiurl = window.prompt('S0 副 API：输入当前 Profile 的 Base URL。不会写入脚本或日志。', '');
    if (!apiurl) return null;
    const model = window.prompt('S0 副 API：输入当前 Profile 的模型名。', '');
    if (!model) return null;
    const source = window.prompt('S0 副 API：输入 source；OpenAI-compatible 通常为 openai。', 'openai');
    if (!source) return null;
    const key = window.prompt('S0 副 API：输入 API Key。只在本次请求内存中使用，不写入结果。', '');
    if (key === null) return null;
    return {
      apiurl: String(apiurl).trim(),
      model: String(model).trim(),
      source: String(source).trim(),
      key: String(key).trim(),
      max_tokens: 96,
    };
  }

  async function runSecondaryStream() {
    const customApi = readSecondaryConfigInteractively();
    if (!customApi) {
      publish('secondary-cancelled-before-request', { cancelled: true });
      return null;
    }
    const runTag = makeShortRunTag('SECONDARY');
    const expected = `S0_OK_${runTag}`;
    const messages = buildMarkerMessages(runTag, 'Follow the final instruction exactly.');
    return runGenerationProbe({
      label: 'secondary-custom-api-stream-short',
      channel: 'secondary',
      config: {
        ordered_prompts: messages,
        custom_api: customApi,
        should_stream: true,
        should_silence: true,
        generation_id: makeGenerationId('secondary-stream'),
      },
      expectedMarker: expected,
    });
  }

  function registerButton(name, handler) {
    eventOn(getButtonEvent(name), () => {
      Promise.resolve()
        .then(handler)
        .catch(error => publish('button-error', serializeError(error)));
    });
  }

  async function runMainShortSuite() {
    publish('auto-suite-start', { mode: AUTO_RUN_MODE });
    await runPromptPath();
    await runOrderedPath({ stream: false });
    await runOrderedPath({ stream: true });
    await runMainCancel();
    publish('auto-suite-end', {
      mode: AUTO_RUN_MODE,
      runCount: state.runs.length,
    });
  }

  function maybeStartAutoRun() {
    if (AUTO_RUN_MODE !== 'main-short-suite') return;
    setTimeout(() => {
      runMainShortSuite().catch(error => publish('auto-suite-error', serializeError(error)));
    }, 0);
  }

  state.runtime = buildRuntimeIdentity();
  publish('runtime', state.runtime);

  replaceScriptButtons(Object.values(BUTTONS).map(name => ({ name, visible: true })));
  registerButton(BUTTONS.identity, () => {
    state.runtime = buildRuntimeIdentity();
    publish('runtime', state.runtime);
  });
  registerButton(BUTTONS.prompt, runPromptPath);
  registerButton(BUTTONS.ordered, () => runOrderedPath({ stream: false }));
  registerButton(BUTTONS.mainStream, () => runOrderedPath({ stream: true }));
  registerButton(BUTTONS.mainCancel, runMainCancel);
  registerButton(BUTTONS.secondaryStream, runSecondaryStream);
  maybeStartAutoRun();
})();
