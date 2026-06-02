import {
  escapeHtml,
} from '../../utils/text.js';
import {
  getContextInfo,
} from '../../core/settings.js';

let panelOptions = {
  refreshPanel: null,
};

// 跨渲染持久化的面板本地状态
let panelState = {
  activeTab: 'prompts',  // 'prompts' | 'generate' | 'saves'
  previewOpen: false,
  generateMode: 'text',  // 'text' | 'html'
};

export function configureMiniTheaterPanel(options = {}) {
  panelOptions = { ...panelOptions, ...options };
}

function refreshPanel() {
  if (typeof panelOptions.refreshPanel === 'function') {
    panelOptions.refreshPanel();
  }
}

// ── 顶部固定区：角色/聊天信息 + API 模式胶囊 ──────────────────────────

function renderTopBar() {
  const info = getContextInfo();
  return `
    <div class="slx-theater-topbar">
      <div class="slx-theater-context">
        <span class="slx-theater-context-char">${escapeHtml(info.characterName)}</span>
        <span class="slx-theater-context-sep">·</span>
        <span class="slx-theater-context-chat">${escapeHtml(info.chatName)}</span>
      </div>
      <button class="slx-theater-api-pill" type="button" data-theater-api-pill title="API 模式（0.2 版接入）">
        副 API
      </button>
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
          type="button"
          role="tab"
          aria-selected="${panelState.activeTab === tab.id ? 'true' : 'false'}"
          data-theater-tab="${escapeHtml(tab.id)}"
        >${escapeHtml(tab.label)}</button>
      `).join('')}
    </div>
  `;
}

// ── Tab 1：提示词库 ───────────────────────────────────────────────────

function renderPromptsTab() {
  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-detail-card slx-theater-empty-state">
        <div class="slx-theater-empty-icon">📝</div>
        <p>还没有收藏的提示词</p>
        <button class="slx-soft-btn" type="button" data-theater-new-prompt aria-label="新建提示词">
          + 新建第一条
        </button>
      </div>
    </div>
  `;
}

// ── Tab 2：发送与生成 ─────────────────────────────────────────────────

function renderGenerateTab() {
  const modeBtnLabel = panelState.generateMode === 'html' ? '切换为文字' : '切换为 HTML 美化';
  const modeDisplay = panelState.generateMode === 'html' ? 'HTML 美化' : '文字';

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
        ></textarea>
        <div class="slx-action-row">
          <button class="slx-soft-btn" type="button" data-theater-pick-prompt>
            从提示词库选择
          </button>
        </div>
      </div>

      <div class="slx-detail-card">
        <div class="slx-switch-row">
          <span class="slx-detail-title">输出模式</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="slx-detail-kicker">${escapeHtml(modeDisplay)}</span>
            <button class="slx-soft-btn" type="button" data-theater-toggle-mode>
              ${escapeHtml(modeBtnLabel)}
            </button>
          </div>
        </div>
      </div>

      <div class="slx-action-row">
        <button class="slx-primary-btn" type="button" data-theater-generate>
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

// ── 预览弹窗壳子 ──────────────────────────────────────────────────────

function renderPreviewOverlay() {
  if (!panelState.previewOpen) return '';

  const isHtml = panelState.generateMode === 'html';
  const modeLabel = isHtml ? 'HTML 美化' : '文字';

  return `
    <div class="slx-theater-overlay" data-theater-overlay role="dialog" aria-modal="true" aria-label="小剧场预览">
      <div class="slx-theater-preview">
        <div class="slx-theater-preview-header">
          <span class="slx-theater-preview-title">预览 · ${escapeHtml(modeLabel)}</span>
          <button class="slx-icon-btn" type="button" data-theater-close-preview aria-label="关闭预览">×</button>
        </div>

        <div class="slx-theater-preview-body">
          ${isHtml
            ? `<div class="slx-theater-iframe-wrap">
                 <iframe
                   class="slx-theater-iframe"
                   sandbox=""
                   title="小剧场 HTML 预览"
                   srcdoc="<p style='font-family:sans-serif;padding:20px;color:#888'>HTML 小剧场内容将在这里渲染（0.1 占位）</p>"
                 ></iframe>
               </div>`
            : `<div class="slx-theater-text-body">
                 <p class="slx-theater-text-placeholder">文字小剧场内容将在这里展示（0.1 占位）</p>
               </div>`
          }
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

  // 标签切换
  root.querySelectorAll('[data-theater-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      panelState.activeTab = btn.dataset.theaterTab;
      refreshPanel();
    });
  });

  // 输出模式切换
  root.querySelector('[data-theater-toggle-mode]')?.addEventListener('click', () => {
    panelState.generateMode = panelState.generateMode === 'text' ? 'html' : 'text';
    refreshPanel();
  });

  // API 胶囊（0.2 接入，暂占位）
  root.querySelector('[data-theater-api-pill]')?.addEventListener('click', () => {
    // 待 0.2 接入
  });

  // 新建提示词（0.2 接入）
  root.querySelector('[data-theater-new-prompt]')?.addEventListener('click', () => {
    // 待 0.2 接入
  });

  // 从库选择（0.2 接入）
  root.querySelector('[data-theater-pick-prompt]')?.addEventListener('click', () => {
    // 待 0.2 接入
  });

  // 生成按钮：0.1 仅打开预览弹窗壳子测试动效
  root.querySelector('[data-theater-generate]')?.addEventListener('click', () => {
    panelState.previewOpen = true;
    refreshPanel();
  });

  // 关闭预览
  root.querySelectorAll('[data-theater-close-preview]').forEach(btn => {
    btn.addEventListener('click', () => {
      panelState.previewOpen = false;
      refreshPanel();
    });
  });

  // 点击遮罩层背景关闭
  root.querySelector('[data-theater-overlay]')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      panelState.previewOpen = false;
      refreshPanel();
    }
  });
}
