import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
import {
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getContextInfo,
  getGlobalSettings,
} from '../../core/settings.js';
import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  createBuildRequestId,
  executeCustomAffectionProfileBuild,
  logAffectionProfileBuild,
  AFFECTION_TRANSPORT_POLICY,
} from './generation.js';
import { syncAffectionInjection } from './injection.js';
import { markAffectionStoreUpdated } from './lifecycle.js';
import {
  normalizeAffectionRoleName,
} from './model.js';
import {
  createGenericAffectionStages,
  normalizeAffectionProfileStages,
} from './profile.js';
import { refreshAffectionPanel } from './runtime.js';

export const MANUAL_AFFECTION_PROFILE_DRAFT_TYPE = 'manual_affection_profile';
export const MANUAL_USER_REQUIREMENT_MAX_LENGTH = 2000;

function assertNormalizedRoleName(roleName) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  if (!cleanRoleName) {
    throw new Error('角色名不能为空。');
  }
  return cleanRoleName;
}

/**
 * 手动建档初始好感入参为 tenths 整数（0—1000），对应用户可见 0—100 最多一位小数。
 */
function assertManualInitialValueTenths(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error('初始好感必须是 0—100、最多一位小数。');
  }
  const tenths = Number(value);
  if (!Number.isInteger(tenths) || tenths < 0 || tenths > 1000) {
    throw new Error('初始好感必须是 0—100、最多一位小数。');
  }
  return tenths;
}

function normalizeManualUserRequirement(value) {
  const text = String(value ?? '').trim();
  if (text.length > MANUAL_USER_REQUIREMENT_MAX_LENGTH) {
    throw new Error(`阶段设计构思不能超过 ${MANUAL_USER_REQUIREMENT_MAX_LENGTH} 字符，请缩短后再试。`);
  }
  return text;
}

function normalizeManualApiMode(apiMode, settings) {
  if (apiMode === 'main_api' || apiMode === 'secondary_api') {
    return apiMode;
  }
  const affection = getAffectionSettings(settings);
  return affection.profileBuildApiMode === 'main_api' ? 'main_api' : 'secondary_api';
}

function assertProfileDoesNotExist(store, roleName) {
  if (isPlainObject(store?.profiles?.[roleName])) {
    throw new Error(`「${roleName}」已经存在好感档案。`);
  }
}

function createManualReadyProfile({
  roleName,
  initialValueTenths,
  buildMode,
  stages,
  stageDesignRequirement = '',
}) {
  const now = formatTimestamp();
  return {
    roleName,
    initialValueTenths,
    valueTenths: initialValueTenths,
    buildMode,
    buildStatus: 'ready',
    stages,
    records: [],
    stageDesignRequirement: String(stageDesignRequirement || ''),
    sourceType: 'manual',
    sourceMessageId: null,
    sourceFingerprint: '',
    createdAt: now,
    updatedAt: now,
  };
}

function assertDraftStages(stages) {
  try {
    return normalizeAffectionProfileStages(stages);
  } catch {
    throw new Error('阶段草稿已经失效。');
  }
}

/**
 * 手动专属建档上下文：只读取参考资料，不写状态。
 * 角色名仅作为世界书 dry run 额外关键词，不对结果二次按角色名过滤。
 */
export async function resolveManualAffectionProfileContext(roleName, {
  resolveContext = resolveShenlingContext,
  formatContext = formatShenlingContextForPrompt,
} = {}) {
  const cleanRoleName = assertNormalizedRoleName(roleName);
  const context = await resolveContext({
    purpose: 'affectionManualProfile',
    targetRoleName: cleanRoleName,
    recentMessageLimit: 8,
    includeRecentChat: true,
    includeMemories: true,
    includeGrandMemories: true,
    includeEmotionProfile: true,
    includeAllEmotionProfiles: false,
    includeWorldInfo: true,
    worldInfoMode: 'dry_run',
    worldInfoLimit: 'all',
  });
  const material = formatContext(context, {
    includeCharacterCard: true,
    includeUserPersona: true,
    includeWorldInfo: true,
    includeTimelineArchives: true,
    includeRecentChat: true,
    includeEmotionProfiles: true,
    worldInfoMaterialMode: 'injection_first',
  });
  return {
    roleName: cleanRoleName,
    material,
    diagnostics: isPlainObject(context?.diagnostics) ? context.diagnostics : {},
  };
}

/**
 * 通用阶段正式建档：零 API、零世界书扫描。
 */
export async function createManualGenericAffectionProfile(input = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
  syncInjection = syncAffectionInjection,
  refreshPanel = refreshAffectionPanel,
} = {}) {
  const roleName = assertNormalizedRoleName(input.roleName);
  const initialValueTenths = assertManualInitialValueTenths(input.initialValueTenths);
  const store = getAffectionSystemState(chatState);
  assertProfileDoesNotExist(store, roleName);

  const stages = createGenericAffectionStages();
  const profile = createManualReadyProfile({
    roleName,
    initialValueTenths,
    buildMode: 'generic',
    stages,
    stageDesignRequirement: '',
  });

  store.profiles[roleName] = profile;
  markAffectionStoreUpdated(store, persist);
  if (persist) {
    await syncInjection({ settings, chatState });
  }
  refreshPanel();
  return profile;
}

/**
 * 专属阶段草稿生成：调用 API，仅返回内存草稿，不落盘。
 */
export async function generateManualAffectionProfileDraft(input = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  chatId = getContextInfo().chatId,
  requestCustomProfile = null,
  resolveContext = resolveManualAffectionProfileContext,
  log = true,
} = {}) {
  const roleName = assertNormalizedRoleName(input.roleName);
  const initialValueTenths = assertManualInitialValueTenths(input.initialValueTenths);
  const userRequirement = normalizeManualUserRequirement(input.userRequirement);
  const apiMode = normalizeManualApiMode(input.apiMode, settings);
  const store = getAffectionSystemState(chatState);
  assertProfileDoesNotExist(store, roleName);

  const currentChatId = chatId === null || chatId === undefined ? '' : String(chatId);
  const task = {
    operation: 'manual_create',
    buildRequestId: createBuildRequestId(),
    chatId: currentChatId,
    messageId: -1,
    fingerprint: 'manual-create',
    roleName,
    initialValueTenths,
    buildMode: 'custom',
    apiMode,
    userRequirement,
  };

  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let contextResult = null;
  let result = null;
  let requestMessages = [];

  try {
    // 上下文解析失败也必须进入同一 failure 通讯日志生命周期。
    contextResult = await resolveContext(roleName);

    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile,
      resolveContextMaterial: async () => contextResult.material,
      transportPolicy: AFFECTION_TRANSPORT_POLICY.CONFIGURED,
      onMessagesReady: messages => {
        requestMessages = messages;
      },
    });

    const stages = normalizeAffectionProfileStages(result.stages);
    const draft = {
      draftType: MANUAL_AFFECTION_PROFILE_DRAFT_TYPE,
      buildRequestId: task.buildRequestId,
      chatId: currentChatId,
      roleName,
      initialValueTenths,
      buildMode: 'custom',
      apiMode,
      userRequirement,
      stages,
      contextDiagnostics: contextResult.diagnostics,
      createdAt: startedAt,
    };

    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      transportPlan: result.apiResult?.transportPlan || null,
      parsedResult: {
        roleName,
        stages,
        draftType: MANUAL_AFFECTION_PROFILE_DRAFT_TYPE,
      },
    });

    return draft;
  } catch (error) {
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'failure',
      startedAt,
      startedMs,
      messages: result?.messages || requestMessages,
      apiResult: result?.apiResult || null,
      transportPlan: result?.apiResult?.transportPlan || error?.transportPlan || null,
      error,
    });
    throw error;
  }
}

/**
 * 专属草稿确认：重新校验聊天、输入与 stages 后写入正式 profile。
 */
export async function commitManualAffectionProfileDraft(input = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  chatId = getContextInfo().chatId,
  persist = true,
  syncInjection = syncAffectionInjection,
  refreshPanel = refreshAffectionPanel,
} = {}) {
  const draft = isPlainObject(input.draft) ? input.draft : null;
  if (!draft || draft.draftType !== MANUAL_AFFECTION_PROFILE_DRAFT_TYPE) {
    throw new Error('阶段草稿已经失效。');
  }

  const currentChatId = chatId === null || chatId === undefined ? '' : String(chatId);
  if (String(draft.chatId ?? '') !== currentChatId) {
    throw new Error('聊天已切换，请重新生成专属阶段草稿。');
  }

  const roleName = assertNormalizedRoleName(
    Object.hasOwn(input, 'roleName') ? input.roleName : draft.roleName,
  );
  const initialValueTenths = assertManualInitialValueTenths(
    Object.hasOwn(input, 'initialValueTenths') ? input.initialValueTenths : draft.initialValueTenths,
  );
  const userRequirement = normalizeManualUserRequirement(
    Object.hasOwn(input, 'userRequirement') ? input.userRequirement : draft.userRequirement,
  );

  if (roleName !== normalizeAffectionRoleName(draft.roleName)
    || initialValueTenths !== Number(draft.initialValueTenths)
    || userRequirement !== String(draft.userRequirement || '').trim()) {
    throw new Error('建档输入已变化，请重新生成专属阶段草稿。');
  }

  const store = getAffectionSystemState(chatState);
  assertProfileDoesNotExist(store, roleName);

  const stages = assertDraftStages(draft.stages);
  const profile = createManualReadyProfile({
    roleName,
    initialValueTenths,
    buildMode: 'custom',
    stages,
    stageDesignRequirement: userRequirement,
  });

  store.profiles[roleName] = profile;
  markAffectionStoreUpdated(store, persist);
  if (persist) {
    await syncInjection({ settings, chatState });
  }
  refreshPanel();
  return profile;
}
