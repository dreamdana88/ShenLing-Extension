import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY } from '../src/constants.js';
import { normalizeCaptureDraft } from '../src/core/settings.js';
import { commitCaptureDrafts } from '../src/features/memoir/capture-commit.js';
import { commitMemoirCandidates } from '../src/features/memoir/memoir-commit.js';

function createInMemoryWorldbookApi({
  worldbookName = 'review-memoir-book',
  initialBook = [],
} = {}) {
  const books = new Map([[worldbookName, structuredClone(initialBook)]]);
  let nextUid = 1;
  let getWorldbookCalls = 0;
  let updateCalls = 0;

  return {
    worldbookName,
    stats: {
      get getWorldbookCalls() { return getWorldbookCalls; },
      get updateCalls() { return updateCalls; },
      books,
    },
    api: {
      getWorldbookNames: async () => [...books.keys()],
      getChatWorldbookName: async () => worldbookName,
      rebindChatWorldbook: async (_target, name) => {
        if (!books.has(name)) books.set(name, []);
        worldbookName = name;
      },
      getWorldbook: async (name) => {
        getWorldbookCalls += 1;
        if (!books.has(name)) throw new Error(`missing worldbook: ${name}`);
        return structuredClone(books.get(name));
      },
      createWorldbook: async (name) => {
        if (!books.has(name)) books.set(name, []);
      },
      updateWorldbookWith: async (name, updater) => {
        updateCalls += 1;
        if (!books.has(name)) books.set(name, []);
        const current = structuredClone(books.get(name));
        const next = await updater(current);
        const list = Array.isArray(next) ? next : [];
        list.forEach(entry => {
          if (entry && (entry.uid === undefined || entry.uid === null)) {
            entry.uid = nextUid;
            nextUid += 1;
          }
        });
        books.set(name, list);
        return structuredClone(list);
      },
    },
  };
}

async function withChatContext({ chatId = 'chat-review-fix', memoir = {} } = {}, run) {
  const previousSillyTavern = globalThis.SillyTavern;
  const previousTavernHelper = globalThis.TavernHelper;
  const context = {
    chatId,
    characterId: 'char-review-fix',
    getCurrentChatId: () => chatId,
    chatMetadata: {
      [CHAT_STATE_KEY]: {
        memoir: {
          worldbookId: '',
          worldbookName: '',
          prevBoundName: '',
          overviewUid: null,
          bindingDecision: null,
          sourceProcessed: [],
          entries: [],
          pending: {
            sourceKey: 'grand:1:0-1',
            sourceKeys: ['grand:1:0-1'],
            candidates: [],
            generatedAt: '2026-08-05T00:00:00.000Z',
          },
          capture: {
            request: '',
            requestedType: 'auto',
            source: { mode: 'recent_chat', recentCount: 20, fromFloor: null, toFloor: null, summaryId: null },
            optionalContext: { includeCharacterCard: false, includePersona: false, worldbookRefs: [] },
            drafts: [],
            lastError: '',
          },
          updatedAt: '',
          ...memoir,
        },
      },
    },
    saveMetadataDebounced: () => {},
  };
  globalThis.SillyTavern = { getContext: () => context };
  try {
    return await run(context);
  } finally {
    if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousSillyTavern;
    if (previousTavernHelper === undefined) delete globalThis.TavernHelper;
    else globalThis.TavernHelper = previousTavernHelper;
  }
}

test('commitCaptureDrafts executes normalizeCaptureDraft and independent readback with providedApi', async () => {
  const { api, worldbookName, stats } = createInMemoryWorldbookApi();
  const inputDraft = {
    captureId: 'capture-review-fix-1',
    type: 'npc',
    title: '测试角色',
    mainKeywords: ['测试角色'],
    filterKeywords: ['初遇'],
    content: '用于验证 Capture 正式提交入口。',
    position: 'after_character_definition',
    order: 950,
  };

  const result = await commitCaptureDrafts([inputDraft], {
    api,
    worldbookName,
    persist: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.verifiedCount, 1);
  assert.deepEqual(result.verifiedIds, ['capture-review-fix-1']);
  assert.equal(result.addedCount, 1);
  assert.equal(result.failures.length, 0);
  assert.ok(stats.updateCalls >= 1);
  assert.ok(stats.getWorldbookCalls >= 1);

  const stored = stats.books.get(worldbookName);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].extra.captureId, 'capture-review-fix-1');
  assert.equal(stored[0].extra.captureType, 'npc');
  assert.match(stored[0].name, /SLX-Capture-NPC-测试角色/);

  // Prove normalizeCaptureDraft path: invalid type falls back and id is preserved.
  const normalized = normalizeCaptureDraft(inputDraft);
  assert.equal(normalized.captureId, 'capture-review-fix-1');
  assert.equal(normalized.type, 'npc');
});

test('commitMemoirCandidates uses getWorldbookApi default path and writes green/blue entries', async () => {
  const worldbookName = 'review-memoir-book';
  const { api, stats } = createInMemoryWorldbookApi({ worldbookName });

  await withChatContext({
    chatId: 'chat-review-fix',
    memoir: {
      worldbookId: worldbookName,
      worldbookName,
      bindingDecision: {
        chatId: 'chat-review-fix',
        worldbookName,
        mode: 'reuse',
        confirmedAt: '2026-08-05T00:00:00.000Z',
      },
      sourceProcessed: [],
      entries: [],
      pending: {
        sourceKey: 'grand:9:1-2',
        sourceKeys: ['grand:9:1-2'],
        candidates: [{ candidateId: 'cand-review-fix-1' }],
        generatedAt: '2026-08-05T00:00:00.000Z',
      },
    },
  }, async (context) => {
    globalThis.TavernHelper = api;

    const result = await commitMemoirCandidates([{
      candidateId: 'cand-review-fix-1',
      title: '测试回忆',
      digest: '测试摘要',
      storyTime: '测试时间',
      importance: 'medium',
      participants: ['角色'],
      mainKeywords: ['角色'],
      filterKeywords: ['事件'],
      content: '用于验证剧情回忆正式提交入口。',
    }], {
      sourceKey: 'grand:9:1-2',
      sourceKeys: ['grand:9:1-2'],
    });

    assert.equal(result.verified, true);
    assert.equal(result.worldbookName, worldbookName);
    assert.equal(result.greenAdded, 1);
    assert.ok(stats.updateCalls >= 1);
    assert.ok(stats.getWorldbookCalls >= 1);

    const book = stats.books.get(worldbookName);
    const green = book.find(entry => entry?.extra?.memoirId === 'mem-review-fix-1');
    const blue = book.find(entry => entry?.extra?.memoirType === 'blue');
    assert.ok(green, 'green entry must exist');
    assert.ok(blue, 'blue overview must exist');
    assert.equal(green.extra.memoirType, 'green');
    assert.equal(blue.position.order, 900);
    assert.equal(green.position.order, 901);

    const memoir = context.chatMetadata[CHAT_STATE_KEY].memoir;
    assert.equal(memoir.pending, null);
    assert.ok(memoir.sourceProcessed.includes('grand:9:1-2'));
    assert.equal(memoir.entries.length, 1);
    assert.equal(memoir.entries[0].memoirId, 'mem-review-fix-1');
    assert.ok(memoir.entries[0].uid !== undefined && memoir.entries[0].uid !== null);
  });
});
