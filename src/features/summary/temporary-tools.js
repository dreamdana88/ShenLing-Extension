// TEMPORARY TOOL
// 仅用于 0.17.4 紧急实机验证与单一历史聊天修复。
// 验证完成后必须删除。

import { GRAND_MEMORY_BLOCK_RE } from '../../constants.js';
import { escapeHtml } from '../../utils/text.js';
import {
  createAssistantChatMessage,
  getChatMessageById,
  getChatMessagesSafe,
} from '../../core/chat.js';
import {
  getChatState,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  createTotalGrandMemoryPlan,
  scanExistingSummaryState,
} from './workflow.js';

export const TEMP_SUMMARY_TOOLS_KEY = 'shenling_temp_summary_tools_v1';
let temporaryToolNotice = '';

export function isTemporarySummaryToolsEnabled() {
  try {
    return globalThis.localStorage?.getItem(TEMP_SUMMARY_TOOLS_KEY) === 'enabled';
  } catch {
    return false;
  }
}

function getChatSignature(chatState = getChatState()) {
  const identity = chatState.identity || {};
  return `${identity.characterId || ''}::${identity.chatId || ''}`;
}

function requireEnabled() {
  if (!isTemporarySummaryToolsEnabled()) throw new Error('临时工具未启用。');
}

function requireSameChat(expectedSignature) {
  const current = getChatState();
  if (!current.identity?.chatId) throw new Error('当前没有可保存的聊天。');
  if (expectedSignature && getChatSignature(current) !== expectedSignature) throw new Error('操作期间已切换聊天，已拒绝写入。');
  return current;
}

function messagePreview(message) {
  return String(message?.message || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '无正文';
}

export function getTemporaryRepairRecords(chatState = getChatState()) {
  const records = Array.isArray(chatState.summary?.archiveRecords) ? chatState.summary.archiveRecords : [];
  return records.map(record => {
    const message = getChatMessageById(Number(record.summaryMessageId));
    return {
      record,
      exists: Boolean(message),
      hidden: Boolean(message?.is_hidden),
      preview: messagePreview(message),
    };
  });
}

function fixtureMessage(label, from, to) {
  return `<grand_memory>\n[volume:${from}-${to}]\n[蜃灵临时测试数据]\n临时大总结 ${label}，仅用于验证总档案合并状态持久化。\n</grand_memory>`;
}

function fixtureSource(label) {
  return `[蜃灵临时测试数据] 临时来源楼 ${label}，用于让生产扫描器建立合法大总结区间。`;
}

export async function createTemporaryGrandFixtures({ confirmed = false } = {}) {
  requireEnabled();
  if (!confirmed) throw new Error('请先确认这是可删除的隔离测试聊天。');
  const initialState = requireSameChat();
  const initialSignature = getChatSignature(initialState);
  const summary = getSummarySettings(getGlobalSettings());
  if (initialState.summary.runningTask !== 'none') throw new Error('当前 Summary 任务未结束。');
  if (summary.autoTotalGrandMemoryEnabled) throw new Error('请先关闭自动大总结合并。');
  if ((initialState.summary.archiveRecords || []).length > 0 || getChatMessagesSafe(undefined, { hide_state: 'all' }).some(message => GRAND_MEMORY_BLOCK_RE.test(message.message))) {
    throw new Error('当前聊天已有大总结或归档记录，拒绝追加临时测试数据。');
  }

  const createdGrandIds = [];
  try {
    for (const [index, [label, from, to]] of [['A', 1, 10], ['B', 11, 20], ['C', 21, 30]].entries()) {
      requireSameChat(initialSignature);
      await createAssistantChatMessage(fixtureSource(label));
      requireSameChat(initialSignature);
      const messageId = await createAssistantChatMessage(fixtureMessage(label, from, to));
      const message = getChatMessageById(Number(messageId));
      if (!message || !GRAND_MEMORY_BLOCK_RE.test(message.message)) throw new Error(`测试大总结 ${label} 创建后未找到。`);
      createdGrandIds.push(Number(messageId));
      if (index === 2) requireSameChat(initialSignature);
    }

    scanExistingSummaryState();
    const currentState = requireSameChat(initialSignature);
    const records = getTemporaryRepairRecords(currentState)
      .filter(item => createdGrandIds.includes(Number(item.record.summaryMessageId)));
    const plan = createTotalGrandMemoryPlan(currentState);
    const valid = records.length === 3
      && records.every(item => item.exists && !item.record.compressedBy && item.record.rangeType !== 'total_grand')
      && plan.freshCount === 3
      && plan.count === 3;
    if (!valid) throw new Error('扫描结果未达到 3 条普通大总结；请删除整个隔离测试聊天，不要继续合并。');
    temporaryToolNotice = '已创建测试大总结：3 条｜扫描识别：3 条｜freshCount：3｜plan.count：3';
    return { createdGrandIds, freshCount: plan.freshCount, count: plan.count };
  } catch (error) {
    temporaryToolNotice = `测试夹具失败：${error.message || String(error)}${createdGrandIds.length ? '。已创建部分数据，请直接删除该隔离测试聊天。' : ''}`;
    throw error;
  }
}

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite))];
}

export function repairTemporaryGrandRelationship({ chatSignature, targetId, sourceIds, confirmation }) {
  requireEnabled();
  const state = requireSameChat(chatSignature);
  if (state.summary.runningTask !== 'none') throw new Error('当前 Summary 任务未结束。');
  const target = Number(targetId);
  const sources = normalizeIds(sourceIds);
  const expectedConfirmation = `修复第${target}楼`;
  if (confirmation !== expectedConfirmation) throw new Error(`确认文本必须完全等于“${expectedConfirmation}”。`);
  if (!Number.isFinite(target) || sources.length < 2 || sources.includes(target)) throw new Error('目标或来源记录选择无效。');

  const records = Array.isArray(state.summary.archiveRecords) ? state.summary.archiveRecords : [];
  const byId = new Map(records.map(record => [Number(record.summaryMessageId), record]));
  const targetRecord = byId.get(target);
  const sourceRecords = sources.map(id => byId.get(id));
  if (!targetRecord || sourceRecords.some(record => !record)) throw new Error('所选记录已不存在于当前聊天。');
  if (!getChatMessageById(target) || sourceRecords.some(record => !getChatMessageById(Number(record.summaryMessageId)))) throw new Error('所选消息楼层已不存在于当前聊天。');
  if (sourceRecords.some(record => Number(record.summaryMessageId) >= target)) throw new Error('目标总档案必须晚于所有来源记录。');

  const existingIds = Array.isArray(targetRecord.compressedRecordIds) ? normalizeIds(targetRecord.compressedRecordIds) : [];
  const relationMatches = targetRecord.rangeType === 'total_grand'
    && existingIds.length === sources.length
    && existingIds.every(id => sources.includes(id))
    && sourceRecords.every(record => Number(record.compressedBy) === target);
  if (relationMatches) {
    temporaryToolNotice = '该合并关系已正确存在，无需重复修复。';
    return { changed: false, reason: 'already-fixed' };
  }
  if (sourceRecords.some(record => record.compressedBy)) throw new Error('来源记录已被其他总档案消费，拒绝覆盖。');
  if (existingIds.length > 0 || (targetRecord.rangeType && targetRecord.rangeType !== 'memory')) throw new Error('目标记录已有冲突的合并关系字段。');

  const snapshot = structuredClone(records);
  try {
    const current = requireSameChat(chatSignature);
    current.summary.archiveRecords = current.summary.archiveRecords.map(record => {
      const messageId = Number(record.summaryMessageId);
      if (sources.includes(messageId)) return { ...record, compressedBy: target };
      if (messageId === target) return { ...record, rangeType: 'total_grand', compressedRecordIds: [...sources] };
      return record;
    });
    saveChatState();
    scanExistingSummaryState();
    const verified = requireSameChat(chatSignature);
    const verifiedById = new Map(verified.summary.archiveRecords.map(record => [Number(record.summaryMessageId), record]));
    const verifiedTarget = verifiedById.get(target);
    const valid = sourceRecords.every(record => verifiedById.get(Number(record.summaryMessageId))?.compressedBy === target)
      && verifiedTarget?.rangeType === 'total_grand'
      && normalizeIds(verifiedTarget.compressedRecordIds).length === sources.length
      && createTotalGrandMemoryPlan(verified).freshRecords.every(item => !sources.includes(Number(item.record.summaryMessageId)));
    if (!valid) throw new Error('修复后验证失败。');
    temporaryToolNotice = `已修复第 ${target} 楼与 ${sources.length} 条来源记录的合并关系；未调用 AI，未修改消息正文。`;
    return { changed: true, targetId: target, sourceIds: sources };
  } catch (error) {
    const current = requireSameChat(chatSignature);
    current.summary.archiveRecords = snapshot;
    saveChatState();
    scanExistingSummaryState();
    temporaryToolNotice = `修复失败，已恢复本次操作前的归档记录：${error.message || String(error)}`;
    throw error;
  }
}

export function renderTemporarySummaryTools(chatState = getChatState()) {
  if (!isTemporarySummaryToolsEnabled()) return '';
  const signature = getChatSignature(chatState);
  const records = getTemporaryRepairRecords(chatState);
  const rows = records.map(item => {
    const record = item.record;
    return `<label class="slx-temp-summary-record"><input type="radio" name="slx-temp-target" value="${escapeHtml(record.summaryMessageId)}" data-slx-temp-target /> <input type="checkbox" value="${escapeHtml(record.summaryMessageId)}" data-slx-temp-source /> 第 ${escapeHtml(record.summaryMessageId)} 楼｜${escapeHtml(record.id || '无记录ID')}｜记忆 ${escapeHtml(record.memoryFrom ?? '?')}-${escapeHtml(record.memoryTo ?? '?')}｜${escapeHtml(record.rangeType || 'memory')}｜${item.hidden ? '隐藏' : '显示'}｜compressedBy ${escapeHtml(record.compressedBy ?? '无')}｜${escapeHtml(item.preview)}</label>`;
  }).join('');
  return `
    <div class="slx-detail-card slx-muted-card" data-slx-temp-summary-tools data-slx-temp-chat="${escapeHtml(signature)}">
      <div class="slx-detail-title">临时大总结诊断工具</div>
      <p>仅供测试与历史修复。操作前请复制或导出当前聊天；下列修复不会调用 AI。</p>
      <label class="slx-setting-toggle-row"><span><b>生成测试夹具</b><small>仅限可删除的隔离聊天；创建 3 条合法普通大总结，不调用 AI。</small></span><input type="checkbox" data-slx-temp-fixture-confirm /></label>
      <button class="slx-soft-btn" type="button" data-slx-temp-create-fixture>生成 3 条临时大总结测试数据</button>
      <hr />
      <div class="slx-detail-title">历史合并关系修复</div>
      <p>选择一个目标总档案和至少两条来源记录；不会修改消息正文、创建、删除或隐藏消息。</p>
      <div class="slx-temp-summary-records">${rows || '<p>暂无可修复归档记录。</p>'}</div>
      <p data-slx-temp-preview>请选择目标与来源记录。</p>
      <input type="text" data-slx-temp-confirmation placeholder="选择目标后输入确认文本" />
      <button class="slx-soft-btn" type="button" data-slx-temp-repair disabled>修复历史合并关系</button>
      <p class="slx-archive-detail" data-slx-temp-notice>${escapeHtml(temporaryToolNotice || '临时工具已启用。')}</p>
    </div>`;
}

export function bindTemporarySummaryTools(panelRoot, rerender) {
  if (!isTemporarySummaryToolsEnabled() || !panelRoot) return;
  const root = panelRoot.querySelector('[data-slx-temp-summary-tools]');
  if (!root) return;
  const updateRepairUi = () => {
    const target = root.querySelector('[data-slx-temp-target]:checked')?.value || '';
    const sources = [...root.querySelectorAll('[data-slx-temp-source]:checked')].map(input => input.value);
    const expected = target ? `修复第${target}楼` : '';
    const confirmation = root.querySelector('[data-slx-temp-confirmation]')?.value || '';
    root.querySelector('[data-slx-temp-preview]').textContent = target
      ? `目标总档案：第 ${target} 楼｜将标记为已合并：${sources.length} 条｜不会调用 AI、修改消息正文、删除或隐藏消息。`
      : '请选择目标与来源记录。';
    root.querySelector('[data-slx-temp-repair]').disabled = !(target && sources.length >= 2 && confirmation === expected);
  };
  root.querySelectorAll('[data-slx-temp-target], [data-slx-temp-source], [data-slx-temp-confirmation]').forEach(input => input.addEventListener('input', updateRepairUi));
  root.querySelector('[data-slx-temp-create-fixture]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await createTemporaryGrandFixtures({ confirmed: Boolean(root.querySelector('[data-slx-temp-fixture-confirm]')?.checked) }); } catch { /* notice is rendered after refresh */ }
    rerender();
  });
  root.querySelector('[data-slx-temp-repair]')?.addEventListener('click', () => {
    const target = root.querySelector('[data-slx-temp-target]:checked')?.value;
    const sources = [...root.querySelectorAll('[data-slx-temp-source]:checked')].map(input => input.value);
    const confirmation = root.querySelector('[data-slx-temp-confirmation]')?.value;
    try { repairTemporaryGrandRelationship({ chatSignature: root.dataset.slxTempChat, targetId: target, sourceIds: sources, confirmation }); } catch { /* notice is rendered after refresh */ }
    rerender();
  });
}
