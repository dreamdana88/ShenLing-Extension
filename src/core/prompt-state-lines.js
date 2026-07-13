import {
  getTavernEventsSafe,
  registerTavernEvent,
} from './tavern-events.js';

const STATE_LINE_RE = /^\s*\[(?:emotion_changed|emotion|affection_changed|affection_candidate|affection)\s*:[^\r\n]*\]\s*$/gim;
const INTERNAL_MEMORY_TASK_MARKERS = Object.freeze([
  '现在是梦境小总结模块',
  '现在是梦境大归档模块',
  '蜃灵助手的总档案压缩模块',
  '现在是旧聊天归档模块',
]);

let promptSanitizerEventStop = null;

export function stripInlineStateLinesForSendingText(text) {
  const value = String(text || '');
  if (!/^\s*\[(?:emotion|affection)/im.test(value)) return value;
  return value
    .replace(STATE_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function stripInlineStateLinesFromSendingContent(content) {
  if (typeof content === 'string') {
    return stripInlineStateLinesForSendingText(content);
  }
  if (!Array.isArray(content)) return content;

  let changed = false;
  const nextContent = content.map(part => {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') return part;
    const text = stripInlineStateLinesForSendingText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? nextContent : content;
}

function getSendingContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function isShenlingInternalMemoryTask(chat) {
  const text = (Array.isArray(chat) ? chat : [])
    .map(message => getSendingContentText(message?.content))
    .filter(Boolean)
    .join('\n\n');
  return INTERNAL_MEMORY_TASK_MARKERS.some(marker => text.includes(marker));
}

export function sanitizeChatCompletionPromptStateLines(eventData) {
  const chat = Array.isArray(eventData?.chat) ? eventData.chat : [];
  if (isShenlingInternalMemoryTask(chat)) {
    return { skipped: true, changedMessages: 0 };
  }

  let changedMessages = 0;
  chat.forEach(message => {
    if (!message || typeof message !== 'object') return;
    const content = stripInlineStateLinesFromSendingContent(message.content);
    if (content !== message.content) {
      message.content = content;
      changedMessages += 1;
    }
  });
  return { skipped: false, changedMessages };
}

export function registerPromptStateLineSanitizerEvents() {
  if (promptSanitizerEventStop) return true;
  const eventName = getTavernEventsSafe().CHAT_COMPLETION_PROMPT_READY;
  const stop = registerTavernEvent(eventName, sanitizeChatCompletionPromptStateLines);
  if (!stop) return false;
  promptSanitizerEventStop = stop;
  return true;
}

export function isPromptStateLineSanitizerRegistered() {
  return Boolean(promptSanitizerEventStop);
}
