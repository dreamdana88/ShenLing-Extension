import {
  getLongFormGenerationTimeoutMessage,
  LONG_FORM_GENERATION_TIMEOUT_MS,
} from '../../constants.js';
import { cloneData, formatTimestamp } from '../../utils/text.js';
import {
  buildGenerationTransportLog,
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
  notifyBackgroundStreamingFallbackOnce,
  resolveConfiguredGenerationTransport,
} from '../../core/generation.js';
import { replacePromptMessageMacros } from '../../core/macros.js';
import {
  getBackgroundStreamingEnabled,
  getGlobalSettings,
} from '../../core/settings.js';
import { buildMemorySummaryMessages } from '../../core/summary.js';
import {
  notifySummary,
  requireWorkflowOption,
} from './runtime.js';

export function joinSummaryExtraInstructions(...sections) {
  return sections
    .map(section => String(section || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Summary transport policy.
 * - configured: user-triggered panel actions; read global backgroundStreamingEnabled
 * - legacy: automatic / confirmed paths; never read streaming setting
 * Default is legacy so new call sites cannot accidentally opt into stream.
 */
export const SUMMARY_TRANSPORT_POLICY = Object.freeze({
  CONFIGURED: 'configured',
  LEGACY: 'legacy',
});

/** Manual Summary / Grand / archive generation timeout (same long-form 300s contract). */
export const MANUAL_SUMMARY_GENERATION_TIMEOUT_MS = LONG_FORM_GENERATION_TIMEOUT_MS;

function normalizeSummaryApiMode(apiMode, settings = getGlobalSettings()) {
  const api = requireWorkflowOption('getApiSettings')(settings);
  return ['main_api', 'secondary_api'].includes(apiMode) ? apiMode : api.mode;
}

function createLegacySummaryTransportPlan(apiMode) {
  return Object.freeze({
    requestedMode: 'legacy',
    actualMode: 'legacy',
    fallbackReason: null,
    apiMode: normalizeSummaryApiMode(apiMode),
  });
}

/**
 * Pure-ish Summary transport plan resolver. Does not start model requests.
 */
export function resolveSummaryTransportPlan({
  apiMode = '',
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  settings = getGlobalSettings(),
} = {}) {
  const resolvedApiMode = normalizeSummaryApiMode(apiMode, settings);
  if (transportPolicy !== SUMMARY_TRANSPORT_POLICY.CONFIGURED) {
    return createLegacySummaryTransportPlan(resolvedApiMode);
  }

  const profile = resolvedApiMode === 'secondary_api'
    ? requireWorkflowOption('getActiveApiProfile')(settings)
    : null;
  const plan = resolveConfiguredGenerationTransport({
    backgroundStreamingEnabled: getBackgroundStreamingEnabled(settings),
    apiMode: resolvedApiMode,
    profile,
  });
  notifyBackgroundStreamingFallbackOnce(plan.fallbackReason, message => {
    notifySummary('warning', message, '后台流式');
  });
  return plan;
}

function buildManualSummaryTimeoutMessage(featureName, apiMode, transportPlan) {
  return getLongFormGenerationTimeoutMessage(featureName, apiMode, {
    transportMode: transportPlan?.actualMode || 'legacy',
  });
}

export async function generateSummaryMemory(prompt, {
  type = '自动小总结',
  apiMode = '',
  transportPolicy = SUMMARY_TRANSPORT_POLICY.LEGACY,
  transportPlan = null,
  profileSnapshot = null,
  timeoutMs,
  timeoutMessage,
} = {}) {
  const settings = getGlobalSettings();
  const addCommunicationLog = requireWorkflowOption('addCommunicationLog');
  const startedAt = performance.now();
  const messages = replacePromptMessageMacros(buildMemorySummaryMessages(prompt));
  // Explicit plan freezes multi-request tasks (e.g. legacy archive); otherwise resolve once here.
  const plan = transportPlan || resolveSummaryTransportPlan({
    apiMode,
    transportPolicy,
    settings,
  });
  const resolvedApiMode = plan.apiMode || normalizeSummaryApiMode(apiMode, settings);
  const generationOptions = {
    messages,
    transportMode: plan.actualMode,
  };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    generationOptions.timeoutMs = timeoutMs;
    generationOptions.timeoutMessage = timeoutMessage
      || buildManualSummaryTimeoutMessage(type, resolvedApiMode, plan);
  }

  if (resolvedApiMode === 'main_api') {
    let apiResult = null;
    try {
      apiResult = await generateWithMainApi(generationOptions);
      addCommunicationLog({
        moduleName: '自动总结 / 主 API',
        taskType: type,
        status: 'success',
        startedAt: formatTimestamp(),
        durationMs: Math.round(performance.now() - startedAt),
        profileName: apiResult.profileName,
        model: apiResult.model,
        url: apiResult.url,
        messages,
        requestBody: apiResult.requestBody,
        responseText: apiResult.responseText,
        parsedResult: apiResult.content,
        transport: buildGenerationTransportLog(plan, apiResult),
      });
      return String(apiResult.content || '').trim();
    } catch (error) {
      const generationErrorContext = getGenerationErrorContext(error);
      const errorCode = generationErrorContext?.code || '';
      const errorStage = generationErrorContext?.stage || '';
      const diagnostics = generationErrorContext?.diagnostics || null;
      addCommunicationLog({
        moduleName: '自动总结 / 主 API',
        taskType: type,
        status: 'failure',
        startedAt: formatTimestamp(),
        durationMs: diagnostics?.durationMs ?? Math.round(performance.now() - startedAt),
        profileName: diagnostics?.profileName || apiResult?.profileName || '酒馆当前连接',
        model: diagnostics?.model || apiResult?.model || '酒馆主 API',
        url: diagnostics?.url || apiResult?.url || '酒馆当前连接',
        httpStatus: diagnostics?.httpStatus ?? '',
        messages,
        requestBody: apiResult?.requestBody || null,
        responseText: diagnostics?.responseText || '',
        transport: buildGenerationTransportLog(plan, apiResult, diagnostics),
        errorCode,
        errorStage,
        errorStack: error.stack || error.message || error,
      });
      throw error;
    }
  }

  // Multi-request tasks may pass a frozen profileSnapshot; do not re-read Active Profile.
  const profile = profileSnapshot || requireWorkflowOption('getActiveApiProfile')(settings);
  let apiResult = null;
  try {
    apiResult = await generateWithSecondaryApi({
      profile,
      ...generationOptions,
    });
    // Stream path may return responseJson=null with full content; content is authoritative.
    const content = String(apiResult.content || '').trim();
    if (!content) {
      throw new Error(`接口返回成功，但没有读取到回复正文：${apiResult.responseText || ''}`);
    }
    addCommunicationLog({
      moduleName: '自动总结 / 副 API',
      taskType: type,
      status: 'success',
      startedAt: formatTimestamp(),
      durationMs: Math.round(performance.now() - startedAt),
      profileName: apiResult.profileName,
      model: apiResult.model,
      url: apiResult.url,
      httpStatus: Number.parseInt(String(apiResult.httpStatus), 10),
      messages,
      requestBody: apiResult.requestBody,
      responseText: apiResult.responseText,
      parsedResult: content,
      transport: buildGenerationTransportLog(plan, apiResult),
    });
    return content;
  } catch (error) {
    const generationErrorContext = getGenerationErrorContext(error);
    const errorCode = generationErrorContext?.code || '';
    const errorStage = generationErrorContext?.stage || '';
    const diagnostics = generationErrorContext?.diagnostics || null;
    addCommunicationLog({
      moduleName: '自动总结 / 副 API',
      taskType: type,
      status: 'failure',
      startedAt: formatTimestamp(),
      durationMs: diagnostics?.durationMs ?? Math.round(performance.now() - startedAt),
      profileName: diagnostics?.profileName || apiResult?.profileName || profile?.name,
      model: diagnostics?.model || apiResult?.model || profile?.model,
      url: diagnostics?.url || apiResult?.url || '',
      httpStatus: diagnostics?.httpStatus ?? '',
      messages,
      requestBody: apiResult?.requestBody || null,
      responseText: diagnostics?.responseText || '',
      transport: buildGenerationTransportLog(plan, apiResult, diagnostics),
      errorCode,
      errorStage,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

export function createManualSummaryGenerationOptions(
  type,
  transportPolicy,
  transportPlan = null,
  profileSnapshot = null,
) {
  const settings = getGlobalSettings();
  const plan = transportPlan || resolveSummaryTransportPlan({
    transportPolicy,
    settings,
  });
  return {
    type,
    transportPolicy,
    transportPlan: plan,
    profileSnapshot,
    timeoutMs: MANUAL_SUMMARY_GENERATION_TIMEOUT_MS,
    timeoutMessage: buildManualSummaryTimeoutMessage(type, plan.apiMode, plan),
  };
}

/**
 * Deep-clone the current Active Profile for multi-request archive freeze.
 * Keeps full Profile fields (including secrets for request use only).
 * Never put the snapshot into transportPlan or communication logs.
 */
export function freezeSecondaryProfileSnapshot(settings = getGlobalSettings()) {
  const profile = requireWorkflowOption('getActiveApiProfile')(settings);
  if (!profile || typeof profile !== 'object') return null;
  return cloneData(profile);
}
