import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import { getAssistantMessageContentFingerprint } from '../src/core/message-fingerprint.js';
import { processAutoGrandMemory } from '../src/features/summary/archive.js';
import { configureSummaryWorkflow } from '../src/features/summary/runtime.js';

function assistant(messageId, message, isHidden = false) {
  return {
    message_id: messageId,
    role: 'assistant',
    is_user: false,
    is_hidden: isHidden,
    swipe_id: 0,
    message,
    mes: message,
  };
}

function grand(messageId, from, to) {
  return assistant(messageId, `<grand_memory>\n[volume: ${from}-${to}]\n大总结 ${messageId}\n</grand_memory>`);
}

async function runAutoGrand({ chat, summary }) {
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
    characterId: 'visibility-character',
    chatId: 'visibility-chat',
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
            autoGrandMemoryEnabled: true,
            grandMemoryInterval: 1,
            autoTotalGrandMemoryEnabled: false,
          },
        },
      },
    },
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        summary: {
          runningTask: 'none',
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
  const hidden = [];
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.window = globalThis;
  delete globalThis.TavernHelper;
  globalThis.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [type, () => {}]));
  globalThis.generateRaw = async () => '<grand_memory>\n[volume: 2-3]\n第二次大总结\n</grand_memory>';
  globalThis.createChatMessages = async messages => {
    context.chat.push(assistant(context.chat.length, messages[0].message));
  };
  globalThis.setChatMessages = async updates => {
    for (const update of updates) {
      if (update.is_hidden) hidden.push(update.message_id);
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
    await processAutoGrandMemory();
    return { hidden, summary: context.chatMetadata[CHAT_STATE_KEY].summary, chat: context.chat };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

// The first Grand floor is appended after newer, not-yet-archived messages, so its
// message ID falls inside the next automatic archive range.
test('automatic Grand archive does not hide an earlier Grand floor inside its range', async () => {
  const first = assistant(0, '正文 A\n<memory>\n[number:1]\nA\n</memory>', true);
  const second = assistant(1, '正文 B\n<memory>\n[number:2]\nB\n</memory>');
  const third = assistant(3, '正文 C\n<memory>\n[number:3]\nC\n</memory>');
  const { hidden, summary, chat } = await runAutoGrand({
    chat: [first, second, grand(2, 1, 1), third],
    summary: {
      archiveRecords: [{
        id: '2-record',
        summaryMessageId: 2,
        archiveFrom: 0,
        archiveTo: 0,
        memoryFrom: 1,
        memoryTo: 1,
        createdAt: 1,
      }],
      lastArchivedMessageId: 0,
      lastGrandSummaryMessageId: 2,
      memoryCountSinceArchive: 2,
      memoryCountedMessageIds: [1, 3],
      processedMessageFingerprints: {
        1: getAssistantMessageContentFingerprint(second),
        3: getAssistantMessageContentFingerprint(third),
      },
    },
  });

  assert.equal(summary.lastArchivedMessageId, 3);
  assert.equal(summary.archiveRecords.length, 2);
  assert.deepEqual(hidden, [1, 3]);
  assert.equal(chat[2].is_hidden, false);
  assert.equal(chat[4].is_hidden, false);
});
