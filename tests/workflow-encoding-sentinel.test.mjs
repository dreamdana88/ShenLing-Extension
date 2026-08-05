import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GARBLED_SNIPPETS = [
  '鎵嬪姩',
  '鍥炲繂',
  '锛',
  '鈹',
  '铚冪伒',
  '鏆傛棤',
  '妤糮',
  '€?',
];

const AFFECTION_SENTINELS = [
  '手动调整',
  '暂无已建档角色',
  '蜃灵攻略状态',
];

const MEMOIR_SENTINELS = [
  '回忆录世界书业务流程',
  '设定采集',
  '回忆录提炼',
];

test('affection and memoir workflows keep readable UTF-8 Chinese sentinels', async () => {
  const affectionSource = await readFile(
    new URL('../src/features/affection/workflow.js', import.meta.url),
    'utf8',
  );
  const memoirSource = await readFile(
    new URL('../src/features/memoir/workflow.js', import.meta.url),
    'utf8',
  );

  for (const sentinel of AFFECTION_SENTINELS) {
    assert.equal(
      affectionSource.includes(sentinel),
      true,
      `missing affection sentinel: ${sentinel}`,
    );
  }
  for (const sentinel of MEMOIR_SENTINELS) {
    assert.equal(
      memoirSource.includes(sentinel),
      true,
      `missing memoir sentinel: ${sentinel}`,
    );
  }

  for (const snippet of GARBLED_SNIPPETS) {
    assert.equal(
      affectionSource.includes(snippet),
      false,
      `garbled snippet found in affection: ${snippet}`,
    );
    assert.equal(
      memoirSource.includes(snippet),
      false,
      `garbled snippet found in memoir: ${snippet}`,
    );
  }

  // Template interpolations must remain intact after encoding accidents.
  assert.match(affectionSource, /\$\{record\.sourceMessageId\}/);
  assert.equal(affectionSource.includes('`绗?{'), false);
  assert.equal(memoirSource.includes('`绗?{'), false);
});
