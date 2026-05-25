import {
  escapeHtml,
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  getChatState,
  saveChatState,
} from '../../core/settings.js';
import {
  resolveDiaryContext,
} from '../../core/context-resolver.js';

let panelOptions = {
  refreshPanel: null,
};

let diaryEditorState = {
  open: false,
  entryId: '',
};

let diaryContextTestState = {
  status: 'idle',
  result: null,
  error: '',
};

export function configureDiaryPanel(options = {}) {
  panelOptions = {
    ...panelOptions,
    ...options,
  };
}

function refreshPanel() {
  if (typeof panelOptions.refreshPanel === 'function') {
    panelOptions.refreshPanel();
  }
}

function getDiaryStore(chatState) {
  if (!isPlainObject(chatState.diary)) {
    chatState.diary = {};
  }
  if (!Array.isArray(chatState.diary.entries)) {
    chatState.diary.entries = [];
  }
  if (!Array.isArray(chatState.diary.books)) {
    chatState.diary.books = [];
  }
  return chatState.diary;
}

function createDiaryId() {
  return `diary-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeDiaryEntry(entry = {}) {
  return {
    id: String(entry.id || createDiaryId()),
    authorName: String(entry.authorName || entry.roleName || '').trim(),
    title: String(entry.title || '').trim(),
    content: String(entry.content || '').trim(),
    source: String(entry.source || 'manual'),
    createdAt: String(entry.createdAt || formatTimestamp()),
    updatedAt: String(entry.updatedAt || entry.createdAt || formatTimestamp()),
    contextDigest: isPlainObject(entry.contextDigest) ? entry.contextDigest : null,
  };
}

function getDiaryEntries(chatState) {
  const store = getDiaryStore(chatState);
  store.entries = store.entries.map(normalizeDiaryEntry);
  return store.entries;
}

function openDiaryEditor(entryId) {
  diaryEditorState = {
    open: true,
    entryId: String(entryId || ''),
  };
}

function closeDiaryEditor() {
  diaryEditorState = {
    open: false,
    entryId: '',
  };
}

function getContextTestStatusText() {
  if (diaryContextTestState.status === 'running') return '正在整理上下文';
  if (diaryContextTestState.status === 'failed') return diaryContextTestState.error || '上下文测试失败';
  if (diaryContextTestState.status === 'success') {
    const diagnostics = diaryContextTestState.result?.diagnostics || {};
    const worldInfo = diagnostics.worldInfo || {};
    return `材料 ${diaryContextTestState.result?.materialLength || 0} 字 · 世界书 ${worldInfo.source || '未记录'}`;
  }
  return '可验证日记生成前会拿到哪些上下文';
}

function renderContextTestResult() {
  if (diaryContextTestState.status !== 'success' || !diaryContextTestState.result) return '';
  const result = diaryContextTestState.result;
  const worldInfo = result.diagnostics?.worldInfo || {};
  return `
    <div class="slx-diary-context-result">
      <div class="slx-detail-kicker">测试上下文</div>
      <div class="slx-diary-stat-grid">
        <span><b>${escapeHtml(result.materialLength)}</b><small>材料字数</small></span>
        <span><b>${escapeHtml(result.recentMessageCount)}</b><small>最近楼层</small></span>
        <span><b>${escapeHtml(result.memoryCount)}</b><small>memory</small></span>
        <span><b>${escapeHtml(result.emotionProfileCount)}</b><small>情感档案</small></span>
      </div>
      <div class="slx-info-line"><span>世界书来源</span><b>${escapeHtml(worldInfo.source || '未记录')}</b></div>
      <div class="slx-info-line"><span>世界书可用条目</span><b>${escapeHtml(worldInfo.usedCount ?? 0)}</b></div>
      <div class="slx-info-line"><span>世界书注入文本</span><b>${escapeHtml(worldInfo.injectionTextLength ?? 0)}</b></div>
    </div>
  `;
}

function renderDiaryEmpty() {
  return `
    <div class="slx-diary-empty">
      <b>这段聊天还没有日记</b>
      <p>第一版日记跟随当前聊天保存，删除聊天时会一起消失。</p>
    </div>
  `;
}

function renderDiaryEntry(entry) {
  const title = entry.title || `${entry.authorName || '未命名角色'}的日记`;
  const author = entry.authorName || '未填写视角';
  const preview = entry.content || '暂无内容';
  return `
    <article class="slx-diary-entry" data-slx-diary-entry="${escapeHtml(entry.id)}">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">${escapeHtml(title)}</div>
          <p>${escapeHtml(author)} · ${escapeHtml(entry.updatedAt || entry.createdAt || '未记录')}</p>
        </div>
        <div class="slx-card-actions">
          <button class="slx-mini-action-btn" type="button" data-slx-edit-diary="${escapeHtml(entry.id)}" title="编辑日记"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="slx-mini-action-btn" type="button" data-slx-delete-diary="${escapeHtml(entry.id)}" title="删除日记"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <p class="slx-diary-preview">${escapeHtml(preview)}</p>
    </article>
  `;
}

function renderDiaryEditor(chatState) {
  if (!diaryEditorState.open) return '';
  const entry = getDiaryEntries(chatState).find(item => item.id === diaryEditorState.entryId);
  if (!entry) return '';

  return `
    <div class="slx-rule-modal" data-slx-close-diary-editor>
      <div class="slx-rule-modal-card slx-diary-editor-card" data-slx-diary-editor-card>
        <div class="slx-summary-card-head">
          <div>
            <div class="slx-detail-title">编辑日记</div>
            <p>${escapeHtml(entry.createdAt || '未记录创建时间')}</p>
          </div>
          <button class="slx-mini-action-btn" type="button" data-slx-close-diary-editor title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="slx-form-grid">
          <label class="slx-field">
            <span>日记作者</span>
            <input type="text" data-slx-diary-edit-author value="${escapeHtml(entry.authorName)}" />
          </label>
          <label class="slx-field">
            <span>标题</span>
            <input type="text" data-slx-diary-edit-title value="${escapeHtml(entry.title)}" />
          </label>
          <label class="slx-field slx-field-wide">
            <span>正文</span>
            <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-content>${escapeHtml(entry.content)}</textarea>
          </label>
        </div>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-diary-edit>
          <i class="fa-solid fa-floppy-disk"></i><span>保存修改</span>
        </button>
      </div>
    </div>
  `;
}

export function renderDiaryPanel(settings, chatState) {
  const entries = getDiaryEntries(chatState).slice().reverse();
  return `
    <div class="slx-detail-card slx-diary-shell-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">聊天内日记本</div>
          <p>当前聊天保存 ${escapeHtml(entries.length)} 篇日记。</p>
        </div>
        <button class="slx-soft-btn" type="button" data-slx-export-diary ${entries.length ? '' : 'disabled'}>导出</button>
      </div>
      <div class="slx-form-grid">
        <label class="slx-field">
          <span>日记作者</span>
          <input type="text" data-slx-diary-author placeholder="例如：花京院典明" />
        </label>
        <label class="slx-field">
          <span>标题</span>
          <input type="text" data-slx-diary-title placeholder="未填写时自动使用作者名" />
        </label>
        <label class="slx-field slx-field-wide">
          <span>正文</span>
          <textarea class="slx-diary-new-textarea" data-slx-diary-content placeholder="先手动写一篇日记，后续这里会接入生成结果。"></textarea>
        </label>
      </div>
      <div class="slx-action-row">
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-add-diary>新增日记</button>
        <button class="slx-soft-btn" type="button" data-slx-test-diary-context ${diaryContextTestState.status === 'running' ? 'disabled' : ''}>测试日记上下文</button>
      </div>
      <div class="slx-field-hint">${escapeHtml(getContextTestStatusText())}</div>
      ${renderContextTestResult()}
    </div>
    <div class="slx-diary-list">
      ${entries.length ? entries.map(renderDiaryEntry).join('') : renderDiaryEmpty()}
    </div>
    ${renderDiaryEditor(chatState)}
  `;
}

function addDiaryEntry(panelRoot) {
  const authorName = String(panelRoot.querySelector('[data-slx-diary-author]')?.value || '').trim();
  const title = String(panelRoot.querySelector('[data-slx-diary-title]')?.value || '').trim();
  const content = String(panelRoot.querySelector('[data-slx-diary-content]')?.value || '').trim();
  if (!content) {
    return;
  }

  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const now = formatTimestamp();
  store.entries.push(normalizeDiaryEntry({
    authorName,
    title: title || (authorName ? `${authorName}的日记` : '未命名日记'),
    content,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  }));
  store.lastSavedAt = now;
  saveChatState();
  refreshPanel();
}

function saveDiaryEdit(panelRoot) {
  const entryId = diaryEditorState.entryId;
  if (!entryId) return;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entry = store.entries.find(item => item.id === entryId);
  if (!entry) return;

  entry.authorName = String(panelRoot.querySelector('[data-slx-diary-edit-author]')?.value || '').trim();
  entry.title = String(panelRoot.querySelector('[data-slx-diary-edit-title]')?.value || '').trim();
  entry.content = String(panelRoot.querySelector('[data-slx-diary-edit-content]')?.value || '').trim();
  entry.updatedAt = formatTimestamp();
  store.lastSavedAt = entry.updatedAt;
  saveChatState();
  closeDiaryEditor();
  refreshPanel();
}

function deleteDiaryEntry(entryId) {
  if (!confirm('删除这篇日记？')) return;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  store.entries = store.entries.filter(entry => entry.id !== entryId);
  store.lastSavedAt = formatTimestamp();
  saveChatState();
  refreshPanel();
}

function exportDiaryBook() {
  const chatState = getChatState();
  const entries = getDiaryEntries(chatState);
  if (!entries.length) return;

  const payload = {
    exportedAt: new Date().toISOString(),
    identity: chatState.identity,
    entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const chatName = String(chatState.identity?.chatName || 'shenling-diary').replace(/[\\/:*?"<>|]+/g, '_');
  anchor.href = url;
  anchor.download = `${chatName}-diary.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function testDiaryContext(panelRoot) {
  const targetRoleName = String(panelRoot.querySelector('[data-slx-diary-author]')?.value || '').trim();
  diaryContextTestState = {
    status: 'running',
    result: null,
    error: '',
  };
  refreshPanel();

  try {
    const context = await resolveDiaryContext({ targetRoleName });
    diaryContextTestState = {
      status: 'success',
      result: {
        materialLength: context.material.length,
        recentMessageCount: context.diagnostics?.recentMessageCount ?? 0,
        memoryCount: context.diagnostics?.memoryCount ?? 0,
        grandMemoryCount: context.diagnostics?.grandMemoryCount ?? 0,
        emotionProfileCount: context.diagnostics?.emotionProfileCount ?? 0,
        diagnostics: context.diagnostics,
      },
      error: '',
    };
  } catch (error) {
    diaryContextTestState = {
      status: 'failed',
      result: null,
      error: error.message || String(error),
    };
  }
  refreshPanel();
}

export function bindDiaryPanelEvents(panelRoot) {
  panelRoot.querySelector('[data-slx-add-diary]')?.addEventListener('click', () => {
    addDiaryEntry(panelRoot);
  });

  panelRoot.querySelector('[data-slx-export-diary]')?.addEventListener('click', exportDiaryBook);

  panelRoot.querySelector('[data-slx-test-diary-context]')?.addEventListener('click', () => {
    void testDiaryContext(panelRoot);
  });

  panelRoot.querySelectorAll('[data-slx-edit-diary]').forEach(button => {
    button.addEventListener('click', () => {
      openDiaryEditor(button.dataset.slxEditDiary);
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-delete-diary]').forEach(button => {
    button.addEventListener('click', () => {
      deleteDiaryEntry(button.dataset.slxDeleteDiary);
    });
  });

  panelRoot.querySelectorAll('[data-slx-close-diary-editor]').forEach(node => {
    node.addEventListener('click', event => {
      if (event.target.closest?.('[data-slx-diary-editor-card]') && !event.target.closest?.('[data-slx-close-diary-editor]')) {
        return;
      }
      closeDiaryEditor();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-save-diary-edit]')?.addEventListener('click', () => {
    saveDiaryEdit(panelRoot);
  });
}
