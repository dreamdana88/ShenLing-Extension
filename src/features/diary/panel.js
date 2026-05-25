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

const DIARY_VIEWS = [
  { id: 'role', label: '角色日记' },
  { id: 'exchange', label: '交换日记' },
  { id: 'drafts', label: '草稿' },
  { id: 'library', label: '日记本' },
];

let panelOptions = {
  refreshPanel: null,
};

let diaryPanelState = {
  view: 'role',
  roleName: '',
  exchangeRoleName: '',
};

let diaryEditorState = {
  open: false,
  entryId: '',
};

let diaryReaderState = {
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
  const hasExchangeShape = isPlainObject(entry.userDiary)
    || isPlainObject(entry.characterReply)
    || String(entry.userContent || '').trim();
  const type = entry.type === 'exchange_diary' || hasExchangeShape ? 'exchange_diary' : 'role_diary';
  const status = entry.status === 'draft' ? 'draft' : 'collected';
  const now = formatTimestamp();

  return {
    id: String(entry.id || createDiaryId()),
    type,
    status,
    authorName: String(entry.authorName || entry.roleName || entry.characterName || '').trim(),
    targetRoleName: String(entry.targetRoleName || entry.authorName || entry.roleName || '').trim(),
    title: String(entry.title || '').trim(),
    time: String(entry.time || '').trim(),
    content: String(entry.content || '').trim(),
    userContent: String(entry.userContent || entry.userDiary?.content || '').trim(),
    characterReply: isPlainObject(entry.characterReply)
      ? {
        title: String(entry.characterReply.title || '').trim(),
        time: String(entry.characterReply.time || '').trim(),
        content: String(entry.characterReply.content || '').trim(),
      }
      : null,
    source: String(entry.source || 'manual'),
    createdAt: String(entry.createdAt || now),
    updatedAt: String(entry.updatedAt || entry.createdAt || now),
    contextDigest: isPlainObject(entry.contextDigest) ? entry.contextDigest : null,
  };
}

function getDiaryEntries(chatState) {
  const store = getDiaryStore(chatState);
  store.entries = store.entries.map(normalizeDiaryEntry);
  return store.entries;
}

function getEntryTitle(entry) {
  if (entry.type === 'exchange_diary') {
    return entry.characterReply?.title || entry.title || '未命名交换日记';
  }
  return entry.title || '待生成标题';
}

function getEntryRoleName(entry) {
  return entry.type === 'exchange_diary'
    ? entry.targetRoleName || entry.authorName || '未填写回应角色'
    : entry.authorName || entry.targetRoleName || '未填写视角';
}

function getEntryTime(entry) {
  return entry.time || entry.characterReply?.time || entry.updatedAt || entry.createdAt || '未记录';
}

function getEntryPreview(entry) {
  if (entry.type === 'exchange_diary') {
    return entry.characterReply?.content || entry.userContent || '等待角色回信';
  }
  return entry.content || '等待生成正文';
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

function renderDiaryViewTabs() {
  return `
    <div class="slx-segment-row slx-diary-tabs" role="group" aria-label="日记模块视图">
      ${DIARY_VIEWS.map(view => `
        <button class="slx-segment-btn ${diaryPanelState.view === view.id ? 'slx-segment-btn-active' : ''}" type="button" data-slx-diary-view="${escapeHtml(view.id)}">
          ${escapeHtml(view.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderRoleDiaryComposer() {
  return `
    <div class="slx-detail-card slx-diary-shell-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">角色日记草稿</div>
          <p>选择日记视角，后续由 AI 生成标题、时间和正文。</p>
        </div>
      </div>
      <label class="slx-field slx-field-wide">
        <span>日记作者 / 目标视角</span>
        <input type="text" data-slx-diary-role-name value="${escapeHtml(diaryPanelState.roleName)}" placeholder="例如：角色名" />
      </label>
      <div class="slx-action-row">
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-create-role-diary-draft>创建角色日记草稿</button>
        <button class="slx-soft-btn" type="button" data-slx-test-diary-context ${diaryContextTestState.status === 'running' ? 'disabled' : ''}>测试日记上下文</button>
      </div>
      <div class="slx-field-hint">${escapeHtml(getContextTestStatusText())}</div>
      ${renderContextTestResult()}
    </div>
  `;
}

function renderExchangeDiaryComposer() {
  return `
    <div class="slx-detail-card slx-diary-shell-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">交换日记草稿</div>
          <p>先保存你的日记，角色回信生成会在下一步接入。</p>
        </div>
      </div>
      <label class="slx-field slx-field-wide">
        <span>回应角色</span>
        <input type="text" data-slx-diary-exchange-role value="${escapeHtml(diaryPanelState.exchangeRoleName)}" placeholder="例如：角色名" />
      </label>
      <label class="slx-field slx-field-wide">
        <span>你的日记</span>
        <textarea class="slx-diary-new-textarea" data-slx-diary-user-content placeholder="写下想交给角色阅读的日记。"></textarea>
      </label>
      <div class="slx-action-row">
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-create-exchange-diary-draft>保存交换日记草稿</button>
        <button class="slx-soft-btn" type="button" data-slx-test-exchange-context ${diaryContextTestState.status === 'running' ? 'disabled' : ''}>测试回应上下文</button>
      </div>
      <div class="slx-field-hint">${escapeHtml(getContextTestStatusText())}</div>
      ${renderContextTestResult()}
    </div>
  `;
}

function renderDiaryEmpty(kind = '日记') {
  return `
    <div class="slx-diary-empty">
      <b>暂无${escapeHtml(kind)}</b>
      <p>日记只保存在当前聊天 metadata，删除聊天时会一起消失。</p>
    </div>
  `;
}

function renderDiaryEntry(entry) {
  const typeLabel = entry.type === 'exchange_diary' ? '交换日记' : '角色日记';
  const statusLabel = entry.status === 'draft' ? '草稿' : '已收录';
  return `
    <article class="slx-diary-entry" data-slx-diary-entry="${escapeHtml(entry.id)}">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">${escapeHtml(getEntryTitle(entry))}</div>
          <p>${escapeHtml(typeLabel)} · ${escapeHtml(statusLabel)} · ${escapeHtml(getEntryRoleName(entry))}</p>
        </div>
        <div class="slx-card-actions">
          <button class="slx-mini-action-btn" type="button" data-slx-read-diary="${escapeHtml(entry.id)}" title="阅读"><i class="fa-solid fa-book-open"></i></button>
          ${entry.status === 'draft' ? `<button class="slx-mini-action-btn" type="button" data-slx-collect-diary="${escapeHtml(entry.id)}" title="收录"><i class="fa-solid fa-check"></i></button>` : ''}
          <button class="slx-mini-action-btn" type="button" data-slx-edit-diary="${escapeHtml(entry.id)}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="slx-mini-action-btn" type="button" data-slx-delete-diary="${escapeHtml(entry.id)}" title="删除"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div class="slx-diary-meta-row">
        <span>${escapeHtml(getEntryTime(entry))}</span>
        <span>${escapeHtml(entry.source === 'generated' ? 'AI 生成' : '手动草稿')}</span>
      </div>
      <p class="slx-diary-preview">${escapeHtml(getEntryPreview(entry))}</p>
    </article>
  `;
}

function renderDiaryList(entries, { status = '', title = '日记本' } = {}) {
  const filtered = entries
    .filter(entry => !status || entry.status === status)
    .slice()
    .reverse();
  return `
    <div class="slx-diary-list-block">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">${escapeHtml(title)}</div>
          <p>${escapeHtml(filtered.length)} 条记录</p>
        </div>
      </div>
      <div class="slx-diary-list">
        ${filtered.length ? filtered.map(renderDiaryEntry).join('') : renderDiaryEmpty(title)}
      </div>
    </div>
  `;
}

function renderDiaryReader(chatState) {
  if (!diaryReaderState.open) return '';
  const entry = getDiaryEntries(chatState).find(item => item.id === diaryReaderState.entryId);
  if (!entry) return '';

  const isExchange = entry.type === 'exchange_diary';
  const leftTitle = isExchange ? '你的日记' : getEntryTitle(entry);
  const leftText = isExchange ? entry.userContent : entry.content || '正文将在生成后写入这里。';
  const rightTitle = isExchange ? (entry.characterReply?.title || '角色回信') : '日记信息';
  const rightText = isExchange
    ? entry.characterReply?.content || '角色回信将在生成后写入这里。'
    : [
      `作者：${getEntryRoleName(entry)}`,
      `时间：${getEntryTime(entry)}`,
      `状态：${entry.status === 'draft' ? '草稿' : '已收录'}`,
      `来源：${entry.source === 'generated' ? 'AI 生成' : '手动草稿'}`,
    ].join('\n');

  return `
    <div class="slx-diary-reader-modal" data-slx-close-diary-reader>
      <div class="slx-diary-reader-stage" data-slx-diary-reader-card>
        <div class="slx-diary-reader-toolbar">
          <div>
            <b>${escapeHtml(getEntryTitle(entry))}</b>
            <span>${escapeHtml(getEntryRoleName(entry))} · ${escapeHtml(getEntryTime(entry))}</span>
          </div>
          <button class="slx-icon-btn" type="button" data-slx-close-diary-reader title="关闭">×</button>
        </div>
        <div class="slx-diary-book-spread">
          <section class="slx-diary-book-page">
            <div class="slx-diary-book-page-title">${escapeHtml(leftTitle)}</div>
            <div class="slx-diary-book-rule"></div>
            <p>${escapeHtml(leftText)}</p>
            <div class="slx-diary-book-page-num">1</div>
          </section>
          <section class="slx-diary-book-page slx-diary-book-page-right">
            <div class="slx-diary-book-page-title">${escapeHtml(rightTitle)}</div>
            <div class="slx-diary-book-rule"></div>
            <p>${escapeHtml(rightText)}</p>
            <div class="slx-diary-book-page-num">2</div>
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderDiaryEditor(chatState) {
  if (!diaryEditorState.open) return '';
  const entry = getDiaryEntries(chatState).find(item => item.id === diaryEditorState.entryId);
  if (!entry) return '';
  const isExchange = entry.type === 'exchange_diary';

  return `
    <div class="slx-rule-modal" data-slx-close-diary-editor>
      <div class="slx-rule-modal-card slx-diary-editor-card" data-slx-diary-editor-card>
        <div class="slx-summary-card-head">
          <div>
            <div class="slx-detail-title">编辑${isExchange ? '交换日记' : '角色日记'}</div>
            <p>${escapeHtml(entry.createdAt || '未记录创建时间')}</p>
          </div>
          <button class="slx-mini-action-btn" type="button" data-slx-close-diary-editor title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="slx-form-grid">
          <label class="slx-field">
            <span>${isExchange ? '回应角色' : '日记作者'}</span>
            <input type="text" data-slx-diary-edit-role value="${escapeHtml(getEntryRoleName(entry))}" />
          </label>
          <label class="slx-field">
            <span>标题</span>
            <input type="text" data-slx-diary-edit-title value="${escapeHtml(getEntryTitle(entry) === '待生成标题' ? '' : getEntryTitle(entry))}" />
          </label>
          <label class="slx-field">
            <span>时间</span>
            <input type="text" data-slx-diary-edit-time value="${escapeHtml(entry.time || entry.characterReply?.time || '')}" />
          </label>
          <label class="slx-field">
            <span>状态</span>
            <select data-slx-diary-edit-status>
              <option value="draft" ${entry.status === 'draft' ? 'selected' : ''}>草稿</option>
              <option value="collected" ${entry.status === 'collected' ? 'selected' : ''}>已收录</option>
            </select>
          </label>
          ${isExchange ? `
            <label class="slx-field slx-field-wide">
              <span>你的日记</span>
              <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-user-content>${escapeHtml(entry.userContent)}</textarea>
            </label>
            <label class="slx-field slx-field-wide">
              <span>角色回信</span>
              <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-content>${escapeHtml(entry.characterReply?.content || '')}</textarea>
            </label>
          ` : `
            <label class="slx-field slx-field-wide">
              <span>正文</span>
              <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-content>${escapeHtml(entry.content)}</textarea>
            </label>
          `}
        </div>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-diary-edit>
          <i class="fa-solid fa-floppy-disk"></i><span>保存修改</span>
        </button>
      </div>
    </div>
  `;
}

export function renderDiaryPanel(settings, chatState) {
  const entries = getDiaryEntries(chatState);
  const draftCount = entries.filter(entry => entry.status === 'draft').length;
  const collectedCount = entries.filter(entry => entry.status === 'collected').length;

  return `
    <div class="slx-detail-card slx-diary-home-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">聊天内日记本</div>
          <p>${escapeHtml(collectedCount)} 篇已收录，${escapeHtml(draftCount)} 篇草稿。</p>
        </div>
        <button class="slx-soft-btn" type="button" data-slx-export-diary ${entries.length ? '' : 'disabled'}>导出</button>
      </div>
      ${renderDiaryViewTabs()}
    </div>
    ${diaryPanelState.view === 'role' ? renderRoleDiaryComposer() : ''}
    ${diaryPanelState.view === 'exchange' ? renderExchangeDiaryComposer() : ''}
    ${diaryPanelState.view === 'drafts' ? renderDiaryList(entries, { status: 'draft', title: '草稿箱' }) : ''}
    ${diaryPanelState.view === 'library' ? renderDiaryList(entries, { status: 'collected', title: '已收录日记' }) : ''}
    ${diaryPanelState.view === 'role' || diaryPanelState.view === 'exchange'
      ? renderDiaryList(entries, { status: 'draft', title: '最近草稿' })
      : ''}
    ${renderDiaryReader(chatState)}
    ${renderDiaryEditor(chatState)}
  `;
}

function saveEntry(entryInput) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entry = normalizeDiaryEntry(entryInput);
  store.entries.push(entry);
  store.lastSavedAt = entry.updatedAt;
  saveChatState();
}

function createRoleDiaryDraft(panelRoot) {
  const authorName = String(panelRoot.querySelector('[data-slx-diary-role-name]')?.value || '').trim();
  diaryPanelState.roleName = authorName;
  const now = formatTimestamp();
  saveEntry({
    type: 'role_diary',
    status: 'draft',
    authorName,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  });
  diaryPanelState.view = 'drafts';
  refreshPanel();
}

function createExchangeDiaryDraft(panelRoot) {
  const targetRoleName = String(panelRoot.querySelector('[data-slx-diary-exchange-role]')?.value || '').trim();
  const userContent = String(panelRoot.querySelector('[data-slx-diary-user-content]')?.value || '').trim();
  if (!userContent) return;
  diaryPanelState.exchangeRoleName = targetRoleName;
  const now = formatTimestamp();
  saveEntry({
    type: 'exchange_diary',
    status: 'draft',
    targetRoleName,
    userContent,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  });
  diaryPanelState.view = 'drafts';
  refreshPanel();
}

function updateDiaryEntry(entryId, updater) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const index = store.entries.findIndex(entry => entry.id === entryId);
  if (index < 0) return null;
  const entry = normalizeDiaryEntry(store.entries[index]);
  updater(entry);
  entry.updatedAt = formatTimestamp();
  store.entries[index] = entry;
  store.lastSavedAt = entry.updatedAt;
  saveChatState();
  return entry;
}

function saveDiaryEdit(panelRoot) {
  const entryId = diaryEditorState.entryId;
  if (!entryId) return;
  updateDiaryEntry(entryId, entry => {
    const roleName = String(panelRoot.querySelector('[data-slx-diary-edit-role]')?.value || '').trim();
    const title = String(panelRoot.querySelector('[data-slx-diary-edit-title]')?.value || '').trim();
    const time = String(panelRoot.querySelector('[data-slx-diary-edit-time]')?.value || '').trim();
    const status = panelRoot.querySelector('[data-slx-diary-edit-status]')?.value === 'draft' ? 'draft' : 'collected';
    const content = String(panelRoot.querySelector('[data-slx-diary-edit-content]')?.value || '').trim();

    entry.status = status;
    entry.title = title;
    entry.time = time;
    if (entry.type === 'exchange_diary') {
      entry.targetRoleName = roleName;
      entry.userContent = String(panelRoot.querySelector('[data-slx-diary-edit-user-content]')?.value || '').trim();
      entry.characterReply = {
        ...(entry.characterReply || {}),
        title,
        time,
        content,
      };
    } else {
      entry.authorName = roleName;
      entry.content = content;
    }
  });
  diaryEditorState.open = false;
  diaryPanelState.view = 'drafts';
  refreshPanel();
}

function collectDiaryEntry(entryId) {
  updateDiaryEntry(entryId, entry => {
    entry.status = 'collected';
  });
  diaryPanelState.view = 'library';
  refreshPanel();
}

function deleteDiaryEntry(entryId) {
  if (!confirm('删除这条日记记录？')) return;
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

async function testDiaryContext(panelRoot, selector) {
  const targetRoleName = String(panelRoot.querySelector(selector)?.value || '').trim();
  if (selector === '[data-slx-diary-role-name]') diaryPanelState.roleName = targetRoleName;
  if (selector === '[data-slx-diary-exchange-role]') diaryPanelState.exchangeRoleName = targetRoleName;

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
  panelRoot.querySelectorAll('[data-slx-diary-view]').forEach(button => {
    button.addEventListener('click', () => {
      diaryPanelState.view = button.dataset.slxDiaryView || 'role';
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-create-role-diary-draft]')?.addEventListener('click', () => {
    createRoleDiaryDraft(panelRoot);
  });

  panelRoot.querySelector('[data-slx-create-exchange-diary-draft]')?.addEventListener('click', () => {
    createExchangeDiaryDraft(panelRoot);
  });

  panelRoot.querySelector('[data-slx-test-diary-context]')?.addEventListener('click', () => {
    void testDiaryContext(panelRoot, '[data-slx-diary-role-name]');
  });

  panelRoot.querySelector('[data-slx-test-exchange-context]')?.addEventListener('click', () => {
    void testDiaryContext(panelRoot, '[data-slx-diary-exchange-role]');
  });

  panelRoot.querySelector('[data-slx-export-diary]')?.addEventListener('click', exportDiaryBook);

  panelRoot.querySelectorAll('[data-slx-read-diary]').forEach(button => {
    button.addEventListener('click', () => {
      diaryReaderState = { open: true, entryId: button.dataset.slxReadDiary || '' };
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-edit-diary]').forEach(button => {
    button.addEventListener('click', () => {
      diaryEditorState = { open: true, entryId: button.dataset.slxEditDiary || '' };
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-collect-diary]').forEach(button => {
    button.addEventListener('click', () => {
      collectDiaryEntry(button.dataset.slxCollectDiary);
    });
  });

  panelRoot.querySelectorAll('[data-slx-delete-diary]').forEach(button => {
    button.addEventListener('click', () => {
      deleteDiaryEntry(button.dataset.slxDeleteDiary);
    });
  });

  panelRoot.querySelectorAll('[data-slx-close-diary-reader]').forEach(node => {
    node.addEventListener('click', event => {
      if (event.target.closest?.('[data-slx-diary-reader-card]') && !event.target.closest?.('[data-slx-close-diary-reader]')) {
        return;
      }
      diaryReaderState = { open: false, entryId: '' };
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-close-diary-editor]').forEach(node => {
    node.addEventListener('click', event => {
      if (event.target.closest?.('[data-slx-diary-editor-card]') && !event.target.closest?.('[data-slx-close-diary-editor]')) {
        return;
      }
      diaryEditorState = { open: false, entryId: '' };
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-save-diary-edit]')?.addEventListener('click', () => {
    saveDiaryEdit(panelRoot);
  });
}
