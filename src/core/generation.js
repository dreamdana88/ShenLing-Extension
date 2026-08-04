import {
  buildApiUrl,
  buildCustomApiFromProfile,
  sanitizeCustomApiForDiagnostics,
} from './api.js';
import {
  RuntimeGenerationError,
  createSecondaryGenerationId,
  getRuntimeStreamingCapability,
  runRuntimeStreamingGeneration,
} from './runtime-generation.js';

const RESPONSE_TEXT_LIMIT = 16384;
const SENSITIVE_QUERY_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'token',
  'access_token',
  'auth',
  'authorization',
  'cookie',
  'session',
]);

function getDurationMs(startedAt) {
  const durationMs = Date.now() - startedAt;
  return Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
}

function sanitizeSensitiveText(value, knownSecrets = []) {
  let sanitized = String(value ?? '');

  for (const secret of knownSecrets) {
    const normalized = String(secret || '');
    if (normalized) {
      sanitized = sanitized.split(normalized).join('[REDACTED]');
    }
  }

  return sanitized
    .replace(
      /(["']?(?:authorization|auth)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^"'\s,;&}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(["']?(?:api[_-]?key|apikey|access[_-]?token|token|cookie|session)["']?\s*[:=]\s*["']?)([^"'\s,;&}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
}

function sanitizeUrl(value, knownSecrets = []) {
  try {
    const url = new URL(String(value || ''));
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return sanitizeSensitiveText(url.toString(), knownSecrets);
  } catch {
    return '';
  }
}

function sanitizeResponseText(value, knownSecrets = []) {
  const sanitized = sanitizeSensitiveText(value, knownSecrets);
  return {
    responseText: sanitized.slice(0, RESPONSE_TEXT_LIMIT),
    responseTextTruncated: sanitized.length > RESPONSE_TEXT_LIMIT,
  };
}

function buildSafeDiagnostics(source = {}) {
  const diagnostics = {};

  if (source.provider === 'main' || source.provider === 'secondary') {
    diagnostics.provider = source.provider;
  }
  if (typeof source.profileName === 'string') {
    diagnostics.profileName = source.profileName;
  }
  if (typeof source.model === 'string') {
    diagnostics.model = source.model;
  }
  if (typeof source.url === 'string') {
    diagnostics.url = sanitizeUrl(source.url);
  }
  if (source.httpStatus === null || Number.isFinite(source.httpStatus)) {
    diagnostics.httpStatus = source.httpStatus;
  }
  if (Number.isFinite(source.messageCount) && source.messageCount >= 0) {
    diagnostics.messageCount = Math.floor(source.messageCount);
  }
  if (typeof source.stream === 'boolean') {
    diagnostics.stream = source.stream;
  }
  if (typeof source.generationId === 'string') {
    diagnostics.generationId = source.generationId.slice(0, 200);
  }
  if (typeof source.stopRequested === 'boolean') {
    diagnostics.stopRequested = source.stopRequested;
  }
  if (typeof source.stopAccepted === 'boolean' || source.stopAccepted === null) {
    diagnostics.stopAccepted = source.stopAccepted;
  }
  if (typeof source.stopError === 'string') {
    diagnostics.stopError = sanitizeSensitiveText(source.stopError).slice(0, 1024);
  }
  if (typeof source.stopSettlementTimedOut === 'boolean') {
    diagnostics.stopSettlementTimedOut = source.stopSettlementTimedOut;
  }
  if (source.abortReason === 'USER_ABORT' || source.abortReason === 'TIMEOUT_ABORT') {
    diagnostics.abortReason = source.abortReason;
  }
  if (typeof source.responseText === 'string') {
    const safeResponse = sanitizeResponseText(source.responseText);
    diagnostics.responseText = safeResponse.responseText;
    diagnostics.responseTextTruncated = (
      source.responseTextTruncated === true
      || safeResponse.responseTextTruncated
    );
  }
  if (Number.isFinite(source.durationMs) && source.durationMs >= 0) {
    diagnostics.durationMs = source.durationMs;
  }

  return Object.freeze(diagnostics);
}

export class GenerationTransportError extends Error {
  constructor(
    message,
    {
      code,
      stage,
      diagnostics,
      cause,
    } = {},
  ) {
    const hasCause = cause !== undefined;
    super(message, hasCause ? { cause } : undefined);

    this.name = 'GenerationTransportError';
    this.code = code;
    this.stage = stage;
    this.diagnostics = buildSafeDiagnostics(diagnostics);

    if (hasCause && this.cause !== cause) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
        writable: true,
      });
    }
  }
}

export function getGenerationErrorContext(error) {
  if (!(error instanceof GenerationTransportError)) return null;

  return Object.freeze({
    code: error.code,
    stage: error.stage,
    diagnostics: Object.freeze({
      ...error.diagnostics,
    }),
  });
}

function getMainGenerateRaw() {
  if (typeof globalThis.generateRaw === 'function') {
    return globalThis.generateRaw;
  }

  const context = globalThis.SillyTavern?.getContext?.();
  return typeof context?.generateRaw === 'function' ? context.generateRaw : null;
}

function runWithTimeout(task, timeoutMs, createTimeoutError) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(task);
  }

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(createTimeoutError()),
      timeoutMs,
    );
  });

  return Promise.race([
    Promise.resolve().then(task),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

function getOpenAiChatCompletionContent(data) {
  const firstChoice = data?.choices?.[0];
  const messageContent = firstChoice?.message?.content;
  if (typeof messageContent === 'string') return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map(item => (typeof item === 'string' ? item : item?.text || ''))
      .join('');
  }
  if (typeof firstChoice?.text === 'string') return firstChoice.text;
  return '';
}

export async function generateWithMainApi({
  messages,
  timeoutMs,
  timeoutMessage = '生成超时，请稍后重试。',
  signal,
  transportMode = 'legacy',
}) {
  const startedAt = Date.now();
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const useStreaming = transportMode === 'stream';

  if (useStreaming) {
    let streamingCapability;
    try {
      streamingCapability = getRuntimeStreamingCapability();
      if (streamingCapability.status === 'error') {
        throw streamingCapability.error;
      }
    } catch (error) {
      const originalMessage = sanitizeSensitiveText(error?.message || String(error));
      throw new GenerationTransportError(
        `解析酒馆主 API 流式 Provider 失败：${originalMessage}`,
        {
          code: 'MAIN_PROVIDER_RESOLUTION_FAILED',
          stage: 'resolve_provider',
          diagnostics: {
            provider: 'main',
            messageCount,
            stream: true,
            durationMs: getDurationMs(startedAt),
          },
          cause: error,
        },
      );
    }

    if (streamingCapability.status !== 'available') {
      throw new GenerationTransportError(
        '当前环境缺少成对的 generateRaw 与 stopGenerationById，无法使用主 API 流式传输。',
        {
          code: 'STREAM_UNAVAILABLE',
          stage: 'resolve_provider',
          diagnostics: {
            provider: 'main',
            messageCount,
            stream: true,
            durationMs: getDurationMs(startedAt),
          },
        },
      );
    }

    try {
      const streamResult = await runRuntimeStreamingGeneration({
        capability: streamingCapability,
        messages,
        timeoutMs,
        signal,
      });
      return {
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url: '酒馆当前连接',
        requestBody: streamResult.requestBody,
        responseText: streamResult.responseText,
        content: streamResult.responseText,
        transport: streamResult.transport,
      };
    } catch (error) {
      if (!(error instanceof RuntimeGenerationError)) throw error;

      const code = (
        error.code === 'USER_ABORT'
        || error.code === 'TIMEOUT_ABORT'
        || error.code === 'NETWORK_ERROR'
      )
        ? error.code
        : 'MAIN_PROVIDER_FAILED';
      const message = code === 'TIMEOUT_ABORT'
        ? sanitizeSensitiveText(timeoutMessage)
        : code === 'USER_ABORT'
          ? '酒馆主 API 生成已取消。'
          : `酒馆主 API 流式生成失败：${sanitizeSensitiveText(
            error.cause?.message || error.message,
          )}`;
      throw new GenerationTransportError(message, {
        code,
        stage: 'send_request',
        diagnostics: {
          provider: 'main',
          messageCount,
          stream: true,
          ...error.diagnostics,
          durationMs: getDurationMs(startedAt),
        },
        cause: error.cause || error,
      });
    }
  }

  let generateRaw;
  try {
    generateRaw = getMainGenerateRaw();
  } catch (error) {
    // Provider 解析阶段异常（例如 getContext() 自身抛错），不得伪装成 Provider 缺失，也不回退副 API。
    const originalMessage = sanitizeSensitiveText(error?.message || String(error));
    throw new GenerationTransportError(
      `解析酒馆主 API Provider 失败：${originalMessage}`,
      {
        code: 'MAIN_PROVIDER_RESOLUTION_FAILED',
        stage: 'resolve_provider',
        diagnostics: {
          provider: 'main',
          messageCount,
          durationMs: getDurationMs(startedAt),
        },
        cause: error,
      },
    );
  }
  if (typeof generateRaw !== 'function') {
    throw new GenerationTransportError(
      '当前环境未发现 generateRaw，无法调用酒馆主 API。',
      {
        code: 'MAIN_PROVIDER_MISSING',
        stage: 'resolve_provider',
        diagnostics: {
          provider: 'main',
          messageCount,
          durationMs: getDurationMs(startedAt),
        },
      },
    );
  }

  const requestBody = { prompt: messages };
  let responseText;
  try {
    responseText = await runWithTimeout(
      () => generateRaw(requestBody),
      timeoutMs,
      () => new GenerationTransportError(
        sanitizeSensitiveText(timeoutMessage),
        {
          code: 'MAIN_TIMEOUT',
          stage: 'send_request',
          diagnostics: {
            provider: 'main',
            messageCount,
            durationMs: getDurationMs(startedAt),
          },
        },
      ),
    );
  } catch (error) {
    if (
      error instanceof GenerationTransportError
      && error.code === 'MAIN_TIMEOUT'
    ) {
      throw error;
    }

    const originalMessage = sanitizeSensitiveText(error?.message || String(error));
    throw new GenerationTransportError(
      `酒馆主 API 生成失败：${originalMessage}`,
      {
        code: 'MAIN_PROVIDER_FAILED',
        stage: 'send_request',
        diagnostics: {
          provider: 'main',
          messageCount,
          durationMs: getDurationMs(startedAt),
        },
        cause: error,
      },
    );
  }

  return {
    profileName: '酒馆当前连接',
    model: '酒馆主 API',
    url: '酒馆当前连接',
    requestBody,
    responseText: String(responseText || ''),
    content: String(responseText || ''),
  };
}

function buildSecondaryStreamDiagnosticRequestBody(messages, model, customApi) {
  return {
    model,
    messages,
    stream: true,
    ordered_prompts: messages,
    custom_api: sanitizeCustomApiForDiagnostics(customApi),
    should_stream: true,
    should_silence: true,
  };
}

export async function generateWithSecondaryApi({
  profile,
  messages,
  timeoutMs,
  timeoutMessage = '生成超时，请稍后重试。',
  signal,
  transportMode = 'legacy',
}) {
  const startedAt = Date.now();
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const useStreaming = transportMode === 'stream';

  if (!profile) {
    throw new GenerationTransportError('当前环境未提供副 API 配置。', {
      code: 'SECONDARY_PROFILE_MISSING',
      stage: 'resolve_provider',
      diagnostics: {
        provider: 'secondary',
        messageCount,
        stream: useStreaming,
        durationMs: getDurationMs(startedAt),
      },
    });
  }

  const profileName = profile.name || '未命名副 API';
  const model = String(profile.model || '').trim();
  if (!model) {
    throw new GenerationTransportError('请先在设置页选择生成模型。', {
      code: 'SECONDARY_MODEL_MISSING',
      stage: 'build_request',
      diagnostics: {
        provider: 'secondary',
        profileName,
        messageCount,
        stream: useStreaming,
        durationMs: getDurationMs(startedAt),
      },
    });
  }

  const apiKey = String(profile.apiKey || '').trim();
  let url;
  try {
    url = buildApiUrl(profile);
  } catch (error) {
    const originalMessage = sanitizeSensitiveText(
      error?.message || String(error),
      [apiKey],
    );
    throw new GenerationTransportError(
      `无法构建副 API 请求地址：${originalMessage}`,
      {
        code: 'SECONDARY_URL_BUILD_FAILED',
        stage: 'build_request',
        diagnostics: {
          provider: 'secondary',
          profileName,
          model,
          url: '',
          messageCount,
          stream: useStreaming,
          durationMs: getDurationMs(startedAt),
        },
        cause: error,
      },
    );
  }
  const safeUrl = sanitizeUrl(url, [apiKey]);

  if (useStreaming) {
    let streamingCapability;
    try {
      streamingCapability = getRuntimeStreamingCapability();
      if (streamingCapability.status === 'error') {
        throw streamingCapability.error;
      }
    } catch (error) {
      const originalMessage = sanitizeSensitiveText(
        error?.message || String(error),
        [apiKey],
      );
      throw new GenerationTransportError(
        `解析副 API 流式 Provider 失败：${originalMessage}`,
        {
          code: 'STREAM_UNAVAILABLE',
          stage: 'resolve_provider',
          diagnostics: {
            provider: 'secondary',
            profileName,
            model,
            url: safeUrl,
            messageCount,
            stream: true,
            durationMs: getDurationMs(startedAt),
          },
          cause: error,
        },
      );
    }

    if (streamingCapability.status !== 'available') {
      throw new GenerationTransportError(
        '当前环境缺少成对的 generateRaw 与 stopGenerationById，无法使用副 API 流式传输。',
        {
          code: 'STREAM_UNAVAILABLE',
          stage: 'resolve_provider',
          diagnostics: {
            provider: 'secondary',
            profileName,
            model,
            url: safeUrl,
            messageCount,
            stream: true,
            durationMs: getDurationMs(startedAt),
          },
        },
      );
    }

    let customApi;
    try {
      customApi = buildCustomApiFromProfile(profile);
    } catch (error) {
      const originalMessage = sanitizeSensitiveText(
        error?.message || String(error),
        [apiKey],
      );
      throw new GenerationTransportError(
        `无法构建副 API custom_api：${originalMessage}`,
        {
          code: 'SECONDARY_URL_BUILD_FAILED',
          stage: 'build_request',
          diagnostics: {
            provider: 'secondary',
            profileName,
            model,
            url: safeUrl,
            messageCount,
            stream: true,
            durationMs: getDurationMs(startedAt),
          },
          cause: error,
        },
      );
    }

    const generationId = createSecondaryGenerationId();
    const diagnosticRequestBody = buildSecondaryStreamDiagnosticRequestBody(
      messages,
      model,
      customApi,
    );

    try {
      const streamResult = await runRuntimeStreamingGeneration({
        capability: streamingCapability,
        messages,
        timeoutMs,
        signal,
        generationId,
        customApi,
      });

      const content = String(streamResult.responseText || '');
      if (!content.trim()) {
        throw new GenerationTransportError(
          '副 API 接口响应中缺少可用模型正文。',
          {
            code: 'SECONDARY_CONTENT_MISSING',
            stage: 'extract_content',
            diagnostics: {
              provider: 'secondary',
              profileName,
              model,
              url: safeUrl,
              messageCount,
              stream: true,
              generationId,
              responseText: '',
              responseTextTruncated: false,
              durationMs: getDurationMs(startedAt),
            },
          },
        );
      }

      // Stream path has no OpenAI chat-completions JSON envelope from TavernHelper.
      // Keep responseJson present as null; never fabricate a provider JSON object.
      return {
        profileName,
        model,
        url,
        httpStatus: null,
        requestBody: diagnosticRequestBody,
        responseText: content,
        responseJson: null,
        content,
        transport: {
          mode: 'stream',
          source: streamingCapability.source || 'TavernHelper',
          generationId: streamResult.transport.generationId,
          firstChunkMs: streamResult.transport.firstChunkMs,
          chunkCount: streamResult.transport.chunkCount,
          durationMs: getDurationMs(startedAt),
        },
      };
    } catch (error) {
      if (error instanceof GenerationTransportError) throw error;
      if (!(error instanceof RuntimeGenerationError)) throw error;

      const code = (
        error.code === 'USER_ABORT'
        || error.code === 'TIMEOUT_ABORT'
        || error.code === 'NETWORK_ERROR'
      )
        ? error.code
        : 'SECONDARY_FETCH_FAILED';
      const message = code === 'TIMEOUT_ABORT'
        ? sanitizeSensitiveText(timeoutMessage, [apiKey])
        : code === 'USER_ABORT'
          ? '副 API 生成已取消。'
          : `副 API 流式生成失败：${sanitizeSensitiveText(
            error.cause?.message || error.message,
            [apiKey],
          )}`;
      throw new GenerationTransportError(message, {
        code,
        stage: 'send_request',
        diagnostics: {
          provider: 'secondary',
          profileName,
          model,
          url: safeUrl,
          messageCount,
          stream: true,
          ...error.diagnostics,
          durationMs: getDurationMs(startedAt),
        },
        cause: error.cause || error,
      });
    }
  }

  const requestBody = {
    model,
    messages,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response;
  let responseText;
  let currentStage = 'send_request';
  let didTimeout = false;
  let timeoutStage = 'send_request';
  let timeoutTimer = null;
  const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const controller = timeoutEnabled ? new AbortController() : null;
  const fetchOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  };
  if (controller) {
    fetchOptions.signal = controller.signal;
  }

  const networkTask = Promise.resolve().then(async () => {
    response = await fetch(url, fetchOptions);
    currentStage = 'read_response';
    responseText = await response.text();
  });

  let timeoutPromise = null;
  if (timeoutEnabled) {
    timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        if (didTimeout) return;

        didTimeout = true;
        timeoutStage = currentStage;
        let abortCause;
        try {
          controller.abort();
        } catch (error) {
          abortCause = error;
        }

        reject(new GenerationTransportError(
          sanitizeSensitiveText(timeoutMessage, [apiKey]),
          {
            code: 'SECONDARY_TIMEOUT',
            stage: timeoutStage,
            diagnostics: {
              provider: 'secondary',
              profileName,
              model,
              url: safeUrl,
              httpStatus: (
                timeoutStage === 'read_response'
                && Number.isFinite(response?.status)
              )
                ? response.status
                : null,
              messageCount,
              stream: false,
              responseText: '',
              responseTextTruncated: false,
              durationMs: getDurationMs(startedAt),
            },
            cause: abortCause,
          },
        ));
      }, timeoutMs);
    });
  }

  try {
    if (timeoutPromise) {
      await Promise.race([networkTask, timeoutPromise]);
    } else {
      await networkTask;
    }
  } catch (error) {
    if (didTimeout) {
      throw error;
    }

    const originalMessage = sanitizeSensitiveText(
      error?.message || String(error),
      [apiKey],
    );
    if (currentStage === 'read_response') {
      throw new GenerationTransportError(
        `读取副 API 响应正文失败：${originalMessage}`,
        {
          code: 'SECONDARY_BODY_READ_FAILED',
          stage: 'read_response',
          diagnostics: {
            provider: 'secondary',
            profileName,
            model,
            url: safeUrl,
            httpStatus: Number.isFinite(response?.status) ? response.status : null,
            messageCount,
            stream: false,
            durationMs: getDurationMs(startedAt),
          },
          cause: error,
        },
      );
    }

    throw new GenerationTransportError(
      `副 API 请求发送失败：${originalMessage}`,
      {
        code: 'SECONDARY_FETCH_FAILED',
        stage: 'send_request',
        diagnostics: {
          provider: 'secondary',
          profileName,
          model,
          url: safeUrl,
          messageCount,
          stream: false,
          durationMs: getDurationMs(startedAt),
        },
        cause: error,
      },
    );
  } finally {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
    }
  }

  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    const safeResponse = sanitizeResponseText(responseText, [apiKey]);
    const safeStatusText = sanitizeSensitiveText(
      response.statusText || '',
      [apiKey],
    ).slice(0, 128);
    const statusSummary = safeStatusText
      ? `${response.status} ${safeStatusText}`
      : String(response.status);
    throw new GenerationTransportError(
      `副 API 请求失败（HTTP ${statusSummary}）。`,
      {
        code: 'SECONDARY_HTTP_ERROR',
        stage: 'read_response',
        diagnostics: {
          provider: 'secondary',
          profileName,
          model,
          url: safeUrl,
          httpStatus: Number.isFinite(response.status) ? response.status : null,
          messageCount,
          stream: false,
          ...safeResponse,
          durationMs: getDurationMs(startedAt),
        },
      },
    );
  }

  const content = responseJson
    ? getOpenAiChatCompletionContent(responseJson)
    : responseText;
  if (!String(content || '').trim()) {
    const safeResponse = sanitizeResponseText(responseText, [apiKey]);
    throw new GenerationTransportError(
      '副 API 接口响应中缺少可用模型正文。',
      {
        code: 'SECONDARY_CONTENT_MISSING',
        stage: 'extract_content',
        diagnostics: {
          provider: 'secondary',
          profileName,
          model,
          url: safeUrl,
          httpStatus: Number.isFinite(response.status) ? response.status : null,
          messageCount,
          stream: false,
          ...safeResponse,
          durationMs: getDurationMs(startedAt),
        },
      },
    );
  }

  return {
    profileName,
    model,
    url,
    httpStatus: `${response.status} ${response.statusText}`,
    requestBody,
    responseText,
    responseJson,
    content,
  };
}
