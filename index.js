const MODULE_NAME = 'shenling_assistant';

const MODULES = [
  { id: 'summary', icon: '🫧', title: '自动总结', desc: '副 API、小总结、大总结与归档管理。' },
  { id: 'outline', icon: '🧭', title: '剧情规划', desc: '故事大纲、主线阶段与当前剧情节点。' },
  { id: 'memoir', icon: '📚', title: '回忆录世界书', desc: '关键节点提炼、绿灯关键词与聊天专属回忆录。' },
  { id: 'pursuit', icon: '💘', title: '逆攻略', desc: '让角色在不崩人设的前提下主动推进关系。' },
  { id: 'parallel', icon: '🌈', title: '平行事件', desc: '基于时间轴低频续写不在场角色动态。' },
  { id: 'profile', icon: '🎭', title: '角色档案', desc: '关系阶段、情感变化、角色目标与隐秘动机。' },
  { id: 'diary', icon: '📓', title: '日程日记', desc: '七日程表、普通日记与交换日记。' },
  { id: 'inspire', icon: '✨', title: '灵感工具', desc: '小剧场、分支选项、冲突事件与场景推进。' },
  { id: 'replace', icon: '🈲', title: '词汇替换', desc: '用户词库、替换预览与当前楼层重新替换。' },
  { id: 'settings', icon: '⚙️', title: '设置', desc: '插件状态、主题与后续通用配置。' },
];

const defaultSettings = Object.freeze({
  enabled: true,
  theme: 'light',
  activeModule: 'summary',
});

let panelRoot = null;

function cloneDefaultSettings() {
  return JSON.parse(JSON.stringify(defaultSettings));
}

function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getSettings() {
  const context = getContextSafe();
  if (!context?.extensionSettings) {
    return cloneDefaultSettings();
  }

  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = cloneDefaultSettings();
  }

  const settings = context.extensionSettings[MODULE_NAME];
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.hasOwn(settings, key)) {
      settings[key] = value;
    }
  }

  return settings;
}

function saveSettings() {
  const context = getContextSafe();
  context?.saveSettingsDebounced?.();
}

function getActiveModule(settings = getSettings()) {
  return MODULES.find(item => item.id === settings.activeModule) ?? MODULES[0];
}

function getContextInfo() {
  const context = getContextSafe();
  return {
    character: context?.name2 || context?.character?.name || '未读取',
    chat: context?.chatMetadata?.name || context?.chatId || '未读取',
  };
}

function createModuleButton(module, settings) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `slx-module-btn${settings.activeModule === module.id ? ' slx-module-btn-active' : ''}`;
  button.dataset.moduleId = module.id;
  button.innerHTML = `
    <span class="slx-module-icon">${module.icon}</span>
    <span class="slx-module-text">
      <b>${module.title}</b>
      <small>${module.desc}</small>
    </span>
  `;
  return button;
}

function renderModuleDetail(module, settings) {
  const info = getContextInfo();
  if (module.id === 'settings') {
    return `
      <div class="slx-detail-card">
        <div class="slx-detail-title">基础设置</div>
        <label class="slx-switch-row" for="slx-panel-enabled">
          <span>
            <b>启用插件</b>
            <small>当前只是总开关占位，后续模块会读取它。</small>
          </span>
          <input id="slx-panel-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
        </label>
        <label class="slx-switch-row" for="slx-panel-theme">
          <span>
            <b>深色主题</b>
            <small>先做轻量切换，后面再扩展皮肤。</small>
          </span>
          <input id="slx-panel-theme" type="checkbox" ${settings.theme === 'dark' ? 'checked' : ''} />
        </label>
      </div>
      <div class="slx-detail-card slx-muted-card">
        <div class="slx-detail-title">当前环境</div>
        <div class="slx-info-line"><span>角色</span><b>${info.character}</b></div>
        <div class="slx-info-line"><span>聊天</span><b>${info.chat}</b></div>
        <div class="slx-info-line"><span>版本</span><b>0.1.0</b></div>
      </div>
    `;
  }

  return `
    <div class="slx-detail-card">
      <div class="slx-detail-kicker">${module.icon} ${module.title}</div>
      <div class="slx-detail-title">待施工</div>
      <p>${module.desc}</p>
      <p>这个模块入口已经预留，后续会按施工计划逐步接入真实功能。</p>
    </div>
    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">施工备注</div>
      <p>当前阶段只验证插件 UI、模块导航和设置保存，不读取聊天、不调用 API、不写入楼层。</p>
    </div>
  `;
}

function renderFloatingPanel() {
  const settings = getSettings();
  const activeModule = getActiveModule(settings);

  if (!panelRoot) {
    panelRoot = document.createElement('div');
    panelRoot.id = 'shenling-assistant-panel-root';
    document.body.appendChild(panelRoot);
  }

  panelRoot.innerHTML = `
    <div class="slx-backdrop" data-slx-close="true"></div>
    <section class="slx-panel" data-theme="${settings.theme}">
      <div class="slx-bubbles"><span></span><span></span><span></span><span></span></div>
      <header class="slx-header">
        <div class="slx-brand">
          <span class="slx-brand-mark">🫧</span>
          <span>
            <b>蜃灵助手</b>
            <small>ShenLing Extension</small>
          </span>
        </div>
        <div class="slx-header-actions">
          <button class="slx-icon-btn" type="button" data-slx-theme title="切换主题">${settings.theme === 'dark' ? '☀️' : '🌙'}</button>
          <button class="slx-icon-btn" type="button" data-slx-close="true" title="关闭">×</button>
        </div>
      </header>
      <main class="slx-body">
        <nav class="slx-module-grid">
          ${MODULES.map(module => createModuleButton(module, settings).outerHTML).join('')}
        </nav>
        <section class="slx-detail">
          <div class="slx-detail-head">
            <span class="slx-detail-icon">${activeModule.icon}</span>
            <div>
              <div class="slx-detail-name">${activeModule.title}</div>
              <div class="slx-detail-desc">${activeModule.desc}</div>
            </div>
          </div>
          ${renderModuleDetail(activeModule, settings)}
        </section>
      </main>
    </section>
  `;

  panelRoot.querySelectorAll('[data-slx-close]').forEach(node => {
    node.addEventListener('click', closeFloatingPanel);
  });

  panelRoot.querySelector('[data-slx-theme]')?.addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    saveSettings();
    renderFloatingPanel();
    syncSettingsPanelState();
  });

  panelRoot.querySelectorAll('.slx-module-btn').forEach(button => {
    button.addEventListener('click', () => {
      settings.activeModule = button.dataset.moduleId || 'summary';
      saveSettings();
      renderFloatingPanel();
    });
  });

  const moduleGrid = panelRoot.querySelector('.slx-module-grid');
  if (moduleGrid && Number.isFinite(options.moduleScrollTop)) {
    moduleGrid.scrollTop = options.moduleScrollTop;
  } else {
    panelRoot.querySelector('.slx-module-btn-active')?.scrollIntoView({ block: 'nearest' });
  }

  panelRoot.querySelector('#slx-panel-enabled')?.addEventListener('change', event => {
    settings.enabled = Boolean(event.currentTarget.checked);
    saveSettings();
    syncSettingsPanelState();
  });

  panelRoot.querySelector('#slx-panel-theme')?.addEventListener('change', event => {
    settings.theme = event.currentTarget.checked ? 'dark' : 'light';
    saveSettings();
    renderFloatingPanel();
    syncSettingsPanelState();
  });
}

function openFloatingPanel() {
  renderFloatingPanel();
  panelRoot?.classList.add('slx-panel-open');
}

function closeFloatingPanel() {
  panelRoot?.classList.remove('slx-panel-open');
}

function syncSettingsPanelState() {
  const settings = getSettings();
  const enabledInput = document.querySelector('#shenling-assistant-enabled');
  if (enabledInput) enabledInput.checked = Boolean(settings.enabled);

  const themeLabel = document.querySelector('#shenling-assistant-theme-label');
  if (themeLabel) themeLabel.textContent = settings.theme === 'dark' ? '深色' : '浅色';
}

function renderSettingsPanel() {
  if (document.querySelector('#shenling-assistant-settings')) return;

  const settings = getSettings();
  const container = document.createElement('div');
  container.id = 'shenling-assistant-settings';
  container.className = 'shenling-assistant-settings';
  container.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>蜃灵助手</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="shenling-assistant-card">
          <div class="shenling-assistant-topline">
            <span class="shenling-assistant-badge">0.1.0</span>
            <span>第三方插件已加载</span>
          </div>
          <div class="shenling-assistant-title">蜃灵助手</div>
          <div class="shenling-assistant-desc">独立插件项目空壳。当前用于验证主面板、模块导航和设置保存。</div>
          <button id="shenling-assistant-open" class="shenling-assistant-open-btn" type="button">
            <span>打开蜃灵助手</span>
            <span>›</span>
          </button>
          <label class="checkbox_label shenling-assistant-row" for="shenling-assistant-enabled">
            <input id="shenling-assistant-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
            <span>启用蜃灵助手</span>
          </label>
          <div class="shenling-assistant-status">当前主题：<b id="shenling-assistant-theme-label">${settings.theme === 'dark' ? '深色' : '浅色'}</b></div>
        </div>
      </div>
    </div>
  `;

  const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
  if (!host) {
    console.warn('[蜃灵助手] 未找到扩展设置面板容器。');
    return;
  }

  host.appendChild(container);

  container.querySelector('#shenling-assistant-open')?.addEventListener('click', openFloatingPanel);
  container.querySelector('#shenling-assistant-enabled')?.addEventListener('change', event => {
    settings.enabled = Boolean(event.currentTarget.checked);
    saveSettings();
  });

  console.info('[蜃灵助手] 设置入口已挂载。');
}

function init() {
  console.info('[蜃灵助手] 插件已加载。');
  renderSettingsPanel();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}