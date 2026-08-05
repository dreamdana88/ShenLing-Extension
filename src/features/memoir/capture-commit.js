import {
  getMemoirState,
  normalizeCaptureDraft,
  saveChatState,
} from '../../core/settings.js';
import { getWorldbookApi } from '../../core/worldbook.js';
import {
  ensureMemoirWorldbook,
  updateWorldbookWithVerification,
  verifyWorldbookEntries,
} from './worldbook-manager.js';

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
