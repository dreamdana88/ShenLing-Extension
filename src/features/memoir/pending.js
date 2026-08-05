import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  getMemoirState,
  saveChatState,
} from '../../core/settings.js';

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
