/** TavernHelper custom_api source for OpenAI-compatible secondary APIs. Not a Profile display name. */
export const SECONDARY_CUSTOM_API_SOURCE = 'openai';

/** Stream-only: Profile endpointPath cannot be safely mapped to custom_api.apiurl. */
export const STREAM_ENDPOINT_UNSUPPORTED = 'STREAM_ENDPOINT_UNSUPPORTED';

export const STREAM_ENDPOINT_UNSUPPORTED_MESSAGE = (
  '当前副 API 的 endpointPath 无法安全映射到 TavernHelper custom_api。'
  + '请使用标准 /v1/chat/completions 或 /chat/completions，'
  + '或关闭后台流式并继续使用 legacy 模式。'
);

const STANDARD_V1_CHAT_COMPLETIONS = '/v1/chat/completions';
const STANDARD_CHAT_COMPLETIONS = '/chat/completions';

export function normalizeApiPath(path) {
  const raw = String(path || '/v1/chat/completions').trim();
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function normalizeApiBaseUrl(url) {
  let normalized = String(url || '').trim().replace(/\/+$/, '');
  if (normalized.toLowerCase().endsWith('/v1')) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

/**
 * Normalize a bare URL for display / simple trim. Prefer deriveCustomApiBaseUrl for streaming.
 */
export function normalizeCustomApiUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function buildApiUrl(profile) {
  const baseUrl = normalizeApiBaseUrl(profile.baseUrl);
  if (!baseUrl) {
    throw new Error('请先填写请求地址。');
  }
  return `${baseUrl}${normalizeApiPath(profile.endpointPath)}`;
}

function createStreamEndpointUnsupportedError(profile, endpointPath) {
  const error = new Error(STREAM_ENDPOINT_UNSUPPORTED_MESSAGE);
  error.name = 'CustomApiMappingError';
  error.code = STREAM_ENDPOINT_UNSUPPORTED;
  error.diagnostics = Object.freeze({
    baseUrl: String(profile?.baseUrl ?? ''),
    endpointPath: String(endpointPath ?? profile?.endpointPath ?? ''),
  });
  return error;
}

/**
 * Derive TavernHelper custom_api.apiurl from Profile baseUrl + endpointPath.
 *
 * Uses the same root normalization as legacy buildApiUrl (strip trailing / and trailing /v1),
 * then absorbs only standard endpointPath semantics into the OpenAI-compatible API root:
 *
 * - /v1/chat/completions  → `{root}/v1`
 * - /chat/completions      → `{root}`
 *
 * Examples:
 * - base https://example.com + /v1/chat/completions → https://example.com/v1
 * - base https://example.com/v1 + /v1/chat/completions → https://example.com/v1 (no /v1/v1)
 * - base https://example.com + /chat/completions → https://example.com
 *
 * Non-standard paths, query strings, and fragments throw STREAM_ENDPOINT_UNSUPPORTED
 * before any generateRaw / fetch is started on the stream path.
 */
/**
 * Pure check: whether Profile endpointPath can be mapped to custom_api.apiurl.
 * Does not send network requests and does not require a complete baseUrl/model.
 */
export function isSecondaryEndpointStreamMappable(profile) {
  const rawEndpoint = String(profile?.endpointPath ?? '').trim();
  const endpointPath = normalizeApiPath(rawEndpoint || STANDARD_V1_CHAT_COMPLETIONS);
  if (endpointPath.includes('?') || endpointPath.includes('#')) {
    return false;
  }
  const pathOnly = endpointPath.replace(/\/+$/, '') || '/';
  const pathKey = pathOnly.toLowerCase();
  return (
    pathKey === STANDARD_V1_CHAT_COMPLETIONS
    || pathKey === STANDARD_CHAT_COMPLETIONS
  );
}

export function deriveCustomApiBaseUrl(profile) {
  const rawEndpoint = String(profile?.endpointPath ?? '').trim();
  const endpointPath = normalizeApiPath(rawEndpoint || STANDARD_V1_CHAT_COMPLETIONS);

  if (endpointPath.includes('?') || endpointPath.includes('#')) {
    throw createStreamEndpointUnsupportedError(profile, endpointPath);
  }

  const pathOnly = endpointPath.replace(/\/+$/, '') || '/';
  const pathKey = pathOnly.toLowerCase();
  const root = normalizeApiBaseUrl(profile?.baseUrl);
  if (!root) {
    throw new Error('请先填写请求地址。');
  }

  if (pathKey === STANDARD_V1_CHAT_COMPLETIONS) {
    return `${root}/v1`;
  }
  if (pathKey === STANDARD_CHAT_COMPLETIONS) {
    return root;
  }

  throw createStreamEndpointUnsupportedError(profile, pathOnly);
}

/**
 * Derive a temporary TavernHelper custom_api object from a Secondary Profile.
 * Does not mutate or persist the Profile schema.
 *
 * Mapping:
 * - baseUrl + endpointPath → apiurl via deriveCustomApiBaseUrl (legacy-equivalent root)
 * - apiKey → key (omitted when empty)
 * - model → model (trim only; namespaces preserved)
 * - source → fixed `openai` (never Profile.name)
 *
 * Generation sampling params (temperature, max_tokens, …) are not present on the
 * current legacy secondary requestBody, so none are invented here.
 */
export function buildCustomApiFromProfile(profile) {
  const apiurl = deriveCustomApiBaseUrl(profile);

  const model = String(profile?.model || '').trim();
  if (!model) {
    throw new Error('请先在设置页选择生成模型。');
  }

  const apiKey = String(profile?.apiKey || '').trim();
  const customApi = {
    apiurl,
    model,
    source: SECONDARY_CUSTOM_API_SOURCE,
  };
  if (apiKey) {
    customApi.key = apiKey;
  }
  return customApi;
}

/**
 * Diagnostic-safe custom_api view. Never includes API key or other secrets.
 */
export function sanitizeCustomApiForDiagnostics(customApi) {
  if (!customApi || typeof customApi !== 'object') return null;
  return {
    apiurl: String(customApi.apiurl || ''),
    model: String(customApi.model || ''),
    source: String(customApi.source || ''),
  };
}

export function buildModelListUrl(profile) {
  const baseUrl = normalizeApiBaseUrl(profile.baseUrl);
  if (!baseUrl) {
    throw new Error('请先填写请求地址。');
  }
  return `${baseUrl}/v1/models`;
}

export function parseModelListResponse(data) {
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return [...new Set(rawModels
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.id === 'string') return item.id;
      return '';
    })
    .filter(Boolean))];
}
