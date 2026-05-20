import { formatTimestamp, isPlainObject } from '../utils/text.js';

export function stringifyLogField(value) {
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

export function createCommunicationLog(input = {}) {
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

export function getKnownApiKeys(settings = {}) {
  const profiles = Array.isArray(settings?.api?.profiles) ? settings.api.profiles : [];
  return profiles
    .map(profile => String(profile.apiKey || '').trim())
    .filter(key => key.length >= 4);
}

export function redactText(value, knownKeys = []) {
  let text = String(value);
  knownKeys.forEach(key => {
    text = text.split(key).join('[已隐藏 API Key]');
  });

  return text
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"',}]+/gi, '$1[已隐藏 API Key]')
    .replace(/((?:api[_-]?key|access[_-]?token|key)\s*["']?\s*[:=]\s*["']?)[^"',\s}&]+/gi, '$1[已隐藏 API Key]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|key)=)[^&\s]+/gi, '$1[已隐藏 API Key]');
}

export function redactLogValue(value, knownKeys = []) {
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

export function sanitizeCommunicationLog(log, settings = {}) {
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

export function formatCommunicationLogForCopy(log) {
  return [
    `模块：${log.moduleName}`,
    `任务：${log.taskType}`,
    `状态：${log.status === 'failure' ? '失败' : '成功'}`,
    `时间：${log.startedAt}`,
    `耗时：${log.durationMs === null ? '未记录' : String(log.durationMs) + 'ms'}`,
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

export async function copyText(text) {
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
