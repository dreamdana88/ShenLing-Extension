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
import { reconcileMemoirWorldbookState } from './worldbook-manager.js';

let panelOptions = { refreshPanel: () => {} };

let panelState = {
  status: 'idle', // idle | extracting | committing
  message: '',
  error: '',
};

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
        <button class="slx-primary-btn" type="button" data-slx-memoir-commit ${panelState.status === 'committing' ? 'disabled' : ''}>
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

export function renderMemoirPanel(settings = null, chatState = getChatState()) {
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

export function bindMemoirPanelEvents(panelRoot, settings) {
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
