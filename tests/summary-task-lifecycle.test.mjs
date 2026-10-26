import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import { getAssistantMessageContentFingerprint } from '../src/core/message-fingerprint.js';
import {
  processAutoGrandMemory,
  processLegacyGrandArchive,
  processTotalGrandMemory,
} from '../src/features/summary/archive.js';
import {
  regenerateLatestGrandMemory,
  regenerateMemoryForMessage,
  summarizeOpeningMessage,
} from '../src/features/summary/manual.js';
import { configureSummaryWorkflow } from '../src/features/summary/runtime.js';

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

function grand(messageId, from, to) {
  return assistant(messageId, `<grand_memory>\n[volume: ${from}-${to}]\n大总结 ${messageId}\n</grand_memory>`);
}

const autoGrandSource = assistant(0, 'A 已总结\n<memory>[n:1] A</memory>');

function autoGrandSummary() {
  return {
    memoryCountSinceArchive: 3,
    memoryCountedMessageIds: [0],
    processedMessageFingerprints: { 0: getAssistantMessageContentFingerprint(autoGrandSource) },
    confirmedTasks: [{
      taskKey: 't0',
      chatIdentity: 'lifecycle-chat',
      originalMessageId: 0,
      assistantFingerprint: getAssistantMessageContentFingerprint(autoGrandSource),
      selectedSwipeId: 0,
      confirmingUserMessageId: 1,
      confirmingUserFingerprint: '1:1',
      status: 'SUMMARIZED',
      createdAt: 'a',
      updatedAt: 'a',
    }],
  };
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

async function withTaskHarness({ chat, summary = {}, modules = {}, generate = null }, run) {
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
    characterId: 'lifecycle-character',
    chatId: 'lifecycle-chat',
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
  const hidden = [];
  const runningDuringGenerate = [];
  const getSummary = () => context.chatMetadata[CHAT_STATE_KEY].summary;
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  delete globalThis.TavernHelper;
  globalThis.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [
    type,
    (message, title) => toasts.push([type, message, title]),
  ]));
  globalThis.generateRaw = async () => {
    runningDuringGenerate.push(getSummary().runningTask);
    if (generate) return generate();
    throw new Error('模拟生成失败');
  };
  globalThis.createChatMessages = async messages => {
    context.chat.push(assistant(context.chat.length, messages[0].message));
  };
  globalThis.setChatMessages = async updates => {
    for (const update of updates) {
      hidden.push(update.message_id);
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
    await run();
    const summaryState = getSummary();
    const result = {
      runningDuringGenerate,
      toasts,
      runningTask: summaryState.runningTask,
      lastError: summaryState.lastError,
      legacyPhase: summaryState.legacyArchiveStatus?.phase ?? null,
    };
    if (generate) {
      const { id, createdAt, ...lastRecord } = summaryState.archiveRecords.at(-1);
      Object.assign(result, {
        hidden,
        chatLength: context.chat.length,
        memoryCountSinceArchive: summaryState.memoryCountSinceArchive,
        memoryCountedMessageIds: summaryState.memoryCountedMessageIds,
        lastArchivedMessageId: summaryState.lastArchivedMessageId,
        lastGrandSummaryMessageId: summaryState.lastGrandSummaryMessageId,
        retainedArchiveMessageIds: summaryState.retainedArchiveMessageIds,
        archiveRecordCount: summaryState.archiveRecords.length,
        lastRecord: JSON.parse(JSON.stringify(lastRecord)),
        legacyStatus: summaryState.legacyArchiveStatus,
      });
    }
    return result;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

const autoGrandModules = { summary: { autoGrandMemoryEnabled: true, grandMemoryInterval: 1 } };

const scenarios = {
  'opening summary failure': () => withTaskHarness({
    chat: [assistant(0, '开场白正文')],
  }, () => summarizeOpeningMessage()),
  'rewrite summary failure': () => withTaskHarness({
    chat: [assistant(0, '开场'), assistant(1, '第一楼正文')],
  }, () => regenerateMemoryForMessage(1)),
  'regenerate latest grand failure': () => withTaskHarness({
    chat: [
      assistant(0, '正文零\n<memory>\n[n:1]\n零\n</memory>'),
      assistant(1, '正文一\n<memory>\n[n:2]\n一\n</memory>'),
      grand(2, 0, 1),
    ],
    summary: {
      archiveRecords: [{
        id: '2-record',
        summaryMessageId: 2,
        archiveFrom: 0,
        archiveTo: 1,
        memoryFrom: 0,
        memoryTo: 1,
        rangeType: 'memory',
      }],
    },
  }, () => regenerateLatestGrandMemory()),
  'auto grand failure': () => withTaskHarness({
    chat: [autoGrandSource],
    summary: autoGrandSummary(),
    modules: autoGrandModules,
  }, () => processAutoGrandMemory()),
  'total grand failure': () => {
    const records = totalGrandRecords();
    return withTaskHarness({
      chat: records.map(record => grand(record.summaryMessageId, record.memoryFrom, record.memoryTo)),
      summary: { archiveRecords: records },
    }, () => processTotalGrandMemory());
  },
  'legacy archive failure': () => withTaskHarness({
    chat: [assistant(0, '旧聊天正文 1'), assistant(1, '旧聊天正文 2')],
  }, () => processLegacyGrandArchive()),
  'auto grand success': () => withTaskHarness({
    chat: [autoGrandSource],
    summary: autoGrandSummary(),
    modules: autoGrandModules,
    generate: () => '<grand_memory>\n[volume: 0-0]\n自动大总结\n</grand_memory>',
  }, () => processAutoGrandMemory()),
  'total grand success': () => {
    const records = totalGrandRecords();
    return withTaskHarness({
      chat: records.map(record => grand(record.summaryMessageId, record.memoryFrom, record.memoryTo)),
      summary: { archiveRecords: records },
      generate: () => '<grand_memory>\n[volume: 0-3]\n总档案\n</grand_memory>',
    }, () => processTotalGrandMemory());
  },
  'legacy archive success': () => withTaskHarness({
    chat: [assistant(0, '旧聊天正文 1'), assistant(1, '旧聊天正文 2')],
    generate: () => '<grand_memory>\n[volume: 0-1]\n旧聊天大总结\n</grand_memory>',
  }, () => processLegacyGrandArchive()),
};

// Frozen from the pre-refactor implementation: start / failure / success bookkeeping of the six summary tasks.
const expected = {
  "opening summary failure": {
    "runningDuringGenerate": [
      "opening_memory"
    ],
    "toasts": [
      [
        "info",
        "0楼小总结生成中。",
        "小总结管理"
      ],
      [
        "error",
        "酒馆主 API 生成失败：模拟生成失败",
        "0楼小总结失败"
      ]
    ],
    "runningTask": "none",
    "lastError": "酒馆主 API 生成失败：模拟生成失败",
    "legacyPhase": "idle"
  },
  "rewrite summary failure": {
    "runningDuringGenerate": [
      "manual_memory"
    ],
    "toasts": [
      [
        "info",
        "第 1 楼小总结生成中。",
        "重写小总结"
      ],
      [
        "error",
        "酒馆主 API 生成失败：模拟生成失败",
        "重写小总结失败"
      ]
    ],
    "runningTask": "none",
    "lastError": "酒馆主 API 生成失败：模拟生成失败",
    "legacyPhase": "idle"
  },
  "regenerate latest grand failure": {
    "runningDuringGenerate": [
      "grand_memory"
    ],
    "toasts": [
      [
        "info",
        "正在重新生成第 2 楼大总结。",
        "归档管理器"
      ],
      [
        "error",
        "酒馆主 API 生成失败：模拟生成失败",
        "重新生成大总结失败"
      ]
    ],
    "runningTask": "none",
    "lastError": "酒馆主 API 生成失败：模拟生成失败",
    "legacyPhase": "idle"
  },
  "auto grand failure": {
    "runningDuringGenerate": [
      "grand_memory"
    ],
    "toasts": [
      [
        "info",
        "大总结生成中。",
        "自动总结"
      ],
      [
        "error",
        "酒馆主 API 生成失败：模拟生成失败",
        "自动大总结失败"
      ]
    ],
    "runningTask": "none",
    "lastError": "酒馆主 API 生成失败：模拟生成失败",
    "legacyPhase": "idle"
  },
  "total grand failure": {
    "runningDuringGenerate": [
      "total_grand_memory"
    ],
    "toasts": [
      [
        "info",
        "正在合并 4 条大总结。",
        "总档案压缩"
      ],
      [
        "error",
        "酒馆主 API 生成失败：模拟生成失败",
        "总档案压缩失败"
      ]
    ],
    "runningTask": "none",
    "lastError": "酒馆主 API 生成失败：模拟生成失败",
    "legacyPhase": "idle"
  },
  "legacy archive failure": {
    "runningDuringGenerate": [
      "legacy_grand_memory"
    ],
    "toasts": [
      [
        "info",
        "旧聊天归档开始：2 批。",
        "旧聊天归档"
      ],
      [
        "error",
        "第 1 / 2 批摘要失败：酒馆主 API 生成失败：模拟生成失败。可重新扫描后重试。",
        "旧聊天归档失败"
      ]
    ],
    "runningTask": "none",
    "lastError": "第 1 / 2 批摘要失败：酒馆主 API 生成失败：模拟生成失败。可重新扫描后重试。",
    "legacyPhase": "error"
  },
  "auto grand success": {
    "runningDuringGenerate": [
      "grand_memory"
    ],
    "toasts": [
      [
        "info",
        "大总结生成中。",
        "自动总结"
      ],
      [
        "success",
        "已生成第 1 楼大总结；本次隐藏 1 层，保留已归档剧情 0 层。",
        "自动总结"
      ]
    ],
    "runningTask": "none",
    "lastError": "",
    "legacyPhase": "idle",
    "hidden": [
      0
    ],
    "chatLength": 2,
    "memoryCountSinceArchive": 0,
    "memoryCountedMessageIds": [],
    "lastArchivedMessageId": 0,
    "lastGrandSummaryMessageId": 1,
    "retainedArchiveMessageIds": [],
    "archiveRecordCount": 1,
    "lastRecord": {
      "summaryMessageId": 1,
      "archiveFrom": 0,
      "archiveTo": 0,
      "memoryFrom": 0,
      "memoryTo": 0,
      "rangeType": "memory",
      "compressedBy": null
    },
    "legacyStatus": {
      "phase": "idle",
      "totalMessages": 0,
      "batchSize": 30,
      "batchTotal": 0,
      "batchIndex": 0,
      "lastResult": ""
    }
  },
  "total grand success": {
    "runningDuringGenerate": [
      "total_grand_memory"
    ],
    "toasts": [
      [
        "info",
        "正在合并 4 条大总结。",
        "总档案压缩"
      ],
      [
        "success",
        "已生成第 4 楼总档案，并合并 4 条大总结；本次隐藏 4 层，保留已归档剧情 0 层。",
        "总档案压缩"
      ]
    ],
    "runningTask": "none",
    "lastError": "",
    "legacyPhase": "idle",
    "hidden": [
      0,
      1,
      2,
      3
    ],
    "chatLength": 5,
    "memoryCountSinceArchive": 0,
    "memoryCountedMessageIds": [],
    "lastArchivedMessageId": 3,
    "lastGrandSummaryMessageId": 4,
    "retainedArchiveMessageIds": [],
    "archiveRecordCount": 5,
    "lastRecord": {
      "summaryMessageId": 4,
      "archiveFrom": 0,
      "archiveTo": 3,
      "memoryFrom": 0,
      "memoryTo": 3,
      "rangeType": "total_grand",
      "compressedBy": null,
      "compressedRecordIds": [
        0,
        1,
        2,
        3
      ]
    },
    "legacyStatus": {
      "phase": "idle",
      "totalMessages": 0,
      "batchSize": 30,
      "batchTotal": 0,
      "batchIndex": 0,
      "lastResult": ""
    }
  },
  "legacy archive success": {
    "runningDuringGenerate": [
      "legacy_grand_memory",
      "legacy_grand_memory",
      "legacy_grand_memory"
    ],
    "toasts": [
      [
        "info",
        "旧聊天归档开始：2 批。",
        "旧聊天归档"
      ],
      [
        "success",
        "已生成第 2 楼旧聊天大总结；本次隐藏 2 层，保留已归档剧情 0 层。",
        "旧聊天归档"
      ]
    ],
    "runningTask": "none",
    "lastError": "",
    "legacyPhase": "done",
    "hidden": [
      0,
      1
    ],
    "chatLength": 3,
    "memoryCountSinceArchive": 0,
    "memoryCountedMessageIds": [],
    "lastArchivedMessageId": 1,
    "lastGrandSummaryMessageId": 2,
    "retainedArchiveMessageIds": [],
    "archiveRecordCount": 1,
    "lastRecord": {
      "summaryMessageId": 2,
      "archiveFrom": 0,
      "archiveTo": 1,
      "memoryFrom": 0,
      "memoryTo": 1,
      "rangeType": "floor",
      "compressedBy": null
    },
    "legacyStatus": {
      "phase": "done",
      "totalMessages": 2,
      "batchSize": 1,
      "batchTotal": 2,
      "batchIndex": 2,
      "lastResult": "已生成第 2 楼旧聊天大总结；本次隐藏 2 层，保留已归档剧情 0 层。"
    }
  }
};

assert.deepEqual(Object.keys(expected), Object.keys(scenarios));

for (const [name, run] of Object.entries(scenarios)) {
  test(`summary task lifecycle: ${name}`, async () => {
    assert.deepEqual(await run(), expected[name]);
  });
}
