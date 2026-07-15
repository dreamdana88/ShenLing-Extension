import { PLUGIN_VERSION } from '../constants.js';
import {
  buildAffectionProfilePrompt,
  buildAffectionStateInjectionPrompt,
  buildAffectionUpdatePromptSection,
  buildCapturePromptMessages,
  buildEmotionUpdatePromptSection,
  buildLegacyArchiveEmotionUpdatePromptSection,
  buildMemoirExtractPrompt,
  buildMiniTheaterPrompt,
  buildPlotOutlinePrompt,
  buildSchedulePrompt,
  fillRuntimePromptTemplate,
  PROMPT_CATALOG,
  PROMPT_IDS,
} from '../prompts.js';
import { isPlainObject } from '../utils/text.js';

export const PROMPT_OVERRIDE_SCHEMA_VERSION = 1;
export const PROMPT_OVERRIDE_MAX_LENGTH = 200000;

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const PROMPT_DEFINITION_MAP = new Map(PROMPT_CATALOG.map(item => [item.id, item]));

function clonePromptValue(value) {
  if (Array.isArray(value)) {
    return value.map(message => ({
      role: String(message?.role || ''),
      content: String(message?.content || ''),
    }));
  }
  return String(value || '');
}

function serializePromptValue(value) {
  return Array.isArray(value)
    ? JSON.stringify(value.map(message => ({
      role: String(message?.role || ''),
      content: String(message?.content || ''),
    })))
    : String(value || '');
}

function getPromptValueLength(value) {
  return serializePromptValue(value).length;
}

export function hashPromptValue(value) {
  const source = serializePromptValue(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function getPromptDefinition(promptId) {
  return PROMPT_DEFINITION_MAP.get(String(promptId || '')) || null;
}

export function listPromptDefinitions() {
  return [...PROMPT_CATALOG];
}

export function createDefaultPromptOverrides() {
  return {
    schemaVersion: PROMPT_OVERRIDE_SCHEMA_VERSION,
    entries: {},
  };
}

function normalizeMessageList(value) {
  if (!Array.isArray(value)) return null;
  const messages = value.map(message => ({
    role: String(message?.role || '').trim(),
    content: String(message?.content || ''),
  }));
  return messages.every(message => MESSAGE_ROLES.has(message.role)) ? messages : null;
}

function normalizeStoredContent(value, definition = null) {
  if (definition?.kind === 'message_list') return normalizeMessageList(value);
  if (definition?.kind === 'text') return typeof value === 'string' ? value : null;
  if (typeof value === 'string') return value;
  return normalizeMessageList(value);
}

export function normalizePromptOverrides(value) {
  const source = isPlainObject(value) ? value : {};
  const entries = {};
  const sourceEntries = isPlainObject(source.entries) ? source.entries : {};

  Object.entries(sourceEntries).forEach(([promptId, entry]) => {
    if (!isPlainObject(entry)) return;
    const definition = getPromptDefinition(promptId);
    const content = normalizeStoredContent(entry.content, definition);
    if (content === null || getPromptValueLength(content) > PROMPT_OVERRIDE_MAX_LENGTH) return;
    entries[promptId] = {
      content,
      baseHash: String(entry.baseHash || ''),
      basePluginVersion: String(entry.basePluginVersion || ''),
      updatedAt: String(entry.updatedAt || ''),
    };
  });

  return {
    schemaVersion: PROMPT_OVERRIDE_SCHEMA_VERSION,
    entries,
  };
}

export function normalizePromptOverrideSettings(settings) {
  if (!isPlainObject(settings)) return createDefaultPromptOverrides();
  settings.promptOverrides = normalizePromptOverrides(settings.promptOverrides);
  return settings.promptOverrides;
}

function getRegisteredVariableNames(definition) {
  return new Set((definition?.variables || []).map(variable => {
    const match = String(variable?.token || '').match(/^\$\{([A-Za-z][A-Za-z0-9_]*)\}$/);
    return match?.[1] || '';
  }).filter(Boolean));
}

export function validatePromptValue(promptId, value) {
  const definition = getPromptDefinition(promptId);
  const errors = [];
  if (!definition) {
    return {
      valid: false,
      errors: [{ code: 'unknown_prompt', message: '提示词未登记，不能启用。' }],
    };
  }

  if (definition.kind === 'message_list') {
    const messages = normalizeMessageList(value);
    if (!messages || messages.length === 0) {
      errors.push({ code: 'message_list', message: '消息组至少需要一条合法消息。' });
    } else {
      messages.forEach((message, index) => {
        if (!message.content.trim()) {
          errors.push({ code: 'empty_message', message: `第 ${index + 1} 条消息不能为空。` });
        }
      });
    }
  } else if (typeof value !== 'string' || !value.trim()) {
    errors.push({ code: 'empty', message: '提示词不能为空。' });
  }

  if (getPromptValueLength(value) > PROMPT_OVERRIDE_MAX_LENGTH) {
    errors.push({ code: 'too_long', message: `提示词不能超过 ${PROMPT_OVERRIDE_MAX_LENGTH} 个字符。` });
  }

  const text = definition.kind === 'message_list'
    ? (Array.isArray(value) ? value.map(message => String(message?.content || '')).join('\n') : '')
    : String(value || '');
  (definition.requiredTokens || []).forEach(token => {
    if (!text.includes(token)) {
      errors.push({ code: 'missing_token', token, message: `缺少必需结构：${token}` });
    }
  });

  const registeredVariables = getRegisteredVariableNames(definition);
  const withoutClosedMacros = text.replace(/\{\{[^{}]*\}\}/g, '');
  const hasUnclosedRuntimePlaceholder = [...text.matchAll(/\$\{[A-Za-z]/g)]
    .some(match => text.indexOf('}', match.index) === -1);
  if (hasUnclosedRuntimePlaceholder || withoutClosedMacros.includes('{{')) {
    errors.push({ code: 'unclosed_placeholder', message: '存在未闭合的模板占位符。' });
  }
  for (const match of text.matchAll(/\$\{([A-Za-z][^}]*)\}/g)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(match[1])) {
      errors.push({ code: 'malformed_variable', token: match[0], message: `运行时变量格式无效：${match[0]}` });
    }
  }
  const unknownVariables = new Set();
  for (const match of text.matchAll(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    if (!registeredVariables.has(match[1])) unknownVariables.add(match[0]);
  }
  unknownVariables.forEach(token => {
    errors.push({ code: 'unknown_variable', token, message: `未登记的运行时变量：${token}` });
  });

  return { valid: errors.length === 0, errors };
}

export function getPromptOverrideState(promptId, settings = {}) {
  const definition = getPromptDefinition(promptId);
  if (!definition) return null;
  const store = normalizePromptOverrideSettings(settings);
  const entry = store.entries[promptId] || null;
  const defaultValue = clonePromptValue(definition.defaultValue);
  const overrideValue = entry ? clonePromptValue(entry.content) : null;
  const validation = validatePromptValue(promptId, entry ? overrideValue : defaultValue);
  const activeValue = entry && validation.valid
    ? clonePromptValue(overrideValue)
    : clonePromptValue(defaultValue);
  return {
    definition,
    defaultValue,
    activeValue,
    overrideValue,
    entry,
    hasOverride: Boolean(entry),
    baseChanged: Boolean(entry?.baseHash && entry.baseHash !== hashPromptValue(defaultValue)),
    validation,
  };
}

export function resolvePromptValue(promptId, settings = {}) {
  const state = getPromptOverrideState(promptId, settings);
  return state ? clonePromptValue(state.activeValue) : null;
}

export function resolvePromptText(promptId, settings = {}) {
  const value = resolvePromptValue(promptId, settings);
  return typeof value === 'string' ? value : '';
}

export function resolvePromptMessages(promptId, settings = {}) {
  const value = resolvePromptValue(promptId, settings);
  return Array.isArray(value) ? clonePromptValue(value) : [];
}

export function setPromptOverride(settings, promptId, value, { updatedAt = new Date().toISOString() } = {}) {
  const definition = getPromptDefinition(promptId);
  const validation = validatePromptValue(promptId, value);
  if (!definition || !validation.valid) return validation;
  const store = normalizePromptOverrideSettings(settings);
  const normalizedValue = definition.kind === 'message_list'
    ? normalizeMessageList(value)
    : String(value || '');
  if (serializePromptValue(normalizedValue) === serializePromptValue(definition.defaultValue)) {
    delete store.entries[promptId];
    return { valid: true, errors: [], removed: true };
  }
  store.entries[promptId] = {
    content: clonePromptValue(normalizedValue),
    baseHash: hashPromptValue(definition.defaultValue),
    basePluginVersion: PLUGIN_VERSION,
    updatedAt: String(updatedAt || ''),
  };
  return { valid: true, errors: [], removed: false };
}

export function removePromptOverride(settings, promptId) {
  const store = normalizePromptOverrideSettings(settings);
  const existed = Object.hasOwn(store.entries, promptId);
  delete store.entries[promptId];
  return existed;
}

export function migrateLegacySummaryPromptSettings(
  settings,
  { memoryDefault, grandDefault } = {},
) {
  const summary = settings?.modules?.summary;
  if (!isPlainObject(summary)) return false;
  normalizePromptOverrideSettings(settings);
  let changed = false;
  const candidates = [
    [PROMPT_IDS.SUMMARY_MEMORY, summary.promptTemplate, String(memoryDefault || '')],
    [PROMPT_IDS.SUMMARY_GRAND, summary.grandPromptTemplate, String(grandDefault || '')],
  ];

  candidates.forEach(([promptId, legacyValue, defaultValue]) => {
    const cleanLegacy = String(legacyValue || '');
    if (
      cleanLegacy
      && cleanLegacy !== defaultValue
      && !settings.promptOverrides.entries[promptId]
    ) {
      settings.promptOverrides.entries[promptId] = {
        content: cleanLegacy,
        baseHash: hashPromptValue(defaultValue),
        basePluginVersion: PLUGIN_VERSION,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }
  });

  if (summary.promptTemplate !== memoryDefault) {
    summary.promptTemplate = String(memoryDefault || '');
    changed = true;
  }
  if (summary.grandPromptTemplate !== grandDefault) {
    summary.grandPromptTemplate = String(grandDefault || '');
    changed = true;
  }
  return changed;
}

function formatExportValue(value) {
  if (!Array.isArray(value)) return String(value || '');
  return value.map((message, index) => [
    `--- 消息 ${index + 1}｜${message.role} ---`,
    message.content,
  ].join('\n')).join('\n\n');
}

export function buildPromptOverrideExport(settings, { exportedAt = new Date().toISOString() } = {}) {
  const store = normalizePromptOverrideSettings(settings);
  const sections = [];
  const errors = [];

  PROMPT_CATALOG.forEach(definition => {
    const entry = store.entries[definition.id];
    if (!entry) return;
    const validation = validatePromptValue(definition.id, entry.content);
    if (!validation.valid) {
      errors.push({ promptId: definition.id, errors: validation.errors });
      return;
    }
    sections.push({
      moduleLabel: definition.moduleLabel,
      label: definition.label,
      promptId: definition.id,
      baseHash: entry.baseHash || hashPromptValue(definition.defaultValue),
      content: formatExportValue(entry.content),
    });
  });

  if (errors.length) return { ok: false, count: 0, errors, text: '' };
  const lines = [
    '# 蜃灵助手提示词修改稿',
    '',
    `插件版本：${PLUGIN_VERSION}`,
    `导出时间：${String(exportedAt || '')}`,
    `修改数量：${sections.length}`,
  ];
  let lastModule = '';
  sections.forEach(section => {
    if (section.moduleLabel !== lastModule) {
      lines.push('', `## ${section.moduleLabel}`);
      lastModule = section.moduleLabel;
    }
    lines.push(
      '',
      `### ${section.label}`,
      `promptId: ${section.promptId}`,
      `baseHash: ${section.baseHash}`,
      '',
      section.content,
    );
  });
  return {
    ok: true,
    count: sections.length,
    errors: [],
    text: `${lines.join('\n').trim()}\n`,
  };
}

export function runPromptOverrideSelfTests() {
  const tests = [];
  const check = (name, condition, detail = '') => {
    tests.push({ name, passed: Boolean(condition), detail: condition ? '' : String(detail || '') });
  };

  const ids = PROMPT_CATALOG.map(item => item.id);
  check('登记表 promptId 唯一', new Set(ids).size === ids.length);
  const invalidDefaults = PROMPT_CATALOG
    .map(item => ({ id: item.id, result: validatePromptValue(item.id, item.defaultValue) }))
    .filter(item => !item.result.valid);
  check('全部默认提示词通过协议校验', invalidDefaults.length === 0, JSON.stringify(invalidDefaults));
  const defaultSettings = { promptOverrides: createDefaultPromptOverrides() };
  const defaultMismatch = PROMPT_CATALOG.filter(item => (
    serializePromptValue(resolvePromptValue(item.id, defaultSettings)) !== serializePromptValue(item.defaultValue)
  ));
  check('无覆盖时解析值与源码默认值一致', defaultMismatch.length === 0, defaultMismatch.map(item => item.id).join(', '));
  const parityPairs = [
    [
      buildMiniTheaterPrompt({ userPrompt: '要求', styleContent: '文风', contextMaterial: '上下文' }),
      buildMiniTheaterPrompt({ userPrompt: '要求', styleContent: '文风', contextMaterial: '上下文', template: resolvePromptText(PROMPT_IDS.THEATER_BUILD, defaultSettings) }),
    ],
    [
      buildPlotOutlinePrompt({ userDirection: '向北', chapterCount: 5, contextMaterial: '上下文' }),
      buildPlotOutlinePrompt({ userDirection: '向北', chapterCount: 5, contextMaterial: '上下文', template: resolvePromptText(PROMPT_IDS.OUTLINE_BUILD, defaultSettings) }),
    ],
    [
      buildSchedulePrompt({ userDirection: '向北', contextMaterial: '上下文', outlineMaterial: '大纲' }),
      buildSchedulePrompt({ userDirection: '向北', contextMaterial: '上下文', outlineMaterial: '大纲', template: resolvePromptText(PROMPT_IDS.SCHEDULE_BUILD, defaultSettings) }),
    ],
    [
      buildMemoirExtractPrompt({ grandMemoryMaterial: '大总结', emotionMaterial: '情感', recordedList: '记录' }),
      buildMemoirExtractPrompt({ grandMemoryMaterial: '大总结', emotionMaterial: '情感', recordedList: '记录', template: resolvePromptText(PROMPT_IDS.MEMOIR_EXTRACT, defaultSettings) }),
    ],
    [
      buildEmotionUpdatePromptSection({ knownProfilesText: '档案' }),
      buildEmotionUpdatePromptSection({ knownProfilesText: '档案', template: resolvePromptText(PROMPT_IDS.EMOTION_UPDATE, defaultSettings) }),
    ],
    [
      buildLegacyArchiveEmotionUpdatePromptSection({ knownProfilesText: '档案' }),
      buildLegacyArchiveEmotionUpdatePromptSection({ knownProfilesText: '档案', template: resolvePromptText(PROMPT_IDS.EMOTION_LEGACY_UPDATE, defaultSettings) }),
    ],
    [
      buildAffectionUpdatePromptSection({ knownAffectionText: '状态' }),
      buildAffectionUpdatePromptSection({ knownAffectionText: '状态', template: resolvePromptText(PROMPT_IDS.AFFECTION_UPDATE, defaultSettings) }),
    ],
    [
      buildAffectionProfilePrompt({ roleName: '沈青', initialAffection: '35.0', userRequirement: '慢热', contextMaterial: '材料' }),
      buildAffectionProfilePrompt({ roleName: '沈青', initialAffection: '35.0', userRequirement: '慢热', contextMaterial: '材料', template: resolvePromptText(PROMPT_IDS.AFFECTION_PROFILE, defaultSettings) }),
    ],
    [
      buildAffectionStateInjectionPrompt({ entriesText: '状态' }),
      buildAffectionStateInjectionPrompt({ entriesText: '状态', template: resolvePromptText(PROMPT_IDS.AFFECTION_INJECTION, defaultSettings) }),
    ],
  ];
  const captureInput = { request: '采集酒馆', requestedType: 'location', sourceMaterial: '正文', optionalMaterial: '角色卡' };
  const captureDefault = buildCapturePromptMessages(captureInput);
  const captureResolved = buildCapturePromptMessages(captureInput, {}, {
    messages: resolvePromptMessages(PROMPT_IDS.CAPTURE_MESSAGES, defaultSettings),
  });
  check(
    '动态 builder 接入默认模板后输出一致',
    parityPairs.every(([before, after]) => before === after)
      && serializePromptValue(captureDefault) === serializePromptValue(captureResolved),
  );

  const settings = { promptOverrides: createDefaultPromptOverrides(), api: { apiKey: 'SECRET_API_KEY' } };
  const targetId = PROMPT_IDS.SUMMARY_GAZE;
  const otherId = PROMPT_IDS.DIARY_ROLE;
  const targetDefault = resolvePromptText(targetId, settings);
  const otherDefault = resolvePromptText(otherId, settings);
  const saveResult = setPromptOverride(settings, targetId, `${targetDefault}\n本地测试覆盖。`);
  check('单条覆盖可以保存', saveResult.valid && resolvePromptText(targetId, settings) !== targetDefault);
  check('单条覆盖不影响其他提示词', resolvePromptText(otherId, settings) === otherDefault);

  settings.promptOverrides.entries[targetId].baseHash = 'old-base';
  check('默认值基线变化可识别', getPromptOverrideState(targetId, settings).baseChanged === true);
  removePromptOverride(settings, targetId);
  check('恢复默认会删除覆盖', resolvePromptText(targetId, settings) === targetDefault);

  const invalidVariable = validatePromptValue(targetId, `${targetDefault}\n\${unknownRuntimeVariable}`);
  check('未登记运行时变量会被拦截', invalidVariable.errors.some(error => error.code === 'unknown_variable'));
  const unclosedVariable = validatePromptValue(targetId, `${targetDefault}\n\${unfinishedVariable`);
  check('未闭合占位符会被拦截', unclosedVariable.errors.some(error => error.code === 'unclosed_placeholder'));
  const invalidProtocol = validatePromptValue(
    PROMPT_IDS.SUMMARY_MEMORY,
    resolvePromptText(PROMPT_IDS.SUMMARY_MEMORY, defaultSettings).replace('</memory>', ''),
  );
  check('缺失协议 token 会被拦截', invalidProtocol.errors.some(error => error.code === 'missing_token'));
  const interpolated = fillRuntimePromptTemplate(
    '状态：${knownProfilesText}\n用户：{{user}}\n示例：${角色名}',
    { knownProfilesText: '已确认档案' },
  );
  check(
    '运行时只替换已提供的 ASCII 变量',
    interpolated === '状态：已确认档案\n用户：{{user}}\n示例：${角色名}',
    interpolated,
  );

  settings.promptOverrides.entries[targetId] = {
    content: '\${unknownRuntimeVariable}',
    baseHash: hashPromptValue(targetDefault),
    basePluginVersion: PLUGIN_VERSION,
    updatedAt: 'TEST_TIME',
  };
  check('无效旧覆盖不会进入运行时', resolvePromptText(targetId, settings) === targetDefault);
  removePromptOverride(settings, targetId);

  setPromptOverride(settings, targetId, `${targetDefault}\n导出测试。`);
  const reloaded = { promptOverrides: normalizePromptOverrides(JSON.parse(JSON.stringify(settings.promptOverrides))) };
  check('覆盖经序列化重载后仍可解析', resolvePromptText(targetId, reloaded).includes('导出测试。'));
  const exported = buildPromptOverrideExport(settings, { exportedAt: 'TEST_TIME' });
  check('导出只包含已覆盖提示词', exported.ok && exported.count === 1);
  check('导出不包含 API Key', !exported.text.includes('SECRET_API_KEY'));

  return {
    passed: tests.every(test => test.passed),
    total: tests.length,
    failed: tests.filter(test => !test.passed).length,
    tests,
  };
}
