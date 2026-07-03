// 回忆录世界书业务流程。
// 阶段 3a：确保当前聊天有可写入的回忆录世界书（策略 A）。
//   - 当前聊天已绑定世界书 -> 直接复用那本（回忆条目以前缀 + extra.memoirId 隔离写入，不替换、不停用用户书）。
//   - 当前聊天无绑定 -> 新建「蜃灵回忆录｜<聊天标识>」并绑定。
// SillyTavern 聊天世界书绑定是 1:1，故不采用「新建独立书 + 替换绑定」以免停用用户自己的书。

import { formatTimestamp } from '../../utils/text.js';
import { getContextSafe } from '../../core/chat.js';
import { getContextInfo, getMemoirState, getMemoirSettings, saveChatState } from '../../core/settings.js';
import { collectEmotionProfiles } from '../../core/context-resolver.js';
import { buildMemoirExtractPrompt } from '../../prompts.js';
import { getWorldbookApi } from './worldbook-api.js';

const MEMOIR_BOOK_PREFIX = '蜃灵回忆录｜';

function resolveChatId() {
  const context = getContextSafe();
  try {
    if (typeof context?.getCurrentChatId === 'function') {
      const id = context.getCurrentChatId();
      if (id) return String(id);
    }
  } catch {}
  const info = getContextInfo();
  return info.chatId ? String(info.chatId) : '';
}

function buildMemoirBookName(chatId) {
  return `${MEMOIR_BOOK_PREFIX}${chatId}`;
}

/** 该书名是否为蜃灵自建的专属回忆录书（用于区分「专属书」与「共享用户书」）。 */
export function isDedicatedMemoirBook(bookName) {
  return typeof bookName === 'string' && bookName.startsWith(MEMOIR_BOOK_PREFIX);
}

/**
 * 确保当前聊天存在可写入的回忆录世界书，并把绑定信息写回 chatState.memoir。
 * 幂等：已建立则直接复用；不会重复创建或改变已有绑定。
 *
 * @returns {Promise<{ worldbookName: string, mode: 'existing'|'new', dedicated: boolean }>}
 */
export async function ensureMemoirWorldbook() {
  const api = getWorldbookApi();
  const chatId = resolveChatId();
  if (!chatId) {
    throw new Error('未读取到当前聊天标识，无法建立回忆录世界书。');
  }

  const memoir = getMemoirState();
  const currentBound = await api.getChatWorldbookName('current'); // string | null

  let worldbookName;
  let mode;

  if (currentBound) {
    // 策略 A：复用现有绑定书，回忆条目以前缀隔离写入
    worldbookName = currentBound;
    mode = 'existing';
    if (!memoir.prevBoundName) {
      memoir.prevBoundName = currentBound; // 记录首次接管前就存在的绑定，仅诊断
    }
  } else {
    // 无绑定：新建蜃灵专属书并绑定当前聊天
    const desiredName = buildMemoirBookName(chatId);
    worldbookName = await api.getOrCreateChatWorldbook('current', desiredName);
    mode = 'new';
    memoir.prevBoundName = '';
  }

  memoir.worldbookId = worldbookName;
  memoir.worldbookName = worldbookName;
  memoir.updatedAt = formatTimestamp();
  saveChatState();

  return { worldbookName, mode, dedicated: isDedicatedMemoirBook(worldbookName) };
}

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
  const greens = entries.filter(e => e && e.type === 'green');
  if (!greens.length) return '';
  return greens
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
  const overview = parsed?.overview && typeof parsed.overview === 'object' ? parsed.overview : null;
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
 * @returns {Promise<{ skipped?: string, sourceKey?: string, prompt?: string, raw?: string,
 *   overview: object|null, memories: any[] }>}
 */
export async function tryExtractMemoirFromGrandSummary(archiveRecord, { generate, grandMemoryText } = {}) {
  const memoirSettings = getMemoirSettings();
  if (!memoirSettings.enabled) {
    return { skipped: 'disabled', overview: null, memories: [] };
  }
  if (typeof generate !== 'function') {
    throw new Error('未提供生成函数，无法提炼回忆候选。');
  }

  const memoir = getMemoirState();
  const sourceKey = buildSourceKey(archiveRecord);
  if (memoir.sourceProcessed.includes(sourceKey)) {
    return { skipped: 'already_processed', sourceKey, overview: null, memories: [] };
  }

  const grandMemoryMaterial = String(grandMemoryText || '').trim();
  if (!grandMemoryMaterial) {
    return { skipped: 'no_material', sourceKey, overview: null, memories: [] };
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
