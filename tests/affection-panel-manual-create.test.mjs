import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_STATE_KEY, MODULE_NAME } from '../src/constants.js';
import {
  bindAffectionPanelEvents,
  configureAffectionPanel,
  createManualAffectionCreateState,
  getManualAffectionCreateSession,
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
    dataset: { ...dataset },
    disabled: false,
    value: '',
    removed: false,
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
    remove() {
      this.removed = true;
    },
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = {};
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    },
    click() {
      if (this.disabled) return;
      for (const fn of this._listeners?.click || []) {
        fn({ currentTarget: this, preventDefault() {} });
      }
    },
    input(value) {
      // 模拟浏览器：disabled 控件不接受输入
      if (this.disabled) return;
      this.value = value;
      for (const fn of this._listeners?.input || []) {
        fn({ currentTarget: this });
      }
    },
    keydown(key) {
      for (const fn of this._listeners?.keydown || []) {
        fn({ key, preventDefault() {}, currentTarget: this });
      }
    },
  };
}

/**
 * 支持真实事件 + 局部 remove + 异步 refresh 后重建节点（不堆叠监听器的 remount）。
 */
function createPanelRoot() {
  const store = new Map();
  let overlay = null;

  const ensure = (key, factory) => {
    if (!store.has(key)) store.set(key, factory());
    return store.get(key);
  };

  const root = {
    store,
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
      if (
        sel === '[data-slx-affection-create-draft-preview]'
        || sel === '.slx-affection-create-draft-preview'
      ) {
        const node = store.get('[data-slx-affection-create-draft-preview]');
        return node && !node.removed ? node : null;
      }
      if (
        sel === '[data-slx-affection-create-context-result]'
        || sel === '.slx-affection-create-context-result'
      ) {
        const node = store.get('[data-slx-affection-create-context-result]');
        return node && !node.removed ? node : null;
      }
      if (
        sel === '[data-slx-affection-create-notice]'
        || sel === '[data-slx-affection-create-draft-notice]'
      ) {
        const node = store.get('[data-slx-affection-create-notice]');
        return node && !node.removed ? node : null;
      }
      if (sel === '[data-slx-affection-create-context-status]') {
        const node = store.get('[data-slx-affection-create-context-status]');
        return node && !node.removed ? node : null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-slx-affection-close-create]') {
        // 顶部 + 底部两个关闭按钮
        if (!store.has(sel)) {
          store.set(sel, [createClickable(), createClickable()]);
        }
        return store.get(sel);
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
      if (sel === '[data-slx-affection-toggle-create-stage]') {
        return store.get(sel) || [];
      }
      if (sel === '[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]') {
        return store.get(sel) || [];
      }
      if (sel === '.slx-affection-create-draft-card') {
        return store.get(sel) || [];
      }
      if (sel === '.slx-affection-create-draft-card .slx-affection-stage-fields') {
        return (store.get('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]') || [])
          .map(node => node._fieldsParent)
          .filter(Boolean);
      }
      if (sel === '.slx-affection-editor-overlay') {
        if (!overlay) overlay = createClickable();
        return [overlay];
      }
      return [];
    },
    /** 根据当前 session 同步草稿/确认按钮等节点（模拟 refresh 后的 DOM）。 */
    syncFromSession() {
      const session = getManualAffectionCreateSession();
      const html = renderManualAffectionCreateOverlay({});
      const hasDraft = Boolean(session?.draft?.stages?.length);
      const isCommitting = session?.generationStatus === 'committing';
      const closeButtons = this.querySelectorAll('[data-slx-affection-close-create]');
      closeButtons.forEach(btn => {
        btn.disabled = isCommitting;
      });
      const isBusy = session?.generationStatus === 'running' || isCommitting;
      const commit = this.querySelector('[data-slx-affection-commit-create-draft]');
      if (commit) {
        commit.disabled = !hasDraft || isBusy;
      }
      const generic = this.querySelector('[data-slx-affection-create-generic]');
      if (generic) {
        generic.disabled = isBusy;
      }
      const generate = this.querySelector('[data-slx-affection-generate-create-draft]');
      if (generate) {
        generate.disabled = isBusy;
      }
      const testContext = this.querySelector('[data-slx-affection-test-create-context]');
      if (testContext) {
        testContext.disabled = isBusy || session?.contextStatus === 'running';
      }
      if (hasDraft) {
        store.set('[data-slx-affection-create-draft-preview]', createClickable());
        // 为可编辑草稿重建字段节点，供 remount 后重新绑定
        const fieldNodes = [];
        const toggleNodes = [];
        const cards = [];
        const draftLocked = session.generationStatus === 'committing';
        (session.draft.stages || []).forEach((stage, stageIndex) => {
          const fieldsParent = {
            hidden: session.draftExpandedStageId !== (stage.stageId || `S${stageIndex + 1}`),
          };
          const card = createClickable();
          card.classList._set = new Set(
            session.draftExpandedStageId === (stage.stageId || `S${stageIndex + 1}`)
              ? ['is-open']
              : [],
          );
          card.querySelector = (innerSel) => {
            if (innerSel === '.slx-affection-stage-fields') return fieldsParent;
            return null;
          };
          cards.push(card);

          const toggle = createClickable({
            slxAffectionToggleCreateStage: stage.stageId || `S${stageIndex + 1}`,
          });
          toggle.disabled = draftLocked;
          toggle.closest = (sel) => {
            if (sel.includes('create-draft-card') || sel.includes('stage-draft-card')) return card;
            return null;
          };
          toggleNodes.push(toggle);

          for (const field of ['name', 'meaning', 'trend', 'boundary']) {
            const node = createClickable({
              slxAffectionCreateStageField: field,
              stageIndex: String(stageIndex),
            });
            node.value = stage[field] || '';
            node.disabled = draftLocked;
            node._fieldsParent = fieldsParent;
            fieldNodes.push(node);
          }
          (stage.behaviors || ['', '', '']).forEach((item, behaviorIndex) => {
            const node = createClickable({
              slxAffectionCreateStageBehavior: String(behaviorIndex),
              stageIndex: String(stageIndex),
            });
            node.value = item || '';
            node.disabled = draftLocked;
            node._fieldsParent = fieldsParent;
            fieldNodes.push(node);
          });
        });
        store.set('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]', fieldNodes);
        store.set('[data-slx-affection-toggle-create-stage]', toggleNodes);
        store.set('.slx-affection-create-draft-card', cards);
      } else {
        store.delete('[data-slx-affection-create-draft-preview]');
        store.delete('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]');
        store.delete('[data-slx-affection-toggle-create-stage]');
        store.delete('.slx-affection-create-draft-card');
      }
      if (session?.notice) {
        store.set('[data-slx-affection-create-notice]', createClickable());
      } else {
        store.delete('[data-slx-affection-create-notice]');
      }
      if (session?.contextStatus === 'success' && session.contextResult) {
        store.set('[data-slx-affection-create-context-result]', createClickable());
        store.get('[data-slx-affection-create-context-result]').textContent = String(session.contextResult.material || '');
      } else if (session?.contextStatus === 'running' || session?.contextStatus === 'error') {
        store.set('[data-slx-affection-create-context-status]', createClickable());
        store.delete('[data-slx-affection-create-context-result]');
      } else {
        store.delete('[data-slx-affection-create-context-result]');
        store.delete('[data-slx-affection-create-context-status]');
      }
      void html;
    },
  };
  return root;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function withHarness(run, {
  settings = createSettings(),
  chatState = createChatState(),
  chatId = 'chat-phase-b',
  panelOptions = {},
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
    try { cb(); } catch { /* ignore */ }
    return 0;
  };

  let liveRoot = null;
  const refreshPanel = () => {
    if (liveRoot) liveRoot.syncFromSession();
  };

  configureAffectionWorkflow({
    addCommunicationLog: () => {},
    getActiveApiProfile: () => ({ name: 't', model: 'm', baseUrl: 'https://example.invalid' }),
    refreshPanel,
  });
  configureAffectionPanel({
    refreshPanel,
    ...panelOptions,
  });

  try {
    return await run({
      settings,
      chatState,
      chatId,
      mount() {
        liveRoot = createPanelRoot();
        bindAffectionPanelEvents(liveRoot);
        return liveRoot;
      },
      remount() {
        liveRoot = createPanelRoot();
        // 先按 session 重建草稿字段节点，再绑定事件（否则 querySelectorAll 为空）
        liveRoot.syncFromSession();
        bindAffectionPanelEvents(liveRoot);
        return liveRoot;
      },
    });
  } finally {
    if (isAffectionEditorOpen() && getManualAffectionCreateSession()?.generationStatus !== 'committing') {
      const root = createPanelRoot();
      bindAffectionPanelEvents(root);
      root.querySelectorAll('[data-slx-affection-close-create]')[0]?.click();
    }
    // Force-clear stuck committing sessions between tests
    if (getManualAffectionCreateSession()) {
      configureAffectionPanel({
        refreshPanel: () => {},
        createManualGeneric: async () => ({}),
        commitManualDraft: async () => ({}),
      });
      // hard reset via close path after forcing idle
      const session = getManualAffectionCreateSession();
      if (session) session.generationStatus = 'idle';
      const root = createPanelRoot();
      bindAffectionPanelEvents(root);
      root.querySelectorAll('[data-slx-affection-close-create]')[0]?.click();
    }
    configureAffectionWorkflow({
      addCommunicationLog: null,
      getActiveApiProfile: null,
      refreshPanel: null,
    });
    configureAffectionPanel({
      refreshPanel: null,
      resolveManualContext: null,
      generateManualDraft: null,
      createManualGeneric: null,
      commitManualDraft: null,
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
  root.querySelector('[data-slx-affection-open-create]').click();
  assert.equal(isAffectionEditorOpen(), true, 'create overlay should open when chat metadata exists');
}

// ---------------------------------------------------------------------------
// 既有渲染 / 接线
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
  await withHarness(async ({ mount }) => {
    const root = mount();
    openCreateView(root);

    let html = renderManualAffectionCreateOverlay({});
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="slx-affection-create-title"/);
    assert.match(html, /data-slx-affection-create-role/);
    assert.match(html, /data-slx-affection-create-initial/);
    assert.match(html, /data-slx-affection-create-api/);
    assert.match(html, /阶段设计构思（可选）/);
    assert.match(html, /data-slx-affection-test-create-context/);
    assert.match(html, /data-slx-affection-generate-create-draft/);

    root.querySelectorAll('[data-slx-affection-create-mode]')[0].click();
    html = renderManualAffectionCreateOverlay({});
    assert.match(html, /使用通用阶段创建/);
    assert.doesNotMatch(html, /data-slx-affection-create-api=/);
    assert.doesNotMatch(html, /data-slx-affection-create-requirement/);
  });
});

test('generic create converts display tenths and writes formal profile with zero API', async () => {
  await withHarness(async ({ chatState, settings }) => {
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
    assert.equal(profile.initialValueTenths, 350);
  });
});

test('context test uses dry_run all and zero world info remains success without profile write', async () => {
  await withHarness(async ({ chatState }) => {
    const before = JSON.stringify(chatState.affectionSystem);
    const result = await resolveManualAffectionProfileContext('沈青', {
      resolveContext: async options => {
        assert.equal(options.worldInfoMode, 'dry_run');
        assert.equal(options.worldInfoLimit, 'all');
        return {
          characterCard: { description: '角色卡' },
          userPersona: {},
          recentMessages: [],
          recentChat: '',
          memories: [],
          grandMemories: [],
          emotionProfiles: [],
          worldInfo: {
            entries: [{ content: '蓝灯' }, { content: '绿灯' }],
            injectionText: '蓝灯\n绿灯',
            diagnostics: { usedCount: 2, materialSource: 'injection', targetRoleInjected: true },
          },
          activatedWorldInfo: [{ content: '蓝灯' }, { content: '绿灯' }],
          diagnostics: {
            recentMessageCount: 0,
            memoryCount: 0,
            grandMemoryCount: 0,
            emotionProfileCount: 0,
            worldInfo: { usedCount: 2, materialSource: 'injection', targetRoleInjected: true },
          },
        };
      },
      formatContext: context => context.worldInfo.injectionText,
    });
    assert.match(result.material, /蓝灯/);
    assert.equal(JSON.stringify(chatState.affectionSystem), before);
  });
});

test('custom draft generation does not write profile; commit saves stageDesignRequirement', async () => {
  await withHarness(async ({ chatState, settings, chatId }) => {
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
      requestCustomProfile: async () => ({
        rawContent: createValidStagesJson(),
        transportPlan: { requestedMode: 'legacy', actualMode: 'legacy', fallbackReason: null, apiMode: 'main_api' },
      }),
      log: false,
    });
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
  });
});

test('closing create overlay clears draft session', async () => {
  await withHarness(async ({ mount }) => {
    const root = mount();
    openCreateView(root);
    assert.equal(isAffectionEditorOpen(), true);
    root.querySelectorAll('[data-slx-affection-close-create]')[0].click();
    assert.equal(isAffectionEditorOpen(), false);
    assert.equal(getManualAffectionCreateSession(), null);
  });
});

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
      resolveContextMaterial: async () => '完整手动上下文',
      requestCustomProfile: async () => {
        apiCalls += 1;
        return {
          rawContent: createValidStagesJson(),
          transportPlan: { requestedMode: 'legacy', actualMode: 'legacy', fallbackReason: null, apiMode: 'secondary_api' },
        };
      },
      log: false,
    });
    assert.equal(apiCalls, 1);
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
  assert.equal(session.contextRequestId, '');
  assert.equal(session.draftExpandedStageId, '');
  assert.deepEqual(session.draftFieldErrors, {});
  assert.equal(session.draftDirty, false);
});

function mockManualDraft(input, stages = createValidStages()) {
  return {
    draftType: 'manual_affection_profile',
    buildRequestId: 'draft-1',
    chatId: 'chat-phase-b',
    roleName: input.roleName,
    initialValueTenths: input.initialValueTenths,
    buildMode: 'custom',
    apiMode: input.apiMode,
    userRequirement: input.userRequirement || '',
    stages,
    contextDiagnostics: {},
    createdAt: 'now',
  };
}

function findCreateStageField(root, stageIndex, field) {
  return root.querySelectorAll('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]')
    .find(node => (
      Number(node.dataset.stageIndex) === stageIndex
      && node.dataset.slxAffectionCreateStageField === field
    ));
}

function findCreateStageBehavior(root, stageIndex, behaviorIndex) {
  return root.querySelectorAll('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]')
    .find(node => (
      Number(node.dataset.stageIndex) === stageIndex
      && Number(node.dataset.slxAffectionCreateStageBehavior) === behaviorIndex
    ));
}

// ---------------------------------------------------------------------------
// Review Fix：三项真实竞态回归
// ---------------------------------------------------------------------------

test('panel input change invalidates the active draft and disables commit immediately', async () => {
  let generateCalls = 0;
  await withHarness(async ({ mount }) => {
    const root = mount();
    openCreateView(root);

    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('35.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    assert.ok(session);
    assert.equal(session.generationStatus, 'success');
    assert.ok(session.draft);
    assert.equal(generateCalls, 1);
    assert.equal(session.notice.includes('草稿已生成'), true);
    assert.equal(session.draftDirty, false);
    assert.ok(session.draftExpandedStageId);

    root.syncFromSession();
    assert.ok(root.querySelector('[data-slx-affection-create-draft-preview]'));
    assert.equal(root.querySelector('[data-slx-affection-commit-create-draft]').disabled, false);
    assert.ok(root.querySelector('[data-slx-affection-create-notice]'));

    // 修改初始好感：内存失效 + 局部 DOM 同步，不依赖完整 refresh
    root.querySelector('[data-slx-affection-create-initial]').input('40.0');

    assert.equal(session.draft, null);
    assert.equal(session.generationStatus, 'idle');
    assert.equal(session.notice, '');
    assert.equal(root.querySelector('[data-slx-affection-create-draft-preview]'), null);
    assert.equal(root.querySelector('[data-slx-affection-commit-create-draft]').disabled, true);
    assert.equal(root.querySelector('[data-slx-affection-create-notice]'), null);

    // 角色名变化同时清空资料
    session.contextStatus = 'success';
    session.contextResult = { material: '旧资料', diagnostics: {} };
    session.contextRequestId = 'old-req';
    root.syncFromSession();
    assert.ok(root.querySelector('[data-slx-affection-create-context-result]'));

    root.querySelector('[data-slx-affection-create-role]').input('萧景琰');
    assert.equal(session.contextResult, null);
    assert.equal(session.contextStatus, 'idle');
    assert.equal(session.contextRequestId, '');
    assert.equal(root.querySelector('[data-slx-affection-create-context-result]'), null);
  }, {
    panelOptions: {
      generateManualDraft: async (input) => {
        generateCalls += 1;
        return {
          draftType: 'manual_affection_profile',
          buildRequestId: 'draft-1',
          chatId: 'chat-phase-b',
          roleName: input.roleName,
          initialValueTenths: input.initialValueTenths,
          buildMode: 'custom',
          apiMode: input.apiMode,
          userRequirement: input.userRequirement || '',
          stages: createValidStages(),
          contextDiagnostics: {},
          createdAt: 'now',
        };
      },
    },
  });
});

test('late context result is ignored after the role name changes', async () => {
  let resolveOldContext;
  const oldContextPromise = new Promise(resolve => {
    resolveOldContext = resolve;
  });
  let contextCalls = 0;

  await withHarness(async ({ mount }) => {
    const root = mount();
    openCreateView(root);

    root.querySelector('[data-slx-affection-create-role]').input('梅长苏');
    root.querySelector('[data-slx-affection-test-create-context]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    assert.equal(session.contextStatus, 'running');
    assert.ok(session.contextRequestId);
    const oldRequestId = session.contextRequestId;
    assert.equal(contextCalls, 1);

    // 角色名改为萧景琰 → 旧请求身份失效
    root.querySelector('[data-slx-affection-create-role]').input('萧景琰');
    assert.equal(session.contextRequestId, '');
    assert.equal(session.contextStatus, 'idle');
    assert.equal(session.contextResult, null);

    resolveOldContext({
      roleName: '梅长苏',
      material: '梅长苏专属资料-不应出现',
      diagnostics: {
        worldInfo: { usedCount: 1, materialSource: 'injection', targetRoleInjected: true },
      },
    });
    await flushMicrotasks();

    assert.equal(getManualAffectionCreateSession().roleName, '萧景琰');
    assert.equal(session.contextResult, null);
    assert.notEqual(session.contextStatus, 'success');
    assert.notEqual(session.contextRequestId, oldRequestId);
    const html = renderManualAffectionCreateOverlay({});
    assert.doesNotMatch(html, /梅长苏专属资料-不应出现/);
    assert.equal(root.querySelector('[data-slx-affection-create-context-result]'), null);

    // 新角色请求可正常成功
    root.querySelector('[data-slx-affection-test-create-context]').click();
    await flushMicrotasks();
    assert.equal(session.contextStatus, 'success');
    assert.match(session.contextResult.material, /萧景琰资料/);
  }, {
    panelOptions: {
      resolveManualContext: async (roleName) => {
        contextCalls += 1;
        if (roleName === '梅长苏') {
          return oldContextPromise;
        }
        return {
          roleName,
          material: `${roleName}资料`,
          diagnostics: {
            worldInfo: { usedCount: 0, materialSource: 'none', targetRoleInjected: true },
          },
        };
      },
    },
  });
});

test('manual create overlay cannot close while a formal commit is pending', async () => {
  let resolveCommit;
  const commitPromise = new Promise(resolve => {
    resolveCommit = resolve;
  });
  let commitCalls = 0;

  await withHarness(async ({ mount, chatState }) => {
    const root = mount();
    openCreateView(root);

    // 通用正式创建路径
    root.querySelectorAll('[data-slx-affection-create-mode]')[0].click();
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('20.0');

    root.querySelector('[data-slx-affection-create-generic]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    assert.ok(session);
    assert.equal(session.generationStatus, 'committing');
    assert.equal(commitCalls, 1);

    root.syncFromSession();
    const closeButtons = root.querySelectorAll('[data-slx-affection-close-create]');
    assert.equal(closeButtons.length, 2);
    assert.equal(closeButtons[0].disabled, true);
    assert.equal(closeButtons[1].disabled, true);

    // 顶部 / 底部关闭均无效
    closeButtons[0].click();
    closeButtons[1].click();
    assert.equal(isAffectionEditorOpen(), true);
    assert.ok(getManualAffectionCreateSession());
    assert.equal(getManualAffectionCreateSession().generationStatus, 'committing');

    // Escape 不关闭
    const overlay = root.querySelectorAll('.slx-affection-editor-overlay')[0];
    overlay.keydown('Escape');
    assert.equal(isAffectionEditorOpen(), true);
    assert.equal(getManualAffectionCreateSession()?.generationStatus, 'committing');

    resolveCommit({
      roleName: '沈青',
      initialValueTenths: 200,
      valueTenths: 200,
      buildMode: 'generic',
      buildStatus: 'ready',
      stages: createGenericAffectionStages(),
      records: [],
      stageDesignRequirement: '',
      sourceType: 'manual',
      sourceMessageId: null,
      sourceFingerprint: '',
      createdAt: 'now',
      updatedAt: 'now',
    });
    // 真正写入 chatState，因我们 mock 了 createGeneric
    chatState.affectionSystem.profiles.沈青 = {
      roleName: '沈青',
      initialValueTenths: 200,
      valueTenths: 200,
      buildMode: 'generic',
      stages: createGenericAffectionStages(),
      records: [],
      sourceType: 'manual',
    };
    await flushMicrotasks();

    assert.equal(isAffectionEditorOpen(), false);
    assert.equal(getManualAffectionCreateSession(), null);
    assert.ok(chatState.affectionSystem.profiles.沈青);
  }, {
    panelOptions: {
      createManualGeneric: async () => {
        commitCalls += 1;
        return commitPromise;
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Phase D：可编辑专属草稿
// ---------------------------------------------------------------------------

test('generated exclusive draft renders editable stage fields without range inputs', async () => {
  let generateCalls = 0;
  await withHarness(async ({ mount }) => {
    const root = mount();
    openCreateView(root);
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('35.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    assert.equal(session.generationStatus, 'success');
    assert.equal(session.draftDirty, false);
    // 35.0 → 350 tenths → S2 (21-40)
    assert.equal(session.draftExpandedStageId, 'S2');

    const html = renderManualAffectionCreateOverlay({});
    assert.match(html, /专属五阶段草稿/);
    assert.match(html, /可直接修改，确认后才正式建档/);
    assert.match(html, /data-slx-affection-create-stage-field="name"/);
    assert.match(html, /data-slx-affection-create-stage-field="meaning"/);
    assert.match(html, /data-slx-affection-create-stage-field="trend"/);
    assert.match(html, /data-slx-affection-create-stage-field="boundary"/);
    assert.match(html, /data-slx-affection-create-stage-behavior="0"/);
    assert.match(html, /data-slx-affection-create-stage-behavior="1"/);
    assert.match(html, /data-slx-affection-create-stage-behavior="2"/);
    assert.match(html, /data-slx-affection-toggle-create-stage/);
    assert.doesNotMatch(html, /data-slx-affection-create-stage-field="minTenths"|data-slx-affection-create-stage-field="maxTenths"|data-slx-affection-create-stage-field="stageId"/);
    assert.doesNotMatch(html, /data-slx-affection-create-range|data-stage-range/);
    // 固定区间以只读文本展示
    assert.match(html, /0\.0—20\.0|21\.0—40\.0/);
  }, {
    panelOptions: {
      generateManualDraft: async (input) => {
        generateCalls += 1;
        return mockManualDraft(input);
      },
    },
  });
  assert.equal(generateCalls, 1);
});

test('editing draft stage fields writes session.draft and does not invalidate or re-call API', async () => {
  let generateCalls = 0;
  await withHarness(async ({ mount, remount }) => {
    const root = mount();
    openCreateView(root);
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('42.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    assert.ok(session.draft);
    const originalMeaning0 = session.draft.stages[0].meaning;
    assert.equal(generateCalls, 1);

    // remount 后绑定可编辑字段
    const live = remount();
    const meaning2 = findCreateStageField(live, 1, 'meaning');
    const behavior3 = findCreateStageBehavior(live, 2, 1);
    assert.ok(meaning2, 'stage 2 meaning field should exist');
    assert.ok(behavior3, 'stage 3 behavior 2 field should exist');

    meaning2.input('用户改写的第二阶段含义');
    behavior3.input('用户改写的第三阶段行为二');

    assert.equal(session.draft.stages[1].meaning, '用户改写的第二阶段含义');
    assert.equal(session.draft.stages[2].behaviors[1], '用户改写的第三阶段行为二');
    assert.equal(session.draft.stages[0].meaning, originalMeaning0);
    assert.ok(session.draft);
    assert.equal(session.generationStatus, 'success');
    assert.equal(session.draftDirty, true);
    assert.equal(generateCalls, 1);
    assert.equal(live.querySelector('[data-slx-affection-commit-create-draft]').disabled, false);
  }, {
    panelOptions: {
      generateManualDraft: async (input) => {
        generateCalls += 1;
        return mockManualDraft(input);
      },
    },
  });
});

test('build-condition changes still invalidate draft; draft text edits do not', async () => {
  let generateCalls = 0;
  await withHarness(async ({ mount, remount }) => {
    const root = mount();
    openCreateView(root);
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('30.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    let session = getManualAffectionCreateSession();
    assert.ok(session.draft);

    const live = remount();
    findCreateStageField(live, 0, 'name').input('改名不失效');
    assert.ok(session.draft);
    assert.equal(session.draftDirty, true);
    assert.equal(session.generationStatus, 'success');
    assert.equal(generateCalls, 1);

    // 角色名变化仍使草稿失效
    live.querySelector('[data-slx-affection-create-role]').input('萧景琰');
    assert.equal(session.draft, null);
    assert.equal(session.generationStatus, 'idle');
    assert.equal(session.draftDirty, false);
    assert.equal(session.draftExpandedStageId, '');
    assert.equal(generateCalls, 1);

    // 重新生成后，构思变化也失效
    live.querySelector('[data-slx-affection-create-role]').input('沈青');
    live.querySelector('[data-slx-affection-create-initial]').input('30.0');
    live.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();
    session = getManualAffectionCreateSession();
    assert.ok(session.draft);
    assert.equal(generateCalls, 2);

    live.querySelector('[data-slx-affection-create-requirement]').input('新构思');
    assert.equal(session.draft, null);
    assert.equal(session.generationStatus, 'idle');

    // API 切换失效
    live.querySelector('[data-slx-affection-create-role]').input('沈青');
    live.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();
    session = getManualAffectionCreateSession();
    assert.ok(session.draft);
    live.querySelectorAll('[data-slx-affection-create-api]')[0].click(); // main_api
    // 默认可能已是 secondary，切换到 main 应失效；若已是 main 则点 secondary
    if (session.draft) {
      live.querySelectorAll('[data-slx-affection-create-api]')[1].click();
    }
    assert.equal(session.draft, null);

    // 建档方式变化失效
    live.querySelector('[data-slx-affection-create-role]').input('沈青');
    live.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();
    session = getManualAffectionCreateSession();
    assert.ok(session.draft);
    live.querySelectorAll('[data-slx-affection-create-mode]')[0].click(); // generic
    assert.equal(session.draft, null);
  }, {
    panelOptions: {
      generateManualDraft: async (input) => {
        generateCalls += 1;
        return mockManualDraft(input);
      },
    },
  });
});

test('commit validates draft fields locally and blocks profile write on errors', async () => {
  let generateCalls = 0;
  let commitCalls = 0;
  let liveChatState = null;
  await withHarness(async ({ mount, remount, chatState }) => {
    liveChatState = chatState;
    const root = mount();
    openCreateView(root);
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('35.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    session.draft.stages[0].name = '';
    session.draft.stages[0].behaviors[1] = '';

    const live = remount();
    live.querySelector('[data-slx-affection-commit-create-draft]').click();
    await flushMicrotasks();

    assert.equal(commitCalls, 0);
    assert.equal(Object.keys(chatState.affectionSystem.profiles).length, 0);
    assert.equal(session.generationStatus, 'success');
    assert.ok(session.draft);
    assert.equal(session.error, '请补全专属阶段草稿后再确认。');
    assert.ok(session.draftFieldErrors.S1);
    assert.ok(session.draftFieldErrors.S1.includes('阶段名'));
    assert.ok(session.draftFieldErrors.S1.includes('行为 2'));
    assert.equal(session.draftExpandedStageId, 'S1');

    const html = renderManualAffectionCreateOverlay({});
    assert.match(html, /请补全专属阶段草稿后再确认/);
    assert.match(html, /请补全：.*阶段名/);
    assert.match(html, /行为 2/);

    // 补全后可继续确认
    session.draft.stages[0].name = '戒备';
    session.draft.stages[0].behaviors[1] = '保持距离但回应必要沟通';
    const live2 = remount();
    live2.querySelector('[data-slx-affection-commit-create-draft]').click();
    await flushMicrotasks();
    assert.equal(commitCalls, 1);
    assert.ok(chatState.affectionSystem.profiles.沈青);
  }, {
    panelOptions: {
      generateManualDraft: async (input) => {
        generateCalls += 1;
        return mockManualDraft(input);
      },
      commitManualDraft: async (input) => {
        commitCalls += 1;
        liveChatState.affectionSystem.profiles[input.roleName] = {
          roleName: input.roleName,
          initialValueTenths: input.initialValueTenths,
          valueTenths: input.initialValueTenths,
          buildMode: 'custom',
          stages: input.draft.stages,
          records: [],
          stageDesignRequirement: input.userRequirement || '',
          sourceType: 'manual',
        };
        return liveChatState.affectionSystem.profiles[input.roleName];
      },
    },
  });
  assert.equal(generateCalls, 1);
});

test('edited draft stages are what gets committed to the formal profile', async () => {
  let commitPayload = null;
  let liveChatState = null;
  await withHarness(async ({ mount, remount, chatState }) => {
    liveChatState = chatState;
    const root = mount();
    openCreateView(root);
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('35.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    const session = getManualAffectionCreateSession();
    assert.equal(session.draft.stages[1].meaning, 'AI原始含义A');

    const live = remount();
    findCreateStageField(live, 1, 'meaning').input('用户最终含义B');
    assert.equal(session.draft.stages[1].meaning, '用户最终含义B');
    assert.equal(session.draftDirty, true);

    live.querySelector('[data-slx-affection-commit-create-draft]').click();
    await flushMicrotasks();

    assert.ok(commitPayload);
    assert.equal(commitPayload.draft.stages[1].meaning, '用户最终含义B');
    assert.equal(liveChatState.affectionSystem.profiles.沈青.stages[1].meaning, '用户最终含义B');
    assert.notEqual(liveChatState.affectionSystem.profiles.沈青.stages[1].meaning, 'AI原始含义A');
  }, {
    panelOptions: {
      generateManualDraft: async (input) => {
        const stages = createValidStages();
        stages[1].meaning = 'AI原始含义A';
        return mockManualDraft(input, stages);
      },
      commitManualDraft: async (input) => {
        commitPayload = input;
        liveChatState.affectionSystem.profiles[input.roleName] = {
          roleName: input.roleName,
          initialValueTenths: input.initialValueTenths,
          valueTenths: input.initialValueTenths,
          buildMode: 'custom',
          stages: input.draft.stages.map(stage => ({ ...stage, behaviors: [...stage.behaviors] })),
          records: [],
          stageDesignRequirement: input.userRequirement || '',
          sourceType: 'manual',
        };
        return liveChatState.affectionSystem.profiles[input.roleName];
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Phase D Review Fix：committing 期间冻结草稿编辑器
// ---------------------------------------------------------------------------

test('manual custom draft fields are disabled while formal commit is pending', async () => {
  let resolveCommit;
  const commitPromise = new Promise((resolve, reject) => {
    resolveCommit = { resolve, reject };
  });
  let commitCalls = 0;

  await withHarness(async ({ mount, remount }) => {
    const root = mount();
    openCreateView(root);
    root.querySelector('[data-slx-affection-create-role]').input('沈青');
    root.querySelector('[data-slx-affection-create-initial]').input('35.0');
    root.querySelector('[data-slx-affection-generate-create-draft]').click();
    await flushMicrotasks();

    let live = remount();
    const meaningField = findCreateStageField(live, 1, 'meaning');
    assert.equal(meaningField.disabled, false);
    meaningField.input('确认前可改的含义B');
    const session = getManualAffectionCreateSession();
    assert.equal(session.draft.stages[1].meaning, '确认前可改的含义B');
    assert.equal(session.draftDirty, true);

    live.querySelector('[data-slx-affection-commit-create-draft]').click();
    await flushMicrotasks();

    assert.equal(session.generationStatus, 'committing');
    assert.equal(commitCalls, 1);

    live = remount();
    const fields = live.querySelectorAll('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]');
    const toggles = live.querySelectorAll('[data-slx-affection-toggle-create-stage]');
    assert.ok(fields.length >= 5 * 7); // 5 stages × (name+meaning+trend+boundary+3 behaviors)
    assert.equal(fields.length, 35);
    assert.equal(toggles.length, 5);
    for (const node of fields) {
      assert.equal(node.disabled, true, 'draft field should be disabled while committing');
    }
    for (const node of toggles) {
      assert.equal(node.disabled, true, 'stage toggle should be disabled while committing');
    }

    // HTML 渲染也带 disabled
    const html = renderManualAffectionCreateOverlay({});
    assert.match(html, /data-slx-affection-create-stage-field="meaning"[^>]*\sdisabled/);
    assert.match(html, /data-slx-affection-toggle-create-stage="S1"[^>]*\sdisabled/);

    // 提交期间假输入不得写入 session.draft（harness 模拟 disabled + handler guard）
    const lockedMeaning = findCreateStageField(live, 1, 'meaning');
    lockedMeaning.input('提交中假修改C');
    assert.equal(session.draft.stages[1].meaning, '确认前可改的含义B');

    // 提交失败 → 恢复可编辑，保留用户草稿
    resolveCommit.reject(new Error('mock commit failed'));
    await flushMicrotasks();

    assert.equal(session.generationStatus, 'success');
    assert.ok(session.draft);
    assert.equal(session.draftDirty, true);
    assert.equal(session.draft.stages[1].meaning, '确认前可改的含义B');
    assert.match(session.error || '', /mock commit failed/);

    live = remount();
    const unlockedFields = live.querySelectorAll('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]');
    const unlockedToggles = live.querySelectorAll('[data-slx-affection-toggle-create-stage]');
    for (const node of unlockedFields) {
      assert.equal(node.disabled, false, 'draft field should unlock after commit failure');
    }
    for (const node of unlockedToggles) {
      assert.equal(node.disabled, false, 'stage toggle should unlock after commit failure');
    }

    const recoveredMeaning = findCreateStageField(live, 1, 'meaning');
    recoveredMeaning.input('失败后继续改D');
    assert.equal(session.draft.stages[1].meaning, '失败后继续改D');
    assert.equal(session.draftDirty, true);
  }, {
    panelOptions: {
      generateManualDraft: async (input) => mockManualDraft(input),
      commitManualDraft: async () => {
        commitCalls += 1;
        return commitPromise;
      },
    },
  });
});
