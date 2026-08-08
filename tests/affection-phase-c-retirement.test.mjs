import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME, PLUGIN_VERSION } from '../src/constants.js';
import {
  commitAffectionUpdateFromConfirmedSummary,
  commitSelectedPendingAffectionUpdates,
  parseAffectionUpdateFromMemory,
  processAffectionUpdateFromSummaryResult,
  rewriteAffectionMemoryFields,
  storePendingAffectionUpdate,
} from '../src/features/affection/lifecycle.js';
import { getAffectionSystemState } from '../src/core/settings.js';
import { buildAffectionUpdatePromptSection, PROMPT_CATALOG, PROMPT_IDS } from '../src/prompts.js';
import { createGenericAffectionStages } from '../src/features/affection/profile.js';
import { isAffectionEditorOpen, renderAffectionPanel } from '../src/features/affection/panel.js';
import { configureAffectionWorkflow } from '../src/features/affection/runtime.js';

function createProfile(roleName, initialValueTenths = 350) {
  return {
    roleName,
    initialValueTenths,
    valueTenths: initialValueTenths,
    buildMode: 'generic',
    buildStatus: 'ready',
    stages: createGenericAffectionStages(),
    records: [],
    stageDesignRequirement: '',
    sourceType: 'manual',
    sourceMessageId: null,
    sourceFingerprint: '',
    createdAt: 't0',
    updatedAt: 't0',
  };
}

function withContext(chatState, settings, chatId = 'chat-c') {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    generateRaw: globalThis.generateRaw,
    fetch: globalThis.fetch,
  };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId,
      chat: [{ mes: 'hi', swipe_id: 0, swipes: ['hi'] }],
      chatMetadata: { [CHAT_STATE_KEY]: chatState },
      extensionSettings: { [MODULE_NAME]: settings },
    }),
  };
  return () => {
    globalThis.SillyTavern = previous.SillyTavern;
    globalThis.generateRaw = previous.generateRaw;
    globalThis.fetch = previous.fetch;
  };
}

// 24.1 Prompt
test('default affection update prompt retires affection_first and only tracks profiles', () => {
  const withProfiles = buildAffectionUpdatePromptSection({
    knownAffectionText: '【沈青】已建档，当前好感 35.0/100',
  });
  const empty = buildAffectionUpdatePromptSection({ knownAffectionText: '暂无已建档角色。' });
  assert.doesNotMatch(withProfiles, /\[affection_first:/);
  assert.match(withProfiles, /不得输出 affection_first|已有正式好感档案|已建档角色/);
  assert.match(empty, /不输出任何 affection|不输出 affection/);
  const catalog = PROMPT_CATALOG.find(item => item.id === PROMPT_IDS.AFFECTION_UPDATE);
  assert.ok(catalog);
  assert.equal(catalog.requiredTokens.includes('[affection_first:'), false);
  assert.ok(catalog.requiredTokens.includes('[affection:'));
  assert.match(catalog.description, /已有档案/);
});

// 24.2 废弃字段
test('retired affection_first is stripped without pending or profile side effects', () => {
  const analysis = parseAffectionUpdateFromMemory(
    `<memory>\n[affection_first:萧景琰|35.0]\n</memory>`,
    { profiles: {} },
  );
  assert.ok(analysis);
  assert.equal(analysis.changes.length, 0);
  assert.ok(analysis.diagnostics.some(item => item.code === 'retired_affection_first_ignored'));
  assert.doesNotMatch(analysis.normalizedMemory, /affection_first/);
  assert.equal(Object.hasOwn(analysis, 'firsts'), false);

  const chatState = { affectionSystem: { profiles: {}, pendingByMessage: {} } };
  const settings = {
    enabled: true,
    modules: { summary: { enabled: true }, affection: { enabled: true, mode: 'normal' } },
  };
  const restore = withContext(chatState, settings);
  try {
    configureAffectionWorkflow({ refreshPanel: () => {} });
    const result = processAffectionUpdateFromSummaryResult(analysis.normalizedMemory || '<memory></memory>', {
      messageId: 1,
      analysis,
      settings,
      chatState,
      persist: false,
    });
    assert.equal(result?.pending, null);
    assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);
  } finally {
    configureAffectionWorkflow({ refreshPanel: null });
    restore();
  }
});

// 24.3 混合输出
test('mixed affection and retired first keeps profiled change only', () => {
  const profiles = { 梅长苏: createProfile('梅长苏', 300) };
  const analysis = parseAffectionUpdateFromMemory(
    `<memory>\n[affection:梅长苏|0.1]\n[affection_first:萧景琰|35.0]\n</memory>`,
    { profiles },
  );
  assert.equal(analysis.changes.length, 1);
  assert.equal(analysis.changes[0].roleName, '梅长苏');
  assert.equal(analysis.changes[0].deltaTenths, 1);
  assert.ok(analysis.diagnostics.some(item => item.code === 'retired_affection_first_ignored'));
  assert.match(analysis.normalizedMemory, /\[affection:梅长苏\|0\.1\|30\.1\]/);
  assert.doesNotMatch(analysis.normalizedMemory, /affection_first/);
});

// 24.4 未建档 affection
test('affection without profile is rejected as change_without_profile', () => {
  const analysis = parseAffectionUpdateFromMemory(
    `<memory>\n[affection:未建档角色|0.1]\n</memory>`,
    { profiles: {} },
  );
  assert.equal(analysis.changes.length, 0);
  assert.ok(analysis.diagnostics.some(item => item.code === 'change_without_profile'));
  assert.doesNotMatch(analysis.normalizedMemory, /\[affection:未建档角色/);
});

// 24.5 已建档变化 + confirmed
test('confirmed summary commits delta for existing profile only', async () => {
  const chatState = {
    affectionSystem: {
      profiles: { 沈青: createProfile('沈青', 350) },
      pendingByMessage: {},
    },
  };
  const settings = {
    enabled: true,
    modules: { summary: { enabled: true }, affection: { enabled: true, mode: 'normal' } },
  };
  const restore = withContext(chatState, settings);
  globalThis.generateRaw = async () => {
    throw new Error('no API expected');
  };
  try {
    configureAffectionWorkflow({ refreshPanel: () => {} });
    const memory = `<memory>\n[affection:沈青|0.1]\n[affection_first:阿蛮|20.0]\n</memory>`;
    const result = await commitAffectionUpdateFromConfirmedSummary(memory, {
      messageId: 12,
      settings,
      chatState,
      persist: false,
      isCurrentChat: () => true,
    });
    assert.ok(result.committedRoleNames.includes('沈青'));
    assert.equal(chatState.affectionSystem.profiles.沈青.valueTenths, 351);
    assert.equal(chatState.affectionSystem.profiles.沈青.records.length, 1);
    assert.equal(chatState.affectionSystem.profiles.沈青.records[0].deltaTenths, 1);
    assert.equal(chatState.affectionSystem.profiles.阿蛮, undefined);
    assert.equal(Object.hasOwn(chatState.affectionSystem, 'buildTasks'), false);
  } finally {
    configureAffectionWorkflow({ refreshPanel: null });
    restore();
  }
});

// 24.6 Swipe
test('selected swipe replaces same-message auto record; delta 0 revokes', async () => {
  const chatState = {
    affectionSystem: {
      profiles: {
        沈青: {
          ...createProfile('沈青', 350),
          records: [{
            recordId: 'old',
            sourceMessageId: 20,
            sourceFingerprint: 'old-fp',
            deltaTenths: 3,
            sourceType: 'auto',
            createdAt: 't1',
          }],
          valueTenths: 353,
        },
      },
      pendingByMessage: {
        20: {
          messageId: 20,
          items: {
            'swipe-a': {
              messageId: 20,
              fingerprint: 'swipe-a',
              changed: true,
              changes: [{ roleName: '沈青', deltaTenths: 1, valueBeforeTenths: 350, valueAfterTenths: 351 }],
              diagnostics: [],
              raw: {},
              origin: 'legacy',
            },
            'swipe-b': {
              messageId: 20,
              fingerprint: 'swipe-b',
              changed: false,
              changes: [{ roleName: '沈青', deltaTenths: 0, valueBeforeTenths: 350, valueAfterTenths: 350 }],
              diagnostics: [],
              raw: {},
              origin: 'legacy',
            },
          },
        },
      },
    },
  };
  const settings = {
    enabled: true,
    modules: { summary: { enabled: true }, affection: { enabled: true, mode: 'normal' } },
  };
  const restore = withContext(chatState, settings);
  try {
    configureAffectionWorkflow({ refreshPanel: () => {} });
    const zeroResult = await commitSelectedPendingAffectionUpdates({
      settings,
      chatState,
      persist: false,
      getSelectedFingerprint: () => 'swipe-b',
    });
    assert.ok(zeroResult.committedMessageIds.includes(20));
    assert.equal(chatState.affectionSystem.profiles.沈青.records.length, 0);
    assert.equal(chatState.affectionSystem.profiles.沈青.valueTenths, 350);
    assert.equal(chatState.affectionSystem.pendingByMessage['20'], undefined);
  } finally {
    configureAffectionWorkflow({ refreshPanel: null });
    restore();
  }
});

// 24.8 状态清理
test('getAffectionSystemState drops buildTasks and pending firsts', () => {
  const chatState = {
    affectionSystem: {
      profiles: { 沈青: createProfile('沈青') },
      pendingByMessage: {
        12: {
          messageId: 12,
          items: {
            fp: {
              changes: [{ roleName: '沈青', deltaTenths: 1 }],
              firsts: [{ roleName: '阿蛮', initialValueTenths: 350 }],
            },
            empty: {
              changes: [],
              firsts: [{ roleName: '幽灵', initialValueTenths: 10 }],
            },
          },
        },
      },
      buildTasks: {
        oldTask: { roleName: '阿蛮' },
      },
      lastUpdatedAt: 'keep-me',
    },
  };
  const store = getAffectionSystemState(chatState);
  assert.ok(store.profiles.沈青);
  assert.equal(Object.hasOwn(store, 'buildTasks'), false);
  assert.ok(store.pendingByMessage['12']?.items?.fp);
  assert.equal(Object.hasOwn(store.pendingByMessage['12'].items.fp, 'firsts'), false);
  assert.equal(store.pendingByMessage['12'].items.empty, undefined);
  assert.equal(store.lastUpdatedAt, 'keep-me');
});

// 24.9 Panel + Review Fix 开发诊断退役
test('panel no longer renders auto first-build controls, diagnostics, or preview APIs', async () => {
  const previous = { SillyTavern: globalThis.SillyTavern };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'chat-panel',
      chat: [],
      chatMetadata: {
        [CHAT_STATE_KEY]: {
          affectionSystem: {
            profiles: {},
            pendingByMessage: {},
          },
        },
      },
      extensionSettings: {
        [MODULE_NAME]: {
          enabled: true,
          modules: {
            summary: { enabled: true },
            affection: {
              enabled: true,
              mode: 'normal',
              defaultBuildMode: 'custom',
              profileBuildApiMode: 'secondary_api',
            },
          },
        },
      },
    }),
  };
  try {
    const html = renderAffectionPanel();
    assert.match(html, /新建角色档案/);
    assert.match(html, /data-slx-affection-open-create/);
    assert.doesNotMatch(html, /data-slx-affection-retry-task/);
    assert.doesNotMatch(html, /data-slx-affection-resolve-task/);
    assert.doesNotMatch(html, /首次建档需要合法初值/);
    assert.doesNotMatch(html, /开发诊断/);
    assert.doesNotMatch(html, /第 1–8 步测试与模拟|第 1-8 步测试与模拟/);
    assert.doesNotMatch(html, /开发期测试区/);
    assert.doesNotMatch(html, /首次角色预建档/);
    assert.doesNotMatch(html, /affection_first 初值/);
    assert.doesNotMatch(html, /模拟预建档/);
    assert.doesNotMatch(html, /显式调用真实 API/);
    assert.doesNotMatch(html, /data-slx-affection-run-build-suite/);
    assert.doesNotMatch(html, /data-slx-affection-run-build-simulator/);
    assert.doesNotMatch(html, /data-slx-affection-run-build-real/);
    assert.doesNotMatch(html, /data-slx-affection-run-commit-simulator/);
    assert.doesNotMatch(html, /data-slx-affection-run-injection-simulator/);
    assert.doesNotMatch(html, /data-slx-affection-test-section/);
    assert.equal(isAffectionEditorOpen(), false);

    const panelSource = await import('node:fs/promises').then(fs =>
      fs.readFile(new URL('../src/features/affection/panel.js', import.meta.url), 'utf8'),
    );
    const generationSource = await import('node:fs/promises').then(fs =>
      fs.readFile(new URL('../src/features/affection/generation.js', import.meta.url), 'utf8'),
    );
    for (const forbidden of [
      'affectionTestState',
      'createDefaultTestState',
      'runAffectionBuildSuite',
      'runAffectionBuildSimulator',
      'runAffectionBuildRealApiPreview',
      'createReadyCommitTask',
      'createAffectionBuildTaskKey',
      'runAffectionProfileBuildApiPreview',
      '预览占位上下文',
    ]) {
      assert.equal(panelSource.includes(forbidden), false, `panel still has ${forbidden}`);
    }
    assert.equal(generationSource.includes('runAffectionProfileBuildApiPreview'), false);
    assert.equal(generationSource.includes('预览占位上下文'), false);
    assert.equal(panelSource.includes('affectionSystem.buildTasks'), false);
  } finally {
    globalThis.SillyTavern = previous.SillyTavern;
  }
});

test('rewriteAffectionMemoryFields removes retired first lines', () => {
  const rewritten = rewriteAffectionMemoryFields(
    `<memory>\n[plot:x]\n[affection:沈青|0.1|35.1]\n[affection_first:阿蛮|20.0]\n</memory>`,
    { changes: [{ roleName: '沈青', deltaTenths: 1, valueAfterTenths: 351 }] },
  );
  assert.match(rewritten, /\[affection:沈青\|0\.1\|35\.1\]/);
  assert.doesNotMatch(rewritten, /affection_first/);
});

test('plugin version is 0.17.32 after Phase D', () => {
  assert.equal(PLUGIN_VERSION, '0.17.32');
});

test('formal affection panel keeps responsive styles after diagnostics retirement', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

  // 正式响应式与可访问性断点
  assert.match(css, /@media\s*\(\s*hover:\s*hover\s*\)/);
  assert.match(css, /@media\s*\(\s*max-width:\s*760px\s*\)/);
  assert.match(css, /@media\s*\(\s*max-width:\s*480px\s*\)/);
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);

  // 区块标题不得再写 Development Test Area
  assert.match(css, /Affection Panel/);
  assert.doesNotMatch(css, /Affection Development Test Area/);

  // 关键正式 selector / 值（允许空白换行）
  assert.match(css, /\.slx-affection-editor[\s\S]{0,400}width:\s*100%/);
  assert.match(css, /\.slx-affection-delta-stepper[\s\S]{0,200}44px/);
  assert.match(css, /\.slx-affection-editor-head\s*>\s*button[\s\S]{0,120}44px/);
  assert.match(css, /\.slx-affection-editor-footer[\s\S]{0,200}flex-direction:\s*column/);
  assert.match(css, /\.slx-affection-settings-controls\b/);
  assert.match(css, /\.slx-affection-detail-hero\b/);
  assert.match(css, /\.slx-affection-record-list\s+li\b/);
  assert.match(css, /\.slx-affection-stage-toggle\b/);
  assert.match(
    css,
    /\.slx-affection-root\s+input[\s\S]{0,200}font-size:\s*16px/,
  );

  // 开发诊断与旧自动建档 selector 不得回潮
  assert.doesNotMatch(css, /\.slx-affection-test-/);
  assert.doesNotMatch(css, /\.slx-affection-diagnostics/);
  assert.doesNotMatch(css, /\.slx-affection-pending-row\.is-first/);
  assert.doesNotMatch(css, /\.slx-affection-initial-form/);
  assert.doesNotMatch(css, /\.slx-affection-build-state/);
  assert.doesNotMatch(css, /\.slx-affection-pending-actions/);

  // 正式 pending「放弃此项」按钮：移动端 44px 触控高度
  assert.match(
    css,
    /\.slx-affection-pending-row\s*>\s*\.slx-affection-text-action[\s\S]{0,160}min-height:\s*44px/,
  );
});
