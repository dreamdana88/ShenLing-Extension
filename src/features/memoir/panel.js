// 回忆录世界书面板：开关、pending 候选确认/编辑/删除、写入世界书、已记录条目、手动提炼。
import { escapeHtml, formatTimestamp } from '../../utils/text.js';
import {
  getChatState,
  getMemoirSettings,
  getMemoirState,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';
import { collectRecentGrandMemories } from '../../core/context-resolver.js';
import { generateSummaryMemory } from '../summary/workflow.js';
import {
  commitMemoirCandidates,
  discardMemoirPending,
  runManualMemoirExtraction,
} from './workflow.js';
import { getContextInfo } from '../../core/settings.js';
import {
  CAPTURE_POSITIONS,
  CAPTURE_SOURCE_MODES,
  CAPTURE_TYPES,
  buildCaptureSourceMaterial,
  clearCaptureDrafts,
  commitCaptureDrafts,
  filterCaptureWorldbookEntries,
  inspectCaptureOptionalSources,
  listCaptureWorldbooks,
  loadCaptureWorldbookEntries,
  removeCaptureDrafts,
  runCaptureGeneration,
  setCaptureWorldbookRefsForBook,
  toggleCaptureWorldbookRef,
} from './workflow.js';
import { reconcileMemoirWorldbookState } from './worldbook-manager.js';

let panelOptions = { refreshPanel: () => {} };

let panelState = {
  status: 'idle', // idle | extracting | committing
  message: '',
  error: '',
};

// Tab 运行态：默认「剧情回忆」。直接切换只改 hidden/active，不触发全局重绘。
let activeTab = 'memoir'; // memoir | capture

const IMPORTANCE_LABEL = { high: '高', medium: '中', low: '低' };

export function configureMemoirPanel(options = {}) {
  panelOptions = { ...panelOptions, ...options };
}

function refreshPanel() {
  panelOptions.refreshPanel();
}

function keywordsToInput(list) {
  return Array.isArray(list) ? list.join('、') : '';
}

function inputToKeywords(value) {
  return String(value || '')
    .split(/[、,，\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function renderPendingCard(cand) {
  return `
    <div class="slx-memoir-cand slx-memoir-editor" data-slx-memoir-cand="${escapeHtml(cand.candidateId)}">
      <div class="slx-memoir-cand-head">
        <div class="slx-memoir-editor-field slx-memoir-title-field">
          <input class="slx-memoir-field" data-field="title" value="${escapeHtml(cand.title)}" placeholder="回忆标题" aria-label="回忆标题" />
        </div>
        <select class="slx-memoir-field slx-memoir-importance" data-field="importance" aria-label="重要度">
          ${['high', 'medium', 'low'].map(v =>
            `<option value="${v}" ${cand.importance === v ? 'selected' : ''}>${IMPORTANCE_LABEL[v]}</option>`,
          ).join('')}
        </select>
        <button class="slx-soft-btn slx-danger-mini-btn" type="button" data-slx-memoir-cand-del="${escapeHtml(cand.candidateId)}">删除</button>
      </div>
      <label class="slx-memoir-editor-field">
        <span>剧情时间</span>
        <input class="slx-memoir-field" data-field="storyTime" value="${escapeHtml(cand.storyTime)}" placeholder="剧情内时间" />
      </label>
      <label class="slx-memoir-editor-field">
        <span>主要关键词（人，顿号分隔）</span>
        <input class="slx-memoir-field" data-field="mainKeywords" value="${escapeHtml(keywordsToInput(cand.mainKeywords))}" />
      </label>
      <label class="slx-memoir-editor-field">
        <span>过滤器关键词（事，顿号分隔）</span>
        <input class="slx-memoir-field" data-field="filterKeywords" value="${escapeHtml(keywordsToInput(cand.filterKeywords))}" />
      </label>
      <label class="slx-memoir-editor-field">
        <span>目录摘要（蓝灯 digest）</span>
        <input class="slx-memoir-field" data-field="digest" value="${escapeHtml(cand.digest || '')}" placeholder="一句话：时·地·人·事" />
      </label>
      <label class="slx-memoir-editor-field slx-memoir-content-field">
        <span>回忆正文（绿灯 content）</span>
        <textarea class="slx-memoir-field slx-memoir-textarea" data-field="content" rows="5">${escapeHtml(cand.content)}</textarea>
      </label>
    </div>
  `;
}

function renderPendingSection(memoir) {
  const pending = memoir.pending;
  if (!pending || !Array.isArray(pending.candidates) || !pending.candidates.length) return '';
  const batchCount = Array.isArray(pending.sourceKeys) && pending.sourceKeys.length
    ? pending.sourceKeys.length
    : 1;
  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">待确认回忆（${pending.candidates.length} 条 · ${batchCount} 批）</div>
      <p>确认前可编辑标题、关键词、正文，或删除不想写入的条目。</p>
      <div class="slx-memoir-cand-list">
        ${pending.candidates.map(renderPendingCard).join('')}
      </div>
      <div class="slx-action-row">
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-memoir-commit ${panelState.status === 'committing' ? 'disabled' : ''}>
          ${panelState.status === 'committing' ? '写入中…' : '确认写入世界书'}
        </button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-discard>全部忽略</button>
      </div>
    </div>
  `;
}

function renderEntriesSection(memoir) {
  const entries = Array.isArray(memoir.entries) ? memoir.entries : [];
  if (!entries.length) {
    return `
      <div class="slx-detail-card slx-muted-card">
        <div class="slx-detail-title">已记录回忆（0）</div>
        <p>暂无。大总结完成后会自动提炼候选，确认后写入。</p>
      </div>
    `;
  }
  const rows = entries.map(e => `
    <li>
      <b>${escapeHtml(e.title)}</b>
      <small>${escapeHtml(e.storyTime || '未明')} · 重要度 ${escapeHtml(IMPORTANCE_LABEL[e.importance] || e.importance || '中')}</small>
    </li>
  `).join('');
  return `
    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">已记录回忆（${entries.length}）</div>
      <ul class="slx-memoir-entry-list">${rows}</ul>
    </div>
  `;
}

function renderMemoirTabContent(settings, chatState) {
  const memoirSettings = getMemoirSettings();
  const memoir = getMemoirState(chatState);
  const statusText = panelState.error
    ? `⚠️ ${panelState.error}`
    : (panelState.message || (panelState.status === 'extracting' ? '提炼中…' : ''));

  return `
    <div class="slx-detail-card">
      <label class="slx-setting-toggle-row" for="slx-memoir-enabled">
        <span>
          <b>回忆录自动提炼</b>
          <small>大总结完成后自动提炼「已完成的关键回忆」，确认后写入当前聊天已绑定世界书。</small>
        </span>
        <input id="slx-memoir-enabled" type="checkbox" data-slx-memoir-enabled ${memoirSettings.enabled ? 'checked' : ''} />
      </label>
      <div class="slx-info-line"><span>绑定世界书</span><b>${escapeHtml(memoir.worldbookName || '（尚未创建）')}</b></div>
      <div class="slx-action-row">
        <button class="slx-soft-btn" type="button" data-slx-memoir-manual ${panelState.status !== 'idle' ? 'disabled' : ''}>
          ${panelState.status === 'extracting' ? '提炼中…' : '从最新大总结提炼'}
        </button>
      </div>
      ${statusText ? `<p class="slx-muted">${escapeHtml(statusText)}</p>` : ''}
    </div>
    ${renderPendingSection(memoir)}
    ${renderEntriesSection(memoir)}
  `;
}

function renderMemoirTabBar() {
  const tabs = [
    { id: 'memoir', label: '剧情回忆' },
    { id: 'capture', label: '设定采集 ✦' },
  ];
  return `
    <div class="slx-memoir-tab-bar" role="tablist" aria-label="回忆录与设定采集">
      ${tabs.map(tab => `
        <button
          class="slx-memoir-tab ${activeTab === tab.id ? 'is-active' : ''}"
          type="button"
          role="tab"
          id="slx-memoir-tab-${tab.id}"
          aria-selected="${activeTab === tab.id}"
          aria-controls="slx-memoir-tabpanel-${tab.id}"
          data-slx-memoir-tab="${tab.id}"
        >${escapeHtml(tab.label)}</button>
      `).join('')}
    </div>
  `;
}

export function renderMemoirPanel(settings = null, chatState = getChatState()) {
  return `
    <div class="slx-memoir-root">
      ${renderMemoirTabBar()}
      <div
        class="slx-memoir-tabpanel"
        role="tabpanel"
        id="slx-memoir-tabpanel-memoir"
        aria-labelledby="slx-memoir-tab-memoir"
        data-slx-memoir-tabpanel="memoir"
        ${activeTab === 'memoir' ? '' : 'hidden'}
      >
        ${renderMemoirTabContent(settings, chatState)}
      </div>
      <div
        class="slx-memoir-tabpanel"
        role="tabpanel"
        id="slx-memoir-tabpanel-capture"
        aria-labelledby="slx-memoir-tab-capture"
        data-slx-memoir-tabpanel="capture"
        ${activeTab === 'capture' ? '' : 'hidden'}
      >
        ${renderCapturePanel()}
      </div>
    </div>
  `;
}

// ── 事件 ─────────────────────────────────────────────────────────────

/** 从面板 DOM 收集当前（可能已编辑的）候选。 */
function collectEditedCandidates(panelRoot) {
  const memoir = getMemoirState();
  const pending = memoir.pending;
  if (!pending) return [];
  const cards = panelRoot.querySelectorAll('[data-slx-memoir-cand]');
  const byId = new Map();
  cards.forEach(card => {
    const id = card.getAttribute('data-slx-memoir-cand');
    const original = pending.candidates.find(candidate => candidate.candidateId === id);
    const get = field => card.querySelector(`[data-field="${field}"]`)?.value ?? '';
    byId.set(id, {
      candidateId: id,
      memoirId: original?.memoirId,
      title: String(get('title')).trim() || '未命名回忆',
      storyTime: String(get('storyTime')).trim() || '未明',
      importance: get('importance') || 'medium',
      mainKeywords: inputToKeywords(get('mainKeywords')),
      filterKeywords: inputToKeywords(get('filterKeywords')),
      participants: Array.isArray(original?.participants) ? original.participants : [],
      digest: String(get('digest')).trim(),
      content: String(get('content')).trim(),
    });
  });
  // 保持 pending 顺序，只取仍在 DOM 中的
  return pending.candidates
    .map(c => byId.get(c.candidateId))
    .filter(Boolean);
}

function setStatus(status, { message = '', error = '' } = {}) {
  panelState = { status, message, error };
}

function confirmUseCurrentWorldbook(worldbookName) {
  return window.confirm(
    `当前聊天已经绑定世界书：\n「${worldbookName}」\n\n`
    + '确定：继续使用当前世界书写入回忆录。\n'
    + '取消：保留当前世界书，并创建、切换到新的蜃灵回忆录世界书。',
  );
}

/**
 * Tab 直接切换：只改 hidden 与 active 状态，不调用全局 refreshPanel()，
 * 避免重建 DOM 丢失两侧未提交的表单编辑。
 */
function bindMemoirTabEvents(panelRoot) {
  const tabs = [...panelRoot.querySelectorAll('[data-slx-memoir-tab]')];
  const panels = panelRoot.querySelectorAll('[data-slx-memoir-tabpanel]');
  const activateTab = (tab, { focus = false } = {}) => {
    const target = tab.getAttribute('data-slx-memoir-tab') || 'memoir';
    activeTab = target;
    tabs.forEach(node => {
      const isActive = node.getAttribute('data-slx-memoir-tab') === target;
      node.classList.toggle('is-active', isActive);
      node.setAttribute('aria-selected', String(isActive));
      node.tabIndex = isActive ? 0 : -1;
    });
    panels.forEach(panel => {
      const isActive = panel.getAttribute('data-slx-memoir-tabpanel') === target;
      if (isActive) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    if (focus) tab.focus();
  };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      activateTab(tab);
    });
    tab.addEventListener('keydown', event => {
      const currentIndex = tabs.indexOf(tab);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(tabs[nextIndex], { focus: true });
    });
  });
  tabs.forEach(tab => {
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  });
}

export function bindMemoirPanelEvents(panelRoot, settings) {
  bindCaptureEvents(panelRoot);
  bindMemoirTabEvents(panelRoot);

  // 面板打开时异步以真实世界书同步一次展示；仅状态发生变化时重绘，避免无意义刷新。
  void reconcileMemoirWorldbookState()
    .then(result => {
      if (result.changed) refreshPanel();
    })
    .catch(error => {
      console.warn('[蜃灵助手] 回忆录面板同步世界书失败，暂时保留本地展示。', error);
    });

  panelRoot.querySelector('[data-slx-memoir-enabled]')?.addEventListener('change', event => {
    const memoirSettings = getMemoirSettings(settings);
    memoirSettings.enabled = event.currentTarget.checked;
    saveGlobalSettings();
    refreshPanel();
  });

  panelRoot.querySelectorAll('[data-slx-memoir-api-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.getAttribute('data-slx-memoir-api-mode');
      if (!['main_api', 'secondary_api'].includes(mode)) return;
      getMemoirSettings(settings).apiMode = mode;
      saveGlobalSettings();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-memoir-manual]')?.addEventListener('click', async () => {
    setStatus('extracting');
    refreshPanel();
    try {
      const grandList = collectRecentGrandMemories({ limit: 1, includeHidden: true });
      const latest = grandList.at(-1);
      if (!latest?.content) {
        setStatus('idle', { error: '未找到大总结楼，请先生成一次大总结。' });
        refreshPanel();
        return;
      }
      const archiveRecord = (getChatState().summary?.archiveRecords || [])
        .find(record => Number(record?.summaryMessageId) === Number(latest.messageId)) || null;
      const extractionOptions = {
        generate: generateSummaryMemory,
        grandMemoryText: latest.content,
        sourceKey: `manual:${latest.messageId}`,
        archiveRecord,
      };
      let result = await runManualMemoirExtraction(extractionOptions);
      if (result.reason === 'already_pending') {
        setStatus('idle', { message: '最新大总结已经在待确认列表中，无需重复提炼。' });
        refreshPanel();
        return;
      }
      if (result.reason === 'already_processed') {
        const confirmed = window.confirm(
          '最新大总结已经处理并写入过回忆录。\n\n'
          + '继续会生成一批全新的候选，可能与现有绿灯内容重复；这不是失败重试去重。\n\n'
          + '仍要重新提炼吗？',
        );
        if (!confirmed) {
          setStatus('idle', { message: '已取消重复提炼。' });
          refreshPanel();
          return;
        }
        result = await runManualMemoirExtraction({ ...extractionOptions, allowProcessed: true });
      }
      if (!result.staged) {
        setStatus('idle', { message: '本次未提炼到可写入的已完成事件。' });
      } else {
        setStatus('idle', { message: `提炼出 ${result.count} 条候选，请在下方确认。` });
      }
    } catch (error) {
      setStatus('idle', { error: error.message || String(error) });
    }
    refreshPanel();
  });

  panelRoot.querySelectorAll('[data-slx-memoir-cand-del]').forEach(btn => {
    btn.addEventListener('click', event => {
      const id = event.currentTarget.getAttribute('data-slx-memoir-cand-del');
      const memoir = getMemoirState();
      if (memoir.pending) {
        memoir.pending.candidates = memoir.pending.candidates.filter(c => c.candidateId !== id);
        if (!memoir.pending.candidates.length) memoir.pending = null;
        saveChatState();
      }
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-memoir-discard]')?.addEventListener('click', () => {
    discardMemoirPending();
    setStatus('idle', { message: '已忽略本批候选。' });
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-memoir-commit]')?.addEventListener('click', async () => {
    const memoir = getMemoirState();
    const sourceKey = memoir.pending?.sourceKey || '';
    const sourceKeys = Array.isArray(memoir.pending?.sourceKeys)
      ? memoir.pending.sourceKeys
      : [sourceKey].filter(Boolean);
    // 先把 DOM 里的编辑写回 pending，避免刷新丢失
    const edited = collectEditedCandidates(panelRoot);
    if (!edited.length) {
      setStatus('idle', { error: '没有可写入的候选。' });
      refreshPanel();
      return;
    }
    setStatus('committing');
    refreshPanel();
    try {
      const result = await commitMemoirCandidates(edited, {
        sourceKey,
        sourceKeys,
        confirmUseCurrent: confirmUseCurrentWorldbook,
      });
      setStatus('idle', {
        message: `已写入 ${result.greenAdded} 条绿灯，蓝灯${result.blueMode === 'created' ? '已创建' : '已更新'}，当前共 ${result.totalEntries} 条。`,
      });
    } catch (error) {
      setStatus('idle', { error: error.message || String(error) });
    }
    refreshPanel();
  });
}

// ── 设定采集：正式表单、草稿审阅与世界书条目选择器 ────────────────

// 设定采集正式界面：需求与材料表单、草稿审阅、批量操作与世界书条目选择器。
// UI 临时态保存在本模块；持久数据统一写回 getMemoirState().capture 并 saveChatState()。
// 阶段 G：正式写入只按 captureId 独立读回结果清理草稿，缺失项保留供安全重试。


const TYPE_LABELS = { auto: '自动', npc: 'NPC', item: '物品', location: '地点', other: '其他' };
const DRAFT_TYPE_LABELS = { npc: 'NPC', item: '物品', location: '地点', other: '其他' };
const SOURCE_LABELS = {
  recent_chat: '最近聊天',
  floor_range: '指定楼层',
  grand_plus_after: '大总结＋后续',
};
const POSITION_LABELS = {
  before_character_definition: '角色定义前',
  after_character_definition: '角色定义后',
};

// ── 临时 UI 状态 ──────────────────────────────────────────────────────
// activeTab 只保存运行态，默认「剧情回忆」。持久数据在 memoir.capture。

function createWorldbookModalState() {
  return {
    open: false,
    initialized: false,
    loading: false,
    loadingMessage: '',
    error: '',
    names: [],
    primaryWorldbook: '',
    books: {},
    expanded: new Set(),
    search: '',
    workingRefs: [],
  };
}

function createCaptureUiState() {
  return {
    activeChatKey: '',
    formCollapsed: false,
    generating: false,
    writing: false,
    advancedOpen: false,
    error: null, // { message, rawResponse }
    writeNotice: null, // { kind: success | partial | error, message }
    draftErrors: new Map(),
    confirmAction: null, // 写入世界书前的确认：{ kind: 'write-selected', ids, message, confirmLabel }
    selectedDraftIds: new Set(),
    highlightDraftIds: new Set(),
    worldbook: createWorldbookModalState(),
  };
}

let uiState = createCaptureUiState();
let worldbookSearchTimer = null;

function getCaptureChatKey() {
  const info = getContextInfo();
  return `${info.characterId || ''}::${info.chatId || info.chatName || ''}`;
}

function syncCaptureChatState() {
  const activeChatKey = getCaptureChatKey();
  if (uiState.activeChatKey === activeChatKey) return;
  uiState = { ...createCaptureUiState(), activeChatKey };
}

/** 读取当前聊天的持久采集状态（已由 getMemoirState 标准化）。 */
function getCapture() {
  return getMemoirState().capture;
}

function persistCapture() {
  saveChatState();
}

function worldbookRefKey(worldbookName, uid) {
  return `${worldbookName}\u0000${uid}`;
}

function cloneWorldbookRefs(refs = []) {
  return (Array.isArray(refs) ? refs : []).map(ref => ({
    worldbookName: ref.worldbookName,
    uid: ref.uid,
    entryNameSnapshot: ref.entryNameSnapshot || '',
  }));
}

export function isCaptureWorldbookModalOpen() {
  return Boolean(uiState.worldbook.open);
}

// ── 剧情来源预览 ──────────────────────────────────────────────────────

/** 同步计算当前来源的实际材料范围，用于预览行；失败返回结构化错误。 */
function computeSourcePreview(source) {
  const result = buildCaptureSourceMaterial(source);
  if (!result.ok) {
    return { ok: false, message: result.errors?.[0]?.message || '当前来源无法读取材料。' };
  }
  const stats = result.stats || {};
  const lines = [];
  if (result.mode === 'grand_plus_after') {
    const summary = result.summary;
    if (summary) {
      const coverage = summary.coverageFrom !== null && summary.coverageTo !== null
        ? `覆盖第 ${summary.coverageFrom}—${summary.coverageTo} 楼`
        : '覆盖范围未记录';
      lines.push(`最近大总结：第 ${summary.messageId} 楼 · ${coverage}`);
    }
    const tail = stats.fromFloor !== null && stats.toFloor !== null
      ? `第 ${stats.fromFloor}—${stats.toFloor} 楼`
      : '无后续楼层';
    lines.push(`后续聊天：${tail} · ${stats.messageCount || 0} 条消息 · 约 ${stats.characterCount || 0} 字`);
  } else {
    const range = stats.fromFloor !== null && stats.toFloor !== null
      ? `第 ${stats.fromFloor}—${stats.toFloor} 楼`
      : '范围未知';
    lines.push(`预计读取：${range} · ${stats.messageCount || 0} 条消息 · 约 ${stats.characterCount || 0} 字`);
  }
  return { ok: true, lines };
}

// ── 表单渲染 ──────────────────────────────────────────────────────────

function renderTypeChips(requestedType, disabled = false) {
  return `
    <div class="slx-capture-type-chips" role="group" aria-label="条目类型">
      ${CAPTURE_TYPES.map(type => `
        <button
          class="slx-capture-type-chip ${requestedType === type ? 'is-active' : ''}"
          type="button"
          aria-pressed="${requestedType === type}"
          data-slx-capture-type="${type}"
          ${disabled ? 'disabled' : ''}
        >${escapeHtml(TYPE_LABELS[type])}</button>
      `).join('')}
    </div>
  `;
}

function renderSourceDetail(source, disabled = false) {
  if (source.mode === 'recent_chat') {
    return `
      <label class="slx-capture-inline-field">
        <span>最近</span>
        <input type="number" min="5" max="200" value="${escapeHtml(source.recentCount)}" data-slx-capture-recent aria-label="最近楼层数" ${disabled ? 'disabled' : ''} />
        <span>楼</span>
      </label>
    `;
  }
  if (source.mode === 'floor_range') {
    return `
      <label class="slx-capture-inline-field">
        <span>楼层</span>
        <input type="number" min="0" placeholder="从" value="${escapeHtml(source.fromFloor ?? '')}" data-slx-capture-from aria-label="起始楼层" ${disabled ? 'disabled' : ''} />
        <span>—</span>
        <input type="number" min="0" placeholder="到" value="${escapeHtml(source.toFloor ?? '')}" data-slx-capture-to aria-label="结束楼层" ${disabled ? 'disabled' : ''} />
      </label>
    `;
  }
  return '<p class="slx-capture-source-note">读取最近有效大总结，并追加总结之后尚未覆盖的纯聊天楼层。</p>';
}

function renderSourcePreview(source) {
  const preview = computeSourcePreview(source);
  if (!preview.ok) {
    return `<div class="slx-capture-source-preview has-error">${escapeHtml(preview.message)}</div>`;
  }
  return `
    <div class="slx-capture-source-preview">
      ${preview.lines.map(line => `<span>${escapeHtml(line)}</span>`).join('')}
    </div>
  `;
}

function renderSourceTabs(source, disabled = false) {
  return `
    <div class="slx-capture-source-tabs" role="radiogroup" aria-label="主要剧情来源">
      ${CAPTURE_SOURCE_MODES.map(mode => `
        <button
          class="slx-capture-source-tab ${source.mode === mode ? 'is-active' : ''}"
          type="button"
          role="radio"
          aria-checked="${source.mode === mode}"
          data-slx-capture-source="${mode}"
          ${disabled ? 'disabled' : ''}
        >${escapeHtml(SOURCE_LABELS[mode])}</button>
      `).join('')}
    </div>
    <div class="slx-capture-source-detail">${renderSourceDetail(source, disabled)}</div>
    ${renderSourcePreview(source)}
  `;
}

function renderContextSection(capture, disabled = false) {
  const sources = inspectCaptureOptionalSources();
  const character = sources.characterCard;
  const persona = sources.persona;
  const optional = capture.optionalContext;
  const wbCount = optional.worldbookRefs.length;
  return `
    <div class="slx-capture-context">
      <button
        class="slx-toggle-chip ${optional.includeCharacterCard && character.available ? 'is-active' : ''} ${character.available ? '' : 'is-disabled'}"
        type="button"
        aria-pressed="${optional.includeCharacterCard && character.available}"
        ${character.available && !disabled ? '' : 'disabled'}
        data-slx-capture-ctx="character"
        title="${escapeHtml(character.available ? (character.name || '当前角色卡') : character.reason)}"
      >角色卡${character.available ? '' : `<small>${escapeHtml(character.reason || '不可用')}</small>`}</button>
      <button
        class="slx-toggle-chip ${optional.includePersona && persona.available ? 'is-active' : ''} ${persona.available ? '' : 'is-disabled'}"
        type="button"
        aria-pressed="${optional.includePersona && persona.available}"
        ${persona.available && !disabled ? '' : 'disabled'}
        data-slx-capture-ctx="persona"
        title="${escapeHtml(persona.available ? '当前 Persona' : persona.reason)}"
      >Persona${persona.available ? '' : `<small>${escapeHtml(persona.reason || '不可用')}</small>`}</button>
      <button class="slx-capture-wb-btn" type="button" data-slx-capture-wb-open ${disabled ? 'disabled' : ''}>
        世界书条目
        ${wbCount ? `<span class="slx-capture-wb-count">已选 ${wbCount}</span>` : ''}
        <span aria-hidden="true">▸</span>
      </button>
    </div>
  `;
}

function renderCaptureError() {
  const persisted = String(getCapture().lastError || '');
  const marker = '\n\n【原始响应】\n';
  const markerIndex = persisted.indexOf(marker);
  const persistedError = persisted
    ? {
      message: markerIndex >= 0 ? persisted.slice(0, markerIndex) : persisted,
      rawResponse: markerIndex >= 0 ? persisted.slice(markerIndex + marker.length) : '',
    }
    : null;
  const error = uiState.error || persistedError;
  if (!error) return '';
  const raw = String(error.rawResponse || '').trim();
  return `
    <div class="slx-capture-error has-error">
      <div class="slx-capture-error-head">
        <p>${escapeHtml(error.message || '生成失败。')}</p>
        <button class="slx-capture-error-close" type="button" data-slx-capture-error-close aria-label="关闭错误提示">×</button>
      </div>
      ${raw ? `
        <details class="slx-capture-error-detail">
          <summary>查看模型原始响应</summary>
          <pre>${escapeHtml(raw)}</pre>
        </details>
      ` : ''}
    </div>
  `;
}

function buildFormSummary(capture) {
  const parts = [TYPE_LABELS[capture.requestedType] || '自动'];
  if (capture.source.mode === 'recent_chat') parts.push(`最近 ${capture.source.recentCount} 楼`);
  else if (capture.source.mode === 'floor_range') {
    const from = capture.source.fromFloor ?? '?';
    const to = capture.source.toFloor ?? '?';
    parts.push(`第 ${from}—${to} 楼`);
  } else parts.push('大总结＋后续');
  const extras = [];
  if (capture.optionalContext.includeCharacterCard) extras.push('角色卡');
  if (capture.optionalContext.includePersona) extras.push('Persona');
  const wbCount = capture.optionalContext.worldbookRefs.length;
  if (wbCount) extras.push(`${wbCount} 条世界书`);
  if (extras.length) parts.push(extras.join('＋'));
  return parts.join(' · ');
}

// ── 草稿卡片 ──────────────────────────────────────────────────────────

function renderDraftCard(draft) {
  const selected = uiState.selectedDraftIds.has(draft.captureId);
  const highlight = uiState.highlightDraftIds.has(draft.captureId);
  const writeError = uiState.draftErrors.get(draft.captureId) || '';
  const typeLabel = DRAFT_TYPE_LABELS[draft.type] || '其他';
  return `
    <div class="slx-capture-draft-card slx-editor ${selected ? 'is-selected' : ''} ${highlight ? 'is-new' : ''} ${writeError ? 'has-write-error' : ''}" data-slx-capture-draft="${escapeHtml(draft.captureId)}">
      <div class="slx-capture-draft-head">
        <label class="slx-capture-draft-check">
          <input type="checkbox" data-slx-capture-draft-select ${selected ? 'checked' : ''} aria-label="选择此草稿" />
        </label>
        <span class="slx-capture-type-badge slx-type-${escapeHtml(draft.type)}">${escapeHtml(typeLabel)}</span>
        <input
          class="slx-editor-input slx-capture-draft-title"
          data-slx-capture-field="title"
          value="${escapeHtml(draft.title)}"
          placeholder="条目标题"
          aria-label="条目标题"
        />
        <button class="slx-soft-btn slx-danger-mini-btn" type="button" data-slx-capture-draft-del title="删除此草稿" aria-label="删除此草稿">删除</button>
      </div>
      <div class="slx-capture-draft-keywords">
        <label class="slx-editor-field">
          <span>主要关键词</span>
          <input class="slx-editor-input" data-slx-capture-field="mainKeywords" value="${escapeHtml(keywordsToInput(draft.mainKeywords))}" placeholder="用于唤起条目的名称、别名" />
        </label>
        <label class="slx-editor-field">
          <span>过滤器关键词</span>
          <input class="slx-editor-input" data-slx-capture-field="filterKeywords" value="${escapeHtml(keywordsToInput(draft.filterKeywords))}" placeholder="地点、组织、关系等语境锚点" />
        </label>
      </div>
      <label class="slx-editor-field slx-capture-draft-content">
        <span>正文</span>
        <textarea class="slx-editor-textarea" data-slx-capture-field="content" rows="5" placeholder="完整、可独立阅读的设定正文">${escapeHtml(draft.content)}</textarea>
      </label>
      <div class="slx-capture-draft-foot">
        <label class="slx-capture-draft-inline">
          <span>插入位置</span>
          <select class="slx-editor-input" data-slx-capture-field="position" aria-label="插入位置">
            ${CAPTURE_POSITIONS.map(pos => `<option value="${pos}" ${draft.position === pos ? 'selected' : ''}>${escapeHtml(POSITION_LABELS[pos])}</option>`).join('')}
          </select>
        </label>
        <label class="slx-capture-draft-inline">
          <span>顺序</span>
          <input class="slx-editor-input slx-capture-draft-order" type="number" data-slx-capture-field="order" value="${escapeHtml(draft.order)}" aria-label="插入顺序" />
        </label>
      </div>
      ${writeError ? `<div class="slx-capture-draft-error" role="alert">${escapeHtml(writeError)}</div>` : ''}
    </div>
  `;
}

function renderCaptureWriteNotice() {
  if (!uiState.writeNotice) return '';
  return `
    <div class="slx-capture-write-notice is-${escapeHtml(uiState.writeNotice.kind)}" role="status">
      ${escapeHtml(uiState.writeNotice.message)}
    </div>
  `;
}

function renderDraftsArea(capture) {
  const drafts = capture.drafts;
  if (!drafts.length && !uiState.generating) {
    return `
      <div class="slx-capture-drafts">
        ${renderCaptureWriteNotice()}
        <div class="slx-capture-empty">
          <span aria-hidden="true">📝</span>
          <p>填写需求后点击「生成草稿」</p>
        </div>
      </div>
    `;
  }
  return `
    <div class="slx-capture-drafts">
      ${renderCaptureWriteNotice()}
      ${uiState.generating ? `
        <div class="slx-capture-generating" role="status" aria-live="polite">
          <span class="slx-capture-spinner" aria-hidden="true"></span>
          <p>正在整理参考材料并生成草稿…</p>
        </div>
      ` : ''}
      ${drafts.map(renderDraftCard).join('')}
    </div>
  `;
}

function renderBatchBar(capture) {
  const drafts = capture.drafts;
  if (!drafts.length) return '';
  const total = drafts.length;
  const selectedCount = drafts.filter(draft => uiState.selectedDraftIds.has(draft.captureId)).length;
  const allSelected = selectedCount === total && total > 0;
  const actionDisabled = uiState.writing ? 'disabled' : '';
  const batchConfirmation = uiState.confirmAction ? renderCaptureConfirmation(uiState.confirmAction) : '';
  return `
    <div class="slx-capture-batch-wrap">
      ${batchConfirmation}
      <div class="slx-capture-batch-bar">
      <button class="slx-soft-btn" type="button" data-slx-capture-select-all ${actionDisabled}>${allSelected ? '取消全选' : '全选'}</button>
      <button class="slx-soft-btn slx-capture-discard-btn" type="button" data-slx-capture-discard-all ${actionDisabled}>放弃全部</button>
      <span class="slx-capture-batch-spacer"></span>
      <button class="slx-soft-btn slx-danger-mini-btn" type="button" data-slx-capture-delete-selected ${selectedCount && !uiState.writing ? '' : 'disabled'}>删除已选${selectedCount ? ` (${selectedCount})` : ''}</button>
      <button class="slx-soft-btn slx-primary-btn slx-capture-write-btn" type="button" data-slx-capture-write-selected ${selectedCount && !uiState.writing ? '' : 'disabled'}>${uiState.writing ? '写入并核对中…' : `写入已选${selectedCount ? ` (${selectedCount})` : ''}`}</button>
      </div>
    </div>
  `;
}

function renderCaptureConfirmation(action) {
  const isWrite = action.kind === 'write-selected';
  return `
    <div class="slx-capture-confirm" role="alertdialog" aria-modal="false" aria-label="确认操作">
      <p>${escapeHtml(action.message)}</p>
      <span class="slx-capture-confirm-actions">
        <button class="slx-soft-btn" type="button" data-slx-capture-confirm-cancel>取消</button>
        <button class="slx-soft-btn ${isWrite ? 'slx-primary-btn' : 'slx-danger-mini-btn'}" type="button" data-slx-capture-confirm-accept>${escapeHtml(action.confirmLabel || '确认')}</button>
      </span>
    </div>
  `;
}

function renderCaptureForm(capture) {
  const collapsed = uiState.formCollapsed;
  const generating = uiState.generating;
  if (collapsed) {
    return `
      <div class="slx-capture-form is-collapsed">
        <div class="slx-capture-form-summary">
          <span>${escapeHtml(buildFormSummary(capture))}</span>
          <button class="slx-soft-btn" type="button" data-slx-capture-form-expand>修改需求 ⌄</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="slx-capture-form">
      <label class="slx-editor-field slx-capture-request-field">
        <span>你想采集什么设定？</span>
        <textarea
          class="slx-editor-textarea slx-capture-request"
          rows="4"
          placeholder="描述你想采集的设定，例如：生成 NPC「林鸢」的人物设定"
          data-slx-capture-request
          ${generating ? 'disabled' : ''}
        >${escapeHtml(capture.request)}</textarea>
      </label>
      ${renderTypeChips(capture.requestedType, generating)}
      ${renderSourceTabs(capture.source, generating)}
      ${renderContextSection(capture, generating)}
      <button
        class="slx-soft-btn slx-primary-btn slx-capture-generate-btn ${generating ? 'is-loading' : ''}"
        type="button"
        data-slx-capture-generate
        ${generating ? 'disabled' : ''}
      >${generating ? '生成中…' : '生成草稿'}</button>
      ${renderCaptureError()}
    </div>
  `;
}

// ── 世界书条目选择器弹层 ───────────────────────────────────────────────

function isWorkingRefSelected(worldbookName, uid) {
  const key = worldbookRefKey(worldbookName, uid);
  return uiState.worldbook.workingRefs.some(ref => worldbookRefKey(ref.worldbookName, ref.uid) === key);
}

function renderWbEntry(worldbookName, entry) {
  const selected = isWorkingRefSelected(worldbookName, entry.uid);
  const strategyLabel = entry.strategyType === 'constant'
    ? '常驻'
    : (entry.strategyType === 'vectorized' ? '向量' : '选择性');
  const keywords = [...entry.mainKeywords, ...entry.filterKeywords].join('、');
  return `
    <label class="slx-capture-wb-entry ${selected ? 'is-selected' : ''}">
      <input
        type="checkbox"
        data-slx-capture-wb-entry
        data-worldbook-name="${escapeHtml(worldbookName)}"
        data-entry-uid="${escapeHtml(entry.uid)}"
        ${selected ? 'checked' : ''}
      />
      <span class="slx-capture-wb-entry-main">
        <b>${escapeHtml(entry.name)}</b>
        <span class="slx-capture-wb-badges">
          <em>${escapeHtml(strategyLabel)}</em>
          ${entry.enabled ? '' : '<em class="is-disabled">已停用</em>'}
        </span>
        ${keywords ? `<small>${escapeHtml(keywords)}</small>` : ''}
        <small>${escapeHtml(entry.preview || '（正文为空）')}</small>
      </span>
    </label>
  `;
}

function renderWbGroup(worldbookName) {
  const wb = uiState.worldbook;
  const book = wb.books[worldbookName];
  const expanded = wb.expanded.has(worldbookName) || Boolean(wb.search);
  const entries = book?.status === 'loaded' ? book.entries : [];
  const visibleEntries = filterCaptureWorldbookEntries(entries, wb.search);
  if (wb.search && book?.status === 'loaded' && visibleEntries.length === 0) return '';
  const selectedCount = wb.workingRefs.filter(ref => ref.worldbookName === worldbookName).length;
  let body = '';
  if (expanded) {
    if (!book || book.status === 'idle') body = '<p class="slx-capture-wb-hint">展开后读取本书全部条目。</p>';
    else if (book.status === 'loading') body = '<p class="slx-capture-wb-hint">条目加载中…</p>';
    else if (book.status === 'failed') body = `<p class="slx-capture-wb-error">${escapeHtml(book.error || '加载失败')}</p>`;
    else if (!visibleEntries.length) body = '<p class="slx-capture-wb-hint">本书没有符合条件的条目。</p>';
    else body = visibleEntries.map(entry => renderWbEntry(worldbookName, entry)).join('');
  }
  return `
    <div class="slx-capture-wb-group">
      <div class="slx-capture-wb-head">
        <button type="button" data-slx-capture-wb-expand="${escapeHtml(worldbookName)}">
          <span aria-hidden="true">${expanded ? '▾' : '▸'}</span>
          <b>${escapeHtml(worldbookName)}</b>
          <small>${book?.status === 'loaded' ? `${selectedCount}/${entries.length}` : `已选 ${selectedCount}`}</small>
        </button>
        ${book?.status === 'loaded' ? `
          <span class="slx-capture-wb-head-actions">
            <button type="button" data-slx-capture-wb-book-all="${escapeHtml(worldbookName)}">全选</button>
            <button type="button" data-slx-capture-wb-book-clear="${escapeHtml(worldbookName)}">清空</button>
          </span>
        ` : ''}
      </div>
      ${expanded ? `<div class="slx-capture-wb-entries">${body}</div>` : ''}
    </div>
  `;
}

function renderWorldbookModal() {
  const wb = uiState.worldbook;
  if (!wb.open) return '';
  const groups = wb.names.map(name => renderWbGroup(name)).join('');
  const selectedCount = wb.workingRefs.length;
  let bodyContent = '';
  if (wb.loading && !wb.names.length) {
    bodyContent = `<p class="slx-capture-wb-hint">${escapeHtml(wb.loadingMessage || '正在读取…')}</p>`;
  } else if (wb.error) {
    bodyContent = `<p class="slx-capture-wb-error">${escapeHtml(wb.error)}</p>`;
  } else if (!wb.names.length) {
    bodyContent = '<p class="slx-capture-wb-hint">当前角色卡没有绑定任何世界书，无条目可选。</p>';
  } else {
    const boundHint = `仅显示当前角色卡绑定的世界书${wb.primaryWorldbook ? `（主要：${escapeHtml(wb.primaryWorldbook)}）` : ''}。`;
    bodyContent = `
      <p class="slx-capture-wb-hint">${boundHint}</p>
      <p class="slx-capture-wb-note">被手动勾选的条目将直接作为参考材料注入，不受启用状态和关键词触发条件影响。</p>
      ${wb.loadingMessage ? `<p class="slx-capture-wb-hint">${escapeHtml(wb.loadingMessage)}</p>` : ''}
      ${groups}
    `;
  }
  return `
    <div class="slx-capture-wb-overlay" data-slx-capture-wb-overlay>
      <div class="slx-capture-wb-modal" role="dialog" aria-modal="true" aria-label="世界书条目选择">
        <div class="slx-capture-wb-modal-head">
          <b>世界书条目选择 · 已选 ${escapeHtml(selectedCount)}</b>
          <button type="button" class="slx-icon-btn" data-slx-capture-wb-close aria-label="关闭">×</button>
        </div>
        <div class="slx-capture-wb-modal-search">
          <input type="search" value="${escapeHtml(wb.search)}" placeholder="搜索标题或关键词…" data-slx-capture-wb-search aria-label="搜索世界书条目" />
        </div>
        <div class="slx-capture-wb-modal-body">
          ${bodyContent}
        </div>
        <div class="slx-capture-wb-modal-foot">
          <button type="button" class="slx-soft-btn" data-slx-capture-wb-cancel>取消</button>
          <button type="button" class="slx-soft-btn slx-primary-btn" data-slx-capture-wb-confirm>确认选择 (${escapeHtml(selectedCount)})</button>
        </div>
      </div>
    </div>
  `;
}

// ── 顶层渲染 ──────────────────────────────────────────────────────────

/** 设定采集主内容（不含 Tab 外壳与世界书弹层）。 */
function renderCaptureRegion(capture) {
  return `
    <div class="slx-capture-region" data-slx-capture-region>
      ${renderCaptureForm(capture)}
      ${renderDraftsArea(capture)}
      ${renderBatchBar(capture)}
    </div>
  `;
}

export function renderCapturePanel() {
  syncCaptureChatState();
  const capture = getCapture();
  return `
    ${renderCaptureRegion(capture)}
    ${renderWorldbookModal()}
  `;
}

// ── 局部重绘 ──────────────────────────────────────────────────────────
// 只替换采集内容子树，保留 Tab 外壳、模块滚动与聊天回忆面板状态。
// 世界书弹层的开关会改变面板 -only 接管态，必须走全局 refreshPanel。

function replaceCaptureRegion(panelRoot) {
  const current = panelRoot.querySelector('[data-slx-capture-region]');
  if (!current) return;
  const template = document.createElement('template');
  template.innerHTML = renderCaptureRegion(getCapture()).trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  current.replaceWith(next);
  bindCaptureEvents(panelRoot);
}

// ── 事件绑定 ──────────────────────────────────────────────────────────

export function bindCaptureEvents(panelRoot) {
  const region = panelRoot.querySelector('[data-slx-capture-region]');
  if (region) {
    bindFormEvents(panelRoot, region);
    bindDraftEvents(panelRoot, region);
    bindBatchEvents(panelRoot, region);
    bindCaptureConfirmationEvents(panelRoot, region);
  }
  bindWorldbookModalEvents(panelRoot);
}

/** 生成前把仍在 DOM 中的表单值写回状态，避免异步刷新丢失编辑。 */
function syncFormInputs(region) {
  const capture = getCapture();
  const request = region.querySelector('[data-slx-capture-request]');
  if (request) capture.request = request.value;
  const recent = region.querySelector('[data-slx-capture-recent]');
  if (recent) capture.source.recentCount = Math.min(200, Math.max(5, Number(recent.value) || 20));
  const from = region.querySelector('[data-slx-capture-from]');
  if (from) capture.source.fromFloor = from.value === '' ? null : Number(from.value);
  const to = region.querySelector('[data-slx-capture-to]');
  if (to) capture.source.toFloor = to.value === '' ? null : Number(to.value);
}

function bindFormEvents(panelRoot, region) {
  region.querySelector('[data-slx-capture-request]')?.addEventListener('input', event => {
    getCapture().request = event.target.value;
    uiState.error = null;
    persistCapture();
  });

  region.querySelector('[data-slx-capture-form-expand]')?.addEventListener('click', () => {
    uiState.formCollapsed = false;
    replaceCaptureRegion(panelRoot);
  });

  region.querySelectorAll('[data-slx-capture-type]').forEach(button => {
    button.addEventListener('click', () => {
      syncFormInputs(region);
      getCapture().requestedType = button.getAttribute('data-slx-capture-type') || 'auto';
      persistCapture();
      replaceCaptureRegion(panelRoot);
    });
  });

  region.querySelectorAll('[data-slx-capture-source]').forEach(button => {
    button.addEventListener('click', () => {
      syncFormInputs(region);
      getCapture().source.mode = button.getAttribute('data-slx-capture-source') || 'recent_chat';
      persistCapture();
      replaceCaptureRegion(panelRoot);
    });
  });

  // 数字来源框改动后重算预览；用 change 避免每次击键都重绘。
  region.querySelector('[data-slx-capture-recent]')?.addEventListener('change', () => {
    syncFormInputs(region);
    persistCapture();
    replaceCaptureRegion(panelRoot);
  });
  region.querySelector('[data-slx-capture-from]')?.addEventListener('change', () => {
    syncFormInputs(region);
    persistCapture();
    replaceCaptureRegion(panelRoot);
  });
  region.querySelector('[data-slx-capture-to]')?.addEventListener('change', () => {
    syncFormInputs(region);
    persistCapture();
    replaceCaptureRegion(panelRoot);
  });

  region.querySelectorAll('[data-slx-capture-ctx]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      syncFormInputs(region);
      const optional = getCapture().optionalContext;
      const kind = button.getAttribute('data-slx-capture-ctx');
      if (kind === 'character') optional.includeCharacterCard = !optional.includeCharacterCard;
      else if (kind === 'persona') optional.includePersona = !optional.includePersona;
      persistCapture();
      replaceCaptureRegion(panelRoot);
    });
  });

  region.querySelector('[data-slx-capture-wb-open]')?.addEventListener('click', () => {
    syncFormInputs(region);
    persistCapture();
    void openWorldbookModal();
  });

  region.querySelector('[data-slx-capture-error-close]')?.addEventListener('click', () => {
    uiState.error = null;
    getCapture().lastError = '';
    persistCapture();
    replaceCaptureRegion(panelRoot);
  });

  region.querySelector('[data-slx-capture-generate]')?.addEventListener('click', () => {
    void runGeneration(panelRoot, region);
  });
}

async function runGeneration(panelRoot, region) {
  syncFormInputs(region);
  const capture = getCapture();
  if (!capture.request.trim()) {
    uiState.error = { message: '请先填写要采集的设定需求。' };
    replaceCaptureRegion(panelRoot);
    return;
  }
  persistCapture();
  uiState.generating = true;
  uiState.error = null;
  uiState.writeNotice = null;
  replaceCaptureRegion(panelRoot);
  try {
    const result = await runCaptureGeneration({ apiMode: getMemoirSettings().apiMode });
    uiState.generating = false;
    if (result.addedCount > 0) {
      uiState.highlightDraftIds = new Set(
        result.drafts.slice(-result.addedCount).map(draft => draft.captureId),
      );
      uiState.formCollapsed = true;
    }
    replaceCaptureRegion(panelRoot);
  } catch (error) {
    uiState.generating = false;
    const preflight = Array.isArray(error.preflightErrors)
      ? error.preflightErrors.map(item => item.message || item.code).join('；')
      : '';
    uiState.error = {
      message: preflight || error.message || String(error),
      rawResponse: error.rawResponse || '',
    };
    replaceCaptureRegion(panelRoot);
  }
}

// ── 草稿卡片事件 ──────────────────────────────────────────────────────
// 文本/关键词/正文输入直接写回草稿并 saveChatState，不重绘以保留焦点。
// 结构性操作（删除、勾选、类型徽标之外）才做局部重绘。

function findDraft(captureId) {
  return getCapture().drafts.find(draft => draft.captureId === captureId) || null;
}

function bindDraftEvents(panelRoot, region) {
  region.querySelectorAll('[data-slx-capture-draft]').forEach(card => {
    const captureId = card.getAttribute('data-slx-capture-draft');

    card.querySelectorAll('[data-slx-capture-field]').forEach(input => {
      const field = input.getAttribute('data-slx-capture-field');
      const eventName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(eventName, () => {
        const draft = findDraft(captureId);
        if (!draft) return;
        if (field === 'title') draft.title = input.value;
        else if (field === 'content') draft.content = input.value;
        else if (field === 'mainKeywords') draft.mainKeywords = inputToKeywords(input.value);
        else if (field === 'filterKeywords') draft.filterKeywords = inputToKeywords(input.value);
        else if (field === 'position') draft.position = input.value;
        else if (field === 'order') {
          const parsed = Number(input.value);
          draft.order = Number.isFinite(parsed) ? Math.trunc(parsed) : draft.order;
        }
        uiState.draftErrors.delete(captureId);
        persistCapture();
      });
    });

    card.querySelector('[data-slx-capture-draft-select]')?.addEventListener('change', event => {
      if (event.target.checked) uiState.selectedDraftIds.add(captureId);
      else uiState.selectedDraftIds.delete(captureId);
      replaceCaptureRegion(panelRoot);
    });

    card.querySelector('[data-slx-capture-draft-del]')?.addEventListener('click', () => {
      const capture = getCapture();
      capture.drafts = removeCaptureDrafts(capture.drafts, [captureId]);
      uiState.selectedDraftIds.delete(captureId);
      uiState.highlightDraftIds.delete(captureId);
      uiState.draftErrors.delete(captureId);
      persistCapture();
      replaceCaptureRegion(panelRoot);
    });
  });
}

function bindCaptureConfirmationEvents(panelRoot, region) {
  region.querySelectorAll('[data-slx-capture-confirm-cancel]').forEach(button => {
    button.addEventListener('click', () => {
      uiState.confirmAction = null;
      replaceCaptureRegion(panelRoot);
    });
  });
  region.querySelectorAll('[data-slx-capture-confirm-accept]').forEach(button => {
    button.addEventListener('click', () => {
      const action = uiState.confirmAction;
      if (!action) return;
      if (action.kind === 'write-selected') {
        uiState.confirmAction = null;
        void runCaptureWrite(panelRoot, action.ids);
        return;
      }
      uiState.confirmAction = null;
      replaceCaptureRegion(panelRoot);
    });
  });
}

// ── 批量操作栏事件 ────────────────────────────────────────────────────

function bindBatchEvents(panelRoot, region) {
  region.querySelector('[data-slx-capture-select-all]')?.addEventListener('click', () => {
    const drafts = getCapture().drafts;
    const allSelected = drafts.length > 0 && drafts.every(draft => uiState.selectedDraftIds.has(draft.captureId));
    if (allSelected) uiState.selectedDraftIds.clear();
    else uiState.selectedDraftIds = new Set(drafts.map(draft => draft.captureId));
    replaceCaptureRegion(panelRoot);
  });

  region.querySelector('[data-slx-capture-delete-selected]')?.addEventListener('click', () => {
    const ids = [...uiState.selectedDraftIds];
    if (!ids.length) return;
    const capture = getCapture();
    capture.drafts = removeCaptureDrafts(capture.drafts, ids);
    ids.forEach(id => {
      uiState.selectedDraftIds.delete(id);
      uiState.highlightDraftIds.delete(id);
      uiState.draftErrors.delete(id);
    });
    persistCapture();
    replaceCaptureRegion(panelRoot);
  });

  region.querySelector('[data-slx-capture-discard-all]')?.addEventListener('click', () => {
    const capture = getCapture();
    if (!capture.drafts.length) return;
    capture.drafts = clearCaptureDrafts();
    uiState.selectedDraftIds.clear();
    uiState.highlightDraftIds.clear();
    uiState.draftErrors.clear();
    persistCapture();
    replaceCaptureRegion(panelRoot);
  });

  region.querySelector('[data-slx-capture-write-selected]')?.addEventListener('click', () => {
    const ids = [...uiState.selectedDraftIds];
    if (!ids.length || uiState.writing) return;
    uiState.confirmAction = {
      kind: 'write-selected',
      ids,
      message: `将已选的 ${ids.length} 条设定草稿写入当前回忆录世界书，并按 captureId 独立读回核对。确认继续？`,
      confirmLabel: `确认写入 ${ids.length} 条`,
    };
    replaceCaptureRegion(panelRoot);
  });
}

async function runCaptureWrite(panelRoot, captureIds) {
  const ids = [...new Set(Array.isArray(captureIds) ? captureIds : [])];
  const drafts = getCapture().drafts.filter(draft => ids.includes(draft.captureId));
  if (!drafts.length) return;
  uiState.writing = true;
  uiState.writeNotice = null;
  ids.forEach(id => uiState.draftErrors.delete(id));
  replaceCaptureRegion(panelRoot);

  try {
    const result = await commitCaptureDrafts(drafts, {
      confirmUseCurrent: confirmUseCurrentWorldbook,
    });
    result.verifiedIds.forEach(id => {
      uiState.selectedDraftIds.delete(id);
      uiState.highlightDraftIds.delete(id);
      uiState.draftErrors.delete(id);
    });
    result.failures.forEach(failure => {
      uiState.draftErrors.set(failure.captureId, failure.message);
    });
    if (result.ok) {
      uiState.writeNotice = {
        kind: 'success',
        message: `已向「${result.worldbookName}」写入并读回核对 ${result.verifiedCount} 条设定。`,
      };
    } else if (result.verifiedCount > 0) {
      uiState.writeNotice = {
        kind: 'partial',
        message: `已核对成功 ${result.verifiedCount} 条；另有 ${result.failures.length} 条未通过，草稿已保留，可修正后重试。`,
      };
    } else {
      uiState.writeNotice = {
        kind: 'error',
        message: `本次没有草稿通过读回核对；${result.failures.length} 条均已保留。`,
      };
    }
  } catch (error) {
    const message = error.message || String(error);
    ids.forEach(id => uiState.draftErrors.set(id, message));
    uiState.writeNotice = {
      kind: 'error',
      message: `写入或独立读回失败：${message}。草稿未清理，可安全重试。`,
    };
  } finally {
    uiState.writing = false;
    replaceCaptureRegion(panelRoot);
  }
}

// ── 世界书弹层逻辑 ────────────────────────────────────────────────────
// 弹层开关改变面板 -only 接管态，走全局 refreshPanel；弹层内部交互只替换弹层子树。

async function openWorldbookModal() {
  const wb = createWorldbookModalState();
  wb.open = true;
  wb.loading = true;
  wb.loadingMessage = '正在读取当前角色卡绑定的世界书…';
  wb.workingRefs = cloneWorldbookRefs(getCapture().optionalContext.worldbookRefs);
  uiState.worldbook = wb;
  refreshPanel();

  const result = await listCaptureWorldbooks();
  const modal = uiState.worldbook;
  if (!modal.open) return; // 期间被关闭
  modal.loading = false;
  modal.loadingMessage = '';
  if (!result.ok) {
    modal.error = result.error?.message || '读取角色卡绑定的世界书失败。';
    replaceWorldbookModal();
    return;
  }
  modal.names = result.names;
  modal.primaryWorldbook = result.primary || '';
  modal.books = Object.fromEntries(result.names.map(name => [name, { status: 'idle', entries: [], error: '' }]));
  // 绑定书通常只有一两本，直接全部展开并加载条目。
  modal.names.forEach(name => modal.expanded.add(name));
  replaceWorldbookModal();
  for (const name of modal.names) {
    await ensureWbBookLoaded(name, { quiet: true });
  }
  replaceWorldbookModal();
}

async function ensureWbBookLoaded(worldbookName, { quiet = false } = {}) {
  const wb = uiState.worldbook;
  const current = wb.books[worldbookName];
  if (!current || current.status === 'loaded' || current.status === 'loading') return;
  wb.books[worldbookName] = { status: 'loading', entries: [], error: '' };
  if (!quiet) replaceWorldbookModal();
  const result = await loadCaptureWorldbookEntries(worldbookName);
  if (!uiState.worldbook.open) return;
  uiState.worldbook.books[worldbookName] = result.ok
    ? { status: 'loaded', entries: result.entries, error: '' }
    : { status: 'failed', entries: [], error: result.error?.message || '加载失败' };
  if (!quiet) replaceWorldbookModal();
}

async function loadAllWbBooksForSearch() {
  const wb = uiState.worldbook;
  const pending = wb.names.filter(name => wb.books[name]?.status !== 'loaded');
  for (const [index, name] of pending.entries()) {
    wb.loadingMessage = `搜索正在加载世界书 ${index + 1}/${pending.length}：${name}`;
    replaceWorldbookModal();
    await ensureWbBookLoaded(name, { quiet: true });
  }
  wb.loadingMessage = '';
  replaceWorldbookModal();
}

function replaceWorldbookModal() {
  if (!panelRootRef) return;
  const current = panelRootRef.querySelector('[data-slx-capture-wb-overlay]');
  const template = document.createElement('template');
  template.innerHTML = renderWorldbookModal().trim();
  const next = template.content.firstElementChild;
  if (current) {
    if (next) current.replaceWith(next);
    else current.remove();
  }
  if (next) bindWorldbookModalEvents(panelRootRef);
}

let panelRootRef = null;

function bindWorldbookModalEvents(panelRoot) {
  panelRootRef = panelRoot;
  const overlay = panelRoot.querySelector('[data-slx-capture-wb-overlay]');
  if (!overlay) return;

  overlay.querySelector('[data-slx-capture-wb-close]')?.addEventListener('click', closeWorldbookModal);
  overlay.querySelector('[data-slx-capture-wb-cancel]')?.addEventListener('click', closeWorldbookModal);

  overlay.querySelector('[data-slx-capture-wb-confirm]')?.addEventListener('click', () => {
    getCapture().optionalContext.worldbookRefs = cloneWorldbookRefs(uiState.worldbook.workingRefs);
    persistCapture();
    closeWorldbookModal();
  });

  overlay.querySelector('[data-slx-capture-wb-search]')?.addEventListener('input', event => {
    uiState.worldbook.search = event.target.value;
    if (worldbookSearchTimer) window.clearTimeout(worldbookSearchTimer);
    worldbookSearchTimer = window.setTimeout(() => {
      worldbookSearchTimer = null;
      if (uiState.worldbook.search.trim()) void loadAllWbBooksForSearch();
      else replaceWorldbookModal();
    }, 250);
  });

  overlay.querySelectorAll('[data-slx-capture-wb-expand]').forEach(button => {
    button.addEventListener('click', () => {
      const name = button.getAttribute('data-slx-capture-wb-expand') || '';
      const expanded = uiState.worldbook.expanded;
      if (expanded.has(name)) {
        expanded.delete(name);
        replaceWorldbookModal();
        return;
      }
      expanded.add(name);
      replaceWorldbookModal();
      void ensureWbBookLoaded(name);
    });
  });

  overlay.querySelectorAll('[data-slx-capture-wb-entry]').forEach(input => {
    input.addEventListener('change', () => {
      const worldbookName = input.getAttribute('data-worldbook-name') || '';
      const uid = Number(input.getAttribute('data-entry-uid'));
      const entry = uiState.worldbook.books[worldbookName]?.entries?.find(item => item.uid === uid);
      if (!entry) return;
      uiState.worldbook.workingRefs = toggleCaptureWorldbookRef(
        uiState.worldbook.workingRefs,
        { worldbookName, ...entry },
        input.checked,
      );
      replaceWorldbookModal();
    });
  });

  overlay.querySelectorAll('[data-slx-capture-wb-book-all]').forEach(button => {
    button.addEventListener('click', () => {
      const worldbookName = button.getAttribute('data-slx-capture-wb-book-all') || '';
      const entries = uiState.worldbook.books[worldbookName]?.entries || [];
      uiState.worldbook.workingRefs = setCaptureWorldbookRefsForBook(
        uiState.worldbook.workingRefs,
        worldbookName,
        entries,
        true,
      );
      replaceWorldbookModal();
    });
  });

  overlay.querySelectorAll('[data-slx-capture-wb-book-clear]').forEach(button => {
    button.addEventListener('click', () => {
      const worldbookName = button.getAttribute('data-slx-capture-wb-book-clear') || '';
      uiState.worldbook.workingRefs = setCaptureWorldbookRefsForBook(
        uiState.worldbook.workingRefs,
        worldbookName,
        [],
        false,
      );
      replaceWorldbookModal();
    });
  });
}

function closeWorldbookModal() {
  if (worldbookSearchTimer) {
    window.clearTimeout(worldbookSearchTimer);
    worldbookSearchTimer = null;
  }
  uiState.worldbook = createWorldbookModalState();
  refreshPanel();
}
