const GENERATION_ID_PREFIX = 'slx-main';

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
  constructor(message, { code, generationId = '', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeGenerationError';
    this.code = code;
    this.generationId = generationId;

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

function createAbortError(code, generationId, cause) {
  const message = code === 'TIMEOUT_ABORT'
    ? '酒馆主 API 流式生成超时并已请求停止。'
    : '酒馆主 API 流式生成已由用户取消。';
  return new RuntimeGenerationError(message, {
    code,
    generationId,
    cause,
  });
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

    abortState = { code, cancelResult: false, error: null };
    try {
      abortState.cancelResult = runtime.stopGenerationById(generationId) === true;
    } catch (error) {
      abortState.error = error;
    }
    notifyAbort(abortState);
  };

  try {
    if (signal?.aborted) {
      throw createAbortError('USER_ABORT', generationId, signal.reason);
    }

    if (typeof signal?.addEventListener === 'function') {
      const onAbort = () => requestAbort('USER_ABORT');
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener?.('abort', onAbort);
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => requestAbort('TIMEOUT_ABORT'), timeoutMs);
    }

    const settlementPromise = Promise.resolve()
      .then(() => runtime.generateRaw(requestBody))
      .then(
        value => ({ status: 'fulfilled', value }),
        error => ({ status: 'rejected', error }),
      );

    let settlement = await Promise.race([settlementPromise, abortPromise]);
    if (abortState) {
      if (abortState.cancelResult) {
        settlement = await settlementPromise;
      }
      const cause = abortState.error
        || (settlement?.status === 'rejected' ? settlement.error : undefined);
      throw createAbortError(abortState.code, generationId, cause);
    }

    if (settlement.status === 'rejected') {
      throw new RuntimeGenerationError('酒馆主 API 流式生成调用失败。', {
        code: 'NETWORK_ERROR',
        generationId,
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
