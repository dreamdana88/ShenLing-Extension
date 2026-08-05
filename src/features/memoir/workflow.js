// 回忆录世界书业务流程。
// 阶段 3a：确保当前聊天有经过用户确认的可写入世界书。
// 本文件仅保留手动剧情回忆提炼的跨模块编排入口。
import { getMemoirState } from '../../core/settings.js';
import {
  buildSourceKey,
  tryExtractMemoirFromGrandSummary,
} from './extraction.js';
import { stageMemoirCandidates } from './pending.js';

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
