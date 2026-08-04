const GENERATION_ID_PREFIX = 'slx-main';
export const STOP_SETTLEMENT_GRACE_MS = 2000;

let generationSequence = 0;

function bindFunction(root, name) {
  const value = root?.[name];
  return typeof value === 'function' ? value.bind(root) : null;
}

function getEventCapability(runtimeRoot, host) {
  const eventRoot = (
    typeof runtimeRoot?.eventOn === 'function'
    && runtimeRoot?.iframe_events
  )
    ? runtimeRoot
    : host;

  const eventOn = bindFunction(eventRoot, 'eventOn');
  const iframeEvents = eventRoot?.iframe_events;
  if (!eventOn || !iframeEvents) return null;

  return Object.freeze({ eventOn, iframeEvents });
}

function createAvailableCapability(root, source, host) {
  const generateRaw = bindFunction(root, 'generateRaw');
  const stopGenerationById = bindFunction(root, 'stopGenerationById');
  if (!generateRaw || !stopGenerationById) return null;

  return Object.freeze({
    status: 'available',
    source,
    runtime: Object.freeze({
      generateRaw,
      stopGenerationById,
      events: getEventCapability(root, host),
    }),
  });
}

/**
 * 原子解析酒馆助手流式生成能力。generateRaw 与 stopGenerationById 只会从同一对象绑定，
 * 不扫描 iframe、DOM 或压缩后的内部变量。
 */
export function getRuntimeStreamingCapability(host = globalThis) {
  let discoveryError = null;

  try {
    const tavernHelperCapability = createAvailableCapability(
      host?.TavernHelper,
      'TavernHelper',
      host,
    );
    if (tavernHelperCapability) return tavernHelperCapability;
  } catch (error) {
    discoveryError = error;
  }

  try {
    const directCapability = createAvailableCapability(host, 'direct-global', host);
    if (directCapability) return directCapability;
  } catch (error) {
    discoveryError ||= error;
  }

  if (discoveryError) {
    return Object.freeze({
      status: 'error',
      source: '',
      error: discoveryError,
    });
  }

  return Object.freeze({
    status: 'unavailable',
    source: '',
    reason: 'generateRaw 与 stopGenerationById 未在同一运行时对象上同时出现。',
  });
}

export function supportsStreamingGeneration(host = globalThis) {
  return getRuntimeStreamingCapability(host).status === 'available';
}

export function createMainGenerationId(host = globalThis) {
  let uniquePart = '';
  try {
    uniquePart = host?.crypto?.randomUUID?.() || '';
  } catch {}

  if (!uniquePart) {
    generationSequence += 1;
    uniquePart = `${Date.now().toString(36)}-${generationSequence.toString(36)}`;
  }

  return `${GENERATION_ID_PREFIX}-${uniquePart}`;
}

export class RuntimeGenerationError extends Error {
  constructor(message, {
    code,
    generationId = '',
    diagnostics = {},
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeGenerationError';
    this.code = code;
    this.generationId = generationId;
    this.diagnostics = Object.freeze({ ...diagnostics });

    if (cause !== undefined && this.cause !== cause) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
        writable: true,
      });
    }
  }
}

function stopListeners(listeners) {
  for (const listener of listeners.splice(0)) {
    try {
      listener?.stop?.();
    } catch {}
  }
}

function registerStreamListeners(runtime, generationId, startedAt, stats) {
  const eventCapability = runtime.events;
  if (!eventCapability) return [];

  const { eventOn, iframeEvents } = eventCapability;
  const listeners = [];
  const markFirstChunk = () => {
    if (stats.firstChunkMs === null) {
      stats.firstChunkMs = Math.max(0, Date.now() - startedAt);
    }
  };

  const subscribe = (eventName, listener) => {
    if (!eventName) return;
    const subscription = eventOn(eventName, listener);
    if (subscription && typeof subscription.stop === 'function') {
      listeners.push(subscription);
    }
  };

  try {
    subscribe(iframeEvents.STREAM_TOKEN_RECEIVED_FULLY, (_text, id) => {
      if (id !== generationId) return;
      stats.fullChunkCount += 1;
      markFirstChunk();
    });
    subscribe(iframeEvents.STREAM_TOKEN_RECEIVED_INCREMENTALLY, (_text, id) => {
      if (id !== generationId) return;
      stats.incrementalChunkCount += 1;
      markFirstChunk();
    });
  } catch (error) {
    stopListeners(listeners);
    throw new RuntimeGenerationError('注册酒馆助手流式事件监听失败。', {
      code: 'RUNTIME_LISTENER_ERROR',
      generationId,
      cause: error,
    });
  }

  return listeners;
}

function createAbortError(code, generationId, cause, diagnostics = {}) {
  const message = code === 'TIMEOUT_ABORT'
    ? '酒馆主 API 流式生成超时并已请求停止。'
    : '酒馆主 API 流式生成已由用户取消。';
  return new RuntimeGenerationError(message, {
    code,
    generationId,
    diagnostics,
    cause,
  });
}

function waitWithinStopGrace(promise, deadline) {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    return Promise.resolve({ status: 'stop-settlement-timeout' });
  }

  let graceTimer = null;
  const gracePromise = new Promise(resolve => {
    graceTimer = setTimeout(
      () => resolve({ status: 'stop-settlement-timeout' }),
      remainingMs,
    );
  });

  return Promise.race([promise, gracePromise])
    .finally(() => clearTimeout(graceTimer));
}

function getAbortDiagnostics(abortState, stopOutcome, stopSettlementTimedOut) {
  return {
    generationId: abortState.generationId,
    stopRequested: true,
    stopAccepted: stopOutcome.accepted,
    stopError: stopOutcome.error
      ? String(stopOutcome.error?.message || stopOutcome.error)
      : '',
    stopSettlementTimedOut,
    abortReason: abortState.code,
  };
}

/**
 * 调用公开运行时流式合同，并且只以 generateRaw Promise 的 settlement 作为完成信号。
 */
export async function runRuntimeStreamingGeneration({
  capability = getRuntimeStreamingCapability(),
  messages,
  timeoutMs,
  signal,
  generationId = createMainGenerationId(),
} = {}) {
  if (capability?.status === 'error') {
    throw new RuntimeGenerationError('解析酒馆助手流式生成能力失败。', {
      code: 'RUNTIME_DISCOVERY_ERROR',
      generationId,
      cause: capability.error,
    });
  }
  if (capability?.status !== 'available') {
    throw new RuntimeGenerationError('当前环境不支持可取消的酒馆助手流式生成。', {
      code: 'RUNTIME_CAPABILITY_MISSING',
      generationId,
    });
  }

  const runtime = capability.runtime;
  const requestBody = {
    ordered_prompts: messages,
    should_stream: true,
    should_silence: true,
    generation_id: generationId,
  };

  if (signal?.aborted) {
    throw createAbortError('USER_ABORT', generationId, signal.reason, {
      generationId,
      stopRequested: false,
      stopAccepted: null,
      stopError: '',
      stopSettlementTimedOut: false,
      abortReason: 'USER_ABORT',
    });
  }

  const startedAt = Date.now();
  const stats = {
    firstChunkMs: null,
    fullChunkCount: 0,
    incrementalChunkCount: 0,
  };
  const listeners = registerStreamListeners(runtime, generationId, startedAt, stats);
  let timer = null;
  let removeAbortListener = null;
  let abortState = null;
  let notifyAbort = null;
  const abortPromise = new Promise(resolve => {
    notifyAbort = resolve;
  });

  const requestAbort = code => {
    if (abortState) return;

    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    abortState = {
      code,
      generationId,
      stopDeadline: Date.now() + STOP_SETTLEMENT_GRACE_MS,
      stopOutcomePromise: null,
    };
    try {
      const stopResult = runtime.stopGenerationById(generationId);
      abortState.stopOutcomePromise = Promise.resolve(stopResult).then(
        value => ({ accepted: value === true, error: null }),
        error => ({ accepted: null, error }),
      );
    } catch (error) {
      abortState.stopOutcomePromise = Promise.resolve({
        accepted: null,
        error,
      });
    }
    notifyAbort(abortState);
  };

  try {
    let generateResult;
    try {
      // 必须同步启动：调用者在本函数返回 Promise 后才能触发同轮 abort，
      // 从而保证 generateRaw 始终先于 stopGenerationById。
      generateResult = runtime.generateRaw(requestBody);
    } catch (error) {
      throw new RuntimeGenerationError('酒馆主 API 流式生成调用失败。', {
        code: 'NETWORK_ERROR',
        generationId,
        diagnostics: { generationId },
        cause: error,
      });
    }

    const settlementPromise = Promise.resolve(generateResult).then(
      value => ({ status: 'fulfilled', value }),
      error => ({ status: 'rejected', error }),
    );

    if (typeof signal?.addEventListener === 'function') {
      const onAbort = () => requestAbort('USER_ABORT');
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener?.('abort', onAbort);
    }

    // generateRaw 可能在同步启动期间触发外部 abort；此处补检仍保持 generate → stop 顺序。
    if (signal?.aborted) {
      requestAbort('USER_ABORT');
    }

    if (!abortState && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const remainingTimeoutMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
      if (remainingTimeoutMs === 0) {
        requestAbort('TIMEOUT_ABORT');
      } else {
        timer = setTimeout(() => requestAbort('TIMEOUT_ABORT'), remainingTimeoutMs);
      }
    }

    let settlement = await Promise.race([settlementPromise, abortPromise]);
    if (abortState) {
      let stopOutcome = await waitWithinStopGrace(
        abortState.stopOutcomePromise,
        abortState.stopDeadline,
      );
      if (stopOutcome.status === 'stop-settlement-timeout') {
        stopOutcome = {
          accepted: null,
          error: new Error('stopGenerationById 未在停止收尾窗口内返回。'),
        };
      }

      let stopSettlementTimedOut = false;
      if (stopOutcome.accepted === true) {
        settlement = await waitWithinStopGrace(
          settlementPromise,
          abortState.stopDeadline,
        );
        stopSettlementTimedOut = settlement.status === 'stop-settlement-timeout';
      }

      const cause = stopOutcome.error
        || (settlement?.status === 'rejected' ? settlement.error : undefined);
      throw createAbortError(
        abortState.code,
        generationId,
        cause,
        getAbortDiagnostics(abortState, stopOutcome, stopSettlementTimedOut),
      );
    }

    if (settlement.status === 'rejected') {
      throw new RuntimeGenerationError('酒馆主 API 流式生成调用失败。', {
        code: 'NETWORK_ERROR',
        generationId,
        diagnostics: { generationId },
        cause: settlement.error,
      });
    }

    return {
      requestBody,
      responseText: String(settlement.value || ''),
      transport: {
        mode: 'stream',
        generationId,
        firstChunkMs: stats.firstChunkMs,
        chunkCount: stats.incrementalChunkCount || stats.fullChunkCount,
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    removeAbortListener?.();
    stopListeners(listeners);
  }
}
