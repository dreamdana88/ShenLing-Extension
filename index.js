import {
  MODULES,
  PLUGIN_VERSION,
} from './src/constants.js';
import {
  cloneData,
  escapeHtml,
  formatTimestamp,
  isPlainObject,
  mergeDefaults,
} from './src/utils/text.js';
import {
  buildModelListUrl,
  getApiModeLabel,
  normalizeApiBaseUrl,
  parseModelListResponse,
} from './src/core/api.js';
import {
  getContextSafe,
} from './src/core/chat.js';
import {
  copyText,
  createCommunicationLog,
  formatCommunicationLogForCopy,
  sanitizeCommunicationLog,
  stringifyLogField,
} from './src/core/logs.js';
import {
  defaultGlobalSettings,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getStorageDiagnostics,
  saveChatState,
  saveGlobalSettings,
} from './src/core/settings.js';
import {
  clearStaleSummaryRunningTask,
  configureSummaryWorkflow,
  registerAutoSummaryEvents,
  scanExistingSummaryState,
} from './src/features/summary/workflow.js';
import {
  bindSummaryPanelEvents,
  configureSummaryPanel,
  refreshSummaryPanelAfterAction,
  renderSummarySettingsPanel,
} from './src/features/summary/panel.js';

let panelRoot = null;
let communicationLogOpen = false;

function syncViewportSize() {
  const viewportHeight = globalThis.visualViewport?.height || globalThis.innerHeight;
  if (viewportHeight) {
    document.documentElement.style.setProperty('--slx-viewport-height', `${viewportHeight}px`);
  }
}

function getCommunicationLogStore(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.communicationLog)) {
    settings.communicationLog = cloneData(defaultGlobalSettings.communicationLog);
  }
  if (!Array.isArray(settings.communicationLog.entries)) {
    settings.communicationLog.entries = [];
  }
  if (!Number.isFinite(settings.communicationLog.maxEntries) || settings.communicationLog.maxEntries < 1) {
    settings.communicationLog.maxEntries = defaultGlobalSettings.communicationLog.maxEntries;
  }
  return settings.communicationLog;
}

function getCommunicationLogs(settings = getGlobalSettings()) {
  return getCommunicationLogStore(settings).entries;
}

function hasFailedCommunicationLog(settings = getGlobalSettings()) {
  return getCommunicationLogs(settings).some(log => log.status === 'failure');
}

function addCommunicationLog(input) {
  const settings = getGlobalSettings();
  const store = getCommunicationLogStore(settings);
  const log = sanitizeCommunicationLog(createCommunicationLog(input), settings);
  store.entries.unshift(log);
  store.entries = store.entries.slice(0, store.maxEntries);
  saveGlobalSettings();
  return log;
}

function clearCommunicationLogs() {
  const settings = getGlobalSettings();
  getCommunicationLogStore(settings).entries = [];
  saveGlobalSettings();
}

function getApiSettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.api)) {
    settings.api = cloneData(defaultGlobalSettings.api);
  }
  settings.api = mergeDefaults(settings.api, cloneData(defaultGlobalSettings.api));
  if (!['secondary_api', 'main_api'].includes(settings.api.mode)) {
    settings.api.mode = 'secondary_api';
  }
  if (!Array.isArray(settings.api.profiles) || settings.api.profiles.length === 0) {
    settings.api.profiles = cloneData(defaultGlobalSettings.api.profiles);
  }
  if (!settings.api.activeProfileId) {
    settings.api.activeProfileId = settings.api.profiles[0].id;
  }

  settings.api.profiles = settings.api.profiles.map((profile, index) => mergeDefaults(profile, {
    id: index === 0 ? 'default' : `profile-${index + 1}`,
    name: index === 0 ? '默认副 API' : `副 API ${index + 1}`,
    baseUrl: '',
    apiKey: '',
    model: '',
    endpointPath: '/v1/chat/completions',
    availableModels: [],
  }));

  return settings.api;
}

function getActiveApiProfile(settings = getGlobalSettings()) {
  const api = getApiSettings(settings);
  let profile = api.profiles.find(item => item.id === api.activeProfileId);
  if (!profile) {
    profile = api.profiles[0];
    api.activeProfileId = profile.id;
  }
  return profile;
}

function createApiProfile(settings = getGlobalSettings()) {
  const api = getApiSettings(settings);
  const profile = {
    id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `副 API ${api.profiles.length + 1}`,
    baseUrl: '',
    apiKey: '',
    model: '',
    endpointPath: '/v1/chat/completions',
    availableModels: [],
  };
  api.profiles.push(profile);
  api.activeProfileId = profile.id;
  return profile;
}

function deleteActiveApiProfile(settings = getGlobalSettings()) {
  const api = getApiSettings(settings);
  if (api.profiles.length <= 1) {
    api.lastTestStatus = '至少保留一个 Profile';
    return false;
  }

  const deleteIndex = api.profiles.findIndex(profile => profile.id === api.activeProfileId);
  if (deleteIndex < 0) {
    return false;
  }

  api.profiles.splice(deleteIndex, 1);
  api.activeProfileId = api.profiles[Math.max(0, deleteIndex - 1)]?.id || api.profiles[0].id;
  api.lastTestStatus = '已删除当前 Profile';
  return true;
}

function renderApiProfileOptions(api) {
  return api.profiles.map(profile => (
    `<option value="${escapeHtml(profile.id)}" ${profile.id === api.activeProfileId ? 'selected' : ''}>${escapeHtml(profile.name || '未命名 Profile')}</option>`
  )).join('');
}

function renderModelOptions(profile) {
  const currentModel = String(profile.model || '').trim();
  const models = Array.isArray(profile.availableModels) ? profile.availableModels.filter(Boolean) : [];
  const options = [...new Set([...models, ...(currentModel ? [currentModel] : [])])];

  if (options.length === 0) {
    return '<option value="">先拉取模型列表</option>';
  }

  return [
    '<option value="">请选择模型</option>',
    ...options.map(model => `<option value="${escapeHtml(model)}" ${model === currentModel ? 'selected' : ''}>${escapeHtml(model)}</option>`),
  ].join('');
}

function getGenerateRawFunction() {
  const context = getContextSafe();
  return globalThis.generateRaw || context?.generateRaw || null;
}

async function fetchSecondaryApiModels() {
  const settings = getGlobalSettings();
  const api = getApiSettings(settings);
  if (api.mode === 'main_api') {
    api.lastTestAt = formatTimestamp();
    api.lastTestStatus = '主 API 模式无需拉取模型';
    addCommunicationLog({
      moduleName: '主 API',
      taskType: '拉取模型',
      status: 'success',
      startedAt: api.lastTestAt,
      model: '酒馆当前连接',
      url: '酒馆当前连接',
      parsedResult: '主 API 使用当前酒馆连接，不需要单独拉取模型。',
    });
    return [];
  }
  const profile = getActiveApiProfile(settings);
  const startedAt = performance.now();
  let url = '';
  let responseText = '';
  let parsedResult = '';

  try {
    url = buildModelListUrl(profile);
    const headers = {};
    if (String(profile.apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
    }

    const response = await fetch(url, { headers });
    responseText = await response.text();
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      parsedResult = '';
    }

    const durationMs = Math.round(performance.now() - startedAt);
    api.lastTestAt = formatTimestamp();

    if (!response.ok) {
      api.lastTestStatus = `拉取失败 HTTP ${response.status}`;
      addCommunicationLog({
        moduleName: '副 API',
        taskType: '拉取模型',
        status: 'failure',
        startedAt: api.lastTestAt,
        durationMs,
        profileName: profile.name,
        model: profile.model,
        url,
        httpStatus: response.status,
        requestBody: null,
        responseText,
        parsedResult,
        errorStack: `HTTP ${response.status} ${response.statusText}`,
      });
      return [];
    }

    const models = parseModelListResponse(parsedResult);
    profile.availableModels = models;
    if (models.length > 0 && (!profile.model || !models.includes(profile.model))) {
      profile.model = models[0];
    }
    api.lastTestStatus = models.length ? `已拉取 ${models.length} 个模型` : '未拉取到模型';

    addCommunicationLog({
      moduleName: '副 API',
      taskType: '拉取模型',
      status: models.length ? 'success' : 'failure',
      startedAt: api.lastTestAt,
      durationMs,
      profileName: profile.name,
      model: profile.model,
      url,
      httpStatus: response.status,
      requestBody: null,
      responseText,
      parsedResult: models,
      errorStack: models.length ? '' : '响应中没有可用模型。',
    });

    return models;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    api.lastTestAt = formatTimestamp();
    api.lastTestStatus = `拉取失败：${error.message || error}`;

    addCommunicationLog({
      moduleName: '副 API',
      taskType: '拉取模型',
      status: 'failure',
      startedAt: api.lastTestAt,
      durationMs,
      profileName: profile.name,
      model: profile.model,
      url,
      requestBody: null,
      responseText,
      parsedResult,
      errorStack: error.stack || error.message || error,
    });

    return [];
  }
}
function getActiveModule(settings = getGlobalSettings()) {
  return MODULES.find(item => item.id === settings.activeModule) ?? MODULES[0];
}

function createModuleButton(module, settings) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `slx-module-btn${settings.activeModule === module.id ? ' slx-module-btn-active' : ''}`;
  button.dataset.moduleId = module.id;
  button.title = module.title;
  button.setAttribute('aria-label', module.title);
  button.innerHTML = `
    <span class="slx-module-icon">${module.icon}</span>
    <span class="slx-module-short">${escapeHtml(module.shortTitle || module.title)}</span>
    <span class="slx-module-text">
      <b>${escapeHtml(module.title)}</b>
      <small>${escapeHtml(module.desc)}</small>
    </span>
  `;
  return button;
}

function renderDiagnosticLine(label, value) {
  return `<div class="slx-info-line"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function renderLogDetailBlock(title, value) {
  const content = stringifyLogField(value);
  if (!content) {
    return '';
  }

  return `
    <details class="slx-log-details">
      <summary>${escapeHtml(title)}</summary>
      <pre>${escapeHtml(content)}</pre>
    </details>
  `;
}

function renderCommunicationLogPanel(settings) {
  if (!communicationLogOpen) {
    return '';
  }

  const logs = getCommunicationLogs(settings);
  const failedCount = logs.filter(log => log.status === 'failure').length;
  const emptyContent = `
    <div class="slx-log-empty">
      <div class="slx-log-empty-icon">📡</div>
      <b>暂无通讯记录</b>
      <p>后续插件自己调用 API 时，请求、响应和报错会统一写到这里。</p>
    </div>
  `;
  const logItems = logs.map(log => `
    <article class="slx-log-item slx-log-item-${log.status}" data-slx-log-id="${escapeHtml(log.id)}">
      <div class="slx-log-item-head">
        <span class="slx-log-status">${log.status === 'failure' ? '失败' : '成功'}</span>
        <div class="slx-log-summary">
          <b>${escapeHtml(log.moduleName)} / ${escapeHtml(log.taskType)}</b>
          <small>${escapeHtml(log.startedAt)}${log.durationMs === null ? '' : ` · ${escapeHtml(log.durationMs)}ms`}</small>
        </div>
        <button class="slx-soft-btn slx-log-copy-btn" type="button" data-slx-copy-log="${escapeHtml(log.id)}">复制</button>
      </div>
      <div class="slx-log-meta">
        <span>Profile：${escapeHtml(log.profileName || '未记录')}</span>
        <span>模型：${escapeHtml(log.model || '未记录')}</span>
        <span>HTTP：${escapeHtml(log.httpStatus || '未记录')}</span>
      </div>
      ${renderLogDetailBlock('messages', log.messages)}
      ${renderLogDetailBlock('请求体', log.requestBody)}
      ${renderLogDetailBlock('响应全文', log.responseText)}
      ${renderLogDetailBlock('解析结果', log.parsedResult)}
      ${renderLogDetailBlock('错误信息', log.errorStack)}
    </article>
  `).join('');

  return `
    <aside class="slx-log-panel" aria-label="通讯日志">
      <div class="slx-log-head">
        <div>
          <div class="slx-log-title">通讯日志</div>
          <div class="slx-log-subtitle">最近 ${escapeHtml(getCommunicationLogStore(settings).maxEntries)} 次插件 API 通讯${failedCount ? `，${escapeHtml(failedCount)} 条失败` : ''}</div>
        </div>
        <div class="slx-log-actions">
          <button class="slx-soft-btn" type="button" data-slx-clear-logs ${logs.length ? '' : 'disabled'}>清空</button>
          <button class="slx-icon-btn" type="button" data-slx-log-close title="关闭通讯日志">×</button>
        </div>
      </div>
      <div class="slx-log-list">
        ${logs.length ? logItems : emptyContent}
      </div>
    </aside>
  `;
}

function renderApiSettingsPanel(settings) {
  const api = getApiSettings(settings);
  const profile = getActiveApiProfile(settings);
  const isMainApi = api.mode === 'main_api';
  const disabled = isMainApi ? 'disabled' : '';

  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">总结 API 设置</div>
      <p>${isMainApi ? '当前使用酒馆主 API，同步沿用你正在聊天的连接。' : '当前使用独立副 API，适合把总结任务分流到另一套模型。'} API Key 只保存在本地扩展设置中，不会写入通讯日志。</p>
      <div class="slx-segment-row" role="group" aria-label="总结 API 模式">
        <button class="slx-segment-btn ${api.mode === 'secondary_api' ? 'slx-segment-btn-active' : ''}" type="button" data-slx-api-mode="secondary_api">独立副 API</button>
        <button class="slx-segment-btn ${api.mode === 'main_api' ? 'slx-segment-btn-active' : ''}" type="button" data-slx-api-mode="main_api">使用主 API</button>
      </div>
      <div class="slx-field-hint">当前：${escapeHtml(getApiModeLabel(api))}。使用主 API 时无需填写下方独立接口配置。</div>
      <div class="slx-api-config ${isMainApi ? 'slx-api-config-disabled' : ''}">
        <div class="slx-profile-bar">
          <label class="slx-field">
            <span>当前 Profile</span>
            <select data-slx-api-profile-select ${disabled}>${renderApiProfileOptions(api)}</select>
          </label>
          <div class="slx-profile-actions">
            <button class="slx-soft-btn" type="button" data-slx-new-api-profile ${disabled}>新增</button>
            <button class="slx-soft-btn" type="button" data-slx-delete-api-profile ${api.profiles.length <= 1 || isMainApi ? 'disabled' : ''}>删除</button>
          </div>
        </div>
        <div class="slx-form-grid">
          <label class="slx-field">
            <span>Profile 名称</span>
            <input type="text" data-slx-api-field="name" value="${escapeHtml(profile.name)}" placeholder="默认副 API" ${disabled} />
          </label>
          <label class="slx-field">
            <span>请求地址</span>
            <input type="text" data-slx-api-field="baseUrl" value="${escapeHtml(profile.baseUrl)}" placeholder="https://api.example.com" ${disabled} />
          </label>
          <label class="slx-field">
            <span>API Key</span>
            <div class="slx-secret-field">
              <input type="password" data-slx-api-field="apiKey" value="${escapeHtml(profile.apiKey)}" placeholder="sk-..." autocomplete="off" ${disabled} />
              <button class="slx-secret-toggle" type="button" data-slx-toggle-api-key title="显示 API Key" aria-label="显示 API Key" ${disabled}><i class="fa-solid fa-eye"></i></button>
            </div>
          </label>
          <label class="slx-field">
            <span>模型名</span>
            <select data-slx-api-field="model" ${disabled}>${renderModelOptions(profile)}</select>
          </label>
        </div>
      </div>
      <div class="slx-api-actions">
        <button class="slx-soft-btn" type="button" data-slx-save-api>${isMainApi ? '保存模式' : '保存配置'}</button>
        <button class="slx-soft-btn" type="button" data-slx-fetch-models ${disabled}>拉取模型</button>
      </div>
      <div class="slx-api-status">
        <span>最近操作：${escapeHtml(api.lastTestAt || '尚未操作')}</span>
        <b>${escapeHtml(api.lastTestStatus || '未记录')}</b>
      </div>
    </div>
  `;
}
function renderModuleDetail(module, settings) {
  const info = getContextInfo();
  const chatState = getChatState();
  const diagnostics = getStorageDiagnostics();

  if (module.id === 'summary') {
    return renderSummarySettingsPanel(settings, chatState);
  }

  if (module.id === 'settings') {
    return `

      ${renderApiSettingsPanel(settings)}
      <div class="slx-detail-card">
        <div class="slx-detail-title">存储测试</div>
        <p>先验证插件自己的抽屉：全局设置进扩展设置，聊天状态进当前聊天 metadata。</p>
        <div class="slx-action-row">
          <button class="slx-soft-btn" type="button" data-slx-write-global>写入全局测试值</button>
          <button class="slx-soft-btn" type="button" data-slx-write-chat>写入当前聊天测试值</button>
        </div>
      </div>
      <div class="slx-detail-card slx-muted-card">
        <div class="slx-detail-title">当前环境</div>
        ${renderDiagnosticLine('角色', info.characterName)}
        ${renderDiagnosticLine('角色 ID', info.characterId || '未读取')}
        ${renderDiagnosticLine('聊天', info.chatName)}
        ${renderDiagnosticLine('聊天 ID', info.chatId || '未读取')}
        ${renderDiagnosticLine('版本', PLUGIN_VERSION)}
      </div>
      <div class="slx-detail-card slx-muted-card">
        <div class="slx-detail-title">状态诊断</div>
        ${renderDiagnosticLine('全局设置键', diagnostics.globalKey)}
        ${renderDiagnosticLine('聊天状态键', diagnostics.chatKey)}
        ${renderDiagnosticLine('扩展设置可用', diagnostics.hasExtensionSettings ? '是' : '否')}
        ${renderDiagnosticLine('聊天 metadata 可用', diagnostics.hasChatMetadata ? '是' : '否')}
        ${renderDiagnosticLine('全局保存函数', diagnostics.canSaveGlobal ? '可用' : '未发现')}
        ${renderDiagnosticLine('聊天保存函数', diagnostics.canSaveChat ? '可用' : '未发现，暂用设置保存兜底')}
        ${renderDiagnosticLine('全局测试值', diagnostics.globalProbe)}
        ${renderDiagnosticLine('聊天测试值', diagnostics.chatProbe)}
        ${renderDiagnosticLine('通讯日志数', getCommunicationLogs(settings).length)}
        ${renderDiagnosticLine('全局最近保存', diagnostics.globalLastSavedAt)}
        ${renderDiagnosticLine('聊天最近保存', diagnostics.chatLastSavedAt)}
      </div>
    `;
  }

  return `
    <div class="slx-detail-card">
      <div class="slx-detail-kicker">${module.icon} ${escapeHtml(module.title)}</div>
      <div class="slx-detail-title">待施工</div>
      <p>${escapeHtml(module.desc)}</p>
      <p>这个模块入口已经预留，后续会按施工计划逐步接入真实功能。</p>
    </div>
    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">当前聊天状态占位</div>
      ${renderDiagnosticLine('小总结计数', chatState.summary.smallSummaryCount)}
      ${renderDiagnosticLine('回忆录条目数', chatState.memoir.entryCount)}
      ${renderDiagnosticLine('平行事件时间', chatState.parallel.lastParallelEventTime || '尚未记录')}
      <p>当前阶段只验证插件 UI、模块导航和设置保存，不读取聊天、不调用 API、不写入楼层。</p>
    </div>
  `;
}

function renderFloatingPanel(options = {}) {
  const settings = getGlobalSettings();
  const activeModule = getActiveModule(settings);

  if (!panelRoot) {
    panelRoot = document.createElement('div');
    panelRoot.id = 'shenling-assistant-panel-root';
    document.body.appendChild(panelRoot);
  }

  panelRoot.innerHTML = `
    <div class="slx-backdrop" data-slx-close="true"></div>
    <section class="slx-panel" data-theme="${escapeHtml(settings.theme)}">
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
          <button class="slx-icon-btn slx-log-toggle${hasFailedCommunicationLog(settings) ? ' slx-log-toggle-alert' : ''}" type="button" data-slx-log-toggle title="通讯日志">📡</button>
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
              <div class="slx-detail-name">${escapeHtml(activeModule.title)}</div>
              <div class="slx-detail-desc">${escapeHtml(activeModule.desc)}</div>
            </div>
          </div>
          ${renderModuleDetail(activeModule, settings)}
        </section>
      </main>
      ${renderCommunicationLogPanel(settings)}
    </section>
  `;

  panelRoot.querySelectorAll('[data-slx-close]').forEach(node => {
    node.addEventListener('click', closeFloatingPanel);
  });

  panelRoot.querySelector('[data-slx-theme]')?.addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    saveGlobalSettings();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });

  panelRoot.querySelector('[data-slx-log-toggle]')?.addEventListener('click', () => {
    communicationLogOpen = !communicationLogOpen;
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
  });

  panelRoot.querySelector('[data-slx-log-close]')?.addEventListener('click', () => {
    communicationLogOpen = false;
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
  });

  panelRoot.querySelector('[data-slx-clear-logs]')?.addEventListener('click', () => {
    clearCommunicationLogs();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });

  panelRoot.querySelectorAll('[data-slx-copy-log]').forEach(button => {
    button.addEventListener('click', async () => {
      const logId = button.dataset.slxCopyLog;
      const log = getCommunicationLogs().find(item => item.id === logId);
      if (!log) return;

      try {
        await copyText(formatCommunicationLogForCopy(log));
        button.textContent = '已复制';
        setTimeout(() => {
          button.textContent = '复制';
        }, 1200);
      } catch (error) {
        console.warn('[蜃灵助手] 复制通讯日志失败。', error);
        button.textContent = '失败';
      }
    });
  });

  const syncApiFormToSettings = () => {
    const profile = getActiveApiProfile(settings);
    panelRoot.querySelectorAll('[data-slx-api-field]').forEach(input => {
      const field = input.dataset.slxApiField;
      if (field && Object.hasOwn(profile, field)) {
        profile[field] = input.value;
      }
    });
    profile.endpointPath = '/v1/chat/completions';
  };

  panelRoot.querySelectorAll('[data-slx-api-mode]').forEach(button => {
    button.addEventListener('click', () => {
      syncApiFormToSettings();
      const api = getApiSettings(settings);
      api.mode = button.dataset.slxApiMode === 'main_api' ? 'main_api' : 'secondary_api';
      saveGlobalSettings();
      renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
      syncSettingsPanelState();
    });
  });

  panelRoot.querySelector('[data-slx-api-profile-select]')?.addEventListener('change', event => {
    syncApiFormToSettings();
    getApiSettings(settings).activeProfileId = event.currentTarget.value;
    saveGlobalSettings();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });

  panelRoot.querySelector('[data-slx-new-api-profile]')?.addEventListener('click', () => {
    syncApiFormToSettings();
    createApiProfile(settings);
    saveGlobalSettings();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });

  panelRoot.querySelector('[data-slx-delete-api-profile]')?.addEventListener('click', () => {
    if (!confirm('删除当前 API Profile？')) {
      return;
    }
    deleteActiveApiProfile(settings);
    saveGlobalSettings();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });

  panelRoot.querySelector('[data-slx-toggle-api-key]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    const input = panelRoot.querySelector('[data-slx-api-field="apiKey"]');
    if (!input) return;

    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    button.innerHTML = `<i class="fa-solid ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
    button.title = isHidden ? '隐藏 API Key' : '显示 API Key';
    button.setAttribute('aria-label', button.title);
  });

  panelRoot.querySelector('[data-slx-save-api]')?.addEventListener('click', event => {
    syncApiFormToSettings();
    saveGlobalSettings();
    event.currentTarget.textContent = '已保存';
    setTimeout(() => {
      event.currentTarget.textContent = getApiSettings(settings).mode === 'main_api' ? '保存模式' : '保存配置';
    }, 1200);
    syncSettingsPanelState();
  });

  panelRoot.querySelector('[data-slx-fetch-models]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    syncApiFormToSettings();
    saveGlobalSettings();
    button.disabled = true;
    button.textContent = '拉取中...';

    await fetchSecondaryApiModels();
    saveGlobalSettings();

    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });


  bindSummaryPanelEvents(panelRoot, settings);

  panelRoot.querySelectorAll('.slx-module-btn').forEach(button => {
    button.addEventListener('click', () => {
      const moduleGrid = panelRoot.querySelector('.slx-module-grid');
      settings.activeModule = button.dataset.moduleId || 'summary';
      saveGlobalSettings();
      renderFloatingPanel({ moduleScrollTop: moduleGrid?.scrollTop ?? 0 });
    });
  });

  const moduleGrid = panelRoot.querySelector('.slx-module-grid');
  if (moduleGrid && Number.isFinite(options.moduleScrollTop)) {
    moduleGrid.scrollTop = options.moduleScrollTop;
  } else {
    panelRoot.querySelector('.slx-module-btn-active')?.scrollIntoView({ block: 'nearest' });
  }

  const detailPanel = panelRoot.querySelector('.slx-detail');
  if (detailPanel && Number.isFinite(options.detailScrollTop)) {
    detailPanel.scrollTop = options.detailScrollTop;
  }


  panelRoot.querySelector('[data-slx-write-global]')?.addEventListener('click', () => {
    settings.diagnostics.globalProbe = `全局 ${formatTimestamp()}`;
    saveGlobalSettings();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });

  panelRoot.querySelector('[data-slx-write-chat]')?.addEventListener('click', () => {
    const chatState = getChatState();
    chatState.diagnostics.chatProbe = `聊天 ${formatTimestamp()}`;
    saveChatState();
    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
  });
}

function openFloatingPanel() {
  const settings = getGlobalSettings();
  settings.ui.lastOpenedAt = formatTimestamp();
  saveGlobalSettings();
  syncViewportSize();
  scanExistingSummaryState();
  registerAutoSummaryEvents();
  renderFloatingPanel();
  document.body.classList.add('slx-panel-open-lock');
  panelRoot?.classList.add('slx-panel-open');
}

function closeFloatingPanel() {
  panelRoot?.classList.remove('slx-panel-open');
  document.body.classList.remove('slx-panel-open-lock');
  communicationLogOpen = false;
}

function syncSettingsPanelState() {
  const settings = getGlobalSettings();
  const enabledInput = document.querySelector('#shenling-assistant-enabled');
  if (enabledInput) enabledInput.checked = Boolean(settings.enabled);

  const themeLabel = document.querySelector('#shenling-assistant-theme-label');
  if (themeLabel) themeLabel.textContent = settings.theme === 'dark' ? '深色' : '浅色';

  const savedLabel = document.querySelector('#shenling-assistant-saved-label');
  if (savedLabel) savedLabel.textContent = settings.diagnostics.lastSavedAt || '尚未保存';
}

function renderSettingsPanel() {
  if (document.querySelector('#shenling-assistant-settings')) return;

  const settings = getGlobalSettings();
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
            <span class="shenling-assistant-badge">${PLUGIN_VERSION}</span>
            <span>第三方插件已加载</span>
          </div>
          <div class="shenling-assistant-title">蜃灵助手</div>
          <div class="shenling-assistant-desc">独立插件项目。当前已接入设置、通讯日志、副 API 配置与自动小总结外壳。</div>
          <button id="shenling-assistant-open" class="shenling-assistant-open-btn" type="button">
            <span>打开蜃灵助手</span>
            <span>›</span>
          </button>
          <label class="checkbox_label shenling-assistant-row" for="shenling-assistant-enabled">
            <input id="shenling-assistant-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
            <span>启用蜃灵助手</span>
          </label>
          <div class="shenling-assistant-status">当前主题：<b id="shenling-assistant-theme-label">${settings.theme === 'dark' ? '深色' : '浅色'}</b></div>
          <div class="shenling-assistant-status">最近保存：<b id="shenling-assistant-saved-label">${escapeHtml(settings.diagnostics.lastSavedAt || '尚未保存')}</b></div>
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
    saveGlobalSettings();
    syncSettingsPanelState();
  });

  console.info('[蜃灵助手] 设置入口已挂载。');
}

function init() {
  console.info('[蜃灵助手] 插件已加载。');
  syncViewportSize();
  globalThis.addEventListener?.('resize', syncViewportSize, { passive: true });
  globalThis.visualViewport?.addEventListener?.('resize', syncViewportSize, { passive: true });
  globalThis.visualViewport?.addEventListener?.('scroll', syncViewportSize, { passive: true });
  configureSummaryPanel({
    getActiveApiProfile,
    getApiSettings,
    getPanelRoot: () => panelRoot,
    refreshPanel: renderFloatingPanel,
    syncSettingsPanelState,
  });
  configureSummaryWorkflow({
    addCommunicationLog,
    getActiveApiProfile,
    getApiSettings,
    getGenerateRawFunction,
    refreshSummaryPanel: refreshSummaryPanelAfterAction,
  });
  getGlobalSettings();
  getChatState();
  clearStaleSummaryRunningTask('插件重新加载');
  scanExistingSummaryState();
  registerAutoSummaryEvents();
  renderSettingsPanel();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
