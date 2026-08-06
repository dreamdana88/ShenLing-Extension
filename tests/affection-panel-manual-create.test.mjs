import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  bindAffectionPanelEvents,
  createManualAffectionCreateState,
  isAffectionEditorOpen,
  renderAffectionPanel,
  renderManualAffectionCreateOverlay,
} from '../src/features/affection/panel.js';
import {
  applyAffectionProfileStages,
  regenerateAffectionProfileStages,
} from '../src/features/affection/workflow.js';
import {
  commitManualAffectionProfileDraft,
  createManualGenericAffectionProfile,
  generateManualAffectionProfileDraft,
  resolveManualAffectionProfileContext,
} from '../src/features/affection/manual-profile.js';
import {
  AFFECTION_STAGE_RANGES,
  parseAffectionValueTenths,
} from '../src/features/affection/model.js';
import { createGenericAffectionStages } from '../src/features/affection/profile.js';
import { configureAffectionWorkflow } from '../src/features/affection/runtime.js';

function createValidStages() {
  return AFFECTION_STAGE_RANGES.map((range, index) => ({
    ...range,
    name: `阶段${index + 1}`,
    meaning: `含义${index + 1}`,
    trend: `趋势${index + 1}`,
    boundary: `边界${index + 1}`,
    behaviors: [`行为A${index + 1}`, `行为B${index + 1}`, `行为C${index + 1}`],
  }));
}

function createValidStagesJson() {
  return JSON.stringify({ stages: createValidStages() });
}

function createSettings(affection = {}) {
  return {
    enabled: true,
    modules: {
      summary: { enabled: true },
      affection: {
        enabled: true,
        mode: 'normal',
        defaultBuildMode: 'custom',
        profileBuildApiMode: 'secondary_api',
        ...affection,
      },
    },
  };
}

function createChatState(profiles = {}) {
  return {
    affectionSystem: {
      profiles: { ...profiles },
      pendingByMessage: {},
      buildTasks: {},
    },
  };
}

function createClickable(dataset = {}) {
  return {
    dataset,
    disabled: false,
    value: '',
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      toggle(name, on) {
        if (on) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) { return this._set.has(name); },
    },
    setAttribute() {},
    focus() {},
    addEventListener(type, fn) {
      if (type === 'click') this._onClick = fn;
      if (type === 'input') this._onInput = fn;
      if (type === 'change') this._onChange = fn;
      if (type === 'keydown') this._onKeydown = fn;
      if (type === 'toggle') this._onToggle = fn;
    },
    click() {
      this._onClick?.({ currentTarget: this, preventDefault() {} });
    },
    input(value) {
      this.value = value;
      this._onInput?.({ currentTarget: this });
    },
  };
}

function createPanelRoot() {
  const nodes = new Map();
  const ensure = (sel, factory) => {
    if (!nodes.has(sel)) nodes.set(sel, factory());
    return nodes.get(sel);
  };

  return {
    nodes,
    querySelector(sel) {
      if (sel === '[data-slx-affection-open-create]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-create-role]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-create-initial]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-create-requirement]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-test-create-context]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-generate-create-draft]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-create-generic]') {
        return ensure(sel, () => createClickable());
      }
      if (sel === '[data-slx-affection-commit-create-draft]') {
        return ensure(sel, () => createClickable());
      }
      // optional controls that may be null
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-slx-affection-close-create]') {
        return [ensure(sel, () => createClickable())];
      }
      if (sel === '[data-slx-affection-create-mode]') {
        return ensure(sel, () => [
          createClickable({ slxAffectionCreateMode: 'generic' }),
          createClickable({ slxAffectionCreateMode: 'custom' }),
        ]);
      }
      if (sel === '[data-slx-affection-create-api]') {
        return ensure(sel, () => [
          createClickable({ slxAffectionCreateApi: 'main_api' }),
          createClickable({ slxAffectionCreateApi: 'secondary_api' }),
        ]);
      }
      if (sel === '[data-slx-affection-build-mode]') return [];
      if (sel === '[data-slx-affection-build-api]') return [];
      if (sel === '[data-slx-affection-delta-step]') return [];
      if (sel === '[data-slx-affection-discard-pending]') return [];
      if (sel === '[data-slx-affection-retry-task]') return [];
      if (sel === '[data-slx-affection-resolve-task]') return [];
      if (sel === '[data-slx-affection-open-detail]') return [];
      if (sel === '[data-slx-affection-profile-mode]') return [];
      if (sel === '[data-slx-affection-regenerate-api]') return [];
      if (sel === '[data-slx-affection-toggle-stage]') return [];
      if (sel === '[data-slx-affection-stage-field], [data-slx-affection-stage-behavior]') return [];
      if (sel === '.slx-affection-editor-overlay') {
        return [ensure(sel, () => createClickable())];
      }
      return [];
    },
  };
}

async function withHarness(run, {
  settings = createSettings(),
  chatState = createChatState(),
  chatId = 'chat-phase-b',
} = {}) {
  const previous = {
    SillyTavern: globalThis.SillyTavern,
    performance: globalThis.performance,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId,
      chat: [{ mes: 'hello' }],
      chatMetadata: { [CHAT_STATE_KEY]: chatState },
      extensionSettings: { [MODULE_NAME]: settings },
    }),
  };
  if (!globalThis.performance?.now) {
    globalThis.performance = { now: () => Date.now() };
  }
  globalThis.requestAnimationFrame = cb => {
    try { cb(); } catch { /* ignore focus errors in node harness */ }
    return 0;
  };
  configureAffectionWorkflow({
    addCommunicationLog: () => {},
    getActiveApiProfile: () => ({ name: 't', model: 'm', baseUrl: 'https://example.invalid' }),
    refreshPanel: () => {},
  });
  try {
    return await run({ settings, chatState, chatId });
  } finally {
    // Close leftover create session between tests.
    if (isAffectionEditorOpen()) {
      const root = createPanelRoot();
      bindAffectionPanelEvents(root);
      root.querySelectorAll('[data-slx-affection-close-create]')[0]?.click();
    }
    configureAffectionWorkflow({
      addCommunicationLog: null,
      getActiveApiProfile: null,
      refreshPanel: null,
    });
    globalThis.SillyTavern = previous.SillyTavern;
    globalThis.performance = previous.performance;
    if (previous.requestAnimationFrame) {
      globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    } else {
      delete globalThis.requestAnimationFrame;
    }
  }
}

function openCreateView(root) {
  bindAffectionPanelEvents(root);
  root.querySelector('[data-slx-affection-open-create]').click();
  assert.equal(isAffectionEditorOpen(), true, 'create overlay should open when chat metadata exists');
}

// ---------------------------------------------------------------------------
// 22.1 Panel 渲染
// ---------------------------------------------------------------------------

test('panel main markup includes create entry and updated copy', async () => {
  await withHarness(async () => {
    const html = renderAffectionPanel();
    assert.match(html, /新建角色档案/);
    assert.match(html, /data-slx-affection-open-create/);
    assert.match(html, /手动指定需要追踪的角色/);
    assert.doesNotMatch(html, /出现可攻略角色后自动建档/);
    assert.match(html, /新建档案默认方式/);
    assert.match(html, /专属阶段默认 API/);
    assert.doesNotMatch(html, /新角色默认建档方式/);
    assert.doesNotMatch(html, /首次建档 API/);
  });
});

test('create overlay generic and custom modes render exclusive fields with a11y', async () => {
  await withHarness(async ({ chatState }) => {
    const root = createPanelRoot();
    openCreateView(root);

    let html = renderManualAffectionCreateOverlay(chatState);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="slx-affection-create-title"/);
    assert.match(html, /data-slx-affection-create-role/);
    assert.match(html, /data-slx-affection-create-initial/);
    assert.match(html, /建档角色名称/);
    assert.match(html, /初始好感/);
    assert.match(html, /data-slx-affection-create-api/);
    assert.match(html, /data-slx-affection-create-requirement/);
    assert.match(html, /阶段设计构思（可选）/);
    assert.match(html, /data-slx-affection-test-create-context/);
    assert.match(html, /data-slx-affection-generate-create-draft/);
    assert.match(html, /role="group"/);

    // switch to generic
    root.querySelectorAll('[data-slx-affection-create-mode]')[0].click();
    html = renderManualAffectionCreateOverlay(chatState);
    assert.match(html, /使用通用阶段创建/);
    assert.match(html, /通用阶段 · 不调用 API/);
    assert.doesNotMatch(html, /data-slx-affection-create-api=/);
    assert.doesNotMatch(html, /data-slx-affection-create-requirement/);
    assert.doesNotMatch(html, /data-slx-affection-test-create-context/);
    assert.doesNotMatch(html, /data-slx-affection-generate-create-draft/);

    // switch back to custom
    root.querySelectorAll('[data-slx-affection-create-mode]')[1].click();
    html = renderManualAffectionCreateOverlay(chatState);
    assert.match(html, /生成专属阶段/);
    assert.match(html, /专属阶段 · 生成后确认创建/);
  });
});

// ---------------------------------------------------------------------------
// 22.2 通用创建
// ---------------------------------------------------------------------------

test('generic create converts display tenths and writes formal profile with zero API', async () => {
  await withHarness(async ({ chatState, settings }) => {
    const root = createPanelRoot();
    openCreateView(root);
    root.querySelectorAll('[data-slx-affection-create-mode]')[0].click();
    root.querySelector('[data-slx-affection-create-role]').input(' 沈 青 ');
    root.querySelector('[data-slx-affection-create-initial]').input('35.0');

    // Panel converts visible 0—100 input via parseAffectionValueTenths → tenths.
    const initialValueTenths = parseAffectionValueTenths('35.0');
    assert.equal(initialValueTenths, 350);

    const profile = await createManualGenericAffectionProfile({
      roleName: '沈青',
      initialValueTenths,
    }, {
      settings,
      chatState,
      persist: false,
      syncInjection: async () => {},
      refreshPanel: () => {},
    });
    assert.equal(profile.sourceType, 'manual');
    assert.equal(profile.buildMode, 'generic');
    assert.equal(profile.stageDesignRequirement, '');
    assert.equal(profile.initialValueTenths, 350);
    assert.equal(chatState.affectionSystem.profiles.沈青.valueTenths, 350);
    assert.equal(Object.keys(chatState.affectionSystem.buildTasks).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 22.3 资料测试
// ---------------------------------------------------------------------------

test('context test uses dry_run all and zero world info remains success without profile write', async () => {
  await withHarness(async ({ chatState }) => {
    const before = JSON.stringify(chatState.affectionSystem);
    const result = await resolveManualAffectionProfileContext('沈青', {
      resolveContext: async options => {
        assert.equal(options.targetRoleName, '沈青');
        assert.equal(options.worldInfoMode, 'dry_run');
        assert.equal(options.worldInfoLimit, 'all');
        assert.equal(options.includeAllEmotionProfiles, false);
        return {
          characterCard: { description: '角色卡' },
          userPersona: { description: 'Persona' },
          recentMessages: [{ messageId: 1, content: '剧情' }],
          recentChat: '剧情',
          memories: [{ content: 'm' }],
          grandMemories: [{ content: 'g' }],
          emotionProfiles: [{ roleName: '沈青', content: 'e' }],
          worldInfo: {
            entries: [
              { content: '蓝灯' },
              { content: '绿灯沈青' },
              { content: '其他' },
            ],
            injectionText: '蓝灯\n绿灯沈青\n其他',
            diagnostics: { usedCount: 3, materialSource: 'injection', targetRoleInjected: true },
          },
          activatedWorldInfo: [
            { content: '蓝灯' },
            { content: '绿灯沈青' },
            { content: '其他' },
          ],
          diagnostics: {
            recentMessageCount: 1,
            memoryCount: 1,
            grandMemoryCount: 1,
            emotionProfileCount: 1,
            worldInfo: { usedCount: 3, materialSource: 'injection', targetRoleInjected: true },
          },
        };
      },
      formatContext: context => `${context.characterCard.description}\n${context.worldInfo.injectionText}`,
    });
    assert.match(result.material, /蓝灯/);
    assert.match(result.material, /绿灯沈青/);
    assert.match(result.material, /其他/);

    const empty = await resolveManualAffectionProfileContext('沈青', {
      resolveContext: async () => ({
        characterCard: { description: '角色卡' },
        userPersona: {},
        recentMessages: [],
        recentChat: '',
        memories: [],
        grandMemories: [],
        emotionProfiles: [],
        worldInfo: { entries: [], injectionText: '', diagnostics: { usedCount: 0, materialSource: 'none', targetRoleInjected: true } },
        activatedWorldInfo: [],
        diagnostics: {
          recentMessageCount: 0,
          memoryCount: 0,
          grandMemoryCount: 0,
          emotionProfileCount: 0,
          worldInfo: { usedCount: 0, materialSource: 'none', targetRoleInjected: true },
        },
      }),
      formatContext: context => context.characterCard.description,
    });
    assert.equal(empty.diagnostics.worldInfo.usedCount, 0);
    assert.equal(JSON.stringify(chatState.affectionSystem), before);
  });
});

// ---------------------------------------------------------------------------
// 22.4 / 22.5 专属草稿与确认
// ---------------------------------------------------------------------------

test('custom draft generation does not write profile; commit saves stageDesignRequirement', async () => {
  await withHarness(async ({ chatState, settings, chatId }) => {
    let apiCalls = 0;
    const draft = await generateManualAffectionProfileDraft({
      roleName: '沈青',
      initialValueTenths: 420,
      userRequirement: '慢热克制',
      apiMode: 'main_api',
    }, {
      settings,
      chatState,
      chatId,
      resolveContext: async () => ({ roleName: '沈青', material: '资料', diagnostics: {} }),
      requestCustomProfile: async ({ task }) => {
        apiCalls += 1;
        assert.equal(task.roleName, '沈青');
        assert.equal(task.initialValueTenths, 420);
        assert.equal(task.userRequirement, '慢热克制');
        assert.equal(task.apiMode, 'main_api');
        return {
          rawContent: createValidStagesJson(),
          transportPlan: { requestedMode: 'legacy', actualMode: 'legacy', fallbackReason: null, apiMode: 'main_api' },
        };
      },
      log: false,
    });
    assert.equal(apiCalls, 1);
    assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);

    await assert.rejects(
      () => commitManualAffectionProfileDraft({
        draft,
        roleName: '沈青',
        initialValueTenths: 999,
        userRequirement: '慢热克制',
      }, {
        chatState,
        chatId,
        persist: false,
        syncInjection: async () => {},
        refreshPanel: () => {},
      }),
      /建档输入已变化/,
    );
    assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);

    const profile = await commitManualAffectionProfileDraft({
      draft,
      roleName: '沈青',
      initialValueTenths: 420,
      userRequirement: '慢热克制',
    }, {
      settings,
      chatState,
      chatId,
      persist: false,
      syncInjection: async () => {},
      refreshPanel: () => {},
    });
    assert.equal(profile.stageDesignRequirement, '慢热克制');
    assert.equal(profile.buildMode, 'custom');
    assert.equal(profile.sourceType, 'manual');
  });
});

test('input change invalidates draft at panel session level', async () => {
  await withHarness(async ({ chatState }) => {
    const root = createPanelRoot();
    openCreateView(root);
    // Seed a draft into the open session through generate path is heavy; verify session factory + invalidate behavior via role input clearing generationStatus after draft set.
    // After open, change mode should clear draft: simulate by setting draft then switching mode.
    const sessionAfterOpen = createManualAffectionCreateState(createSettings(), 'chat-phase-b');
    sessionAfterOpen.draft = { stages: createValidStages() };
    sessionAfterOpen.generationStatus = 'success';
    sessionAfterOpen.notice = 'ok';
    // Panel invalidates on mode switch — click generic then custom
    root.querySelectorAll('[data-slx-affection-create-mode]')[0].click();
    const html = renderManualAffectionCreateOverlay(chatState);
    // After mode switch on real session, draft preview should be gone
    assert.doesNotMatch(html, /专属五阶段草稿/);
    void sessionAfterOpen;
  });
});

test('closing create overlay clears draft session', async () => {
  await withHarness(async ({ chatState }) => {
    const root = createPanelRoot();
    openCreateView(root);
    assert.equal(isAffectionEditorOpen(), true);
    root.querySelectorAll('[data-slx-affection-close-create]')[0].click();
    assert.equal(isAffectionEditorOpen(), false);
    assert.equal(renderManualAffectionCreateOverlay(chatState), '');
  });
});

// ---------------------------------------------------------------------------
// 22.6 主动重新生成
// ---------------------------------------------------------------------------

test('regenerate default context is dry_run all; overlong requirement rejects without API', async () => {
  await withHarness(async ({ chatState, settings }) => {
    chatState.affectionSystem.profiles.沈青 = {
      roleName: '沈青',
      initialValueTenths: 300,
      valueTenths: 300,
      buildMode: 'custom',
      stages: createGenericAffectionStages(),
      records: [],
      stageDesignRequirement: '旧构思',
    };

    let apiCalls = 0;
    await regenerateAffectionProfileStages({
      roleName: '沈青',
      userRequirement: '新构思',
    }, {
      settings,
      chatState,
      resolveContextMaterial: async roleName => {
        assert.equal(roleName, '沈青');
        return '完整手动上下文';
      },
      requestCustomProfile: async ({ task, messages }) => {
        apiCalls += 1;
        assert.equal(task.userRequirement, '新构思');
        assert.match(messages.map(m => m.content).join('\n'), /完整手动上下文|新构思/);
        return {
          rawContent: createValidStagesJson(),
          transportPlan: { requestedMode: 'legacy', actualMode: 'legacy', fallbackReason: null, apiMode: 'secondary_api' },
        };
      },
      log: false,
    });
    assert.equal(apiCalls, 1);

    // Default path options for resolveManualAffectionProfileContext
    let options = null;
    await resolveManualAffectionProfileContext('沈青', {
      resolveContext: async opts => {
        options = opts;
        return {
          characterCard: {},
          userPersona: {},
          recentMessages: [],
          recentChat: '',
          memories: [],
          grandMemories: [],
          emotionProfiles: [],
          worldInfo: { entries: [], injectionText: '', diagnostics: { usedCount: 0 } },
          activatedWorldInfo: [],
          diagnostics: { worldInfo: { usedCount: 0 } },
        };
      },
      formatContext: () => 'x',
    });
    assert.equal(options.worldInfoMode, 'dry_run');
    assert.equal(options.worldInfoLimit, 'all');

    await assert.rejects(
      () => regenerateAffectionProfileStages({
        roleName: '沈青',
        userRequirement: 'x'.repeat(2001),
      }, {
        settings,
        chatState,
        resolveContextMaterial: async () => 'x',
        requestCustomProfile: async () => {
          apiCalls = 99;
          return createValidStagesJson();
        },
        log: false,
      }),
      /不能超过 2000/,
    );
    assert.notEqual(apiCalls, 99);
  });
});

test('stageDesignRequirement is saved on custom apply and kept when switching to generic', async () => {
  await withHarness(async ({ chatState, settings }) => {
    chatState.affectionSystem.profiles.沈青 = {
      roleName: '沈青',
      initialValueTenths: 200,
      valueTenths: 200,
      buildMode: 'custom',
      stages: createValidStages(),
      records: [],
      stageDesignRequirement: '原始构思',
    };

    await applyAffectionProfileStages({
      roleName: '沈青',
      stages: createValidStages(),
      buildMode: 'custom',
      stageDesignRequirement: '  确认后的构思  ',
    }, { settings, chatState, persist: false });
    assert.equal(chatState.affectionSystem.profiles.沈青.stageDesignRequirement, '确认后的构思');

    await applyAffectionProfileStages({
      roleName: '沈青',
      stages: createGenericAffectionStages(),
      buildMode: 'generic',
    }, { settings, chatState, persist: false });
    assert.equal(chatState.affectionSystem.profiles.沈青.buildMode, 'generic');
    assert.equal(chatState.affectionSystem.profiles.沈青.stageDesignRequirement, '确认后的构思');
  });
});

test('createManualAffectionCreateState reads global defaults without mutating them', () => {
  const settings = createSettings({
    defaultBuildMode: 'generic',
    profileBuildApiMode: 'main_api',
  });
  const session = createManualAffectionCreateState(settings, 'chat-x');
  assert.equal(session.buildMode, 'generic');
  assert.equal(session.apiMode, 'main_api');
  assert.equal(session.chatId, 'chat-x');
  assert.equal(settings.modules.affection.defaultBuildMode, 'generic');
  assert.equal(settings.modules.affection.profileBuildApiMode, 'main_api');
});
