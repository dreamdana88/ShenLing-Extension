const MODULE_NAME = 'shenling_assistant';
const CHAT_STATE_KEY = `${MODULE_NAME}_chat_state`;
const STORAGE_VERSION = 1;
const PLUGIN_VERSION = '0.5.0';
const DEFAULT_SUMMARY_INCLUDE_TAGS = Object.freeze(['content']);
const DEFAULT_SUMMARY_EXCLUDE_TAGS = Object.freeze(['thinking', 'wave']);

const MODULES = [
  { id: 'summary', icon: '🫧', shortTitle: '总结', title: '自动总结', desc: '副 API、小总结、大总结与归档管理。' },
  { id: 'outline', icon: '🧭', shortTitle: '剧情', title: '剧情规划', desc: '故事大纲、主线阶段与当前剧情节点。' },
  { id: 'memoir', icon: '📚', shortTitle: '回忆', title: '回忆录世界书', desc: '关键节点提炼、绿灯关键词与聊天专属回忆录。' },
  { id: 'pursuit', icon: '💘', shortTitle: '攻略', title: '逆攻略', desc: '让角色在不崩人设的前提下主动推进关系。' },
  { id: 'parallel', icon: '🌈', shortTitle: '平行', title: '平行事件', desc: '基于时间轴低频续写不在场角色动态。' },
  { id: 'profile', icon: '🎭', shortTitle: '档案', title: '角色档案', desc: '关系阶段、情感变化、角色目标与隐秘动机。' },
  { id: 'diary', icon: '📓', shortTitle: '日记', title: '日程日记', desc: '七日程表、普通日记与交换日记。' },
  { id: 'inspire', icon: '✨', shortTitle: '灵感', title: '灵感工具', desc: '小剧场、分支选项、冲突事件与场景推进。' },
  { id: 'replace', icon: '🈲', shortTitle: '替换', title: '词汇替换', desc: '用户词库、替换预览与当前楼层重新替换。' },
  { id: 'settings', icon: '⚙️', shortTitle: '设置', title: '设置', desc: '副 API、存储诊断与通讯日志。' },
];

const defaultGlobalSettings = Object.freeze({
  schemaVersion: STORAGE_VERSION,
  enabled: true,
  theme: 'light',
  activeModule: 'summary',
  ui: {
    lastOpenedAt: '',
  },
  modules: {
    summary: {
      enabled: false,
      autoGrandMemoryEnabled: false,
      grandMemoryInterval: 6,
      intervalMessages: 1,
      sourceTags: {
        includeTags: [...DEFAULT_SUMMARY_INCLUDE_TAGS],
        excludeTags: [...DEFAULT_SUMMARY_EXCLUDE_TAGS],
      },
      promptTemplate: [
        '##浓缩梦境',
        '',
        '必须输出<memory>结构化总结，并严格使用以下格式进行封装：',
        '',
        '<memory>',
        '<number>',
        '自然顺序编号，如 `1`、`2`，承接上轮递增。',
        '</number>',
        '',
        '<worldstate>',
        '时间：${精确日期 + 当前时段}',
        '地点：${所在地点}',
        '人物：${列举在场角色}',
        '</worldstate>',
        '',
        '<currentTask>',
        '一句话简述当前主线目标',
        '</currentTask>',
        '',
        '<plot>',
        '以自然语言用第三人称客观梳理总结本轮演出剧情 (200 token)，必须包含：用户输入内容、关键事件/情节进展、重要互动、情绪变化、特殊世界规则发现或剧情推进。',
        '{{user}}：${1句最关键的对话(可无)}',
        '主要角色：${1句最关键的对话(可无)}',
        '</plot>',
        '',
        '<psychology>',
        '（非{{user}}主要角色情感变化）：',
        '${角色名}',
        '- 情感分层：{(日常/深入/高峰)简要描述+变化方向}',
        '- 情感关系：{人物关系的变化倾向(30字)}',
        '</psychology>',
        '',
        '<list>',
        '根据角色人设、职业背景、生活作息等，简要列出角色当天日程表与行动安排（至就寝时间），随时间推进进行check',
        '',
        '格式:',
        '${日期}-${角色名}',
        '${早/中/晚}:${序号}.${日程安排内容} ${预期完成时间（x时-y时）}',
        '隐私:${想隐藏的秘密}',
        '好奇:${想探究的好奇}',
        '当前目标:${一句话简述近期要达成的目标}',
        '</list>',
        '',
        '<database>',
        '- 重要物品/概念解锁:',
        '记录本轮中首次出现的、重要的物品或概念。',
        '</database>',
        '</memory>',
        '',
        '重要：<memory>内容应足够独立，即使没有正文，也能让人了解故事发展。总字数不超过400字。',
      ].join('\n'),
    },
    memoir: {
      mode: 'ask_after_archive',
    },
    parallel: {
      enabled: false,
      triggerMode: 'manual_and_timed',
      thresholdMinutes: 60,
      appendToChat: true,
    },
  },
  communicationLog: {
    maxEntries: 10,
    entries: [],
  },
  api: {
    mode: 'secondary_api',
    activeProfileId: 'default',
    lastTestAt: '',
    lastTestStatus: '',
    profiles: [
      {
        id: 'default',
        name: '默认副 API',
        baseUrl: '',
        apiKey: '',
        model: '',
        endpointPath: '/v1/chat/completions',
        availableModels: [],
      },
    ],
  },
  diagnostics: {
    globalProbe: '',
    lastSavedAt: '',
  },
});

const defaultChatState = Object.freeze({
  schemaVersion: STORAGE_VERSION,
  identity: {
    characterId: '',
    characterName: '',
    chatId: '',
    chatName: '',
  },
  summary: {
    smallSummaryCount: 0,
    memoryCountSinceArchive: 0,
    memoryCountedMessageIds: [],
    lastSummaryMessageId: null,
    lastGrandSummaryMessageId: null,
    lastSummaryAt: '',
    lastArchiveId: '',
    archiveRecords: [],
    runningTask: 'none',
    lastError: '',
  },
  outline: {
    currentOutlineId: '',
    currentNodeId: '',
  },
  memoir: {
    worldBookId: '',
    worldBookName: '',
    entryCount: 0,
  },
  parallel: {
    lastParallelEventTime: '',
    lastParallelEventMessageId: null,
  },
  diagnostics: {
    chatProbe: '',
    lastSavedAt: '',
  },
});

let panelRoot = null;
let communicationLogOpen = false;

function syncViewportSize() {
  const viewportHeight = globalThis.visualViewport?.height || globalThis.innerHeight;
  if (viewportHeight) {
    document.documentElement.style.setProperty('--slx-viewport-height', `${viewportHeight}px`);
  }
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(target, defaults) {
  const output = isPlainObject(target) ? target : {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (isPlainObject(defaultValue)) {
      output[key] = mergeDefaults(output[key], defaultValue);
    } else if (!Object.hasOwn(output, key)) {
      output[key] = cloneData(defaultValue);
    }
  }

  return output;
}

function formatTimestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTagName(value) {
  return String(value || '')
    .trim()
    .replace(/^<\/?/, '')
    .replace(/>$/, '')
    .replace(/\s.*$/, '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function parseTagList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,，、;；\s]+/);
  return [...new Set(items.map(normalizeTagName).filter(Boolean))];
}

function formatTagList(value) {
  return parseTagList(value).join('\n');
}

function getSummarySourceTags(summary) {
  if (!isPlainObject(summary.sourceTags)) {
    summary.sourceTags = {};
  }
  summary.sourceTags.includeTags = Object.hasOwn(summary.sourceTags, 'includeTags')
    ? parseTagList(summary.sourceTags.includeTags)
    : [...DEFAULT_SUMMARY_INCLUDE_TAGS];
  summary.sourceTags.excludeTags = Object.hasOwn(summary.sourceTags, 'excludeTags')
    ? parseTagList(summary.sourceTags.excludeTags)
    : [...DEFAULT_SUMMARY_EXCLUDE_TAGS];
  const oldDefaultExcludeTags = ['thinking', 'wave', 'memory', 'grand_memory'];
  if (oldDefaultExcludeTags.every(tag => summary.sourceTags.excludeTags.includes(tag)) && summary.sourceTags.excludeTags.length === oldDefaultExcludeTags.length) {
    summary.sourceTags.excludeTags = [...DEFAULT_SUMMARY_EXCLUDE_TAGS];
  }
  return summary.sourceTags;
}

function stripTaggedBlocks(content, tags) {
  return parseTagList(tags).reduce((text, tag) => {
    const safeTag = escapeRegExp(tag);
    const blockRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeTag}>`, 'gi');
    const selfClosingRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?\\/>`, 'gi');
    return text.replace(blockRe, '').replace(selfClosingRe, '');
  }, String(content || ''));
}

function extractTaggedBlocks(content, tags) {
  const source = String(content || '');
  return parseTagList(tags).flatMap(tag => {
    const safeTag = escapeRegExp(tag);
    const blockRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`, 'gi');
    return Array.from(source.matchAll(blockRe)).map(match => match[1].trim()).filter(Boolean);
  });
}

function extractSummarySourceContent(content, summary = getSummarySettings()) {
  const tags = getSummarySourceTags(summary);
  const withoutExcluded = stripTaggedBlocks(content, tags.excludeTags).replace(/\n{3,}/g, '\n\n').trim();
  const includedBlocks = extractTaggedBlocks(withoutExcluded, tags.includeTags);
  return (includedBlocks.length ? includedBlocks.join('\n\n') : withoutExcluded).trim();
}

function stringifyLogField(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createCommunicationLog(input = {}) {
  return {
    id: input.id || `slx-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    moduleName: input.moduleName || '未指定模块',
    taskType: input.taskType || '未指定任务',
    status: input.status === 'failure' ? 'failure' : 'success',
    startedAt: input.startedAt || formatTimestamp(),
    durationMs: Number.isFinite(input.durationMs) ? input.durationMs : null,
    profileName: input.profileName || '',
    model: input.model || '',
    url: input.url || '',
    httpStatus: input.httpStatus || '',
    messages: input.messages ?? '',
    requestBody: input.requestBody ?? '',
    responseText: input.responseText ?? '',
    parsedResult: input.parsedResult ?? '',
    errorStack: input.errorStack || input.error?.stack || input.error?.message || input.error || '',
  };
}

function getKnownApiKeys(settings = getGlobalSettings()) {
  const profiles = getApiSettings(settings).profiles;
  return profiles
    .map(profile => String(profile.apiKey || '').trim())
    .filter(key => key.length >= 4);
}

function redactText(value, knownKeys = []) {
  let text = String(value);
  knownKeys.forEach(key => {
    text = text.split(key).join('[已隐藏 API Key]');
  });

  return text
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"',}]+/gi, '$1[已隐藏 API Key]')
    .replace(/((?:api[_-]?key|access[_-]?token|key)\s*["']?\s*[:=]\s*["']?)[^"',\s}&]+/gi, '$1[已隐藏 API Key]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|key)=)[^&\s]+/gi, '$1[已隐藏 API Key]');
}

function redactLogValue(value, knownKeys = []) {
  if (typeof value === 'string') {
    return redactText(value, knownKeys);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactLogValue(item, knownKeys));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('apikey') || lowerKey.includes('api_key') || lowerKey.includes('authorization') || lowerKey.includes('token')) {
        return [key, '[已隐藏 API Key]'];
      }
      return [key, redactLogValue(item, knownKeys)];
    }));
  }
  return value;
}

function sanitizeCommunicationLog(log, settings = getGlobalSettings()) {
  const knownKeys = getKnownApiKeys(settings);
  return {
    ...log,
    url: redactLogValue(log.url, knownKeys),
    messages: redactLogValue(log.messages, knownKeys),
    requestBody: redactLogValue(log.requestBody, knownKeys),
    responseText: redactLogValue(log.responseText, knownKeys),
    parsedResult: redactLogValue(log.parsedResult, knownKeys),
    errorStack: redactLogValue(log.errorStack, knownKeys),
  };
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

function formatCommunicationLogForCopy(log) {
  return [
    `模块：${log.moduleName}`,
    `任务：${log.taskType}`,
    `状态：${log.status === 'failure' ? '失败' : '成功'}`,
    `时间：${log.startedAt}`,
    `耗时：${log.durationMs === null ? '未记录' : `${log.durationMs}ms`}`,
    `API Profile：${log.profileName || '未记录'}`,
    `模型：${log.model || '未记录'}`,
    `请求地址：${log.url || '未记录'}`,
    `HTTP 状态：${log.httpStatus || '未记录'}`,
    '',
    '【messages】',
    stringifyLogField(log.messages) || '未记录',
    '',
    '【请求体】',
    stringifyLogField(log.requestBody) || '未记录',
    '',
    '【响应全文】',
    stringifyLogField(log.responseText) || '未记录',
    '',
    '【解析结果】',
    stringifyLogField(log.parsedResult) || '未记录',
    '',
    '【错误信息】',
    stringifyLogField(log.errorStack) || '未记录',
  ].join('\n');
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
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

function normalizeApiPath(path) {
  const raw = String(path || '/v1/chat/completions').trim();
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeApiBaseUrl(url) {
  let normalized = String(url || '').trim().replace(/\/+$/, '');
  if (normalized.toLowerCase().endsWith('/v1')) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

function buildApiUrl(profile) {
  const baseUrl = normalizeApiBaseUrl(profile.baseUrl);
  if (!baseUrl) {
    throw new Error('请先填写请求地址。');
  }
  return `${baseUrl}${normalizeApiPath(profile.endpointPath)}`;
}

function buildModelListUrl(profile) {
  const baseUrl = normalizeApiBaseUrl(profile.baseUrl);
  if (!baseUrl) {
    throw new Error('请先填写请求地址。');
  }
  return `${baseUrl}/v1/models`;
}

function parseModelListResponse(data) {
  const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return [...new Set(rawModels
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.id === 'string') return item.id;
      return '';
    })
    .filter(Boolean))];
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

function getApiTestMessages() {
  return [
    { role: 'system', content: '你是蜃灵助手的副 API 连通性测试。' },
    { role: 'user', content: '请只回复 OK。' },
  ];
}

function getGenerateRawFunction() {
  const context = getContextSafe();
  return globalThis.generateRaw || context?.generateRaw || null;
}

function getApiModeLabel(api) {
  return api.mode === 'main_api' ? '使用主 API' : '独立副 API';
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
async function testSecondaryApiConnection() {
  const settings = getGlobalSettings();
  const api = getApiSettings(settings);
  const startedAt = performance.now();
  const messages = getApiTestMessages();
  let url = '';
  let requestBody = null;

  if (api.mode === 'main_api') {
    url = '酒馆当前连接';
    requestBody = {
      user_input: '请只回复 OK。',
      ordered_prompts: [{ role: 'system', content: '你是蜃灵助手的主 API 连通性测试。' }],
      should_silence: true,
      max_chat_history: 0,
    };

    try {
      const generateRaw = getGenerateRawFunction();
      if (typeof generateRaw !== 'function') {
        throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
      }
      const result = await generateRaw(requestBody);
      const durationMs = Math.round(performance.now() - startedAt);
      api.lastTestAt = formatTimestamp();
      api.lastTestStatus = '主 API 成功';
      addCommunicationLog({
        moduleName: '主 API',
        taskType: '测试连接',
        status: 'success',
        startedAt: api.lastTestAt,
        durationMs,
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url,
        messages,
        requestBody,
        responseText: result,
        parsedResult: result,
      });
      return true;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      api.lastTestAt = formatTimestamp();
      api.lastTestStatus = `主 API 失败：${error.message || error}`;
      addCommunicationLog({
        moduleName: '主 API',
        taskType: '测试连接',
        status: 'failure',
        startedAt: api.lastTestAt,
        durationMs,
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url,
        messages,
        requestBody,
        errorStack: error.stack || error.message || error,
      });
      return false;
    }
  }

  const profile = getActiveApiProfile(settings);

  try {
    url = buildApiUrl(profile);
    if (!String(profile.model || '').trim()) {
      throw new Error('请先填写模型名。');
    }

    requestBody = {
      model: String(profile.model).trim(),
      messages,
      temperature: 0,
      max_tokens: 16,
      stream: false,
    };

    const headers = {
      'Content-Type': 'application/json',
    };
    if (String(profile.apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text();
    let parsedResult = '';
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      parsedResult = '';
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const status = response.ok ? 'success' : 'failure';
    api.lastTestAt = formatTimestamp();
    api.lastTestStatus = response.ok ? '成功' : `失败 HTTP ${response.status}`;

    addCommunicationLog({
      moduleName: '副 API',
      taskType: '测试连接',
      status,
      startedAt: api.lastTestAt,
      durationMs,
      profileName: profile.name,
      model: profile.model,
      url,
      httpStatus: response.status,
      messages,
      requestBody,
      responseText,
      parsedResult,
      errorStack: response.ok ? '' : `HTTP ${response.status} ${response.statusText}`,
    });

    return response.ok;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    api.lastTestAt = formatTimestamp();
    api.lastTestStatus = `失败：${error.message || error}`;

    addCommunicationLog({
      moduleName: '副 API',
      taskType: '测试连接',
      status: 'failure',
      startedAt: api.lastTestAt,
      durationMs,
      profileName: profile.name,
      model: profile.model,
      url,
      messages,
      requestBody,
      errorStack: error.stack || error.message || error,
    });

    return false;
  }
}

function getContextSafe() {
  return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getContextInfo() {
  const context = getContextSafe();
  const characterId = String(
    context?.characterId
      ?? context?.this_chid
      ?? context?.chid
      ?? context?.character?.avatar
      ?? '',
  );
  const chatId = String(
    context?.chatId
      ?? context?.chatMetadata?.name
      ?? context?.chat?.[0]?.extra?.chat_id
      ?? '',
  );

  return {
    characterId,
    characterName: context?.name2 || context?.character?.name || '未读取',
    chatId,
    chatName: context?.chatMetadata?.name || chatId || '未读取',
  };
}

function getGlobalSettings() {
  const context = getContextSafe();
  if (!context?.extensionSettings) {
    return cloneData(defaultGlobalSettings);
  }

  context.extensionSettings[MODULE_NAME] = mergeDefaults(
    context.extensionSettings[MODULE_NAME],
    cloneData(defaultGlobalSettings),
  );
  context.extensionSettings[MODULE_NAME].schemaVersion = STORAGE_VERSION;

  return context.extensionSettings[MODULE_NAME];
}

function saveGlobalSettings() {
  const settings = getGlobalSettings();
  settings.diagnostics.lastSavedAt = formatTimestamp();
  getContextSafe()?.saveSettingsDebounced?.();
}

function getChatState() {
  const context = getContextSafe();
  const info = getContextInfo();

  if (!context?.chatMetadata) {
    const fallback = cloneData(defaultChatState);
    fallback.identity = info;
    return fallback;
  }

  context.chatMetadata[CHAT_STATE_KEY] = mergeDefaults(
    context.chatMetadata[CHAT_STATE_KEY],
    cloneData(defaultChatState),
  );

  const state = context.chatMetadata[CHAT_STATE_KEY];
  state.schemaVersion = STORAGE_VERSION;
  state.identity = info;
  return state;
}

function saveChatState() {
  const state = getChatState();
  state.diagnostics.lastSavedAt = formatTimestamp();

  const context = getContextSafe();
  if (typeof context?.saveMetadataDebounced === 'function') {
    context.saveMetadataDebounced();
  } else {
    context?.saveSettingsDebounced?.();
  }
}

function getStorageDiagnostics() {
  const context = getContextSafe();
  const settings = getGlobalSettings();
  const chatState = getChatState();

  return {
    globalKey: MODULE_NAME,
    chatKey: CHAT_STATE_KEY,
    hasExtensionSettings: Boolean(context?.extensionSettings),
    hasChatMetadata: Boolean(context?.chatMetadata),
    canSaveGlobal: typeof context?.saveSettingsDebounced === 'function',
    canSaveChat: typeof context?.saveMetadataDebounced === 'function',
    globalLastSavedAt: settings.diagnostics.lastSavedAt || '尚未保存',
    chatLastSavedAt: chatState.diagnostics.lastSavedAt || '尚未保存',
    globalProbe: settings.diagnostics.globalProbe || '尚未写入',
    chatProbe: chatState.diagnostics.chatProbe || '尚未写入',
  };
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
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-test-api>测试连接</button>
      </div>
      <div class="slx-api-status">
        <span>最近测试：${escapeHtml(api.lastTestAt || '尚未测试')}</span>
        <b>${escapeHtml(api.lastTestStatus || '未记录')}</b>
      </div>
    </div>
  `;
}
function getSummarySettings(settings = getGlobalSettings()) {
  if (!isPlainObject(settings.modules)) {
    settings.modules = cloneData(defaultGlobalSettings.modules);
  }
  settings.modules.summary = mergeDefaults(
    settings.modules.summary,
    cloneData(defaultGlobalSettings.modules.summary),
  );
  delete settings.modules.summary.startMessageId;
  getSummarySourceTags(settings.modules.summary);
  return settings.modules.summary;
}

function renderSummarySettingsPanel(settings, chatState) {
  const summary = getSummarySettings(settings);
  const apiProfile = getActiveApiProfile(settings);
  const api = getApiSettings(settings);
  const activeModel = api.mode === 'main_api' ? '酒馆主 API' : (apiProfile.model || '尚未选择模型');
  const grandInterval = Math.max(1, Number(summary.grandMemoryInterval) || 6);
  const memoryCount = Number(chatState.summary.memoryCountSinceArchive ?? chatState.summary.smallSummaryCount ?? 0);
  const archiveRecords = Array.isArray(chatState.summary.archiveRecords) ? chatState.summary.archiveRecords : [];
  const latestArchiveRecord = archiveRecords[0] || archiveRecords.at(-1);
  const latestArchiveLabel = latestArchiveRecord
    ? `第 ${latestArchiveRecord.summaryMessageId ?? '?'} 楼 / ${latestArchiveRecord.archiveFrom ?? '?'}-${latestArchiveRecord.archiveTo ?? '?'}`
    : '无';
  const latestLog = settings.communicationLog?.entries?.[0];
  const latestLogLabel = latestLog ? `${latestLog.status === 'failure' ? '失败' : '成功'} · ${latestLog.startedAt}` : '无';
  const runningTaskLabels = {
    none: '空闲',
    opening_memory: '0楼总结中',
    memory: '小总结中',
    grand_memory: '大总结中',
  };
  const runningLabel = runningTaskLabels[chatState.summary.runningTask] || chatState.summary.runningTask || '空闲';
  const presetMemoryLabel = summary.enabled ? '自动总结接管中' : '预设小总结接管中';
  const sourceTags = getSummarySourceTags(summary);

  return `
    <div class="slx-detail-card slx-summary-settings-card">
      <label class="slx-setting-toggle-row" for="slx-summary-enabled">
        <span>
          <b>自动小总结</b>
          <small>开启后将由总结 API 接管每轮正文后的 memory。</small>
          <small>预设小总结：${escapeHtml(presetMemoryLabel)}</small>
        </span>
        <input id="slx-summary-enabled" type="checkbox" data-slx-summary-field="enabled" ${summary.enabled ? 'checked' : ''} />
      </label>
      <label class="slx-setting-toggle-row" for="slx-summary-grand-enabled">
        <span>
          <b>自动大总结</b>
          <small>达到阈值后创建独立大总结楼，并自动隐藏本轮归档区间。</small>
        </span>
        <input id="slx-summary-grand-enabled" type="checkbox" data-slx-summary-field="autoGrandMemoryEnabled" ${summary.autoGrandMemoryEnabled ? 'checked' : ''} />
      </label>
      <label class="slx-field slx-field-wide">
        <span>大总结间隔</span>
        <input type="number" min="1" step="1" data-slx-summary-field="grandMemoryInterval" value="${escapeHtml(grandInterval)}" />
        <small>每 N 次成功小总结后触发一次大总结。</small>
      </label>
    </div>

    <div class="slx-detail-card slx-source-rules-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">正文读取规则</div>
          <p>这里只处理正文里的杂讯标签。&lt;memory&gt; 与 &lt;grand_memory&gt; 会由小总结/大总结流程单独读取，不作为默认排除项。</p>
        </div>
        <button class="slx-mini-action-btn" type="button" data-slx-reset-source-tags title="恢复蜃灵默认标签">↺</button>
      </div>
      <div class="slx-form-grid">
        <label class="slx-field slx-field-wide">
          <span>纳入正文标签</span>
          <textarea rows="3" data-slx-summary-tag-field="includeTags" placeholder="content">${escapeHtml(formatTagList(sourceTags.includeTags))}</textarea>
          <small>例如 content。留空时会使用排除后的全文。</small>
        </label>
        <label class="slx-field slx-field-wide">
          <span>排除正文杂讯标签</span>
          <textarea rows="4" data-slx-summary-tag-field="excludeTags" placeholder="thinking&#10;wave">${escapeHtml(formatTagList(sourceTags.excludeTags))}</textarea>
          <small>例如 thinking、wave。不要默认排除 memory / grand_memory，它们是归档素材。</small>
        </label>
      </div>
      <div class="slx-tag-preview">
        <span>当前纳入：${escapeHtml(sourceTags.includeTags.join('、') || '无，使用全文')}</span>
        <span>当前排除：${escapeHtml(sourceTags.excludeTags.join('、') || '无')}</span>
      </div>
    </div>

    <div class="slx-detail-card slx-muted-card">
      <div class="slx-summary-card-head">
        <div class="slx-detail-title">运行状态</div>
        <b>${escapeHtml(runningLabel)}</b>
      </div>
      ${renderDiagnosticLine('小总结累计', `${memoryCount} / ${grandInterval}`)}
      ${renderDiagnosticLine('预设小总结', presetMemoryLabel)}
      ${renderDiagnosticLine('当前启用模型', activeModel)}
      ${renderDiagnosticLine('上次小总结楼', chatState.summary.lastSummaryMessageId ?? '无')}
      ${renderDiagnosticLine('上次大总结楼', chatState.summary.lastGrandSummaryMessageId ?? '无')}
      ${renderDiagnosticLine('归档记录', `${archiveRecords.length} 条`)}
      ${renderDiagnosticLine('最新归档', latestArchiveLabel)}
      ${renderDiagnosticLine('最近通讯日志', latestLogLabel)}
      ${renderDiagnosticLine('上次错误', chatState.summary.lastError || '无')}
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" disabled title="运行逻辑将在 5B 接入">
          <span>为0楼生成小总结</span>
        </button>
        <button class="slx-soft-btn" type="button" disabled title="运行逻辑将在 5B 接入">
          <span>重新生成上次大总结</span>
        </button>
      </div>
    </div>

    <div class="slx-detail-card slx-muted-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">归档管理器</div>
          <p>查看大总结楼层与当前隐藏状态，可直接编辑大总结正文。</p>
        </div>
        <button class="slx-mini-action-btn" type="button" disabled title="运行逻辑将在 5B 接入">↻</button>
      </div>
      <p>${archiveRecords.length ? '归档记录会在这里按楼层显示。' : '暂无归档记录。'}</p>
    </div>

    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">小总结管理</div>
      <p>指定楼层重写或手动编辑 memory，并覆盖回原楼层。</p>
      <label class="slx-field slx-field-wide">
        <span>重写指定楼层小总结</span>
        <div class="slx-model-row">
          <input type="number" min="0" placeholder="留空默认最新AI楼层" disabled />
          <button class="slx-mini-action-btn" type="button" disabled title="运行逻辑将在 5B 接入">↻</button>
        </div>
        <small>适合大改楼层后刷新小总结，不会增加累计次数。</small>
      </label>
      <label class="slx-field slx-field-wide">
        <span>编辑指定楼层小总结</span>
        <div class="slx-model-row">
          <input type="number" min="0" placeholder="输入楼层号" disabled />
          <button class="slx-mini-action-btn" type="button" disabled title="运行逻辑将在 5B 接入">✎</button>
        </div>
        <small>适合只改几个字，保存后只覆盖该楼 memory。</small>
      </label>
    </div>

    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">5A 阶段边界</div>
      <p>界面与状态结构先按蜃灵切换脚本对齐。后续接入时会先扫描既有蜃灵 &lt;memory&gt; 小总结并计入累积；没有可识别小总结的旧聊天，再用手动大总结补档并隐藏前文。</p>
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
  panelRoot.querySelector('[data-slx-test-api]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    syncApiFormToSettings();
    saveGlobalSettings();
    button.disabled = true;
    button.textContent = '测试中...';

    await testSecondaryApiConnection();

    renderFloatingPanel({ moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0 });
    syncSettingsPanelState();
  });


  const syncSummaryFieldToSettings = input => {
    const summary = getSummarySettings(settings);
    const field = input.dataset.slxSummaryField;
    if (!field || !Object.hasOwn(summary, field)) return false;

    if (input.type === 'checkbox') {
      summary[field] = Boolean(input.checked);
    } else if (input.type === 'number') {
      const value = Number.parseInt(input.value, 10);
      summary[field] = Number.isFinite(value) ? Math.max(Number(input.min || 0), value) : summary[field];
      input.value = summary[field];
    } else {
      summary[field] = input.value;
    }

    saveGlobalSettings();
    return true;
  };

  const rerenderSummaryPanel = () => {
    renderFloatingPanel({
      moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0,
      detailScrollTop: panelRoot.querySelector('.slx-detail')?.scrollTop ?? 0,
    });
    syncSettingsPanelState();
  };

  const syncSummaryTagFieldToSettings = input => {
    const summary = getSummarySettings(settings);
    const tags = getSummarySourceTags(summary);
    const field = input.dataset.slxSummaryTagField;
    if (!['includeTags', 'excludeTags'].includes(field)) return false;

    tags[field] = parseTagList(input.value);
    input.value = formatTagList(tags[field]);
    saveGlobalSettings();
    return true;
  };

  panelRoot.querySelectorAll('[data-slx-summary-tag-field]').forEach(input => {
    input.addEventListener('change', () => {
      if (syncSummaryTagFieldToSettings(input)) {
        rerenderSummaryPanel();
      }
    });

    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !event.ctrlKey) return;
      event.preventDefault();
      if (syncSummaryTagFieldToSettings(input)) {
        input.blur();
        rerenderSummaryPanel();
      }
    });
  });

  panelRoot.querySelector('[data-slx-reset-source-tags]')?.addEventListener('click', () => {
    const summary = getSummarySettings(settings);
    summary.sourceTags = {
      includeTags: [...DEFAULT_SUMMARY_INCLUDE_TAGS],
      excludeTags: [...DEFAULT_SUMMARY_EXCLUDE_TAGS],
    };
    saveGlobalSettings();
    rerenderSummaryPanel();
  });

  panelRoot.querySelectorAll('[data-slx-summary-field]').forEach(input => {
    input.addEventListener('change', () => {
      if (syncSummaryFieldToSettings(input)) {
        rerenderSummaryPanel();
      }
    });

    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (syncSummaryFieldToSettings(input)) {
        input.blur();
        rerenderSummaryPanel();
      }
    });
  });

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
          <div class="shenling-assistant-desc">独立插件项目空壳。当前用于验证主面板、模块导航和设置存储。</div>
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
  getGlobalSettings();
  getChatState();
  renderSettingsPanel();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
