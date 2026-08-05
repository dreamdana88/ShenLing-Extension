import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatIdentityKey,
  captureChatScope,
  CHAT_SCOPE_REASON,
  evaluateChatScope,
  getChatSwitchEpoch,
  isChatScopeAvailable,
  isChatScopeValid,
  markChatScopeChanged,
  resetChatScopeEpochForTests,
} from '../src/core/chat-scope.js';

test('buildChatIdentityKey requires both characterId and chatId', () => {
  assert.equal(buildChatIdentityKey('char-a', 'chat-1'), 'char-a\u001fchat-1');
  assert.equal(buildChatIdentityKey('', 'chat-1'), '');
  assert.equal(buildChatIdentityKey('char-a', ''), '');
  assert.equal(buildChatIdentityKey('  ', 'chat-1'), '');
});

test('captureChatScope returns a frozen snapshot with current epoch', () => {
  resetChatScopeEpochForTests(3);
  const scope = captureChatScope({ characterId: 'c1', chatId: 'h1' });
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(scope.characterId, 'c1');
  assert.equal(scope.chatId, 'h1');
  assert.equal(scope.identityKey, 'c1\u001fh1');
  assert.equal(scope.epoch, 3);
  assert.equal(typeof scope.capturedAt, 'number');
  assert.throws(() => {
    scope.chatId = 'mutated';
  });
});

test('same characterId + chatId + epoch remains valid', () => {
  resetChatScopeEpochForTests(0);
  const scope = captureChatScope({ characterId: 'c1', chatId: 'h1' });
  assert.equal(isChatScopeAvailable(scope), true);
  assert.equal(isChatScopeValid(scope, { characterId: 'c1', chatId: 'h1' }, 0), true);
  assert.deepEqual(evaluateChatScope(scope, { characterId: 'c1', chatId: 'h1' }, 0), {
    valid: true,
    reason: null,
  });
});

test('different chatId or characterId is invalid', () => {
  resetChatScopeEpochForTests(0);
  const scope = captureChatScope({ characterId: 'c1', chatId: 'h1' });
  assert.equal(isChatScopeValid(scope, { characterId: 'c1', chatId: 'h2' }, 0), false);
  assert.equal(
    evaluateChatScope(scope, { characterId: 'c1', chatId: 'h2' }, 0).reason,
    CHAT_SCOPE_REASON.CHAT_SCOPE_CHANGED,
  );
  assert.equal(isChatScopeValid(scope, { characterId: 'c2', chatId: 'h1' }, 0), false);
  assert.equal(
    evaluateChatScope(scope, { characterId: 'c2', chatId: 'h1' }, 0).reason,
    CHAT_SCOPE_REASON.CHAT_SCOPE_CHANGED,
  );
});

test('epoch change and A→B→A remain invalid', () => {
  resetChatScopeEpochForTests(0);
  const scopeA = captureChatScope({ characterId: 'c1', chatId: 'chat-a' });
  assert.equal(isChatScopeValid(scopeA, { characterId: 'c1', chatId: 'chat-a' }, 0), true);

  markChatScopeChanged(); // A → B
  assert.equal(getChatSwitchEpoch(), 1);
  assert.equal(isChatScopeValid(scopeA, { characterId: 'c1', chatId: 'chat-b' }, 1), false);

  markChatScopeChanged(); // B → A
  assert.equal(getChatSwitchEpoch(), 2);
  // identity returns to A, but epoch advanced twice → still invalid
  assert.equal(isChatScopeValid(scopeA, { characterId: 'c1', chatId: 'chat-a' }, 2), false);
  assert.equal(
    evaluateChatScope(scopeA, { characterId: 'c1', chatId: 'chat-a' }, 2).reason,
    CHAT_SCOPE_REASON.CHAT_SCOPE_CHANGED,
  );
});

test('missing chatId is fail closed and never matches', () => {
  resetChatScopeEpochForTests(0);
  const empty = captureChatScope({ characterId: 'c1', chatId: '' });
  assert.equal(isChatScopeAvailable(empty), false);
  assert.equal(evaluateChatScope(empty).reason, CHAT_SCOPE_REASON.CHAT_SCOPE_UNAVAILABLE);

  const valid = captureChatScope({ characterId: 'c1', chatId: 'h1' });
  assert.equal(
    evaluateChatScope(valid, { characterId: 'c1', chatId: '' }, 0).reason,
    CHAT_SCOPE_REASON.CHAT_SCOPE_UNAVAILABLE,
  );
  // Two empty scopes must not match each other through identityKey.
  const emptyB = captureChatScope({ characterId: '', chatId: '' });
  assert.equal(isChatScopeValid(emptyB, { characterId: '', chatId: '' }, 0), false);
});
