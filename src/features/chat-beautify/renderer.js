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
import { renderGrandMemoryCard } from './render-grand-memory.js?v=0.16.34';
import { renderMemoryCard } from './render-memory.js';

export const MEMORY_RENDER_DELAY_MS = 220;
const MEMORY_RENDER_FORMAT_VERSION = 9;
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
  'affection_first',
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
const OBVIOUS_MEMORY_TAG_RE = /<\/?memory\b|<\/?grand_memory\b/i;
const OBVIOUS_ESCAPED_MEMORY_TAG_RE = /&lt;\/?memory\b|&lt;\/?grand_memory\b/i;

let rendererRegistered = false;
let eventStops = [];
let refreshTimer = null;
const dirtyMessageIds = new Set();
let needsFullRefresh = false;

/** @type {{ heavyCleanupCount: number, settingsBuildCount: number, fullRefreshCount: number, lastPartialRenderIds: number[] }} */
const perfCounters = {
  heavyCleanupCount: 0,
  settingsBuildCount: 0,
  fullRefreshCount: 0,
  /** Bound: overwritten each partial flush; never accumulates history. */
  lastPartialRenderIds: [],
};

function getSettingsBundle() {
  perfCounters.settingsBuildCount += 1;
  const globalSettings = getGlobalSettings();
  const beautifySettings = getChatBeautifySettings(globalSettings);
  return {
    globalSettings,
    beautifySettings,
    active: Boolean(globalSettings.enabled && beautifySettings.enabled && beautifySettings.renderMemory),
    theme: getMemoryTheme(beautifySettings),
  };
}

function getMemoryTheme(beautifySettings = getChatBeautifySettings()) {
  return beautifySettings.theme === 'dark' ? 'dark' : 'light';
}

function hashMemoryBlocks(blocks) {
  const text = blocks.map(block => `${block.type}:${block.text}`).join('\n\n');
  return `${MEMORY_RENDER_FORMAT_VERSION}:${blocks.length}:${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
}

function hashTextFingerprint(text) {
  let hash = 2166136261;
  String(text || '').split('').forEach(char => {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  });
  return (hash >>> 0).toString(36);
}

function getMessageSwipeId(messageElement) {
  return String(
    messageElement?.getAttribute?.('swipeid')
      ?? messageElement?.dataset?.swipeid
      ?? '',
  );
}

function createMessageSourceKey(messageElement, rawMessageText) {
  const text = String(rawMessageText || '');
  return `${getMessageSwipeId(messageElement)}:${text.length}:${hashTextFingerprint(text)}`;
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

function clearLegacyOriginalHtmlSnapshot(mesText) {
  if (!mesText) return;
  delete mesText.dataset.slxMemoryOriginalHtml;
  delete mesText.dataset.slxMemoryOriginalSourceKey;
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
  perfCounters.heavyCleanupCount += 1;
  removeMemoryGhostElements(mesText);
  removeMemoryFieldParagraphs(mesText);
  removeMemoryTextNodes(mesText);
}

function hasObviousFieldOnlyLines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  return lines.every(isBeautifyFieldLine);
}

/**
 * Lightweight leak probe: shallow checks only.
 * Must NOT TreeWalker / full p,div scan / full cleanup regex chain / whole mes_text.innerHTML serialize.
 */
export function hasLightweightMemoryLeak(mesText) {
  if (!mesText) return false;
  if (typeof mesText.querySelector === 'function') {
    if (mesText.querySelector('memory') || mesText.querySelector('grand_memory')) return true;
  }

  const children = mesText.childNodes ? Array.from(mesText.childNodes) : [];
  for (const child of children) {
    if (child?.nodeType === 3) {
      const text = child.textContent || '';
      if (OBVIOUS_MEMORY_TAG_RE.test(text) || hasObviousFieldOnlyLines(text)) return true;
      continue;
    }
    if (child?.nodeType === 1) {
      if (child.classList?.contains?.('slx-memory-wrap')) continue;
      const tag = String(child.tagName || '').toLowerCase();
      if (tag === 'memory' || tag === 'grand_memory') return true;
      // Direct child text only — do not serialize the whole mes_text subtree as innerHTML.
      const text = child.textContent || '';
      if (OBVIOUS_MEMORY_TAG_RE.test(text) || OBVIOUS_ESCAPED_MEMORY_TAG_RE.test(text)) return true;
      if (hasObviousFieldOnlyLines(text)) return true;
    }
  }

  // Fallback when childNodes unavailable (test doubles): sample textContent once, not innerHTML.
  if (!children.length) {
    const text = String(mesText.textContent || '');
    if (OBVIOUS_MEMORY_TAG_RE.test(text) || OBVIOUS_ESCAPED_MEMORY_TAG_RE.test(text)) return true;
  }
  return false;
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

function clearCleanupMarks(messageElement, mesText = null) {
  if (messageElement?.removeAttribute) {
    messageElement.removeAttribute('data-slx-memory-cleaned');
    messageElement.removeAttribute('data-slx-memory-cleaned-source');
  }
  if (messageElement?.dataset) {
    delete messageElement.dataset.slxMemoryCleaned;
    delete messageElement.dataset.slxMemoryCleanedSource;
  }
  const target = mesText || messageElement?.querySelector?.('.mes_text');
  if (target?.removeAttribute) {
    target.removeAttribute('data-slx-memory-cleaned');
    target.removeAttribute('data-slx-memory-cleaned-source');
  }
  if (target?.dataset) {
    delete target.dataset.slxMemoryCleaned;
    delete target.dataset.slxMemoryCleanedSource;
  }
}

function markCleanupComplete(messageElement, mesText, hash) {
  if (messageElement?.setAttribute) {
    messageElement.setAttribute('data-slx-memory-cleaned', '1');
    messageElement.setAttribute('data-slx-memory-cleaned-source', hash);
  }
  if (messageElement?.dataset) {
    messageElement.dataset.slxMemoryCleaned = '1';
    messageElement.dataset.slxMemoryCleanedSource = hash;
  }
  if (mesText?.setAttribute) {
    mesText.setAttribute('data-slx-memory-cleaned', '1');
    mesText.setAttribute('data-slx-memory-cleaned-source', hash);
  }
  if (mesText?.dataset) {
    mesText.dataset.slxMemoryCleaned = '1';
    mesText.dataset.slxMemoryCleanedSource = hash;
  }
}

function isCleanupMarkedForHash(messageElement, mesText, hash) {
  const source = messageElement?.dataset?.slxMemoryCleanedSource
    ?? messageElement?.getAttribute?.('data-slx-memory-cleaned-source')
    ?? mesText?.dataset?.slxMemoryCleanedSource
    ?? mesText?.getAttribute?.('data-slx-memory-cleaned-source')
    ?? '';
  const cleaned = messageElement?.dataset?.slxMemoryCleaned
    ?? messageElement?.getAttribute?.('data-slx-memory-cleaned')
    ?? mesText?.dataset?.slxMemoryCleaned
    ?? mesText?.getAttribute?.('data-slx-memory-cleaned')
    ?? '';
  return Boolean(cleaned) && source === hash;
}

function removeExistingCards(messageElement) {
  messageElement.querySelectorAll(':scope .slx-memory-wrap').forEach(element => element.remove());
  messageElement.removeAttribute('data-slx-memory-rendered');
  clearCleanupMarks(messageElement);
}

function clearMessageElement(messageElement) {
  if (!messageElement) return;
  removeExistingCards(messageElement);
  const mesText = messageElement.querySelector('.mes_text');
  clearLegacyOriginalHtmlSnapshot(mesText);
  clearCleanupMarks(messageElement, mesText);
}

function syncMemoryThemeControls(root = document, theme = getMemoryTheme()) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  root.querySelectorAll?.('[data-slx-memory-theme-toggle]')?.forEach(button => {
    button.textContent = theme === 'dark' ? '\u2600\uFE0F' : '\u{1F319}';
    button.setAttribute('aria-label', `切换小总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`);
    button.title = `切换小总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`;
  });
}

function syncMemoryWrapTheme(messageElement, theme) {
  messageElement
    ?.querySelectorAll?.(':scope .slx-memory-wrap')
    ?.forEach(element => {
      if (element.dataset?.theme === theme) return;
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

function applyMemoryTheme(theme) {
  document.querySelectorAll('.slx-memory-wrap').forEach(element => {
    if (element.dataset?.theme === theme) {
      return;
    }
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

/**
 * One-shot render context for a flush batch.
 * settings are resolved once; chat snapshot is built once for the batch.
 */
export function createBeautifyRenderContext(options = {}) {
  const bundle = getSettingsBundle();
  const messageById = new Map();
  let snapshotBuilt = false;

  function ensureSnapshot(ids = null) {
    if (snapshotBuilt) return messageById;
    snapshotBuilt = true;
    if (Array.isArray(ids) && ids.length > 0) {
      ids.forEach(id => {
        const message = getChatMessageById(Number(id));
        if (message) messageById.set(Number(id), message);
      });
      return messageById;
    }
    getChatMessagesSafe(undefined, { hide_state: 'all' }).forEach(message => {
      messageById.set(Number(message.message_id), message);
    });
    return messageById;
  }

  if (options.preload === 'all') {
    ensureSnapshot(null);
  } else if (Array.isArray(options.messageIds) && options.messageIds.length) {
    ensureSnapshot(options.messageIds);
  }

  return {
    ...bundle,
    messageById,
    ensureSnapshot,
    getMessageText(messageId) {
      ensureSnapshot(options.messageIds || null);
      const message = messageById.get(Number(messageId)) || getChatMessageById(Number(messageId));
      if (message && !messageById.has(Number(messageId))) {
        messageById.set(Number(messageId), message);
      }
      return String(message?.message || message?.mes || '');
    },
  };
}

export function renderMessageElement(messageElement, renderContext = null) {
  const context = renderContext || createBeautifyRenderContext();
  const { beautifySettings, active, theme } = context;
  if (!active) {
    clearMessageElement(messageElement);
    return { status: 'inactive' };
  }

  const messageId = getMessageIdFromElement(messageElement);
  if (messageId === null) return { status: 'no-id' };
  const mesText = messageElement.querySelector('.mes_text');
  if (!mesText) return { status: 'no-mes-text' };

  const rawMessageText = context.getMessageText(messageId);
  const blocks = extractBeautifyBlocks(rawMessageText);
  if (!blocks.length) {
    clearMessageElement(messageElement);
    return { status: 'no-blocks' };
  }

  const sourceKey = createMessageSourceKey(messageElement, rawMessageText);
  const hash = `${sourceKey}:${hashMemoryBlocks(blocks)}`;
  const existingWrap = messageElement.querySelector(':scope .slx-memory-wrap');
  if (
    messageElement.dataset.slxMemoryRendered === hash
    && existingWrap
  ) {
    if (!beautifySettings.showRawAlongside) {
      const alreadyClean = isCleanupMarkedForHash(messageElement, mesText, hash);
      const leak = hasLightweightMemoryLeak(mesText);
      if (alreadyClean && !leak) {
        syncMemoryWrapTheme(messageElement, theme);
        return { status: 'fast-path', hash, heavyCleanup: false };
      }
      if (leak || !alreadyClean) {
        cleanupLeakedMemoryText(mesText);
        markCleanupComplete(messageElement, mesText, hash);
        syncMemoryWrapTheme(messageElement, theme);
        return { status: 'hash-hit-cleanup', hash, heavyCleanup: true };
      }
    }
    syncMemoryWrapTheme(messageElement, theme);
    return { status: 'hash-hit', hash, heavyCleanup: false };
  }

  clearLegacyOriginalHtmlSnapshot(mesText);
  removeExistingCards(messageElement);
  const hadDisplaySource = hasMemoryDisplaySource(mesText);

  if (!beautifySettings.showRawAlongside && hadDisplaySource) {
    cleanupLeakedMemoryText(mesText);
  }

  const wrap = createMemoryWrap(blocks, theme);
  wrap.dataset.slxMemoryHash = hash;
  mesText.append(wrap);
  messageElement.dataset.slxMemoryRendered = hash;
  if (!beautifySettings.showRawAlongside) {
    markCleanupComplete(messageElement, mesText, hash);
  }
  return { status: 'rendered', hash, heavyCleanup: !beautifySettings.showRawAlongside && hadDisplaySource };
}

function refreshVisibleMessages(renderContext = null) {
  perfCounters.fullRefreshCount += 1;
  const context = renderContext || createBeautifyRenderContext({ preload: 'all' });
  if (!context.active) {
    clearChatBeautifyRenderer({ keepEvents: true });
    return;
  }
  context.ensureSnapshot(null);
  const elements = getVisibleMessageElements();
  if (elements.length) {
    elements.forEach(element => renderMessageElement(element, context));
    return;
  }

  getChatMessagesSafe(undefined, { hide_state: 'all' })
    .filter(message => extractBeautifyBlocks(message.message).length > 0)
    .forEach(message => {
      const element = getMessageElementById(message.message_id);
      if (element) renderMessageElement(element, context);
    });
}

/**
 * Extract a reliable message id from event args.
 * Never treats generation_id as messageId.
 */
export function extractBeautifyMessageIdFromArgs(...args) {
  for (const arg of args) {
    if (typeof arg === 'number' && Number.isInteger(arg) && arg >= 0) {
      return arg;
    }
    if (typeof arg === 'string' && /^\d+$/.test(arg.trim())) {
      return Number(arg.trim());
    }
    if (!arg || typeof arg !== 'object') continue;

    // generation_id-only (or generation payload without message id fields) must not become a message id.
    const hasGenerationId = Object.prototype.hasOwnProperty.call(arg, 'generation_id')
      || Object.prototype.hasOwnProperty.call(arg, 'generationId');
    const candidate = arg.message_id ?? arg.messageId ?? arg.mesid;
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      const numeric = Number(candidate);
      if (Number.isInteger(numeric) && numeric >= 0) return numeric;
    }
    if (hasGenerationId) {
      // Do not fall through to generic `id` on generation payloads.
      continue;
    }
    if (arg.id !== undefined && arg.id !== null && arg.id !== '') {
      const numeric = Number(arg.id);
      if (Number.isInteger(numeric) && numeric >= 0) return numeric;
    }
  }
  return null;
}

/**
 * Resolve a reliable message id for a named Tavern event.
 * Returns null when the event should not use that id (caller consults resolveBeautifyEventAction).
 * Never treats generation_id as messageId.
 */
export function resolveBeautifyEventMessageId(eventName, ...args) {
  const events = getTavernEventsSafe();
  const name = String(eventName || '');
  if (events.CHAT_CHANGED && name === String(events.CHAT_CHANGED)) return null;
  if (events.GENERATION_AFTER_COMMANDS && name === String(events.GENERATION_AFTER_COMMANDS)) return null;
  return extractBeautifyMessageIdFromArgs(...args);
}

/**
 * Classify how Beautify should react to a Tavern event.
 * - full: CHAT_CHANGED or unparseable non-generation message events
 * - partial: reliable messageId dirty enqueue
 * - noop: GENERATION_AFTER_COMMANDS; GENERATION_ENDED without messageId
 */
export function resolveBeautifyEventAction(eventName, ...args) {
  const events = getTavernEventsSafe();
  const name = String(eventName || '');

  if (events.CHAT_CHANGED && name === String(events.CHAT_CHANGED)) {
    return { action: 'full', messageId: null };
  }
  if (events.GENERATION_AFTER_COMMANDS && name === String(events.GENERATION_AFTER_COMMANDS)) {
    return { action: 'noop', messageId: null };
  }
  if (events.GENERATION_ENDED && name === String(events.GENERATION_ENDED)) {
    const messageId = extractBeautifyMessageIdFromArgs(...args);
    if (messageId === null) return { action: 'noop', messageId: null };
    return { action: 'partial', messageId };
  }

  const messageId = extractBeautifyMessageIdFromArgs(...args);
  if (messageId === null) return { action: 'full', messageId: null };
  return { action: 'partial', messageId };
}

function enqueueRefresh({ full = false, messageId = null } = {}) {
  if (full || messageId === null || messageId === undefined) {
    needsFullRefresh = true;
  } else {
    const numeric = Number(messageId);
    if (Number.isInteger(numeric) && numeric >= 0) {
      dirtyMessageIds.add(numeric);
    } else {
      needsFullRefresh = true;
    }
  }
}

export function scheduleBeautifyRefresh(options = {}) {
  if (options === null || options === undefined) {
    enqueueRefresh({ full: true });
  } else if (typeof options === 'number' || typeof options === 'string') {
    const numeric = Number(options);
    if (Number.isInteger(numeric) && numeric >= 0) {
      enqueueRefresh({ messageId: numeric });
    } else {
      enqueueRefresh({ full: true });
    }
  } else if (options.full === true) {
    enqueueRefresh({ full: true });
  } else if (options.messageId !== undefined && options.messageId !== null) {
    enqueueRefresh({ messageId: options.messageId });
  } else {
    enqueueRefresh({ full: true });
  }

  const delay = Number.isFinite(options.delayMs) ? options.delayMs : MEMORY_RENDER_DELAY_MS;
  const schedule = typeof options.schedule === 'function'
    ? options.schedule
    : (callback, ms) => window.setTimeout(callback, ms);
  const cancel = typeof options.cancel === 'function'
    ? options.cancel
    : id => window.clearTimeout(id);

  if (refreshTimer !== null && refreshTimer !== undefined) {
    cancel(refreshTimer);
  }
  refreshTimer = schedule(() => {
    refreshTimer = null;
    flushBeautifyRefresh();
  }, delay);
  return refreshTimer;
}

export function flushBeautifyRefresh() {
  const doFull = needsFullRefresh;
  const ids = [...dirtyMessageIds];
  needsFullRefresh = false;
  dirtyMessageIds.clear();

  if (doFull) {
    perfCounters.lastPartialRenderIds = [];
    const context = createBeautifyRenderContext({ preload: 'all' });
    refreshVisibleMessages(context);
    return { mode: 'full', messageIds: ids };
  }

  if (!ids.length) {
    perfCounters.lastPartialRenderIds = [];
    return { mode: 'noop', messageIds: [] };
  }

  const missing = ids.some(id => !getMessageElementById(id));
  if (missing) {
    perfCounters.lastPartialRenderIds = [];
    const fullContext = createBeautifyRenderContext({ preload: 'all' });
    refreshVisibleMessages(fullContext);
    return { mode: 'full-fallback', messageIds: ids };
  }

  const context = createBeautifyRenderContext({ messageIds: ids });
  // Bound counter: replace (never append across flushes).
  perfCounters.lastPartialRenderIds = [...ids];
  ids.forEach(id => {
    const element = getMessageElementById(id);
    if (element) renderMessageElement(element, context);
  });
  return { mode: 'partial', messageIds: ids };
}

function handleBeautifyTavernEvent(eventName, ...args) {
  const decision = resolveBeautifyEventAction(eventName, ...args);
  if (decision.action === 'noop') return;
  if (decision.action === 'full') {
    scheduleBeautifyRefresh({ full: true });
    return;
  }
  scheduleBeautifyRefresh({ messageId: decision.messageId });
}

function bindCardToggle(event) {
  const sectionHead = event.target.closest?.('.slx-grand-section__head');
  if (sectionHead) {
    const section = sectionHead.closest('.slx-grand-section');
    if (!section) return;
    const collapsed = section.classList.toggle('slx-grand-section--collapsed');
    sectionHead.setAttribute('aria-expanded', String(!collapsed));
    return;
  }

  const eventHead = event.target.closest?.('.slx-grand-event__head');
  if (eventHead) {
    const grandEvent = eventHead.closest('.slx-grand-event');
    if (!grandEvent) return;
    const collapsed = grandEvent.classList.toggle('slx-grand-event--collapsed');
    eventHead.setAttribute('aria-expanded', String(!collapsed));
    return;
  }

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
    .map(eventName => registerTavernEvent(eventName, (...args) => handleBeautifyTavernEvent(eventName, ...args)))
    .filter(Boolean);
  document.addEventListener('click', bindCardToggle);
  document.addEventListener('click', bindMemoryThemeToggle);
}

export function registerChatBeautifyRenderer() {
  if (rendererRegistered) return;
  if (!getSettingsBundle().active) {
    clearChatBeautifyRenderer();
    return;
  }

  registerRendererEvents();
  rendererRegistered = true;
  scheduleBeautifyRefresh({ full: true });
}

export function refreshChatBeautifyRenderer() {
  scheduleBeautifyRefresh({ full: true });
}

export function clearChatBeautifyRenderer(options = {}) {
  if (refreshTimer !== null && refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer);
  }
  refreshTimer = null;
  dirtyMessageIds.clear();
  needsFullRefresh = false;
  getVisibleMessageElements().forEach(element => clearMessageElement(element));

  if (!options.keepEvents) {
    eventStops.forEach(stop => stop?.stop?.());
    eventStops = [];
    document.removeEventListener('click', bindCardToggle);
    document.removeEventListener('click', bindMemoryThemeToggle);
    rendererRegistered = false;
  }
}

/** Test helpers — not used by production paths. */
export function getBeautifyRefreshQueueStateForTests() {
  return {
    dirtyMessageIds: [...dirtyMessageIds],
    needsFullRefresh,
    refreshTimer,
    rendererRegistered,
  };
}

export function getBeautifyPerfCountersForTests() {
  return {
    heavyCleanupCount: perfCounters.heavyCleanupCount,
    settingsBuildCount: perfCounters.settingsBuildCount,
    fullRefreshCount: perfCounters.fullRefreshCount,
    lastPartialRenderIds: [...perfCounters.lastPartialRenderIds],
  };
}

export function resetBeautifyRendererStateForTests() {
  if (refreshTimer !== null && refreshTimer !== undefined) {
    try {
      window.clearTimeout?.(refreshTimer);
    } catch {
      // ignore
    }
  }
  refreshTimer = null;
  dirtyMessageIds.clear();
  needsFullRefresh = false;
  eventStops.forEach(stop => stop?.stop?.());
  eventStops = [];
  rendererRegistered = false;
  perfCounters.heavyCleanupCount = 0;
  perfCounters.settingsBuildCount = 0;
  perfCounters.fullRefreshCount = 0;
  perfCounters.lastPartialRenderIds = [];
}
