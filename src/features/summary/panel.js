import {
  DEFAULT_SUMMARY_EXCLUDE_TAGS,
  DEFAULT_SUMMARY_INCLUDE_TAGS,
  GRAND_MEMORY_BLOCK_RE,
} from '../../constants.js';
import {
  escapeHtml,
  formatTagList,
  getSummarySourceTags,
  parseTagList,
} from '../../utils/text.js';
import {
  createMessageIdRange,
  formatMessageIdList,
  getChatMessageById,
  setChatMessageContent,
} from '../../core/chat.js';
import {
  extractMemoryBlocks,
  getLegacyArchiveBatchSize,
  normalizeGrandMemoryBlock,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import {
  getSummarySettings,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  clearStaleSummaryRunningTask,
  clearSummaryWriteIgnored,
  createTotalGrandMemoryPlan,
  createLegacyArchivePlan,
  getEditableSummaryMessage,
  markSummaryWriteIgnored,
  notifySummary,
  parseManualSummaryFloor,
  processLegacyGrandArchive,
  processTotalGrandMemory,
  regenerateLatestGrandMemory,
  regenerateMemoryForMessage,
  scanExistingSummaryState,
  summarizeOpeningMessage,
  updateLegacyArchiveStatus,
  writeManualMemoryToMessage,
} from './workflow.js';

let memoryEditorState = null;
let grandMemoryEditorState = null;
let summaryPanelOptions = {
  getActiveApiProfile: null,
  getApiSettings: null,
  getPanelRoot: null,
  refreshPanel: null,
  syncSettingsPanelState: null,
};

export function configureSummaryPanel(options = {}) {
  summaryPanelOptions = {
    ...summaryPanelOptions,
    ...options,
  };
}

function getPanelRoot() {
  return typeof summaryPanelOptions.getPanelRoot === 'function' ? summaryPanelOptions.getPanelRoot() : null;
}

function getActiveApiProfileForPanel(settings) {
  return typeof summaryPanelOptions.getActiveApiProfile === 'function'
    ? summaryPanelOptions.getActiveApiProfile(settings)
    : { model: '' };
}

function getApiSettingsForPanel(settings) {
  return typeof summaryPanelOptions.getApiSettings === 'function'
    ? summaryPanelOptions.getApiSettings(settings)
    : { mode: 'secondary_api' };
}

function rerenderSummaryPanelFromRoot(panelRoot = getPanelRoot()) {
  if (!panelRoot) return;
  if (typeof summaryPanelOptions.refreshPanel === 'function') {
    summaryPanelOptions.refreshPanel({
      moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0,
      detailScrollTop: panelRoot.querySelector('.slx-detail')?.scrollTop ?? 0,
    });
  }
  if (typeof summaryPanelOptions.syncSettingsPanelState === 'function') {
    summaryPanelOptions.syncSettingsPanelState();
  }
}

function renderDiagnosticLine(label, value) {
  return `<div class="slx-info-line"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function createArchiveRecordView(record) {
  const totalIds = createMessageIdRange(record.archiveFrom, record.archiveTo);
  const hiddenIds = [];
  const visibleIds = [];
  const missingIds = [];

  totalIds.forEach(messageId => {
    const message = getChatMessageById(messageId);
    if (!message) {
      missingIds.push(messageId);
    } else if (message.is_hidden) {
      hiddenIds.push(messageId);
    } else {
      visibleIds.push(messageId);
    }
  });

  const summaryMessage = getChatMessageById(record.summaryMessageId);
  const summaryMissing = !summaryMessage;
  const summaryHidden = Boolean(summaryMessage?.is_hidden);
  const summaryStatus = summaryMissing ? '大总结缺失' : summaryHidden ? '大总结被隐藏' : '大总结显示中';

  return {
    record,
    totalIds,
    hiddenIds,
    visibleIds,
    missingIds,
    summaryHidden,
    summaryMissing,
    summaryStatus,
  };
}

function renderArchiveRecordView(view) {
  const warnClass = view.summaryHidden || view.summaryMissing ? ' slx-archive-pill-warn' : '';
  const rangePrefix = view.record.rangeType === 'floor'
    ? '旧聊 ' + escapeHtml(view.record.archiveFrom) + '-' + escapeHtml(view.record.archiveTo) + '｜'
    : view.record.memoryFrom !== null && view.record.memoryFrom !== undefined
      ? '记忆 ' + escapeHtml(view.record.memoryFrom) + '-' + escapeHtml(view.record.memoryTo) + '｜'
      : '';
  return `
    <div class="slx-archive-item">
      <div class="slx-archive-top">
        <div class="slx-archive-title">
          第 ${escapeHtml(view.record.summaryMessageId)} 楼大总结
          <span>${rangePrefix}隐藏 ${escapeHtml(view.record.archiveFrom)}-${escapeHtml(view.record.archiveTo)}</span>
        </div>
        <button class="slx-mini-action-btn" type="button" data-slx-edit-grand-memory="${escapeHtml(view.record.summaryMessageId)}" title="编辑大总结正文" ${view.summaryMissing ? 'disabled' : ''}><i class="fa-solid fa-pen-to-square"></i></button>
      </div>
      <div class="slx-archive-statline">
        <span class="slx-archive-pill">隐藏 ${view.hiddenIds.length}/${view.totalIds.length}</span>
        <span class="slx-archive-pill">显示 ${view.visibleIds.length}</span>
        ${view.missingIds.length ? `<span class="slx-archive-pill slx-archive-pill-warn">缺失 ${view.missingIds.length}</span>` : ''}
        <span class="slx-archive-pill${warnClass}">${escapeHtml(view.summaryStatus)}</span>
      </div>
      ${view.visibleIds.length ? `<div class="slx-archive-detail">例外显示楼层：${escapeHtml(formatMessageIdList(view.visibleIds))}</div>` : ''}
      ${view.missingIds.length ? `<div class="slx-archive-detail slx-archive-warn">未找到楼层：${escapeHtml(formatMessageIdList(view.missingIds))}</div>` : ''}
    </div>
  `;
}

export function refreshSummaryPanelAfterAction() {
  const panelRoot = getPanelRoot();
  if (!panelRoot?.classList.contains('slx-panel-open')) return;
  rerenderSummaryPanelFromRoot(panelRoot);
}

function openMemoryEditorForMessage(messageId) {
  const chatMessage = getEditableSummaryMessage(messageId);
  const memories = extractMemoryBlocks(chatMessage.message);
  if (memories.length === 0) throw new Error(`第 ${Number(messageId)} 楼没有 <memory> 小总结。`);
  memoryEditorState = {
    messageId: Number(messageId),
    content: memories.at(-1) || '',
    saveLabel: '保存',
  };
  refreshSummaryPanelAfterAction();
}

function closeMemoryEditor() {
  memoryEditorState = null;
  refreshSummaryPanelAfterAction();
}

async function saveMemoryEditorContent() {
  if (!memoryEditorState) return;
  const messageId = memoryEditorState.messageId;
  const textarea = getPanelRoot()?.querySelector('[data-slx-memory-editor-content]');
  const rawContent = String(textarea?.value || '').trim();
  if (!rawContent) throw new Error('小总结内容不能为空。');

  memoryEditorState.saveLabel = '保存中...';
  refreshSummaryPanelAfterAction();
  try {
    await writeManualMemoryToMessage(messageId, rawContent);
    memoryEditorState = {
      messageId,
      content: normalizeMemoryBlock(rawContent),
      saveLabel: '已保存',
    };
    notifySummary('success', `已保存第 ${messageId} 楼小总结。`, '小总结管理');
    refreshSummaryPanelAfterAction();
    window.setTimeout(() => {
      if (memoryEditorState?.messageId === messageId) {
        memoryEditorState.saveLabel = '保存';
        refreshSummaryPanelAfterAction();
      }
    }, 1500);
  } catch (error) {
    memoryEditorState.saveLabel = '保存';
    notifySummary('error', error.message || String(error), '保存小总结失败');
    refreshSummaryPanelAfterAction();
  }
}

function openGrandMemoryEditor(summaryMessageId) {
  const messageId = Number(summaryMessageId);
  const chatMessage = getChatMessageById(messageId);
  if (!chatMessage) throw new Error(`未找到第 ${messageId} 楼大总结。`);
  if (!GRAND_MEMORY_BLOCK_RE.test(chatMessage.message)) throw new Error(`第 ${messageId} 楼没有 <grand_memory>。`);
  grandMemoryEditorState = {
    messageId,
    content: chatMessage.message.trim(),
    saveLabel: '保存',
  };
  refreshSummaryPanelAfterAction();
}

function closeGrandMemoryEditor() {
  grandMemoryEditorState = null;
  refreshSummaryPanelAfterAction();
}

async function saveGrandMemoryEditorContent() {
  if (!grandMemoryEditorState) return;
  const messageId = grandMemoryEditorState.messageId;
  const textarea = getPanelRoot()?.querySelector('[data-slx-grand-memory-editor-content]');
  const rawContent = String(textarea?.value || '').trim();
  if (!rawContent) throw new Error('大总结内容不能为空。');

  const grandMemory = normalizeGrandMemoryBlock(rawContent);
  grandMemoryEditorState.saveLabel = '保存中...';
  refreshSummaryPanelAfterAction();
  markSummaryWriteIgnored(messageId);
  try {
    await setChatMessageContent(messageId, grandMemory);
    grandMemoryEditorState = {
      messageId,
      content: grandMemory,
      saveLabel: '已保存',
    };
    scanExistingSummaryState();
    notifySummary('success', `已保存第 ${messageId} 楼大总结。`, '归档管理器');
    refreshSummaryPanelAfterAction();
    window.setTimeout(() => {
      if (grandMemoryEditorState?.messageId === messageId) {
        grandMemoryEditorState.saveLabel = '保存';
        refreshSummaryPanelAfterAction();
      }
    }, 1500);
  } catch (error) {
    clearSummaryWriteIgnored(messageId);
    grandMemoryEditorState.saveLabel = '保存';
    notifySummary('error', error.message || String(error), '保存大总结失败');
    refreshSummaryPanelAfterAction();
  }
}

export function renderSummarySettingsPanel(settings, chatState) {
  const summary = getSummarySettings(settings);
  const apiProfile = getActiveApiProfileForPanel(settings);
  const api = getApiSettingsForPanel(settings);
  const activeModel = api.mode === 'main_api' ? '酒馆主 API' : (apiProfile.model || '尚未选择模型');
  const grandInterval = Math.max(1, Number(summary.grandMemoryInterval) || 6);
  const memoryCount = Number(chatState.summary.memoryCountSinceArchive ?? chatState.summary.smallSummaryCount ?? 0);
  const archiveRecords = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords : [];
  const activeArchiveRecords = archiveRecords.filter(record => !record.compressedBy);
  const compressedArchiveCount = archiveRecords.length - activeArchiveRecords.length;
  const latestArchiveRecord = activeArchiveRecords.at(-1) || archiveRecords.at(-1) || null;
  const latestArchiveLabel = latestArchiveRecord
    ? `第 ${latestArchiveRecord.summaryMessageId ?? '?'} 楼 | 隐藏 ${latestArchiveRecord.archiveFrom ?? '?'}-${latestArchiveRecord.archiveTo ?? '?'}`
    : '无';
  const latestLog = settings.communicationLog?.entries?.[0];
  const latestLogLabel = latestLog ? `${latestLog.status === 'failure' ? '失败' : '成功'} · ${latestLog.startedAt}` : '无';
  const runningTaskLabels = {
    none: '空闲',
    opening_memory: '0楼总结中',
    memory: '小总结中',
    manual_memory: '手动小总结中',
    grand_memory: '大总结中',
    total_grand_memory: '总档案合并中',
    legacy_grand_memory: '旧聊天归档中',
  };
  const runningLabel = runningTaskLabels[chatState.summary.runningTask] || chatState.summary.runningTask || '空闲';
  const sourceTags = getSummarySourceTags(summary);
  const sourceRulesCollapsed = settings.ui?.sourceRulesCollapsed !== false;
  const archiveRecordViews = [...activeArchiveRecords].reverse().map(createArchiveRecordView);
  const totalGrandPlan = createTotalGrandMemoryPlan();
  const legacyBatchSize = summary.legacyArchiveBatchSize || '';
  const summarySourceModeLabel = summary.includeUserInput ? '续写模式：用户输入 + AI 正文' : '转述模式：仅 AI 正文';
  const legacyScopeLabel = summary.includeUserInput ? '用户楼 + AI 楼' : '仅 AI 楼';
  const legacyPlan = createLegacyArchivePlan(getLegacyArchiveBatchSize(summary));
  const legacyStatus = chatState.summary.legacyArchiveStatus || {};
  const legacyStatusLabel = legacyStatus.lastResult || (legacyPlan.totalMessages ? '待归档 ' + legacyPlan.totalMessages + ' 楼。' : '未扫描到可归档正文。');
  const memoryEditorHtml = memoryEditorState ? `
    <div class="slx-detail-card slx-memory-editor-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">第 ${escapeHtml(memoryEditorState.messageId)} 楼小总结</div>
          <p>保存后只替换该楼 &lt;memory&gt;，不会改动正文。</p>
        </div>
      </div>
      <label class="slx-field slx-field-wide">
        <span>memory 内容</span>
        <textarea class="slx-memory-editor-textarea" data-slx-memory-editor-content>${escapeHtml(memoryEditorState.content)}</textarea>
      </label>
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" data-slx-cancel-memory-edit>取消</button>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-memory-edit>${escapeHtml(memoryEditorState.saveLabel || '保存')}</button>
      </div>
    </div>
  ` : '';
  const grandMemoryEditorHtml = grandMemoryEditorState ? `
    <div class="slx-detail-card slx-memory-editor-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">第 ${escapeHtml(grandMemoryEditorState.messageId)} 楼大总结</div>
          <p>保存后只覆盖该楼 &lt;grand_memory&gt; 正文。</p>
        </div>
      </div>
      <label class="slx-field slx-field-wide">
        <span>grand_memory 内容</span>
        <textarea class="slx-memory-editor-textarea" data-slx-grand-memory-editor-content>${escapeHtml(grandMemoryEditorState.content)}</textarea>
      </label>
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" data-slx-cancel-grand-memory-edit>取消</button>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-grand-memory-edit>${escapeHtml(grandMemoryEditorState.saveLabel || '保存')}</button>
      </div>
    </div>
  ` : '';

  return `
    <div class="slx-detail-card slx-summary-settings-card">
      <label class="slx-setting-toggle-row" for="slx-summary-enabled">
        <span>
          <b>自动小总结</b>
          <small>AI 回复后自动写入 memory。</small>
        </span>
        <input id="slx-summary-enabled" type="checkbox" data-slx-summary-field="enabled" ${summary.enabled ? 'checked' : ''} />
      </label>
      <label class="slx-setting-toggle-row" for="slx-summary-include-user-input">
        <span>
          <b>纳入用户输入</b>
          <small>续写模式开启；转述模式关闭。</small>
        </span>
        <input id="slx-summary-include-user-input" type="checkbox" data-slx-summary-field="includeUserInput" ${summary.includeUserInput ? 'checked' : ''} />
      </label>
      <label class="slx-setting-toggle-row" for="slx-summary-grand-enabled">
        <span>
          <b>自动大总结</b>
          <small>达到间隔后生成大总结并隐藏归档区间。</small>
        </span>
        <input id="slx-summary-grand-enabled" type="checkbox" data-slx-summary-field="autoGrandMemoryEnabled" ${summary.autoGrandMemoryEnabled ? 'checked' : ''} />
      </label>
      <label class="slx-field slx-field-wide">
        <span>大总结间隔</span>
        <input type="number" min="1" step="1" data-slx-summary-field="grandMemoryInterval" value="${escapeHtml(grandInterval)}" />
        <small>每 N 次成功小总结后触发一次大总结。</small>
      </label>
    </div>

    <div class="slx-detail-card slx-source-rules-card${sourceRulesCollapsed ? ' slx-source-rules-card-collapsed' : ''}">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">正文读取规则</div>
          ${sourceRulesCollapsed ? '' : '<p>这里只处理正文里的杂讯标签。&lt;memory&gt; 与 &lt;grand_memory&gt; 会由小总结/大总结流程单独读取，不作为默认排除项。</p>'}
        </div>
        <div class="slx-card-actions">
          ${sourceRulesCollapsed ? '' : '<button class="slx-mini-action-btn" type="button" data-slx-reset-source-tags title="恢复蜃灵默认标签"><i class="fa-solid fa-rotate-left"></i></button>'}
          <button class="slx-mini-action-btn slx-collapse-toggle" type="button" data-slx-toggle-source-rules title="${sourceRulesCollapsed ? '展开正文读取规则' : '收起正文读取规则'}"><i class="fa-solid ${sourceRulesCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i></button>
        </div>
      </div>
      ${sourceRulesCollapsed ? '' : `
        <div class="slx-form-grid">
          <label class="slx-field slx-field-wide">
            <span>纳入正文标签</span>
            <input type="text" data-slx-summary-tag-field="includeTags" value="${escapeHtml(formatTagList(sourceTags.includeTags))}" placeholder="content" />
            <small>用逗号分隔，例如 content。留空时会使用排除后的全文。</small>
          </label>
          <label class="slx-field slx-field-wide">
            <span>排除正文杂讯标签</span>
            <input type="text" data-slx-summary-tag-field="excludeTags" value="${escapeHtml(formatTagList(sourceTags.excludeTags))}" placeholder="thinking, wave" />
            <small>用逗号分隔，例如 thinking, wave。不要默认排除 memory / grand_memory。</small>
          </label>
        </div>
        <div class="slx-tag-preview">
          <span>当前纳入：${escapeHtml(sourceTags.includeTags.join('、') || '无，使用全文')}</span>
          <span>当前排除：${escapeHtml(sourceTags.excludeTags.join('、') || '无')}</span>
        </div>
      `}
    </div>
    <div class="slx-detail-card slx-muted-card">
      <div class="slx-summary-card-head">
        <div class="slx-detail-title">运行状态</div>
        <b>${escapeHtml(runningLabel)}</b>
      </div>
      ${renderDiagnosticLine('小总结取材', summarySourceModeLabel)}
      ${renderDiagnosticLine('小总结累计', `${memoryCount} / ${grandInterval}`)}
      ${renderDiagnosticLine('当前启用模型', activeModel)}
      ${renderDiagnosticLine('上次归档', chatState.summary.lastArchivedMessageId ?? '无')}
      ${renderDiagnosticLine('上次小总结楼', chatState.summary.lastSummaryMessageId ?? '无')}
      ${renderDiagnosticLine('上次大总结楼', chatState.summary.lastGrandSummaryMessageId ?? '无')}
      ${renderDiagnosticLine('归档记录', compressedArchiveCount ? `${activeArchiveRecords.length} 条（已合并 ${compressedArchiveCount} 条）` : `${activeArchiveRecords.length} 条`)}
      ${renderDiagnosticLine('最新归档', latestArchiveLabel)}
      ${renderDiagnosticLine('最近通讯日志', latestLogLabel)}
      ${renderDiagnosticLine('上次错误', chatState.summary.lastError || '无')}
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" data-slx-generate-opening-memory ${chatState.summary.runningTask !== 'none' ? 'disabled' : ''}>
          <span>为0楼生成小总结</span>
        </button>
        <button class="slx-soft-btn" type="button" data-slx-regenerate-grand-memory ${archiveRecords.length && chatState.summary.runningTask === 'none' ? '' : 'disabled'}>
          <span>重新生成上次大总结</span>
        </button>
        <button class="slx-soft-btn" type="button" data-slx-compress-grand-memories ${totalGrandPlan.count >= 2 && chatState.summary.runningTask === 'none' ? '' : 'disabled'}>
          <span>合并大总结</span>
        </button>
      </div>
    </div>

    <div class="slx-detail-card slx-muted-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">归档管理器</div>
          <p>查看、编辑和刷新归档。</p>
        </div>
        <button class="slx-mini-action-btn" type="button" data-slx-refresh-archive-scan title="刷新归档状态"><i class="fa-solid fa-rotate-right"></i></button>
      </div>
      ${activeArchiveRecords.length ? `<div class="slx-archive-detail">可合并大总结：${escapeHtml(totalGrandPlan.count)} 条${compressedArchiveCount ? `｜已合并旧记录 ${escapeHtml(compressedArchiveCount)} 条` : ''}</div>` : ''}
      ${archiveRecordViews.length ? archiveRecordViews.map(renderArchiveRecordView).join('') : '<p>暂无归档记录。</p>'}
    </div>
    ${grandMemoryEditorHtml}

    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">旧聊天归档</div>
      <p>把旧聊天分批整理为大总结。当前范围：${escapeHtml(legacyScopeLabel)}。</p>
      <label class="slx-field slx-field-wide">
        <span>每批楼层数</span>
        <input type="number" min="1" step="1" data-slx-legacy-archive-batch-size value="${escapeHtml(legacyBatchSize)}" placeholder="留空默认 30" />
        <small>输入 4 就按每 4 楼一批；留空默认每 30 楼一批。</small>
      </label>
      <div class="slx-diagnostics">
        ${renderDiagnosticLine('归档取材', legacyScopeLabel)}
        ${renderDiagnosticLine('可归档楼层', legacyPlan.totalMessages + ' 楼')}
        ${renderDiagnosticLine('预计批次', legacyPlan.batchTotal ? legacyPlan.batchTotal + ' 批' : '无')}
        ${renderDiagnosticLine('批次进度', legacyStatus.batchTotal ? (legacyStatus.batchIndex || 0) + ' / ' + legacyStatus.batchTotal : '未开始')}
        ${renderDiagnosticLine('归档状态', legacyStatusLabel)}
      </div>
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" data-slx-scan-legacy-archive>扫描旧聊天</button>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-start-legacy-archive ${legacyPlan.totalMessages && chatState.summary.runningTask === 'none' ? '' : 'disabled'}>开始归档</button>
      </div>
    </div>
    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">小总结管理</div>
      <p>重写或编辑指定楼层 memory。</p>
      <label class="slx-field slx-field-wide">
        <span>重写指定楼层小总结</span>
        <div class="slx-model-row">
          <input type="number" min="0" data-slx-rewrite-memory-floor placeholder="留空默认最新AI楼层" />
          <button class="slx-mini-action-btn" type="button" data-slx-rewrite-memory title="重新生成并覆盖该楼 memory" ${chatState.summary.runningTask !== 'none' ? 'disabled' : ''}><i class="fa-solid fa-rotate-right"></i></button>
        </div>
        <small>适合大改楼层后刷新小总结，不会增加累计次数。</small>
      </label>
      <label class="slx-field slx-field-wide">
        <span>编辑指定楼层小总结</span>
        <div class="slx-model-row">
          <input type="number" min="0" data-slx-edit-memory-floor placeholder="输入楼层号" />
          <button class="slx-mini-action-btn" type="button" data-slx-edit-memory title="读取该楼 memory"><i class="fa-solid fa-pen-to-square"></i></button>
        </div>
        <small>适合只改几个字，保存后只覆盖该楼 memory。</small>
      </label>
    </div>

    ${memoryEditorHtml}
  `;
}

export function bindSummaryPanelEvents(panelRoot, settings) {
  if (!panelRoot) return;
  const syncSummaryFieldToSettings = input => {
    const summary = getSummarySettings(settings);
    const field = input.dataset.slxSummaryField;
    if (!field || !Object.hasOwn(summary, field)) return false;

    if (input.type === 'checkbox') {
      summary[field] = Boolean(input.checked);
    } else if (input.type === 'number') {
      const value = Number.parseInt(input.value, 10);
      summary[field] = Number.isFinite(value) ? Math.max(Number(input.min || 0), value) : summary[field];
      input.value = summary[field];
    } else {
      summary[field] = input.value;
    }

    saveGlobalSettings();
    return true;
  };

  const rerenderSummaryPanel = () => rerenderSummaryPanelFromRoot(panelRoot);

  const syncSummaryTagFieldToSettings = input => {
    const summary = getSummarySettings(settings);
    const tags = getSummarySourceTags(summary);
    const field = input.dataset.slxSummaryTagField;
    if (!['includeTags', 'excludeTags'].includes(field)) return false;

    tags[field] = parseTagList(input.value);
    input.value = formatTagList(tags[field]);
    saveGlobalSettings();
    return true;
  };

  panelRoot.querySelectorAll('[data-slx-summary-tag-field]').forEach(input => {
    input.addEventListener('change', () => {
      if (syncSummaryTagFieldToSettings(input)) {
        rerenderSummaryPanel();
      }
    });

    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (syncSummaryTagFieldToSettings(input)) {
        input.blur();
        rerenderSummaryPanel();
      }
    });
  });

  panelRoot.querySelector('[data-slx-reset-source-tags]')?.addEventListener('click', () => {
    const summary = getSummarySettings(settings);
    summary.sourceTags = {
      includeTags: [...DEFAULT_SUMMARY_INCLUDE_TAGS],
      excludeTags: [...DEFAULT_SUMMARY_EXCLUDE_TAGS],
    };
    saveGlobalSettings();
    rerenderSummaryPanel();
  });

  panelRoot.querySelector('[data-slx-toggle-source-rules]')?.addEventListener('click', () => {
    settings.ui.sourceRulesCollapsed = settings.ui?.sourceRulesCollapsed === false;
    saveGlobalSettings();
    rerenderSummaryPanel();
  });
  panelRoot.querySelector('[data-slx-refresh-archive-scan]')?.addEventListener('click', () => {
    const reset = clearStaleSummaryRunningTask('手动刷新归档状态');
    scanExistingSummaryState();
    if (reset) notifySummary('info', '已重置未完成的总结任务状态。', '归档管理器');
    rerenderSummaryPanel();
  });
  const syncLegacyArchiveBatchSize = () => {
    const input = panelRoot.querySelector('[data-slx-legacy-archive-batch-size]');
    const summary = getSummarySettings(settings);
    summary.legacyArchiveBatchSize = String(input?.value || '').trim();
    saveGlobalSettings();
    return getLegacyArchiveBatchSize(summary);
  };

  panelRoot.querySelector('[data-slx-legacy-archive-batch-size]')?.addEventListener('change', () => {
    syncLegacyArchiveBatchSize();
    rerenderSummaryPanel();
  });

  panelRoot.querySelector('[data-slx-legacy-archive-batch-size]')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    syncLegacyArchiveBatchSize();
    event.currentTarget.blur();
    rerenderSummaryPanel();
  });

  panelRoot.querySelector('[data-slx-scan-legacy-archive]')?.addEventListener('click', () => {
    const batchSize = syncLegacyArchiveBatchSize();
    const plan = createLegacyArchivePlan(batchSize);
    updateLegacyArchiveStatus({
      phase: 'scanned',
      totalMessages: plan.totalMessages,
      batchSize,
      batchTotal: plan.batchTotal,
      batchIndex: 0,
      lastResult: plan.totalMessages ? '已扫描 ' + plan.totalMessages + ' 楼，预计 ' + plan.batchTotal + ' 批。' : '没有读取到可归档正文。',
    });
    rerenderSummaryPanel();
  });

  panelRoot.querySelector('[data-slx-start-legacy-archive]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    syncLegacyArchiveBatchSize();
    button.disabled = true;
    void processLegacyGrandArchive().catch(error => {
      notifySummary('warning', error.message || String(error), '旧聊天归档失败');
    }).finally(() => {
      button.disabled = false;
    });
  });
  panelRoot.querySelector('[data-slx-regenerate-grand-memory]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    button.disabled = true;
    void regenerateLatestGrandMemory().catch(error => {
      notifySummary('warning', error.message || String(error), '重新生成大总结失败');
    }).finally(() => {
      button.disabled = false;
    });
  });
  panelRoot.querySelector('[data-slx-compress-grand-memories]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    button.disabled = true;
    void processTotalGrandMemory().catch(error => {
      notifySummary('warning', error.message || String(error), '总档案压缩失败');
    }).finally(() => {
      button.disabled = false;
    });
  });
  panelRoot.querySelector('[data-slx-generate-opening-memory]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    button.disabled = true;
    void summarizeOpeningMessage().catch(error => {
      notifySummary('warning', error.message || String(error), '0楼小总结失败');
    }).finally(() => {
      button.disabled = false;
    });
  });

  panelRoot.querySelector('[data-slx-rewrite-memory]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    const input = panelRoot.querySelector('[data-slx-rewrite-memory-floor]');
    const messageId = parseManualSummaryFloor(input?.value, { defaultToLatest: true });
    if (messageId === null) {
      notifySummary('warning', '请输入有效楼层号，或留空使用最新 AI 楼层。', '重写小总结');
      return;
    }
    button.disabled = true;
    void regenerateMemoryForMessage(messageId).catch(error => {
      notifySummary('warning', error.message || String(error), '重写小总结失败');
    }).finally(() => {
      button.disabled = false;
    });
  });

  panelRoot.querySelector('[data-slx-edit-memory]')?.addEventListener('click', () => {
    const input = panelRoot.querySelector('[data-slx-edit-memory-floor]');
    const messageId = parseManualSummaryFloor(input?.value);
    if (messageId === null) {
      notifySummary('warning', '请输入有效楼层号。', '小总结管理');
      return;
    }
    try {
      openMemoryEditorForMessage(messageId);
    } catch (error) {
      notifySummary('warning', error.message || String(error), '小总结管理');
    }
  });

  panelRoot.querySelector('[data-slx-save-memory-edit]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    button.disabled = true;
    void saveMemoryEditorContent().catch(error => {
      notifySummary('warning', error.message || String(error), '保存小总结失败');
    }).finally(() => {
      button.disabled = false;
    });
  });

  panelRoot.querySelector('[data-slx-cancel-memory-edit]')?.addEventListener('click', () => {
    closeMemoryEditor();
  });

  panelRoot.querySelectorAll('[data-slx-edit-grand-memory]').forEach(button => {
    button.addEventListener('click', () => {
      try {
        openGrandMemoryEditor(button.dataset.slxEditGrandMemory);
      } catch (error) {
        notifySummary('warning', error.message || String(error), '归档管理器');
      }
    });
  });

  panelRoot.querySelector('[data-slx-save-grand-memory-edit]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    button.disabled = true;
    void saveGrandMemoryEditorContent().catch(error => {
      notifySummary('warning', error.message || String(error), '保存大总结失败');
    }).finally(() => {
      button.disabled = false;
    });
  });

  panelRoot.querySelector('[data-slx-cancel-grand-memory-edit]')?.addEventListener('click', () => {
    closeGrandMemoryEditor();
  });

  panelRoot.querySelectorAll('[data-slx-summary-field]').forEach(input => {
    input.addEventListener('change', () => {
      if (syncSummaryFieldToSettings(input)) {
        rerenderSummaryPanel();
      }
    });

    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (syncSummaryFieldToSettings(input)) {
        input.blur();
        rerenderSummaryPanel();
      }
    });
  });
}
