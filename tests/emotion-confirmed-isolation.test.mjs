import assert from 'node:assert/strict';
import test from 'node:test';
import { commitEmotionUpdateFromConfirmedSummary } from '../src/features/emotion-profile/workflow.js';
import { CHAT_STATE_KEY } from '../src/constants.js';

test('confirmed Emotion keeps A state isolated when the chat changes between pending preparation and commit', async () => {
  const previousSillyTavern = globalThis.SillyTavern;
  const previousWindow = globalThis.window;
  const stateA = { emotionProfiles: { profiles: {}, pendingByMessage: {} } };
  const stateB = { emotionProfiles: { profiles: { Existing: { name: 'Existing', records: [] } }, pendingByMessage: {} } };
  const contextA = {
    chatId: 'chat-a',
    chat: [{ message_id: 0, role: 'assistant', message: 'A' }],
    chatMetadata: { [CHAT_STATE_KEY]: stateA },
    saveMetadataDebounced: () => {},
  };
  const contextB = {
    chatId: 'chat-b',
    chat: [{ message_id: 0, role: 'assistant', message: 'B' }],
    chatMetadata: { [CHAT_STATE_KEY]: stateB },
    saveMetadataDebounced: () => {},
  };
  const settings = { enabled: true, modules: { summary: { enabled: true }, emotionProfile: { enabled: true } } };
  let current = contextA;
  globalThis.SillyTavern = { getContext: () => current };
  globalThis.window = globalThis;
  const result = '<memory>\n[emotion_changed:true]\n[emotion:Luna|信任|安心|共同经历]\n</memory>';
  try {
    const committedWhileSwitched = await commitEmotionUpdateFromConfirmedSummary(result, {
      messageId: 0,
      fingerprint: '1:1',
      chatState: stateA,
      settings,
      isCurrentChat: () => {
        current = contextB;
        return false;
      },
    });
    assert.equal(committedWhileSwitched, false);
    assert.deepEqual(stateB.emotionProfiles, { profiles: { Existing: { name: 'Existing', records: [] } }, pendingByMessage: {} });
    assert.ok(stateA.emotionProfiles.pendingByMessage['0']);

    current = contextA;
    const committedAfterReturn = await commitEmotionUpdateFromConfirmedSummary(result, {
      messageId: 0,
      fingerprint: '1:1',
      chatState: stateA,
      settings,
      isCurrentChat: () => true,
    });
    assert.equal(committedAfterReturn, true);
    assert.equal(stateA.emotionProfiles.profiles.Luna.records.length, 1);
    assert.deepEqual(stateB.emotionProfiles, { profiles: { Existing: { name: 'Existing', records: [] } }, pendingByMessage: {} });
  } finally {
    if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousSillyTavern;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
