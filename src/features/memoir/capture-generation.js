import {
  getLongFormGenerationTimeoutMessage,
  LONG_FORM_GENERATION_TIMEOUT_MS,
} from '../../constants.js';
import {
  buildGenerationTransportLog,
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
  notifyBackgroundStreamingFallbackOnce,
  resolveConfiguredGenerationTransport,
} from '../../core/generation.js';
import {
  resolvePromptMessages,
} from '../../core/prompt-overrides.js';
import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  appendCaptureDrafts,
  getBackgroundStreamingEnabled,
  getGlobalSettings,
  getMemoirState,
  normalizeCaptureDraft,
  normalizeCaptureState,
  saveChatState,
} from '../../core/settings.js';
import {
  buildCapturePromptMessages,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  buildCaptureOptionalContextMaterial,
  buildCaptureSourceMaterial,
} from './capture-material.js';
import {
  getWorkflowOption,
} from './runtime.js';

export const CAPTURE_GENERATION_TIMEOUT_MS = LONG_FORM_GENERATION_TIMEOUT_MS;

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
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

  const settings = getGlobalSettings();
  const messages = errors.length ? [] : buildCapturePromptMessages({
    request: capture.request,
    requestedType: capture.requestedType,
    sourceMaterial: sourceResult.material,
    optionalMaterial: optionalResult.material,
  }, macroOverrides, {
    messages: resolvePromptMessages(PROMPT_IDS.CAPTURE_MESSAGES, settings),
  });
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

async function requestCaptureGeneration(messages, apiMode, transportPlan) {
  const settings = getGlobalSettings();
  const profile = apiMode === 'secondary_api'
    ? getWorkflowOption('getActiveApiProfile')?.(settings)
    : null;
  const timeoutMessage = getLongFormGenerationTimeoutMessage('设定采集', apiMode, {
    transportMode: transportPlan.actualMode,
  });
  return apiMode === 'main_api'
    ? generateWithMainApi({
      messages,
      timeoutMs: CAPTURE_GENERATION_TIMEOUT_MS,
      timeoutMessage,
      transportMode: transportPlan.actualMode,
    })
    : generateWithSecondaryApi({
      profile,
      messages,
      timeoutMs: CAPTURE_GENERATION_TIMEOUT_MS,
      timeoutMessage,
      transportMode: transportPlan.actualMode,
    });
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
  // Outer-scope plan so failure logs keep requested/actual/fallback after generate throws.
  let transportPlan = null;

  try {
    prepared = await prepareCaptureGeneration({ captureState, materialOptions, macroOverrides });
    if (!prepared.ok) {
      const summary = prepared.errors.map(error => error.message || error.code).filter(Boolean).join('；');
      throw createWorkflowError('CapturePreflightError', summary || '设定采集材料预检未通过。', {
        preflightErrors: prepared.errors,
      });
    }

    const settings = getGlobalSettings();
    const profile = resolvedApiMode === 'secondary_api'
      ? getWorkflowOption('getActiveApiProfile')?.(settings)
      : null;
    transportPlan = resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: getBackgroundStreamingEnabled(settings),
      apiMode: resolvedApiMode,
      profile,
    });
    notifyBackgroundStreamingFallbackOnce(transportPlan.fallbackReason, message => {
      const toastr = globalThis.toastr || globalThis.parent?.toastr;
      toastr?.warning?.(message, '后台流式');
    });

    apiResult = await requestCaptureGeneration(
      prepared.messages,
      resolvedApiMode,
      transportPlan,
    );
    parseResult = parseCaptureGenerationResponse(apiResult.content);
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
      transport: buildGenerationTransportLog(transportPlan, apiResult),
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
    const generationErrorContext = getGenerationErrorContext(error);
    const errorCode = generationErrorContext?.code || '';
    const errorStage = generationErrorContext?.stage || '';
    const diagnostics = generationErrorContext?.diagnostics || null;
    const rawResponse = error.rawResponse || parseResult?.rawResponse || apiResult?.responseText || '';
    if (persist) saveCaptureError(error.message || String(error), rawResponse);
    getWorkflowOption('addCommunicationLog')?.({
      moduleName: resolvedApiMode === 'main_api' ? '设定采集 / 主 API' : '设定采集 / 副 API',
      taskType: '设定采集草稿生成',
      status: 'failure',
      startedAt,
      durationMs: diagnostics?.durationMs ?? Math.round(nowMs() - startedMs),
      profileName: diagnostics?.profileName
        || apiResult?.profileName
        || (resolvedApiMode === 'main_api' ? '酒馆当前连接' : ''),
      model: diagnostics?.model
        || apiResult?.model
        || (resolvedApiMode === 'main_api' ? '酒馆主 API' : ''),
      url: diagnostics?.url
        || apiResult?.url
        || (resolvedApiMode === 'main_api' ? '酒馆当前连接' : ''),
      httpStatus: diagnostics?.httpStatus ?? apiResult?.httpStatus ?? '',
      messages: prepared?.messages || [],
      requestBody: apiResult?.requestBody || {},
      responseText: diagnostics?.responseText || apiResult?.responseText || rawResponse,
      parsedResult: parseResult || null,
      transport: buildGenerationTransportLog(transportPlan, apiResult, diagnostics),
      errorCode,
      errorStage,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

// ── 阶段 G：设定草稿正式写入与 captureId 独立读回 ─────────────────
