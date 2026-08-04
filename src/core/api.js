/** TavernHelper custom_api source for OpenAI-compatible secondary APIs. Not a Profile display name. */
export const SECONDARY_CUSTOM_API_SOURCE = 'openai';

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
 * Normalize Profile baseUrl for TavernHelper custom_api.apiurl.
 * Only trims and strips trailing slashes; does not strip `/v1` and does not append
 * endpointPath (TavernHelper / ST openai-compatible source owns path construction).
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

/**
 * Derive a temporary TavernHelper custom_api object from a Secondary Profile.
 * Does not mutate or persist the Profile schema.
 *
 * Mapping (S0-verified OpenAI-compatible contract):
 * - baseUrl → apiurl (trim + strip trailing / only)
 * - apiKey → key (omitted when empty)
 * - model → model (trim only; namespaces preserved)
 * - source → fixed `openai` (never Profile.name)
 * - endpointPath is intentionally not mapped: custom_api has no endpointPath field;
 *   diagnostic legacy URL continues to use buildApiUrl(profile).
 *
 * Generation sampling params (temperature, max_tokens, …) are not present on the
 * current legacy secondary requestBody, so none are invented here.
 */
export function buildCustomApiFromProfile(profile) {
  const apiurl = normalizeCustomApiUrl(profile?.baseUrl);
  if (!apiurl) {
    throw new Error('请先填写请求地址。');
  }

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
