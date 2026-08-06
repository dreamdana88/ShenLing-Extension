import {
  getLongFormGenerationTimeoutMessage,
  LONG_FORM_GENERATION_TIMEOUT_MS,
} from '../../constants.js';
import { formatTimestamp, isPlainObject } from '../../utils/text.js';
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
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import {
  getBackgroundStreamingEnabled,
  getGlobalSettings,
} from '../../core/settings.js';
import {
  buildAffectionProfilePrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  formatAffectionValueTenths,
  normalizeAffectionRoleName,
} from './model.js';
import {
  normalizeAffectionProfileStages,
  parseAffectionProfileResponse,
} from './profile.js';
import {
  getWorkflowOption,
} from './runtime.js';

export const AFFECTION_PROFILE_BUILD_TIMEOUT_MS = LONG_FORM_GENERATION_TIMEOUT_MS;

export function createBuildRequestId() {
  return `affection-build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildAffectionProfileMessages({
  roleName,
  initialValueTenths,
  userRequirement = '',
  contextMaterial,
}) {
  const settings = getGlobalSettings();
  return replacePromptMessageMacros([
    ...resolvePromptMessages(PROMPT_IDS.SUMMARY_SUPPORT_MESSAGES, settings),
    {
      role: 'user',
      content: buildAffectionProfilePrompt({
        roleName,
        initialAffection: formatAffectionValueTenths(initialValueTenths),
        userRequirement,
        contextMaterial,
        template: resolvePromptText(PROMPT_IDS.AFFECTION_PROFILE, settings),
      }),
    },
  ]);
}

/**
 * Transport policy for affection profile builds.
 * - configured: user-triggered; read global backgroundStreamingEnabled
 * Phase C 后仅手动建档 / 主动重新生成使用 CONFIGURED。
 */
export const AFFECTION_TRANSPORT_POLICY = Object.freeze({
  CONFIGURED: 'configured',
});

function normalizeAffectionApiMode(apiMode) {
  return apiMode === 'main_api' || apiMode === 'main' ? 'main_api' : 'secondary_api';
}

function resolveAffectionTransportPlan(apiMode, transportPolicy = AFFECTION_TRANSPORT_POLICY.CONFIGURED) {
  void transportPolicy;
  const settings = getGlobalSettings();
  const profile = normalizeAffectionApiMode(apiMode) === 'secondary_api'
    ? getWorkflowOption('getActiveApiProfile')?.(settings)
    : null;
  const plan = resolveConfiguredGenerationTransport({
    backgroundStreamingEnabled: getBackgroundStreamingEnabled(settings),
    apiMode,
    profile,
  });
  notifyBackgroundStreamingFallbackOnce(plan.fallbackReason, message => {
    const toastr = globalThis.toastr || globalThis.parent?.toastr;
    toastr?.warning?.(message, '后台流式');
  });
  return plan;
}

async function requestAffectionProfileStages({
  messages,
  apiMode,
  transportPolicy = AFFECTION_TRANSPORT_POLICY.CONFIGURED,
}) {
  // Resolve before the request so failure logs keep the same plan.
  const transportPlan = resolveAffectionTransportPlan(apiMode, transportPolicy);
  const settings = getGlobalSettings();
  const profile = normalizeAffectionApiMode(apiMode) === 'secondary_api'
    ? getWorkflowOption('getActiveApiProfile')?.(settings)
    : null;
  const timeoutMessage = getLongFormGenerationTimeoutMessage('专属阶段表', apiMode, {
    transportMode: transportPlan.actualMode,
  });

  try {
    const apiResult = normalizeAffectionApiMode(apiMode) === 'main_api'
      ? await generateWithMainApi({
        messages,
        timeoutMs: AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
        timeoutMessage,
        transportMode: transportPlan.actualMode,
      })
      : await generateWithSecondaryApi({
        profile,
        messages,
        timeoutMs: AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
        timeoutMessage,
        transportMode: transportPlan.actualMode,
      });

    return {
      ...apiResult,
      rawContent: apiResult.content,
      transportPlan,
    };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.transportPlan = transportPlan;
    }
    throw error;
  }
}

export function logAffectionProfileBuild({
  enabled = true,
  task,
  status,
  startedAt,
  startedMs,
  messages = [],
  apiResult = null,
  parsedResult = null,
  transportPlan = null,
  error = null,
}) {
  if (!enabled) return;
  const generationErrorContext = status === 'failure' ? getGenerationErrorContext(error) : null;
  const errorCode = generationErrorContext?.code || '';
  const errorStage = generationErrorContext?.stage || '';
  const diagnostics = generationErrorContext?.diagnostics || null;
  const plan = transportPlan
    || apiResult?.transportPlan
    || error?.transportPlan
    || null;
  getWorkflowOption('addCommunicationLog')?.({
    moduleName: task.apiMode === 'main_api' ? '好感度建档 / 主 API' : '好感度建档 / 副 API',
    taskType: task.operation === 'manual_create'
      ? '手动创建专属阶段'
      : task.operation === 'regenerate'
        ? '专属阶段表主动重新生成'
        : '专属阶段表生成',
    status,
    startedAt,
    durationMs: diagnostics?.durationMs ?? Math.round(performance.now() - startedMs),
    profileName: diagnostics?.profileName
      || apiResult?.profileName
      || (task.apiMode === 'main_api' ? '酒馆当前连接' : ''),
    model: diagnostics?.model
      || apiResult?.model
      || (task.apiMode === 'main_api' ? '酒馆主 API' : ''),
    url: diagnostics?.url
      || apiResult?.url
      || (task.apiMode === 'main_api' ? '酒馆当前连接' : ''),
    httpStatus: diagnostics?.httpStatus ?? apiResult?.httpStatus ?? '',
    transport: buildGenerationTransportLog(plan, apiResult, diagnostics),
    messages,
    requestBody: apiResult?.requestBody || {
      buildRequestId: task.buildRequestId,
      chatId: task.chatId,
      messageId: task.messageId,
      fingerprint: task.fingerprint,
      roleName: task.roleName,
      initialValueTenths: task.initialValueTenths,
      buildMode: task.buildMode,
      apiMode: task.apiMode,
      operation: task.operation || '',
      userRequirement: task.userRequirement || '',
    },
    responseText: diagnostics?.responseText || apiResult?.responseText || '',
    rawResultContent: apiResult?.rawContent || '',
    parsedResult,
    ...(status === 'failure' ? { errorCode, errorStage } : {}),
    errorStack: error?.stack || error?.message || error || '',
  });
}

export async function executeCustomAffectionProfileBuild(task, {
  requestCustomProfile,
  resolveContextMaterial,
  onMessagesReady = null,
  transportPolicy = AFFECTION_TRANSPORT_POLICY.CONFIGURED,
}) {
  const contextMaterial = await resolveContextMaterial(task.roleName);
  const messages = buildAffectionProfileMessages({
    roleName: task.roleName,
    initialValueTenths: task.initialValueTenths,
    userRequirement: task.userRequirement,
    contextMaterial,
  });
  if (typeof onMessagesReady === 'function') {
    onMessagesReady(messages);
  }
  const apiResult = requestCustomProfile
    ? await requestCustomProfile({
      task: { ...task },
      messages,
      contextMaterial,
      transportPolicy,
    })
    : await requestAffectionProfileStages({
      messages,
      apiMode: task.apiMode,
      transportPolicy,
    });
  const rawContent = isPlainObject(apiResult) && Object.hasOwn(apiResult, 'rawContent')
    ? apiResult.rawContent
    : apiResult;
  const parsed = parseAffectionProfileResponse(rawContent);
  const stages = normalizeAffectionProfileStages(parsed);
  return {
    messages,
    apiResult: isPlainObject(apiResult) ? apiResult : { rawContent: String(apiResult || '') },
    parsed,
    stages,
  };
}
