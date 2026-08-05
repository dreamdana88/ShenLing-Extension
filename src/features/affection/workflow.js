import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
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
  getAffectionSettings,
  getAffectionSystemState,
  getBackgroundStreamingEnabled,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getMemoryField,
  getMemoryFields,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import { getMessageContentFingerprint } from '../../core/message-fingerprint.js';
import { registerPendingCommitHandler } from '../../core/pending-commit.js';
import {
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import { getContextSafe } from '../../core/chat.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import {
  buildAffectionProfilePrompt,
  buildAffectionStateInjectionPrompt,
  buildAffectionUpdatePromptSection as buildAffectionUpdatePromptSectionText,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  AFFECTION_STAGE_RANGES,
  clampAffectionValueTenths,
  createManualAffectionAdjustmentRecord,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  getStageForValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionFirstEntries,
  normalizeAffectionRoleName,
  recalculateAffectionLedger,
  replaceAffectionRecord,
  sortAffectionRecords,
} from './model.js';
import { getLongFormGenerationTimeoutMessage, LONG_FORM_GENERATION_TIMEOUT_MS } from '../../constants.js';

export const AFFECTION_PROFILE_BUILD_TIMEOUT_MS = LONG_FORM_GENERATION_TIMEOUT_MS;
export const AFFECTION_PROFILE_BUILDING_MAX_AGE_MS = LONG_FORM_GENERATION_TIMEOUT_MS + 2 * 60 * 1000;
const AFFECTION_BUILD_TASK_LIMIT = 60;
const AFFECTION_PENDING_COMMIT_HANDLER_ID = 'affection';
export const AFFECTION_STATE_PROMPT_ID = 'shenling_assistant_affection_state';
export const AFFECTION_STATE_INJECT_POSITION = 1;
export const AFFECTION_STATE_INJECT_DEPTH = 0;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  refreshPanel: null,
};

let affectionPendingCommitRegistered = false;
const affectionEventStops = [];
let affectionEventsRegistered = false;

export function configureAffectionWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

function parseRawPipeEntry(value, valueKey) {
  const parts = String(value || '').split('|').map(part => part.trim());
  return {
    roleName: parts[0] || '',
    [valueKey]: parts[1] || '',
    extraParts: parts.slice(2),
  };
}

function getMemoryLineKey(line) {
  return String(line || '').match(/^\s*\[([A-Za-z][\w-]*)\s*:/)?.[1]?.toLowerCase() || '';
}

function buildNormalizedAffectionLines(changes) {
  return changes.map(item => (
    `[affection:${item.roleName}|${formatAffectionDeltaTenths(item.deltaTenths)}|${formatAffectionValueTenths(item.valueAfterTenths)}]`
  ));
}

function buildNormalizedFirstLines(firsts) {
  return firsts.map(item => (
    `[affection_first:${item.roleName}|${formatAffectionValueTenths(item.initialValueTenths)}]`
  ));
}

export function rewriteAffectionMemoryFields(memoryText, { changes = [], firsts = [] } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const lines = memory.split(/\r?\n/);
  const filteredLines = lines.filter(line => {
    const key = getMemoryLineKey(line);
    return key !== 'affection' && key !== 'affection_first';
  });
  const normalizedLines = [
    ...buildNormalizedAffectionLines(Array.isArray(changes) ? changes : []),
    ...buildNormalizedFirstLines(Array.isArray(firsts) ? firsts : []),
  ];
  if (!normalizedLines.length) return filteredLines.join('\n');

  const progressIndex = filteredLines.findIndex(line => getMemoryLineKey(line) === 'progress');
  const closingIndex = filteredLines.findIndex(line => /^\s*<\/memory>\s*$/i.test(line));
  const boundaryIndex = progressIndex >= 0
    ? progressIndex
    : closingIndex >= 0
      ? closingIndex
      : filteredLines.length;
  let insertionIndex = boundaryIndex;
  for (let index = 0; index < boundaryIndex; index += 1) {
    const key = getMemoryLineKey(filteredLines[index]);
    if (key === 'emotion' || key === 'emotion_changed' || key === 'affection_changed') {
      insertionIndex = index + 1;
    }
  }

  filteredLines.splice(insertionIndex, 0, ...normalizedLines);
  return filteredLines.join('\n');
}

function getProfileCurrentValueTenths(profile) {
  if (!isPlainObject(profile)) return null;
  return recalculateAffectionLedger(
    profile.initialValueTenths,
    Array.isArray(profile.records) ? profile.records : [],
  ).valueTenths;
}

export function buildKnownAffectionText(profiles = {}) {
  const lines = Object.entries(isPlainObject(profiles) ? profiles : {})
    .filter(([, profile]) => isPlainObject(profile))
    .map(([storedRoleName, profile]) => {
      const roleName = String(profile.roleName || storedRoleName || '').trim();
      if (!roleName) return '';
      const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
      const recent = ledger.records.slice(-3).map(record => {
        const source = record.sourceMessageId === null || record.sourceMessageId === undefined
          ? '鎵嬪姩璋冩暣'
          : `绗?{record.sourceMessageId}妤糮;
        const deltaTenths = Number(record.deltaTenths);
        const deltaValue = Number.isInteger(deltaTenths) ? (deltaTenths / 10).toFixed(1) : '0.0';
        const delta = deltaTenths > 0 ? `+${deltaValue}` : deltaValue;
        return `${source}${delta}鈫?{formatAffectionValueTenths(record.valueAfterTenths)}`;
      });
      return `銆?{roleName}銆戝凡寤烘。锛屽綋鍓嶅ソ鎰?${formatAffectionValueTenths(ledger.valueTenths)}/100${recent.length ? `锛涜繎鏈燂細${recent.join('銆?)}` : '锛涙殏鏃犳寮忓彉鍖栬褰?}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : '鏆傛棤宸插缓妗ｈ鑹层€?;
}

function buildAffectionStageBehaviorText(stage) {
  const meaning = String(stage?.meaning || '').trim();
  const behaviors = (Array.isArray(stage?.behaviors) ? stage.behaviors : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return [meaning, behaviors.length ? behaviors.join('锛?) : '']
    .filter(Boolean)
    .join('锛?);
}

export function buildAffectionInjection(chatState = getChatState()) {
  const store = getAffectionSystemState(chatState);
  const entries = Object.entries(store.profiles || {})
    .filter(([, profile]) => isPlainObject(profile) && profile.buildStatus === 'ready')
    .map(([storedRoleName, profile]) => {
      const roleName = normalizeAffectionRoleName(profile.roleName || storedRoleName);
      if (!roleName) return '';
      const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
      const stage = getStageForValueTenths(ledger.valueTenths, profile.stages);
      const stageName = String(stage?.name || '').trim();
      const behavior = buildAffectionStageBehaviorText(stage);
      const trend = String(stage?.trend || '').trim();
      const boundary = String(stage?.boundary || '').trim();
      if (!stageName || !behavior || !trend || !boundary) return '';
      return [
        `[铚冪伒鏀荤暐鐘舵€侊細${roleName}]`,
        `${roleName}瀵箋{user}}鐨勫ソ鎰熷害锛?{formatAffectionValueTenths(ledger.valueTenths)}/100锛岄樁娈点€?{stageName}銆嶃€俙,
        `褰撳墠闃舵琛ㄧ幇锛?{behavior}`,
        `鍙樺寲鍊惧悜锛?{trend}`,
        `绂佹锛氫笉瑕佹挱鎶ユ暟鍊兼垨闃舵鍚嶇О锛?{boundary}锛涗笉瑕佽繚鑳岃鑹叉牳蹇冧汉璁俱€俙,
      ].join('\n');
    })
    .filter(Boolean);
  return buildAffectionStateInjectionPrompt({
    entriesText: entries.join('\n\n'),
    template: resolvePromptText(PROMPT_IDS.AFFECTION_INJECTION, getGlobalSettings()),
  });
}

const GENERIC_AFFECTION_STAGE_CONTENT = Object.freeze([
  Object.freeze({
    name: '闄岃矾鏄熻景',
    meaning: '浠嶆槸闇€瑕佷繚鎸佽窛绂讳笌瑙傚療鐨勯檶鐢熶汉銆?,
    behaviors: ['淇濇寔鍩烘湰绀艰矊涓庡繀瑕佷氦娴?, '浼樺厛瑙傚療 {{user}} 鐨勮█琛屼笌杈圭晫', '涓嶄富鍔ㄩ€忛湶绉佷汉鎯呯华涓庨噸瑕佺瀵?],
    trend: '寮€濮嬭浣?{{user}} 鐨勪範鎯紝骞舵効鎰忓欢闀挎櫘閫氫氦娴併€?,
    boundary: '涓嶆彁鍓嶈〃鐜颁翰瀵嗕緷璧栥€佹毀鏄у崰鏈夋垨鏃犳潯浠朵俊浠汇€?,
  }),
  Object.freeze({
    name: '寰厜鍒濈幇',
    meaning: '鎶?{{user}} 瑙嗕负鍙互缁х画鎺ヨЕ鐨勭啛浜轰笌鏈嬪弸銆?,
    behaviors: ['鎰挎剰鍥炲簲鏃ュ父鍏冲績涓庢櫘閫氶個绾?, '鍦ㄥ姏鎵€鑳藉強鐨勮寖鍥存彁渚涘府鍔?, '鍋跺皵鍒嗕韩涓嶆晱鎰熺殑涓汉鎯虫硶'],
    trend: '閫愭笎涓诲姩瀵绘壘鍏卞悓璇濋锛屽苟鍦ㄦ剰 {{user}} 鐨勮瘎浠枫€?,
    boundary: '涓嶆彁鍓嶄綔鍑烘亱鐖辨壙璇烘垨琛ㄧ幇寮虹儓鎺掍粬鎬с€?,
  }),
  Object.freeze({
    name: '鎯呮劔鏆楃敓',
    meaning: '宸蹭骇鐢熸槑纭ソ鎰燂紝浣嗕粛鍦ㄧ‘璁ゅ郊姝ゅ績鎰忋€?,
    behaviors: ['鏇翠富鍔ㄥ叧娉?{{user}} 鐨勬儏缁彉鍖?, '鎰挎剰鍒涢€犲崟鐙浉澶勪笌娣卞叆浜ゆ祦鐨勬満浼?, '鍦ㄥ叧閿椂鍒荤粰浜堝甫鏈変釜浜哄€惧悜鐨勬敮鎸?],
    trend: '璇曟帰褰兼杈圭晫锛屽苟閫愭笎鏄鹃湶鍖哄埆浜庢櫘閫氭湅鍙嬬殑鍦ㄦ剰銆?,
    boundary: '涓嶆妸灏氭湭纭鐨勫ソ鎰熺洿鎺ユ紨鎴愮ǔ瀹氫即渚ｅ叧绯汇€?,
  }),
  Object.freeze({
    name: '蹇冩剰鐩搁€?,
    meaning: '宸茬‘璁ゅ郊姝ゅ叿鏈変翰瀵嗗€惧悜锛屽叧绯昏繘鍏ョǔ瀹氱（鍚堛€?,
    behaviors: ['涓诲姩琛ㄨ揪鎬濆康銆佸叧蹇冧笌浜插瘑闇€姹?, '鎶?{{user}} 绾冲叆閲嶈璁″垝涓庡喅瀹?, '閬囧埌鍒嗘鏃舵効鎰忔矡閫氬苟淇鍏崇郴'],
    trend: '閫愭寤虹珛鏇存繁鐨勬壙璇恒€侀粯濂戜笌鍏卞悓鐢熸椿鎰熴€?,
    boundary: '涓嶅拷鐣ヨ鑹茶嚜韬師鍒欙紝涔熶笉鎶婁翰瀵嗙瓑鍚屼簬澶卞幓鐙珛鎬с€?,
  }),
  Object.freeze({
    name: '鐏甸瓊浜よ瀺',
    meaning: '鎶?{{user}} 瑙嗕负娣卞害淇¤禆骞舵効鎰忛暱鏈熺浉浼寸殑鐖变汉銆?,
    behaviors: ['鑷劧鍒嗕韩鏈€閲嶈鐨勮剢寮便€佺瀵嗕笌闀挎湡鎰挎櫙', '鍦ㄥ皧閲嶅郊姝や富浣撴€х殑鍓嶆彁涓嬫壙鎷呭叡鍚岃矗浠?, '浠ョǔ瀹氳€屽叿浣撶殑琛屽姩缁存姢鍙屾柟鍏崇郴'],
    trend: '缁х画娣卞寲鍏卞悓缁忓巻涓庨暱鏈熸壙璇猴紝鑰岄潪鏈烘閲嶅绀虹埍銆?,
    boundary: '涓嶅洜楂樺ソ鎰熷彇娑堜汉璁俱€佺幇瀹炵煕鐩俱€佷釜浜鸿竟鐣屾垨鍚堢悊鍒嗘銆?,
  }),
]);

function sanitizeAffectionStageText(value, maxLength) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[(?:emotion|affection|progress|memory|grand_memory)[^\]\r\n]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function createGenericAffectionStages() {
  return AFFECTION_STAGE_RANGES.map((range, index) => ({
    ...range,
    ...GENERIC_AFFECTION_STAGE_CONTENT[index],
    behaviors: [...GENERIC_AFFECTION_STAGE_CONTENT[index].behaviors],
  }));
}

export function normalizeAffectionProfileStages(value) {
  const stages = Array.isArray(value?.stages) ? value.stages : Array.isArray(value) ? value : [];
  if (stages.length !== AFFECTION_STAGE_RANGES.length) {
    throw new Error('涓撳睘闃舵琛ㄥ繀椤绘伆濂藉寘鍚簲涓樁娈点€?);
  }

  return AFFECTION_STAGE_RANGES.map((range, index) => {
    const source = isPlainObject(stages[index]) ? stages[index] : {};
    const name = sanitizeAffectionStageText(source.name, 24);
    const meaning = sanitizeAffectionStageText(source.meaning, 120);
    const trend = sanitizeAffectionStageText(source.trend, 120);
    const boundary = sanitizeAffectionStageText(source.boundary, 120);
    const behaviors = (Array.isArray(source.behaviors) ? source.behaviors : [])
      .map(item => sanitizeAffectionStageText(item, 100))
      .filter(Boolean);
    if (!name || !meaning || !trend || !boundary || behaviors.length !== 3) {
      throw new Error(`涓撳睘闃舵琛ㄧ ${index + 1} 闃舵瀛楁涓嶅畬鏁达紝涓?behaviors 蹇呴』鎭板ソ涓夋潯闈炵┖鏂囨湰銆俙);
    }
    return {
      ...range,
      name,
      meaning,
      behaviors,
      trend,
      boundary,
    };
  });
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const matched = raw.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return (matched?.[1] || raw).trim();
}

function parseAffectionProfileResponse(value) {
  if (isPlainObject(value) && Array.isArray(value.stages)) return value;
  const raw = stripMarkdownFence(value);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('涓撳睘闃舵琛ㄨ繑鍥炰笉鏄悎娉?JSON銆?);
  }
}

export function createAffectionBuildTaskKey({ chatId, messageId, fingerprint, roleName }) {
  return [chatId, messageId, fingerprint, normalizeAffectionRoleName(roleName)]
    .map(value => encodeURIComponent(String(value ?? '')))
    .join('::');
}

function createBuildRequestId() {
  return `affection-build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pruneAffectionBuildTasks(buildTasks) {
  const entries = Object.entries(isPlainObject(buildTasks) ? buildTasks : {});
  if (entries.length <= AFFECTION_BUILD_TASK_LIMIT) return;
  entries
    .sort(([, left], [, right]) => String(left?.updatedAt || left?.createdAt || '')
      .localeCompare(String(right?.updatedAt || right?.createdAt || '')))
    .slice(0, entries.length - AFFECTION_BUILD_TASK_LIMIT)
    .forEach(([key]) => delete buildTasks[key]);
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

async function resolveAffectionProfileContext(roleName) {
  const context = await resolveShenlingContext({
    purpose: 'affectionProfile',
    targetRoleName: roleName,
    recentMessageLimit: 8,
    includeRecentChat: true,
    includeMemories: true,
    includeGrandMemories: true,
    includeEmotionProfile: true,
    includeAllEmotionProfiles: false,
    includeWorldInfo: false,
  });
  return formatShenlingContextForPrompt(context, {
    includeWorldInfo: false,
    includeTimelineArchives: true,
    includeRecentChat: true,
    includeEmotionProfiles: true,
  });
}

/**
 * Transport policy for affection profile builds.
 * - configured: user-triggered; read global backgroundStreamingEnabled
 * - legacy: automatic/pending/confirmed builds; never read streaming setting
 * Default is legacy so new call sites cannot accidentally opt into stream.
 */
export const AFFECTION_TRANSPORT_POLICY = Object.freeze({
  CONFIGURED: 'configured',
  LEGACY: 'legacy',
});

function normalizeAffectionApiMode(apiMode) {
  return apiMode === 'main_api' || apiMode === 'main' ? 'main_api' : 'secondary_api';
}

function createLegacyAffectionTransportPlan(apiMode) {
  return Object.freeze({
    requestedMode: 'legacy',
    actualMode: 'legacy',
    fallbackReason: null,
    apiMode: normalizeAffectionApiMode(apiMode),
  });
}

function resolveAffectionTransportPlan(apiMode, transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY) {
  if (transportPolicy === AFFECTION_TRANSPORT_POLICY.CONFIGURED) {
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
      toastr?.warning?.(message, '鍚庡彴娴佸紡');
    });
    return plan;
  }
  return createLegacyAffectionTransportPlan(apiMode);
}

async function requestAffectionProfileStages({
  messages,
  apiMode,
  transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
}) {
  // Resolve before the request so failure logs keep the same plan.
  const transportPlan = resolveAffectionTransportPlan(apiMode, transportPolicy);
  const settings = getGlobalSettings();
  const profile = normalizeAffectionApiMode(apiMode) === 'secondary_api'
    ? getWorkflowOption('getActiveApiProfile')?.(settings)
    : null;
  const timeoutMessage = getLongFormGenerationTimeoutMessage('涓撳睘闃舵琛?, apiMode, {
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

function createProfileDraft(task, stages) {
  const now = formatTimestamp();
  return {
    roleName: task.roleName,
    initialValueTenths: task.initialValueTenths,
    valueTenths: task.initialValueTenths,
    buildMode: task.buildMode,
    buildStatus: 'ready',
    stages,
    records: [],
    sourceMessageId: task.messageId,
    sourceFingerprint: task.fingerprint,
    createdAt: now,
    updatedAt: now,
  };
}

export function isAffectionAnalysisActive(settings = getGlobalSettings()) {
  const affection = getAffectionSettings(settings);
  const summary = getSummarySettings(settings);
  return Boolean(
    settings?.enabled === true
    && summary.enabled === true
    && affection.enabled === true
    && affection.mode === 'normal'
  );
}

function getDefaultBuildSnapshot(messageId) {
  const settings = getGlobalSettings();
  return {
    chatId: getContextInfo().chatId,
    fingerprint: getMessageContentFingerprint(messageId, settings),
    active: isAffectionAnalysisActive(settings),
  };
}

function collectAffectionBuildCandidates(pending, profiles) {
  const candidates = [];
  const seen = new Set();
  const add = (roleName, initialValueTenths, source) => {
    const normalizedRoleName = normalizeAffectionRoleName(roleName);
    if (!normalizedRoleName || seen.has(normalizedRoleName) || isPlainObject(profiles?.[normalizedRoleName])) return;
    seen.add(normalizedRoleName);
    candidates.push({ roleName: normalizedRoleName, initialValueTenths, source });
  };

  (Array.isArray(pending?.firsts) ? pending.firsts : []).forEach(item => {
    const value = Number(item?.initialValueTenths);
    add(
      item?.roleName,
      Number.isInteger(value) && value >= 0 && value <= 1000 ? value : null,
      'affection_first',
    );
  });
  (Array.isArray(pending?.diagnostics) ? pending.diagnostics : []).forEach(item => {
    if (item?.code === 'first_invalid_initial_value' || item?.code === 'change_without_profile_or_first') {
      add(item.roleName, null, item.code);
    }
  });
  return candidates;
}

function isReusableBuildTask(task, force) {
  if (!isPlainObject(task) || force) return false;
  if (['ready', 'error', 'stale', 'needs_initial_value'].includes(task.buildStatus)) return true;
  if (task.buildStatus !== 'building') return false;
  return Date.now() - Number(task.createdAtMs || 0) < AFFECTION_PROFILE_BUILDING_MAX_AGE_MS;
}

function saveAffectionBuildState(persist) {
  if (persist) {
    saveChatState();
    getWorkflowOption('refreshPanel')?.();
  }
}

function isAutomaticRecordForMessage(record, messageId) {
  return record?.sourceType !== 'manual_adjustment'
    && Number(record?.sourceMessageId) === Number(messageId);
}

function removeAutomaticRecordsForMessage(records, messageId) {
  return sortAffectionRecords(records).filter(record => !isAutomaticRecordForMessage(record, messageId));
}

function getMatchingAffectionBuildTask(store, {
  chatId,
  messageId,
  fingerprint,
  roleName,
}) {
  const taskKey = createAffectionBuildTaskKey({ chatId, messageId, fingerprint, roleName });
  const task = store.buildTasks?.[taskKey];
  if (!isPlainObject(task)) return null;
  return String(task.chatId || '') === String(chatId || '')
    && Number(task.messageId) === Number(messageId)
    && String(task.fingerprint || '') === String(fingerprint || '')
    && normalizeAffectionRoleName(task.roleName) === normalizeAffectionRoleName(roleName)
    ? task
    : null;
}

function removeAffectionBuildTasksForMessage(store, messageId, { keepTaskKeys = [] } = {}) {
  const keep = new Set(keepTaskKeys);
  let removed = 0;
  Object.entries(store.buildTasks || {}).forEach(([taskKey, task]) => {
    if (Number(task?.messageId) !== Number(messageId) || keep.has(taskKey)) return;
    delete store.buildTasks[taskKey];
    removed += 1;
  });
  return removed;
}

function applyPendingAffectionChange(profile, change, { messageId, fingerprint, timestamp }) {
  if (!isPlainObject(profile)) return false;
  const deltaTenths = Number(change?.deltaTenths);
  if (!Number.isInteger(deltaTenths)) return false;

  const currentRecords = Array.isArray(profile.records) ? profile.records : [];
  const previousRecord = currentRecords.find(record => isAutomaticRecordForMessage(record, messageId));
  const recordsWithoutCurrentMessage = removeAutomaticRecordsForMessage(currentRecords, messageId);
  const nextRecords = deltaTenths === 0
    ? recordsWithoutCurrentMessage
    : sortAffectionRecords([
      ...recordsWithoutCurrentMessage,
      {
        recordId: `affection:auto:${messageId}:${encodeURIComponent(normalizeAffectionRoleName(change.roleName))}`,
        sourceMessageId: Number(messageId),
        sourceFingerprint: String(fingerprint || ''),
        deltaTenths,
        sourceType: 'auto',
        createdAt: String(previousRecord?.createdAt || timestamp),
        updatedAt: timestamp,
      },
    ]);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, nextRecords);
  const before = JSON.stringify({
    valueTenths: profile.valueTenths,
    records: currentRecords,
  });
  const after = JSON.stringify({
    valueTenths: ledger.valueTenths,
    records: ledger.records,
  });
  if (before === after) return false;
  profile.valueTenths = ledger.valueTenths;
  profile.records = ledger.records;
  profile.updatedAt = timestamp;
  return true;
}

function isMatchingReadyProfileDraft(task, first) {
  const draft = task?.profileDraft;
  return task?.buildStatus === 'ready'
    && isPlainObject(draft)
    && normalizeAffectionRoleName(draft.roleName) === normalizeAffectionRoleName(first?.roleName)
    && Number(draft.initialValueTenths) === Number(first?.initialValueTenths)
    && Array.isArray(draft.stages)
    && draft.stages.length === AFFECTION_STAGE_RANGES.length;
}

function getCurrentTaskState(task, {
  getCurrentSnapshot,
  getCurrentChatState,
}) {
  const snapshot = getCurrentSnapshot(task.messageId);
  if (String(snapshot?.chatId || '') !== task.chatId) {
    return { valid: false, reason: '鑱婂ぉ宸插垏鎹€?, canWrite: false, task: null };
  }
  const currentChatState = getCurrentChatState();
  const currentStore = getAffectionSystemState(currentChatState);
  const currentTask = currentStore.buildTasks[task.taskKey];
  if (!isPlainObject(currentTask) || currentTask.buildRequestId !== task.buildRequestId) {
    return { valid: false, reason: '寤烘。浠诲姟宸茶鏇挎崲鎴栨竻鐞嗐€?, canWrite: true, task: currentTask || null };
  }
  if (snapshot?.active !== true) {
    return { valid: false, reason: '濂芥劅妯″潡鎴栬嚜鍔ㄥ皬鎬荤粨宸插叧闂€?, canWrite: true, task: currentTask };
  }
  if (String(snapshot?.fingerprint || '') !== task.fingerprint) {
    return { valid: false, reason: '褰撳墠閫変腑 swipe 宸插彉鍖栥€?, canWrite: true, task: currentTask };
  }
  return { valid: true, reason: '', canWrite: true, task: currentTask };
}

function markBuildTaskStale(task, reason, validation, persist) {
  if (validation.canWrite && isPlainObject(validation.task)) {
    validation.task.buildStatus = 'stale';
    validation.task.error = reason;
    validation.task.updatedAt = formatTimestamp();
    saveAffectionBuildState(persist);
  }
}

function logAffectionProfileBuild({
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
    moduleName: task.apiMode === 'main_api' ? '濂芥劅搴﹀缓妗?/ 涓?API' : '濂芥劅搴﹀缓妗?/ 鍓?API',
    taskType: task.operation === 'regenerate'
      ? '涓撳睘闃舵琛ㄤ富鍔ㄩ噸鏂扮敓鎴?
      : task.buildMode === 'generic' ? '閫氱敤闃舵琛ㄩ寤烘。' : '涓撳睘闃舵琛ㄩ寤烘。',
    status,
    startedAt,
    durationMs: diagnostics?.durationMs ?? Math.round(performance.now() - startedMs),
    profileName: diagnostics?.profileName
      || apiResult?.profileName
      || (task.apiMode === 'main_api' ? '閰掗褰撳墠杩炴帴' : ''),
    model: diagnostics?.model
      || apiResult?.model
      || (task.apiMode === 'main_api' ? '閰掗涓?API' : ''),
    url: diagnostics?.url
      || apiResult?.url
      || (task.apiMode === 'main_api' ? '閰掗褰撳墠杩炴帴' : ''),
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
    },
    responseText: diagnostics?.responseText || apiResult?.responseText || '',
    rawResultContent: apiResult?.rawContent || '',
    parsedResult,
    ...(status === 'failure' ? { errorCode, errorStage } : {}),
    errorStack: error?.stack || error?.message || error || '',
  });
}

async function executeCustomAffectionProfileBuild(task, {
  requestCustomProfile,
  resolveContextMaterial,
  onMessagesReady = null,
  transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
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

async function runAffectionBuildCandidate(candidate, pending, options) {
  const {
    settings,
    chatState,
    chatId,
    persist,
    force,
    getCurrentSnapshot,
    getCurrentChatState,
    requestCustomProfile,
    resolveContextMaterial,
    log,
    transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
  } = options;
  const affection = getAffectionSettings(settings);
  const store = getAffectionSystemState(chatState);
  const taskKey = createAffectionBuildTaskKey({
    chatId,
    messageId: pending.messageId,
    fingerprint: pending.fingerprint,
    roleName: candidate.roleName,
  });
  const existing = store.buildTasks[taskKey];
  if (isReusableBuildTask(existing, force)) return existing;

  const now = formatTimestamp();
  const task = {
    taskKey,
    buildRequestId: createBuildRequestId(),
    chatId,
    messageId: pending.messageId,
    fingerprint: pending.fingerprint,
    roleName: candidate.roleName,
    initialValueTenths: candidate.initialValueTenths,
    buildMode: affection.defaultBuildMode,
    apiMode: affection.profileBuildApiMode,
    buildStatus: candidate.initialValueTenths === null
      ? 'needs_initial_value'
      : affection.defaultBuildMode === 'generic' ? 'ready' : 'building',
    stages: [],
    profileDraft: null,
    source: candidate.source,
    error: candidate.initialValueTenths === null ? '缂哄皯鍚堟硶 affection_first 鍒濆€笺€? : '',
    createdAt: now,
    createdAtMs: Date.now(),
    updatedAt: now,
  };
  store.buildTasks[taskKey] = task;
  pruneAffectionBuildTasks(store.buildTasks);

  const startedAt = now;
  const startedMs = performance.now();
  if (task.buildStatus === 'needs_initial_value') {
    saveAffectionBuildState(persist);
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'failure',
      startedAt,
      startedMs,
      parsedResult: task,
      error: new Error(task.error),
    });
    return task;
  }

  if (task.buildMode === 'generic') {
    task.stages = createGenericAffectionStages();
    task.profileDraft = createProfileDraft(task, task.stages);
    task.updatedAt = formatTimestamp();
    saveAffectionBuildState(persist);
    logAffectionProfileBuild({
      enabled: log,
      task,
      status: 'success',
      startedAt,
      startedMs,
      parsedResult: task.profileDraft,
    });
    return task;
  }

  saveAffectionBuildState(persist);
  let result = null;
  let requestMessages = [];
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile,
      resolveContextMaterial,
      transportPolicy,
      onMessagesReady: messages => {
        requestMessages = messages;
      },
    });
    const validation = getCurrentTaskState(task, { getCurrentSnapshot, getCurrentChatState });
    if (!validation.valid) {
      markBuildTaskStale(task, validation.reason, validation, persist);
      logAffectionProfileBuild({
        enabled: log,
        task,
        status: 'failure',
        startedAt,
        startedMs,
        messages: result.messages,
        apiResult: result.apiResult,
        transportPlan: result.apiResult?.transportPlan || null,
        parsedResult: result.parsed,
        error: new Error(`寤烘。缁撴灉澶辨晥锛?{validation.reason}`),
      });
      return validation.task || { ...task, buildStatus: 'stale', error: validation.reason };
    }
    validation.task.stages = result.stages;
    validation.task.profileDraft = createProfileDraft(validation.task, result.stages);
    validation.task.buildStatus = 'ready';
    validation.task.error = '';
    validation.task.updatedAt = formatTimestamp();
    saveAffectionBuildState(persist);
    logAffectionProfileBuild({
      enabled: log,
      task: validation.task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      transportPlan: result.apiResult?.transportPlan || null,
      parsedResult: validation.task.profileDraft,
    });
    if (validation.task.confirmed === true) {
      await commitSelectedPendingAffectionUpdates({
        settings,
        chatState: getCurrentChatState(),
        chatId,
        persist,
        getSelectedFingerprint: messageId => getCurrentSnapshot(messageId)?.fingerprint || '',
      });
    }
    return validation.task;
  } catch (error) {
    const validation = getCurrentTaskState(task, { getCurrentSnapshot, getCurrentChatState });
    if (validation.valid) {
      validation.task.buildStatus = 'error';
      validation.task.error = error?.message || String(error);
      validation.task.stages = [];
      validation.task.profileDraft = null;
      validation.task.updatedAt = formatTimestamp();
      saveAffectionBuildState(persist);
    } else {
      markBuildTaskStale(task, validation.reason, validation, persist);
    }
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
    return validation.task || { ...task, buildStatus: 'stale', error: validation.reason };
  }
}

export async function startAffectionProfileBuildsForPending(
  pending,
  {
    settings = getGlobalSettings(),
    chatState = getChatState(),
    chatId = getContextInfo().chatId,
    persist = true,
    force = false,
    getCurrentSnapshot = getDefaultBuildSnapshot,
    getCurrentChatState = () => getChatState(),
    requestCustomProfile = null,
    resolveContextMaterial = resolveAffectionProfileContext,
    log = persist,
    // Automatic pending / confirmed builds default to legacy and ignore global stream setting.
    transportPolicy = AFFECTION_TRANSPORT_POLICY.LEGACY,
  } = {},
) {
  if (!pending || !Number.isInteger(Number(pending.messageId)) || !String(pending.fingerprint || '').trim()) return [];
  const store = getAffectionSystemState(chatState);
  const candidates = collectAffectionBuildCandidates(pending, store.profiles);
  const options = {
    settings,
    chatState,
    chatId: String(chatId || ''),
    persist,
    force,
    getCurrentSnapshot,
    getCurrentChatState,
    requestCustomProfile,
    resolveContextMaterial,
    log,
    transportPolicy,
  };
  return Promise.all(candidates.map(candidate => runAffectionBuildCandidate(candidate, pending, options)));
}

export async function runAffectionProfileBuildApiPreview({ roleName, initialValueTenths } = {}) {
  const normalizedRoleName = normalizeAffectionRoleName(roleName);
  const value = Number(initialValueTenths);
  if (!normalizedRoleName) throw new Error('璇疯緭鍏ヨ娴嬭瘯鐨勮鑹插悕銆?);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error('鍒濆濂芥劅蹇呴』鏄?0鈥?00銆佹渶澶氫竴浣嶅皬鏁般€?);
  }
  const settings = getGlobalSettings();
  const affection = getAffectionSettings(settings);
  const task = {
    buildRequestId: createBuildRequestId(),
    chatId: getContextInfo().chatId,
    messageId: -1,
    fingerprint: 'explicit-preview',
    roleName: normalizedRoleName,
    initialValueTenths: value,
    buildMode: 'custom',
    apiMode: affection.profileBuildApiMode,
  };
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let result = null;
  let requestMessages = [];
  try {
    result = await executeCustomAffectionProfileBuild(task, {
      requestCustomProfile: null,
      resolveContextMaterial: resolveAffectionProfileContext,
      transportPolicy: AFFECTION_TRANSPORT_POLICY.CONFIGURED,
      onMessagesReady: messages => {
        requestMessages = messages;
      },
    });
    const profileDraft = createProfileDraft(task, result.stages);
    logAffectionProfileBuild({
      task,
      status: 'success',
      startedAt,
      startedMs,
      messages: result.messages,
      apiResult: result.apiResult,
      transportPlan: result.apiResult?.transportPlan || null,
      parsedResult: profileDraft,
    });
    return profileDraft;
  } catch (error) {
    logAffectionProfileBuild({
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

function getAffectionPendingItem(store, messageId, fingerprint) {
  const bucket = store.pendingByMessage?.[String(Number(messageId))];
  return isPlainObject(bucket?.items?.[String(fingerprint || '').trim()])
    ? bucket.items[String(fingerprint || '').trim()]
    : null;
}

function markAffectionStoreUpdated(store, persist) {
  store.lastUpdatedAt = formatTimestamp();
  if (persist) saveChatState();
}

export function updatePendingAffectionDelta({
  messageId,
  fingerprint,
  roleName,
  deltaTenths,
} = {}, {
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const cleanFingerprint = String(fingerprint || '').trim();
  const nextDeltaTenths = Number(deltaTenths);
  if (!cleanRoleName || !cleanFingerprint || !AFFECTION_ALLOWED_DELTA_TENTHS.includes(nextDeltaTenths)) {
    throw new Error('寰呯‘璁ゅソ鎰熷彉鍖栧弬鏁版棤鏁堛€?);
  }
  const store = getAffectionSystemState(chatState);
  const pending = getAffectionPendingItem(store, messageId, cleanFingerprint);
  if (!pending) throw new Error('褰撳墠閫変腑鍥炲娌℃湁鍙紪杈戠殑濂芥劅 pending銆?);
  const change = (Array.isArray(pending.changes) ? pending.changes : [])
    .find(item => normalizeAffectionRoleName(item?.roleName) === cleanRoleName);
  if (!change) throw new Error(`鏈壘鍒般€?{cleanRoleName}銆嶇殑寰呯‘璁ゅ彉鍖栥€俙);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`銆?{cleanRoleName}銆嶅皻鏃犳寮忓ソ鎰熸。妗堛€俙);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  change.deltaTenths = nextDeltaTenths;
  change.valueBeforeTenths = ledger.valueTenths;
  change.valueAfterTenths = clampAffectionValueTenths(ledger.valueTenths + nextDeltaTenths);
  pending.changed = pending.changes.some(item => Number(item?.deltaTenths) !== 0);
  pending.updatedAt = formatTimestamp();
  markAffectionStoreUpdated(store, persist);
  return { ...change };
}

export function discardPendingAffectionItem({
  messageId,
  fingerprint,
  roleName,
} = {}, {
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const cleanFingerprint = String(fingerprint || '').trim();
  const messageKey = String(Number(messageId));
  const store = getAffectionSystemState(chatState);
  const bucket = store.pendingByMessage?.[messageKey];
  const pending = getAffectionPendingItem(store, messageId, cleanFingerprint);
  if (!cleanRoleName || !pending || !isPlainObject(bucket?.items)) return false;
  const matchingTaskKeys = Object.entries(store.buildTasks || {})
    .filter(([, task]) => (
      Number(task?.messageId) === Number(messageId)
      && String(task?.fingerprint || '') === cleanFingerprint
      && normalizeAffectionRoleName(task?.roleName) === cleanRoleName
    ))
    .map(([taskKey]) => taskKey);
  const matchingPendingCount = [
    ...(Array.isArray(pending.changes) ? pending.changes : []),
    ...(Array.isArray(pending.firsts) ? pending.firsts : []),
  ].filter(item => normalizeAffectionRoleName(item?.roleName) === cleanRoleName).length;
  if (!matchingPendingCount && !matchingTaskKeys.length) return false;
  pending.changes = (Array.isArray(pending.changes) ? pending.changes : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== cleanRoleName);
  pending.firsts = (Array.isArray(pending.firsts) ? pending.firsts : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== cleanRoleName);
  pending.changed = pending.changes.some(item => Number(item?.deltaTenths) !== 0);
  const afterCount = pending.changes.length + pending.firsts.length;
  matchingTaskKeys.forEach(taskKey => delete store.buildTasks[taskKey]);
  if (!afterCount) delete bucket.items[cleanFingerprint];
  if (!Object.keys(bucket.items).length) delete store.pendingByMessage[messageKey];
  markAffectionStoreUpdated(store, persist);
  return true;
}

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
  if (!profile) throw new Error(`鏈壘鍒般€?{cleanRoleName}銆嶇殑濂芥劅妗ｆ銆俙);
  if (!Number.isInteger(target) || target < 0 || target > 1000) {
    throw new Error('褰撳墠濂芥劅蹇呴』鏄?0鈥?00銆佹渶澶氫竴浣嶅皬鏁般€?);
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
  getWorkflowOption('refreshPanel')?.();
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
  getWorkflowOption('refreshPanel')?.();
  return true;
}

export async function applyAffectionProfileStages({
  roleName,
  stages,
  buildMode = 'custom',
} = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`鏈壘鍒般€?{cleanRoleName}銆嶇殑濂芥劅妗ｆ銆俙);
  const normalizedStages = normalizeAffectionProfileStages(stages);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  store.profiles[cleanRoleName] = {
    ...profile,
    valueTenths: ledger.valueTenths,
    records: ledger.records,
    stages: normalizedStages,
    buildMode: buildMode === 'generic' ? 'generic' : 'custom',
    buildStatus: 'ready',
    updatedAt: formatTimestamp(),
  };
  markAffectionStoreUpdated(store, persist);
  if (persist) await syncAffectionInjection({ settings, chatState });
  getWorkflowOption('refreshPanel')?.();
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
  resolveContextMaterial = resolveAffectionProfileContext,
  log = true,
} = {}) {
  const cleanRoleName = normalizeAffectionRoleName(roleName);
  const store = getAffectionSystemState(chatState);
  const profile = isPlainObject(store.profiles?.[cleanRoleName]) ? store.profiles[cleanRoleName] : null;
  if (!profile) throw new Error(`鏈壘鍒般€?{cleanRoleName}銆嶇殑濂芥劅妗ｆ銆俙);
  const affection = getAffectionSettings(settings);
  const cleanApiMode = ['main_api', 'secondary_api'].includes(apiMode)
    ? apiMode
    : affection.profileBuildApiMode;
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
    userRequirement: String(userRequirement || '').trim().slice(0, 2000),
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

export async function retryAffectionBuildTask({ taskKey } = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const store = getAffectionSystemState(chatState);
  const task = store.buildTasks?.[String(taskKey || '')];
  if (!isPlainObject(task)) throw new Error('寰呴噸璇曠殑涓撳睘寤烘。浠诲姟宸茬粡涓嶅瓨鍦ㄣ€?);
  const pending = getAffectionPendingItem(store, task.messageId, task.fingerprint);
  if (!pending) throw new Error('寤烘。鏉ユ簮鍥炲宸茬粡澶辨晥锛屾棤娉曢噸璇曘€?);
  return startAffectionProfileBuildsForPending(pending, {
    settings,
    chatState,
    chatId: task.chatId,
    persist,
    force: true,
  });
}

export function updateAffectionBuildTaskInitialValue({
  taskKey,
  initialValueTenths,
} = {}, {
  chatState = getChatState(),
  persist = true,
} = {}) {
  const value = Number(initialValueTenths);
  const store = getAffectionSystemState(chatState);
  const task = store.buildTasks?.[String(taskKey || '')];
  if (!isPlainObject(task)) throw new Error('寰呭鐞嗙殑棣栨寤烘。浠诲姟宸茬粡涓嶅瓨鍦ㄣ€?);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error('鍒濆濂芥劅蹇呴』鏄?0鈥?00銆佹渶澶氫竴浣嶅皬鏁般€?);
  }
  const pending = getAffectionPendingItem(store, task.messageId, task.fingerprint);
  if (!pending) throw new Error('寤烘。鏉ユ簮鍥炲宸茬粡澶辨晥锛屾棤娉曡ˉ鍏呭垵濮嬪ソ鎰熴€?);
  task.initialValueTenths = value;
  task.error = '';
  task.updatedAt = formatTimestamp();
  const firsts = (Array.isArray(pending.firsts) ? pending.firsts : [])
    .filter(item => normalizeAffectionRoleName(item?.roleName) !== normalizeAffectionRoleName(task.roleName));
  pending.firsts = [...firsts, { roleName: task.roleName, initialValueTenths: value }];
  pending.updatedAt = task.updatedAt;
  markAffectionStoreUpdated(store, persist);
  return task;
}

export async function useGenericAffectionBuildTask({ taskKey } = {}, {
  settings = getGlobalSettings(),
  chatState = getChatState(),
  persist = true,
} = {}) {
  const store = getAffectionSystemState(chatState);
  const task = store.buildTasks?.[String(taskKey || '')];
  if (!isPlainObject(task) || !Number.isInteger(Number(task.initialValueTenths))) {
    throw new Error('璇ュ缓妗ｄ换鍔＄己灏戝悎娉曞垵濮嬪ソ鎰燂紝鏃犳硶鏀圭敤閫氱敤闃舵銆?);
  }
  task.buildMode = 'generic';
  task.stages = createGenericAffectionStages();
  task.profileDraft = createProfileDraft(task, task.stages);
  task.buildStatus = 'ready';
  task.error = '';
  task.updatedAt = formatTimestamp();
  markAffectionStoreUpdated(store, persist);
  if (task.confirmed === true) {
    await commitSelectedPendingAffectionUpdates({ settings, chatState, chatId: task.chatId, persist });
  }
  getWorkflowOption('refreshPanel')?.();
  return task;
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

export function parseAffectionUpdateFromMemory(memoryText, { profiles = {} } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const rawAffectionValues = getMemoryFields(memory, 'affection');
  const rawFirstValues = getMemoryFields(memory, 'affection_first');
  if (!rawAffectionValues.length && !rawFirstValues.length) return null;

  const diagnostics = [];

  const rawAffectionEntries = rawAffectionValues.map((value, index) => {
    const entry = parseRawPipeEntry(value, 'delta');
    if (entry.extraParts.length) {
      diagnostics.push({
        code: 'ignored_ai_value_after',
        index,
        roleName: entry.roleName,
        value: entry.extraParts.join('|'),
        message: 'AI 寮傚父杈撳嚭浜?affection 绗笁娈碉紝宸插拷鐣ュ苟鐢辫处鏈噸绠椼€?,
      });
    }
    return entry;
  });
  const rawFirstEntries = rawFirstValues.map((value, index) => {
    const entry = parseRawPipeEntry(value, 'initialValue');
    if (entry.extraParts.length) {
      diagnostics.push({
        code: 'first_extra_fields',
        index,
        roleName: entry.roleName,
        message: 'affection_first 鍙厑璁歌鑹插悕涓庡垵濮嬪ソ鎰熶袱娈碉紝澶氫綑瀛楁宸插拷鐣ャ€?,
      });
    }
    return entry;
  });

  const normalizedChanges = normalizeAffectionChanges({
    entries: rawAffectionEntries,
  });
  const normalizedFirsts = normalizeAffectionFirstEntries({
    entries: rawFirstEntries,
    existingRoleNames: Object.keys(isPlainObject(profiles) ? profiles : {}),
  });
  diagnostics.push(...normalizedChanges.diagnostics, ...normalizedFirsts.diagnostics);

  const firstByRoleName = new Map(
    normalizedFirsts.items.map(item => [item.roleName, item]),
  );
  const changes = normalizedChanges.items.flatMap(item => {
    const profile = isPlainObject(profiles?.[item.roleName]) ? profiles[item.roleName] : null;
    const first = firstByRoleName.get(item.roleName);
    if (!profile && !first) {
      diagnostics.push({
        code: 'change_without_profile_or_first',
        roleName: item.roleName,
        message: `銆?{item.roleName}銆嶅皻鏈缓妗ｄ笖鏈疆娌℃湁鍚堟硶 affection_first锛屾棤娉曡绠楀綋鍓嶅ソ鎰燂紝宸叉嫆缁濊 affection銆俙,
      });
      return [];
    }

    if (first) {
      diagnostics.push({
        code: 'first_suppresses_same_turn_change',
        roleName: item.roleName,
        message: `銆?{item.roleName}銆嶆湰杞负棣栨寤烘。锛宎ffection_first 宸茶〃绀烘ゼ灞傜粨鏉熷悗鐨勫垵濮嬪ソ鎰燂紱鍚岃鑹?affection 宸插拷鐣ャ€俙,
      });
      return [];
    }

    const valueBeforeTenths = getProfileCurrentValueTenths(profile);
    return [{
      ...item,
      valueBeforeTenths,
      valueAfterTenths: clampAffectionValueTenths(valueBeforeTenths + item.deltaTenths),
    }];
  });

  const changed = changes.some(item => item.deltaTenths !== 0);
  if (
    normalizedChanges.changed
    && !changed
    && !diagnostics.some(item => item.code === 'first_suppresses_same_turn_change')
  ) {
    diagnostics.push({
      code: 'no_resolvable_change',
      message: '鏈疆娌℃湁鍙绠楀綋鍓嶅€肩殑 affection锛屽凡瑙勮寖鍖栦负鏃犲彉鍖栥€?,
    });
  }
  const firsts = normalizedFirsts.items;
  const normalizedMemory = rewriteAffectionMemoryFields(memory, { changes, firsts });

  return {
    changed,
    changes,
    firsts,
    diagnostics,
    raw: {
      affection: rawAffectionValues,
      affectionFirst: rawFirstValues,
    },
    normalizedMemory,
  };
}

export function storePendingAffectionUpdate(
  { messageId, fingerprint, analysis, origin = 'legacy' } = {},
  { chatState = getChatState(), persist = true } = {},
) {
  const numericMessageId = Number(messageId);
  const cleanFingerprint = String(fingerprint || '').trim();
  if (!Number.isInteger(numericMessageId) || numericMessageId < 0 || !cleanFingerprint || !analysis) {
    return null;
  }

  const store = getAffectionSystemState(chatState);
  const messageKey = String(numericMessageId);
  const existingBucket = isPlainObject(store.pendingByMessage[messageKey])
    ? store.pendingByMessage[messageKey]
    : {};
  const items = isPlainObject(existingBucket.items) ? existingBucket.items : {};
  const updatedAt = formatTimestamp();
  const pending = {
    messageId: numericMessageId,
    fingerprint: cleanFingerprint,
    changed: analysis.changed === true,
    changes: Array.isArray(analysis.changes) ? analysis.changes.map(item => ({ ...item })) : [],
    firsts: Array.isArray(analysis.firsts) ? analysis.firsts.map(item => ({ ...item })) : [],
    diagnostics: Array.isArray(analysis.diagnostics) ? analysis.diagnostics.map(item => ({ ...item })) : [],
    raw: isPlainObject(analysis.raw) ? { ...analysis.raw } : {},
    origin: ['legacy', 'manual'].includes(origin) ? origin : 'legacy',
    updatedAt,
  };
  items[cleanFingerprint] = pending;
  store.pendingByMessage[messageKey] = {
    messageId: numericMessageId,
    items,
    updatedAt,
  };
  if (persist) saveChatState();
  return pending;
}

export function prepareAffectionUpdateFromSummaryResult(
  result,
  {
    settings = getGlobalSettings(),
    chatState = getChatState(),
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const store = getAffectionSystemState(chatState);
  return parseAffectionUpdateFromMemory(result, { profiles: store.profiles });
}

export function processAffectionUpdateFromSummaryResult(
  result,
  {
    messageId,
    analysis = null,
    settings = getGlobalSettings(),
    chatState = getChatState(),
    persist = true,
    startBuild = true,
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const prepared = analysis || prepareAffectionUpdateFromSummaryResult(result, { settings, chatState });
  if (!prepared) {
    console.warn('[铚冪伒鍔╂墜] 鏈疆灏忔€荤粨鏈繑鍥?affection / affection_first锛屽凡璺宠繃濂芥劅 pending銆?);
    return null;
  }
  const fingerprint = getMessageContentFingerprint(messageId, settings);
  if (!fingerprint) return { ...prepared, pending: null, fingerprint: '' };
  const pending = storePendingAffectionUpdate(
    { messageId, fingerprint, analysis: prepared },
    { chatState, persist },
  );
  if (pending && startBuild) {
    void startAffectionProfileBuildsForPending(pending, {
      settings,
      chatState,
      chatId: getContextInfo().chatId,
      persist,
    }).catch(error => {
      console.error('[铚冪伒鍔╂墜] 濂芥劅棣栨瑙掕壊棰勫缓妗ｅけ璐ャ€?, error);
    });
  }
  return { ...prepared, pending, fingerprint };
}

export async function commitAffectionUpdateFromConfirmedSummary(
  result,
  {
    messageId,
    settings = getGlobalSettings(),
    chatState = getChatState(),
    chatId = getContextInfo().chatId,
    persist = true,
    isCurrentChat = () => true,
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return { active: false };
  const prepared = prepareAffectionUpdateFromSummaryResult(result, { settings, chatState });
  if (!prepared) return null;
  const numericMessageId = Number(messageId);
  const fingerprint = getMessageContentFingerprint(numericMessageId, settings);
  if (!fingerprint || !isCurrentChat()) return { ...prepared, fingerprint: '' };

  const store = getAffectionSystemState(chatState);
  const timestamp = formatTimestamp();
  const summary = {
    committedRoleNames: [],
    createdRoleNames: [],
  };
  let changed = false;

  prepared.changes.forEach(change => {
    const roleName = normalizeAffectionRoleName(change?.roleName);
    const profile = isPlainObject(store.profiles?.[roleName]) ? store.profiles[roleName] : null;
    if (!profile) return;
    if (applyPendingAffectionChange(profile, change, {
      messageId: numericMessageId,
      fingerprint,
      timestamp,
    })) {
      changed = true;
    }
    if (Number(change?.deltaTenths) !== 0) summary.committedRoleNames.push(roleName);
  });

  const firsts = Array.isArray(prepared.firsts) ? prepared.firsts : [];
  if (firsts.length) {
    const buildPending = {
      messageId: numericMessageId,
      fingerprint,
      changes: [],
      firsts,
    };
    await startAffectionProfileBuildsForPending(buildPending, {
      settings,
      chatState,
      chatId,
      persist,
    });
    if (!isCurrentChat()) return { ...prepared, fingerprint, ...summary };

    for (const first of firsts) {
      const roleName = normalizeAffectionRoleName(first?.roleName);
      if (!roleName || isPlainObject(store.profiles?.[roleName])) continue;
      const task = getMatchingAffectionBuildTask(store, {
        chatId,
        messageId: numericMessageId,
        fingerprint,
        roleName,
      });
      if (!isMatchingReadyProfileDraft(task, first)) {
        throw new Error(`濂芥劅棣栨寤烘。鏈畬鎴愶細${roleName || '鏈煡瑙掕壊'}`);
      }
      const ledger = recalculateAffectionLedger(task.profileDraft.initialValueTenths, task.profileDraft.records);
      store.profiles[roleName] = {
        ...task.profileDraft,
        roleName,
        initialValueTenths: ledger.initialValueTenths,
        valueTenths: ledger.valueTenths,
        records: ledger.records,
        sourceMessageId: numericMessageId,
        sourceFingerprint: fingerprint,
        buildStatus: 'ready',
        updatedAt: timestamp,
      };
      delete store.buildTasks[task.taskKey];
      summary.createdRoleNames.push(roleName);
      changed = true;
    }
  }

  if (changed) {
    store.lastUpdatedAt = timestamp;
    if (persist) saveChatState();
    if (persist && isCurrentChat()) await syncAffectionInjection({ settings, chatState });
    getWorkflowOption('refreshPanel')?.();
  }
  return {
    ...prepared,
    fingerprint,
    committedRoleNames: [...new Set(summary.committedRoleNames)],
    createdRoleNames: [...new Set(summary.createdRoleNames)],
  };
}

export async function commitSelectedPendingAffectionUpdates({
  settings = getGlobalSettings(),
  chatState = getChatState(),
  chatId = getContextInfo().chatId,
  persist = true,
  getSelectedFingerprint = messageId => getMessageContentFingerprint(messageId, settings),
  messageIds = null,
} = {}) {
  const summary = {
    active: isAffectionAnalysisActive(settings),
    committedMessageIds: [],
    committedRoleNames: [],
    createdRoleNames: [],
    waitingRoleNames: [],
    discardedSwipeCount: 0,
    removedBuildTaskCount: 0,
  };
  if (!summary.active) return summary;

  const store = getAffectionSystemState(chatState);
  const pendingEntries = Object.entries(store.pendingByMessage || {});
  if (!pendingEntries.length) return summary;
  const selectedMessageIds = Array.isArray(messageIds)
    ? new Set(messageIds.map(Number).filter(Number.isInteger))
    : null;

  let stateChanged = false;
  const timestamp = formatTimestamp();

  for (const [messageKey, bucket] of pendingEntries) {
    const messageId = Number(messageKey);
    if (selectedMessageIds && !selectedMessageIds.has(messageId)) continue;
    if (!Number.isInteger(messageId) || !isPlainObject(bucket) || !isPlainObject(bucket.items)) {
      delete store.pendingByMessage[messageKey];
      stateChanged = true;
      continue;
    }

    const fingerprint = String(getSelectedFingerprint(messageId) || '').trim();
    if (!fingerprint) continue;
    const selected = bucket.items[fingerprint];
    if (!isPlainObject(selected)) {
      summary.discardedSwipeCount += Object.keys(bucket.items).length;
      delete store.pendingByMessage[messageKey];
      summary.removedBuildTaskCount += removeAffectionBuildTasksForMessage(store, messageId);
      stateChanged = true;
      continue;
    }
    if (selected.origin === 'confirmed') continue;

    summary.discardedSwipeCount += Math.max(0, Object.keys(bucket.items).length - 1);
    const selectedChanges = Array.isArray(selected.changes) ? selected.changes : [];
    selectedChanges.forEach(change => {
      const roleName = normalizeAffectionRoleName(change?.roleName);
      const profile = isPlainObject(store.profiles?.[roleName]) ? store.profiles[roleName] : null;
      if (!profile) return;
      if (applyPendingAffectionChange(profile, change, { messageId, fingerprint, timestamp })) {
        stateChanged = true;
      }
      if (Number(change?.deltaTenths) !== 0) summary.committedRoleNames.push(roleName);
    });

    const unresolvedFirsts = [];
    const keepTaskKeys = [];
    (Array.isArray(selected.firsts) ? selected.firsts : []).forEach(first => {
      const roleName = normalizeAffectionRoleName(first?.roleName);
      if (!roleName || isPlainObject(store.profiles?.[roleName])) return;
      const task = getMatchingAffectionBuildTask(store, {
        chatId,
        messageId,
        fingerprint,
        roleName,
      });
      if (isMatchingReadyProfileDraft(task, first)) {
        const draft = task.profileDraft;
        const ledger = recalculateAffectionLedger(draft.initialValueTenths, draft.records);
        store.profiles[roleName] = {
          ...draft,
          roleName,
          initialValueTenths: ledger.initialValueTenths,
          valueTenths: ledger.valueTenths,
          records: ledger.records,
          sourceMessageId: messageId,
          sourceFingerprint: fingerprint,
          buildStatus: 'ready',
          updatedAt: timestamp,
        };
        delete store.buildTasks[task.taskKey];
        summary.createdRoleNames.push(roleName);
        stateChanged = true;
        return;
      }
      if (task?.buildStatus === 'building') {
        task.confirmed = true;
        task.confirmedAt = task.confirmedAt || timestamp;
        task.updatedAt = timestamp;
        unresolvedFirsts.push({ ...first });
        keepTaskKeys.push(task.taskKey);
        summary.waitingRoleNames.push(roleName);
        stateChanged = true;
      }
    });

    summary.removedBuildTaskCount += removeAffectionBuildTasksForMessage(store, messageId, {
      keepTaskKeys,
    });
    if (unresolvedFirsts.length) {
      selected.changes = [];
      selected.changed = false;
      selected.firsts = unresolvedFirsts;
      selected.confirmed = true;
      selected.confirmedAt = selected.confirmedAt || timestamp;
      selected.updatedAt = timestamp;
      store.pendingByMessage[messageKey] = {
        messageId,
        items: { [fingerprint]: selected },
        updatedAt: timestamp,
      };
    } else {
      delete store.pendingByMessage[messageKey];
    }
    summary.committedMessageIds.push(messageId);
    stateChanged = true;
  }

  summary.committedMessageIds = [...new Set(summary.committedMessageIds)];
  summary.committedRoleNames = [...new Set(summary.committedRoleNames)];
  summary.createdRoleNames = [...new Set(summary.createdRoleNames)];
  summary.waitingRoleNames = [...new Set(summary.waitingRoleNames)];
  if (stateChanged) {
    store.lastUpdatedAt = timestamp;
    if (persist) saveChatState();
    if (persist) await syncAffectionInjection({ settings, chatState });
    getWorkflowOption('refreshPanel')?.();
  }
  return summary;
}

function resolveSetExtensionPrompt() {
  const context = getContextSafe();
  if (typeof context?.setExtensionPrompt === 'function') {
    return (...args) => context.setExtensionPrompt(...args);
  }
  if (typeof globalThis.setExtensionPrompt === 'function') {
    return (...args) => globalThis.setExtensionPrompt(...args);
  }
  return null;
}

async function clearAffectionInjection(setExtensionPrompt) {
  const disabledFilter = () => false;
  await setExtensionPrompt(AFFECTION_STATE_PROMPT_ID, '', -1, 0, false, 0, disabledFilter);
  await setExtensionPrompt(
    AFFECTION_STATE_PROMPT_ID,
    '',
    AFFECTION_STATE_INJECT_POSITION,
    AFFECTION_STATE_INJECT_DEPTH,
    false,
    0,
    disabledFilter,
  );
}

export async function syncAffectionInjection({
  settings = getGlobalSettings(),
  chatState = getChatState(),
  setExtensionPrompt = resolveSetExtensionPrompt(),
  getLatestSettings = () => getGlobalSettings(),
  getLatestChatState = () => getChatState(),
} = {}) {
  if (typeof setExtensionPrompt !== 'function') {
    return { action: 'unavailable', content: '', promptId: AFFECTION_STATE_PROMPT_ID };
  }
  const content = isAffectionAnalysisActive(settings)
    ? buildAffectionInjection(chatState)
    : '';
  if (!content) {
    await clearAffectionInjection(setExtensionPrompt);
    return { action: 'clear', content: '', promptId: AFFECTION_STATE_PROMPT_ID };
  }
  await setExtensionPrompt(
    AFFECTION_STATE_PROMPT_ID,
    content,
    AFFECTION_STATE_INJECT_POSITION,
    AFFECTION_STATE_INJECT_DEPTH,
    false,
    0,
    () => {
      const latestSettings = getLatestSettings();
      return Boolean(
        isAffectionAnalysisActive(latestSettings)
        && buildAffectionInjection(getLatestChatState())
      );
    },
  );
  return { action: 'set', content, promptId: AFFECTION_STATE_PROMPT_ID };
}

export function registerAffectionWorkflowEvents() {
  registerPendingCommitHandler(
    AFFECTION_PENDING_COMMIT_HANDLER_ID,
    commitSelectedPendingAffectionUpdates,
  );
  affectionPendingCommitRegistered = true;
  if (affectionEventsRegistered) return true;
  const tavernEvents = getTavernEventsSafe();
  const syncHandler = () => {
    void syncAffectionInjection().catch(error => {
      console.warn('[铚冪伒鍔╂墜] 濂芥劅鏀荤暐鐘舵€佹敞鍏ュ埛鏂板け璐ャ€?, error);
    });
  };
  [
    tavernEvents.GENERATE_BEFORE_COMBINE_PROMPTS,
    tavernEvents.CHAT_CHANGED,
  ].filter(Boolean).forEach(eventName => {
    const stop = registerTavernEvent(eventName, syncHandler);
    if (stop) affectionEventStops.push(stop);
  });
  affectionEventsRegistered = affectionEventStops.length > 0;
  syncHandler();
  return affectionPendingCommitRegistered;
}
