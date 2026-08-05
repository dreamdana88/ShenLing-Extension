import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  getConfirmedSummaryTasks,
  normalizeSummaryLifecycleMetadata,
} from '../src/core/settings.js';
import { commitAffectionUpdateFromConfirmedSummary } from '../src/features/affection/lifecycle.js';
import {
  commitSelectedPendingEmotionUpdates,
} from '../src/features/emotion-profile/workflow.js';
import {
  clearSummaryWriteIgnored,
  markSummaryWriteIgnored,
} from '../src/features/summary/state.js';
import { processImmediateWordReplace } from '../src/features/summary/workflow.js';

function task(taskKey, originalMessageId, status, effects = undefined) {
  return {
    taskKey,
    chatIdentity: 'chat-a',
    originalMessageId,
    assistantFingerprint: '1:1',
    selectedSwipeId: 0,
    confirmingUserMessageId: originalMessageId + 1,
    confirmingUserFingerprint: '1:1',
    status,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...(effects ? { effects } : {}),
  };
}

test('summary lifecycle migration filters corrupt fingerprints, cancels pre-activation tasks, and is idempotent', () => {
  const state = {
    summary: {
      pending: { obsolete: true },
      confirmedQueueActivatedAt: '2026-07-30T00:00:01.000Z',
      processedMessageFingerprints: { 0: '1:1', 1: 'invalid', wrong: '2:2', 2: '3:-4' },
      memoryCountedMessageIds: [0, '0', 2, -1, 'wrong'],
      confirmedTasks: [task('pre-activation', 0, 'PENDING')],
    },
  };

  normalizeSummaryLifecycleMetadata(state);
  const firstPass = JSON.stringify(state.summary);
  normalizeSummaryLifecycleMetadata(state);

  assert.equal(state.summary.lifecycleSchemaVersion, 1);
  assert.equal(Object.hasOwn(state.summary, 'pending'), false);
  assert.deepEqual(state.summary.processedMessageFingerprints, { 0: '1:1', 2: '3:-4' });
  assert.deepEqual(state.summary.memoryCountedMessageIds, [0, 2]);
  assert.equal(state.summary.confirmedTasks[0].status, 'CANCELLED');
  assert.equal(state.summary.confirmedTasks[0].reasonCode, 'PRE_ACTIVATION');
  assert.equal(JSON.stringify(state.summary), firstPass);
});

test('only safely terminal confirmed tasks covered by Grand archiveTo are pruned', () => {
  const terminalEffects = { emotion: 'SUCCEEDED', affection: 'SKIPPED', plot: 'SUCCEEDED' };
  const state = {
    summary: {
      archiveRecords: [{ summaryMessageId: 4, archiveFrom: 0, archiveTo: 2 }],
      confirmedTasks: [
        task('archived-summary', 2, 'SUMMARIZED', terminalEffects),
        task('archived-cancelled', 1, 'CANCELLED'),
        task('pending-must-stay', 1, 'PENDING'),
        task('failed-must-stay', 0, 'FAILED'),
        task('unarchived-summary', 3, 'SUMMARIZED', terminalEffects),
      ],
    },
  };

  assert.deepEqual(
    getConfirmedSummaryTasks(state).map(item => item.taskKey),
    ['pending-must-stay', 'failed-must-stay', 'unarchived-summary'],
  );
});

test('legacy pending handler ignores a confirmed-origin emotion item', async () => {
  const state = {
    emotionProfiles: {
      profiles: {},
      pendingByMessage: {
        0: {
          messageId: 0,
          items: {
            '1:1': {
              origin: 'confirmed',
              changed: true,
              profiles: [{ roleName: 'Luna', currentStatus: '信任', changeSummary: '共同经历', relationshipToUser: '同伴' }],
            },
          },
        },
      },
    },
  };

  await commitSelectedPendingEmotionUpdates({
    chatState: state,
    settings: { enabled: true, modules: { summary: { enabled: true }, emotionProfile: { enabled: true } } },
    getSelectedFingerprint: () => '1:1',
    persist: false,
    sync: false,
  });

  assert.deepEqual(state.emotionProfiles.profiles, {});
  assert.ok(state.emotionProfiles.pendingByMessage[0].items['1:1']);
});

test('confirmed Affection applies directly without creating legacy pending state', async () => {
  const previousSillyTavern = globalThis.SillyTavern;
  const state = {
    affectionSystem: {
      profiles: {
        Luna: {
          roleName: 'Luna',
          initialValueTenths: 500,
          valueTenths: 500,
          stages: [],
          records: [],
        },
      },
      pendingByMessage: {},
      buildTasks: {},
    },
  };
  const context = {
    chatId: 'chat-a',
    chat: [{ message_id: 0, role: 'assistant', message: 'A' }],
    chatMetadata: { [CHAT_STATE_KEY]: state },
    saveMetadataDebounced: () => {},
  };
  globalThis.SillyTavern = { getContext: () => context };
  try {
    const result = await commitAffectionUpdateFromConfirmedSummary(
      '<memory>\n[affection:Luna|0.1]\n</memory>',
      {
        messageId: 0,
        chatState: state,
        chatId: 'chat-a',
        persist: false,
        settings: {
          enabled: true,
          modules: {
            summary: { enabled: true },
            affection: { enabled: true, mode: 'normal' },
          },
        },
      },
    );
    assert.deepEqual(result.committedRoleNames, ['Luna']);
    assert.equal(state.affectionSystem.profiles.Luna.valueTenths, 501);
    assert.deepEqual(state.affectionSystem.pendingByMessage, {});
  } finally {
    if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousSillyTavern;
  }
});

test('a Summary write ignore from chat A cannot suppress the same message id in chat B', async () => {
  const previousSillyTavern = globalThis.SillyTavern;
  const previousWindow = globalThis.window;
  const previousSetChatMessages = globalThis.setChatMessages;
  const contextB = {
    chatId: 'chat-b',
    chat: [{ message_id: 0, role: 'assistant', message: '旧词' }],
    extensionSettings: {
      [MODULE_NAME]: {
        enabled: true,
        modules: {
          replace: {
            enabled: true,
            defaultsVersion: 11,
            rules: [{ id: 'replace-old', enabled: true, kind: 'fixed', source: '旧词', target: '新词', mode: 'plain', scope: 'all' }],
          },
        },
      },
    },
    chatMetadata: { [CHAT_STATE_KEY]: {} },
    saveMetadataDebounced: () => {},
  };
  globalThis.SillyTavern = { getContext: () => contextB };
  globalThis.window = globalThis;
  globalThis.setChatMessages = async updates => {
    updates.forEach(update => {
      contextB.chat[Number(update.message_id)].message = update.message;
    });
  };
  try {
    assert.equal(markSummaryWriteIgnored(0, 0, 'chat-a'), true);
    assert.equal(await processImmediateWordReplace(0), true);
    assert.equal(contextB.chat[0].message, '新词');
  } finally {
    clearSummaryWriteIgnored(0, 'chat-a');
    clearSummaryWriteIgnored(0, 'chat-b');
    if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousSillyTavern;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSetChatMessages === undefined) delete globalThis.setChatMessages;
    else globalThis.setChatMessages = previousSetChatMessages;
  }
});
