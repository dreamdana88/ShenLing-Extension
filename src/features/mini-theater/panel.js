import {
  escapeHtml,
} from '../../utils/text.js';
import {
  getContextInfo,
  getGlobalSettings,
  saveGlobalSettings,
} from '../../core/settings.js';

let panelOptions = {
  refreshPanel: null,
};

// 跨渲染持久化的面板本地状态
let panelState = {
  activeTab: 'prompts',    // 'prompts' | 'generate' | 'saves'
  previewOpen: false,
  promptText: '',
  promptSource: null,      // { id, name } | null
  promptSearch: '',
  promptSortBy: 'newest',  // 'newest' | 'name'
  promptFolderFilter: null,// folderId | null（null = 全部）
  modal: null,             // 见下方 modal 类型注释
  pickSearch: '',          // 从库选择弹窗内的搜索词
};

/*
  modal 类型：
  { type: 'prompt-form', promptId: null|string, fields: { name, content, folderId } }
  { type: 'folder-form', fields: { name } }
  { type: 'delete-confirm', target: 'prompt'|'folder', id, name }
  { type: 'pick-prompt' }
*/

export function configureMiniTheaterPanel(options = {}) {
  panelOptions = { ...panelOptions, ...options };
}

function refreshPanel() {
  if (typeof panelOptions.refreshPanel === 'function') {
    panelOptions.refreshPanel();
  }
}

// ── 数据访问 ──────────────────────────────────────────────────────────

function getMiniTheaterSettings() {
  const settings = getGlobalSettings();
  settings.modules = settings.modules || {};
  settings.modules.miniTheater = settings.modules.miniTheater || {};
  const mt = settings.modules.miniTheater;
  if (!['main_api', 'secondary_api'].includes(mt.apiMode)) mt.apiMode = 'secondary_api';
  if (!Array.isArray(mt.folders)) mt.folders = [];
  if (!Array.isArray(mt.prompts)) mt.prompts = [];
  return mt;
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getFolderName(folderId, folders) {
  if (!folderId) return null;
  return folders.find(f => f.id === folderId)?.name ?? null;
}

function getFilteredSortedPrompts(prompts, { search, folderId, sortBy }) {
  let result = [...prompts];
  if (folderId !== null) {
    result = result.filter(p => (p.folderId || null) === folderId);
  }
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.content || '').toLowerCase().includes(q),
    );
  }
  if (sortBy === 'name') {
    result.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  } else {
    result.sort((a, b) => ((b.createdAt || '') > (a.createdAt || '') ? 1 : -1));
  }
  return result;
}

// ── 顶部固定区 ────────────────────────────────────────────────────────

function renderTopBar() {
  const info = getContextInfo();
  const mt = getMiniTheaterSettings();
  const apiMode = mt.apiMode;
  return `
    <div class="slx-theater-topbar">
      <div class="slx-theater-context">
        <span class="slx-theater-context-char">${escapeHtml(info.characterName)}</span>
        <span class="slx-theater-context-sep">·</span>
        <span class="slx-theater-context-chat">${escapeHtml(info.chatName)}</span>
      </div>
      <div class="slx-theater-api-toggle" role="group" aria-label="小剧场生成 API">
        <button class="${apiMode === 'main_api' ? 'is-active' : ''}" type="button" data-theater-api-mode="main_api">主 API</button>
        <button class="${apiMode === 'secondary_api' ? 'is-active' : ''}" type="button" data-theater-api-mode="secondary_api">副 API</button>
      </div>
    </div>
  `;
}

// ── 标签栏 ────────────────────────────────────────────────────────────

function renderTabBar() {
  const tabs = [
    { id: 'prompts', label: '提示词库' },
    { id: 'generate', label: '发送与生成' },
    { id: 'saves', label: '已收藏回看' },
  ];
  return `
    <div class="slx-theater-tabs" role="tablist">
      ${tabs.map(tab => `
        <button
          class="slx-theater-tab${panelState.activeTab === tab.id ? ' slx-theater-tab-active' : ''}"
          type="button" role="tab"
          aria-selected="${panelState.activeTab === tab.id}"
          data-theater-tab="${escapeHtml(tab.id)}"
        >${escapeHtml(tab.label)}</button>
      `).join('')}
    </div>
  `;
}

// ── Tab 1：提示词库 ───────────────────────────────────────────────────

function renderFolderChips(folders) {
  const active = panelState.promptFolderFilter;
  const chips = [{ id: null, label: '全部' }, ...folders.map(f => ({ id: f.id, label: f.name }))];
  return `
    <div class="slx-theater-folder-chips" role="group" aria-label="按文件夹筛选">
      ${chips.map(c => `
        <button
          class="slx-theater-folder-chip${(c.id === null ? active === null : active === c.id) ? ' is-active' : ''}"
          type="button"
          data-theater-folder-filter="${c.id === null ? '' : escapeHtml(c.id)}"
        >${escapeHtml(c.label)}</button>
      `).join('')}
      <button class="slx-theater-folder-chip slx-theater-folder-chip-add" type="button" data-theater-new-folder>＋ 文件夹</button>
    </div>
  `;
}

function renderPromptCard(prompt, folders) {
  const folderName = getFolderName(prompt.folderId, folders);
  const preview = (prompt.content || '').slice(0, 65).replace(/[\r\n]+/g, ' ');
  const hasMore = (prompt.content || '').length > 65;
  return `
    <div class="slx-theater-prompt-card" data-prompt-id="${escapeHtml(prompt.id)}">
      <div class="slx-theater-prompt-card-body">
        <div class="slx-theater-prompt-card-name">${escapeHtml(prompt.name || '未命名')}</div>
        ${preview ? `<div class="slx-theater-prompt-card-preview">${escapeHtml(preview)}${hasMore ? '…' : ''}</div>` : ''}
        ${folderName ? `<span class="slx-theater-prompt-card-folder">${escapeHtml(folderName)}</span>` : ''}
      </div>
      <div class="slx-theater-prompt-card-actions">
        <button class="slx-soft-btn" type="button" data-theater-copy-prompt="${escapeHtml(prompt.id)}">复制</button>
        <button class="slx-soft-btn" type="button" data-theater-send-prompt="${escapeHtml(prompt.id)}">发送到生成</button>
        <button class="slx-soft-btn" type="button" data-theater-edit-prompt="${escapeHtml(prompt.id)}">编辑</button>
        <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-delete-prompt="${escapeHtml(prompt.id)}">删除</button>
      </div>
    </div>
  `;
}

function renderPromptsTab() {
  const mt = getMiniTheaterSettings();
  const { folders, prompts } = mt;
  const filtered = getFilteredSortedPrompts(prompts, {
    search: panelState.promptSearch,
    folderId: panelState.promptFolderFilter,
    sortBy: panelState.promptSortBy,
  });

  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-theater-prompts-toolbar">
        <input
          class="slx-theater-search-input"
          type="search"
          placeholder="搜索提示词…"
          value="${escapeHtml(panelState.promptSearch)}"
          data-theater-prompt-search
          aria-label="搜索提示词"
        >
        <select class="slx-theater-sort-select" data-theater-sort aria-label="排序方式">
          <option value="newest" ${panelState.promptSortBy === 'newest' ? 'selected' : ''}>最新</option>
          <option value="name" ${panelState.promptSortBy === 'name' ? 'selected' : ''}>名称</option>
        </select>
        <button class="slx-soft-btn" type="button" data-theater-new-prompt>＋ 新建</button>
      </div>

      ${folders.length > 0 ? renderFolderChips(folders) : ''}

      ${filtered.length === 0
    ? `<div class="slx-detail-card slx-theater-empty-state">
           <div class="slx-theater-empty-icon">📝</div>
           <p>${prompts.length === 0 ? '还没有收藏的提示词' : '没有符合条件的提示词'}</p>
           ${prompts.length === 0 ? '<button class="slx-soft-btn" type="button" data-theater-new-prompt>＋ 新建第一条</button>' : ''}
         </div>`
    : `<div class="slx-theater-prompt-list">
           ${filtered.map(p => renderPromptCard(p, folders)).join('')}
         </div>`
}
    </div>
  `;
}

// ── Tab 2：发送与生成 ─────────────────────────────────────────────────

function renderGenerateTab() {
  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-detail-card">
        <label class="slx-detail-title" for="slx-theater-prompt-input">提示词内容</label>
        <textarea
          id="slx-theater-prompt-input"
          class="slx-theater-prompt-textarea"
          rows="5"
          placeholder="输入小剧场提示词，或从提示词库中选择…"
          data-theater-prompt-text
        >${escapeHtml(panelState.promptText)}</textarea>
        <div class="slx-action-row">
          <button class="slx-soft-btn" type="button" data-theater-pick-prompt>从提示词库选择</button>
          ${panelState.promptSource
    ? `<span class="slx-theater-source-bar">
               来源：${escapeHtml(panelState.promptSource.name)}
               <button class="slx-theater-source-clear" type="button" data-theater-clear-source aria-label="清除来源">✕</button>
             </span>`
    : ''}
        </div>
      </div>

      <div class="slx-action-row">
        <button class="slx-soft-btn slx-theater-generate-btn" type="button" data-theater-generate>
          生成小剧场 ▶
        </button>
      </div>
      <p class="slx-theater-gen-note">0.1 版本：生成功能待接入，点击可预览弹窗效果</p>
    </div>
  `;
}

// ── Tab 3：已收藏回看 ─────────────────────────────────────────────────

function renderSavesTab() {
  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-detail-card slx-theater-empty-state">
        <div class="slx-theater-empty-icon">🎬</div>
        <p>生成后的小剧场将在这里留档</p>
      </div>
    </div>
  `;
}

// ── 模态弹窗 ──────────────────────────────────────────────────────────

function renderModalContent() {
  const m = panelState.modal;
  if (!m) return '';

  if (m.type === 'prompt-form') {
    const mt = getMiniTheaterSettings();
    const isEdit = Boolean(m.promptId);
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">${isEdit ? '编辑提示词' : '新建提示词'}</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <div class="slx-theater-modal-form-row">
          <div class="slx-theater-form-field">
            <label for="slx-theater-modal-name">名称</label>
            <input id="slx-theater-modal-name" type="text" class="slx-theater-text-input"
              value="${escapeHtml(m.fields.name)}" placeholder="给提示词起个名字…"
              data-theater-modal-field="name" maxlength="60" autocomplete="off">
          </div>
          <div class="slx-theater-form-field slx-theater-folder-field">
            <label for="slx-theater-modal-folder">文件夹</label>
            <select id="slx-theater-modal-folder" class="slx-theater-select" data-theater-modal-field="folderId">
              <option value="" ${!m.fields.folderId ? 'selected' : ''}>未分类</option>
              ${mt.folders.map(f => `
                <option value="${escapeHtml(f.id)}" ${m.fields.folderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>
              `).join('')}
            </select>
          </div>
        </div>
        <div class="slx-theater-form-field">
          <label for="slx-theater-modal-content">内容</label>
          <textarea id="slx-theater-modal-content" class="slx-theater-prompt-textarea slx-theater-modal-textarea" rows="12"
            placeholder="提示词正文…"
            data-theater-modal-field="content"
          >${escapeHtml(m.fields.content)}</textarea>
        </div>
      </div>
      <div class="slx-theater-modal-footer">
        ${isEdit
    ? `<button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-modal-delete-prompt="${escapeHtml(m.promptId)}">删除</button>`
    : '<span></span>'}
        <div style="display:flex;gap:8px">
          <button class="slx-soft-btn" type="button" data-theater-modal-close>取消</button>
          <button class="slx-soft-btn slx-primary-btn slx-theater-modal-primary-btn" type="button" data-theater-modal-save>保存</button>
        </div>
      </div>
    `;
  }

  if (m.type === 'folder-form') {
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">新建文件夹</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <div class="slx-theater-form-field">
          <label for="slx-theater-modal-folder-name">文件夹名称</label>
          <input id="slx-theater-modal-folder-name" type="text" class="slx-theater-text-input"
            value="${escapeHtml(m.fields.name)}" placeholder="例如：浪漫番外"
            data-theater-modal-field="name" maxlength="30" autocomplete="off">
        </div>
      </div>
      <div class="slx-theater-modal-footer">
        <span></span>
        <div style="display:flex;gap:8px">
          <button class="slx-soft-btn" type="button" data-theater-modal-close>取消</button>
          <button class="slx-soft-btn slx-primary-btn slx-theater-modal-primary-btn" type="button" data-theater-modal-save>创建</button>
        </div>
      </div>
    `;
  }

  if (m.type === 'delete-confirm') {
    const extra = m.target === 'folder' ? '<br>文件夹内的提示词将移至未分类。' : '';
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">确认删除</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <p style="margin:0;line-height:1.6;color:var(--slx-text)">
          删除「${escapeHtml(m.name)}」？此操作无法撤销。${extra}
        </p>
      </div>
      <div class="slx-theater-modal-footer">
        <span></span>
        <div style="display:flex;gap:8px">
          <button class="slx-soft-btn" type="button" data-theater-modal-close>取消</button>
          <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-modal-confirm-delete>确认删除</button>
        </div>
      </div>
    `;
  }

  if (m.type === 'pick-prompt') {
    const mt = getMiniTheaterSettings();
    const filtered = getFilteredSortedPrompts(mt.prompts, {
      search: panelState.pickSearch,
      folderId: null,
      sortBy: 'name',
    });
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">选择提示词</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body slx-theater-pick-body">
        <input type="search" class="slx-theater-search-input" placeholder="搜索…"
          value="${escapeHtml(panelState.pickSearch)}"
          data-theater-pick-search aria-label="搜索提示词">
        <div class="slx-theater-pick-list">
          ${filtered.length === 0
    ? `<p style="color:var(--slx-muted);font-size:12px;padding:8px 0;margin:0">
                ${mt.prompts.length === 0 ? '提示词库为空，请先新建提示词' : '没有匹配的提示词'}</p>`
    : filtered.map(p => `
                <button class="slx-theater-pick-item" type="button" data-theater-pick-item="${escapeHtml(p.id)}">
                  <span class="slx-theater-pick-item-name">${escapeHtml(p.name || '未命名')}</span>
                  <span class="slx-theater-pick-item-preview">${escapeHtml((p.content || '').slice(0, 55))}${(p.content || '').length > 55 ? '…' : ''}</span>
                </button>
              `).join('')}
        </div>
      </div>
    `;
  }

  return '';
}

function renderModal() {
  if (!panelState.modal) return '';
  const modalClass = [
    'slx-theater-modal',
    panelState.modal.type === 'prompt-form' ? 'slx-theater-modal-prompt-form' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="slx-theater-overlay slx-theater-modal-overlay" data-theater-modal-overlay role="dialog" aria-modal="true">
      <div class="${modalClass}">
        ${renderModalContent()}
      </div>
    </div>
  `;
}

// ── 预览弹窗 ──────────────────────────────────────────────────────────

function renderPreviewOverlay() {
  if (!panelState.previewOpen) return '';
  return `
    <div class="slx-theater-overlay" data-theater-overlay role="dialog" aria-modal="true" aria-label="小剧场预览">
      <div class="slx-theater-preview">
        <div class="slx-theater-preview-header">
          <span class="slx-theater-preview-title">小剧场预览</span>
          <button class="slx-icon-btn" type="button" data-theater-close-preview aria-label="关闭预览">×</button>
        </div>
        <div class="slx-theater-preview-body">
          <div class="slx-theater-text-body">
            <p class="slx-theater-text-placeholder">小剧场内容将在这里展示。后续生成结果如果包含 HTML，会自动进入安全预览；纯文字会按正文展示。</p>
          </div>
        </div>
        <div class="slx-theater-preview-footer">
          <button class="slx-soft-btn" type="button" data-theater-close-preview>关闭</button>
          <button class="slx-soft-btn" type="button" disabled title="0.3 版本接入">收藏</button>
          <button class="slx-soft-btn" type="button" disabled title="0.3 版本接入">复制</button>
          <button class="slx-soft-btn" type="button" disabled title="0.3 版本接入">重新生成</button>
        </div>
      </div>
    </div>
  `;
}

// ── 主渲染入口 ────────────────────────────────────────────────────────

export function renderMiniTheaterPanel() {
  return `
    <div class="slx-theater-root" data-theater-root>
      ${renderTopBar()}
      ${renderTabBar()}
      ${renderActiveTab()}
      ${renderPreviewOverlay()}
      ${renderModal()}
    </div>
  `;
}

function renderActiveTab() {
  switch (panelState.activeTab) {
    case 'generate': return renderGenerateTab();
    case 'saves':    return renderSavesTab();
    default:         return renderPromptsTab();
  }
}

// ── 事件绑定 ──────────────────────────────────────────────────────────

export function bindMiniTheaterPanelEvents(panelRoot) {
  const root = panelRoot.querySelector('[data-theater-root]');
  if (!root) return;

  // ── 标签切换 ──
  root.querySelectorAll('[data-theater-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      panelState.activeTab = btn.dataset.theaterTab;
      refreshPanel();
    });
  });

  // ── API 模式 ──
  root.querySelectorAll('[data-theater-api-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.theaterApiMode;
      if (!['main_api', 'secondary_api'].includes(mode)) return;
      getMiniTheaterSettings().apiMode = mode;
      saveGlobalSettings();
      refreshPanel();
    });
  });

  // ── 提示词库：搜索 / 排序 / 文件夹筛选 ──
  root.querySelector('[data-theater-prompt-search]')?.addEventListener('input', e => {
    panelState.promptSearch = e.target.value;
    refreshPanel();
  });

  root.querySelector('[data-theater-sort]')?.addEventListener('change', e => {
    panelState.promptSortBy = e.target.value;
    refreshPanel();
  });

  root.querySelectorAll('[data-theater-folder-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.theaterFolderFilter;
      panelState.promptFolderFilter = val === '' ? null : val;
      refreshPanel();
    });
  });

  // ── 新建提示词 ──
  root.querySelectorAll('[data-theater-new-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      panelState.modal = { type: 'prompt-form', promptId: null, fields: { name: '', content: '', folderId: null } };
      refreshPanel();
    });
  });

  // ── 新建文件夹 ──
  root.querySelector('[data-theater-new-folder]')?.addEventListener('click', () => {
    panelState.modal = { type: 'folder-form', fields: { name: '' } };
    refreshPanel();
  });

  // ── 卡片操作 ──
  root.querySelectorAll('[data-theater-copy-prompt]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(p => p.id === btn.dataset.theaterCopyPrompt);
      if (!prompt) return;
      try {
        await navigator.clipboard.writeText(prompt.content || '');
        const orig = btn.textContent;
        btn.textContent = '已复制 ✓';
        setTimeout(() => { btn.textContent = orig; }, 1400);
      } catch {
        btn.textContent = '复制失败';
      }
    });
  });

  root.querySelectorAll('[data-theater-send-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(p => p.id === btn.dataset.theaterSendPrompt);
      if (!prompt) return;
      panelState.promptText = prompt.content || '';
      panelState.promptSource = { id: prompt.id, name: prompt.name || '未命名' };
      panelState.activeTab = 'generate';
      refreshPanel();
    });
  });

  root.querySelectorAll('[data-theater-edit-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(p => p.id === btn.dataset.theaterEditPrompt);
      if (!prompt) return;
      panelState.modal = {
        type: 'prompt-form',
        promptId: prompt.id,
        fields: { name: prompt.name || '', content: prompt.content || '', folderId: prompt.folderId || null },
      };
      refreshPanel();
    });
  });

  root.querySelectorAll('[data-theater-delete-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(p => p.id === btn.dataset.theaterDeletePrompt);
      if (!prompt) return;
      panelState.modal = { type: 'delete-confirm', target: 'prompt', id: prompt.id, name: prompt.name || '未命名' };
      refreshPanel();
    });
  });

  // ── 发送与生成 tab ──
  root.querySelector('[data-theater-prompt-text]')?.addEventListener('input', e => {
    panelState.promptText = e.target.value;
    if (panelState.promptSource) {
      panelState.promptSource = null;
      // 不 refreshPanel，避免光标跳位
    }
  });

  root.querySelector('[data-theater-clear-source]')?.addEventListener('click', () => {
    panelState.promptSource = null;
    refreshPanel();
  });

  root.querySelector('[data-theater-pick-prompt]')?.addEventListener('click', () => {
    panelState.pickSearch = '';
    panelState.modal = { type: 'pick-prompt' };
    refreshPanel();
  });

  root.querySelector('[data-theater-generate]')?.addEventListener('click', () => {
    panelState.previewOpen = true;
    refreshPanel();
  });

  // ── 预览弹窗 ──
  root.querySelectorAll('[data-theater-close-preview]').forEach(btn => {
    btn.addEventListener('click', () => {
      panelState.previewOpen = false;
      refreshPanel();
    });
  });
  root.querySelector('[data-theater-overlay]')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      panelState.previewOpen = false;
      refreshPanel();
    }
  });

  // ── 模态弹窗通用 ──
  root.querySelectorAll('[data-theater-modal-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      panelState.modal = null;
      refreshPanel();
    });
  });

  root.querySelector('[data-theater-modal-overlay]')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      panelState.modal = null;
      refreshPanel();
    }
  });

  root.querySelectorAll('[data-theater-modal-field]').forEach(el => {
    const event = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(event, e => {
      if (!panelState.modal?.fields) return;
      const field = el.dataset.theaterModalField;
      const val = e.target.value;
      panelState.modal.fields[field] = field === 'folderId' ? (val || null) : val;
    });
  });

  root.querySelector('[data-theater-modal-save]')?.addEventListener('click', () => {
    const m = panelState.modal;
    if (!m) return;
    const now = new Date().toISOString();

    if (m.type === 'prompt-form') {
      const name = (m.fields.name || '').trim();
      if (!name) return;
      const mt = getMiniTheaterSettings();
      if (m.promptId) {
        const existing = mt.prompts.find(p => p.id === m.promptId);
        if (existing) {
          existing.name = name;
          existing.content = (m.fields.content || '').trim();
          existing.folderId = m.fields.folderId || null;
          existing.updatedAt = now;
        }
      } else {
        mt.prompts.push({
          id: genId(),
          name,
          content: (m.fields.content || '').trim(),
          folderId: m.fields.folderId || null,
          createdAt: now,
          updatedAt: now,
        });
      }
      saveGlobalSettings();
      panelState.modal = null;
      refreshPanel();
    }

    if (m.type === 'folder-form') {
      const name = (m.fields.name || '').trim();
      if (!name) return;
      getMiniTheaterSettings().folders.push({ id: genId(), name });
      saveGlobalSettings();
      panelState.modal = null;
      refreshPanel();
    }
  });

  // 从编辑模态内点删除 → 进入删除确认
  root.querySelector('[data-theater-modal-delete-prompt]')?.addEventListener('click', function () {
    const promptId = this.dataset.theaterModalDeletePrompt;
    const mt = getMiniTheaterSettings();
    const prompt = mt.prompts.find(p => p.id === promptId);
    if (!prompt) return;
    panelState.modal = { type: 'delete-confirm', target: 'prompt', id: promptId, name: prompt.name || '未命名' };
    refreshPanel();
  });

  // 确认删除
  root.querySelector('[data-theater-modal-confirm-delete]')?.addEventListener('click', () => {
    const m = panelState.modal;
    if (!m || m.type !== 'delete-confirm') return;
    const mt = getMiniTheaterSettings();
    if (m.target === 'prompt') {
      mt.prompts = mt.prompts.filter(p => p.id !== m.id);
      if (panelState.promptSource?.id === m.id) panelState.promptSource = null;
    }
    if (m.target === 'folder') {
      mt.folders = mt.folders.filter(f => f.id !== m.id);
      mt.prompts.forEach(p => { if (p.folderId === m.id) p.folderId = null; });
      if (panelState.promptFolderFilter === m.id) panelState.promptFolderFilter = null;
    }
    saveGlobalSettings();
    panelState.modal = null;
    refreshPanel();
  });

  // ── 从库选择弹窗 ──
  root.querySelector('[data-theater-pick-search]')?.addEventListener('input', e => {
    panelState.pickSearch = e.target.value;
    refreshPanel();
  });

  root.querySelectorAll('[data-theater-pick-item]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(p => p.id === btn.dataset.theaterPickItem);
      if (!prompt) return;
      panelState.promptText = prompt.content || '';
      panelState.promptSource = { id: prompt.id, name: prompt.name || '未命名' };
      panelState.modal = null;
      panelState.activeTab = 'generate';
      refreshPanel();
    });
  });
}
