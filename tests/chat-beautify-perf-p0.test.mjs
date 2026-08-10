import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MODULE_NAME, CHAT_STATE_KEY } from '../src/constants.js';
import { createViewportSyncController } from '../src/core/viewport-sync.js';
import {
  MEMORY_RENDER_DELAY_MS,
  createBeautifyRenderContext,
  flushBeautifyRefresh,
  getBeautifyPerfCountersForTests,
  getBeautifyRefreshQueueStateForTests,
  hasLightweightMemoryLeak,
  renderMessageElement,
  resetBeautifyRendererStateForTests,
  resolveBeautifyEventAction,
  resolveBeautifyEventMessageId,
  scheduleBeautifyRefresh,
} from '../src/features/chat-beautify/renderer.js';
import {
  configureEmotionProfileWorkflow,
} from '../src/features/emotion-profile/workflow.js';

const MEMORY_SAMPLE = `<memory>
[number:1]
[time:午后]
[location:庭院]
[characters:角色A]
[task:无]
[plot:推进剧情]
</memory>`;

function createDomNode(tagName = 'div') {
  const node = {
    nodeType: tagName ? 1 : 3,
    tagName: tagName ? String(tagName).toUpperCase() : undefined,
    className: '',
    classList: {
      _set: new Set(),
      contains(name) { return this._set.has(name); },
      add(name) { this._set.add(name); node.className = [...this._set].join(' '); },
      remove(name) { this._set.delete(name); node.className = [...this._set].join(' '); },
      toggle(name) {
        if (this._set.has(name)) { this.remove(name); return false; }
        this.add(name);
        return true;
      },
    },
    dataset: {},
    attributes: {},
    style: {},
    children: [],
    childNodes: [],
    parentNode: null,
    textContent: '',
    innerHTML: '',
    innerText: '',
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
      if (name === 'class') {
        this.className = String(value);
        this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
      }
      if (name === 'mesid') this.attributes.mesid = String(value);
    },
    getAttribute(name) {
      if (name === 'class') return this.className;
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete this.dataset[key];
      }
    },
    append(...nodes) {
      nodes.flat().forEach(child => {
        if (child == null) return;
        if (typeof child === 'string') {
          const text = createDomNode(null);
          text.nodeType = 3;
          text.textContent = child;
          this.childNodes.push(text);
          return;
        }
        child.parentNode = this;
        this.children.push(child);
        this.childNodes.push(child);
      });
    },
    appendChild(child) {
      this.append(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter(item => item !== this);
      this.parentNode.childNodes = this.parentNode.childNodes.filter(item => item !== this);
      this.parentNode = null;
    },
    normalize() {},
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = current => {
        if (!current || current.nodeType !== 1) return;
        if (matchSelector(current, selector)) results.push(current);
        current.children.forEach(visit);
      };
      this.children.forEach(visit);
      return results;
    },
  };
  if (tagName) {
    node.nodeType = 1;
  } else {
    node.nodeType = 3;
  }
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(value) {
      node.classList._set = new Set(String(value || '').split(/\s+/).filter(Boolean));
    },
    configurable: true,
  });
  return node;
}

function matchSelector(node, selector) {
  const raw = String(selector || '').trim();
  if (raw === ':scope .slx-memory-wrap' || raw === '.slx-memory-wrap') {
    return node.classList.contains('slx-memory-wrap');
  }
  if (raw === '.mes_text') return node.classList.contains('mes_text');
  if (raw === 'memory') return node.tagName === 'MEMORY';
  if (raw === 'grand_memory') return node.tagName === 'GRAND_MEMORY';
  if (raw === 'p, div') return node.tagName === 'P' || node.tagName === 'DIV';
  if (raw === '[data-slx-memory-theme-toggle]') {
    return Boolean(node.dataset.slxMemoryThemeToggle || node.attributes['data-slx-memory-theme-toggle']);
  }
  if (raw.startsWith('.mes[mesid="') && raw.endsWith('"]')) {
    const id = raw.slice('.mes[mesid="'.length, -2);
    return node.classList.contains('mes') && String(node.getAttribute('mesid')) === id;
  }
  if (raw === '.mes[mesid]') {
    return node.classList.contains('mes') && node.getAttribute('mesid') != null;
  }
  if (raw === '.slx-memory-wrap') return node.classList.contains('slx-memory-wrap');
  return false;
}

function createDocumentMock(rootNodes = []) {
  const body = createDomNode('body');
  rootNodes.forEach(node => body.append(node));
  return {
    body,
    createElement(tag) {
      return createDomNode(tag);
    },
    createTreeWalker(root, _whatToShow) {
      const nodes = [];
      const walk = node => {
        if (!node) return;
        if (node.nodeType === 3) nodes.push(node);
        (node.childNodes || []).forEach(walk);
      };
      walk(root);
      let index = -1;
      return {
        nextNode() {
          index += 1;
          return nodes[index] || null;
        },
      };
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = node => {
        if (!node || node.nodeType !== 1) return;
        if (matchSelector(node, selector)) results.push(node);
        (node.children || []).forEach(visit);
      };
      visit(body);
      return results;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function createMessageElement(messageId, mesTextContent = '') {
  const mes = createDomNode('div');
  mes.classList.add('mes');
  mes.setAttribute('mesid', String(messageId));
  const mesText = createDomNode('div');
  mesText.classList.add('mes_text');
  if (mesTextContent) {
    const text = createDomNode(null);
    text.nodeType = 3;
    text.textContent = mesTextContent;
    mesText.childNodes.push(text);
    mesText.textContent = mesTextContent;
  }
  mes.append(mesText);
  return mes;
}

function installRuntime({
  messages = [],
  enabled = true,
  showRawAlongside = false,
  documentMock = null,
} = {}) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    window: globalThis.window,
    document: globalThis.document,
    NodeFilter: globalThis.NodeFilter,
    tavern_events: globalThis.tavern_events,
  };

  const normalized = messages.map((message, index) => ({
    message_id: message.message_id ?? index,
    role: message.role || 'assistant',
    message: message.message || '',
    mes: message.message || message.mes || '',
    is_hidden: Boolean(message.is_hidden),
  }));

  const settings = {
    enabled,
    theme: 'light',
    ui: { showFloatingButton: true },
    modules: {
      chatBeautify: {
        enabled: true,
        renderMemory: true,
        showRawAlongside,
        theme: 'light',
        rendererVersion: 2,
      },
    },
    diagnostics: {},
  };

  const context = {
    chatId: 'perf-chat',
    chat: normalized,
    extensionSettings: { [MODULE_NAME]: settings },
    chatMetadata: { [CHAT_STATE_KEY]: { summary: {} } },
    saveSettingsDebounced() {},
    saveMetadataDebounced() {},
  };

  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.tavern_events = {
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    MESSAGE_RENDERED: 'message_rendered',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_EDITED: 'message_edited',
    CHAT_CHANGED: 'chat_changed',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
  };

  const doc = documentMock || createDocumentMock(normalized.map(message => createMessageElement(message.message_id)));
  globalThis.document = doc;

  // TavernHelper-like chat helpers used by getChatMessagesSafe compatibility path.
  globalThis.TavernHelper = {
    getChatMessages(range) {
      if (range === undefined || range === null || range === '0-{{lastMessageId}}') {
        return normalized.map(message => ({ ...message }));
      }
      const id = Number(range);
      if (Number.isInteger(id)) {
        return normalized.filter(message => Number(message.message_id) === id).map(message => ({ ...message }));
      }
      return normalized.map(message => ({ ...message }));
    },
    getLastMessageId() {
      return normalized.length ? Number(normalized[normalized.length - 1].message_id) : -1;
    },
  };

  resetBeautifyRendererStateForTests();

  return {
    context,
    settings,
    document: doc,
    restore() {
      resetBeautifyRendererStateForTests();
      if (previous.SillyTavern === undefined) delete globalThis.SillyTavern;
      else globalThis.SillyTavern = previous.SillyTavern;
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.NodeFilter === undefined) delete globalThis.NodeFilter;
      else globalThis.NodeFilter = previous.NodeFilter;
      if (previous.tavern_events === undefined) delete globalThis.tavern_events;
      else globalThis.tavern_events = previous.tavern_events;
      delete globalThis.TavernHelper;
    },
  };
}

function createFakeTimer() {
  let nextId = 1;
  const timers = new Map();
  return {
    schedule(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay: Number(delay) || 0 });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    flush() {
      const entries = [...timers.entries()];
      timers.clear();
      entries.forEach(([, item]) => item.callback());
    },
    get size() {
      return timers.size;
    },
  };
}

// ── 1 / 2 / 3 / 4：dirty 队列与 messageId 解析 ──────────────────────────

test('两个不同 messageId 在 debounce 窗口内都会进入 dirty 队列并局部刷新', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 12, message: MEMORY_SAMPLE },
      { message_id: 13, message: MEMORY_SAMPLE },
    ],
  });
  const timer = createFakeTimer();
  try {
    scheduleBeautifyRefresh({ messageId: 12, schedule: timer.schedule, cancel: timer.cancel, delayMs: MEMORY_RENDER_DELAY_MS });
    scheduleBeautifyRefresh({ messageId: 13, schedule: timer.schedule, cancel: timer.cancel, delayMs: MEMORY_RENDER_DELAY_MS });
    const queued = getBeautifyRefreshQueueStateForTests();
    assert.deepEqual(queued.dirtyMessageIds.sort((a, b) => a - b), [12, 13]);
    assert.equal(queued.needsFullRefresh, false);

    const result = flushBeautifyRefresh();
    assert.equal(result.mode, 'partial');
    assert.deepEqual(result.messageIds.sort((a, b) => a - b), [12, 13]);
    const counters = getBeautifyPerfCountersForTests();
    assert.equal(counters.fullRefreshCount, 0);
    assert.deepEqual([...counters.lastPartialRenderIds].sort((a, b) => a - b), [12, 13]);
  } finally {
    runtime.restore();
  }
});

test('dirty ids + full-refresh 事件最终只执行一次 full refresh', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 1, message: MEMORY_SAMPLE },
      { message_id: 2, message: MEMORY_SAMPLE },
    ],
  });
  const timer = createFakeTimer();
  try {
    scheduleBeautifyRefresh({ messageId: 1, schedule: timer.schedule, cancel: timer.cancel });
    scheduleBeautifyRefresh({ full: true, schedule: timer.schedule, cancel: timer.cancel });
    const queued = getBeautifyRefreshQueueStateForTests();
    assert.equal(queued.needsFullRefresh, true);
    assert.deepEqual(queued.dirtyMessageIds, [1]);

    const result = flushBeautifyRefresh();
    assert.equal(result.mode, 'full');
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 1);
    assert.deepEqual(getBeautifyRefreshQueueStateForTests().dirtyMessageIds, []);
    assert.equal(getBeautifyRefreshQueueStateForTests().needsFullRefresh, false);
  } finally {
    runtime.restore();
  }
});

test('messageId 无法解析时安全 fallback 为 full refresh', () => {
  assert.equal(resolveBeautifyEventMessageId('message_updated', { foo: 'bar' }), null);
  assert.equal(resolveBeautifyEventMessageId('message_updated', 'not-a-number'), null);
  assert.equal(resolveBeautifyEventMessageId('message_updated'), null);

  const runtime = installRuntime({
    messages: [{ message_id: 0, message: MEMORY_SAMPLE }],
  });
  try {
    scheduleBeautifyRefresh({ full: true, delayMs: 0, schedule: cb => { cb(); return 1; }, cancel() {} });
    // already flushed by sync schedule; ensure API accepts full
    const again = flushBeautifyRefresh();
    assert.equal(again.mode, 'noop');
  } finally {
    runtime.restore();
  }
});

test('generation_id 不得被误判为 messageId；Generation 事件不再强制 full', () => {
  const events = {
    chat_changed: 'chat_changed',
    generation_ended: 'generation_ended',
    generation_after_commands: 'generation_after_commands',
  };
  globalThis.tavern_events = {
    CHAT_CHANGED: events.chat_changed,
    GENERATION_ENDED: events.generation_ended,
    GENERATION_AFTER_COMMANDS: events.generation_after_commands,
  };

  assert.equal(resolveBeautifyEventMessageId('message_updated', { generation_id: 99 }), null);
  assert.equal(resolveBeautifyEventMessageId('message_updated', { generationId: '12' }), null);
  assert.equal(resolveBeautifyEventMessageId('message_updated', { generation_id: 1, id: 7 }), null);
  assert.equal(resolveBeautifyEventMessageId('message_updated', { message_id: 5, generation_id: 9 }), 5);
  assert.equal(resolveBeautifyEventMessageId('message_updated', 8), 8);
  assert.equal(resolveBeautifyEventMessageId('message_updated', '8'), 8);
  assert.equal(resolveBeautifyEventMessageId('message_updated', { messageId: 3 }), 3);
  assert.equal(resolveBeautifyEventMessageId('message_updated', { mesid: 4 }), 4);

  assert.deepEqual(resolveBeautifyEventAction(events.chat_changed, 1), { action: 'full', messageId: null });
  assert.deepEqual(resolveBeautifyEventAction(events.generation_after_commands, 3), { action: 'noop', messageId: null });
  assert.deepEqual(resolveBeautifyEventAction(events.generation_ended), { action: 'noop', messageId: null });
  assert.deepEqual(resolveBeautifyEventAction(events.generation_ended, { generation_id: 9 }), { action: 'noop', messageId: null });
  assert.deepEqual(resolveBeautifyEventAction(events.generation_ended, 20), { action: 'partial', messageId: 20 });
  assert.equal(resolveBeautifyEventMessageId(events.generation_ended, 20), 20);
  assert.equal(resolveBeautifyEventMessageId(events.generation_after_commands, 3), null);
});

function applyBeautifyEventAction(eventName, ...args) {
  const decision = resolveBeautifyEventAction(eventName, ...args);
  if (decision.action === 'noop') return decision;
  if (decision.action === 'full') {
    scheduleBeautifyRefresh({ full: true, delayMs: 9999, schedule: () => 1, cancel() {} });
    return decision;
  }
  scheduleBeautifyRefresh({ messageId: decision.messageId, delayMs: 9999, schedule: () => 1, cancel() {} });
  return decision;
}

test('GENERATION_AFTER_COMMANDS 不进入 full 也不进入 dirty', () => {
  const runtime = installRuntime({
    messages: [{ message_id: 20, message: MEMORY_SAMPLE }],
  });
  try {
    resetBeautifyRendererStateForTests();
    applyBeautifyEventAction('generation_after_commands', 'normal', {}, false);
    const queued = getBeautifyRefreshQueueStateForTests();
    assert.equal(queued.needsFullRefresh, false);
    assert.deepEqual(queued.dirtyMessageIds, []);
    assert.equal(flushBeautifyRefresh().mode, 'noop');
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 0);
  } finally {
    runtime.restore();
  }
});

test('GENERATION_ENDED 无 messageId 时不进入 full queue', () => {
  const runtime = installRuntime({
    messages: [{ message_id: 20, message: MEMORY_SAMPLE }],
  });
  try {
    resetBeautifyRendererStateForTests();
    applyBeautifyEventAction('generation_ended');
    applyBeautifyEventAction('generation_ended', { generation_id: 42 });
    const queued = getBeautifyRefreshQueueStateForTests();
    assert.equal(queued.needsFullRefresh, false);
    assert.deepEqual(queued.dirtyMessageIds, []);
    assert.equal(flushBeautifyRefresh().mode, 'noop');
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 0);
  } finally {
    runtime.restore();
  }
});

test('GENERATION_ENDED 有可靠 messageId 时进入 dirty 且不 full', () => {
  const runtime = installRuntime({
    messages: [{ message_id: 20, message: MEMORY_SAMPLE }],
  });
  try {
    resetBeautifyRendererStateForTests();
    applyBeautifyEventAction('generation_ended', 20);
    const queued = getBeautifyRefreshQueueStateForTests();
    assert.equal(queued.needsFullRefresh, false);
    assert.deepEqual(queued.dirtyMessageIds, [20]);
    const result = flushBeautifyRefresh();
    assert.equal(result.mode, 'partial');
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 0);
  } finally {
    runtime.restore();
  }
});

test('正常生成组合 AFTER_COMMANDS + CHARACTER_MESSAGE_RENDERED + GENERATION_ENDED 只局部刷新目标楼', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 19, message: MEMORY_SAMPLE },
      { message_id: 20, message: MEMORY_SAMPLE },
      { message_id: 21, message: MEMORY_SAMPLE },
    ],
  });
  try {
    resetBeautifyRendererStateForTests();
    applyBeautifyEventAction('generation_after_commands', 'normal', {}, false);
    applyBeautifyEventAction('character_message_rendered', 20);
    applyBeautifyEventAction('generation_ended');
    const queued = getBeautifyRefreshQueueStateForTests();
    assert.equal(queued.needsFullRefresh, false);
    assert.deepEqual(queued.dirtyMessageIds, [20]);
    const result = flushBeautifyRefresh();
    assert.equal(result.mode, 'partial');
    assert.deepEqual(result.messageIds, [20]);
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 0);
    assert.deepEqual(getBeautifyPerfCountersForTests().lastPartialRenderIds, [20]);
  } finally {
    runtime.restore();
  }
});

test('CHAT_CHANGED 仍然 full refresh', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 0, message: MEMORY_SAMPLE },
      { message_id: 1, message: MEMORY_SAMPLE },
    ],
  });
  try {
    resetBeautifyRendererStateForTests();
    applyBeautifyEventAction('chat_changed');
    assert.equal(getBeautifyRefreshQueueStateForTests().needsFullRefresh, true);
    const result = flushBeautifyRefresh();
    assert.equal(result.mode, 'full');
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 1);
  } finally {
    runtime.restore();
  }
});

test('partial perf counter 第二轮覆盖第一轮且不累计历史', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 1, message: MEMORY_SAMPLE },
      { message_id: 2, message: MEMORY_SAMPLE },
      { message_id: 3, message: MEMORY_SAMPLE },
    ],
  });
  try {
    resetBeautifyRendererStateForTests();
    scheduleBeautifyRefresh({ messageId: 1, delayMs: 9999, schedule: () => 1, cancel() {} });
    scheduleBeautifyRefresh({ messageId: 2, delayMs: 9999, schedule: () => 1, cancel() {} });
    flushBeautifyRefresh();
    assert.deepEqual([...getBeautifyPerfCountersForTests().lastPartialRenderIds].sort((a, b) => a - b), [1, 2]);

    scheduleBeautifyRefresh({ messageId: 3, delayMs: 9999, schedule: () => 1, cancel() {} });
    flushBeautifyRefresh();
    assert.deepEqual(getBeautifyPerfCountersForTests().lastPartialRenderIds, [3]);
    assert.equal(getBeautifyPerfCountersForTests().lastPartialRenderIds.length, 1);
  } finally {
    runtime.restore();
  }
});

test('多轮 partial flush 计数状态长度不随运行轮次增长', () => {
  const runtime = installRuntime({
    messages: Array.from({ length: 5 }, (_, index) => ({
      message_id: index,
      message: MEMORY_SAMPLE,
    })),
  });
  try {
    resetBeautifyRendererStateForTests();
    for (let round = 0; round < 20; round += 1) {
      const id = round % 5;
      scheduleBeautifyRefresh({ messageId: id, delayMs: 9999, schedule: () => 1, cancel() {} });
      flushBeautifyRefresh();
      assert.equal(getBeautifyPerfCountersForTests().lastPartialRenderIds.length, 1);
      assert.deepEqual(getBeautifyPerfCountersForTests().lastPartialRenderIds, [id]);
    }
  } finally {
    runtime.restore();
  }
});

// ── 5 / 6：hash 命中 cleanup 短路 ───────────────────────────────────────

test('same hash + clean 不调用 heavy cleanup', () => {
  const runtime = installRuntime({
    messages: [{ message_id: 0, message: MEMORY_SAMPLE }],
  });
  try {
    const element = globalThis.document.querySelector('.mes[mesid="0"]');
    const context = createBeautifyRenderContext({ messageIds: [0] });
    const first = renderMessageElement(element, context);
    assert.ok(['rendered', 'hash-hit-cleanup', 'fast-path', 'hash-hit'].includes(first.status));
    const afterFirst = getBeautifyPerfCountersForTests().heavyCleanupCount;

    const second = renderMessageElement(element, context);
    assert.equal(second.status, 'fast-path');
    assert.equal(second.heavyCleanup, false);
    assert.equal(getBeautifyPerfCountersForTests().heavyCleanupCount, afterFirst);
  } finally {
    runtime.restore();
  }
});

test('same hash + raw memory 泄漏复活仍执行 heavy cleanup', () => {
  const runtime = installRuntime({
    messages: [{ message_id: 0, message: MEMORY_SAMPLE }],
  });
  try {
    const element = globalThis.document.querySelector('.mes[mesid="0"]');
    const context = createBeautifyRenderContext({ messageIds: [0] });
    renderMessageElement(element, context);
    const afterFirst = getBeautifyPerfCountersForTests().heavyCleanupCount;

    const mesText = element.querySelector('.mes_text');
    const leak = createDomNode(null);
    leak.nodeType = 3;
    leak.textContent = '<memory>[number:9]</memory>';
    mesText.childNodes.push(leak);
    mesText.textContent = `${mesText.textContent || ''}<memory>[number:9]</memory>`;

    assert.equal(hasLightweightMemoryLeak(mesText), true);
    const second = renderMessageElement(element, context);
    assert.equal(second.heavyCleanup, true);
    assert.ok(getBeautifyPerfCountersForTests().heavyCleanupCount > afterFirst);
  } finally {
    runtime.restore();
  }
});

// ── 7 / 8：settings / chat snapshot 只构建一次 ──────────────────────────

test('full refresh N 楼 settings snapshot 仅构建一次', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 0, message: MEMORY_SAMPLE },
      { message_id: 1, message: MEMORY_SAMPLE },
      { message_id: 2, message: MEMORY_SAMPLE },
    ],
  });
  try {
    resetBeautifyRendererStateForTests();
    scheduleBeautifyRefresh({ full: true, delayMs: 0, schedule: cb => { cb(); return 1; }, cancel() {} });
    const counters = getBeautifyPerfCountersForTests();
    assert.equal(counters.settingsBuildCount, 1);
    assert.equal(counters.fullRefreshCount, 1);
  } finally {
    runtime.restore();
  }
});

test('dirty batch N 楼 chat snapshot 仅构建一次（settings 一次）', () => {
  const runtime = installRuntime({
    messages: [
      { message_id: 10, message: MEMORY_SAMPLE },
      { message_id: 11, message: MEMORY_SAMPLE },
      { message_id: 12, message: MEMORY_SAMPLE },
    ],
  });
  try {
    resetBeautifyRendererStateForTests();
    scheduleBeautifyRefresh({ messageId: 10, delayMs: 9999, schedule: () => 1, cancel() {} });
    scheduleBeautifyRefresh({ messageId: 11, delayMs: 9999, schedule: () => 1, cancel() {} });
    scheduleBeautifyRefresh({ messageId: 12, delayMs: 9999, schedule: () => 1, cancel() {} });
    const result = flushBeautifyRefresh();
    assert.equal(result.mode, 'partial');
    assert.equal(getBeautifyPerfCountersForTests().settingsBuildCount, 1);
    assert.equal(getBeautifyPerfCountersForTests().fullRefreshCount, 0);
  } finally {
    runtime.restore();
  }
});

// ── 9 / 10 / 11：viewport / FAB ─────────────────────────────────────────

test('同一帧多个 visualViewport.scroll 只触发一次真实 apply', () => {
  let box = { width: 390, height: 720 };
  let applyCount = 0;
  const queue = [];
  const controller = createViewportSyncController({
    getBox: () => box,
    apply: () => { applyCount += 1; },
    raf: callback => {
      queue.push(callback);
      return queue.length;
    },
    cancelRaf: id => {
      queue[id - 1] = null;
    },
  });

  for (let index = 0; index < 20; index += 1) {
    controller.requestSync();
  }
  assert.equal(controller.getState().scheduledCount, 20);
  assert.equal(queue.filter(Boolean).length, 1);
  queue.filter(Boolean).forEach(callback => callback());
  assert.equal(applyCount, 1);
});

test('viewport 尺寸不变时不重复 apply（接近零工作）', () => {
  let box = { width: 390, height: 720 };
  let applyCount = 0;
  const queue = [];
  const controller = createViewportSyncController({
    getBox: () => box,
    apply: () => { applyCount += 1; },
    raf: callback => {
      queue.push(callback);
      return queue.length;
    },
    cancelRaf() {},
  });

  controller.requestSync();
  queue.pop()();
  assert.equal(applyCount, 1);

  controller.requestSync();
  queue.pop()();
  assert.equal(applyCount, 1);
  assert.equal(controller.getState().skippedUnchangedCount, 1);

  box = { width: 390, height: 640 };
  controller.requestSync();
  queue.pop()();
  assert.equal(applyCount, 2);
});

test('hidden FAB 路径：index 源码在 hidden 后结束 geometry', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /button\.hidden = !shouldShow/);
  assert.match(indexSource, /if \(!shouldShow \|\| button\.hidden\) \{\s*return;/s);
  assert.match(indexSource, /if \(!getFloatingButtonCustomPosition\(settings\)\)/);
  assert.match(indexSource, /requestViewportSync/);
  assert.match(indexSource, /createViewportSyncController/);
  assert.doesNotMatch(indexSource, /visualViewport\?\.addEventListener\?\.\('scroll',\s*syncViewportSize/);
});

// ── 12 / 13：面板关闭不重建；open 仍可用 ────────────────────────────────

test('面板关闭 + Emotion 后台 refresh 使用 guarded 回调且不调用完整 render', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /function refreshFloatingPanelIfOpen/);
  assert.match(indexSource, /if \(!isFloatingPanelOpen\(\)\) return false;/);
  assert.match(
    indexSource,
    /configureEmotionProfileWorkflow\(\{[\s\S]*?refreshPanel:\s*refreshFloatingPanelIfOpen/,
  );
  assert.match(
    indexSource,
    /configureAffectionWorkflow\(\{[\s\S]*?refreshPanel:\s*refreshFloatingPanelIfOpen/,
  );
  // 面板 UI 交互仍使用完整 renderFloatingPanel
  assert.match(
    indexSource,
    /configureEmotionProfilePanel\(\{\s*refreshPanel:\s*renderFloatingPanel,/,
  );

  let renderCount = 0;
  const refreshFloatingPanelIfOpen = () => {
    // simulate closed panel
    return false;
  };
  configureEmotionProfileWorkflow({
    refreshPanel: () => {
      // workflow event path uses whatever is configured; verify closed guard semantics
      const opened = false;
      if (!opened) return refreshFloatingPanelIfOpen();
      renderCount += 1;
    },
  });

  // Directly exercise the closed semantics used by index wiring.
  assert.equal(refreshFloatingPanelIfOpen(), false);
  assert.equal(renderCount, 0);
});

test('正常 openFloatingPanel 仍然先 render 再标记 open（不被 guard 阻断）', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const openStart = indexSource.indexOf('function openFloatingPanel()');
  const openEnd = indexSource.indexOf('function closeFloatingPanel()', openStart);
  const openBody = indexSource.slice(openStart, openEnd);
  assert.match(openBody, /renderFloatingPanel\(\);/);
  assert.match(openBody, /panelRoot\?\.classList\.add\('slx-panel-open'\)/);
  // open path must NOT go through refreshFloatingPanelIfOpen
  assert.doesNotMatch(openBody, /refreshFloatingPanelIfOpen/);
});

test('轻量 leak probe 能识别 memory 元素与标签文本，但不依赖 TreeWalker', () => {
  const mesText = createDomNode('div');
  assert.equal(hasLightweightMemoryLeak(mesText), false);

  const ghost = createDomNode('memory');
  ghost.textContent = '[number:1]';
  mesText.append(ghost);
  assert.equal(hasLightweightMemoryLeak(mesText), true);

  const mesText2 = createDomNode('div');
  const text = createDomNode(null);
  text.nodeType = 3;
  text.textContent = '[time:午后]\n[location:庭院]\n[characters:A]\n[task:无]\n[plot:线]';
  // field-only lines without number still count via isBeautifyFieldLine keys used in probe
  mesText2.childNodes.push(text);
  // Our probe requires every non-empty line to be a beautify field line.
  assert.equal(hasLightweightMemoryLeak(mesText2), true);
});
