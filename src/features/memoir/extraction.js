import {
  getGlobalSettings,
  getMemoirSettings,
  getMemoirState,
} from '../../core/settings.js';
import {
  collectEmotionProfiles,
} from '../../core/context-resolver.js';
import {
  buildMemoirExtractPrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import {
  reconcileMemoirWorldbookState,
} from './worldbook-manager.js';

/** 用大总结的 messageId + 区间作为幂等键，避免同一次归档重复提炼。 */
export function buildSourceKey(archiveRecord = {}) {
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
