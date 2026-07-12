// 设定采集生成流程：材料预检、独立请求、严格 JSON 解析与草稿追加。

import { buildApiUrl } from '../../core/api.js';
import {
  getGlobalSettings,
  getMemoirState,
  saveChatState,
} from '../../core/settings.js';
import { getOpenAiResponseContent } from '../../core/summary.js';
import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  appendCaptureDrafts,
  normalizeCaptureDraft,
  normalizeCaptureState,
} from './capture-model.js';
import {
  buildCaptureOptionalContextMaterial,
  buildCaptureSourceMaterial,
} from './capture-materials.js';
import { buildCapturePromptMessages } from './capture-prompt.js';

const CAPTURE_GENERATION_TIMEOUT_MS = 180000;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getGenerateRawFunction: null,
};

export function configureCaptureWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function withTimeout(promise, timeoutMs = CAPTURE_GENERATION_TIMEOUT_MS) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('设定采集生成超时，请稍后重试。')),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const matched = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (matched?.[1] || raw).trim();
}

function createParseFailure(rawResponse, jsonText, code, message, details = {}) {
  return {
    ok: false,
    rawResponse: String(rawResponse || ''),
    jsonText: String(jsonText || ''),
    entries: [],
    error: { code, message, details },
  };
}

/** 严格接受 JSON（允许完整 JSON 代码围栏），并只把模型内容字段交给草稿标准化。 */
export function parseCaptureGenerationResponse(rawResponse) {
  const raw = String(rawResponse || '');
  const jsonText = stripMarkdownFence(raw);
  if (!jsonText) {
    return createParseFailure(raw, jsonText, 'empty_response', '模型没有返回任何内容。');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return createParseFailure(
      raw,
      jsonText,
      'invalid_json',
      `设定采集结果不是合法 JSON：${error.message}`,
    );
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) {
    return createParseFailure(raw, jsonText, 'invalid_schema', 'JSON 顶层必须是包含 entries 数组的对象。');
  }
  if (parsed.entries.length === 0) {
    return createParseFailure(raw, jsonText, 'empty_entries', '模型返回的 entries 数组为空。');
  }
  const invalidIndex = parsed.entries.findIndex(entry => !isPlainObject(entry));
  if (invalidIndex >= 0) {
    return createParseFailure(
      raw,
      jsonText,
      'invalid_entry',
      `第 ${invalidIndex + 1} 条 entries 不是有效对象。`,
      { index: invalidIndex },
    );
  }

  const entries = parsed.entries.map(entry => normalizeCaptureDraft({
    type: entry.type,
    title: entry.title,
    mainKeywords: entry.mainKeywords,
    filterKeywords: entry.filterKeywords,
    content: entry.content,
  }));
  return {
    ok: true,
    rawResponse: raw,
    jsonText,
    entries,
    error: null,
  };
}

function createPreflightError(code, message, details = {}) {
  return { code, message, details };
}

/** 只整理材料和最终 messages，不调用模型、不修改状态。 */
export async function prepareCaptureGeneration({
  captureState,
  materialOptions = {},
  macroOverrides = {},
} = {}) {
  const capture = normalizeCaptureState(captureState || getMemoirState().capture);
  const errors = [];
  if (!capture.request.trim()) {
    errors.push(createPreflightError('empty_request', '请先填写要采集的设定需求。'));
  }
  const sourceResult = buildCaptureSourceMaterial(capture.source, materialOptions);
  if (!sourceResult.ok) errors.push(...sourceResult.errors);
  const optionalResult = await buildCaptureOptionalContextMaterial(
    capture.optionalContext,
    materialOptions,
  );
  if (!optionalResult.ok) errors.push(...optionalResult.errors);

  const messages = errors.length ? [] : buildCapturePromptMessages({
    request: capture.request,
    requestedType: capture.requestedType,
    sourceMaterial: sourceResult.material,
    optionalMaterial: optionalResult.material,
  }, macroOverrides);
  return {
    ok: errors.length === 0,
    capture,
    sourceResult,
    optionalResult,
    messages,
    promptText: messages.map(message => message.content).join('\n\n'),
    errors,
  };
}

function resolveApiMode(apiMode) {
  if (['main_api', 'secondary_api'].includes(apiMode)) return apiMode;
  return getGlobalSettings().api?.mode === 'main_api' ? 'main_api' : 'secondary_api';
}

async function requestCaptureMainApi(messages) {
  const generateRaw = getWorkflowOption('getGenerateRawFunction')?.();
  if (typeof generateRaw !== 'function') {
    throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
  }
  const requestBody = { prompt: messages };
  const responseText = await withTimeout(Promise.resolve().then(() => generateRaw(requestBody)));
  return {
    profileName: '酒馆当前连接',
    model: '酒馆主 API',
    url: '酒馆当前连接',
    requestBody,
    responseText: String(responseText || ''),
    responseJson: null,
  };
}

async function requestCaptureSecondaryApi(messages) {
  const profile = getWorkflowOption('getActiveApiProfile')?.(getGlobalSettings());
  if (!profile) throw new Error('当前环境未提供副 API 配置。');
  if (!String(profile.model || '').trim()) throw new Error('请先在设置页选择生成模型。');
  const url = buildApiUrl(profile);
  const requestBody = {
    model: String(profile.model).trim(),
    messages,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (String(profile.apiKey || '').trim()) headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
  const response = await withTimeout(
    fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) }),
  );
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {}
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
  }
  return {
    profileName: profile.name || '未命名副 API',
    model: profile.model,
    url,
    httpStatus: `${response.status} ${response.statusText}`,
    requestBody,
    responseText,
    responseJson,
  };
}

function createWorkflowError(name, message, details = {}) {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, details);
  return error;
}

function saveCaptureError(message, rawResponse = '') {
  const capture = getMemoirState().capture;
  const raw = String(rawResponse || '').trim();
  capture.lastError = raw ? `${message}\n\n【原始响应】\n${raw}` : message;
  saveChatState();
}

/** 用户明确触发后调用模型；成功只追加草稿，不写世界书。 */
export async function runCaptureGeneration({
  captureState,
  materialOptions = {},
  macroOverrides = {},
  apiMode,
  persist = true,
} = {}) {
  const startedAt = formatTimestamp();
  const startedMs = nowMs();
  const resolvedApiMode = resolveApiMode(apiMode);
  let prepared = null;
  let apiResult = null;
  let parseResult = null;

  try {
    prepared = await prepareCaptureGeneration({ captureState, materialOptions, macroOverrides });
    if (!prepared.ok) {
      const summary = prepared.errors.map(error => error.message || error.code).filter(Boolean).join('；');
      throw createWorkflowError('CapturePreflightError', summary || '设定采集材料预检未通过。', {
        preflightErrors: prepared.errors,
      });
    }
    apiResult = resolvedApiMode === 'main_api'
      ? await requestCaptureMainApi(prepared.messages)
      : await requestCaptureSecondaryApi(prepared.messages);
    const rawContent = apiResult.responseJson
      ? getOpenAiResponseContent(apiResult.responseJson)
      : apiResult.responseText;
    parseResult = parseCaptureGenerationResponse(rawContent);
    if (!parseResult.ok) {
      throw createWorkflowError('CaptureParseError', parseResult.error.message, {
        parseError: parseResult.error,
        rawResponse: parseResult.rawResponse,
      });
    }

    const targetCapture = persist ? getMemoirState().capture : prepared.capture;
    const previousCount = targetCapture.drafts.length;
    targetCapture.drafts = appendCaptureDrafts(targetCapture.drafts, parseResult.entries);
    targetCapture.lastError = '';
    if (persist) saveChatState();
    const addedCount = targetCapture.drafts.length - previousCount;

    getWorkflowOption('addCommunicationLog')?.({
      moduleName: resolvedApiMode === 'main_api' ? '设定采集 / 主 API' : '设定采集 / 副 API',
      taskType: '设定采集草稿生成',
      status: 'success',
      startedAt,
      durationMs: Math.round(nowMs() - startedMs),
      profileName: apiResult.profileName,
      model: apiResult.model,
      url: apiResult.url,
      httpStatus: apiResult.httpStatus || '',
      messages: prepared.messages,
      requestBody: apiResult.requestBody,
      responseText: apiResult.responseText,
      rawResultContent: parseResult.jsonText,
      parsedResult: parseResult.entries,
    });

    return {
      ok: true,
      apiMode: resolvedApiMode,
      prepared,
      rawResponse: parseResult.rawResponse,
      parsedEntries: parseResult.entries,
      addedCount,
      drafts: targetCapture.drafts,
    };
  } catch (error) {
    const rawResponse = error.rawResponse || parseResult?.rawResponse || apiResult?.responseText || '';
    if (persist) saveCaptureError(error.message || String(error), rawResponse);
    getWorkflowOption('addCommunicationLog')?.({
      moduleName: resolvedApiMode === 'main_api' ? '设定采集 / 主 API' : '设定采集 / 副 API',
      taskType: '设定采集草稿生成',
      status: 'failure',
      startedAt,
      durationMs: Math.round(nowMs() - startedMs),
      profileName: apiResult?.profileName || (resolvedApiMode === 'main_api' ? '酒馆当前连接' : ''),
      model: apiResult?.model || (resolvedApiMode === 'main_api' ? '酒馆主 API' : ''),
      url: apiResult?.url || (resolvedApiMode === 'main_api' ? '酒馆当前连接' : ''),
      httpStatus: apiResult?.httpStatus || '',
      messages: prepared?.messages || [],
      requestBody: apiResult?.requestBody || {},
      responseText: apiResult?.responseText || rawResponse,
      parsedResult: parseResult || null,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}
