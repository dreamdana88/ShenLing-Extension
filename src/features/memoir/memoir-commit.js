import { formatTimestamp } from '../../utils/text.js';
import {
  getMemoirState,
  saveChatState,
} from '../../core/settings.js';
import { getWorldbookApi } from '../../core/worldbook.js';
import {
  buildMemoirBlueContent,
  ensureMemoirWorldbook,
  updateWorldbookWithVerification,
} from './worldbook-manager.js';

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
