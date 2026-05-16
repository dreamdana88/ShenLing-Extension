const MODULE_NAME = 'shenling_assistant';

const defaultSettings = Object.freeze({
  enabled: true,
});

function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getSettings() {
  const context = getContextSafe();
  if (!context?.extensionSettings) {
    return structuredClone(defaultSettings);
  }

  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
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

function renderPanel() {
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
          <div class="shenling-assistant-title">蜃灵助手已加载</div>
          <div class="shenling-assistant-desc">这是第三方插件空壳。当前只用于验证安装、加载和设置保存流程。</div>
          <label class="checkbox_label shenling-assistant-row" for="shenling-assistant-enabled">
            <input id="shenling-assistant-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
            <span>启用蜃灵助手</span>
          </label>
          <div class="shenling-assistant-status">下一步：接入基础面板与副 API 通讯日志。</div>
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

  container.querySelector('#shenling-assistant-enabled')?.addEventListener('change', event => {
    settings.enabled = Boolean(event.currentTarget.checked);
    saveSettings();
    console.info(`[蜃灵助手] enabled = ${settings.enabled}`);
  });

  console.info('[蜃灵助手] 设置面板已挂载。');
}

function init() {
  console.info('[蜃灵助手] 插件空壳已加载。');
  renderPanel();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
