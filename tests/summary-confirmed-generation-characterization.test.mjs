import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import { configureSummaryWorkflow } from '../src/features/summary/runtime.js';
import {
  generateConfirmedSummaryForGroup,
  generateConfirmedSummaryForTask,
  writeConfirmedSummaryForGroup,
  writeConfirmedSummaryForTask,
} from '../src/features/summary/workflow.js';

function message(message_id, role, text) {
  return {
    message_id,
    role,
    is_user: role === 'user',
    is_hidden: false,
    swipe_id: 0,
    message: text,
    mes: text,
  };
}

function createChat() {
  return [
    message(0, 'user', '用户输入零'),
    message(1, 'assistant', '助手正文一。\n<memory>\n[n:1]\n旧小总结\n</memory>'),
    message(2, 'user', '用户输入二'),
    message(3, 'assistant', '助手正文三。'),
    message(4, 'user', '用户输入四'),
    message(5, 'assistant', '助手正文五。'),
  ];
}

async function withHarness({ includeUserInput }, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    TavernHelper: globalThis.TavernHelper,
    generateRaw: globalThis.generateRaw,
    setChatMessages: globalThis.setChatMessages,
    window: globalThis.window,
  };
  const prompts = [];
  const context = {
    chatId: 'characterization-chat',
    chat: createChat(),
    name1: '测试用户',
    name2: '测试角色',
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        generation: { backgroundStreamingEnabled: false },
        api: { mode: 'main_api', activeProfileId: 'default', profiles: [] },
        modules: {
          summary: { enabled: true, includeUserInput },
          emotionProfile: { enabled: true },
        },
      },
    },
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        summary: {
          runningTask: 'none',
          archiveRecords: [],
          processedMessageFingerprints: {},
          confirmedTasks: [],
        },
      },
    },
    saveMetadataDebounced: () => {},
    saveSettingsDebounced: () => {},
    saveChat: async () => {},
  };
  const writes = [];
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  delete globalThis.TavernHelper;
  globalThis.generateRaw = async request => {
    prompts.push(request.prompt);
    return '<memory>\n[n:1]\n新小总结\n</memory>';
  };
  globalThis.setChatMessages = async updates => {
    for (const update of updates) {
      writes.push([update.message_id, update.message]);
      Object.assign(context.chat[Number(update.message_id)], update);
    }
  };
  configureSummaryWorkflow({
    addCommunicationLog: () => {},
    getActiveApiProfile: () => null,
    getApiSettings: () => ({ mode: 'main_api' }),
    refreshSummaryPanel: () => {},
  });
  try {
    return await run({ prompts, writes, context });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

const scenarios = {
  'single task prompt, includeUserInput on': () => withHarness({ includeUserInput: true }, async ({ prompts }) => {
    const result = await generateConfirmedSummaryForTask(3);
    return { prompts, result };
  }),
  'single task prompt, includeUserInput off': () => withHarness({ includeUserInput: false }, async ({ prompts }) => {
    const result = await generateConfirmedSummaryForTask(3);
    return { prompts, result };
  }),
  'group prompt, includeUserInput on': () => withHarness({ includeUserInput: true }, async ({ prompts }) => {
    const result = await generateConfirmedSummaryForGroup([1, 3, 5]);
    return { prompts, result };
  }),
  'group prompt, includeUserInput off': () => withHarness({ includeUserInput: false }, async ({ prompts }) => {
    const result = await generateConfirmedSummaryForGroup([1, 3, 5]);
    return { prompts, result };
  }),
};

// Frozen from the pre-refactor implementation: full prompts sent to the model and returned shapes.
const expected = JSON.parse(await readFile(
  new URL('./fixtures/summary-confirmed-generation-prompts.json', import.meta.url),
  'utf8',
));

assert.deepEqual(Object.keys(expected), Object.keys(scenarios));

for (const [name, run] of Object.entries(scenarios)) {
  test(`confirmed generation characterization: ${name}`, async () => {
    assert.deepEqual(await run(), expected[name]);
  });
}

test('writeConfirmedSummaryForTask writes only when the fingerprint matches', async () => {
  await withHarness({ includeUserInput: false }, async ({ writes }) => {
    const { fingerprint } = await generateConfirmedSummaryForTask(3);
    assert.equal(await writeConfirmedSummaryForTask(3, `${fingerprint}-stale`, '<memory>x</memory>'), false);
    assert.deepEqual(writes, []);
    assert.equal(await writeConfirmedSummaryForTask(3, fingerprint, '<memory>x</memory>'), true);
    assert.deepEqual(writes, [[3, '助手正文三。\n\n<memory>x</memory>']]);
  });
});

test('writeConfirmedSummaryForGroup writes on the last floor, rejects mismatches and empty groups', async () => {
  await withHarness({ includeUserInput: false }, async ({ writes }) => {
    const { fingerprints } = await generateConfirmedSummaryForGroup([1, 3, 5]);
    assert.equal(await writeConfirmedSummaryForGroup([], {}, '<memory>x</memory>'), false);
    assert.equal(
      await writeConfirmedSummaryForGroup([1, 3, 5], { ...fingerprints, 3: 'stale' }, '<memory>x</memory>'),
      false,
    );
    assert.deepEqual(writes, []);
    assert.equal(await writeConfirmedSummaryForGroup([1, 3, 5], fingerprints, '<memory>x</memory>'), true);
    assert.deepEqual(writes, [[5, '助手正文五。\n\n<memory>x</memory>']]);
  });
});
