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

const DIARY_TABS = [
  { id: 'notebooks', label: '日记本', icon: 'fa-book-open' },
  { id: 'settings', label: '日记设置', icon: 'fa-sliders' },
];

const DEFAULT_COVERS = [
  { id: 'linen', label: '布面旧册' },
  { id: 'red', label: '酒红硬封' },
  { id: 'green', label: '墨绿手账' },
];

const DEFAULT_PAGES = [
  { id: 'warm', label: '暖黄纸页' },
  { id: 'plain', label: '素白纸页' },
  { id: 'lined', label: '横线手账' },
];

let panelOptions = {
  refreshPanel: null,
};

let diaryPanelState = {
  tab: 'notebooks',
  screen: 'library',
  roleName: '',
  entryId: '',
  composeRoleName: '',
  composeDate: '',
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

function createDiaryId() {
  return `diary-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeDiarySettings(settings = {}) {
  return {
    apiMode: settings.apiMode === 'secondary' ? 'secondary' : 'main',
    userTextColor: String(settings.userTextColor || '#8b4b43').trim(),
    characterTextColor: String(settings.characterTextColor || '#4f3926').trim(),
    coverPreset: DEFAULT_COVERS.some(item => item.id === settings.coverPreset) ? settings.coverPreset : 'linen',
    pagePreset: DEFAULT_PAGES.some(item => item.id === settings.pagePreset) ? settings.pagePreset : 'warm',
    customCover: String(settings.customCover || '').trim(),
    customPage: String(settings.customPage || '').trim(),
  };
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
  chatState.diary.settings = normalizeDiarySettings(chatState.diary.settings);
  return chatState.diary;
}

function normalizeRoleName(value) {
  return String(value || '').trim();
}

function normalizeDiaryEntry(entry = {}) {
  const hasExchangeShape = isPlainObject(entry.userDiary)
    || isPlainObject(entry.characterReply)
    || String(entry.userContent || '').trim();
  const type = entry.type === 'exchange_diary' || hasExchangeShape ? 'exchange_diary' : 'role_diary';
  const status = entry.status === 'draft' ? 'draft' : 'collected';
  const now = formatTimestamp();
  const roleName = normalizeRoleName(entry.roleName || entry.targetRoleName || entry.authorName || entry.characterName);

  return {
    id: String(entry.id || createDiaryId()),
    type,
    status,
    roleName,
    authorName: normalizeRoleName(entry.authorName || roleName),
    targetRoleName: normalizeRoleName(entry.targetRoleName || roleName),
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

function getEntryRoleName(entry) {
  return normalizeRoleName(entry.roleName || entry.targetRoleName || entry.authorName) || '未填写角色';
}

function getEntryTitle(entry) {
  if (entry.type === 'exchange_diary') {
    return entry.characterReply?.title || entry.title || '等待角色回信';
  }
  return entry.title || '待生成标题';
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

function getDefaultDiaryDate(chatState) {
  const store = getDiaryStore(chatState);
  return store.lastComposeDate
    || chatState.summary?.currentStoryDate
    || chatState.identity?.storyDate
    || formatTimestamp();
}

function getRoleEntries(entries, roleName) {
  const cleanRoleName = normalizeRoleName(roleName);
  return entries
    .filter(entry => getEntryRoleName(entry) === cleanRoleName)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function getNotebooks(chatState) {
  const store = getDiaryStore(chatState);
  const entries = getDiaryEntries(chatState);
  const roles = new Map();

  store.books.forEach(book => {
    const roleName = normalizeRoleName(book.roleName || book.name);
    if (!roleName) return;
    roles.set(roleName, {
      roleName,
      createdAt: String(book.createdAt || ''),
      updatedAt: String(book.updatedAt || ''),
      entryCount: 0,
      latestEntry: null,
    });
  });

  entries.forEach(entry => {
    const roleName = getEntryRoleName(entry);
    if (!roles.has(roleName)) {
      roles.set(roleName, {
        roleName,
        createdAt: entry.createdAt || '',
        updatedAt: entry.updatedAt || '',
        entryCount: 0,
        latestEntry: null,
      });
    }
    const book = roles.get(roleName);
    book.entryCount += 1;
    if (!book.latestEntry || String(entry.createdAt || '') > String(book.latestEntry.createdAt || '')) {
      book.latestEntry = entry;
      book.updatedAt = entry.updatedAt || entry.createdAt || book.updatedAt;
    }
  });

  return [...roles.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function ensureNotebook(roleName) {
  const cleanRoleName = normalizeRoleName(roleName);
  if (!cleanRoleName) return null;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const existing = store.books.find(book => normalizeRoleName(book.roleName || book.name) === cleanRoleName);
  const now = formatTimestamp();
  if (existing) {
    existing.roleName = cleanRoleName;
    existing.updatedAt = now;
  } else {
    store.books.push({
      id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      roleName: cleanRoleName,
      createdAt: now,
      updatedAt: now,
    });
  }
  store.lastSavedAt = now;
  saveChatState();
  return cleanRoleName;
}

function setDiaryScreen(screen, patch = {}) {
  diaryPanelState = {
    ...diaryPanelState,
    screen,
    ...patch,
  };
  refreshPanel();
}

function renderDiaryTabs() {
  return `
    <div class="slx-segment-row slx-diary-tabs" role="group" aria-label="日记模块视图">
      ${DIARY_TABS.map(tab => `
        <button class="slx-segment-btn ${diaryPanelState.tab === tab.id ? 'slx-segment-btn-active' : ''}" type="button" data-slx-diary-tab="${escapeHtml(tab.id)}">
          <i class="fa-solid ${escapeHtml(tab.icon)}"></i><span>${escapeHtml(tab.label)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function renderDiaryEmpty(title = '日记') {
  return `
    <div class="slx-diary-empty">
      <b>暂无${escapeHtml(title)}</b>
      <p>日记只保存在当前聊天 metadata，删除聊天时会一起消失。</p>
    </div>
  `;
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

function getContextTestStatusText() {
  if (diaryContextTestState.status === 'running') return '正在整理日记上下文';
  if (diaryContextTestState.status === 'failed') return diaryContextTestState.error || '上下文测试失败';
  if (diaryContextTestState.status === 'success') {
    const worldInfo = diaryContextTestState.result?.diagnostics?.worldInfo || {};
    return `材料 ${diaryContextTestState.result?.materialLength || 0} 字 · 世界书 ${worldInfo.source || '未记录'}`;
  }
  return '可先验证这本日记生成前会拿到哪些上下文';
}

function renderDiaryLibrary(chatState) {
  const notebooks = getNotebooks(chatState);
  const totalEntries = getDiaryEntries(chatState).length;
  return `
    <div class="slx-detail-card slx-diary-shell-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">角色日记本</div>
          <p>${escapeHtml(notebooks.length)} 本日记，${escapeHtml(totalEntries)} 篇记录。</p>
        </div>
        <button class="slx-soft-btn" type="button" data-slx-export-diary ${totalEntries ? '' : 'disabled'}>导出</button>
      </div>
      <div class="slx-diary-create-row">
        <label class="slx-field">
          <span>创建角色日记</span>
          <input type="text" data-slx-diary-new-book-role value="${escapeHtml(diaryPanelState.composeRoleName)}" placeholder="输入角色名称" />
        </label>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-create-diary-book>
          <i class="fa-solid fa-book-medical"></i><span>创建并打开</span>
        </button>
      </div>
    </div>
    <div class="slx-diary-book-list">
      ${notebooks.length ? notebooks.map(book => `
        <button class="slx-diary-notebook-card" type="button" data-slx-open-diary-book="${escapeHtml(book.roleName)}">
          <span class="slx-diary-book-cover-mark"></span>
          <span>
            <b>${escapeHtml(book.roleName)}</b>
            <small>${escapeHtml(book.entryCount)} 篇日记${book.latestEntry ? ` · 最新：${escapeHtml(getEntryTitle(book.latestEntry))}` : ''}</small>
          </span>
          <span class="slx-diary-open-label">打开</span>
        </button>
      `).join('') : renderDiaryEmpty('角色日记本')}
    </div>
  `;
}

function renderDiarySettings(chatState) {
  const store = getDiaryStore(chatState);
  const settings = store.settings;
  return `
    <div class="slx-detail-card slx-diary-shell-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">日记设置</div>
          <p>这些设置后续会影响日记生成和日记本外观。</p>
        </div>
      </div>
      <div class="slx-diary-setting-line">
        <span>生成 API</span>
        <div class="slx-diary-pill-toggle" role="group" aria-label="日记生成 API">
          <button class="${settings.apiMode === 'main' ? 'is-active' : ''}" type="button" data-slx-diary-api-mode="main">主 API</button>
          <button class="${settings.apiMode === 'secondary' ? 'is-active' : ''}" type="button" data-slx-diary-api-mode="secondary">副 API</button>
        </div>
      </div>
      <div class="slx-form-grid">
        <label class="slx-field">
          <span>U 字体颜色</span>
          <input type="color" data-slx-diary-user-color value="${escapeHtml(settings.userTextColor)}" />
        </label>
        <label class="slx-field">
          <span>C 字体颜色</span>
          <input type="color" data-slx-diary-character-color value="${escapeHtml(settings.characterTextColor)}" />
        </label>
        <label class="slx-field">
          <span>日记封面</span>
          <select data-slx-diary-cover-preset>
            ${DEFAULT_COVERS.map(item => `<option value="${escapeHtml(item.id)}" ${settings.coverPreset === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          </select>
        </label>
        <label class="slx-field">
          <span>日记内页</span>
          <select data-slx-diary-page-preset>
            ${DEFAULT_PAGES.map(item => `<option value="${escapeHtml(item.id)}" ${settings.pagePreset === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          </select>
        </label>
        <label class="slx-field slx-field-wide">
          <span>封面图片地址</span>
          <input type="text" data-slx-diary-custom-cover value="${escapeHtml(settings.customCover)}" placeholder="后续可接上传，这里先预留图片地址" />
        </label>
        <label class="slx-field slx-field-wide">
          <span>内页图片地址</span>
          <input type="text" data-slx-diary-custom-page value="${escapeHtml(settings.customPage)}" placeholder="后续可接上传，这里先预留图片地址" />
        </label>
      </div>
    </div>
  `;
}

function renderDiaryCover(chatState) {
  const roleName = diaryPanelState.roleName;
  const entries = getRoleEntries(getDiaryEntries(chatState), roleName);
  return `
    <div class="slx-diary-nav-row">
      <button class="slx-soft-btn" type="button" data-slx-diary-back-library><i class="fa-solid fa-arrow-left"></i><span>返回书架</span></button>
    </div>
    <button class="slx-diary-cover" type="button" data-slx-open-diary-toc>
      <span class="slx-diary-cover-label">SHENLING DIARY</span>
      <b>${escapeHtml(roleName || '未命名角色')}</b>
      <small>${escapeHtml(entries.length)} 篇记录 · 点击翻开目录</small>
    </button>
  `;
}

function renderDiaryToc(chatState) {
  const roleName = diaryPanelState.roleName;
  const entries = getRoleEntries(getDiaryEntries(chatState), roleName);
  return `
    <div class="slx-diary-nav-row">
      <button class="slx-soft-btn" type="button" data-slx-diary-back-cover><i class="fa-solid fa-arrow-left"></i><span>返回封面</span></button>
      <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-open-diary-compose><i class="fa-solid fa-feather"></i><span>撰写日记</span></button>
    </div>
    <div class="slx-diary-book-spread slx-diary-inline-book">
      <section class="slx-diary-book-page">
        <div class="slx-diary-book-page-title">目录</div>
        <div class="slx-diary-book-rule"></div>
        <div class="slx-diary-toc-list">
          ${entries.length ? entries.map((entry, index) => `
            <button type="button" data-slx-open-diary-entry="${escapeHtml(entry.id)}">
              <span>${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
              <b>${escapeHtml(getEntryTitle(entry))}</b>
              <small>${escapeHtml(getEntryTime(entry))} · ${entry.type === 'exchange_diary' ? '交换日记' : '角色独白'}</small>
            </button>
          `).join('') : '<p>这本日记还没有写下第一篇。</p>'}
        </div>
        <div class="slx-diary-book-page-num">目录</div>
      </section>
      <section class="slx-diary-book-page slx-diary-book-page-right">
        <div class="slx-diary-book-page-title">撰写</div>
        <div class="slx-diary-book-rule"></div>
        <p>点击“撰写日记”进入新页面。若你的日记内容为空，会生成角色独白；若写下给角色看的内容，会生成交换日记。</p>
        <div class="slx-diary-book-page-num">${escapeHtml(roleName || '')}</div>
      </section>
    </div>
  `;
}

function renderDiaryEntryPage(chatState) {
  const entries = getRoleEntries(getDiaryEntries(chatState), diaryPanelState.roleName);
  const entry = entries.find(item => item.id === diaryPanelState.entryId);
  if (!entry) return renderDiaryToc(chatState);

  const index = entries.findIndex(item => item.id === entry.id);
  const previousEntry = entries[index - 1] || null;
  const nextEntry = entries[index + 1] || null;
  const isExchange = entry.type === 'exchange_diary';
  const leftTitle = isExchange ? '你的日记' : getEntryTitle(entry);
  const leftText = isExchange ? entry.userContent : entry.content || '正文将在生成后写入这里。';
  const rightTitle = isExchange ? (entry.characterReply?.title || '角色回信') : '日记信息';
  const rightText = isExchange
    ? entry.characterReply?.content || '角色回信将在生成后写入这里。'
    : [
      `作者：${getEntryRoleName(entry)}`,
      `日期：${getEntryTime(entry)}`,
      `状态：${entry.status === 'draft' ? '草稿' : '已收录'}`,
      `来源：${entry.source === 'generated' ? 'AI 生成' : '手动草稿'}`,
    ].join('\n');

  return `
    <div class="slx-diary-nav-row">
      <button class="slx-soft-btn" type="button" data-slx-diary-back-toc><i class="fa-solid fa-list"></i><span>目录</span></button>
      <div class="slx-card-actions">
        ${entry.status === 'draft' ? `<button class="slx-mini-action-btn" type="button" data-slx-collect-diary="${escapeHtml(entry.id)}" title="收录"><i class="fa-solid fa-check"></i></button>` : ''}
        <button class="slx-mini-action-btn" type="button" data-slx-edit-diary="${escapeHtml(entry.id)}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="slx-mini-action-btn" type="button" data-slx-delete-diary="${escapeHtml(entry.id)}" title="删除"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>
    <div class="slx-diary-book-spread slx-diary-inline-book">
      <section class="slx-diary-book-page">
        <div class="slx-diary-book-page-title">${escapeHtml(leftTitle)}</div>
        <div class="slx-diary-book-rule"></div>
        <p>${escapeHtml(leftText)}</p>
        <div class="slx-diary-book-page-num">${escapeHtml(index + 1)}</div>
      </section>
      <section class="slx-diary-book-page slx-diary-book-page-right">
        <div class="slx-diary-book-page-title">${escapeHtml(rightTitle)}</div>
        <div class="slx-diary-book-rule"></div>
        <p>${escapeHtml(rightText)}</p>
        <div class="slx-diary-book-page-num">${escapeHtml(getEntryTime(entry))}</div>
      </section>
    </div>
    <div class="slx-diary-page-turns">
      <button class="slx-soft-btn" type="button" data-slx-open-diary-entry="${escapeHtml(previousEntry?.id || '')}" ${previousEntry ? '' : 'disabled'}><i class="fa-solid fa-chevron-left"></i><span>上一篇</span></button>
      <button class="slx-soft-btn slx-primary-btn" type="button" ${nextEntry ? `data-slx-open-diary-entry="${escapeHtml(nextEntry.id)}"` : 'data-slx-open-diary-compose'}><span>${nextEntry ? '下一篇' : '撰写新日记'}</span><i class="fa-solid fa-chevron-right"></i></button>
    </div>
  `;
}

function renderDiaryCompose(chatState) {
  const roleName = diaryPanelState.composeRoleName || diaryPanelState.roleName;
  const dateValue = diaryPanelState.composeDate || getDefaultDiaryDate(chatState);
  return `
    <div class="slx-diary-nav-row">
      <button class="slx-soft-btn" type="button" data-slx-diary-back-toc><i class="fa-solid fa-arrow-left"></i><span>返回目录</span></button>
    </div>
    <div class="slx-diary-book-spread slx-diary-inline-book">
      <section class="slx-diary-book-page">
        <div class="slx-diary-book-page-title">撰写日记</div>
        <div class="slx-diary-book-rule"></div>
        <label class="slx-field slx-diary-paper-field">
          <span>日记角色</span>
          <input type="text" data-slx-diary-compose-role value="${escapeHtml(roleName)}" placeholder="输入角色名称" />
        </label>
        <label class="slx-field slx-diary-paper-field">
          <span>日记日期</span>
          <input type="text" data-slx-diary-compose-date value="${escapeHtml(dateValue)}" placeholder="默认当前剧情日期，可手动改" />
        </label>
        <label class="slx-field slx-diary-paper-field">
          <span>给角色看的内容</span>
          <textarea class="slx-diary-new-textarea" data-slx-diary-compose-user-content placeholder="可空。为空时生成角色独白；写下你的内容时生成交换日记。"></textarea>
        </label>
      </section>
      <section class="slx-diary-book-page slx-diary-book-page-right">
        <div class="slx-diary-book-page-title">落笔前</div>
        <div class="slx-diary-book-rule"></div>
        <p>标题由 AI 生成。这里先建立待生成草稿，下一步会把正式生成流程接入这张纸页里的等待态。</p>
        <div class="slx-action-row slx-diary-compose-actions">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-create-unified-diary-draft>
            <i class="fa-solid fa-feather"></i><span>创建待生成草稿</span>
          </button>
          <button class="slx-soft-btn" type="button" data-slx-test-diary-context ${diaryContextTestState.status === 'running' ? 'disabled' : ''}>
            <i class="fa-solid fa-magnifying-glass"></i><span>测试上下文</span>
          </button>
        </div>
        <div class="slx-field-hint">${escapeHtml(getContextTestStatusText())}</div>
        ${renderContextTestResult()}
      </section>
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
            <span>日记角色</span>
            <input type="text" data-slx-diary-edit-role value="${escapeHtml(getEntryRoleName(entry))}" />
          </label>
          <label class="slx-field">
            <span>标题</span>
            <input type="text" data-slx-diary-edit-title value="${escapeHtml(getEntryTitle(entry) === '待生成标题' || getEntryTitle(entry) === '等待角色回信' ? '' : getEntryTitle(entry))}" />
          </label>
          <label class="slx-field">
            <span>日期</span>
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

function renderDiaryNotebookBody(chatState) {
  if (diaryPanelState.screen === 'cover') return renderDiaryCover(chatState);
  if (diaryPanelState.screen === 'toc') return renderDiaryToc(chatState);
  if (diaryPanelState.screen === 'entry') return renderDiaryEntryPage(chatState);
  if (diaryPanelState.screen === 'compose') return renderDiaryCompose(chatState);
  return renderDiaryLibrary(chatState);
}

function renderDiaryNotebookModal(chatState) {
  if (diaryPanelState.tab !== 'notebooks' || diaryPanelState.screen === 'library') return '';
  const roleName = diaryPanelState.roleName || diaryPanelState.composeRoleName || '未命名日记本';
  const stageClass = diaryPanelState.screen === 'cover' ? 'slx-diary-stage-cover' : 'slx-diary-stage-open';
  return `
    <div class="slx-diary-notebook-modal" data-slx-close-diary-notebook>
      <div class="slx-diary-notebook-stage ${stageClass}" data-slx-diary-notebook-stage>
        <div class="slx-diary-notebook-toolbar">
          <div>
            <b>${escapeHtml(roleName)}</b>
            <span>${diaryPanelState.screen === 'cover' ? '封面' : diaryPanelState.screen === 'toc' ? '目录' : diaryPanelState.screen === 'compose' ? '撰写日记' : '日记页'}</span>
          </div>
          <button class="slx-icon-btn" type="button" data-slx-close-diary-notebook title="关闭">×</button>
        </div>
        ${renderDiaryNotebookBody(chatState)}
      </div>
    </div>
  `;
}

export function renderDiaryPanel(settings, chatState) {
  getDiaryStore(chatState);
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
      </div>
      ${renderDiaryTabs()}
    </div>
    ${diaryPanelState.tab === 'settings' ? renderDiarySettings(chatState) : renderDiaryLibrary(chatState)}
    ${renderDiaryNotebookModal(chatState)}
    ${renderDiaryEditor(chatState)}
  `;
}

function saveEntry(entryInput) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entry = normalizeDiaryEntry(entryInput);
  ensureNotebook(getEntryRoleName(entry));
  store.entries.push(entry);
  store.lastComposeDate = entry.time || store.lastComposeDate || '';
  store.lastSavedAt = entry.updatedAt;
  saveChatState();
  return entry;
}

function createUnifiedDiaryDraft(panelRoot) {
  const roleName = normalizeRoleName(panelRoot.querySelector('[data-slx-diary-compose-role]')?.value);
  const date = String(panelRoot.querySelector('[data-slx-diary-compose-date]')?.value || '').trim() || formatTimestamp();
  const userContent = String(panelRoot.querySelector('[data-slx-diary-compose-user-content]')?.value || '').trim();
  if (!roleName) return;

  diaryPanelState.composeRoleName = roleName;
  diaryPanelState.composeDate = date;
  const now = formatTimestamp();
  const entry = saveEntry({
    type: userContent ? 'exchange_diary' : 'role_diary',
    status: 'draft',
    roleName,
    authorName: roleName,
    targetRoleName: roleName,
    time: date,
    userContent,
    characterReply: userContent ? { title: '', time: date, content: '' } : null,
    source: 'manual',
    createdAt: now,
    updatedAt: now,
  });

  diaryPanelState = {
    ...diaryPanelState,
    roleName,
    entryId: entry.id,
    screen: 'entry',
  };
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
  const updated = updateDiaryEntry(entryId, entry => {
    const roleName = normalizeRoleName(panelRoot.querySelector('[data-slx-diary-edit-role]')?.value);
    const title = String(panelRoot.querySelector('[data-slx-diary-edit-title]')?.value || '').trim();
    const time = String(panelRoot.querySelector('[data-slx-diary-edit-time]')?.value || '').trim();
    const status = panelRoot.querySelector('[data-slx-diary-edit-status]')?.value === 'draft' ? 'draft' : 'collected';
    const content = String(panelRoot.querySelector('[data-slx-diary-edit-content]')?.value || '').trim();

    entry.status = status;
    entry.roleName = roleName;
    entry.authorName = roleName;
    entry.targetRoleName = roleName;
    entry.title = title;
    entry.time = time;
    if (entry.type === 'exchange_diary') {
      entry.userContent = String(panelRoot.querySelector('[data-slx-diary-edit-user-content]')?.value || '').trim();
      entry.characterReply = {
        ...(entry.characterReply || {}),
        title,
        time,
        content,
      };
    } else {
      entry.content = content;
    }
    ensureNotebook(roleName);
  });
  diaryEditorState.open = false;
  if (updated) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: getEntryRoleName(updated),
      entryId: updated.id,
      screen: 'entry',
    };
  }
  refreshPanel();
}

function collectDiaryEntry(entryId) {
  const updated = updateDiaryEntry(entryId, entry => {
    entry.status = 'collected';
  });
  if (updated) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: getEntryRoleName(updated),
      entryId: updated.id,
      screen: 'entry',
    };
  }
  refreshPanel();
}

function deleteDiaryEntry(entryId) {
  if (!confirm('删除这条日记记录？')) return;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const deleted = store.entries.find(entry => entry.id === entryId);
  store.entries = store.entries.filter(entry => entry.id !== entryId);
  store.lastSavedAt = formatTimestamp();
  saveChatState();
  if (deleted && diaryPanelState.entryId === entryId) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: getEntryRoleName(normalizeDiaryEntry(deleted)),
      entryId: '',
      screen: 'toc',
    };
  }
  refreshPanel();
}

function exportDiaryBook() {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entries = getDiaryEntries(chatState);
  if (!entries.length) return;

  const payload = {
    exportedAt: new Date().toISOString(),
    identity: chatState.identity,
    books: store.books,
    settings: store.settings,
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
  const targetRoleName = normalizeRoleName(panelRoot.querySelector('[data-slx-diary-compose-role]')?.value || diaryPanelState.roleName);
  diaryPanelState.composeRoleName = targetRoleName;

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

function saveDiarySettings(panelRoot) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  store.settings = normalizeDiarySettings({
    ...store.settings,
    userTextColor: panelRoot.querySelector('[data-slx-diary-user-color]')?.value,
    characterTextColor: panelRoot.querySelector('[data-slx-diary-character-color]')?.value,
    coverPreset: panelRoot.querySelector('[data-slx-diary-cover-preset]')?.value,
    pagePreset: panelRoot.querySelector('[data-slx-diary-page-preset]')?.value,
    customCover: panelRoot.querySelector('[data-slx-diary-custom-cover]')?.value,
    customPage: panelRoot.querySelector('[data-slx-diary-custom-page]')?.value,
  });
  store.lastSavedAt = formatTimestamp();
  saveChatState();
}

export function bindDiaryPanelEvents(panelRoot) {
  panelRoot.addEventListener('click', event => {
    const openCover = event.target.closest?.('[data-slx-open-diary-toc]');
    if (openCover) {
      event.preventDefault();
      setDiaryScreen('toc', { entryId: '' });
    }
  });

  panelRoot.querySelectorAll('[data-slx-diary-tab]').forEach(button => {
    button.addEventListener('click', () => {
      diaryPanelState.tab = button.dataset.slxDiaryTab || 'notebooks';
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-export-diary]')?.addEventListener('click', exportDiaryBook);

  panelRoot.querySelector('[data-slx-create-diary-book]')?.addEventListener('click', () => {
    const roleName = ensureNotebook(panelRoot.querySelector('[data-slx-diary-new-book-role]')?.value);
    if (!roleName) return;
    diaryPanelState = {
      ...diaryPanelState,
      roleName,
      composeRoleName: roleName,
      screen: 'cover',
    };
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-diary-new-book-role]')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    panelRoot.querySelector('[data-slx-create-diary-book]')?.click();
  });

  panelRoot.querySelectorAll('[data-slx-open-diary-book]').forEach(button => {
    button.addEventListener('click', () => {
      const roleName = normalizeRoleName(button.dataset.slxOpenDiaryBook);
      diaryPanelState = {
        ...diaryPanelState,
        roleName,
        composeRoleName: roleName,
        entryId: '',
        screen: 'cover',
      };
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-diary-back-library]')?.addEventListener('click', () => {
    setDiaryScreen('library', { roleName: '', entryId: '' });
  });

  panelRoot.querySelectorAll('[data-slx-close-diary-notebook]').forEach(node => {
    node.addEventListener('click', event => {
      const clickedBackdrop = event.target === node && node.classList?.contains('slx-diary-notebook-modal');
      const closeControl = event.target.closest?.('[data-slx-close-diary-notebook]');
      const clickedCloseButton = Boolean(closeControl && closeControl !== node);
      if (!clickedBackdrop && !clickedCloseButton) {
        return;
      }
      setDiaryScreen('library', { roleName: '', entryId: '' });
    });
  });

  panelRoot.querySelector('[data-slx-diary-back-cover]')?.addEventListener('click', () => {
    setDiaryScreen('cover', { entryId: '' });
  });

  panelRoot.querySelector('[data-slx-diary-back-toc]')?.addEventListener('click', () => {
    setDiaryScreen('toc', { entryId: '' });
  });

  panelRoot.querySelectorAll('[data-slx-open-diary-entry]').forEach(button => {
    button.addEventListener('click', () => {
      const entryId = button.dataset.slxOpenDiaryEntry || '';
      if (!entryId) return;
      setDiaryScreen('entry', { entryId });
    });
  });

  panelRoot.querySelectorAll('[data-slx-open-diary-compose]').forEach(button => {
    button.addEventListener('click', () => {
      const chatState = getChatState();
      setDiaryScreen('compose', {
        composeRoleName: diaryPanelState.roleName,
        composeDate: diaryPanelState.composeDate || getDefaultDiaryDate(chatState),
      });
    });
  });

  panelRoot.querySelector('[data-slx-create-unified-diary-draft]')?.addEventListener('click', () => {
    createUnifiedDiaryDraft(panelRoot);
  });

  panelRoot.querySelector('[data-slx-test-diary-context]')?.addEventListener('click', () => {
    void testDiaryContext(panelRoot);
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

  panelRoot.querySelectorAll('[data-slx-diary-api-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const chatState = getChatState();
      const store = getDiaryStore(chatState);
      store.settings.apiMode = button.dataset.slxDiaryApiMode === 'secondary' ? 'secondary' : 'main';
      store.lastSavedAt = formatTimestamp();
      saveChatState();
      refreshPanel();
    });
  });

  [
    '[data-slx-diary-user-color]',
    '[data-slx-diary-character-color]',
    '[data-slx-diary-cover-preset]',
    '[data-slx-diary-page-preset]',
    '[data-slx-diary-custom-cover]',
    '[data-slx-diary-custom-page]',
  ].forEach(selector => {
    panelRoot.querySelector(selector)?.addEventListener('change', () => saveDiarySettings(panelRoot));
  });
}
