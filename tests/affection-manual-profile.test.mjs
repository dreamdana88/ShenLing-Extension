import assert from 'node:assert/strict';
import test from 'node:test';

import { MODULE_NAME } from '../src/constants.js';
import {
  commitManualAffectionProfileDraft,
  createManualGenericAffectionProfile,
  generateManualAffectionProfileDraft,
  MANUAL_AFFECTION_PROFILE_DRAFT_TYPE,
  MANUAL_USER_REQUIREMENT_MAX_LENGTH,
  resolveManualAffectionProfileContext,
} from '../src/features/affection/manual-profile.js';
import {
  AFFECTION_TRANSPORT_POLICY,
} from '../src/features/affection/generation.js';
import { AFFECTION_STAGE_RANGES } from '../src/features/affection/model.js';
import { configureAffectionWorkflow } from '../src/features/affection/runtime.js';
import { buildAffectionProfilePrompt } from '../src/prompts.js';

function createValidStages(overrides = {}) {
  return AFFECTION_STAGE_RANGES.map((range, index) => ({
    ...range,
    name: overrides.name || `阶段${index + 1}`,
    meaning: `含义${index + 1}`,
    trend: `趋势${index + 1}`,
    boundary: `边界${index + 1}`,
    behaviors: [`行为A${index + 1}`, `行为B${index + 1}`, `行为C${index + 1}`],
    ...(overrides.range !== undefined ? { range: overrides.range } : { range: '99-99' }),
  }));
}

function createValidStagesJson(extra = {}) {
  return JSON.stringify({ stages: createValidStages(extra) });
}

function createSettings(overrides = {}) {
  return {
    enabled: true,
    modules: {
      summary: { enabled: true },
      affection: {
        enabled: true,
        mode: 'normal',
        defaultBuildMode: 'custom',
        profileBuildApiMode: 'secondary_api',
        ...overrides.affection,
      },
    },
    ...overrides.settingsRoot,
  };
}

function createChatState(profiles = {}) {
  return {
    affectionSystem: {
      profiles: { ...profiles },
      pendingByMessage: {},
    },
  };
}

function createContextPayload({
  roleName = '沈青',
  worldInfoEntries = [],
  materialParts = {},
} = {}) {
  const characterCard = materialParts.characterCard || '角色卡：沈青是冷静的术士。';
  const userPersona = materialParts.userPersona || 'Persona：谨慎的旅人。';
  const worldInfoText = materialParts.worldInfo
    || (worldInfoEntries.length
      ? worldInfoEntries.map(item => item.content).join('\n')
      : '');
  const memories = materialParts.memories || 'memory：初次见面。';
  const recentChat = materialParts.recentChat || '最近剧情：雨夜交谈。';
  const emotion = materialParts.emotion || '情感档案：沈青保持戒备。';

  return {
    purpose: 'affectionManualProfile',
    targetRoleName: roleName,
    characterCard: { description: characterCard },
    userPersona: { description: userPersona },
    recentMessages: [{ messageId: 1, content: recentChat }],
    recentChat,
    memories: [{ messageId: 0, content: memories }],
    grandMemories: [{ messageId: -1, content: 'grand：更早的往事。' }],
    emotionProfiles: [{ roleName, content: emotion }],
    worldInfo: {
      entries: worldInfoEntries,
      worldInfoBefore: worldInfoEntries.map(item => item.content).join('\n'),
      worldInfoAfter: '',
      injectionText: worldInfoEntries.map(item => item.content).join('\n'),
      diagnostics: {
        source: 'dry_run',
        mode: 'dry_run',
        materialSource: worldInfoEntries.length ? 'injection' : 'none',
        usedCount: worldInfoEntries.length,
        activatedCount: worldInfoEntries.length,
        targetRoleInjected: true,
      },
    },
    activatedWorldInfo: worldInfoEntries,
    worldInfoBefore: worldInfoEntries.map(item => item.content).join('\n'),
    worldInfoAfter: '',
    worldInfoInjectionText: worldInfoEntries.map(item => item.content).join('\n'),
    diagnostics: {
      recentMessageCount: 1,
      memoryCount: 1,
      grandMemoryCount: 1,
      emotionProfileCount: 1,
      worldInfo: {
        source: 'dry_run',
        mode: 'dry_run',
        materialSource: worldInfoEntries.length ? 'injection' : 'none',
        usedCount: worldInfoEntries.length,
        activatedCount: worldInfoEntries.length,
        targetRoleInjected: true,
      },
    },
  };
}

async function withAffectionLogHarness(run) {
  const logs = [];
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    performance: globalThis.performance,
  };

  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'chat-manual-a',
      chat: [],
      extensionSettings: { [MODULE_NAME]: createSettings() },
    }),
  };
  if (!globalThis.performance?.now) {
    globalThis.performance = { now: () => Date.now() };
  }

  configureAffectionWorkflow({
    addCommunicationLog: entry => logs.push(entry),
    getActiveApiProfile: () => ({
      name: 'test-secondary',
      model: 'test-model',
      baseUrl: 'https://example.invalid',
    }),
    refreshPanel: () => {},
  });

  try {
    return await run({ logs });
  } finally {
    configureAffectionWorkflow({
      addCommunicationLog: null,
      getActiveApiProfile: null,
      refreshPanel: null,
    });
    globalThis.SillyTavern = previous.SillyTavern;
    globalThis.performance = previous.performance;
  }
}

// ---------------------------------------------------------------------------
// 17.1 输入校验
// ---------------------------------------------------------------------------

test('manual input: empty role name is rejected', async () => {
  await assert.rejects(
    () => createManualGenericAffectionProfile({ roleName: '  ', initialValueTenths: 100 }),
    /角色名不能为空/,
  );
});

test('manual input: invalid initial value is rejected without auto-clamp', async () => {
  await assert.rejects(
    () => createManualGenericAffectionProfile({ roleName: '沈青', initialValueTenths: null }),
    /初始好感必须是 0—100/,
  );
  await assert.rejects(
    () => createManualGenericAffectionProfile({ roleName: '沈青', initialValueTenths: 1001 }),
    /初始好感必须是 0—100/,
  );
  await assert.rejects(
    () => createManualGenericAffectionProfile({ roleName: '沈青', initialValueTenths: 35.12 }),
    /初始好感必须是 0—100/,
  );
  await assert.rejects(
    () => createManualGenericAffectionProfile({ roleName: '沈青', initialValueTenths: -1 }),
    /初始好感必须是 0—100/,
  );
});

test('manual input: userRequirement over 2000 chars is rejected without truncation', async () => {
  const chatState = createChatState();
  const longText = '测'.repeat(MANUAL_USER_REQUIREMENT_MAX_LENGTH + 1);
  await assert.rejects(
    () => generateManualAffectionProfileDraft({
      roleName: '沈青',
      initialValueTenths: 350,
      userRequirement: longText,
    }, {
      chatState,
      resolveContext: async () => ({ roleName: '沈青', material: 'x', diagnostics: {} }),
      requestCustomProfile: async () => createValidStagesJson(),
      log: false,
    }),
    /不能超过 2000/,
  );
  assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);
});

test('manual input: duplicate formal profile is rejected', async () => {
  const chatState = createChatState({
    沈青: {
      roleName: '沈青',
      initialValueTenths: 100,
      valueTenths: 100,
      stages: createValidStages(),
      records: [],
    },
  });
  await assert.rejects(
    () => createManualGenericAffectionProfile({ roleName: ' 沈 青 ', initialValueTenths: 200 }, { chatState, persist: false }),
    /已经存在好感档案/,
  );
});

// ---------------------------------------------------------------------------
// 17.2 通用建档
// ---------------------------------------------------------------------------

test('manual generic profile creates formal archive with zero API and zero world info', async () => {
  const chatState = createChatState();
  let apiCalls = 0;
  let worldInfoCalls = 0;
  let saved = 0;
  let injected = 0;
  let refreshed = 0;

  // Intercept would-be API / WI via injected deps staying unused.
  const profile = await createManualGenericAffectionProfile({
    roleName: ' 沈\n  青 ',
    initialValueTenths: 350,
  }, {
    settings: createSettings(),
    chatState,
    persist: true,
    syncInjection: async () => {
      injected += 1;
    },
    refreshPanel: () => {
      refreshed += 1;
    },
  });

  // Force-save path uses markAffectionStoreUpdated → saveChatState; we only assert store side effects.
  assert.equal(apiCalls, 0);
  assert.equal(worldInfoCalls, 0);
  assert.equal(profile.roleName, '沈青');
  assert.equal(profile.buildMode, 'generic');
  assert.equal(profile.buildStatus, 'ready');
  assert.equal(profile.sourceType, 'manual');
  assert.equal(profile.sourceMessageId, null);
  assert.equal(profile.sourceFingerprint, '');
  assert.equal(profile.stageDesignRequirement, '');
  assert.equal(profile.initialValueTenths, 350);
  assert.equal(profile.valueTenths, 350);
  assert.deepEqual(profile.records, []);
  assert.equal(profile.stages.length, 5);
  assert.equal(profile.stages[0].stageId, 'S1');
  assert.equal(profile.stages[0].minTenths, 0);
  assert.equal(profile.stages[0].maxTenths, 200);
  assert.equal(profile.stages[4].stageId, 'S5');
  assert.equal(chatState.affectionSystem.profiles.沈青, profile);
  assert.ok(chatState.affectionSystem.lastUpdatedAt);
  assert.equal(injected, 1);
  assert.equal(refreshed, 1);
  assert.equal(Object.hasOwn(chatState.affectionSystem, 'buildTasks'), false);
  assert.equal(Object.keys(chatState.affectionSystem.pendingByMessage || {}).length, 0);
  void saved;
});

// ---------------------------------------------------------------------------
// 17.3 专属上下文
// ---------------------------------------------------------------------------

test('manual context resolver passes dry_run + all worldInfo and keeps mixed entries', async () => {
  const calls = [];
  const worldInfoEntries = [
    { title: '世界观蓝灯', content: '蓝灯：帝国历史。', comment: 'world' },
    { title: '沈青绿灯', content: '绿灯：沈青幼年。', comment: 'npc' },
    { title: '其他剧情触发', content: '其他：暴雨之夜。', comment: 'plot' },
  ];

  const result = await resolveManualAffectionProfileContext('沈青', {
    resolveContext: async options => {
      calls.push(options);
      return createContextPayload({ roleName: '沈青', worldInfoEntries });
    },
    formatContext: (context, options) => {
      assert.equal(options.includeWorldInfo, true);
      assert.equal(options.includeCharacterCard, true);
      assert.equal(options.includeUserPersona, true);
      assert.equal(options.includeTimelineArchives, true);
      assert.equal(options.includeRecentChat, true);
      assert.equal(options.includeEmotionProfiles, true);
      assert.equal(options.worldInfoMaterialMode, 'injection_first');
      return [
        context.characterCard.description,
        context.userPersona.description,
        context.worldInfo.injectionText,
        context.memories[0].content,
        context.recentChat,
        context.emotionProfiles[0].content,
      ].join('\n');
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'affectionManualProfile');
  assert.equal(calls[0].targetRoleName, '沈青');
  assert.equal(calls[0].worldInfoMode, 'dry_run');
  assert.equal(calls[0].worldInfoLimit, 'all');
  assert.equal(calls[0].includeWorldInfo, true);
  assert.equal(calls[0].includeAllEmotionProfiles, false);
  assert.equal(calls[0].includeEmotionProfile, true);
  assert.equal(calls[0].recentMessageLimit, 8);

  assert.match(result.material, /蓝灯：帝国历史/);
  assert.match(result.material, /绿灯：沈青幼年/);
  assert.match(result.material, /其他：暴雨之夜/);
  assert.match(result.material, /角色卡：沈青是冷静的术士/);
  assert.match(result.material, /Persona：谨慎的旅人/);
  assert.match(result.material, /最近剧情：雨夜交谈/);
  assert.match(result.material, /memory：初次见面/);
  assert.match(result.material, /情感档案：沈青保持戒备/);
  assert.equal(result.diagnostics.worldInfo.usedCount, 3);
  assert.equal(result.diagnostics.worldInfo.targetRoleInjected, true);
});

test('manual context succeeds when world info is empty', async () => {
  const result = await resolveManualAffectionProfileContext('沈青', {
    resolveContext: async () => createContextPayload({ roleName: '沈青', worldInfoEntries: [] }),
    formatContext: context => [
      context.characterCard.description,
      context.userPersona.description,
      context.recentChat,
    ].join('\n'),
  });
  assert.equal(result.roleName, '沈青');
  assert.match(result.material, /角色卡/);
  assert.equal(result.diagnostics.worldInfo.usedCount, 0);
});

// ---------------------------------------------------------------------------
// 17.4 专属草稿生成
// ---------------------------------------------------------------------------

test('manual custom draft uses configured transport, keeps store untouched, and logs success', async () => {
  await withAffectionLogHarness(async ({ logs }) => {
    const chatState = createChatState();
    const profilesSnapshot = JSON.stringify(chatState.affectionSystem.profiles);
    const pendingSnapshot = JSON.stringify(chatState.affectionSystem.pendingByMessage);
    let persistCalls = 0;
    let injectCalls = 0;
    const captured = {
      transportPolicy: null,
      messages: null,
      task: null,
    };

    const draft = await generateManualAffectionProfileDraft({
      roleName: '沈青',
      initialValueTenths: 420,
      userRequirement: '慢热且克制',
      apiMode: 'main_api',
    }, {
      settings: createSettings({ affection: { profileBuildApiMode: 'secondary_api' } }),
      chatState,
      chatId: 'chat-manual-a',
      resolveContext: async roleName => ({
        roleName,
        material: '完整参考资料：蓝灯世界观 + 绿灯沈青 + Persona',
        diagnostics: {
          recentMessageCount: 2,
          memoryCount: 1,
          grandMemoryCount: 1,
          emotionProfileCount: 1,
          worldInfo: {
            source: 'dry_run',
            materialSource: 'injection',
            usedCount: 2,
            activatedCount: 2,
            targetRoleInjected: true,
          },
        },
      }),
      requestCustomProfile: async ({ task, messages, transportPolicy }) => {
        captured.transportPolicy = transportPolicy;
        captured.messages = messages;
        captured.task = task;
        return {
          rawContent: createValidStagesJson(),
          requestBody: { from: 'mock-api' },
          transportPlan: {
            requestedMode: 'stream',
            actualMode: 'stream',
            fallbackReason: null,
            apiMode: 'main_api',
          },
          profileName: '酒馆当前连接',
          model: 'main-model',
          url: '酒馆当前连接',
          httpStatus: 200,
          responseText: createValidStagesJson(),
        };
      },
      log: true,
    });

    assert.equal(captured.transportPolicy, AFFECTION_TRANSPORT_POLICY.CONFIGURED);
    assert.equal(captured.task.operation, 'manual_create');
    assert.equal(captured.task.apiMode, 'main_api');
    assert.equal(captured.task.userRequirement, '慢热且克制');
    const joined = captured.messages.map(item => item.content).join('\n');
    assert.match(joined, /慢热且克制/);
    assert.match(joined, /完整参考资料：蓝灯世界观/);
    assert.match(joined, /独立的好感度档案设计任务/);
    assert.match(joined, /以下是可参考资料/);
    assert.match(joined, /再次确认/);
    assert.doesNotMatch(joined, /由同一次小总结确定/);

    assert.equal(draft.draftType, MANUAL_AFFECTION_PROFILE_DRAFT_TYPE);
    assert.equal(draft.chatId, 'chat-manual-a');
    assert.equal(draft.roleName, '沈青');
    assert.equal(draft.initialValueTenths, 420);
    assert.equal(draft.buildMode, 'custom');
    assert.equal(draft.apiMode, 'main_api');
    assert.equal(draft.userRequirement, '慢热且克制');
    assert.equal(draft.stages.length, 5);
    assert.equal(draft.stages[0].minTenths, 0);
    assert.equal(draft.stages[0].maxTenths, 200);
    assert.equal(draft.contextDiagnostics.worldInfo.usedCount, 2);

    assert.equal(JSON.stringify(chatState.affectionSystem.profiles), profilesSnapshot);
    assert.equal(JSON.stringify(chatState.affectionSystem.pendingByMessage), pendingSnapshot);
    assert.equal(Object.hasOwn(chatState.affectionSystem, 'buildTasks'), false);
    assert.equal(persistCalls, 0);
    assert.equal(injectCalls, 0);

    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'success');
    assert.equal(logs[0].taskType, '手动创建专属阶段');
    assert.ok(logs[0].messages?.length);
    assert.ok(logs[0].requestBody);
    assert.ok(Object.hasOwn(logs[0], 'rawResultContent'));
    assert.ok(Object.hasOwn(logs[0], 'parsedResult'));
    assert.ok(Object.hasOwn(logs[0], 'transport'));
  });
});

test('manual custom draft failure logs fully and leaves no half-written profile', async () => {
  await withAffectionLogHarness(async ({ logs }) => {
    const chatState = createChatState();
    await assert.rejects(
      () => generateManualAffectionProfileDraft({
        roleName: '沈青',
        initialValueTenths: 100,
      }, {
        chatState,
        chatId: 'chat-manual-a',
        resolveContext: async () => ({ roleName: '沈青', material: '资料', diagnostics: {} }),
        requestCustomProfile: async () => ({
          rawContent: '{not-json',
          transportPlan: {
            requestedMode: 'legacy',
            actualMode: 'legacy',
            fallbackReason: null,
            apiMode: 'secondary_api',
          },
        }),
        log: true,
      }),
      /合法 JSON|专属阶段表/,
    );
    assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].taskType, '手动创建专属阶段');
    assert.equal(logs[0].requestBody.operation, 'manual_create');
    assert.equal(logs[0].requestBody.roleName, '沈青');
    assert.equal(logs[0].requestBody.initialValueTenths, 100);
    assert.equal(logs[0].requestBody.buildMode, 'custom');
    assert.ok(Object.hasOwn(logs[0].requestBody, 'userRequirement'));
    assert.ok(logs[0].errorStack);
  });
});

test('manual custom draft context failure logs fallback and keeps store untouched', async () => {
  await withAffectionLogHarness(async ({ logs }) => {
    const chatState = createChatState();
    const profilesSnapshot = JSON.stringify(chatState.affectionSystem.profiles);
    const pendingSnapshot = JSON.stringify(chatState.affectionSystem.pendingByMessage);
    let apiCalls = 0;

    await assert.rejects(
      () => generateManualAffectionProfileDraft({
        roleName: '沈青',
        initialValueTenths: 350,
        userRequirement: '慢热且克制',
        apiMode: 'main_api',
      }, {
        settings: createSettings({ affection: { profileBuildApiMode: 'secondary_api' } }),
        chatState,
        chatId: 'chat-manual-a',
        resolveContext: async () => {
          throw new Error('manual context probe failed');
        },
        requestCustomProfile: async () => {
          apiCalls += 1;
          return createValidStagesJson();
        },
        log: true,
      }),
      /manual context probe failed/,
    );

    assert.equal(JSON.stringify(chatState.affectionSystem.profiles), profilesSnapshot);
    assert.equal(JSON.stringify(chatState.affectionSystem.pendingByMessage), pendingSnapshot);
    assert.equal(Object.hasOwn(chatState.affectionSystem, 'buildTasks'), false);
    assert.equal(apiCalls, 0);

    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'failure');
    assert.equal(logs[0].taskType, '手动创建专属阶段');
    assert.ok(logs[0].requestBody?.buildRequestId);
    assert.equal(logs[0].requestBody.chatId, 'chat-manual-a');
    assert.equal(logs[0].requestBody.roleName, '沈青');
    assert.equal(logs[0].requestBody.initialValueTenths, 350);
    assert.equal(logs[0].requestBody.buildMode, 'custom');
    assert.equal(logs[0].requestBody.apiMode, 'main_api');
    assert.equal(logs[0].requestBody.operation, 'manual_create');
    assert.equal(logs[0].requestBody.userRequirement, '慢热且克制');
    assert.ok(logs[0].errorStack);
    assert.match(String(logs[0].errorStack), /manual context probe failed/);
    assert.ok(!logs[0].messages || logs[0].messages.length === 0);
    assert.equal(logs.some(entry => entry.status === 'success'), false);
  });
});

test('manual custom draft rejects incomplete five stages without writing profile', async () => {
  const chatState = createChatState();
  await assert.rejects(
    () => generateManualAffectionProfileDraft({
      roleName: '沈青',
      initialValueTenths: 200,
    }, {
      chatState,
      chatId: 'chat-a',
      resolveContext: async () => ({ roleName: '沈青', material: '资料', diagnostics: {} }),
      requestCustomProfile: async () => JSON.stringify({
        stages: createValidStages().slice(0, 4),
      }),
      log: false,
    }),
    /五个阶段/,
  );
  assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);
});

// ---------------------------------------------------------------------------
// 17.5 专属草稿确认
// ---------------------------------------------------------------------------

function createMemoryDraft(overrides = {}) {
  return {
    draftType: MANUAL_AFFECTION_PROFILE_DRAFT_TYPE,
    buildRequestId: 'affection-build-test',
    chatId: 'chat-manual-a',
    roleName: '沈青',
    initialValueTenths: 350,
    buildMode: 'custom',
    apiMode: 'secondary_api',
    userRequirement: '慢热',
    stages: createValidStages(),
    contextDiagnostics: {},
    createdAt: '2026/8/6 12:00:00',
    ...overrides,
  };
}

test('manual draft commit writes formal profile and syncs injection', async () => {
  const chatState = createChatState();
  let injected = 0;
  let refreshed = 0;
  const draft = createMemoryDraft();

  const profile = await commitManualAffectionProfileDraft({
    draft,
    roleName: '沈青',
    initialValueTenths: 350,
    userRequirement: '慢热',
  }, {
    chatState,
    chatId: 'chat-manual-a',
    persist: true,
    syncInjection: async () => {
      injected += 1;
    },
    refreshPanel: () => {
      refreshed += 1;
    },
  });

  assert.equal(profile.roleName, '沈青');
  assert.equal(profile.buildMode, 'custom');
  assert.equal(profile.buildStatus, 'ready');
  assert.equal(profile.sourceType, 'manual');
  assert.equal(profile.stageDesignRequirement, '慢热');
  assert.equal(profile.initialValueTenths, 350);
  assert.equal(profile.valueTenths, 350);
  assert.deepEqual(profile.records, []);
  assert.equal(profile.sourceMessageId, null);
  assert.equal(profile.sourceFingerprint, '');
  assert.equal(profile.stages.length, 5);
  assert.equal(profile.stages[1].minTenths, 201);
  assert.equal(chatState.affectionSystem.profiles.沈青.stageDesignRequirement, '慢热');
  assert.equal(injected, 1);
  assert.equal(refreshed, 1);
});

test('manual draft commit rejects chat switch / input drift / duplicate / bad draft', async () => {
  const baseDraft = createMemoryDraft();

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: baseDraft,
      roleName: '沈青',
      initialValueTenths: 350,
      userRequirement: '慢热',
    }, { chatState: createChatState(), chatId: 'chat-other', persist: false }),
    /聊天已切换/,
  );

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: baseDraft,
      roleName: '沈青改',
      initialValueTenths: 350,
      userRequirement: '慢热',
    }, { chatState: createChatState(), chatId: 'chat-manual-a', persist: false }),
    /建档输入已变化/,
  );

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: baseDraft,
      roleName: '沈青',
      initialValueTenths: 400,
      userRequirement: '慢热',
    }, { chatState: createChatState(), chatId: 'chat-manual-a', persist: false }),
    /建档输入已变化/,
  );

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: baseDraft,
      roleName: '沈青',
      initialValueTenths: 350,
      userRequirement: '急切',
    }, { chatState: createChatState(), chatId: 'chat-manual-a', persist: false }),
    /建档输入已变化/,
  );

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: baseDraft,
      roleName: '沈青',
      initialValueTenths: 350,
      userRequirement: '慢热',
    }, {
      chatState: createChatState({
        沈青: {
          roleName: '沈青',
          initialValueTenths: 10,
          valueTenths: 10,
          stages: createValidStages(),
          records: [],
        },
      }),
      chatId: 'chat-manual-a',
      persist: false,
    }),
    /已经存在好感档案/,
  );

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: createMemoryDraft({
        stages: createValidStages().map((stage, index) => (
          index === 0 ? { ...stage, behaviors: ['只有一条'] } : stage
        )),
      }),
      roleName: '沈青',
      initialValueTenths: 350,
      userRequirement: '慢热',
    }, { chatState: createChatState(), chatId: 'chat-manual-a', persist: false }),
    /阶段草稿已经失效/,
  );

  await assert.rejects(
    () => commitManualAffectionProfileDraft({
      draft: createMemoryDraft({ draftType: 'wrong' }),
      roleName: '沈青',
      initialValueTenths: 350,
      userRequirement: '慢热',
    }, { chatState: createChatState(), chatId: 'chat-manual-a', persist: false }),
    /阶段草稿已经失效/,
  );

  // All rejections leave empty store when starting empty
  const empty = createChatState();
  try {
    await commitManualAffectionProfileDraft({
      draft: baseDraft,
      roleName: '沈青',
      initialValueTenths: 999,
      userRequirement: '慢热',
    }, { chatState: empty, chatId: 'chat-manual-a', persist: false });
  } catch {
    // expected
  }
  assert.equal(Object.keys(empty.affectionSystem.profiles).length, 0);
});

// ---------------------------------------------------------------------------
// 17.6 Prompt
// ---------------------------------------------------------------------------

test('affection profile prompt uses sandwich structure with recall and source-neutral initial value', () => {
  const withRequirement = buildAffectionProfilePrompt({
    roleName: '沈青',
    initialAffection: '35.0',
    userRequirement: '慢热克制',
    contextMaterial: '角色卡与世界书材料',
  });
  const withoutRequirement = buildAffectionProfilePrompt({
    roleName: '沈青',
    initialAffection: '35.0',
    userRequirement: '',
    contextMaterial: '角色卡与世界书材料',
  });

  assert.match(withRequirement, /独立的好感度档案设计任务/);
  assert.match(withRequirement, /目标角色「沈青」/);
  assert.match(withRequirement, /本次建档指定的正式初始好感为 35\.0/);
  assert.match(withRequirement, /不得重新估算、修改或覆盖该初始值/);
  assert.match(withRequirement, /【用户阶段设计构思｜优先参考】/);
  assert.match(withRequirement, /慢热克制/);
  assert.match(withRequirement, /以下是可参考资料：/);
  assert.match(withRequirement, /角色卡与世界书材料/);
  assert.match(withRequirement, /再次确认：/);
  assert.match(withRequirement, /只输出符合固定结构的合法 JSON/);
  assert.doesNotMatch(withRequirement, /由同一次小总结确定/);

  const requirementIndex = withRequirement.indexOf('【用户阶段设计构思｜优先参考】');
  const materialIndex = withRequirement.indexOf('以下是可参考资料：');
  const recallIndex = withRequirement.indexOf('再次确认：');
  assert.ok(requirementIndex > 0 && materialIndex > requirementIndex && recallIndex > materialIndex);

  assert.doesNotMatch(withoutRequirement, /【用户阶段设计构思｜优先参考】/);
  assert.match(withoutRequirement, /以下是可参考资料：/);
  assert.match(withoutRequirement, /再次确认：/);
});
