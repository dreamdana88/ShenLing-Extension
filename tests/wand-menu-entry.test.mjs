import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PLUGIN_VERSION } from '../src/constants.js';
import { defaultGlobalSettings } from '../src/core/settings.js';
import { cloneData, mergeDefaults } from '../src/utils/text.js';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function createElementMock(tagName = 'div') {
  const listeners = new Map();
  const node = {
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    hidden: false,
    title: '',
    dataset: {},
    children: [],
    attributes: {},
    innerHTML: '',
    parentNode: null,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter(item => item !== this);
      this.parentNode = null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = current => {
        if (matchSelector(current, selector)) results.push(current);
        current.children.forEach(visit);
      };
      this.children.forEach(visit);
      return results;
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    click() {
      (listeners.get('click') || []).forEach(handler => handler({}));
    },
    get listenerCount() {
      return (listeners.get('click') || []).length;
    },
  };
  return node;
}

function matchSelector(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector === '.list-group-item') return /\blist-group-item\b/.test(node.className);
  return false;
}

function createDocumentMock({ withMenu = true } = {}) {
  const body = createElementMock('body');
  let menu = null;
  if (withMenu) {
    menu = createElementMock('div');
    menu.id = 'extensionsMenu';
    body.appendChild(menu);
  }
  const doc = {
    body,
    createElement: tag => createElementMock(tag),
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      const visit = node => {
        if (matchSelector(node, selector)) results.push(node);
        node.children.forEach(visit);
      };
      visit(body);
      return results;
    },
  };
  return { doc, menu, body };
}

/**
 * Extract and run the wand helpers from index.js against injected deps.
 * Avoids importing index.js (which auto-inits on load).
 */
function createWandHarness({
  withMenu = true,
  settings = {
    enabled: true,
    ui: {
      showFloatingButton: true,
      showWandMenuEntry: true,
    },
  },
} = {}) {
  const { doc } = createDocumentMock({ withMenu });
  let openCount = 0;
  const openFloatingPanel = () => {
    openCount += 1;
  };
  const getGlobalSettings = () => settings;
  const saveCalls = [];

  const start = indexSource.indexOf('function shouldShowWandMenuEntry');
  const end = indexSource.indexOf('function syncSettingsPanelState()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const snippet = indexSource.slice(start, end);

  const runner = new Function(
    'document',
    'getGlobalSettings',
    'openFloatingPanel',
    `${snippet}
     return {
       shouldShowWandMenuEntry,
       ensureWandMenuEntry,
       syncWandMenuEntryState,
     };`,
  );
  const api = runner(doc, getGlobalSettings, openFloatingPanel);
  return {
    ...api,
    document: doc,
    settings,
    get openCount() {
      return openCount;
    },
    saveCalls,
  };
}

test('默认 showWandMenuEntry = true', () => {
  assert.equal(defaultGlobalSettings.ui.showWandMenuEntry, true);
  const merged = mergeDefaults({}, cloneData(defaultGlobalSettings));
  assert.equal(merged.ui.showWandMenuEntry, true);

  const legacyWithoutField = {
    enabled: true,
    ui: { showFloatingButton: true },
  };
  const filled = mergeDefaults(legacyWithoutField, cloneData(defaultGlobalSettings));
  assert.equal(filled.ui.showWandMenuEntry, true);
});

test('初始化只创建一个 wand container，重复 ensure 不产生重复入口', () => {
  const harness = createWandHarness();
  assert.equal(harness.ensureWandMenuEntry(), true);
  assert.equal(harness.ensureWandMenuEntry(), true);
  assert.equal(harness.ensureWandMenuEntry(), true);
  assert.equal(harness.document.querySelectorAll('#shenling-assistant-wand-container').length, 1);
  assert.equal(harness.document.querySelectorAll('#shenling-assistant-wand-entry').length, 1);
});

test('Wand ON + plugin ON → visible；Wand OFF / plugin OFF → hidden', () => {
  const harness = createWandHarness();
  harness.ensureWandMenuEntry();
  const container = harness.document.querySelector('#shenling-assistant-wand-container');
  const entry = harness.document.querySelector('#shenling-assistant-wand-entry');

  harness.settings.enabled = true;
  harness.settings.ui.showWandMenuEntry = true;
  harness.syncWandMenuEntryState();
  assert.equal(container.hidden, false);
  assert.equal(entry.hidden, false);

  harness.settings.ui.showWandMenuEntry = false;
  harness.syncWandMenuEntryState();
  assert.equal(container.hidden, true);
  assert.equal(entry.hidden, true);

  harness.settings.ui.showWandMenuEntry = true;
  harness.settings.enabled = false;
  harness.syncWandMenuEntryState();
  assert.equal(container.hidden, true);

  harness.settings.enabled = true;
  harness.syncWandMenuEntryState();
  assert.equal(container.hidden, false);
});

test('Floating OFF 不影响 Wand；Wand OFF 不影响 Floating 语义', () => {
  assert.match(indexSource, /showFloatingButton/);
  assert.match(indexSource, /showWandMenuEntry/);
  assert.match(indexSource, /shouldShow\s*=\s*Boolean\(settings\.enabled && settings\.ui\.showFloatingButton\)/);
  assert.match(
    indexSource,
    /function shouldShowWandMenuEntry[\s\S]*?return Boolean\(settings\.enabled && settings\.ui\.showWandMenuEntry\)/,
  );

  const harness = createWandHarness({
    settings: {
      enabled: true,
      ui: { showFloatingButton: false, showWandMenuEntry: true },
    },
  });
  harness.ensureWandMenuEntry();
  assert.equal(harness.document.querySelector('#shenling-assistant-wand-container').hidden, false);

  harness.settings.ui.showWandMenuEntry = false;
  harness.syncWandMenuEntryState();
  assert.equal(harness.document.querySelector('#shenling-assistant-wand-container').hidden, true);
  // Floating remains independently controlled in settings (not flipped by wand).
  assert.equal(harness.settings.ui.showFloatingButton, false);
});

test('checkbox 修改后保存设置并立即同步（源码契约）', () => {
  assert.match(
    indexSource,
    /#shenling-assistant-wand-enabled[\s\S]*?settings\.ui\.showWandMenuEntry\s*=\s*Boolean\(event\.currentTarget\.checked\)/,
  );
  assert.match(
    indexSource,
    /showWandMenuEntry\s*=\s*Boolean\(event\.currentTarget\.checked\);\s*saveGlobalSettings\(\);\s*syncSettingsPanelState\(\);/s,
  );
  assert.match(indexSource, /const wandInput = document\.querySelector\('#shenling-assistant-wand-enabled'\)/);
  assert.match(indexSource, /if \(wandInput\) wandInput\.checked = Boolean\(settings\.ui\.showWandMenuEntry\)/);
});

test('点击 Wand Entry 走 openFloatingPanel；openFloatingPanel 本身不被复制', () => {
  const harness = createWandHarness();
  harness.ensureWandMenuEntry();
  const entry = harness.document.querySelector('#shenling-assistant-wand-entry');
  assert.equal(entry.listenerCount, 1);
  entry.click();
  entry.click();
  assert.equal(harness.openCount, 2);

  // Only one openFloatingPanel definition in index.js
  const openDefs = indexSource.match(/function openFloatingPanel\s*\(/g) || [];
  assert.equal(openDefs.length, 1);
  assert.match(indexSource, /entry\.addEventListener\('click',\s*\(\)\s*=>\s*\{\s*openFloatingPanel\(\);/s);
  assert.match(indexSource, /#shenling-assistant-open[\s\S]*?openFloatingPanel/);
  assert.match(indexSource, /button\.addEventListener\('click'[\s\S]*?openFloatingPanel\(\)/);
});

test('#extensionsMenu 缺失时安全 no-op，不 throw', () => {
  const harness = createWandHarness({ withMenu: false });
  assert.doesNotThrow(() => {
    assert.equal(harness.ensureWandMenuEntry(), false);
    harness.syncWandMenuEntryState();
  });
  assert.equal(harness.document.querySelectorAll('#shenling-assistant-wand-container').length, 0);
});

test('init 挂载顺序包含 ensureWandMenuEntry 与 syncSettingsPanelState', () => {
  const initStart = indexSource.indexOf('function init()');
  const initEnd = indexSource.indexOf('\nif (document.readyState', initStart);
  const initBody = indexSource.slice(initStart, initEnd);
  assert.match(initBody, /renderSettingsPanel\(\);/);
  assert.match(initBody, /renderFloatingButton\(\);/);
  assert.match(initBody, /ensureWandMenuEntry\(\);/);
  assert.match(initBody, /syncSettingsPanelState\(\);/);
  assert.doesNotMatch(indexSource, /MutationObserver/);
  assert.doesNotMatch(
    indexSource.slice(indexSource.indexOf('function ensureWandMenuEntry'), indexSource.indexOf('function syncWandMenuEntryState')),
    /setInterval/,
  );
});

test('设置页包含快捷入口分组与 wand checkbox', () => {
  assert.match(indexSource, /快捷入口/);
  assert.match(indexSource, /shenling-assistant-wand-enabled/);
  assert.match(indexSource, /显示在魔法棒菜单/);
  assert.match(indexSource, /shenling-assistant-wand-container/);
  assert.match(indexSource, /extensionsMenuExtensionButton/);
  assert.match(indexSource, /fa-moon/);
});

test('版本三处一致 = 0.17.35', () => {
  assert.equal(PLUGIN_VERSION, '0.17.35');
  assert.equal(manifest.version, '0.17.35');
  assert.match(readme, /当前版本：`0\.17\.35`/);
});
