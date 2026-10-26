import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import { SUMMARY_MERGED_BATCH_INSTRUCTION } from '../src/prompts.js';
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

// Structural assertions only: template wording from src/prompts.js is intentionally not frozen here.
const PRIOR_MEMORY = '【过往梦境档案】\n<memory>\n[n:1]\n旧小总结\n</memory>';
const GENERATED_MEMORY = '<memory>\n[n:1]\n新小总结\n</memory>';

function runSingle(includeUserInput) {
  return withHarness({ includeUserInput }, async ({ prompts }) => {
    const result = await generateConfirmedSummaryForTask(3);
    return { prompt: prompts[0], result };
  });
}

function runGroup(includeUserInput) {
  return withHarness({ includeUserInput }, async ({ prompts }) => {
    const result = await generateConfirmedSummaryForGroup([1, 3, 5]);
    return { prompt: prompts[0], result };
  });
}

function userContent(prompt) {
  return prompt.find(item => item.role === 'user').content;
}

test('single floor uses its own material and prior memories from that floor', async () => {
  const withUser = await runSingle(true);
  assert.equal(
    userContent(withUser.prompt),
    `${PRIOR_MEMORY}\n\n【本轮素材】\n【最新用户输入】\n用户输入二\n\n【最新正文】\n助手正文三。`,
  );
  const withoutUser = await runSingle(false);
  assert.equal(userContent(withoutUser.prompt), `${PRIOR_MEMORY}\n\n【本轮素材】\n助手正文三。`);
});

test('group labels every floor in order and takes prior memories from the first floor', async () => {
  const withUser = await runGroup(true);
  assert.equal(
    userContent(withUser.prompt),
    '【本轮素材】\n【第 1 楼·用户输入】\n用户输入零\n\n【第 1 楼·正文】\n助手正文一。\n\n'
      + '【第 3 楼·用户输入】\n用户输入二\n\n【第 3 楼·正文】\n助手正文三。\n\n'
      + '【第 5 楼·用户输入】\n用户输入四\n\n【第 5 楼·正文】\n助手正文五。',
  );
  const withoutUser = await runGroup(false);
  assert.equal(
    userContent(withoutUser.prompt),
    '【本轮素材】\n【第 1 楼·正文】\n助手正文一。\n\n【第 3 楼·正文】\n助手正文三。\n\n【第 5 楼·正文】\n助手正文五。',
  );
});

test('group system prompt differs from a single floor only by the merged-batch instruction', async () => {
  for (const includeUserInput of [true, false]) {
    const single = (await runSingle(includeUserInput)).prompt.filter(item => item.role !== 'user');
    const group = (await runGroup(includeUserInput)).prompt.filter(item => item.role !== 'user');
    assert.equal(group.length, single.length);
    assert.ok(single.every(item => !item.content.includes(SUMMARY_MERGED_BATCH_INSTRUCTION)));
    const withInstruction = group.filter(item => item.content.includes(SUMMARY_MERGED_BATCH_INSTRUCTION));
    assert.equal(withInstruction.length, 1);
    group.forEach((item, index) => {
      assert.equal(item.role, single[index].role);
      assert.equal(item.content.replace(`${SUMMARY_MERGED_BATCH_INSTRUCTION}\n\n`, ''), single[index].content);
    });
  }
});

test('single and group results share fingerprints and the processed memory', async () => {
  for (const includeUserInput of [true, false]) {
    const single = (await runSingle(includeUserInput)).result;
    const group = (await runGroup(includeUserInput)).result;
    assert.deepEqual(Object.keys(group.fingerprints), ['1', '3', '5']);
    assert.equal(single.fingerprint, group.fingerprints[3]);
    assert.equal(single.memory, GENERATED_MEMORY);
    assert.equal(group.memory, GENERATED_MEMORY);
  }
});

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
