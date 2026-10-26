import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import { bindSummaryPanelEvents } from '../src/features/summary/panel.js';

function createContext(settings) {
  return {
    chatId: 'chat-a',
    extensionSettings: { [MODULE_NAME]: settings },
    chatMetadata: { [CHAT_STATE_KEY]: { summary: {} } },
    saveMetadataDebounced: () => {},
    saveSettingsDebounced: () => {},
  };
}

function createInput(value) {
  return {
    dataset: { slxSummaryField: 'intervalMessages' },
    type: 'number',
    value,
    validity: '',
    reportCount: 0,
    setCustomValidity(message) {
      this.validity = message;
    },
    reportValidity() {
      this.reportCount += 1;
    },
    addEventListener(event, handler) {
      (this.handlers ||= {})[event] = handler;
    },
    dispatchChange() {
      this.handlers?.change?.();
    },
  };
}

function createHarness(fieldValue) {
  const settings = {
    enabled: true,
    modules: { summary: { intervalMessages: 1 } },
  };
  const input = createInput(fieldValue);
  const panelRoot = {
    querySelectorAll: selector =>
      selector === '[data-slx-summary-field]' ? [input] : [],
    querySelector: () => null,
  };
  const context = createContext(settings);
  const previous = { SillyTavern: globalThis.SillyTavern };
  globalThis.SillyTavern = { getContext: () => context };
  bindSummaryPanelEvents(panelRoot, settings);
  return {
    input,
    summary: context.extensionSettings[MODULE_NAME].modules.summary,
    restore() {
      if (previous.SillyTavern === undefined) delete globalThis.SillyTavern;
      else globalThis.SillyTavern = previous.SillyTavern;
    },
  };
}

for (const bad of ['0', '11', '2.5', 'abc', '']) {
  test(`intervalMessages=${JSON.stringify(bad)} is rejected and not saved`, () => {
    const { input, summary, restore } = createHarness(bad);
    try {
      input.dispatchChange();
      assert.equal(summary.intervalMessages, 1);
      assert.equal(input.reportCount, 1);
      assert.notEqual(input.validity, '');
    } finally {
      restore();
    }
  });
}

for (const good of ['1', '5', '10']) {
  test(`intervalMessages=${good} is saved`, () => {
    const { input, summary, restore } = createHarness(good);
    try {
      input.dispatchChange();
      assert.equal(summary.intervalMessages, Number(good));
      assert.equal(input.validity, '');
      assert.equal(input.reportCount, 0);
    } finally {
      restore();
    }
  });
}
