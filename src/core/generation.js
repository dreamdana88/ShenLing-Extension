import { buildApiUrl } from './api.js';

function getMainGenerateRaw() {
  if (typeof globalThis.generateRaw === 'function') {
    return globalThis.generateRaw;
  }

  const context = globalThis.SillyTavern?.getContext?.();
  return typeof context?.generateRaw === 'function' ? context.generateRaw : null;
}

function runWithTimeout(task, timeoutMs, timeoutMessage) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(task);
  }

  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMs,
    );
  });

  return Promise.race([
    Promise.resolve().then(task),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

function getOpenAiChatCompletionContent(data) {
  const firstChoice = data?.choices?.[0];
  const messageContent = firstChoice?.message?.content;
  if (typeof messageContent === 'string') return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map(item => (typeof item === 'string' ? item : item?.text || ''))
      .join('');
  }
  if (typeof firstChoice?.text === 'string') return firstChoice.text;
  return '';
}

export async function generateWithMainApi({
  messages,
  timeoutMs,
  timeoutMessage = '生成超时，请稍后重试。',
}) {
  const generateRaw = getMainGenerateRaw();
  if (typeof generateRaw !== 'function') {
    throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
  }

  const requestBody = { prompt: messages };
  const responseText = await runWithTimeout(
    () => generateRaw(requestBody),
    timeoutMs,
    timeoutMessage,
  );

  return {
    profileName: '酒馆当前连接',
    model: '酒馆主 API',
    url: '酒馆当前连接',
    requestBody,
    responseText: String(responseText || ''),
    content: String(responseText || ''),
  };
}

export async function generateWithSecondaryApi({
  profile,
  messages,
  timeoutMs,
  timeoutMessage = '生成超时，请稍后重试。',
}) {
  if (!profile) throw new Error('当前环境未提供副 API 配置。');

  const model = String(profile.model || '').trim();
  if (!model) throw new Error('请先在设置页选择生成模型。');

  const url = buildApiUrl(profile);
  const requestBody = {
    model,
    messages,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = String(profile.apiKey || '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await runWithTimeout(
    () => fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    }),
    timeoutMs,
    timeoutMessage,
  );
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
  }

  const content = responseJson
    ? getOpenAiChatCompletionContent(responseJson)
    : responseText;
  if (!String(content || '').trim()) {
    throw new Error(`副 API 响应缺少模型正文：${responseText}`);
  }

  return {
    profileName: profile.name || '未命名副 API',
    model,
    url,
    httpStatus: `${response.status} ${response.statusText}`,
    requestBody,
    responseText,
    responseJson,
    content,
  };
}
