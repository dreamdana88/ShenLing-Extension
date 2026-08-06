import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import { registerPendingCommitHandler } from '../../core/pending-commit.js';
import { resolvePromptText } from '../../core/prompt-overrides.js';
import {
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getContextInfo,
  getGlobalSettings,
} from '../../core/settings.js';
import {
  buildAffectionUpdatePromptSection as buildAffectionUpdatePromptSectionText,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  createManualAffectionAdjustmentRecord,
  normalizeAffectionRoleName,
  recalculateAffectionLedger,
  replaceAffectionRecord,
} from './model.js';
import {
  createBuildRequestId,
  executeCustomAffectionProfileBuild,
  logAffectionProfileBuild,
  AFFECTION_TRANSPORT_POLICY,
} from './generation.js';
import { registerAffectionInjectionEvents, syncAffectionInjection } from './injection.js';
import {
  commitSelectedPendingAffectionUpdates,
  markAffectionStoreUpdated,
} from './lifecycle.js';
import {
  MANUAL_USER_REQUIREMENT_MAX_LENGTH,
  resolveManualAffectionProfileContext,
} from './manual-profile.js';
import {
  buildKnownAffectionText,
  normalizeAffectionProfileStages,
} from './profile.js';
import {
  isAffectionAnalysisActive,
  refreshAffectionPanel,
} from './runtime.js';

/** 主动重新生成：与手动新建共用完整 dry_run + all 上下文。 */
async function resolveRegenerateContextMaterial(roleName) {
  const context = await resolveManualAffectionProfileContext(roleName);
  return context.material;
}

const AFFECTION_PENDING_COMMIT_HANDLER_ID = 'affection';
let affectionPendingCommitRegistered = false;

export async function adjustAffectionProfileValue({
  roleName,
  targetValueTenths,
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const target = Number(targetValueTenths);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`未找到「${cleanRoleName}」的好感档案。`);
  if (!Number.isInteger(target) || target < 0 || target > 1000) {
    throw new Error('当前好感必须是 0—100、最多一位小数。');
  }
  const timestamp = formatTimestamp();
  const record = createManualAffectionAdjustmentRecord({
    initialValueTenths: profile.initialValueTenths,
    records: profile.records,
    targetValueTenths: target,
    recordId: `manual:${Date.now()}:${encodeURIComponent(cleanRoleName)}`,
    createdAt: timestamp,
  });
  if (!record) return { changed: false, profile };
  const ledger = recalculateAffectionLedger(
    profile.initialValueTenths,
    replaceAffectionRecord(profile.records, record),
  );
  store.profiles[cleanRoleName] = {
    ...profile,
    valueTenths: ledger.valueTenths,
    records: ledger.records,
    updatedAt: timestamp,
  };
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  refreshAffectionPanel();
  return { changed: true, profile: store.profiles[cleanRoleName], record };
}

export async function deleteAffectionProfile({ roleName } = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  if (!cleanRoleName || !isPlainObject(store.profiles?.[cleanRoleName])) return false;
  delete store.profiles[cleanRoleName];
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  refreshAffectionPanel();
  return true;
}

export async function applyAffectionProfileStages({
  roleName,
  stages,
  buildMode = 'custom',
  stageDesignRequirement,
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`未找到「${cleanRoleName}」的好感档案。`);
  const normalizedStages = normalizeAffectionProfileStages(stages);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  const nextProfile = {
    ...profile,
    valueTenths: ledger.valueTenths,
    records: ledger.records,
    stages: normalizedStages,
    buildMode: buildMode === 'generic' ? 'generic' : 'custom',
    buildStatus: 'ready',
    updatedAt: formatTimestamp(),
  };
  // 未提供 stageDesignRequirement 时保留原值（含切换通用阶段）。
  if (stageDesignRequirement !== undefined) {
    const cleanRequirement = String(stageDesignRequirement ?? '').trim();
    if (cleanRequirement.length > MANUAL_USER_REQUIREMENT_MAX_LENGTH) {
      throw new Error(`阶段设计构思不能超过 ${MANUAL_USER_REQUIREMENT_MAX_LENGTH} 字符，请缩短后再试。`);
    }
    nextProfile.stageDesignRequirement = cleanRequirement;
  }
  store.profiles[cleanRoleName] = nextProfile;
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  refreshAffectionPanel();
  return store.profiles[cleanRoleName];
}

export async function regenerateAffectionProfileStages({
  roleName,
  userRequirement = '',
  apiMode = '',
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  requestCustomProfile = null,
  resolveContextMaterial = resolveRegenerateContextMaterial,
  log = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`未找到「${cleanRoleName}」的好感档案。`);
  const affection = getAffectionSettings(settings);
  const cleanApiMode = ['main_api', 'secondary_api'].includes(apiMode)
    ? apiMode
    : affection.profileBuildApiMode;
  const cleanUserRequirement = String(userRequirement || '').trim();
  if (cleanUserRequirement.length > MANUAL_USER_REQUIREMENT_MAX_LENGTH) {
    throw new Error(`阶段设计构思不能超过 ${MANUAL_USER_REQUIREMENT_MAX_LENGTH} 字符，请缩短后再试。`);
  }
  const task = {
    operation: 'regenerate',
    buildRequestId: createBuildRequestId(),
    chatId: getContextInfo().chatId,
    messageId: -1,
    fingerprint: 'manual-regenerate',
    roleName: cleanRoleName,
    initialValueTenths: profile.initialValueTenths,
    buildMode: 'custom',
    apiMode: cleanApiMode,
    userRequirement: cleanUserRequirement,
  };
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let result = null;
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile,
      resolveContextMaterial,
      transportPolicy: AFFECTION_TRANSPORT_POLICY.CONFIGURED,
    });
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      transportPlan: result.apiResult?.transportPlan || null,
      parsedResult: { roleName: cleanRoleName, stages: result.stages },
    });
    return {
      roleName: cleanRoleName,
      apiMode: cleanApiMode,
      userRequirement: task.userRequirement,
      stages: result.stages,
    };
  } catch (error) {
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'failure',
      startedAt,
      startedMs,
      messages: result?.messages || [],
      apiResult: result?.apiResult || null,
      transportPlan: result?.apiResult?.transportPlan || error?.transportPlan || null,
      error,
    });
    throw error;
  }
}

export function buildAffectionUpdatePromptSection(
  settings = getGlobalSettings(),
  chatState = getChatState(),
) {
  if (!isAffectionAnalysisActive(settings)) return '';
  const store = getAffectionSystemState(chatState);
  return buildAffectionUpdatePromptSectionText({
    knownAffectionText: buildKnownAffectionText(store.profiles),
    template: resolvePromptText(PROMPT_IDS.AFFECTION_UPDATE, settings),
  });
}

export function registerAffectionWorkflowEvents() {
  registerPendingCommitHandler(
    AFFECTION_PENDING_COMMIT_HANDLER_ID,
    commitSelectedPendingAffectionUpdates,
  );
  affectionPendingCommitRegistered = true;
  registerAffectionInjectionEvents();
  return affectionPendingCommitRegistered;
}
