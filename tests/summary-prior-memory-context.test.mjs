import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPriorMemoriesForSummary } from '../src/features/summary/workflow.js';
import { CHAT_STATE_KEY } from '../src/constants.js';

function assistant(message_id, message) {
  return { message_id, role: 'assistant', swipe_id: 0, message };
}

async function withContext(context, run) {
  const previous = globalThis.SillyTavern;
  globalThis.SillyTavern = { getContext: () => context };
  try {
    await run();
  } finally {
    if (previous === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previous;
  }
}

function createContext(chat, archiveRecords) {
  return {
    chatId: 'chat-a',
    chat,
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        summary: {
          archiveRecords,
        },
      },
    },
  };
}

test('prior summary context keeps post-archive summaries that appear before the Grand message', async () => {
  const context = createContext([
    assistant(0, 'A0\n<memory>[n:1] A0</memory>'),
    { message_id: 1, role: 'user', message: 'U1' },
    assistant(2, 'B2 后补总结\n<memory>[n:2] B2</memory>'),
    assistant(3, '<grand_memory>\n[volume: 1-1]\nGrand3\n</grand_memory>'),
    assistant(4, 'C4'),
  ], [{ id: 'grand-3', summaryMessageId: 3, archiveFrom: 0, archiveTo: 0 }]);

  await withContext(context, () => {
    const priorMemories = collectPriorMemoriesForSummary(4);
    assert.equal(priorMemories.length, 2);
    assert.equal(priorMemories.filter(memory => memory.includes('Grand3')).length, 1);
    assert.equal(priorMemories.filter(memory => memory.includes('B2')).length, 1);
    assert.equal(priorMemories.some(memory => memory.includes('A0')), false);
  });
});

test('a later Grand archive prevents its archived summary from repeating as prior context', async () => {
  const context = createContext([
    assistant(0, 'A0\n<memory>[n:1] A0</memory>'),
    { message_id: 1, role: 'user', message: 'U1' },
    assistant(2, 'B2\n<memory>[n:2] B2</memory>'),
    assistant(3, '<grand_memory>\n[volume: 1-1]\nGrand3\n</grand_memory>'),
    { message_id: 4, role: 'user', message: 'U2' },
    assistant(5, '<grand_memory>\n[volume: 2-2]\nGrand5\n</grand_memory>'),
    assistant(6, 'C6'),
  ], [
    { id: 'grand-3', summaryMessageId: 3, archiveFrom: 0, archiveTo: 0 },
    { id: 'grand-5', summaryMessageId: 5, archiveFrom: 1, archiveTo: 2 },
  ]);

  await withContext(context, () => {
    const priorMemories = collectPriorMemoriesForSummary(6);
    assert.equal(priorMemories.length, 1);
    assert.equal(priorMemories[0].includes('Grand5'), true);
    assert.equal(priorMemories.some(memory => memory.includes('B2')), false);
  });
});

test('legacy Grand chats without archiveTo retain the previous message-position boundary', async () => {
  const context = createContext([
    assistant(0, 'A0\n<memory>[n:1] A0</memory>'),
    { message_id: 1, role: 'user', message: 'U1' },
    assistant(2, 'B2\n<memory>[n:2] B2</memory>'),
    assistant(3, '<grand_memory>\n[volume: 1-1]\nLegacy Grand\n</grand_memory>'),
    assistant(4, 'C4'),
  ], [{ id: 'legacy-grand', summaryMessageId: 3 }]);

  await withContext(context, () => {
    const priorMemories = collectPriorMemoriesForSummary(4);
    assert.equal(priorMemories.length, 1);
    assert.equal(priorMemories[0].includes('Legacy Grand'), true);
  });
});
