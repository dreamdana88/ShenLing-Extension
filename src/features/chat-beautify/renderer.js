import {
  getChatMessageById,
  getChatMessagesSafe,
} from '../../core/chat.js';
import { extractMemoryBlocks } from '../../core/summary.js';
import {
  getChatBeautifySettings,
  getGlobalSettings,
} from '../../core/settings.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import { renderMemoryCard } from './render-memory.js';

const MEMORY_RENDER_DELAY_MS = 120;

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

function hashMemoryBlocks(blocks) {
  const text = blocks.join('\n\n');
  return `${blocks.length}:${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
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

function ensureOriginalHtml(mesText) {
  if (!mesText || mesText.dataset.slxMemoryOriginalHtml !== undefined) return;
  mesText.dataset.slxMemoryOriginalHtml = mesText.innerHTML;
}

function restoreOriginalHtml(mesText) {
  if (!mesText || mesText.dataset.slxMemoryOriginalHtml === undefined) return;
  mesText.innerHTML = mesText.dataset.slxMemoryOriginalHtml;
}

function removeMemoryGhostElements(mesText) {
  mesText.querySelectorAll('memory').forEach(element => element.remove());
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
      .replace(/<\/?memory\b[^>]*>/gi, '');
    if (cleaned !== original) {
      textNode.textContent = cleaned;
    }
  });
}

function cleanupLeakedMemoryText(mesText) {
  removeMemoryGhostElements(mesText);
  removeMemoryTextNodes(mesText);
}

function hasMemoryDisplaySource(mesText) {
  if (!mesText) return false;
  return Boolean(mesText.querySelector('memory'))
    || /<\/?memory\b/i.test(mesText.textContent || '')
    || /&lt;\/?memory\b/i.test(mesText.innerHTML || '');
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

function createMemoryWrap(blocks) {
  const wrap = document.createElement('div');
  wrap.className = 'slx-memory-wrap';
  wrap.dataset.slxMemoryWrap = 'true';
  blocks.forEach(block => {
    wrap.append(renderMemoryCard(block));
  });
  return wrap;
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

  const blocks = extractMemoryBlocks(getMessageText(messageId));
  if (!blocks.length) {
    clearMessageElement(messageElement);
    return;
  }

  const hash = hashMemoryBlocks(blocks);
  if (
    messageElement.dataset.slxMemoryRendered === hash
    && messageElement.querySelector(':scope .slx-memory-wrap')
  ) {
    return;
  }

  ensureOriginalHtml(mesText);
  restoreOriginalHtml(mesText);
  removeExistingCards(messageElement);
  if (!beautifySettings.showRawAlongside && !hasMemoryDisplaySource(mesText)) {
    return;
  }

  if (!beautifySettings.showRawAlongside) {
    cleanupLeakedMemoryText(mesText);
  }

  const wrap = createMemoryWrap(blocks);
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
    .filter(message => extractMemoryBlocks(message.message).length > 0)
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
    rendererRegistered = false;
  }
}
