// 回忆录世界书业务流程。
// 阶段 3a：确保当前聊天有经过用户确认的可写入世界书。
//   - 当前聊天无绑定 -> 新建「蜃灵回忆录｜<聊天标识>」并绑定。
//   - 已绑定且本聊天确认过 -> 直接复用。
//   - 已绑定但未确认/绑定已变化 -> 由 UI 询问：复用当前书，或创建蜃灵专属书并切换绑定。

import { GRAND_MEMORY_BLOCK_RE, LIST_BLOCK_RE, MEMORY_BLOCK_RE } from '../../constants.js';
import { getChatMessagesSafe, getContextSafe } from '../../core/chat.js';
import {
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
} from '../../core/generation.js';
import {
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import { extractSummarySourceContent, formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  CAPTURE_SOURCE_MODES,
  appendCaptureDrafts,
  getChatState,
  getGlobalSettings,
  getMemoirState,
  getMemoirSettings,
  getSummarySettings,
  normalizeCaptureDraft,
  normalizeCaptureState,
  saveChatState,
} from '../../core/settings.js';
export {
  CAPTURE_POSITIONS,
  CAPTURE_SOURCE_MODES,
  CAPTURE_TYPES,
  clearCaptureDrafts,
  removeCaptureDrafts,
} from '../../core/settings.js';
import {
  collectEmotionProfiles,
  formatCharacterCardForPrompt,
  formatUserPersonaForPrompt,
  getResolvedCharacterCard,
  getUserPersona,
} from '../../core/context-resolver.js';
import {
  buildCapturePromptMessages,
  buildMemoirExtractPrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import { getWorldbookApi, getWorldbookReadApi } from '../../core/worldbook.js';
import {
  buildMemoirBlueContent,
  ensureMemoirWorldbook,
  isDedicatedMemoirBook,
  reconcileMemoirWorldbookState,
  updateWorldbookWithVerification,
  verifyWorldbookEntries,
} from './worldbook-manager.js';

export { ensureMemoirWorldbook, isDedicatedMemoirBook } from './worldbook-manager.js';

// ── 阶段 3b：大总结后提炼回忆候选（只解析，不写入世界书）──────────────

/** 用大总结的 messageId + 区间作为幂等键，避免同一次归档重复提炼。 */
function buildSourceKey(archiveRecord = {}) {
  const id = archiveRecord.summaryMessageId ?? archiveRecord.id ?? '';
  const from = archiveRecord.memoryFrom ?? archiveRecord.archiveFrom ?? '';
  const to = archiveRecord.memoryTo ?? archiveRecord.archiveTo ?? '';
  return `grand:${id}:${from}-${to}`;
}

/** 把情感档案压成提炼素材可读的短文本。 */
function buildEmotionMaterial() {
  const profiles = collectEmotionProfiles({ includeAll: true });
  if (!profiles.length) return '';
  return profiles
    .map(p => {
      const parts = [
        p.currentStatus ? `状态：${p.currentStatus}` : '',
        p.relationshipToUser ? `与{{user}}关系：${p.relationshipToUser}` : '',
      ].filter(Boolean).join('；');
      return `- ${p.roleName}｜${parts}`;
    })
    .join('\n');
}

/** 把已记录条目压成「事件 / 人 / 关键锚点」简表，供 AI 去重参考。 */
function buildRecordedList(memoir) {
  const entries = Array.isArray(memoir.entries) ? memoir.entries : [];
  if (!entries.length) return '';
  return entries
    .map(e => {
      const people = Array.isArray(e.mainKeywords) ? e.mainKeywords.slice(0, 2).join('/') : '';
      const anchor = Array.isArray(e.filterKeywords) ? e.filterKeywords.slice(0, 2).join('/') : '';
      return `- ${e.title || '未命名'}${people ? ` / ${people}` : ''}${anchor ? ` / ${anchor}` : ''}`;
    })
    .join('\n');
}

/** 宽松解析模型输出：容忍 ```json 代码块包裹或前后杂讯。 */
function parseMemoirJson(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('模型无输出。');
  let jsonText = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    jsonText = fence[1].trim();
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = text.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`回忆录 JSON 解析失败：${error.message}`);
  }
  const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const overview = Array.isArray(parsed?.overview) ? parsed.overview : [];
  return { overview, memories };
}

/**
 * 大总结完成后尝试提炼回忆候选。
 * 只负责「门控 → 幂等 → 收集素材 → 调 API → 解析」，不写世界书、不改 sourceProcessed。
 * 写入与幂等标记留待阶段四/五。
 *
 * @param {object} archiveRecord 来自 processAutoGrandMemory 的归档记录
 * @param {object} deps
 *   - generate: (prompt, opts) => Promise<string>  复用大总结链路（跟随设置里选的主/副 API）
 *   - grandMemoryText: string 本次大总结正文
 *   - force: boolean 诊断试跑用；跳过 enabled 门控与 sourceProcessed 幂等，强制走一次生成
 * @returns {Promise<{ skipped?: string, sourceKey?: string, prompt?: string, raw?: string,
 *   overview: any[], memories: any[] }>}
 */
export async function tryExtractMemoirFromGrandSummary(archiveRecord, { generate, grandMemoryText, force = false } = {}) {
  const memoirSettings = getMemoirSettings();
  if (!force && !memoirSettings.enabled) {
    return { skipped: 'disabled', overview: [], memories: [] };
  }
  if (typeof generate !== 'function') {
    throw new Error('未提供生成函数，无法提炼回忆候选。');
  }

  // 提炼前先检查真实世界书；整本书已删除时清掉旧索引/来源，避免旧记录继续影响去重素材。
  try {
    await reconcileMemoirWorldbookState();
  } catch (error) {
    console.warn('[蜃灵助手] 提炼前同步回忆录世界书失败，将保留现有本地状态。', error);
  }
  const memoir = getMemoirState();
  const sourceKey = buildSourceKey(archiveRecord);
  if (!force && memoir.sourceProcessed.includes(sourceKey)) {
    return { skipped: 'already_processed', sourceKey, overview: [], memories: [] };
  }
  const pendingSourceKeys = Array.isArray(memoir.pending?.sourceKeys)
    ? memoir.pending.sourceKeys
    : [memoir.pending?.sourceKey].filter(Boolean);
  if (!force && pendingSourceKeys.includes(sourceKey)) {
    return { skipped: 'already_pending', sourceKey, overview: [], memories: [] };
  }

  const grandMemoryMaterial = String(grandMemoryText || '').trim();
  if (!grandMemoryMaterial) {
    return { skipped: 'no_material', sourceKey, overview: [], memories: [] };
  }

  const settings = getGlobalSettings();
  const prompt = buildMemoirExtractPrompt({
    grandMemoryMaterial,
    emotionMaterial: buildEmotionMaterial(),
    recordedList: buildRecordedList(memoir),
    template: resolvePromptText(PROMPT_IDS.MEMOIR_EXTRACT, settings),
  });

  const raw = await generate(prompt, { type: '回忆录提炼', apiMode: memoirSettings.apiMode });
  const { overview, memories } = parseMemoirJson(raw);

  return { sourceKey, prompt, raw, overview, memories };
}

// ── 阶段四：候选暂存到 pending，交用户确认 ────────────────────────────

function createCandidateId(index) {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `cand-${globalThis.crypto.randomUUID()}`;
    }
  } catch {}
  return `cand-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${index}`;
}

/** 规范化单条绿灯候选，容错缺字段。创建后即持久化稳定 candidateId，供面板和失败重试复用。 */
function normalizeCandidate(mem, index) {
  const asArray = v => (Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []);
  const importance = ['high', 'medium', 'low'].includes(mem?.importance) ? mem.importance : 'medium';
  return {
    candidateId: createCandidateId(index),
    title: String(mem?.title || '').trim() || '未命名回忆',
    storyTime: String(mem?.storyTime || '').trim() || '未明',
    importance,
    participants: asArray(mem?.participants),
    mainKeywords: asArray(mem?.mainKeywords),
    filterKeywords: asArray(mem?.filterKeywords),
    content: String(mem?.content || '').trim(),
  };
}

/** 把提炼结果规范化后暂存到 chatState.memoir.pending，等待用户确认。 */
export function stageMemoirCandidates({ sourceKey, overview, memories } = {}) {
  const memoir = getMemoirState();
  const candidates = (Array.isArray(memories) ? memories : [])
    .map((m, i) => normalizeCandidate(m, i))
    .filter(c => c.content); // 无正文的丢弃

  // digest 从 overview 里按 title 对齐补进候选，供面板/蓝灯使用
  const overviewList = Array.isArray(overview) ? overview : [];
  const digestByTitle = new Map(
    overviewList
      .filter(o => o && o.title)
      .map(o => [String(o.title).trim(), String(o.digest || '').trim()]),
  );
  candidates.forEach(c => {
    c.digest = digestByTitle.get(c.title) || '';
  });

  const previous = memoir.pending && Array.isArray(memoir.pending.candidates)
    ? memoir.pending
    : null;
  const previousSourceKeys = Array.isArray(previous?.sourceKeys)
    ? previous.sourceKeys
    : [previous?.sourceKey].filter(Boolean);
  const sourceKeys = [...new Set([...previousSourceKeys, sourceKey].filter(Boolean))];

  memoir.pending = {
    sourceKey: sourceKeys[0] || '', // 兼容旧状态读取；新代码以 sourceKeys 为准
    sourceKeys,
    candidates: [...(previous?.candidates || []), ...candidates],
    generatedAt: formatTimestamp(),
  };
  saveChatState();
  return memoir.pending;
}

/** 丢弃当前 pending 候选（用户点“全部忽略”）。 */
export function discardMemoirPending() {
  const memoir = getMemoirState();
  memoir.pending = null;
  saveChatState();
}

// ── 阶段五：把确认后的候选写入世界书 ─────────────────────────────────

const MEMOIR_GREEN_NAME_PREFIX = 'SLX-Memoir-Green-';
const MEMOIR_BLUE_NAME = 'SLX-Memoir-Blue-回忆录总览';

/** 绿灯条目正文：时间前置，AI 可读，不含来源信息。 */
function buildGreenContent(entry) {
  const time = entry.storyTime && entry.storyTime !== '未明' ? `【${entry.storyTime}】` : '';
  return `${time}${entry.content}`.trim();
}

function normalizeWorldbookContent(content) {
  return String(content || '').replace(/\r\n/g, '\n').trim();
}

// 插入顺序（order）：蓝灯总览固定 900，绿灯从 901 起按记录（≈剧情）顺序逐条 +1。
// 说明：memoir.entries 的数组顺序就是记录顺序，因大总结按剧情推进依次处理，天然即时间序；
// storyTime 是自由文本（不同世界的纪年/时段各异），不做字符串排序，避免误排。
const MEMOIR_BLUE_ORDER = 900;
const MEMOIR_GREEN_ORDER_BASE = 901;

/** 绿灯条目结构（新 schema），供 createWorldbookEntries。order 会在写入后统一重排。 */
function buildGreenEntryPayload(entry, order) {
  return {
    name: `${MEMOIR_GREEN_NAME_PREFIX}${entry.title}`,
    enabled: true,
    strategy: {
      type: 'selective',
      keys: entry.mainKeywords.length ? entry.mainKeywords : [entry.title],
      keys_secondary: { logic: 'and_any', keys: entry.filterKeywords },
      scan_depth: 'same_as_global',
    },
    position: { type: 'after_character_definition', role: 'system', depth: 0, order },
    content: buildGreenContent(entry),
    probability: 100,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    extra: {
      memoirId: entry.memoirId,
      memoirType: 'green',
      storyTime: entry.storyTime,
      importance: entry.importance,
      participants: entry.participants,
    },
  };
}

/**
 * 把用户确认后的候选写入世界书。
 * - 绿灯：逐条新增（增量，不动旧条目）。
 * - 蓝灯：用全量 entries 重建后覆盖（不丢旧目录）。
 * - 独立读回确认绿灯与蓝灯后，才更新 entries、sourceProcessed 并清空 pending。
 *
 * @param {Array} confirmedCandidates 用户确认保留（可能已编辑）的候选数组
 * @param {object} opts - sourceKey: 幂等键（写入后记入 sourceProcessed）
 * @returns {Promise<{ worldbookName, greenAdded, blueMode, totalEntries, verified }>}
 */
export async function commitMemoirCandidates(
  confirmedCandidates,
  { sourceKey, sourceKeys: pendingSourceKeys = [], confirmUseCurrent } = {},
) {
  const list = Array.isArray(confirmedCandidates) ? confirmedCandidates.filter(c => c && c.content) : [];
  if (!list.length) {
    throw new Error('没有可写入的回忆候选。');
  }

  // 1) 准备本轮绿灯。candidateId 来自已持久化 pending，可让失败重试保持同一 memoirId。
  const now = formatTimestamp();
  const newEntries = list.map((c) => {
    const memoirId = c.memoirId || (c.candidateId
      ? String(c.candidateId).replace(/^cand-/, 'mem-')
      : '');
    if (!memoirId) {
      throw new Error('待写入候选缺少稳定 ID，请重新提炼后再试。');
    }
    return {
      memoirId,
      title: c.title,
      digest: c.digest || '',
      storyTime: c.storyTime || '未明',
      importance: ['high', 'medium', 'low'].includes(c.importance) ? c.importance : 'medium',
      participants: Array.isArray(c.participants) ? c.participants : [],
      mainKeywords: Array.isArray(c.mainKeywords) ? c.mainKeywords : [],
      filterKeywords: Array.isArray(c.filterKeywords) ? c.filterKeywords : [],
      content: c.content,
      createdAt: now,
      updatedAt: now,
    };
  });

  // 稳定 ID 校验通过后再解析/创建目标世界书，避免无效候选触发绑定副作用。
  const api = getWorldbookApi();
  const { worldbookName } = await ensureMemoirWorldbook({ confirmUseCurrent });
  const memoir = getMemoirState();
  const sourceKeys = [...new Set([
    ...(Array.isArray(pendingSourceKeys) ? pendingSourceKeys : []),
    sourceKey,
  ].filter(Boolean))];

  // pending 失败重试时，同一 candidateId 会得到同一 memoirId。新值覆盖本地同 ID 索引，
  // 但不会改变原有顺序；真正是否需要补写，以世界书内的稳定 ID 为准。
  const unkeyedEntries = memoir.entries.filter(entry => !entry?.memoirId);
  const entriesById = new Map(
    memoir.entries
      .filter(entry => entry?.memoirId)
      .map(entry => [entry.memoirId, entry]),
  );
  newEntries.forEach(entry => entriesById.set(entry.memoirId, entry));
  const allEntries = [...unkeyedEntries, ...entriesById.values()];

  // 2) 单次更新完成绿灯新增、蓝灯创建/覆盖和全量排序，避免中途失败留下半批条目。
  const blueContent = buildMemoirBlueContent(allEntries);
  const greenOrderById = new Map(
    allEntries.map((e, i) => [e.memoirId, MEMOIR_GREEN_ORDER_BASE + i]),
  );
  let blueMode = 'updated';
  const greenAddedIds = new Set();
  const verification = await updateWorldbookWithVerification(worldbookName, (book) => {
    const list2 = Array.isArray(book) ? book : [];
    const existingMemoirIds = new Set(
      list2.map(entry => entry?.extra?.memoirId).filter(Boolean),
    );
    newEntries.forEach((entry) => {
      if (existingMemoirIds.has(entry.memoirId)) return;
      list2.push(buildGreenEntryPayload(entry, greenOrderById.get(entry.memoirId)));
      existingMemoirIds.add(entry.memoirId);
      greenAddedIds.add(entry.memoirId);
    });

    let blueFound = false;
    list2.forEach(e => {
      if (!e) return;
      if (e.extra?.memoirType === 'green' && greenOrderById.has(e.extra.memoirId)) {
        e.position = { ...(e.position || {}), order: greenOrderById.get(e.extra.memoirId) };
      }
      if (e.name === MEMOIR_BLUE_NAME || e.extra?.memoirType === 'blue') {
        blueFound = true;
        e.content = blueContent;
        e.extra = { ...(e.extra || {}), memoirType: 'blue' };
        e.strategy = { ...(e.strategy || {}), type: 'constant' };
        e.position = { ...(e.position || {}), order: MEMOIR_BLUE_ORDER };
        e.recursion = { prevent_incoming: true, prevent_outgoing: true, delay_until: null };
      }
    });
    if (!blueFound) {
      list2.push({
        name: MEMOIR_BLUE_NAME,
        enabled: true,
        strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
        position: { type: 'after_character_definition', role: 'system', depth: 0, order: MEMOIR_BLUE_ORDER },
        content: blueContent,
        probability: 100,
        recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
        extra: { memoirType: 'blue' },
      });
      blueMode = 'created';
    }
    return list2;
  }, {
    api,
    idField: 'memoirId',
    expectedIds: newEntries.map(entry => entry.memoirId),
    typeField: 'memoirType',
    typeValue: 'green',
  });

  // 3) update 返回不等于真实持久化成功；共享管理器已独立读回并按 memoirId 核对本批绿灯。
  const blueEntry = verification.book.find(entry => entry?.extra?.memoirType === 'blue') || null;
  const blueContentMatches = blueEntry
    && normalizeWorldbookContent(blueEntry.content) === normalizeWorldbookContent(blueContent);
  if (!verification.ok || !blueEntry || !blueContentMatches) {
    const problems = [];
    if (verification.missingIds.length) {
      problems.push(`缺少绿灯：${verification.missingIds.join('、')}`);
    }
    if (!blueEntry) problems.push('缺少蓝灯总览');
    else if (!blueContentMatches) problems.push('蓝灯总览内容与预期不一致');
    const error = new Error(`世界书写入后的读回核对失败（${problems.join('；')}）。待确认批次已保留，可安全重试。`);
    error.name = 'WorldbookVerificationError';
    error.worldbookName = worldbookName;
    error.missingMemoirIds = verification.missingIds;
    error.blueVerified = !!blueEntry && !!blueContentMatches;
    throw error;
  }

  // 4) 全部读回成功后才写本地索引；UID 按稳定 ID 回填，不再按可能重名的标题匹配。
  const verifiedById = new Map(
    verification.verifiedEntries.map(entry => [entry.extra.memoirId, entry]),
  );
  allEntries.forEach(entry => {
    const verified = verifiedById.get(entry.memoirId);
    if (verified?.uid !== undefined && verified?.uid !== null) entry.uid = verified.uid;
  });
  memoir.entries = allEntries;

  // 5) 只有绿灯与蓝灯均核对通过，才做幂等标记并清 pending。
  sourceKeys.forEach((key) => {
    if (!memoir.sourceProcessed.includes(key)) memoir.sourceProcessed.push(key);
  });
  memoir.pending = null;
  memoir.updatedAt = now;
  saveChatState();

  return {
    worldbookName,
    greenAdded: greenAddedIds.size,
    blueMode,
    totalEntries: memoir.entries.length,
    verified: true,
  };
}

// ── 手动提炼：从最新大总结提炼并暂存（供面板“手动提炼”按钮）──────────

/**
 * 手动触发：读最新大总结正文提炼候选并暂存到 pending。
 * @param {object} deps - generate: 生成函数（由 UI 注入 generateSummaryMemory）
 *   - grandMemoryText: 可选，指定素材；不传则由调用方读取最新大总结
 * @returns {Promise<{ staged: boolean, count: number, reason?: string }>}
 */
export async function runManualMemoirExtraction({
  generate,
  grandMemoryText,
  sourceKey,
  archiveRecord = null,
  allowProcessed = false,
} = {}) {
  const resolvedRecord = archiveRecord || {
    summaryMessageId: sourceKey || 'manual',
    memoryFrom: '?',
    memoryTo: '?',
  };
  const resolvedSourceKey = buildSourceKey(resolvedRecord);
  const memoir = getMemoirState();
  const pendingSourceKeys = Array.isArray(memoir.pending?.sourceKeys)
    ? memoir.pending.sourceKeys
    : [memoir.pending?.sourceKey].filter(Boolean);
  if (!allowProcessed && pendingSourceKeys.includes(resolvedSourceKey)) {
    return { staged: false, count: 0, reason: 'already_pending', sourceKey: resolvedSourceKey };
  }
  if (!allowProcessed && memoir.sourceProcessed.includes(resolvedSourceKey)) {
    return { staged: false, count: 0, reason: 'already_processed', sourceKey: resolvedSourceKey };
  }

  const result = await tryExtractMemoirFromGrandSummary(resolvedRecord, {
    generate,
    grandMemoryText,
    force: true, // 手动提炼绕过 enabled/幂等，由用户主动发起
  });
  if (!result.memories.length) {
    return { staged: false, count: 0, reason: 'no_memory' };
  }
  stageMemoirCandidates(result);
  return { staged: true, count: result.memories.length };
}

// ── 设定采集材料读取与角色绑定世界书解析 ──────────────────────────

// 设定采集主要剧情材料读取与预检。阶段 C 只处理聊天和大总结，不读取可选上下文。


export const MAX_CAPTURE_CHAT_MESSAGES = 200;

export const CAPTURE_MATERIAL_ERROR_CODES = Object.freeze({
  INVALID_SOURCE_MODE: 'invalid_source_mode',
  INVALID_FLOOR_RANGE: 'invalid_floor_range',
  FLOOR_OUT_OF_RANGE: 'floor_out_of_range',
  EMPTY_CHAT: 'empty_chat',
  EMPTY_MATERIAL: 'empty_material',
  GRAND_SUMMARY_NOT_FOUND: 'grand_summary_not_found',
  TOO_MANY_MESSAGES: 'too_many_messages',
});

export const CAPTURE_OPTIONAL_ERROR_CODES = Object.freeze({
  CHARACTER_CARD_UNAVAILABLE: 'character_card_unavailable',
  PERSONA_UNAVAILABLE: 'persona_unavailable',
  WORLDBOOK_LIST_FAILED: 'worldbook_list_failed',
  WORLDBOOK_LOAD_FAILED: 'worldbook_load_failed',
  WORLDBOOK_REF_MISSING: 'worldbook_ref_missing',
});

function isCaptureMaterialObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCaptureMaterialFloor(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeRecentCount(value) {
  if (value === null || value === undefined || value === '') return 20;
  const number = Number(value);
  if (!Number.isFinite(number)) return 20;
  return Math.min(200, Math.max(5, Math.trunc(number)));
}

function normalizeRole(message) {
  const role = String(message?.role || (message?.is_user ? 'user' : 'assistant')).toLowerCase();
  return role === 'user' || role === 'assistant' ? role : '';
}

function getMessageFloor(message, index = 0) {
  const floor = Number(message?.message_id ?? message?.id ?? index);
  return Number.isFinite(floor) && floor >= 0 ? Math.trunc(floor) : null;
}

function getRawMessageContent(message) {
  return String(message?.message ?? message?.mes ?? message?.content ?? '');
}

function isSystemOrInjectedMessage(message) {
  return message?.is_system === true
    || message?.extra?.is_system === true
    || message?.extra?.isSmallSys === true
    || message?.extra?.isAuthorNote === true
    || message?.extra?.is_author_note === true;
}

function cleanPureChatContent(content, summarySettings) {
  const withoutManagedBlocks = String(content || '')
    .replace(GRAND_MEMORY_BLOCK_RE, '')
    .replace(MEMORY_BLOCK_RE, '')
    .replace(LIST_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return extractSummarySourceContent(withoutManagedBlocks, summarySettings).trim();
}

function resolveSpeaker(message, role, names) {
  const explicitName = String(message?.name ?? '').trim();
  if (explicitName) return explicitName;
  return role === 'user' ? names.userName : names.characterName;
}

function resolveNames(names = {}) {
  const context = getContextSafe();
  return {
    userName: String(names.userName || context?.name1 || context?.user_name || '用户').trim() || '用户',
    characterName: String(names.characterName || context?.name2 || context?.character?.name || '角色').trim() || '角色',
  };
}

/**
 * 从真实聊天楼层中提取纯聊天。隐藏的正常用户/角色楼层仍保留，以支持读取被大总结归档的原始剧情。
 * getChatMessagesSafe 只返回当前选中的 swipe；本函数不会遍历 message.swipes。
 */
export function collectPureChatMessages({ messages, summarySettings, names } = {}) {
  const rawMessages = Array.isArray(messages)
    ? messages
    : getChatMessagesSafe(undefined, { hide_state: 'all' });
  const settings = isCaptureMaterialObject(summarySettings) ? summarySettings : getSummarySettings();
  const resolvedNames = resolveNames(names);

  return rawMessages
    .map((message, index) => ({ message, floor: getMessageFloor(message, index) }))
    .filter(item => item.floor !== null)
    .sort((a, b) => a.floor - b.floor)
    .flatMap(({ message, floor }) => {
      const role = normalizeRole(message);
      if (!role || isSystemOrInjectedMessage(message)) return [];
      const rawContent = getRawMessageContent(message);
      if (GRAND_MEMORY_BLOCK_RE.test(rawContent)) return [];
      const content = cleanPureChatContent(rawContent, settings);
      if (!content) return [];
      return [{
        floor,
        role,
        speaker: resolveSpeaker(message, role, resolvedNames),
        content,
        characterCount: content.length,
        isHidden: message?.is_hidden === true,
      }];
    });
}

export function formatCaptureChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => `第 ${message.floor} 楼｜${message.speaker}：${message.content}`)
    .join('\n\n');
}

function createStats(messages, material) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    fromFloor: list[0]?.floor ?? null,
    toFloor: list.at(-1)?.floor ?? null,
    floorIds: list.map(message => message.floor),
    messageCount: list.length,
    characterCount: String(material || '').length,
  };
}

function createSuccess(mode, messages, material, extra = {}) {
  return {
    ok: true,
    mode,
    material,
    messages,
    summary: extra.summary || null,
    stats: createStats(messages, material),
    errors: [],
    ...extra,
  };
}

function createFailure(mode, code, message, details = {}) {
  return {
    ok: false,
    mode,
    material: '',
    messages: [],
    summary: null,
    stats: createStats([], ''),
    errors: [{ code, message, details }],
  };
}

function getRawFloorBounds(rawMessages) {
  const floors = (Array.isArray(rawMessages) ? rawMessages : [])
    .map(getMessageFloor)
    .filter(floor => floor !== null);
  return {
    minFloor: floors.length ? Math.min(...floors) : null,
    maxFloor: floors.length ? Math.max(...floors) : null,
  };
}

function resolveRecentChat(source, context) {
  const count = normalizeRecentCount(source.recentCount);
  const selected = context.pureMessages.slice(-count);
  if (!selected.length) {
    return createFailure('recent_chat', CAPTURE_MATERIAL_ERROR_CODES.EMPTY_MATERIAL, '最近聊天中没有可用的纯聊天楼层。');
  }
  const material = formatCaptureChatMessages(selected);
  return createSuccess('recent_chat', selected, material, { requestedCount: count });
}

function resolveFloorRange(source, context) {
  const fromFloor = normalizeCaptureMaterialFloor(source.fromFloor);
  const toFloor = normalizeCaptureMaterialFloor(source.toFloor);
  if (fromFloor === null || toFloor === null || fromFloor > toFloor) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.INVALID_FLOOR_RANGE,
      '指定楼层范围无效，请填写非负整数，且起始楼层不能大于结束楼层。',
      { fromFloor: source.fromFloor ?? null, toFloor: source.toFloor ?? null },
    );
  }
  const { minFloor, maxFloor } = context.rawFloorBounds;
  if (minFloor === null || maxFloor === null) {
    return createFailure('floor_range', CAPTURE_MATERIAL_ERROR_CODES.EMPTY_CHAT, '当前聊天没有任何楼层。');
  }
  if (fromFloor < minFloor || fromFloor > maxFloor || toFloor > maxFloor) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.FLOOR_OUT_OF_RANGE,
      `指定楼层超出当前聊天范围 ${minFloor}—${maxFloor}。`,
      { fromFloor, toFloor, minFloor, maxFloor },
    );
  }
  const selected = context.pureMessages.filter(message => (
    message.floor >= fromFloor && message.floor <= toFloor
  ));
  if (!selected.length) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.EMPTY_MATERIAL,
      `第 ${fromFloor}—${toFloor} 楼没有可用的纯聊天内容。`,
      { fromFloor, toFloor },
    );
  }
  if (selected.length > MAX_CAPTURE_CHAT_MESSAGES) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.TOO_MANY_MESSAGES,
      `指定范围包含 ${selected.length} 条纯聊天，超过单次最多 ${MAX_CAPTURE_CHAT_MESSAGES} 条的保护限制。`,
      { fromFloor, toFloor, messageCount: selected.length, maxMessageCount: MAX_CAPTURE_CHAT_MESSAGES },
    );
  }
  const material = formatCaptureChatMessages(selected);
  return createSuccess('floor_range', selected, material, {
    requestedRange: { fromFloor, toFloor },
  });
}

function extractGrandSummaryContent(content) {
  const match = String(content || '').match(GRAND_MEMORY_BLOCK_RE);
  return match?.[0]?.trim() || '';
}

function findLatestGrandSummary(rawMessages, chatState) {
  const messagesByFloor = new Map(
    (Array.isArray(rawMessages) ? rawMessages : [])
      .map((message, index) => [getMessageFloor(message, index), message])
      .filter(([floor]) => floor !== null),
  );
  const records = Array.isArray(chatState?.summary?.archiveRecords)
    ? chatState.summary.archiveRecords
    : [];
  const activeRecords = records
    .filter(record => !record?.compressedBy)
    .sort((a, b) => Number(b?.summaryMessageId ?? -1) - Number(a?.summaryMessageId ?? -1));

  for (const record of activeRecords) {
    const messageId = normalizeCaptureMaterialFloor(record?.summaryMessageId);
    const message = messageId === null ? null : messagesByFloor.get(messageId);
    const content = extractGrandSummaryContent(getRawMessageContent(message));
    if (!message || normalizeRole(message) !== 'assistant' || isSystemOrInjectedMessage(message) || !content) continue;
    return {
      messageId,
      content,
      coverageFrom: normalizeCaptureMaterialFloor(record.archiveFrom),
      coverageTo: normalizeCaptureMaterialFloor(record.archiveTo),
      recordId: String(record.id ?? ''),
    };
  }

  const fallback = [...messagesByFloor.entries()]
    .sort((a, b) => b[0] - a[0])
    .find(([, message]) => (
      normalizeRole(message) === 'assistant'
      && !isSystemOrInjectedMessage(message)
      && extractGrandSummaryContent(getRawMessageContent(message))
    ));
  if (!fallback) return null;
  return {
    messageId: fallback[0],
    content: extractGrandSummaryContent(getRawMessageContent(fallback[1])),
    coverageFrom: null,
    coverageTo: null,
    recordId: '',
  };
}

function resolveGrandPlusAfter(context) {
  const summary = findLatestGrandSummary(context.rawMessages, context.chatState);
  if (!summary) {
    return createFailure(
      'grand_plus_after',
      CAPTURE_MATERIAL_ERROR_CODES.GRAND_SUMMARY_NOT_FOUND,
      '当前聊天没有可用的大总结。',
    );
  }
  const messages = context.pureMessages.filter(message => message.floor > summary.messageId);
  if (messages.length > MAX_CAPTURE_CHAT_MESSAGES) {
    return createFailure(
      'grand_plus_after',
      CAPTURE_MATERIAL_ERROR_CODES.TOO_MANY_MESSAGES,
      `大总结后有 ${messages.length} 条纯聊天，超过单次最多 ${MAX_CAPTURE_CHAT_MESSAGES} 条的保护限制。`,
      { summaryMessageId: summary.messageId, messageCount: messages.length, maxMessageCount: MAX_CAPTURE_CHAT_MESSAGES },
    );
  }
  const coverage = summary.coverageFrom !== null && summary.coverageTo !== null
    ? `｜覆盖第 ${summary.coverageFrom}—${summary.coverageTo} 楼`
    : '';
  const sections = [`【最近大总结｜第 ${summary.messageId} 楼${coverage}】\n${summary.content}`];
  if (messages.length) {
    sections.push(`【大总结后的纯聊天】\n${formatCaptureChatMessages(messages)}`);
  }
  const material = sections.join('\n\n');
  return createSuccess('grand_plus_after', messages, material, { summary });
}

/**
 * 根据唯一来源模式构建剧情材料，并返回可供 UI 使用的结构化范围、计数与预检错误。
 */
export function buildCaptureSourceMaterial(source, options = {}) {
  const normalizedSource = isCaptureMaterialObject(source) ? source : {};
  const mode = normalizedSource.mode;
  if (!CAPTURE_SOURCE_MODES.includes(mode)) {
    return createFailure(
      mode || '',
      CAPTURE_MATERIAL_ERROR_CODES.INVALID_SOURCE_MODE,
      '设定采集的主要剧情来源无效。',
      { mode: mode ?? null },
    );
  }

  const rawMessages = Array.isArray(options.messages)
    ? options.messages
    : getChatMessagesSafe(undefined, { hide_state: 'all' });
  const pureMessages = collectPureChatMessages({
    messages: rawMessages,
    summarySettings: options.summarySettings,
    names: options.names,
  });
  const context = {
    rawMessages,
    pureMessages,
    rawFloorBounds: getRawFloorBounds(rawMessages),
    chatState: isCaptureMaterialObject(options.chatState) ? options.chatState : getChatState(),
  };

  if (mode === 'recent_chat') return resolveRecentChat(normalizedSource, context);
  if (mode === 'floor_range') return resolveFloorRange(normalizedSource, context);
  return resolveGrandPlusAfter(context);
}

function hasActiveCharacterContext(context, characterMaterial) {
  if (!characterMaterial) return false;
  const rawId = context?.characterId ?? context?.this_chid ?? context?.chid;
  const hasId = rawId !== null && rawId !== undefined && String(rawId).trim() !== '' && Number(rawId) !== -1;
  return hasId || Boolean(context?.character) || Boolean(context?.name2);
}

/** 返回角色卡与 Persona 的当前可用状态和已经格式化的材料。 */
export function inspectCaptureOptionalSources(options = {}) {
  const context = getContextSafe();
  const hasInjectedCharacter = Object.hasOwn(options, 'characterCard');
  const hasInjectedPersona = Object.hasOwn(options, 'persona');
  const characterCard = hasInjectedCharacter ? options.characterCard : getResolvedCharacterCard();
  const persona = hasInjectedPersona ? options.persona : getUserPersona();
  const characterMaterial = formatCharacterCardForPrompt(characterCard);
  const personaMaterial = formatUserPersonaForPrompt(persona);
  const characterAvailable = Object.hasOwn(options, 'characterAvailable')
    ? options.characterAvailable === true
    : (hasInjectedCharacter ? Boolean(characterMaterial) : hasActiveCharacterContext(context, characterMaterial));

  return {
    characterCard: {
      available: characterAvailable && Boolean(characterMaterial),
      reason: characterAvailable && characterMaterial ? '' : '当前没有可读取的角色卡。',
      name: String(characterCard?.name || '').trim(),
      material: characterMaterial,
      data: characterCard || null,
    },
    persona: {
      available: Boolean(personaMaterial),
      reason: personaMaterial ? '' : '当前 Persona 没有可读取的描述。',
      material: personaMaterial,
    },
  };
}

function normalizeWorldbookKeyword(value) {
  if (value instanceof RegExp) return value.toString();
  return String(value ?? '').trim();
}

function normalizeWorldbookKeywords(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeWorldbookKeyword).filter(Boolean);
}

function normalizeWorldbookEntryForCapture(worldbookName, entry) {
  const uid = Number(entry?.uid);
  if (!Number.isInteger(uid) || uid < 0) return null;
  const content = String(entry?.content ?? '');
  const name = String(entry?.name ?? '').trim() || `未命名条目 #${uid}`;
  return {
    worldbookName,
    uid,
    name,
    enabled: entry?.enabled !== false,
    strategyType: ['constant', 'selective', 'vectorized'].includes(entry?.strategy?.type)
      ? entry.strategy.type
      : 'selective',
    mainKeywords: normalizeWorldbookKeywords(entry?.strategy?.keys),
    filterKeywords: normalizeWorldbookKeywords(entry?.strategy?.keys_secondary?.keys),
    content,
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 80),
    position: String(entry?.position?.type || ''),
    order: Number.isFinite(Number(entry?.position?.order)) ? Number(entry.position.order) : null,
  };
}

export function createCaptureWorldbookRef(worldbookName, entry) {
  const name = String(worldbookName || '').trim();
  const uid = Number(entry?.uid);
  if (!name || !Number.isInteger(uid) || uid < 0) return null;
  return {
    worldbookName: name,
    uid,
    entryNameSnapshot: String(entry?.name ?? entry?.entryNameSnapshot ?? '').trim(),
  };
}

function getCaptureWorldbookRefKey(ref) {
  return `${String(ref?.worldbookName || '').trim()}\u0000${Number(ref?.uid)}`;
}

export function toggleCaptureWorldbookRef(refs, ref, selected) {
  const normalizedRef = createCaptureWorldbookRef(ref?.worldbookName, ref);
  const current = Array.isArray(refs) ? refs.map(item => createCaptureWorldbookRef(item?.worldbookName, item)).filter(Boolean) : [];
  if (!normalizedRef) return current;
  const key = getCaptureWorldbookRefKey(normalizedRef);
  const exists = current.some(item => getCaptureWorldbookRefKey(item) === key);
  const shouldSelect = selected === undefined ? !exists : selected === true;
  if (shouldSelect && !exists) return [...current, normalizedRef];
  if (!shouldSelect && exists) return current.filter(item => getCaptureWorldbookRefKey(item) !== key);
  return current;
}

export function setCaptureWorldbookRefsForBook(refs, worldbookName, entries, selected) {
  const name = String(worldbookName || '').trim();
  let next = (Array.isArray(refs) ? refs : [])
    .map(item => createCaptureWorldbookRef(item?.worldbookName, item))
    .filter(Boolean);
  if (!selected) return next.filter(ref => ref.worldbookName !== name);
  (Array.isArray(entries) ? entries : []).forEach(entry => {
    const ref = createCaptureWorldbookRef(name, entry);
    if (ref) next = toggleCaptureWorldbookRef(next, ref, true);
  });
  return next;
}

/**
 * 只返回当前角色卡绑定的世界书（primary + additional），不拉取全部世界书。
 * 设定采集只在角色卡绑定的世界书内选择条目。
 */
export async function listCaptureWorldbooks({ api } = {}) {
  try {
    const readApi = api || getWorldbookReadApi();
    if (typeof readApi.getCharWorldbookNames !== 'function') {
      throw new Error('当前环境缺少 getCharWorldbookNames，无法读取角色卡绑定的世界书。');
    }
    const bound = await Promise.resolve(readApi.getCharWorldbookNames('current'));
    const primary = String(bound?.primary || '').trim();
    const additional = Array.isArray(bound?.additional) ? bound.additional : [];
    // primary 排在最前，additional 去重跟随；空名剔除。
    const names = [...new Set([primary, ...additional]
      .map(name => String(name || '').trim())
      .filter(Boolean))];
    return { ok: true, names, primary: primary || null, error: null };
  } catch (error) {
    return {
      ok: false,
      names: [],
      primary: null,
      error: {
        code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_LIST_FAILED,
        message: `读取角色卡绑定的世界书失败：${error.message || String(error)}`,
      },
    };
  }
}

/** 按需加载单本世界书全部条目，保留关闭状态和激活类型供选择器展示。 */
export async function loadCaptureWorldbookEntries(worldbookName, { api } = {}) {
  const name = String(worldbookName || '').trim();
  try {
    const readApi = api || getWorldbookReadApi();
    const rawEntries = await readApi.getWorldbook(name);
    if (!Array.isArray(rawEntries)) throw new Error('返回结果不是条目数组。');
    const entries = rawEntries
      .map(entry => normalizeWorldbookEntryForCapture(name, entry))
      .filter(Boolean);
    return { ok: true, worldbookName: name, entries, error: null };
  } catch (error) {
    return {
      ok: false,
      worldbookName: name,
      entries: [],
      error: {
        code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_LOAD_FAILED,
        message: `读取世界书「${name || '未命名'}」失败：${error.message || String(error)}`,
        worldbookName: name,
      },
    };
  }
}

export function filterCaptureWorldbookEntries(entries, query) {
  const keyword = String(query || '').trim().toLocaleLowerCase();
  if (!keyword) return Array.isArray(entries) ? entries : [];
  return (Array.isArray(entries) ? entries : []).filter(entry => [
    entry?.name,
    ...(Array.isArray(entry?.mainKeywords) ? entry.mainKeywords : []),
    ...(Array.isArray(entry?.filterKeywords) ? entry.filterKeywords : []),
  ].some(value => String(value || '').toLocaleLowerCase().includes(keyword)));
}

function formatSelectedWorldbookEntry(entry) {
  return [
    `【世界书参考｜${entry.worldbookName}｜${entry.name}｜UID ${entry.uid}】`,
    entry.content,
  ].join('\n');
}

/**
 * 正式生成前使用：重新读取所有明确勾选的 worldbookName + uid，并构建最终附加材料。
 * 关闭、常驻、未触发、位置和递归状态均不参与筛选；缺失引用会明确报错。
 */
export async function buildCaptureOptionalContextMaterial(optionalContext, options = {}) {
  const selection = isCaptureMaterialObject(optionalContext) ? optionalContext : {};
  const sources = inspectCaptureOptionalSources(options);
  const errors = [];
  const sections = [];
  if (selection.includeCharacterCard) {
    if (sources.characterCard.available) sections.push(`【当前角色卡】\n${sources.characterCard.material}`);
    else errors.push({
      code: CAPTURE_OPTIONAL_ERROR_CODES.CHARACTER_CARD_UNAVAILABLE,
      message: sources.characterCard.reason,
    });
  }
  if (selection.includePersona) {
    if (sources.persona.available) sections.push(`【当前 Persona】\n${sources.persona.material}`);
    else errors.push({
      code: CAPTURE_OPTIONAL_ERROR_CODES.PERSONA_UNAVAILABLE,
      message: sources.persona.reason,
    });
  }

  const refs = (Array.isArray(selection.worldbookRefs) ? selection.worldbookRefs : [])
    .map(ref => createCaptureWorldbookRef(ref?.worldbookName, ref))
    .filter(Boolean);
  const uniqueRefs = [...new Map(refs.map(ref => [getCaptureWorldbookRefKey(ref), ref])).values()];
  const refsByBook = new Map();
  uniqueRefs.forEach(ref => {
    if (!refsByBook.has(ref.worldbookName)) refsByBook.set(ref.worldbookName, []);
    refsByBook.get(ref.worldbookName).push(ref);
  });

  const resolvedEntries = [];
  const missingRefs = [];
  for (const [worldbookName, bookRefs] of refsByBook.entries()) {
    const loaded = await loadCaptureWorldbookEntries(worldbookName, { api: options.api });
    if (!loaded.ok) {
      errors.push(loaded.error);
      bookRefs.forEach(ref => missingRefs.push(ref));
      continue;
    }
    const byUid = new Map(loaded.entries.map(entry => [entry.uid, entry]));
    bookRefs.forEach(ref => {
      const entry = byUid.get(ref.uid);
      if (!entry) {
        missingRefs.push(ref);
        errors.push({
          code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_REF_MISSING,
          message: `世界书「${ref.worldbookName}」中找不到 UID ${ref.uid}（选择时标题：${ref.entryNameSnapshot || '未记录'}）。`,
          ref,
        });
        return;
      }
      resolvedEntries.push(entry);
      sections.push(formatSelectedWorldbookEntry(entry));
    });
  }

  const material = sections.join('\n\n');
  return {
    ok: errors.length === 0,
    material,
    characterCount: material.length,
    sources,
    selectedRefCount: uniqueRefs.length,
    resolvedEntries,
    missingRefs,
    errors,
  };
}

// ── 设定采集生成、严格解析与草稿追加 ──────────────────────────────

// 设定采集生成流程：材料预检、独立请求、严格 JSON 解析与草稿追加。


const CAPTURE_GENERATION_TIMEOUT_MS = 180000;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
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

async function requestCaptureGeneration(messages, apiMode) {
  return apiMode === 'main_api'
    ? generateWithMainApi({
      messages,
      timeoutMs: CAPTURE_GENERATION_TIMEOUT_MS,
      timeoutMessage: '设定采集生成超时，请稍后重试。',
    })
    : generateWithSecondaryApi({
      profile: getWorkflowOption('getActiveApiProfile')?.(getGlobalSettings()),
      messages,
      timeoutMs: CAPTURE_GENERATION_TIMEOUT_MS,
      timeoutMessage: '设定采集生成超时，请稍后重试。',
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

  try {
    prepared = await prepareCaptureGeneration({ captureState, materialOptions, macroOverrides });
    if (!prepared.ok) {
      const summary = prepared.errors.map(error => error.message || error.code).filter(Boolean).join('；');
      throw createWorkflowError('CapturePreflightError', summary || '设定采集材料预检未通过。', {
        preflightErrors: prepared.errors,
      });
    }
    apiResult = await requestCaptureGeneration(prepared.messages, resolvedApiMode);
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
      errorCode,
      errorStage,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

// ── 阶段 G：设定草稿正式写入与 captureId 独立读回 ─────────────────

const CAPTURE_ENTRY_TYPE_LABELS = Object.freeze({
  npc: 'NPC',
  item: 'Item',
  location: 'Location',
  other: 'Other',
});

function buildCaptureEntryPayload(draft) {
  const typeLabel = CAPTURE_ENTRY_TYPE_LABELS[draft.type] || 'Other';
  return {
    name: `SLX-Capture-${typeLabel}-${draft.title}`,
    enabled: true,
    strategy: {
      type: 'selective',
      keys: draft.mainKeywords.length ? draft.mainKeywords : [draft.title],
      keys_secondary: { logic: 'and_any', keys: draft.filterKeywords },
      scan_depth: 'same_as_global',
    },
    position: {
      type: draft.position,
      role: 'system',
      depth: 0,
      order: draft.order,
    },
    content: draft.content,
    probability: 100,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    extra: {
      captureId: draft.captureId,
      captureType: draft.type,
    },
  };
}

/**
 * 将用户明确选择的设定草稿写入当前回忆录世界书。
 * 无论更新调用是否报错，均以独立 getWorldbook() 读回的 captureId 为最终事实：
 * 已读回草稿从本地移除，缺失或无效草稿保留并返回逐条错误，重试复用原 captureId。
 */
export async function commitCaptureDrafts(
  selectedDrafts,
  {
    confirmUseCurrent,
    api: providedApi = null,
    worldbookName: providedWorldbookName = '',
    persist = true,
  } = {},
) {
  const uniqueDrafts = [...new Map(
    (Array.isArray(selectedDrafts) ? selectedDrafts : [])
      .map(normalizeCaptureDraft)
      .map(draft => [draft.captureId, draft]),
  ).values()];
  if (!uniqueDrafts.length) throw new Error('没有已选择的设定草稿。');

  const invalidFailures = [];
  const validDrafts = uniqueDrafts.filter(draft => {
    const reasons = [];
    if (!draft.title.trim()) reasons.push('标题为空');
    if (!draft.content.trim()) reasons.push('正文为空');
    if (!draft.mainKeywords.length && !draft.title.trim()) reasons.push('缺少可用关键词');
    if (!reasons.length) return true;
    invalidFailures.push({ captureId: draft.captureId, message: reasons.join('；') });
    return false;
  });

  if (!validDrafts.length) {
    return {
      ok: false,
      worldbookName: providedWorldbookName,
      requestedCount: uniqueDrafts.length,
      verifiedCount: 0,
      addedCount: 0,
      verifiedIds: [],
      failures: invalidFailures,
      updateError: '',
    };
  }

  const api = providedApi || getWorldbookApi();
  const worldbookName = providedWorldbookName || (
    await ensureMemoirWorldbook({ confirmUseCurrent })
  ).worldbookName;
  const expectedIds = validDrafts.map(draft => draft.captureId);
  const addedIds = new Set();
  let updateError = null;
  let verification = null;

  try {
    verification = await updateWorldbookWithVerification(worldbookName, (book) => {
      const list = Array.isArray(book) ? book : [];
      const existingIds = new Set(
        list.map(entry => String(entry?.extra?.captureId || '')).filter(Boolean),
      );
      validDrafts.forEach(draft => {
        if (existingIds.has(draft.captureId)) return;
        list.push(buildCaptureEntryPayload(draft));
        existingIds.add(draft.captureId);
        addedIds.add(draft.captureId);
      });
      return list;
    }, {
      api,
      idField: 'captureId',
      expectedIds,
      typeField: 'captureType',
    });
  } catch (error) {
    updateError = error;
    // updateWorldbookWith 可能在部分持久化后才抛错；必须再读一次，不能凭异常判整批失败。
    verification = await verifyWorldbookEntries(worldbookName, {
      api,
      idField: 'captureId',
      expectedIds,
      typeField: 'captureType',
    });
  }

  const verifiedIds = verification.verifiedEntries
    .map(entry => String(entry?.extra?.captureId || ''))
    .filter(Boolean);
  const missingFailures = verification.missingIds.map(captureId => ({
    captureId,
    message: updateError
      ? `写入调用异常且读回未找到：${updateError.message || String(updateError)}`
      : '写入后独立读回未找到该 captureId，可安全重试。',
  }));
  const failures = [...invalidFailures, ...missingFailures];

  if (persist && verifiedIds.length) {
    const capture = getMemoirState().capture;
    const verifiedSet = new Set(verifiedIds);
    capture.drafts = capture.drafts.filter(draft => !verifiedSet.has(draft.captureId));
    saveChatState();
  }

  return {
    ok: failures.length === 0,
    worldbookName,
    requestedCount: uniqueDrafts.length,
    verifiedCount: verifiedIds.length,
    addedCount: [...addedIds].filter(id => verifiedIds.includes(id)).length,
    verifiedIds,
    verifiedEntries: verification.verifiedEntries,
    failures,
    updateError: updateError?.message || '',
  };
}
