// 回忆录世界书业务流程。
// 阶段 3a：确保当前聊天有经过用户确认的可写入世界书。
//   - 当前聊天无绑定 -> 新建「蜃灵回忆录｜<聊天标识>」并绑定。
//   - 已绑定且本聊天确认过 -> 直接复用。
//   - 已绑定但未确认/绑定已变化 -> 由 UI 询问：复用当前书，或创建蜃灵专属书并切换绑定。

import { formatTimestamp } from '../../utils/text.js';
import { getMemoirState, getMemoirSettings, saveChatState } from '../../core/settings.js';
import { collectEmotionProfiles } from '../../core/context-resolver.js';
import { buildMemoirExtractPrompt } from '../../prompts.js';
import { getWorldbookApi } from './worldbook-api.js';
import {
  ensureMemoirWorldbook,
  isDedicatedMemoirBook,
  updateWorldbookWithVerification,
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

  const prompt = buildMemoirExtractPrompt({
    grandMemoryMaterial,
    emotionMaterial: buildEmotionMaterial(),
    recordedList: buildRecordedList(memoir),
  });

  const raw = await generate(prompt, { type: '回忆录提炼' });
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

/** 用全量 entries 重建蓝灯总览正文（覆盖但不丢旧目录）。 */
function buildBlueContent(entries) {
  const lines = ['【回忆录总览】', '以下是这段旅程中值得铭记的往事：', ''];
  entries.forEach(e => {
    const digest = e.digest || `${e.storyTime && e.storyTime !== '未明' ? e.storyTime + '，' : ''}${e.title}`;
    lines.push(`· ${e.title}：${digest}`);
    const anchors = Array.isArray(e.filterKeywords)
      ? [...new Set(e.filterKeywords.map(word => String(word || '').trim()).filter(Boolean))].slice(0, 4)
      : [];
    if (anchors.length) lines.push(`  唤起词：${anchors.join('、')}`);
  });
  return lines.join('\n');
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
  const blueContent = buildBlueContent(allEntries);
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
