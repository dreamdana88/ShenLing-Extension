import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  processAutoTotalGrandMemory,
  processLegacyGrandArchive,
  processTotalGrandMemory,
} from '../src/features/summary/archive.js';
import { configureSummaryWorkflow } from '../src/features/summary/runtime.js';
import { isSummaryWriteIgnored } from '../src/features/summary/state.js';

function assistant(messageId, message) {
  return {
    message_id: messageId,
    role: 'assistant',
    is_user: false,
    is_hidden: false,
    swipe_id: 0,
    message,
    mes: message,
  };
}

function grand(messageId) {
  return assistant(messageId, `<grand_memory>\n[volume: ${messageId}-${messageId}]\n大总结 ${messageId}\n</grand_memory>`);
}

function totalGrandRecords() {
  return Array.from({ length: 4 }, (_, id) => ({
    id: `${id}-record`,
    summaryMessageId: id,
    archiveFrom: id,
    archiveTo: id,
    memoryFrom: id,
    memoryTo: id,
    rangeType: 'memory',
  }));
}

// Runs one summary task while a host hook edits message 0 at a chosen moment,
// so the guard that fires next has to discard the result.
async function withDiscardHarness({
  chat,
  summary = {},
  modules = {},
  mutateAt = null,
  generateResult,
}, run) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    TavernHelper: globalThis.TavernHelper,
    generateRaw: globalThis.generateRaw,
    createChatMessages: globalThis.createChatMessages,
    setChatMessages: globalThis.setChatMessages,
    toastr: globalThis.toastr,
    window: globalThis.window,
  };
  const context = {
    characterId: 'discard-character',
    chatId: 'discard-chat',
    name1: '测试用户',
    name2: '测试角色',
    chat,
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        generation: { backgroundStreamingEnabled: false },
        api: { mode: 'main_api', activeProfileId: 'default', profiles: [] },
        modules: {
          summary: {
            enabled: true,
            includeUserInput: false,
            legacyArchiveBatchSize: '1',
            autoGrandMemoryEnabled: false,
            autoTotalGrandMemoryEnabled: false,
            ...modules.summary,
          },
        },
      },
    },
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        summary: {
          runningTask: 'none',
          archiveRecords: [],
          memoryCountSinceArchive: 0,
          memoryCountedMessageIds: [],
          processedMessageFingerprints: {},
          confirmedTasks: [],
          lastError: '',
          ...summary,
        },
      },
    },
    saveMetadataDebounced: () => {},
    saveSettingsDebounced: () => {},
    saveChat: async () => {},
  };
  const toasts = [];
  const calls = { generate: 0, create: 0, hide: 0 };
  let createdId = null;
  const getSummary = () => context.chatMetadata[CHAT_STATE_KEY].summary;
  const mutate = at => {
    if (mutateAt === at) context.chat[0].message = context.chat[0].message.replace(/(大总结|旧聊天正文)/, '$1改');
  };
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  delete globalThis.TavernHelper;
  globalThis.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [
    type,
    (message, title) => toasts.push([type, message, title]),
  ]));
  globalThis.generateRaw = async () => {
    calls.generate += 1;
    mutate(`generate-${calls.generate}`);
    return generateResult;
  };
  globalThis.createChatMessages = async messages => {
    calls.create += 1;
    createdId = context.chat.length;
    context.chat.push(assistant(createdId, messages[0].message));
    mutate('create');
  };
  globalThis.setChatMessages = async updates => {
    calls.hide += 1;
    for (const update of updates) Object.assign(context.chat[Number(update.message_id)], update);
    mutate('hide');
  };
  configureSummaryWorkflow({
    addCommunicationLog: () => {},
    getActiveApiProfile: () => null,
    getApiSettings: () => ({ mode: 'main_api' }),
    refreshSummaryPanel: () => {},
  });
  try {
    await run();
    const summaryState = getSummary();
    return {
      calls,
      toasts: toasts.filter(([type]) => type !== 'info'),
      runningTask: summaryState.runningTask,
      lastError: summaryState.lastError,
      archiveRecordCount: summaryState.archiveRecords.length,
      createdFloorIgnored: createdId === null ? null : isSummaryWriteIgnored(createdId),
    };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

const totalGrandResult = '<grand_memory>\n[volume: 0-3]\n总档案\n</grand_memory>';
const legacyGrandResult = '<grand_memory>\n[volume: 0-1]\n旧聊天大总结\n</grand_memory>';

function totalGrandHarness(mutateAt, runOptions = { guardChatScope: true }) {
  const records = totalGrandRecords();
  return withDiscardHarness({
    chat: records.map(record => grand(record.summaryMessageId)),
    summary: { archiveRecords: records },
    mutateAt,
    generateResult: totalGrandResult,
  }, () => processTotalGrandMemory(runOptions));
}

const legacyChat = () => [assistant(0, '旧聊天正文 1'), assistant(1, '旧聊天正文 2')];

const scenarios = {
  'total grand guarded, untouched': () => totalGrandHarness(null),
  'total grand discarded after generate': () => totalGrandHarness('generate-1'),
  'total grand discarded after create': () => totalGrandHarness('create'),
  'total grand discarded after hide': () => totalGrandHarness('hide'),
  'auto total grand unguarded, untouched': () => {
    const records = totalGrandRecords();
    return withDiscardHarness({
      chat: records.map(record => grand(record.summaryMessageId)),
      summary: { archiveRecords: records },
      modules: { summary: { autoTotalGrandMemoryEnabled: true, totalGrandMemoryInterval: 3 } },
      generateResult: totalGrandResult,
    }, () => processAutoTotalGrandMemory());
  },
  'legacy archive discarded after first batch': () => withDiscardHarness({
    chat: legacyChat(),
    mutateAt: 'generate-1',
    generateResult: legacyGrandResult,
  }, () => processLegacyGrandArchive()),
  'legacy archive discarded after final generate': () => withDiscardHarness({
    chat: [assistant(0, '旧聊天正文 1')],
    modules: { summary: { legacyArchiveBatchSize: '5' } },
    mutateAt: 'generate-1',
    generateResult: legacyGrandResult,
  }, () => processLegacyGrandArchive()),
  'legacy archive discarded after create': () => withDiscardHarness({
    chat: legacyChat(),
    mutateAt: 'create',
    generateResult: legacyGrandResult,
  }, () => processLegacyGrandArchive()),
  'legacy archive discarded after hide': () => withDiscardHarness({
    chat: legacyChat(),
    mutateAt: 'hide',
    generateResult: legacyGrandResult,
  }, () => processLegacyGrandArchive()),
};

// Frozen from the pre-refactor implementation: what each guard discards (or lets through).
const expected = {
  "total grand guarded, untouched": {
    "calls": {
      "generate": 1,
      "create": 1,
      "hide": 1
    },
    "toasts": [
      [
        "success",
        "已生成第 4 楼总档案，并合并 4 条大总结；本次隐藏 4 层，保留已归档剧情 0 层。",
        "总档案压缩"
      ]
    ],
    "runningTask": "none",
    "lastError": "",
    "archiveRecordCount": 5,
    "createdFloorIgnored": true
  },
  "total grand discarded after generate": {
    "calls": {
      "generate": 1,
      "create": 0,
      "hide": 0
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "总档案压缩"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 4,
    "createdFloorIgnored": null
  },
  "total grand discarded after create": {
    "calls": {
      "generate": 1,
      "create": 1,
      "hide": 0
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "总档案压缩"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 4,
    "createdFloorIgnored": false
  },
  "total grand discarded after hide": {
    "calls": {
      "generate": 1,
      "create": 1,
      "hide": 1
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "总档案压缩"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 4,
    "createdFloorIgnored": false
  },
  "auto total grand unguarded, untouched": {
    "calls": {
      "generate": 1,
      "create": 1,
      "hide": 1
    },
    "toasts": [
      [
        "success",
        "已生成第 4 楼总档案，并合并 4 条大总结；本次隐藏 4 层，保留已归档剧情 0 层。",
        "总档案压缩"
      ]
    ],
    "runningTask": "none",
    "lastError": "",
    "archiveRecordCount": 5,
    "createdFloorIgnored": true
  },
  "legacy archive discarded after first batch": {
    "calls": {
      "generate": 1,
      "create": 0,
      "hide": 0
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "旧聊天归档"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 0,
    "createdFloorIgnored": null
  },
  "legacy archive discarded after final generate": {
    "calls": {
      "generate": 1,
      "create": 0,
      "hide": 0
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "旧聊天归档"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 0,
    "createdFloorIgnored": null
  },
  "legacy archive discarded after create": {
    "calls": {
      "generate": 3,
      "create": 1,
      "hide": 0
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "旧聊天归档"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 0,
    "createdFloorIgnored": false
  },
  "legacy archive discarded after hide": {
    "calls": {
      "generate": 3,
      "create": 1,
      "hide": 1
    },
    "toasts": [
      [
        "warning",
        "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
        "旧聊天归档"
      ]
    ],
    "runningTask": "none",
    "lastError": "目标内容在任务期间发生变化，本次结果已丢弃，请重新执行。",
    "archiveRecordCount": 0,
    "createdFloorIgnored": false
  }
};

assert.deepEqual(Object.keys(expected), Object.keys(scenarios));

for (const [name, run] of Object.entries(scenarios)) {
  test(`summary guard discard: ${name}`, async () => {
    assert.deepEqual(await run(), expected[name]);
  });
}
