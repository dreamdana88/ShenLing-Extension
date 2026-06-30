import {
  getChatMessageById,
  getChatMessagesSafe,
} from '../../core/chat.js';
import { extractMemoryBlocks } from '../../core/summary.js';
import {
  getChatBeautifySettings,
  getGlobalSettings,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import { renderGrandMemoryCard } from './render-grand-memory.js';
import { renderMemoryCard } from './render-memory.js';

const MEMORY_RENDER_DELAY_MS = 220;
const MEMORY_RENDER_FORMAT_VERSION = 2;
const MEMORY_FIELD_KEYS = new Set([
  'number',
  'time',
  'location',
  'characters',
  'task',
  'plot',
  'quote',
  'db',
  'emotion_changed',
  'emotion',
  'affection_changed',
  'affection',
  'progress',
]);
const GRAND_MEMORY_FIELD_KEYS = new Set([
  'volume',
  'span',
  'chronicle',
  'plot',
  'arc',
  'db',
  'task',
  'faction',
  'next',
]);
const MEMORY_FIELD_LINE_RE = /^\s*\[([A-Za-z][\w-]*)\s*:\s*([^\[\]]*?)\]\s*$/;

let rendererRegistered = false;
let eventStops = [];
let refreshTimer = null;

function getSettings() {
  const globalSettings = getGlobalSettings();
  const beautifySettings = getChatBeautifySettings(globalSettings);
  return {
    globalSettings,
    beautifySettings,
    active: Boolean(globalSettings.enabled && beautifySettings.enabled && beautifySettings.renderMemory),
  };
}

function getMemoryTheme(beautifySettings = getChatBeautifySettings()) {
  return beautifySettings.theme === 'dark' ? 'dark' : 'light';
}

function hashMemoryBlocks(blocks) {
  const text = blocks.map(block => `${block.type}:${block.text}`).join('\n\n');
  return `${MEMORY_RENDER_FORMAT_VERSION}:${blocks.length}:${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
}

function getMessageIdFromElement(messageElement) {
  const raw = messageElement?.getAttribute?.('mesid')
    ?? messageElement?.dataset?.messageId
    ?? messageElement?.dataset?.mesid;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function getMessageElementById(messageId) {
  return document.querySelector(`.mes[mesid="${Number(messageId)}"]`);
}

function getVisibleMessageElements() {
  return Array.from(document.querySelectorAll('.mes[mesid]'));
}

function getMessageText(messageId) {
  const message = getChatMessageById(Number(messageId));
  return String(message?.message || message?.mes || '');
}

function isMemoryFieldLine(line) {
  const match = String(line || '').match(MEMORY_FIELD_LINE_RE);
  return Boolean(match && MEMORY_FIELD_KEYS.has(match[1].trim().toLowerCase()));
}

function isGrandMemoryFieldLine(line) {
  const match = String(line || '').match(MEMORY_FIELD_LINE_RE);
  return Boolean(match && GRAND_MEMORY_FIELD_KEYS.has(match[1].trim().toLowerCase()));
}

function isBeautifyFieldLine(line) {
  return isMemoryFieldLine(line) || isGrandMemoryFieldLine(line);
}

function extractGrandMemoryBlocks(content) {
  return Array.from(String(content || '').matchAll(/<grand_memory\b[^>]*>[\s\S]*?<\/grand_memory>/gi))
    .map(match => match[0].trim());
}

function extractLooseMemoryBlocks(content) {
  const strictBlocks = extractMemoryBlocks(content);
  if (strictBlocks.length) return strictBlocks;
  if (/<grand_memory\b[\s\S]*?<\/grand_memory>/i.test(String(content || ''))) return [];

  const blocks = [];
  let current = [];
  String(content || '').split(/\r?\n/).forEach(line => {
    if (isMemoryFieldLine(line)) {
      current.push(line.trim());
      return;
    }
    if (current.length) {
      blocks.push(`<memory>\n${current.join('\n')}\n</memory>`);
      current = [];
    }
  });
  if (current.length) {
    blocks.push(`<memory>\n${current.join('\n')}\n</memory>`);
  }

  return blocks.filter(block => (
    /\[number\s*:/i.test(block) ||
    (
      /\[time\s*:/i.test(block) &&
      /\[location\s*:/i.test(block) &&
      /\[characters\s*:/i.test(block) &&
      /\[task\s*:/i.test(block) &&
      /\[plot\s*:/i.test(block)
    )
  ));
}

function extractBeautifyBlocks(content) {
  const source = String(content || '');
  const grandMemoryBlocks = extractGrandMemoryBlocks(source);
  const memoryBlocks = grandMemoryBlocks.length ? extractMemoryBlocks(source) : extractLooseMemoryBlocks(source);
  return [
    ...memoryBlocks.map(text => ({ type: 'memory', text })),
    ...grandMemoryBlocks.map(text => ({ type: 'grand_memory', text })),
  ];
}

function ensureOriginalHtml(mesText) {
  if (!mesText || mesText.dataset.slxMemoryOriginalHtml !== undefined) return;
  if (!String(mesText.innerHTML || '').trim()) return;
  mesText.dataset.slxMemoryOriginalHtml = mesText.innerHTML;
}

function restoreOriginalHtml(mesText) {
  if (!mesText || mesText.dataset.slxMemoryOriginalHtml === undefined) return;
  if (!String(mesText.dataset.slxMemoryOriginalHtml || '').trim()) {
    delete mesText.dataset.slxMemoryOriginalHtml;
    return;
  }
  mesText.innerHTML = mesText.dataset.slxMemoryOriginalHtml;
}

function removeMemoryGhostElements(mesText) {
  mesText.querySelectorAll('memory').forEach(element => element.remove());
  mesText.querySelectorAll('grand_memory').forEach(element => element.remove());
  mesText.normalize();
}

function removeMemoryTextNodes(mesText) {
  const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  nodes.forEach(textNode => {
    const original = textNode.textContent || '';
    const cleaned = original
      .replace(/<memory\b[^>]*>[\s\S]*?<\/memory>/gi, '')
      .replace(/<grand_memory\b[^>]*>[\s\S]*?<\/grand_memory>/gi, '')
      .replace(/<\/?memory\b[^>]*>/gi, '')
      .replace(/<\/?grand_memory\b[^>]*>/gi, '')
      .split(/\r?\n/)
      .filter(line => !isBeautifyFieldLine(line))
      .join('\n');
    if (cleaned !== original) {
      textNode.textContent = cleaned;
    }
  });
}

function removeMemoryFieldParagraphs(mesText) {
  Array.from(mesText.querySelectorAll('p, div')).forEach(element => {
    if (element.classList?.contains('slx-memory-wrap')) return;
    const lines = String(element.innerText || element.textContent || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (!lines.length) return;
    const memoryLineCount = lines.filter(isBeautifyFieldLine).length;
    if (memoryLineCount > 0 && memoryLineCount === lines.length) {
      element.remove();
    }
  });
}

function cleanupLeakedMemoryText(mesText) {
  removeMemoryGhostElements(mesText);
  removeMemoryFieldParagraphs(mesText);
  removeMemoryTextNodes(mesText);
}

function hasMemoryDisplaySource(mesText) {
  if (!mesText) return false;
  return Boolean(mesText.querySelector('memory'))
    || Boolean(mesText.querySelector('grand_memory'))
    || /<\/?memory\b/i.test(mesText.textContent || '')
    || /<\/?grand_memory\b/i.test(mesText.textContent || '')
    || /&lt;\/?memory\b/i.test(mesText.innerHTML || '')
    || /&lt;\/?grand_memory\b/i.test(mesText.innerHTML || '')
    || extractBeautifyBlocks(mesText.innerText || mesText.textContent || '').length > 0;
}

function removeExistingCards(messageElement) {
  messageElement.querySelectorAll(':scope .slx-memory-wrap').forEach(element => element.remove());
  messageElement.removeAttribute('data-slx-memory-rendered');
}

function clearMessageElement(messageElement, { restore = true } = {}) {
  if (!messageElement) return;
  removeExistingCards(messageElement);
  const mesText = messageElement.querySelector('.mes_text');
  if (restore && mesText?.dataset.slxMemoryOriginalHtml !== undefined) {
    restoreOriginalHtml(mesText);
    delete mesText.dataset.slxMemoryOriginalHtml;
  }
}

function syncMemoryWrapTheme(messageElement, theme) {
  messageElement
    ?.querySelectorAll?.(':scope .slx-memory-wrap')
    ?.forEach(element => {
      element.dataset.theme = theme;
      syncMemoryThemeControls(element, theme);
    });
}

function createMemoryWrap(blocks, theme) {
  const wrap = document.createElement('div');
  wrap.className = 'slx-memory-wrap';
  wrap.dataset.slxMemoryWrap = 'true';
  wrap.dataset.theme = theme;
  blocks.forEach(block => {
    wrap.append(block.type === 'grand_memory'
      ? renderGrandMemoryCard(block.text, theme)
      : renderMemoryCard(block.text, theme));
  });
  return wrap;
}

function syncMemoryThemeControls(root = document, theme = getMemoryTheme()) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  root.querySelectorAll?.('[data-slx-memory-theme-toggle]')?.forEach(button => {
    button.textContent = theme === 'dark' ? '☀️' : '🌙';
    button.setAttribute('aria-label', `切换小总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`);
    button.title = `切换小总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`;
  });
}

function applyMemoryTheme(theme) {
  document.querySelectorAll('.slx-memory-wrap').forEach(element => {
    element.dataset.theme = theme;
    syncMemoryThemeControls(element, theme);
  });
}

function toggleMemoryTheme() {
  const settings = getGlobalSettings();
  const beautifySettings = getChatBeautifySettings(settings);
  beautifySettings.theme = getMemoryTheme(beautifySettings) === 'dark' ? 'light' : 'dark';
  saveGlobalSettings();
  applyMemoryTheme(beautifySettings.theme);
}

function renderMessageElement(messageElement) {
  const { beautifySettings, active } = getSettings();
  if (!active) {
    clearMessageElement(messageElement);
    return;
  }

  const messageId = getMessageIdFromElement(messageElement);
  if (messageId === null) return;
  const mesText = messageElement.querySelector('.mes_text');
  if (!mesText) return;

  const rawMessageText = getMessageText(messageId);
  const blocks = extractBeautifyBlocks(rawMessageText);
  if (!blocks.length) {
    clearMessageElement(messageElement, { restore: false });
    return;
  }

  const hash = hashMemoryBlocks(blocks);
  const theme = getMemoryTheme(beautifySettings);
  if (
    messageElement.dataset.slxMemoryRendered === hash
    && messageElement.querySelector(':scope .slx-memory-wrap')
  ) {
    if (!beautifySettings.showRawAlongside) {
      cleanupLeakedMemoryText(mesText);
    }
    syncMemoryWrapTheme(messageElement, theme);
    return;
  }

  ensureOriginalHtml(mesText);
  restoreOriginalHtml(mesText);
  removeExistingCards(messageElement);
  const hadDisplaySource = hasMemoryDisplaySource(mesText);

  if (!beautifySettings.showRawAlongside && hadDisplaySource) {
    cleanupLeakedMemoryText(mesText);
  }

  const wrap = createMemoryWrap(blocks, theme);
  wrap.dataset.slxMemoryHash = hash;
  mesText.append(wrap);
  messageElement.dataset.slxMemoryRendered = hash;
}

function refreshVisibleMessages() {
  if (!getSettings().active) {
    clearChatBeautifyRenderer({ keepEvents: true });
    return;
  }
  const elements = getVisibleMessageElements();
  if (elements.length) {
    elements.forEach(renderMessageElement);
    return;
  }

  getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => extractBeautifyBlocks(message.message).length > 0)
    .forEach(message => {
      const element = getMessageElementById(message.message_id);
      if (element) renderMessageElement(element);
    });
}

function scheduleRefresh(messageId = null) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    if (messageId !== null && messageId !== undefined && Number.isInteger(Number(messageId))) {
      const element = getMessageElementById(Number(messageId));
      if (element) {
        renderMessageElement(element);
        return;
      }
    }
    refreshVisibleMessages();
  }, MEMORY_RENDER_DELAY_MS);
}

function bindCardToggle(event) {
  const title = event.target.closest?.('.slx-memory-card__title');
  if (!title) return;
  const card = title.closest('.slx-memory-card');
  if (!card) return;
  const collapsed = card.classList.toggle('slx-memory-card--collapsed');
  title.setAttribute('aria-expanded', String(!collapsed));
}

function bindMemoryThemeToggle(event) {
  const button = event.target.closest?.('[data-slx-memory-theme-toggle]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  toggleMemoryTheme();
}

function registerRendererEvents() {
  const events = getTavernEventsSafe();
  const eventNames = [
    events.CHARACTER_MESSAGE_RENDERED,
    events.USER_MESSAGE_RENDERED,
    events.MESSAGE_RENDERED,
    events.MESSAGE_SWIPED,
    events.MESSAGE_UPDATED,
    events.MESSAGE_EDITED,
    events.CHAT_CHANGED,
    events.GENERATION_ENDED,
    events.GENERATION_AFTER_COMMANDS,
  ].filter(Boolean);

  const uniqueEventNames = [...new Set(eventNames)];
  eventStops = uniqueEventNames
    .map(eventName => registerTavernEvent(eventName, () => scheduleRefresh()))
    .filter(Boolean);
  document.addEventListener('click', bindCardToggle);
  document.addEventListener('click', bindMemoryThemeToggle);
}

export function registerChatBeautifyRenderer() {
  if (rendererRegistered) return;
  if (!getSettings().active) {
    clearChatBeautifyRenderer();
    return;
  }

  registerRendererEvents();
  rendererRegistered = true;
  scheduleRefresh();
}

export function refreshChatBeautifyRenderer() {
  scheduleRefresh();
}

export function clearChatBeautifyRenderer(options = {}) {
  window.clearTimeout(refreshTimer);
  refreshTimer = null;
  getVisibleMessageElements().forEach(element => clearMessageElement(element));

  if (!options.keepEvents) {
    eventStops.forEach(stop => stop?.stop?.());
    eventStops = [];
    document.removeEventListener('click', bindCardToggle);
    document.removeEventListener('click', bindMemoryThemeToggle);
    rendererRegistered = false;
  }
}
