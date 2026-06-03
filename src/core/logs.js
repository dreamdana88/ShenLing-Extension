import { formatTimestamp, isPlainObject } from '../utils/text.js';

function formatMessageList(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map((message, index) => {
    if (!isPlainObject(message)) {
      return `--- message ${index + 1} ---\n${stringifyLogField(message)}`;
    }
    const { role, content, ...rest } = message;
    const restText = Object.keys(rest).length ? `\n\n其他字段：\n${JSON.stringify(rest, null, 2)}` : '';
    return `--- message ${index + 1}${role ? ` / ${role}` : ''} ---\n${String(content ?? '')}${restText}`;
  }).join('\n\n');
}

function stringifyObjectLogField(value) {
  if (Array.isArray(value.messages)) {
    const { messages, ...rest } = value;
    const restText = Object.keys(rest).length ? `${JSON.stringify(rest, null, 2)}\n\n` : '';
    return `${restText}messages:\n${formatMessageList(messages)}`.trim();
  }

  if (Array.isArray(value.ordered_prompts) || typeof value.user_input === 'string') {
    const { ordered_prompts: orderedPrompts, user_input: userInput, ...rest } = value;
    const restText = Object.keys(rest).length ? `${JSON.stringify(rest, null, 2)}\n\n` : '';
    const orderedText = Array.isArray(orderedPrompts)
      ? `ordered_prompts:\n${formatMessageList(orderedPrompts)}\n\n`
      : '';
    const inputText = typeof userInput === 'string' ? `user_input:\n${userInput}` : '';
    return `${restText}${orderedText}${inputText}`.trim();
  }

  return JSON.stringify(value, null, 2);
}

export function stringifyLogField(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const messages = formatMessageList(value);
    if (messages) return messages;
  }

  try {
    if (isPlainObject(value)) {
      return stringifyObjectLogField(value);
    }
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
    rawParsedResult: input.rawParsedResult ?? '',
    rawResultContent: input.rawResultContent ?? '',
    parsedResult: input.parsedResult ?? '',
    wordReplacement: input.wordReplacement ?? '',
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
    rawParsedResult: redactLogValue(log.rawParsedResult, knownKeys),
    rawResultContent: redactLogValue(log.rawResultContent, knownKeys),
    parsedResult: redactLogValue(log.parsedResult, knownKeys),
    wordReplacement: redactLogValue(log.wordReplacement, knownKeys),
    errorStack: redactLogValue(log.errorStack, knownKeys),
  };
}

export function formatCommunicationLogForCopy(log) {
  const lines = [
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
  ];

  if (log.rawParsedResult) {
    lines.push('', '【替换前解析】', stringifyLogField(log.rawParsedResult) || '未记录');
  }

  if (log.rawResultContent) {
    lines.push('', '【替换前正文】', stringifyLogField(log.rawResultContent) || '未记录');
  }

  lines.push('', '【解析结果】', stringifyLogField(log.parsedResult) || '未记录');

  if (log.wordReplacement) {
    lines.push('', '【禁词替换】', stringifyLogField(log.wordReplacement) || '未记录');
  }

  lines.push('', '【错误信息】', stringifyLogField(log.errorStack) || '未记录');

  return lines.join('\n');
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
