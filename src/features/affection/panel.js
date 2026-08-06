import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  createManualAffectionAdjustmentRecord,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  getStageForValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionRoleName,
  parseAffectionDeltaTenths,
  parseAffectionValueTenths,
  recalculateAffectionLedger,
  replaceAffectionRecord,
  upsertAffectionRecord,
} from './model.js';
import {
  cloneData,
  escapeHtml,
  isPlainObject,
} from '../../utils/text.js';
import {
  getAffectionProfileKey,
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getStorageDiagnostics,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  createMessageContentFingerprint,
  getMessageContentFingerprint,
} from '../../core/message-fingerprint.js';
import { slxIcon } from '../../icons.js';
import {
  getPendingCommitHandlerIds,
  isPendingCommitEventRegistered,
  registerPendingCommitEvents,
  registerPendingCommitHandler,
  runPendingCommitHandlers,
} from '../../core/pending-commit.js';
import {
  isPromptStateLineSanitizerRegistered,
  registerPromptStateLineSanitizerEvents,
  sanitizeChatCompletionPromptStateLines,
  stripInlineStateLinesForSendingText,
} from '../../core/prompt-state-lines.js';
import { stripMemoryChangedControlLines } from '../../core/summary.js';
import { MEMORY_FIELD_CONFIG } from '../chat-beautify/field-config.js';
import { formatMemoryMultiRowParts } from '../chat-beautify/render-memory.js';
import { runAffectionProfileBuildApiPreview } from './generation.js';
import {
  AFFECTION_STATE_INJECT_POSITION,
  AFFECTION_STATE_PROMPT_ID,
  buildAffectionInjection,
  syncAffectionInjection,
} from './injection.js';
import {
  commitAffectionUpdateFromConfirmedSummary,
  commitSelectedPendingAffectionUpdates,
  discardPendingAffectionItem,
  parseAffectionUpdateFromMemory,
  storePendingAffectionUpdate,
  updatePendingAffectionDelta,
} from './lifecycle.js';
import {
  commitManualAffectionProfileDraft,
  createManualGenericAffectionProfile,
  generateManualAffectionProfileDraft,
  resolveManualAffectionProfileContext,
} from './manual-profile.js';
import { createGenericAffectionStages } from './profile.js';
import {
  adjustAffectionProfileValue,
  applyAffectionProfileStages,
  buildAffectionUpdatePromptSection,
  deleteAffectionProfile,
  regenerateAffectionProfileStages,
} from './workflow.js';

const DEFAULT_CHANGE_LINES = [
  '沈青 |0.1',
  '沈 青|0.2',
  '阿蛮|5',
  '苏暮香|0',
].join('\n');

const DEFAULT_LEDGER_RECORDS = JSON.stringify([
  {
    recordId: 'message-12',
    sourceMessageId: 12,
    sourceFingerprint: 'swipe-b',
    deltaTenths: 2,
    sourceType: 'auto',
    createdAt: '2026-07-13T12:02:00.000Z',
  },
  {
    recordId: 'message-10',
    sourceMessageId: 10,
    sourceFingerprint: 'swipe-a',
    deltaTenths: 1,
    sourceType: 'auto',
    createdAt: '2026-07-13T12:01:00.000Z',
  },
], null, 2);

const DEFAULT_SETTINGS_MIGRATION_INPUT = JSON.stringify({
  globalSettings: {
    modules: {
      affection: {
        enabled: true,
        mode: 'off',
        buildMode: 'generic',
        apiMode: 'main_api',
        obsoleteField: '会被移除',
      },
    },
  },
  chatState: {
    affectionSystem: {
      profiles: {
        '旧键不会参与身份': {
          roleName: '  沈 青  ',
          characterId: 'world-card-id',
          aliases: ['阿青'],
          initialValueTenths: 425,
        },
      },
      pendingByMessage: [],
      buildTasks: '损坏对象',
      mode: 'reverse',
      buildMode: 'generic',
    },
  },
}, null, 2);

const DEFAULT_STATE_LINE_INPUT = `<memory>
[number:12]
[plot:{{user}}尊重了沈青的边界。]
[emotion_changed:true]
[emotion:沈青|朋友|戒备略松|开始信任]
[affection:沈青|0.1|35.2]
[affection_first:阿蛮|25.0]
</memory>`;

const DEFAULT_FIELD_MEMORY_INPUT = `<memory>
[number:20]
[emotion_changed:false]
[affection:沈青|0]
[affection_first:阿蛮|35.0]
[progress:main|推进|1|5]
</memory>`;

const DEFAULT_FIELD_PROFILES_INPUT = JSON.stringify({
  沈青: {
    roleName: '沈青',
    initialValueTenths: 350,
    valueTenths: 350,
    records: [],
  },
}, null, 2);

let affectionPanelOptions = {
  refreshPanel: null,
  // 可选注入：资料测试 / 草稿生成 / 正式提交（生产默认走真实实现）
  resolveManualContext: null,
  generateManualDraft: null,
  createManualGeneric: null,
  commitManualDraft: null,
};

let affectionPanelState = {
  view: 'main', // main | create | detail | stages
  roleName: '',
  settingsOpen: false,
  fullStagesOpen: false,
  regenerateOpen: false,
  notice: '',
  error: '',
  focusSelector: '',
  focusRoleName: '',
  editor: null,
  manualCreate: null,
};

let affectionTestState = createDefaultTestState();

function createDefaultTestState() {
  return {
    suiteStatus: 'idle',
    suiteResults: [],
    changeLines: DEFAULT_CHANGE_LINES,
    changeResult: null,
    changeError: '',
    ledgerInitialValue: '42.2',
    ledgerRecords: DEFAULT_LEDGER_RECORDS,
    ledgerTargetValue: '50.0',
    ledgerResult: null,
    ledgerError: '',
    settingsSuiteStatus: 'idle',
    settingsSuiteResults: [],
    settingsMigrationInput: DEFAULT_SETTINGS_MIGRATION_INPUT,
    settingsMigrationStatus: 'idle',
    settingsMigrationResult: null,
    settingsMigrationError: '',
    storageProbeStatus: 'idle',
    storageProbeResult: null,
    storageProbeError: '',
    sharedCoreSuiteStatus: 'idle',
    sharedCoreSuiteResults: [],
    stateLineMode: 'ordinary',
    stateLineInput: DEFAULT_STATE_LINE_INPUT,
    stateLineStatus: 'idle',
    stateLineResult: null,
    stateLineError: '',
    fieldSuiteStatus: 'idle',
    fieldSuiteResults: [],
    fieldMemoryInput: DEFAULT_FIELD_MEMORY_INPUT,
    fieldProfilesInput: DEFAULT_FIELD_PROFILES_INPUT,
    fieldSwipe: 'swipe-a',
    fieldPendingByMessage: {},
    fieldStatus: 'idle',
    fieldResult: null,
    fieldError: '',
    buildSuiteStatus: 'idle',
    buildSuiteResults: [],
    buildRoleName: '阿蛮',
    buildInitialValue: '35.0',
    buildMode: 'generic',
    buildStatus: 'idle',
    buildResult: null,
    buildError: '',
    buildRealStatus: 'idle',
    buildRealResult: null,
    buildRealError: '',
    commitSuiteStatus: 'idle',
    commitSuiteResults: [],
    commitSelectedSwipe: 'swipe-b',
    commitStatus: 'idle',
    commitResult: null,
    commitError: '',
    injectionSuiteStatus: 'idle',
    injectionSuiteResults: [],
    uiSuiteStatus: 'idle',
    uiSuiteResults: [],
    injectionMode: 'active',
    injectionStatus: 'idle',
    injectionResult: null,
    injectionError: '',
    diagnosticsOpen: false,
    expandedSections: {
      suite: false,
      change: false,
      ledger: false,
      settingsSuite: false,
      settingsMigration: false,
      storageProbe: false,
      sharedCoreSuite: false,
      stateLines: false,
      fieldSuite: false,
      fieldSimulator: false,
      buildSuite: false,
      buildSimulator: false,
      commitSuite: false,
      injectionSuite: false,
      uiSuite: false,
    },
  };
}

export function configureAffectionPanel(options = {}) {
  affectionPanelOptions = {
    ...affectionPanelOptions,
    ...options,
  };
}

function refreshPanel() {
  if (typeof affectionPanelOptions.refreshPanel === 'function') {
    affectionPanelOptions.refreshPanel();
  }
}

function setAffectionPanelFeedback({ notice = '', error = '' } = {}) {
  affectionPanelState.notice = String(notice || '');
  affectionPanelState.error = String(error || '');
}

function getCurrentAffectionChatId() {
  return String(getContextInfo()?.chatId || '');
}

function createManualCreateState(settings = getGlobalSettings(), chatId = getCurrentAffectionChatId()) {
  const affection = getAffectionSettings(settings);
  return {
    chatId: String(chatId || ''),
    roleName: '',
    initialValue: '',
    buildMode: affection.defaultBuildMode === 'generic' ? 'generic' : 'custom',
    apiMode: affection.profileBuildApiMode === 'main_api' ? 'main_api' : 'secondary_api',
    userRequirement: '',
    contextStatus: 'idle',
    contextResult: null,
    contextError: '',
    contextRequestId: '',
    generationStatus: 'idle',
    draft: null,
    generationError: '',
    notice: '',
    error: '',
  };
}

function clearManualCreateSession() {
  affectionPanelState.manualCreate = null;
  if (affectionPanelState.view === 'create') {
    affectionPanelState.view = 'main';
  }
}

function createManualContextRequestId() {
  return `affection-context:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function invalidateManualCreateDraft(session, { clearContext = false } = {}) {
  if (!session) return;
  session.draft = null;
  session.generationStatus = 'idle';
  session.generationError = '';
  session.notice = '';
  if (clearContext) {
    session.contextRequestId = '';
    session.contextStatus = 'idle';
    session.contextResult = null;
    session.contextError = '';
  }
}

function isActiveManualCreateSession(session) {
  return Boolean(
    session
    && affectionPanelState.manualCreate === session
    && session.chatId === getCurrentAffectionChatId(),
  );
}

function isActiveManualContextRequest(session, requestId, roleName) {
  return Boolean(
    isActiveManualCreateSession(session)
    && session.contextRequestId === requestId
    && normalizeAffectionRoleName(session.roleName) === roleName,
  );
}

/**
 * 输入变化后局部同步草稿/资料 UI，避免对角色名等高频 input 做完整 refreshPanel。
 */
function syncManualCreateDraftInvalidation(panelRoot, { clearContext = false } = {}) {
  if (!panelRoot?.querySelector) return;
  panelRoot.querySelector('[data-slx-affection-create-draft-preview]')?.remove?.();
  panelRoot.querySelector('.slx-affection-create-draft-preview')?.remove?.();
  const commitButton = panelRoot.querySelector('[data-slx-affection-commit-create-draft]');
  if (commitButton) commitButton.disabled = true;
  panelRoot.querySelector('[data-slx-affection-create-notice]')?.remove?.();
  panelRoot.querySelector('[data-slx-affection-create-draft-notice]')?.remove?.();
  if (clearContext) {
    panelRoot.querySelector('[data-slx-affection-create-context-result]')?.remove?.();
    panelRoot.querySelector('.slx-affection-create-context-result')?.remove?.();
    panelRoot.querySelector('[data-slx-affection-create-context-status]')?.remove?.();
    // 角色名变化使进行中的资料测试失效后，恢复测试按钮（非生成中时）
    const session = affectionPanelState.manualCreate;
    const genBusy = session?.generationStatus === 'running'
      || session?.generationStatus === 'committing';
    const testButton = panelRoot.querySelector('[data-slx-affection-test-create-context]');
    if (testButton && !genBusy) testButton.disabled = false;
  }
}

function getManualCreateDeps() {
  return {
    resolveContext: typeof affectionPanelOptions.resolveManualContext === 'function'
      ? affectionPanelOptions.resolveManualContext
      : resolveManualAffectionProfileContext,
    generateDraft: typeof affectionPanelOptions.generateManualDraft === 'function'
      ? affectionPanelOptions.generateManualDraft
      : generateManualAffectionProfileDraft,
    createGeneric: typeof affectionPanelOptions.createManualGeneric === 'function'
      ? affectionPanelOptions.createManualGeneric
      : createManualGenericAffectionProfile,
    commitDraft: typeof affectionPanelOptions.commitManualDraft === 'function'
      ? affectionPanelOptions.commitManualDraft
      : commitManualAffectionProfileDraft,
  };
}

/** 读取当前手动建档 session（只读检查 / 测试断言用）。 */
export function getManualAffectionCreateSession() {
  return affectionPanelState.manualCreate;
}

function normalizeAffectionPanelView(store) {
  const currentChatId = getCurrentAffectionChatId();
  if (affectionPanelState.editor?.chatId && affectionPanelState.editor.chatId !== currentChatId) {
    affectionPanelState.editor = null;
    affectionPanelState.view = 'main';
    affectionPanelState.roleName = '';
  }
  if (
    affectionPanelState.manualCreate
    && affectionPanelState.manualCreate.chatId !== currentChatId
  ) {
    affectionPanelState.manualCreate = null;
    if (affectionPanelState.view === 'create') {
      affectionPanelState.view = 'main';
    }
  }
  if (
    (affectionPanelState.view === 'detail' || affectionPanelState.view === 'stages')
    && !isPlainObject(store.profiles?.[affectionPanelState.roleName])
  ) {
    affectionPanelState.view = 'main';
    affectionPanelState.roleName = '';
    affectionPanelState.editor = null;
  }
  if (affectionPanelState.view === 'create' && !affectionPanelState.manualCreate) {
    affectionPanelState.view = 'main';
  }
}

export function isAffectionEditorOpen() {
  return affectionPanelState.view === 'create'
    || affectionPanelState.view === 'detail'
    || affectionPanelState.view === 'stages';
}

/** 供测试与内部复用：构造新建档案会话初始状态。 */
export function createManualAffectionCreateState(settings, chatId) {
  return createManualCreateState(settings, chatId);
}

function getSelectedPendingEntries(settings, store) {
  return Object.entries(store.pendingByMessage || {})
    .map(([messageKey, bucket]) => {
      const messageId = Number(messageKey);
      if (!Number.isInteger(messageId) || !isPlainObject(bucket?.items)) return null;
      const fingerprint = getMessageContentFingerprint(messageId, settings);
      const pending = isPlainObject(bucket.items[fingerprint]) ? bucket.items[fingerprint] : null;
      if (!pending) return null;
      const changes = Array.isArray(pending.changes) ? pending.changes : [];
      if (!changes.length) return null;
      return {
        messageId,
        fingerprint,
        pending,
        otherSwipeCount: Math.max(0, Object.keys(bucket.items).length - 1),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.messageId - left.messageId);
}

function renderAffectionFeedback() {
  return `
    ${affectionPanelState.notice ? `<div class="slx-affection-feedback is-success" role="status">${slxIcon('check')}<span>${escapeHtml(affectionPanelState.notice)}</span></div>` : ''}
    ${affectionPanelState.error ? `<div class="slx-affection-feedback is-error" role="alert">${slxIcon('alert')}<span>${escapeHtml(affectionPanelState.error)}</span></div>` : ''}
  `;
}

function renderAffectionSettings(settings) {
  const affection = getAffectionSettings(settings);
  const buildModeLabel = affection.defaultBuildMode === 'generic' ? '通用阶段' : '专属阶段';
  const apiLabel = affection.profileBuildApiMode === 'main_api' ? '主 API' : '副 API';
  return `
    <details class="slx-detail-card slx-affection-settings-fold" data-slx-affection-settings ${affectionPanelState.settingsOpen ? 'open' : ''}>
      <summary>
        <span>${slxIcon('settings')}<b>建档设置</b></span>
        <small>${escapeHtml(buildModeLabel)} · ${escapeHtml(apiLabel)}</small>
        ${slxIcon('chevronDown')}
      </summary>
      <div class="slx-affection-settings-body">
        <div class="slx-affection-settings-controls">
          <div class="slx-affection-control-group">
            <span class="slx-affection-control-label">新建档案默认方式</span>
            <div class="slx-affection-segment" role="group" aria-label="新建档案默认方式">
              <button type="button" data-slx-affection-build-mode="custom" class="${affection.defaultBuildMode === 'custom' ? 'is-active' : ''}" aria-pressed="${affection.defaultBuildMode === 'custom'}">专属阶段</button>
              <button type="button" data-slx-affection-build-mode="generic" class="${affection.defaultBuildMode === 'generic' ? 'is-active' : ''}" aria-pressed="${affection.defaultBuildMode === 'generic'}">通用阶段</button>
            </div>
          </div>
          ${affection.defaultBuildMode === 'custom' ? `
            <div class="slx-affection-control-group slx-affection-api-setting">
              <span class="slx-affection-control-label">专属阶段默认 API</span>
              <div class="slx-schedule-api-toggle slx-affection-api-toggle" role="group" aria-label="专属阶段默认 API">
                <button type="button" data-slx-affection-build-api="main_api" class="${affection.profileBuildApiMode === 'main_api' ? 'is-active' : ''}" aria-pressed="${affection.profileBuildApiMode === 'main_api'}">主 API</button>
                <button type="button" data-slx-affection-build-api="secondary_api" class="${affection.profileBuildApiMode === 'secondary_api' ? 'is-active' : ''}" aria-pressed="${affection.profileBuildApiMode === 'secondary_api'}">副 API</button>
              </div>
            </div>
          ` : '<p class="slx-affection-build-note">通用阶段不调用建档 API。</p>'}
        </div>
      </div>
    </details>
  `;
}

function renderPendingChangeRow(entry, change) {
  const roleName = normalizeAffectionRoleName(change?.roleName);
  const deltaTenths = Number(change?.deltaTenths);
  const deltaIndex = AFFECTION_ALLOWED_DELTA_TENTHS.indexOf(deltaTenths);
  const canDecrease = deltaIndex > 0;
  const canIncrease = deltaIndex >= 0 && deltaIndex < AFFECTION_ALLOWED_DELTA_TENTHS.length - 1;
  return `
    <div class="slx-affection-pending-row">
      <div class="slx-affection-pending-person">
        <b>${escapeHtml(roleName)}</b>
        <small>本轮变化 · 变化后 ${escapeHtml(formatAffectionValueTenths(change.valueAfterTenths))}</small>
      </div>
      <div class="slx-affection-delta-stepper" aria-label="${escapeHtml(roleName)}本轮好感变化">
        <button type="button" data-slx-affection-delta-step="-1" data-message-id="${entry.messageId}" data-fingerprint="${escapeHtml(entry.fingerprint)}" data-role-name="${escapeHtml(roleName)}" aria-label="降低${escapeHtml(roleName)}本轮好感变化" ${canDecrease ? '' : 'disabled'}>${slxIcon('minus')}</button>
        <output>${deltaTenths === 0 ? '无变化' : escapeHtml(formatAffectionDeltaTenths(deltaTenths))}</output>
        <button type="button" data-slx-affection-delta-step="1" data-message-id="${entry.messageId}" data-fingerprint="${escapeHtml(entry.fingerprint)}" data-role-name="${escapeHtml(roleName)}" aria-label="提高${escapeHtml(roleName)}本轮好感变化" ${canIncrease ? '' : 'disabled'}>${slxIcon('plus')}</button>
      </div>
      <button class="slx-affection-text-action is-danger" type="button" data-slx-affection-discard-pending data-message-id="${entry.messageId}" data-fingerprint="${escapeHtml(entry.fingerprint)}" data-role-name="${escapeHtml(roleName)}">放弃此项</button>
    </div>
  `;
}

function renderAffectionPending(settings, store) {
  const entries = getSelectedPendingEntries(settings, store);
  if (!entries.length) {
    return `
      <section class="slx-detail-card slx-affection-pending-card is-empty">
        <div class="slx-affection-section-head"><b>当前回复待确认</b><small>暂无</small></div>
        <p>暂无待确认变化。</p>
      </section>
    `;
  }
  return entries.map(entry => {
    const changeRows = (Array.isArray(entry.pending.changes) ? entry.pending.changes : [])
      .map(change => renderPendingChangeRow(entry, change));
    return `
      <section class="slx-detail-card slx-affection-pending-card">
        <div class="slx-affection-section-head">
          <div><b>当前回复待确认</b><small>第 ${entry.messageId} 楼 · 当前选中回复</small></div>
          ${entry.otherSwipeCount ? `<span>另有 ${entry.otherSwipeCount} 个未选回复暂存</span>` : ''}
        </div>
        <div class="slx-affection-pending-list">${changeRows.join('')}</div>
        <p>下次发送时确认。</p>
      </section>
    `;
  }).join('');
}

function getStageNumber(stage) {
  const matched = String(stage?.stageId || '').match(/(\d+)/);
  return Number(matched?.[1]) || 1;
}

function renderAffectionStageRail(roleName, valueTenths, stages) {
  const safeStages = Array.isArray(stages) && stages.length ? stages : createGenericAffectionStages();
  const current = getStageForValueTenths(valueTenths, safeStages);
  const currentNumber = getStageNumber(current);
  return `
    <div class="slx-affection-stage-rail" role="img" aria-label="${escapeHtml(roleName)}当前好感 ${escapeHtml(formatAffectionValueTenths(valueTenths))}，位于第 ${currentNumber} 阶段「${escapeHtml(current.name || '未命名')}」">
      ${safeStages.map((stage, index) => `<span class="slx-affection-stage-segment ${index + 1 === currentNumber ? 'is-current' : ''}"></span>`).join('')}
      <i style="--slx-affection-position:${Math.max(0, Math.min(100, Number(valueTenths) / 10))}%"></i>
    </div>
  `;
}

function renderAffectionProfileCard(storedRoleName, profile) {
  const roleName = normalizeAffectionRoleName(profile?.roleName || storedRoleName);
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  const stage = getStageForValueTenths(ledger.valueTenths, profile.stages);
  const recent = [...ledger.records].reverse().find(record => Number(record?.deltaTenths) !== 0);
  const recentText = recent
    ? `${recent.sourceMessageId === null ? '手动调整' : `第${recent.sourceMessageId}楼`} ${formatAffectionDeltaTenths(recent.deltaTenths)}`
    : '以初始好感建档';
  const buildStatusLabel = {
    ready: '就绪',
    building: '生成中',
    error: '失败',
    stale: '已失效',
  }[profile.buildStatus] || '就绪';
  return `
    <article class="slx-detail-card slx-affection-profile-card">
      <header>
        <b>${escapeHtml(roleName)}</b>
        <span class="slx-affection-card-badges">
          <small>${profile.buildMode === 'generic' ? '通用' : '专属'}</small>
          <small>${escapeHtml(buildStatusLabel)}</small>
        </span>
      </header>
      <div class="slx-affection-value-line">
        <strong>${escapeHtml(formatAffectionValueTenths(ledger.valueTenths))}<small>/100</small></strong>
        <span>「${escapeHtml(stage.name || '未命名阶段')}」</span>
      </div>
      ${renderAffectionStageRail(roleName, ledger.valueTenths, profile.stages)}
      <div class="slx-affection-stage-caption">当前位于第 ${getStageNumber(stage)} 阶段</div>
      <p class="slx-affection-stage-meaning">${escapeHtml(stage.meaning || '尚未填写阶段含义。')}</p>
      <footer>
        <small>最近：${escapeHtml(recentText)}</small>
        <button class="slx-soft-btn" type="button" data-slx-affection-open-detail="${escapeHtml(roleName)}">${slxIcon('edit')}<span>查看调整</span></button>
      </footer>
    </article>
  `;
}

function renderManualCreateEntryCard() {
  return `
    <section class="slx-detail-card slx-affection-create-entry">
      <div class="slx-affection-section-head">
        <b>新建角色档案</b>
        <small>手动指定追踪角色</small>
      </div>
      <p class="slx-affection-create-entry-desc">手动指定需要追踪的角色，并选择通用或专属五阶段。</p>
      <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-affection-open-create>
        ${slxIcon('sparkles')}<span>新建角色档案</span>
      </button>
    </section>
  `;
}

function renderAffectionProfiles(store) {
  const profiles = Object.entries(store.profiles || {}).filter(([, profile]) => isPlainObject(profile));
  return `
    <section class="slx-affection-profile-section">
      <div class="slx-affection-section-head"><b>角色档案</b><small>已建档 ${profiles.length} 人</small></div>
      ${profiles.length ? `<div class="slx-affection-profile-grid">${profiles.map(([roleName, profile]) => renderAffectionProfileCard(roleName, profile)).join('')}</div>` : `
        <div class="slx-detail-card slx-affection-empty-state">
          ${slxIcon('pursuit')}
          <b>还没有正式好感档案</b>
          <p>点击“新建角色档案”，手动指定需要追踪的角色。</p>
        </div>
      `}
    </section>
  `;
}

function formatManualContextSummary(contextResult) {
  const diagnostics = isPlainObject(contextResult?.diagnostics) ? contextResult.diagnostics : {};
  const worldInfo = isPlainObject(diagnostics.worldInfo) ? diagnostics.worldInfo : {};
  const materialLength = String(contextResult?.material || '').length;
  const recentMessageCount = Number.isFinite(Number(diagnostics.recentMessageCount))
    ? Number(diagnostics.recentMessageCount)
    : 0;
  const memoryCount = Number.isFinite(Number(diagnostics.memoryCount))
    ? Number(diagnostics.memoryCount)
    : 0;
  const grandMemoryCount = Number.isFinite(Number(diagnostics.grandMemoryCount))
    ? Number(diagnostics.grandMemoryCount)
    : 0;
  const emotionProfileCount = Number.isFinite(Number(diagnostics.emotionProfileCount))
    ? Number(diagnostics.emotionProfileCount)
    : 0;
  const usedCount = Number.isFinite(Number(worldInfo.usedCount))
    ? Number(worldInfo.usedCount)
    : 0;
  const materialSource = String(worldInfo.materialSource || '').trim() || '未知';
  const targetInjected = worldInfo.targetRoleInjected === true ? '是' : '否';
  return {
    materialLength,
    recentMessageCount,
    memoryCount,
    grandMemoryCount,
    emotionProfileCount,
    usedCount,
    materialSource,
    targetInjected,
  };
}

function renderManualCreateDraftPreview(session) {
  const stages = Array.isArray(session?.draft?.stages) ? session.draft.stages : [];
  if (!stages.length) return '';
  const initialTenths = parseAffectionValueTenths(session.initialValue);
  const currentStage = Number.isInteger(initialTenths)
    ? getStageForValueTenths(initialTenths, stages)
    : null;
  return `
    <section class="slx-detail-card slx-affection-create-draft-preview" data-slx-affection-create-draft-preview aria-label="专属五阶段草稿">
      <div class="slx-affection-section-head"><b>专属五阶段草稿</b><small>确认后才正式建档</small></div>
      <div class="slx-affection-create-draft-list">
        ${stages.map((stage, index) => `
          <details class="slx-affection-create-draft-card ${stage.stageId === currentStage?.stageId ? 'is-current' : ''}" ${index === 0 || stage.stageId === currentStage?.stageId ? 'open' : ''}>
            <summary>
              <span>
                <small>${index + 1}</small>
                <b>${escapeHtml(formatAffectionValueTenths(stage.minTenths))}—${escapeHtml(formatAffectionValueTenths(stage.maxTenths))}</b>
                <em>「${escapeHtml(stage.name || '未命名')}」</em>
              </span>
              ${stage.stageId === currentStage?.stageId ? '<small class="is-current">初始好感所在阶段</small>' : ''}
            </summary>
            <div>
              <p><b>关系含义：</b>${escapeHtml(stage.meaning || '')}</p>
              <ul>${(stage.behaviors || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
              <p><b>变化倾向：</b>${escapeHtml(stage.trend || '')}</p>
              <p><b>阶段边界：</b>${escapeHtml(stage.boundary || '')}</p>
            </div>
          </details>
        `).join('')}
      </div>
    </section>
  `;
}

function renderManualCreateContextResult(session) {
  if (session.contextStatus === 'running') {
    return '<div class="slx-affection-editor-status" data-slx-affection-create-context-status role="status">正在读取角色资料…</div>';
  }
  if (session.contextStatus === 'error') {
    return `<div class="slx-affection-feedback is-error" data-slx-affection-create-context-status role="alert">${slxIcon('alert')}<span>${escapeHtml(session.contextError || '角色资料读取失败。')}</span></div>`;
  }
  if (session.contextStatus !== 'success' || !session.contextResult) return '';
  const summary = formatManualContextSummary(session.contextResult);
  return `
    <div class="slx-affection-create-context-result" data-slx-affection-create-context-result>
      <ul class="slx-affection-create-context-summary">
        <li>参考资料总字符数：${summary.materialLength}</li>
        <li>最近剧情数量：${summary.recentMessageCount}</li>
        <li>memory 数量：${summary.memoryCount}</li>
        <li>grand_memory 数量：${summary.grandMemoryCount}</li>
        <li>Emotion Profile 数量：${summary.emotionProfileCount}</li>
        <li>世界书条目：${summary.usedCount}</li>
        <li>世界书材料来源：${escapeHtml(summary.materialSource)}</li>
        <li>角色名是否加入扫描：${summary.targetInjected}</li>
      </ul>
      <details class="slx-affection-create-material-fold">
        <summary>查看将发送的参考资料</summary>
        <pre class="slx-affection-create-material-pre">${escapeHtml(session.contextResult.material || '')}</pre>
      </details>
    </div>
  `;
}

export function renderManualAffectionCreateOverlay(store) {
  if (affectionPanelState.view !== 'create' || !affectionPanelState.manualCreate) return '';
  const session = affectionPanelState.manualCreate;
  const isCustom = session.buildMode === 'custom';
  const isBusy = session.generationStatus === 'running' || session.generationStatus === 'committing';
  const isCommitting = session.generationStatus === 'committing';
  const isContextRunning = session.contextStatus === 'running';
  const fieldsDisabled = isBusy ? 'disabled' : '';
  const modeSubtitle = isCustom ? '专属阶段 · 生成后确认创建' : '通用阶段 · 不调用 API';
  const hasDraft = isCustom && isPlainObject(session.draft) && Array.isArray(session.draft.stages);
  return `
    <div class="slx-affection-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="slx-affection-create-title">
      <section class="slx-affection-editor slx-affection-create-editor">
        <header class="slx-affection-editor-head">
          <div>
            <b id="slx-affection-create-title">新建角色好感档案</b>
            <small>${escapeHtml(modeSubtitle)}</small>
          </div>
          <button type="button" data-slx-affection-close-create aria-label="关闭新建角色档案" ${isCommitting ? 'disabled' : ''}>${slxIcon('close')}</button>
        </header>
        <div class="slx-affection-editor-body">
          ${session.notice ? `<div class="slx-affection-feedback is-success" data-slx-affection-create-notice role="status">${slxIcon('check')}<span>${escapeHtml(session.notice)}</span></div>` : ''}
          ${session.error ? `<div class="slx-affection-feedback is-error" role="alert">${slxIcon('alert')}<span>${escapeHtml(session.error)}</span></div>` : ''}
          ${session.generationError ? `<div class="slx-affection-feedback is-error" role="alert">${slxIcon('alert')}<span>${escapeHtml(session.generationError)}</span></div>` : ''}

          <section class="slx-detail-card slx-affection-create-form">
            <label class="slx-affection-create-field">
              <span>建档角色名称</span>
              <input type="text" data-slx-affection-create-role value="${escapeHtml(session.roleName)}" autocomplete="off" ${fieldsDisabled} />
              <small>该名称会作为目标角色，并参与世界书资料扫描。</small>
            </label>
            <label class="slx-affection-create-field">
              <span>初始好感</span>
              <input type="number" min="0" max="100" step="0.1" inputmode="decimal" data-slx-affection-create-initial value="${escapeHtml(session.initialValue)}" ${fieldsDisabled} />
              <small>范围 0—100，最多一位小数。</small>
            </label>
            <div class="slx-affection-control-group">
              <span class="slx-affection-control-label" id="slx-affection-create-mode-label">建档方式</span>
              <div class="slx-affection-segment" role="group" aria-labelledby="slx-affection-create-mode-label">
                <button type="button" data-slx-affection-create-mode="generic" class="${session.buildMode === 'generic' ? 'is-active' : ''}" aria-pressed="${session.buildMode === 'generic'}" ${fieldsDisabled}>通用阶段</button>
                <button type="button" data-slx-affection-create-mode="custom" class="${session.buildMode === 'custom' ? 'is-active' : ''}" aria-pressed="${session.buildMode === 'custom'}" ${fieldsDisabled}>专属阶段</button>
              </div>
            </div>
            ${isCustom ? `
              <label class="slx-affection-create-field slx-affection-requirement">
                <span>阶段设计构思（可选）</span>
                <textarea rows="4" maxlength="2000" data-slx-affection-create-requirement placeholder="可填写你希望的关系节奏、阶段风格、角色边界或特殊发展方向。留空时由模型根据参考资料设计。" ${fieldsDisabled}>${escapeHtml(session.userRequirement)}</textarea>
              </label>
              <div class="slx-affection-control-group">
                <span class="slx-affection-control-label" id="slx-affection-create-api-label">本次 API</span>
                <div class="slx-schedule-api-toggle slx-affection-api-toggle" role="group" aria-labelledby="slx-affection-create-api-label">
                  <button type="button" data-slx-affection-create-api="main_api" class="${session.apiMode === 'main_api' ? 'is-active' : ''}" aria-pressed="${session.apiMode === 'main_api'}" ${fieldsDisabled}>主 API</button>
                  <button type="button" data-slx-affection-create-api="secondary_api" class="${session.apiMode === 'secondary_api' ? 'is-active' : ''}" aria-pressed="${session.apiMode === 'secondary_api'}" ${fieldsDisabled}>副 API</button>
                </div>
              </div>
              <div class="slx-affection-create-context-actions">
                <button class="slx-soft-btn" type="button" data-slx-affection-test-create-context ${isBusy || isContextRunning ? 'disabled' : ''}>
                  ${slxIcon('memoir')}<span>${isContextRunning ? '正在读取…' : '测试角色资料'}</span>
                </button>
                <button class="slx-soft-btn" type="button" data-slx-affection-generate-create-draft ${isBusy ? 'disabled' : ''}>
                  ${slxIcon('sparkles')}<span>${session.generationStatus === 'running' ? '正在生成专属阶段…' : '生成专属阶段'}</span>
                </button>
              </div>
              ${renderManualCreateContextResult(session)}
              ${session.generationStatus === 'running' ? '<div class="slx-affection-editor-status" role="status">正在生成专属阶段…</div>' : ''}
            ` : ''}
          </section>

          ${hasDraft ? renderManualCreateDraftPreview(session) : ''}

          <footer class="slx-affection-editor-footer">
            <button class="slx-soft-btn" type="button" data-slx-affection-close-create ${isCommitting ? 'disabled' : ''}>取消</button>
            ${isCustom
    ? `<button class="slx-soft-btn slx-primary-btn" type="button" data-slx-affection-commit-create-draft ${!hasDraft || isBusy ? 'disabled' : ''}>${slxIcon('check')}<span>${isCommitting ? '创建中…' : '确认创建档案'}</span></button>`
    : `<button class="slx-soft-btn slx-primary-btn" type="button" data-slx-affection-create-generic ${isBusy ? 'disabled' : ''}>${slxIcon('check')}<span>${isCommitting ? '创建中…' : '使用通用阶段创建'}</span></button>`}
          </footer>
        </div>
      </section>
    </div>
  `;
}

function renderFullStageDetails(profile, currentStage) {
  return `
    <details class="slx-affection-stage-details" data-slx-affection-full-stages ${affectionPanelState.fullStagesOpen ? 'open' : ''}>
      <summary><span>查看全部五阶段</span>${slxIcon('chevronDown')}</summary>
      <div>
        ${(Array.isArray(profile.stages) ? profile.stages : []).map(stage => `
          <article class="${stage.stageId === currentStage.stageId ? 'is-current' : ''}">
            <header><b>${escapeHtml(stage.name || '未命名')}</b><small>${escapeHtml(formatAffectionValueTenths(stage.minTenths))}—${escapeHtml(formatAffectionValueTenths(stage.maxTenths))}</small></header>
            <p>${escapeHtml(stage.meaning || '')}</p>
            <ul>${(stage.behaviors || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
            <p><b>变化倾向：</b>${escapeHtml(stage.trend || '')}</p>
            <p><b>阶段边界：</b>${escapeHtml(stage.boundary || '')}</p>
          </article>
        `).join('')}
      </div>
    </details>
  `;
}

function renderAffectionRecordList(records) {
  const items = [...records].reverse().slice(0, 8);
  if (!items.length) return '<p>暂无正式变化记录。</p>';
  return `<ol class="slx-affection-record-list">${items.map(record => `
    <li>
      <span>${record.sourceMessageId === null ? '手动调整' : `第 ${escapeHtml(record.sourceMessageId)} 楼`}</span>
      <b>${escapeHtml(formatAffectionDeltaTenths(record.deltaTenths))}</b>
      <small>${escapeHtml(formatAffectionValueTenths(record.valueBeforeTenths))} → ${escapeHtml(formatAffectionValueTenths(record.valueAfterTenths))}</small>
    </li>
  `).join('')}</ol>`;
}

function renderAffectionDetailOverlay(store) {
  if (affectionPanelState.view !== 'detail') return '';
  const profile = store.profiles?.[affectionPanelState.roleName];
  if (!isPlainObject(profile)) return '';
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  const stage = getStageForValueTenths(ledger.valueTenths, profile.stages);
  return `
    <div class="slx-affection-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="slx-affection-detail-title">
      <section class="slx-affection-editor">
        <header class="slx-affection-editor-head">
          <div><b id="slx-affection-detail-title">${escapeHtml(affectionPanelState.roleName)} · 好感档案</b><small>${escapeHtml(formatAffectionValueTenths(ledger.valueTenths))}/100 · 「${escapeHtml(stage.name || '未命名阶段')}」</small></div>
          <button type="button" data-slx-affection-close-overlay aria-label="返回好感度主面板">${slxIcon('close')}</button>
        </header>
        <div class="slx-affection-editor-body">
          ${renderAffectionFeedback()}
          <section class="slx-affection-detail-hero">
            <strong>${escapeHtml(formatAffectionValueTenths(ledger.valueTenths))}<small>/100</small></strong>
            <div><b>「${escapeHtml(stage.name || '未命名阶段')}」</b><p>${escapeHtml(stage.meaning || '')}</p></div>
          </section>
          ${renderAffectionStageRail(affectionPanelState.roleName, ledger.valueTenths, profile.stages)}

          <section class="slx-detail-card slx-affection-adjust-card">
            <div class="slx-affection-section-head"><b>当前值校准</b><small>记录为手动调整</small></div>
            <div class="slx-affection-adjust-row">
              <label><span>当前好感</span><input type="number" min="0" max="100" step="0.1" inputmode="decimal" data-slx-affection-adjust-value value="${escapeHtml(formatAffectionValueTenths(ledger.valueTenths))}" /></label>
              <button class="slx-soft-btn" type="button" data-slx-affection-apply-adjust>应用调整</button>
            </div>
          </section>

          <section class="slx-detail-card slx-affection-current-stage">
            <div class="slx-affection-section-head"><b>当前阶段</b><small>第 ${getStageNumber(stage)} 阶段</small></div>
            <p><b>关系含义：</b>${escapeHtml(stage.meaning || '')}</p>
            <ul>${(stage.behaviors || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
            <p><b>变化倾向：</b>${escapeHtml(stage.trend || '')}</p>
            <p><b>阶段边界：</b>${escapeHtml(stage.boundary || '')}</p>
            ${renderFullStageDetails(profile, stage)}
          </section>

          <section class="slx-detail-card slx-affection-build-mode-card">
            <div class="slx-affection-section-head"><b>建档方式</b><small>${profile.buildMode === 'generic' ? '通用阶段' : '专属阶段'}</small></div>
            <div class="slx-affection-segment" role="group" aria-label="${escapeHtml(affectionPanelState.roleName)}建档方式">
              <button type="button" data-slx-affection-profile-mode="custom" class="${profile.buildMode === 'custom' ? 'is-active' : ''}" aria-pressed="${profile.buildMode === 'custom'}">专属阶段</button>
              <button type="button" data-slx-affection-profile-mode="generic" class="${profile.buildMode === 'generic' ? 'is-active' : ''}" aria-pressed="${profile.buildMode === 'generic'}">通用阶段</button>
            </div>
            <button class="slx-soft-btn" type="button" data-slx-affection-open-stage-editor>${slxIcon(profile.buildMode === 'custom' ? 'edit' : 'sparkles')}<span>${profile.buildMode === 'custom' ? '编辑专属阶段内容' : '创建专属阶段内容'}</span></button>
          </section>

          <section class="slx-detail-card">
            <div class="slx-affection-section-head"><b>最近变化</b><small>只读</small></div>
            ${renderAffectionRecordList(ledger.records)}
          </section>

          <button class="slx-affection-delete-profile" type="button" data-slx-affection-delete-profile>${slxIcon('trash')}<span>删除此角色档案</span></button>
        </div>
      </section>
    </div>
  `;
}

function createAffectionStageEditor(profile, roleName) {
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  const currentStage = getStageForValueTenths(ledger.valueTenths, profile.stages);
  const stages = cloneData(profile.stages || []);
  return {
    chatId: getCurrentAffectionChatId(),
    roleName,
    stages,
    originalStages: cloneData(stages),
    sourceBuildMode: profile.buildMode === 'generic' ? 'generic' : 'custom',
    userRequirement: String(profile.stageDesignRequirement || ''),
    regenerateApiMode: getAffectionSettings(getGlobalSettings()).profileBuildApiMode,
    expandedStageId: currentStage.stageId || stages[0]?.stageId || 'S1',
    dirty: false,
    modifiedStageIds: [],
    generationStatus: 'idle',
    error: '',
    fieldErrors: {},
  };
}

function getStageEditorErrors(stages) {
  const errors = {};
  (Array.isArray(stages) ? stages : []).forEach((stage, index) => {
    const stageId = stage?.stageId || `S${index + 1}`;
    const fields = [];
    if (!String(stage?.name || '').trim()) fields.push('阶段名');
    if (!String(stage?.meaning || '').trim()) fields.push('关系含义');
    if (!String(stage?.trend || '').trim()) fields.push('变化倾向');
    if (!String(stage?.boundary || '').trim()) fields.push('阶段边界');
    (Array.isArray(stage?.behaviors) ? stage.behaviors : []).forEach((item, behaviorIndex) => {
      if (!String(item || '').trim()) fields.push(`行为 ${behaviorIndex + 1}`);
    });
    if (!Array.isArray(stage?.behaviors) || stage.behaviors.length !== 3) fields.push('三条行为');
    if (fields.length) errors[stageId] = fields;
  });
  return errors;
}

function renderAffectionStageFields(stage, index, expanded, stageErrors, currentStageId = '') {
  const stageId = stage.stageId || `S${index + 1}`;
  const errorText = stageErrors?.length ? `请补全：${stageErrors.join('、')}` : '';
  return `
    <article class="slx-affection-stage-draft-card ${expanded ? 'is-open' : ''} ${errorText ? 'has-error' : ''}">
      <button class="slx-affection-stage-toggle" type="button" data-slx-affection-toggle-stage="${escapeHtml(stageId)}" aria-expanded="${expanded}" aria-controls="slx-affection-stage-fields-${index}">
        <span><small>${index + 1}</small><b>${escapeHtml(formatAffectionValueTenths(stage.minTenths))}—${escapeHtml(formatAffectionValueTenths(stage.maxTenths))}</b><em>「${escapeHtml(stage.name || '未命名')}」</em></span>
        <span class="slx-affection-stage-tags">
          ${stageId === currentStageId ? '<small class="is-current">当前阶段</small>' : ''}
          ${affectionPanelState.editor?.modifiedStageIds?.includes(stageId) ? '<small>已修改</small>' : ''}
          ${errorText ? '<small class="is-error">有错误</small>' : ''}
          ${slxIcon('chevronDown')}
        </span>
      </button>
      <div class="slx-affection-stage-fields" id="slx-affection-stage-fields-${index}" ${expanded ? '' : 'hidden'}>
        ${errorText ? `<div class="slx-affection-field-error" role="alert">${escapeHtml(errorText)}</div>` : ''}
        <label><span>阶段名</span><input type="text" maxlength="24" data-slx-affection-stage-field="name" data-stage-index="${index}" value="${escapeHtml(stage.name || '')}" /></label>
        <label><span>关系含义</span><textarea rows="2" maxlength="120" data-slx-affection-stage-field="meaning" data-stage-index="${index}">${escapeHtml(stage.meaning || '')}</textarea></label>
        ${(stage.behaviors || ['', '', '']).map((item, behaviorIndex) => `<label><span>行为 ${behaviorIndex + 1}</span><textarea rows="2" maxlength="100" data-slx-affection-stage-behavior="${behaviorIndex}" data-stage-index="${index}">${escapeHtml(item || '')}</textarea></label>`).join('')}
        <label><span>变化倾向</span><textarea rows="2" maxlength="120" data-slx-affection-stage-field="trend" data-stage-index="${index}">${escapeHtml(stage.trend || '')}</textarea></label>
        <label><span>阶段边界</span><textarea rows="2" maxlength="120" data-slx-affection-stage-field="boundary" data-stage-index="${index}">${escapeHtml(stage.boundary || '')}</textarea></label>
      </div>
    </article>
  `;
}

function renderAffectionStageEditorOverlay(store) {
  if (affectionPanelState.view !== 'stages' || !affectionPanelState.editor) return '';
  const editor = affectionPanelState.editor;
  const profile = store.profiles?.[editor.roleName];
  if (!isPlainObject(profile)) return '';
  const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
  const currentStage = getStageForValueTenths(ledger.valueTenths, profile.stages);
  const isRunning = editor.generationStatus === 'running';
  const canEditStages = editor.sourceBuildMode !== 'generic' || editor.generationStatus === 'success';
  const fieldErrors = editor.fieldErrors || {};
  const errorCount = Object.keys(fieldErrors).length;
  return `
    <div class="slx-affection-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="slx-affection-stage-editor-title">
      <section class="slx-affection-editor">
        <header class="slx-affection-editor-head">
          <button type="button" data-slx-affection-back-detail aria-label="返回${escapeHtml(editor.roleName)}好感档案">${slxIcon('chevronLeft')}</button>
          <div><b id="slx-affection-stage-editor-title">${escapeHtml(editor.roleName)} · 编辑专属好感阶段</b><small>当前好感 ${escapeHtml(formatAffectionValueTenths(ledger.valueTenths))} · 正式阶段仍在使用中</small></div>
        </header>
        <div class="slx-affection-editor-body">
          ${renderAffectionFeedback()}
          <details class="slx-detail-card slx-affection-regenerate-fold" data-slx-affection-regenerate-fold ${affectionPanelState.regenerateOpen ? 'open' : ''}>
            <summary><span>${slxIcon('sparkles')}<b>按需求重新生成</b></span>${slxIcon('chevronDown')}</summary>
            <div>
              <label class="slx-affection-requirement"><span>重新生成需求（可选）</span><textarea rows="4" maxlength="2000" data-slx-affection-requirement placeholder="例如：前期戒备更重；确认关系后仍不擅长直白表达……" ${isRunning ? 'disabled' : ''}>${escapeHtml(editor.userRequirement)}</textarea><small>按此需求生成。</small></label>
              <div class="slx-affection-regenerate-actions">
                <div class="slx-schedule-api-toggle slx-affection-api-toggle" role="group" aria-label="本次重新生成 API">
                  <button type="button" data-slx-affection-regenerate-api="main_api" class="${editor.regenerateApiMode === 'main_api' ? 'is-active' : ''}" aria-pressed="${editor.regenerateApiMode === 'main_api'}" ${isRunning ? 'disabled' : ''}>主 API</button>
                  <button type="button" data-slx-affection-regenerate-api="secondary_api" class="${editor.regenerateApiMode === 'secondary_api' ? 'is-active' : ''}" aria-pressed="${editor.regenerateApiMode === 'secondary_api'}" ${isRunning ? 'disabled' : ''}>副 API</button>
                </div>
                <button class="slx-soft-btn" type="button" data-slx-affection-regenerate ${isRunning ? 'disabled' : ''}>${slxIcon('refresh')}<span>${isRunning ? '正在生成…' : '重新生成五阶段'}</span></button>
              </div>
              ${editor.error ? `<div class="slx-affection-feedback is-error" role="alert">${slxIcon('alert')}<span>${escapeHtml(editor.error)}</span></div>` : ''}
              ${editor.generationStatus === 'success' ? '<div class="slx-affection-editor-status" role="status">新五阶段已载入编辑副本，尚未覆盖正式阶段。</div>' : ''}
            </div>
          </details>

          <section class="slx-affection-stage-accordion" aria-label="五阶段编辑副本">
            <div class="slx-affection-section-head"><b>当前编辑副本</b><small>${editor.dirty ? '尚未应用' : '与正式阶段一致'}</small></div>
            ${canEditStages ? '' : '<div class="slx-affection-editor-status" role="status">当前仍在使用通用阶段。请先按需求重新生成一份专属五阶段草稿，再进行编辑和确认覆盖。</div>'}
            ${errorCount ? `<div class="slx-affection-editor-errors" role="alert">尚有 ${errorCount} 个阶段未通过校验，请展开标记为“有错误”的阶段。</div>` : ''}
            ${canEditStages ? editor.stages.map((stage, index) => renderAffectionStageFields(
              stage,
              index,
              editor.expandedStageId === stage.stageId,
              fieldErrors[stage.stageId],
              currentStage.stageId,
            )).join('') : ''}
          </section>

          <footer class="slx-affection-editor-footer">
            <button class="slx-soft-btn" type="button" data-slx-affection-cancel-stage-edit ${isRunning ? 'disabled' : ''}>取消修改</button>
            <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-affection-confirm-stages ${editor.dirty && canEditStages && !isRunning ? '' : 'disabled'}>${slxIcon('check')}<span>确认覆盖</span></button>
          </footer>
        </div>
      </section>
    </div>
  `;
}

function assertTest(condition, message) {
  if (!condition) throw new Error(message);
}

function sameValue(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function runModelTest(title, run) {
  try {
    const detail = run();
    return {
      title,
      status: 'passed',
      detail: String(detail || '结果符合预期。'),
    };
  } catch (error) {
    return {
      title,
      status: 'failed',
      detail: error?.message || String(error),
    };
  }
}

async function runAsyncTest(title, run) {
  try {
    const detail = await run();
    return {
      title,
      status: 'passed',
      detail: String(detail || '结果符合预期。'),
    };
  } catch (error) {
    return {
      title,
      status: 'failed',
      detail: error?.message || String(error),
    };
  }
}

function runAffectionModelSuite() {
  const results = [
    runModelTest('合法 delta 与 0 转为整数十分位', () => {
      const actual = ['-0.3', '-0.2', '-0.1', '0', '0.1', '0.2', '0.3']
        .map(parseAffectionDeltaTenths);
      assertTest(sameValue(actual, [-3, -2, -1, 0, 1, 2, 3]), `实际结果：${JSON.stringify(actual)}`);
      assertTest(sameValue(AFFECTION_ALLOWED_DELTA_TENTHS, [-3, -2, -1, 0, 1, 2, 3]), '允许值常量与解析规则不一致。');
      return '0 与 ±0.1 / ±0.2 / ±0.3 均正确转换。';
    }),
    runModelTest('拒绝越界值与非法小数', () => {
      const values = ['0.11', '1', '999', 'abc', ''];
      const actual = values.map(parseAffectionDeltaTenths);
      assertTest(actual.every(value => value === null), `未全部拒绝：${JSON.stringify(actual)}`);
      return '所有非法变化值均返回 null。';
    }),
    runModelTest('角色名保守规范化', () => {
      const actual = normalizeAffectionRoleName('  沈\n   青  ');
      assertTest(actual === '沈青', `中文名实际结果：${actual}`);
      assertTest(normalizeAffectionRoleName('  Mary   Jane  ') === 'Mary Jane', '外文姓名的正常分隔空格被误删。');
      return '中文字符间异常空格已清除，外文姓名分隔空格保留。';
    }),
    runModelTest('0 表示已判断但本轮无变化', () => {
      const actual = normalizeAffectionChanges({
        entries: [['沈青', '0']],
      });
      assertTest(actual.changed === false && actual.items[0]?.deltaTenths === 0, '0 判断没有被保留为无变化结果。');
      return '保留角色的 0 判断，同时 changed=false。';
    }),
    runModelTest('同轮同名角色只保留第一条合法变化', () => {
      const actual = normalizeAffectionChanges({
        entries: [['沈青', '0.1'], ['沈 青', '0.2'], ['阿蛮', '-0.2']],
      });
      assertTest(sameValue(actual.items, [
        { roleName: '沈青', deltaTenths: 1 },
        { roleName: '阿蛮', deltaTenths: -2 },
      ]), `实际结果：${JSON.stringify(actual.items)}`);
      assertTest(actual.diagnostics.some(item => item.code === 'duplicate_role'), '缺少 duplicate_role 诊断。');
      return '规范化同名已去重，并保留其他角色。';
    }),
    runModelTest('没有合法 delta 时归一为无变化', () => {
      const actual = normalizeAffectionChanges({
        entries: [['沈青', '5'], ['', '0.1']],
      });
      assertTest(actual.changed === false && actual.items.length === 0, '无合法变化时 changed 未关闭。');
      assertTest(actual.diagnostics.some(item => item.code === 'no_valid_delta'), '缺少 no_valid_delta 诊断。');
      return 'changed=false，非法原因保留在 diagnostics。';
    }),
    runModelTest('五阶段边界连续且无空档', () => {
      const samples = [
        [0, 'S1'], [200, 'S1'], [201, 'S2'], [400, 'S2'], [401, 'S3'],
        [600, 'S3'], [601, 'S4'], [800, 'S4'], [801, 'S5'], [1000, 'S5'],
      ];
      const actual = samples.map(([value]) => getStageForValueTenths(value).stageId);
      const expected = samples.map(([, stageId]) => stageId);
      assertTest(sameValue(actual, expected), `实际阶段：${JSON.stringify(actual)}`);
      return '0/20.0/20.1/40.0/40.1/60.0/60.1/80.0/80.1/100.0 全部命中正确阶段。';
    }),
    runModelTest('账本按楼层排序并重算前后值', () => {
      const ledger = recalculateAffectionLedger(422, [
        { recordId: 'later', sourceMessageId: 12, deltaTenths: 2, sourceType: 'auto' },
        { recordId: 'earlier', sourceMessageId: 10, deltaTenths: 1, sourceType: 'auto' },
      ]);
      assertTest(sameValue(ledger.records.map(item => item.recordId), ['earlier', 'later']), '记录未按楼层排序。');
      assertTest(sameValue(ledger.records.map(item => [item.valueBeforeTenths, item.valueAfterTenths]), [
        [422, 423], [423, 425],
      ]), `前后值错误：${JSON.stringify(ledger.records)}`);
      assertTest(ledger.valueTenths === 425, `最终值错误：${ledger.valueTenths}`);
      return '乱序输入被整理为 10 楼 → 12 楼，最终值 42.5。';
    }),
    runModelTest('同楼自动记录替换且手动记录保留', () => {
      const actual = replaceAffectionRecord([
        { recordId: 'old-auto', sourceMessageId: 10, deltaTenths: 1, sourceType: 'auto' },
        { recordId: 'manual', sourceMessageId: 10, deltaTenths: 5, sourceType: 'manual_adjustment' },
      ], {
        recordId: 'new-auto', sourceMessageId: 10, deltaTenths: -2, sourceType: 'auto',
      });
      assertTest(!actual.some(item => item.recordId === 'old-auto'), '旧自动记录未被替换。');
      assertTest(actual.some(item => item.recordId === 'new-auto'), '新自动记录未写入。');
      assertTest(actual.some(item => item.recordId === 'manual'), '同楼手动记录被误删。');
      return '只替换同楼自动记录。';
    }),
    runModelTest('重复提交同一楼层保持幂等', () => {
      const first = upsertAffectionRecord(400, [], {
        recordId: 'first', sourceMessageId: 20, deltaTenths: 1, sourceType: 'auto',
      });
      const second = upsertAffectionRecord(400, first.records, {
        recordId: 'second', sourceMessageId: 20, deltaTenths: 2, sourceType: 'auto',
      });
      assertTest(second.records.length === 1, `实际记录数：${second.records.length}`);
      assertTest(second.valueTenths === 402, `实际最终值：${second.valueTenths}`);
      return '同楼第二次处理替换旧值，不发生 0.1 + 0.2 的重复累计。';
    }),
    runModelTest('上下限截断后从可见值继续累计', () => {
      const ledger = recalculateAffectionLedger(999, [
        { recordId: 'up', sourceMessageId: 1, deltaTenths: 3, sourceType: 'auto' },
        { recordId: 'down', sourceMessageId: 2, deltaTenths: -1, sourceType: 'auto' },
      ]);
      assertTest(sameValue(ledger.records.map(item => [item.valueBeforeTenths, item.valueAfterTenths]), [
        [999, 1000], [1000, 999],
      ]), `截断承接错误：${JSON.stringify(ledger.records)}`);
      return '99.9 + 0.3 = 100.0，随后 -0.1 = 99.9。';
    }),
    runModelTest('手动调整按当前正式值生成记录', () => {
      const records = [{ recordId: 'auto', sourceMessageId: 1, deltaTenths: 1, sourceType: 'auto' }];
      const manual = createManualAffectionAdjustmentRecord({
        initialValueTenths: 422,
        records,
        targetValueTenths: 500,
        recordId: 'manual',
      });
      assertTest(manual?.deltaTenths === 77, `手动 delta：${manual?.deltaTenths}`);
      const ledger = recalculateAffectionLedger(422, [...records, manual]);
      assertTest(manual?.sourceMessageId === null, `手动记录楼层号应为 null，实际为：${manual?.sourceMessageId}`);
      assertTest(sameValue(ledger.records.map(item => item.recordId), ['auto', 'manual']), '手动记录没有排在现有楼层记录之后。');
      assertTest(manual?.valueBeforeTenths === 423 && manual?.valueAfterTenths === 500, '手动记录的前后值不正确。');
      assertTest(ledger.valueTenths === 500, `调整后最终值：${ledger.valueTenths}`);
      return '自动记录先算到 42.3，随后以无楼层手动记录调整到 50.0。';
    }),
  ];

  affectionTestState.suiteResults = results;
  affectionTestState.suiteStatus = results.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

function parseChangeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separatorIndex = line.indexOf('|');
      if (separatorIndex < 0) return [line, ''];
      return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
    });
}

function runChangeSimulator() {
  try {
    const result = normalizeAffectionChanges({
      entries: parseChangeLines(affectionTestState.changeLines),
    });
    affectionTestState.changeResult = result;
    affectionTestState.changeError = '';
  } catch (error) {
    affectionTestState.changeResult = null;
    affectionTestState.changeError = error?.message || String(error);
  }
}

function runLedgerSimulator() {
  try {
    const initialValueTenths = parseAffectionValueTenths(affectionTestState.ledgerInitialValue);
    if (initialValueTenths === null) throw new Error('初始好感必须是 0—100、最多一位小数。');

    const records = JSON.parse(affectionTestState.ledgerRecords || '[]');
    if (!Array.isArray(records)) throw new Error('账本记录必须是 JSON 数组。');

    const ledger = recalculateAffectionLedger(initialValueTenths, records);
    const targetValueTenths = parseAffectionValueTenths(affectionTestState.ledgerTargetValue);
    const manualRecord = targetValueTenths === null ? null : createManualAffectionAdjustmentRecord({
      initialValueTenths,
      records: ledger.records,
      targetValueTenths,
      recordId: 'manual:test-area',
      createdAt: new Date().toISOString(),
    });
    const adjustedLedger = manualRecord
      ? recalculateAffectionLedger(initialValueTenths, [...ledger.records, manualRecord])
      : ledger;

    affectionTestState.ledgerResult = {
      orderedValue: formatAffectionValueTenths(ledger.valueTenths),
      ledger,
      manualTarget: targetValueTenths === null ? '未提供' : formatAffectionValueTenths(targetValueTenths),
      manualRecord,
      adjustedValue: formatAffectionValueTenths(adjustedLedger.valueTenths),
      adjustedLedger,
    };
    affectionTestState.ledgerError = '';
  } catch (error) {
    affectionTestState.ledgerResult = null;
    affectionTestState.ledgerError = error?.message || String(error);
  }
}

function runAffectionSettingsSuite() {
  const results = [
    runModelTest('全局默认设置字段完整且唯一', () => {
      const holder = { modules: {} };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: false,
        mode: 'normal',
        defaultBuildMode: 'custom',
        profileBuildApiMode: 'secondary_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      assertTest(sameValue(Object.keys(actual), [
        'enabled', 'mode', 'defaultBuildMode', 'profileBuildApiMode',
      ]), `实际字段：${JSON.stringify(Object.keys(actual))}`);
      return '只生成四个已定稿的全局字段。';
    }),
    runModelTest('非法枚举和损坏开关回落到安全默认值', () => {
      const holder = {
        modules: {
          affection: {
            enabled: 'true',
            mode: 'broken',
            defaultBuildMode: 'unknown',
            profileBuildApiMode: 'third_api',
            extra: 'remove-me',
          },
        },
      };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: false,
        mode: 'normal',
        defaultBuildMode: 'custom',
        profileBuildApiMode: 'secondary_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      return '损坏布尔值、非法枚举与多余字段均已安全规范化。';
    }),
    runModelTest('合法模式枚举保持兼容但不扩展第一版 UI', () => {
      const holder = {
        modules: {
          affection: {
            enabled: true,
            mode: 'reverse',
            defaultBuildMode: 'generic',
            profileBuildApiMode: 'main_api',
          },
        },
      };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: true,
        mode: 'reverse',
        defaultBuildMode: 'generic',
        profileBuildApiMode: 'main_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      return '数据层保留 reverse 枚举兼容；本测试区未提供 reverse 操作入口。';
    }),
    runModelTest('旧草案字段迁移且 off 不会误开启攻略', () => {
      const holder = {
        modules: {
          affection: {
            enabled: true,
            mode: 'off',
            buildMode: 'generic',
            apiMode: 'main_api',
          },
        },
      };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: false,
        mode: 'normal',
        defaultBuildMode: 'generic',
        profileBuildApiMode: 'main_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      return '旧 off 被迁移为 enabled=false，旧建档/API 字段映射到正式字段。';
    }),
    runModelTest('聊天态只保留三个独立数据容器', () => {
      const holder = {
        affectionSystem: {
          profiles: null,
          pendingByMessage: [],
          buildTasks: 'broken',
          mode: 'reverse',
          buildMode: 'generic',
          profileBuildApiMode: 'main_api',
        },
      };
      const actual = getAffectionSystemState(holder);
      assertTest(sameValue(actual, {
        profiles: {},
        pendingByMessage: {},
        buildTasks: {},
      }), `实际结果：${JSON.stringify(actual)}`);
      return '损坏容器已修复，聊天态未复制任何全局模式字段。';
    }),
    runModelTest('顶层模块和 affectionSystem 损坏时可完整重建', () => {
      const globalHolder = { modules: [] };
      const chatHolder = { affectionSystem: [] };
      const settings = getAffectionSettings(globalHolder);
      const system = getAffectionSystemState(chatHolder);
      assertTest(settings.enabled === false && settings.mode === 'normal', `全局设置：${JSON.stringify(settings)}`);
      assertTest(sameValue(Object.keys(system).sort(), ['pendingByMessage', 'profiles'].sort()) || (system.profiles && system.pendingByMessage && !Object.hasOwn(system, 'buildTasks')), `聊天态：${JSON.stringify(system)}`);
      return '数组、空值等损坏顶层结构会回落为完整安全默认值。';
    }),
    runModelTest('profile key 只采用保守规范化角色名', () => {
      const holder = {
        affectionSystem: {
          profiles: {
            'storage-key': {
              roleName: '  沈 青  ',
              characterId: 'world-card-id',
              uuid: 'fake-uuid',
              aliases: ['阿青'],
            },
            ' 阿 蛮 ': {
              initialValueTenths: 100,
            },
            duplicate: {
              roleName: '沈青',
              initialValueTenths: 999,
            },
          },
          pendingByMessage: {},
          buildTasks: {},
        },
      };
      const actual = getAffectionSystemState(holder);
      assertTest(sameValue(Object.keys(actual.profiles), ['沈青', '阿蛮']), `实际 key：${JSON.stringify(Object.keys(actual.profiles))}`);
      assertTest(actual.profiles['沈青'].roleName === '沈青', 'profile.roleName 未同步规范化。');
      assertTest(!Object.hasOwn(actual.profiles, 'world-card-id') && !Object.hasOwn(actual.profiles, 'fake-uuid'), '角色卡或 UUID 被误作 profile key。');
      assertTest(getAffectionProfileKey(' 苏 暮 香 ') === '苏暮香', '角色名键函数未复用 model 的保守规范化。');
      return '角色卡 ID、UUID、aliases 均未参与身份键推断，同名保留首条档案。';
    }),
    runModelTest('旧数组草案可按显式 roleName 恢复', () => {
      const holder = {
        affectionSystem: {
          profiles: [
            { roleName: ' 苏 暮 香 ', initialValueTenths: 300 },
            { name: '没有 roleName', characterId: 'not-a-role' },
          ],
        },
      };
      const actual = getAffectionSystemState(holder);
      assertTest(sameValue(Object.keys(actual.profiles), ['苏暮香']), `实际 key：${JSON.stringify(Object.keys(actual.profiles))}`);
      assertTest(Object.hasOwn(actual, 'profiles') && Object.hasOwn(actual, 'pendingByMessage') && !Object.hasOwn(actual, 'buildTasks'), '聊天态字段应仅含 profiles/pendingByMessage。');
      return '只迁移带显式 roleName 的旧数组条目。';
    }),
  ];

  affectionTestState.settingsSuiteResults = results;
  affectionTestState.settingsSuiteStatus = results.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

function runSettingsMigrationPreview() {
  try {
    const source = JSON.parse(affectionTestState.settingsMigrationInput || '{}');
    const globalSettings = cloneData(source.globalSettings || {});
    const chatState = cloneData(source.chatState || {});
    const affectionSettings = getAffectionSettings(globalSettings);
    const affectionSystem = getAffectionSystemState(chatState);
    affectionTestState.settingsMigrationResult = {
      affectionSettings,
      affectionSystem,
      persistedGlobalFields: Object.keys(affectionSettings),
      persistedChatFields: Object.keys(affectionSystem),
      profileKeys: Object.keys(affectionSystem.profiles),
      note: '本次预览只修改解析后的页面内存副本。',
    };
    affectionTestState.settingsMigrationStatus = 'passed';
    affectionTestState.settingsMigrationError = '';
  } catch (error) {
    affectionTestState.settingsMigrationResult = null;
    affectionTestState.settingsMigrationStatus = 'failed';
    affectionTestState.settingsMigrationError = error?.message || String(error);
  }
}

function runAffectionStorageProbe() {
  const diagnostics = getStorageDiagnostics();
  if (!diagnostics.hasExtensionSettings || !diagnostics.hasChatMetadata) {
    affectionTestState.storageProbeStatus = 'failed';
    affectionTestState.storageProbeResult = null;
    affectionTestState.storageProbeError = '需要先进入一个可保存 metadata 的聊天，并确保扩展设置已就绪。';
    return;
  }

  const settings = getGlobalSettings();
  const chatState = getChatState();
  const globalSnapshot = cloneData(settings.modules?.affection || {});
  const chatSnapshot = cloneData(chatState.affectionSystem || {});
  const probeKey = `settings-probe:${Date.now()}`;
  let readback = null;
  let probeError = null;
  let restored = false;

  try {
    settings.modules.affection = {
      enabled: true,
      mode: 'normal',
      defaultBuildMode: 'generic',
      profileBuildApiMode: 'main_api',
    };
    const system = getAffectionSystemState(chatState);
    system.pendingByMessage = system.pendingByMessage || {}; /* buildTasks retired */
    saveGlobalSettings();
    saveChatState();

    const readSettings = getAffectionSettings(getGlobalSettings());
    const readSystem = getAffectionSystemState(getChatState());
    readback = {
      settings: cloneData(readSettings),
      buildTask: null,
    };
    assertTest(readSettings.enabled === true, '全局 enabled 未读回。');
    assertTest(readSettings.defaultBuildMode === 'generic', '全局建档模式未读回。');
    assertTest(readSettings.profileBuildApiMode === 'main_api', '全局建档 API 模式未读回。');
    assertTest(true, 'buildTasks 已退役。');
  } catch (error) {
    probeError = error;
  } finally {
    try {
      settings.modules.affection = globalSnapshot;
      chatState.affectionSystem = chatSnapshot;
      saveGlobalSettings();
      saveChatState();
      restored = true;
    } catch (restoreError) {
      probeError = probeError || restoreError;
    }
  }

  affectionTestState.storageProbeResult = {
    probeKey,
    readback,
    restored,
    note: restored ? '原全局设置与当前聊天好感状态已恢复。' : '恢复未完成，请查看错误。',
  };
  affectionTestState.storageProbeStatus = !probeError && restored ? 'passed' : 'failed';
  affectionTestState.storageProbeError = probeError?.message || String(probeError || '');
}

async function runAffectionSharedCoreSuite() {
  const tests = [
    ['中性 fingerprint 对同内容稳定、对不同 swipe 可区分', async () => {
      const first = createMessageContentFingerprint('沈青看向 {{user}}。\n她略微放松。');
      const same = createMessageContentFingerprint('  沈青看向 {{user}}。   她略微放松。  ');
      const different = createMessageContentFingerprint('沈青移开了视线。');
      assertTest(Boolean(first) && first === same, `同内容指纹不稳定：${first} / ${same}`);
      assertTest(first !== different, `不同内容得到相同指纹：${first}`);
      return `稳定指纹 ${first}，不同 swipe 指纹 ${different}。`;
    }],
    ['pending 协调器：无处理器', async () => {
      const results = await runPendingCommitHandlers([], { source: 'test-area' });
      assertTest(Array.isArray(results) && results.length === 0, `实际结果：${JSON.stringify(results)}`);
      return '无处理器时直接返回空结果。';
    }],
    ['pending 协调器：单处理器成功', async () => {
      const calls = [];
      const results = await runPendingCommitHandlers([
        ['emotion', async context => {
          calls.push(context.source);
          return 'emotion-ok';
        }],
      ], { source: 'single' });
      assertTest(sameValue(calls, ['single']), `调用记录：${JSON.stringify(calls)}`);
      assertTest(results[0]?.status === 'fulfilled' && results[0]?.value === 'emotion-ok', `实际结果：${JSON.stringify(results)}`);
      return '单处理器收到上下文并正常返回。';
    }],
    ['pending 协调器：处理器抛错不阻断后续', async () => {
      const calls = [];
      const results = await runPendingCommitHandlers([
        ['emotion', async () => {
          calls.push('emotion');
          throw new Error('模拟情感提交失败');
        }],
        ['affection', async () => {
          calls.push('affection');
          return 'affection-ok';
        }],
      ]);
      assertTest(sameValue(calls, ['emotion', 'affection']), `调用顺序：${JSON.stringify(calls)}`);
      assertTest(results[0]?.status === 'rejected' && results[1]?.status === 'fulfilled', `实际结果：${JSON.stringify(results)}`);
      return '首个失败被隔离，后续好感处理器仍成功执行。';
    }],
    ['pending 协调器：双处理器依次成功', async () => {
      const calls = [];
      const results = await runPendingCommitHandlers([
        ['emotion', async () => calls.push('emotion')],
        ['affection', async () => calls.push('affection')],
      ]);
      assertTest(sameValue(calls, ['emotion', 'affection']), `调用顺序：${JSON.stringify(calls)}`);
      assertTest(results.every(result => result.status === 'fulfilled'), `实际结果：${JSON.stringify(results)}`);
      return '情感与好感按注册顺序独立完成。';
    }],
    ['处理器注册同 id 去重且可安全清理', async () => {
      const id = `affection-test:${Date.now()}`;
      const firstHandler = async () => 'first';
      const secondHandler = async () => 'second';
      const unregisterFirst = registerPendingCommitHandler(id, firstHandler);
      const unregisterSecond = registerPendingCommitHandler(id, secondHandler);
      try {
        assertTest(getPendingCommitHandlerIds().filter(item => item === id).length === 1, '同 id 产生了重复处理器。');
        unregisterFirst();
        assertTest(getPendingCommitHandlerIds().includes(id), '旧注销函数误删了新处理器。');
      } finally {
        unregisterSecond();
      }
      assertTest(!getPendingCommitHandlerIds().includes(id), '模拟处理器未清理。');
      return '同 id 覆盖注册，测试结束后 registry 已恢复。';
    }],
    ['共享事件注册重复调用仍保持单例', async () => {
      const pendingFirst = registerPendingCommitEvents();
      const pendingSecond = registerPendingCommitEvents();
      const sanitizerFirst = registerPromptStateLineSanitizerEvents();
      const sanitizerSecond = registerPromptStateLineSanitizerEvents();
      assertTest(pendingFirst && pendingSecond && isPendingCommitEventRegistered(), 'MESSAGE_SENT 协调器事件未保持注册。');
      assertTest(sanitizerFirst && sanitizerSecond && isPromptStateLineSanitizerRegistered(), 'prompt-ready 剥离事件未保持注册。');
      return '两类共享事件重复初始化均复用既有监听。';
    }],
    ['普通正文剥离 emotion 与旧 affection 控制行，内部总结完整保留', async () => {
      const ordinary = { chat: [{ role: 'user', content: DEFAULT_STATE_LINE_INPUT }] };
      const ordinaryResult = sanitizeChatCompletionPromptStateLines(ordinary);
      assertTest(ordinaryResult.skipped === false && ordinaryResult.changedMessages === 1, `普通正文结果：${JSON.stringify(ordinaryResult)}`);
      assertTest(!/\[(?:emotion_changed|affection_changed)\s*:/i.test(ordinary.chat[0].content), `普通正文仍含 changed 控制行：${ordinary.chat[0].content}`);
      assertTest(ordinary.chat[0].content.includes('[emotion:'), 'emotion 状态行被误删。');
      assertTest(ordinary.chat[0].content.includes('[affection:沈青|0.1|35.2]'), '三段 affection 历史行被误删或改写。');
      assertTest(ordinary.chat[0].content.includes('[affection_first:'), 'affection_first 初始好感行被误删。');
      assertTest(ordinary.chat[0].content.includes('[plot:'), '普通 memory 字段被误删。');

      const multipart = {
        chat: [{
          role: 'user',
          content: [
            { type: 'text', text: DEFAULT_STATE_LINE_INPUT },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } },
          ],
        }],
      };
      sanitizeChatCompletionPromptStateLines(multipart);
      assertTest(!/\[(?:emotion_changed|affection_changed)\s*:/i.test(multipart.chat[0].content[0].text), '多段文本中的 changed 控制行未剥离。');
      assertTest(multipart.chat[0].content[0].text.includes('[emotion:') && multipart.chat[0].content[0].text.includes('[affection:沈青|0.1|35.2]'), '多段文本中的状态数据被误删。');
      assertTest(multipart.chat[0].content[0].text.includes('[affection_first:阿蛮|25.0]'), '多段文本中的 affection_first 被误删。');
      assertTest(multipart.chat[0].content[1].type === 'image_url', '非文本内容段被误改。');

      const internalContent = `现在是梦境小总结模块\n${DEFAULT_STATE_LINE_INPUT}`;
      const internal = { chat: [{ role: 'system', content: internalContent }] };
      const internalResult = sanitizeChatCompletionPromptStateLines(internal);
      assertTest(internalResult.skipped === true && internal.chat[0].content === internalContent, '内部小总结材料被误剥离。');
      return '普通字符串/多段文本删除 emotion_changed，并兼容清理旧 affection_changed；emotion/三段 affection/affection_first 均保留，内部小总结原文未变。';
    }],
  ];

  const results = [];
  for (const [title, run] of tests) {
    results.push(await runAsyncTest(title, run));
  }
  affectionTestState.sharedCoreSuiteResults = results;
  affectionTestState.sharedCoreSuiteStatus = results.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

function runStateLineSimulator() {
  try {
    const original = affectionTestState.stateLineInput;
    if (affectionTestState.stateLineMode === 'internal') {
      const eventData = {
        chat: [{ role: 'system', content: `现在是梦境小总结模块\n${original}` }],
      };
      const result = sanitizeChatCompletionPromptStateLines(eventData);
      affectionTestState.stateLineResult = {
        mode: 'internal',
        result,
        output: eventData.chat[0].content,
      };
    } else {
      affectionTestState.stateLineResult = {
        mode: 'ordinary',
        output: stripInlineStateLinesForSendingText(original),
      };
    }
    affectionTestState.stateLineStatus = 'passed';
    affectionTestState.stateLineError = '';
  } catch (error) {
    affectionTestState.stateLineResult = null;
    affectionTestState.stateLineStatus = 'failed';
    affectionTestState.stateLineError = error?.message || String(error);
  }
}

function createActiveAffectionTestSettings() {
  return {
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
  };
}

function createExistingAffectionProfiles() {
  return {
    沈青: {
      roleName: '沈青',
      initialValueTenths: 350,
      valueTenths: 350,
      records: [],
    },
  };
}

function runAffectionFieldSuite() {
  const tests = [
    runModelTest('攻略提示词受总开关、自动小总结和好感开关共同门控', () => {
      const activeSettings = createActiveAffectionTestSettings();
      const chatState = {
        affectionSystem: { profiles: createExistingAffectionProfiles(), pendingByMessage: {}, buildTasks: {} },
      };
      const prompt = buildAffectionUpdatePromptSection(activeSettings, chatState);
      assertTest(!prompt.includes('[affection_changed:'), '提示词仍要求 affection_changed。');
      assertTest(prompt.includes('无实质性交流或互动时输出 0'), '提示词没有要求无变化时输出 0。');
      assertTest(!prompt.includes('[affection_first:'), '默认提示词不应再要求 affection_first。');
      assertTest(!prompt.includes('AI 只输出两段 affection'), '用户删除的两段 affection 说明句仍存在。');
      assertTest(prompt.includes('已有正式好感档案') || prompt.includes('已建档角色'), '提示词应只针对已建档角色。');
      assertTest(prompt.includes('【沈青】已建档'), '提示词没有带入已知正式档案。');
      assertTest(buildAffectionUpdatePromptSection({ ...activeSettings, enabled: false }, chatState) === '', '插件总开关关闭后仍追加提示词。');
      const summaryOff = cloneData(activeSettings);
      summaryOff.modules.summary.enabled = false;
      assertTest(buildAffectionUpdatePromptSection(summaryOff, chatState) === '', '自动小总结关闭后仍追加提示词。');
      const affectionOff = cloneData(activeSettings);
      affectionOff.modules.affection.enabled = false;
      assertTest(buildAffectionUpdatePromptSection(affectionOff, chatState) === '', '好感开关关闭后仍追加提示词。');
      return '三项依赖全部开启时才追加攻略判断，并列出已建档角色。';
    }),
    runModelTest('0 判断保留角色与当前值但不形成数值变化', () => {
      const analysis = parseAffectionUpdateFromMemory(`<memory>
[affection:沈青|0]
</memory>`, { profiles: createExistingAffectionProfiles() });
      assertTest(analysis.changes[0]?.valueBeforeTenths === 350, '变化前值不是 35.0。');
      assertTest(analysis.changes[0]?.valueAfterTenths === 350, '0 判断改变了当前好感。');
      assertTest(analysis.changed === false, '0 判断被标记为实际变化。');
      assertTest(analysis.normalizedMemory.includes('[affection:沈青|0|35.0]'), '没有写回 0 与当前好感。');
      return '本轮保留“沈青 0 / 当前 35.0”，但 changed=false，后续不应生成正式增减记录。';
    }),
    runModelTest('affection_first 可单独形成首次数据', () => {
      const analysis = parseAffectionUpdateFromMemory(`<memory>
[affection_first:苏暮香|85.0]
</memory>`, { profiles: createExistingAffectionProfiles() });
      assertTest(analysis.changed === false && analysis.changes.length === 0, 'first 单独出现时产生了变化。');
      assertTest(analysis.firsts[0]?.roleName === '苏暮香' && analysis.firsts[0]?.initialValueTenths === 850, '首次好感未独立解析。');
      assertTest(analysis.normalizedMemory.includes('[affection_first:苏暮香|85.0]'), '首次好感未保留。');
      return '无本轮变化时仍可独立记录未建档角色的 85.0 初值。';
    }),
    runModelTest('first/affection 冲突按是否已建档分流', () => {
      const unprofiled = parseAffectionUpdateFromMemory(`<memory>
[affection:阿蛮|0.2]
[affection_first:阿蛮|35.0]
</memory>`, { profiles: createExistingAffectionProfiles() });
      assertTest(unprofiled.changed === false && unprofiled.changes.length === 0, '未建档角色的同轮 affection 没有被丢弃。');
      assertTest(unprofiled.firsts[0]?.roleName === '阿蛮' && unprofiled.firsts[0]?.initialValueTenths === 350, '未建档角色的 first 没有保留。');
      assertTest(!unprofiled.normalizedMemory.includes('[affection:阿蛮'), '未建档角色仍写回了 affection。');
      assertTest(unprofiled.normalizedMemory.includes('[affection_first:阿蛮|35.0]'), '未建档角色没有写回 first。');
      assertTest(unprofiled.diagnostics.some(item => item.code === 'first_suppresses_same_turn_change'), '缺少 first 优先诊断。');

      const profiled = parseAffectionUpdateFromMemory(`<memory>
[affection:沈青|0.2]
[affection_first:沈青|35.0]
</memory>`, { profiles: createExistingAffectionProfiles() });
      assertTest(profiled.changes[0]?.valueAfterTenths === 352, '已建档角色的 affection 没有按账本保留。');
      assertTest(profiled.firsts.length === 0, '已建档角色的错误 first 没有被丢弃。');
      assertTest(profiled.normalizedMemory.includes('[affection:沈青|0.2|35.2]'), '已建档角色没有写回三段 affection。');
      assertTest(!profiled.normalizedMemory.includes('[affection_first:沈青'), '已建档角色仍写回了 first。');
      assertTest(profiled.diagnostics.some(item => item.code === 'first_already_profiled'), '缺少已有档案 first 诊断。');
      return '未建档：只保留 first；已建档：只保留 affection，并由正式账本补全当前值。';
    }),
    runModelTest('非法值、重复角色与已有档案 first 均留下诊断', () => {
      const analysis = parseAffectionUpdateFromMemory(`<memory>
[affection:沈青|5]
[affection:沈青|0.2]
[affection_first:沈青|40.0]
[affection_first:阿蛮|999]
[affection_first:阿蛮|35.0]
[affection_first:阿蛮|40.0]
</memory>`, { profiles: createExistingAffectionProfiles() });
      const codes = new Set(analysis.diagnostics.map(item => item.code));
      assertTest(analysis.changes.length === 1 && analysis.changes[0].deltaTenths === 2, '合法变化没有保留。');
      assertTest(analysis.firsts.length === 1 && analysis.firsts[0].initialValueTenths === 350, '合法 first 没有唯一保留。');
      assertTest(codes.has('invalid_delta'), '缺少非法 delta 诊断。');
      assertTest(codes.has('first_already_profiled'), '缺少已有档案 first 诊断。');
      assertTest(codes.has('first_invalid_initial_value'), '缺少非法初值诊断。');
      assertTest(codes.has('first_duplicate_role'), '缺少 first 重复角色诊断。');
      return '非法行均被拒绝，合法变化和首次初值保留并附具体诊断。';
    }),
    runModelTest('未建档角色缺少 affection_first 时拒绝变化', () => {
      const analysis = parseAffectionUpdateFromMemory(`<memory>
[affection:陌生路人|0.1]
</memory>`, { profiles: createExistingAffectionProfiles() });
      assertTest(analysis.changed === false && analysis.changes.length === 0, '无法确定当前值的变化仍被接受。');
      assertTest(analysis.diagnostics.some(item => item.code === 'change_without_profile_or_first'), '缺少未建档且无 first 的诊断。');
      assertTest(!analysis.normalizedMemory.includes('[affection:'), '无基准值的 affection 仍被写回楼层。');
      return '没有正式档案或 first 时无法计算 valueAfter，因此拒绝该变化。';
    }),
    runModelTest('同 messageId 的不同 fingerprint 分别保存 pending', () => {
      const profiles = createExistingAffectionProfiles();
      const chatState = {
        affectionSystem: { profiles, pendingByMessage: {}, buildTasks: {} },
      };
      const first = parseAffectionUpdateFromMemory('<memory>\n[affection:沈青|0.1]\n</memory>', { profiles });
      const second = parseAffectionUpdateFromMemory('<memory>\n[affection:沈青|-0.2]\n</memory>', { profiles });
      storePendingAffectionUpdate({ messageId: 20, fingerprint: 'swipe-a', analysis: first }, { chatState, persist: false });
      storePendingAffectionUpdate({ messageId: 20, fingerprint: 'swipe-b', analysis: second }, { chatState, persist: false });
      const items = chatState.affectionSystem.pendingByMessage['20'].items;
      assertTest(sameValue(Object.keys(items), ['swipe-a', 'swipe-b']), `pending keys：${JSON.stringify(Object.keys(items))}`);
      assertTest(items['swipe-a'].changes[0].deltaTenths === 1 && items['swipe-b'].changes[0].deltaTenths === -2, '两个 swipe 的变化互相覆盖。');
      return 'swipe-a 与 swipe-b 在同一楼层下独立保存。';
    }),
    runModelTest('正式写回剥离 emotion_changed 并保留好感数据', () => {
      const analysis = parseAffectionUpdateFromMemory(`<memory>
[emotion_changed:false]
[affection:沈青|0.2]
[affection_first:阿蛮|35.0]
</memory>`, { profiles: createExistingAffectionProfiles() });
      const written = stripMemoryChangedControlLines(analysis.normalizedMemory);
      assertTest(!/\[(?:emotion_changed|affection_changed)\s*:/i.test(written), 'changed 控制行仍存在。');
      assertTest(written.includes('[affection:沈青|0.2|35.2]'), '三段 affection 被误删。');
      assertTest(written.includes('[affection_first:阿蛮|35.0]'), 'affection_first 被误删。');
      return '新协议不含 affection_changed；emotion_changed 被剥离，三段历史与首次初值完整保留。';
    }),
  ];

  affectionTestState.fieldSuiteResults = tests;
  affectionTestState.fieldSuiteStatus = tests.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

function runAffectionFieldSimulator() {
  try {
    const profiles = JSON.parse(affectionTestState.fieldProfilesInput || '{}');
    if (!profiles || Array.isArray(profiles) || typeof profiles !== 'object') {
      throw new Error('模拟 profiles 必须是以角色名为 key 的 JSON 对象。');
    }
    const analysis = parseAffectionUpdateFromMemory(
      affectionTestState.fieldMemoryInput,
      { profiles },
    );
    if (!analysis) throw new Error('输入中没有 affection 或 affection_first。');

    const chatState = {
      affectionSystem: {
        profiles,
        pendingByMessage: cloneData(affectionTestState.fieldPendingByMessage),
        buildTasks: {},
      },
    };
    const fingerprint = `simulated:${affectionTestState.fieldSwipe}`;
    const pending = storePendingAffectionUpdate(
      { messageId: 20, fingerprint, analysis },
      { chatState, persist: false },
    );
    affectionTestState.fieldPendingByMessage = cloneData(chatState.affectionSystem.pendingByMessage);
    affectionTestState.fieldResult = {
      selectedSwipe: affectionTestState.fieldSwipe,
      fingerprint,
      parsed: {
        changed: analysis.changed,
        changes: analysis.changes,
        firsts: analysis.firsts,
        diagnostics: analysis.diagnostics,
        raw: analysis.raw,
      },
      normalizedMemoryBeforeControlStrip: analysis.normalizedMemory,
      writtenMemory: stripMemoryChangedControlLines(analysis.normalizedMemory),
      pending,
      pendingSnapshot: affectionTestState.fieldPendingByMessage,
    };
    affectionTestState.fieldStatus = 'passed';
    affectionTestState.fieldError = '';
  } catch (error) {
    affectionTestState.fieldResult = null;
    affectionTestState.fieldStatus = 'failed';
    affectionTestState.fieldError = error?.message || String(error);
  }
}

function createBuildTestSettings(buildMode) {
  return {
    enabled: true,
    modules: {
      summary: { enabled: true },
      affection: {
        enabled: true,
        mode: 'normal',
        defaultBuildMode: buildMode,
        profileBuildApiMode: 'secondary_api',
      },
    },
  };
}

function createMockCustomStages() {
  return {
    roleName: '模型可能返回的错误名称',
    stages: Array.from({ length: 5 }, (_, index) => ({
      range: '模型范围不可信',
      name: `角色阶段${index + 1}`,
      meaning: `第${index + 1}阶段的关系含义`,
      behaviors: [`行为${index + 1}-A`, `行为${index + 1}-B`, `行为${index + 1}-C`],
      trend: `第${index + 1}阶段的递进趋势`,
      boundary: `第${index + 1}阶段的关系边界`,
    })),
  };
}

function createBuildTestPending(initialValueTenths = 350) {
  return {
    messageId: 20,
    fingerprint: 'swipe-a',
    firsts: [{ roleName: '阿蛮', initialValueTenths }],
    diagnostics: [],
  };
}

function createBuildTestChatState() {
  return {
    affectionSystem: { profiles: {}, pendingByMessage: {}, buildTasks: {} },
  };
}

function createBuildTestOptions(chatState, settings, overrides = {}) {
  return {
    settings,
    chatState,
    chatId: 'chat-a',
    persist: false,
    getCurrentSnapshot: () => ({ chatId: 'chat-a', fingerprint: 'swipe-a', active: true }),
    getCurrentChatState: () => chatState,
    resolveContextMaterial: async () => '模拟角色与关系材料',
    ...overrides,
  };
}

export async function runAffectionBuildSuite() {

  const tests = [{
    title: '自动首次建档链已于 Phase C 退役',
    status: 'passed',
    detail: 'buildTasks / affection_first / 自动 Profile Build 已删除；请使用「新建角色档案」手动建档。',
  }];
  affectionTestState.buildSuiteResults = tests;
  affectionTestState.buildSuiteStatus = 'passed';
  return tests;
}

async function runAffectionBuildSimulator() {

  affectionTestState.buildResult = {
    status: 'retired',
    detail: '自动首次建档模拟器已退役，请使用手动新建档案。',
  };
  affectionTestState.buildStatus = 'passed';
  return affectionTestState.buildResult;
}

async function runAffectionBuildRealApiPreview() {

  affectionTestState.buildResult = {
    status: 'retired',
    detail: '自动首次建档模拟器已退役，请使用手动新建档案。',
  };
  affectionTestState.buildStatus = 'passed';
  return affectionTestState.buildResult;
}

function createCommitTestProfile(roleName = '沈青', initialValueTenths = 350, records = []) {
  const ledger = recalculateAffectionLedger(initialValueTenths, records);
  return {
    roleName,
    initialValueTenths,
    valueTenths: ledger.valueTenths,
    buildMode: 'generic',
    buildStatus: 'ready',
    stages: createGenericCommitTestStages(),
    records: ledger.records,
    createdAt: '2026/7/15 10:00:00',
    updatedAt: '2026/7/15 10:00:00',
  };
}

function createGenericCommitTestStages() {
  return Array.from({ length: 5 }, (_, index) => ({
    stageId: `S${index + 1}`,
    minTenths: index === 0 ? 0 : index * 200 + 1,
    maxTenths: (index + 1) * 200,
    name: `测试阶段${index + 1}`,
    meaning: `测试关系${index + 1}`,
    behaviors: ['行为A', '行为B', '行为C'],
    trend: '继续发展',
    boundary: '不越级',
  }));
}

function createCommitPending(messageId, fingerprint, { changes = [], firsts = [] } = {}) {
  return {
    messageId,
    fingerprint,
    changed: changes.some(item => Number(item.deltaTenths) !== 0),
    changes: changes.map(item => ({ ...item })),
    firsts: firsts.map(item => ({ ...item })),
    diagnostics: [],
    raw: {},
    updatedAt: '2026/7/15 10:00:00',
  };
}

function putCommitPending(chatState, messageId, items) {
  chatState.affectionSystem.pendingByMessage[String(messageId)] = {
    messageId,
    items,
    updatedAt: '2026/7/15 10:00:00',
  };
}

function createReadyCommitTask(chatState, {
  chatId = 'chat-a',
  messageId = 20,
  fingerprint = 'swipe-a',
  roleName = '阿蛮',
  initialValueTenths = 350,
} = {}) {
  const taskKey = createAffectionBuildTaskKey({ chatId, messageId, fingerprint, roleName });
  const profileDraft = createCommitTestProfile(roleName, initialValueTenths);
  const task = {
    taskKey,
    buildRequestId: `test:${fingerprint}:${roleName}`,
    chatId,
    messageId,
    fingerprint,
    roleName,
    initialValueTenths,
    buildMode: 'generic',
    apiMode: 'secondary_api',
    buildStatus: 'ready',
    stages: profileDraft.stages,
    profileDraft,
    createdAt: '2026/7/15 10:00:00',
    updatedAt: '2026/7/15 10:00:00',
  };
  chatState.affectionSystem.buildTasks[taskKey] = task;
  return task;
}

function createCommitOptions(chatState, selectedFingerprint) {
  return {
    settings: createBuildTestSettings('generic'),
    chatState,
    chatId: 'chat-a',
    persist: false,
    getSelectedFingerprint: () => selectedFingerprint,
  };
}

export async function runAffectionCommitSuite() {

  const tests = [];
  tests.push(await runAsyncTest('已建档角色 confirmed 提交仅写数值账本', async () => {
    const chatState = {
      affectionSystem: {
        profiles: {
          沈青: {
            roleName: '沈青',
            initialValueTenths: 350,
            valueTenths: 350,
            stages: createGenericAffectionStages(),
            records: [],
          },
        },
        pendingByMessage: {},
      },
    };
    const memory = '<memory>\n[affection:沈青|0.1]\n[affection_first:阿蛮|20.0]\n</memory>';
    const result = await commitAffectionUpdateFromConfirmedSummary(memory, {
      messageId: 9,
      chatState,
      settings: getGlobalSettings(),
      persist: false,
      isCurrentChat: () => true,
    });
    assertTest(result?.committedRoleNames?.includes('沈青'), '未提交已建档角色变化。');
    assertTest(chatState.affectionSystem.profiles.沈青.valueTenths === 351, '账本未更新。');
    assertTest(!chatState.affectionSystem.profiles.阿蛮, '废弃 affection_first 不应建档。');
    assertTest(!Object.hasOwn(chatState.affectionSystem, 'buildTasks'), '不应再出现 buildTasks。');
    return 'confirmed 只提交已有档案数值变化。';
  }));
  tests.push(await runAsyncTest('Swipe 选中 delta=0 撤销同楼自动记录', async () => {
    const chatState = {
      affectionSystem: {
        profiles: {
          沈青: {
            roleName: '沈青',
            initialValueTenths: 350,
            valueTenths: 353,
            stages: createGenericAffectionStages(),
            records: [{
              recordId: 'old',
              sourceMessageId: 20,
              sourceFingerprint: 'a',
              deltaTenths: 3,
              sourceType: 'auto',
              createdAt: 't',
            }],
          },
        },
        pendingByMessage: {
          20: {
            messageId: 20,
            items: {
              zero: {
                messageId: 20,
                fingerprint: 'zero',
                changes: [{ roleName: '沈青', deltaTenths: 0 }],
                origin: 'legacy',
              },
            },
          },
        },
      },
    };
    const result = await commitSelectedPendingAffectionUpdates({
      chatState,
      settings: getGlobalSettings(),
      persist: false,
      getSelectedFingerprint: () => 'zero',
    });
    assertTest(result.committedMessageIds.includes(20), '未提交选中 swipe。');
    assertTest(chatState.affectionSystem.profiles.沈青.records.length === 0, 'delta=0 未撤销旧记录。');
    assertTest(chatState.affectionSystem.profiles.沈青.valueTenths === 350, '撤销后初值不对。');
    return 'Swipe 选中与 delta=0 撤销正常。';
  }));
  affectionTestState.commitSuiteResults = tests;
  affectionTestState.commitSuiteStatus = tests.every(item => item.status === 'passed') ? 'passed' : 'failed';
  return tests;
}

async function runAffectionCommitSimulator() {
  try {
    const selectedSwipe = affectionTestState.commitSelectedSwipe;
    const chatState = createBuildTestChatState();
    chatState.affectionSystem.profiles.沈青 = createCommitTestProfile();
    putCommitPending(chatState, 20, {
      'swipe-a': createCommitPending(20, 'swipe-a', { changes: [{ roleName: '沈青', deltaTenths: 1 }] }),
      'swipe-b': createCommitPending(20, 'swipe-b', { changes: [{ roleName: '沈青', deltaTenths: -2 }] }),
    });
    createReadyCommitTask(chatState, { fingerprint: 'swipe-a', roleName: '阿蛮', initialValueTenths: 350 });
    const before = cloneData(chatState.affectionSystem);
    const summary = await commitSelectedPendingAffectionUpdates(createCommitOptions(chatState, selectedSwipe));
    affectionTestState.commitResult = {
      selectedSwipe,
      before,
      summary,
      after: chatState.affectionSystem,
    };
    affectionTestState.commitStatus = 'passed';
    affectionTestState.commitError = '';
  } catch (error) {
    affectionTestState.commitResult = null;
    affectionTestState.commitStatus = 'failed';
    affectionTestState.commitError = error?.message || String(error);
  }
}

function createInjectionTestChatState({ empty = false } = {}) {
  const chatState = createBuildTestChatState();
  if (!empty) {
    chatState.affectionSystem.profiles.沈青 = createCommitTestProfile('沈青', 350);
  }
  return chatState;
}

function createSetExtensionPromptRecorder() {
  const calls = [];
  return {
    calls,
    setExtensionPrompt: async (...args) => {
      calls.push(args);
    },
  };
}

export async function runAffectionInjectionSuite() {
  const tests = [];
  tests.push(await runAsyncTest('注入只包含正式当前值对应的单个阶段', async () => {
    const content = buildAffectionInjection(createInjectionTestChatState());
    assertTest(content.includes('沈青对{{user}}的好感度：35.0/100'), '没有注入正式账本当前值。');
    assertTest(content.includes('阶段「测试阶段2」'), `35.0 未命中 S2：${content}`);
    assertTest(content.includes('行为A；行为B；行为C') && content.includes('变化倾向：继续发展'), '缺少当前阶段行为或变化倾向。');
    assertTest(!content.includes('测试阶段1') && !content.includes('测试阶段3'), '注入泄露了非当前阶段。');
    assertTest(content.includes('不要播报数值或阶段名称'), '缺少禁止正文播报状态。');
    return '35.0 只注入 S2 的名称、表现、趋势和边界，不暴露完整五阶段。';
  }));
  tests.push(await runAsyncTest('攻略 active 时写入独立 prompt id 与固定槽位', async () => {
    const recorder = createSetExtensionPromptRecorder();
    const settings = createBuildTestSettings('generic');
    let latestChatState = createInjectionTestChatState();
    const result = await syncAffectionInjection({
      settings,
      chatState: latestChatState,
      setExtensionPrompt: recorder.setExtensionPrompt,
      getLatestSettings: () => settings,
      getLatestChatState: () => latestChatState,
    });
    const call = recorder.calls[0];
    assertTest(result.action === 'set' && recorder.calls.length === 1, `写入结果：${JSON.stringify(result)}`);
    assertTest(call[0] === AFFECTION_STATE_PROMPT_ID && call[0] !== 'shenling_assistant_emotion_profile_state', '未使用独立好感 prompt id。');
    assertTest(call[2] === AFFECTION_STATE_INJECT_POSITION && call[3] === 0, `槽位错误：${JSON.stringify(call.slice(0, 4))}`);
    assertTest(typeof call[6] === 'function' && call[6]() === true, '最新状态过滤函数未允许当前有效注入。');
    settings.modules.summary.enabled = false;
    assertTest(call[6]() === false, '过滤函数闭包了旧设置，关闭自动小总结后仍返回 true。');
    settings.modules.summary.enabled = true;
    latestChatState = createInjectionTestChatState({ empty: true });
    assertTest(call[6]() === false, '过滤函数闭包了旧聊天，切到空档案聊天后仍返回 true。');
    return '使用 shenling_assistant_affection_state / position=1 / depth=0，过滤器读取最新状态。';
  }));
  tests.push(await runAsyncTest('关闭依赖或内容为空时覆盖清空真实槽位', async () => {
    for (const mode of ['summary_off', 'affection_off', 'empty']) {
      const settings = createBuildTestSettings('generic');
      if (mode === 'summary_off') settings.modules.summary.enabled = false;
      if (mode === 'affection_off') settings.modules.affection.enabled = false;
      const chatState = createInjectionTestChatState({ empty: mode === 'empty' });
      const recorder = createSetExtensionPromptRecorder();
      const result = await syncAffectionInjection({
        settings,
        chatState,
        setExtensionPrompt: recorder.setExtensionPrompt,
      });
      assertTest(result.action === 'clear' && recorder.calls.length === 2, `${mode} 未执行双槽位清理。`);
      assertTest(recorder.calls.some(call => call[2] === -1), `${mode} 缺少兼容清理。`);
      assertTest(recorder.calls.some(call => call[2] === AFFECTION_STATE_INJECT_POSITION && call[3] === 0), `${mode} 没有覆盖清空真实槽位。`);
      assertTest(recorder.calls.every(call => call[1] === '' && call[6]() === false), `${mode} 清理内容或过滤器错误。`);
    }
    return '自动小总结关闭、好感关闭和无正式档案均同时清理兼容槽位与 position=1 实际槽位。';
  }));
  tests.push(await runAsyncTest('affection 与 affection_first 使用专用楼层显示格式', async () => {
    assertTest(sameValue(
      formatMemoryMultiRowParts('affection', '沈青|0.2|35.2', 3),
      ['沈青', '+0.2', '当前好感 35.2'],
    ), '正向 affection 显示错误。');
    assertTest(sameValue(
      formatMemoryMultiRowParts('affection', '沈青|-0.1|35.1', 3),
      ['沈青', '-0.1', '当前好感 35.1'],
    ), '负向 affection 显示错误。');
    assertTest(sameValue(
      formatMemoryMultiRowParts('affection', '沈青|0|35.0', 3),
      ['沈青', '0', '当前好感 35.0'],
    ), '零变化 affection 显示错误。');
    assertTest(sameValue(
      formatMemoryMultiRowParts('affection_first', '阿蛮|35.0', 2),
      ['阿蛮', '初始好感 35.0'],
    ), 'affection_first 显示错误。');
    assertTest(MEMORY_FIELD_CONFIG.affection?.enabled !== false && MEMORY_FIELD_CONFIG.affection?.pipe === 3, 'affection 字段尚未正式启用三段配置。');
    assertTest(MEMORY_FIELD_CONFIG.affection_first?.pipe === 2, 'affection_first 两段配置缺失。');
    return '正数补 +，负数/0 保留，并分别显示当前好感与初始好感。';
  }));
  tests.push(await runAsyncTest('写回剥离控制行但保留全部状态数据', async () => {
    const input = `<memory>\n[emotion_changed:false]\n[affection_changed:true]\n[emotion:沈青|朋友|平静|保持信任]\n[affection:沈青|0.2|35.2]\n[affection_first:阿蛮|35.0]\n</memory>`;
    const output = stripMemoryChangedControlLines(input);
    assertTest(!/\[(?:emotion_changed|affection_changed)\s*:/i.test(output), 'changed 控制行未完全剥离。');
    assertTest(output.includes('[emotion:沈青|朋友|平静|保持信任]'), 'emotion 数据被误删。');
    assertTest(output.includes('[affection:沈青|0.2|35.2]'), '三段 affection 被误删。');
    assertTest(output.includes('[affection_first:阿蛮|35.0]'), 'affection_first 被误删。');
    return '只删除 emotion_changed 与旧 affection_changed，三类正式状态行完整保留。';
  }));

  affectionTestState.injectionSuiteResults = tests;
  affectionTestState.injectionSuiteStatus = tests.every(item => item.status === 'passed') ? 'passed' : 'failed';
  return cloneData(tests);
}

function createUiTestChatState() {
  return {
    affectionSystem: {
      profiles: {
        沈青: {
          roleName: '沈青',
          initialValueTenths: 350,
          valueTenths: 352,
          buildMode: 'custom',
          buildStatus: 'ready',
          stages: createGenericCommitTestStages(),
          records: [{
            recordId: 'affection:auto:18:test',
            sourceMessageId: 18,
            sourceFingerprint: 'swipe-old',
            deltaTenths: 2,
            sourceType: 'auto',
            createdAt: '2026/7/15 10:00:00',
            valueBeforeTenths: 350,
            valueAfterTenths: 352,
          }],
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
              changes: [{
                roleName: '沈青',
                deltaTenths: 2,
                valueBeforeTenths: 352,
                valueAfterTenths: 354,
              }],
            },
          },
        },
      },
    },
  };
}

export async function runAffectionUiSuite() {
  affectionTestState.uiSuiteStatus = 'running';
  affectionTestState.uiSuiteResults = [];
  refreshPanel();
  const settings = createBuildTestSettings('custom');
  const results = [];

  results.push(await runAsyncTest('pending stepper 只改当前 fingerprint，并重算变化后值', async () => {
    const chatState = createUiTestChatState();
    const updated = updatePendingAffectionDelta({
      messageId: 20,
      fingerprint: 'swipe-a',
      roleName: '沈青',
      deltaTenths: 0,
    }, { chatState, persist: false });
    assertTest(updated.deltaTenths === 0 && updated.valueAfterTenths === 352, '0 变化没有按正式账本重算。');
    assertTest(chatState.affectionSystem.profiles.沈青.records.length === 1, 'pending 编辑污染了正式 records。');
    return 'deltaTenths=0 保留在 pending；正式 records 未变。';
  }));

  results.push(await runAsyncTest('放弃单项只清理 pending changes', async () => {
    const chatState = createUiTestChatState();
    const removed = discardPendingAffectionItem({
      messageId: 20,
      fingerprint: 'swipe-a',
      roleName: '沈青',
    }, { chatState, persist: false });
    assertTest(removed, '未删除待确认变化。');
    assertTest(
      !chatState.affectionSystem.pendingByMessage['20']
      || !chatState.affectionSystem.pendingByMessage['20'].items['swipe-a']
      || !(chatState.affectionSystem.pendingByMessage['20'].items['swipe-a'].changes || [])
        .some(item => item.roleName === '沈青'),
      'changes 中仍残留该角色。',
    );
    assertTest(!Object.hasOwn(chatState.affectionSystem, 'buildTasks'), '不应再出现 buildTasks。');
    return 'pending changes 可按角色放弃；buildTasks 已退役。';
  }));

  results.push(await runAsyncTest('手动校准只追加 manual_adjustment，不改初值和旧记录', async () => {
    const chatState = createUiTestChatState();
    const result = await adjustAffectionProfileValue({
      roleName: '沈青',
      targetValueTenths: 400,
    }, { settings, chatState, persist: false });
    const profile = chatState.affectionSystem.profiles.沈青;
    assertTest(result.changed && profile.valueTenths === 400, '当前值未校准到 40.0。');
    assertTest(profile.initialValueTenths === 350, '手动校准修改了 initialValueTenths。');
    assertTest(profile.records.length === 2 && profile.records.some(record => record.sourceType === 'manual_adjustment'), '未追加 manual_adjustment。');
    return '35.2 → 40.0，旧自动记录与初值均保留。';
  }));

  results.push(await runAsyncTest('确认专属阶段只替换 stages，不改账本', async () => {
    const chatState = createUiTestChatState();
    const beforeRecords = JSON.stringify(chatState.affectionSystem.profiles.沈青.records);
    const customStages = createGenericCommitTestStages().map(stage => ({ ...stage, name: `专属${stage.stageId}` }));
    await applyAffectionProfileStages({ roleName: '沈青', stages: customStages, buildMode: 'custom' }, {
      settings,
      chatState,
      persist: false,
    });
    const profile = chatState.affectionSystem.profiles.沈青;
    assertTest(profile.stages[1].name === '专属S2', '新阶段未覆盖。');
    assertTest(profile.valueTenths === 352 && JSON.stringify(profile.records) === beforeRecords, '阶段覆盖污染了正式账本。');
    return '五阶段已替换；valueTenths、initialValueTenths、records 未变。';
  }));

  results.push(await runAsyncTest('按需求重新生成只返回草稿，正式阶段继续生效', async () => {
    const chatState = createUiTestChatState();
    const beforeStages = JSON.stringify(chatState.affectionSystem.profiles.沈青.stages);
    let promptText = '';
    const result = await regenerateAffectionProfileStages({
      roleName: '沈青',
      userRequirement: '前期戒备更重，确认关系后仍不直白表达。',
      apiMode: 'main_api',
    }, {
      settings,
      chatState,
      log: false,
      resolveContextMaterial: async () => '角色核心身份：测试角色。',
      requestCustomProfile: async ({ messages }) => {
        promptText = messages.map(message => message.content || '').join('\n');
        return createMockCustomStages();
      },
    });
    assertTest(result.stages.length === 5, '未返回合法五阶段草稿。');
    assertTest(promptText.includes('前期戒备更重，确认关系后仍不直白表达'), '用户需求未进入生成提示词。');
    assertTest(JSON.stringify(chatState.affectionSystem.profiles.沈青.stages) === beforeStages, '重新生成直接覆盖了正式阶段。');
    return '需求已进入请求；API 结果仅作为编辑草稿返回。';
  }));

  results.push(await runAsyncTest('阶段手风琴与档案刻度包含可访问文本', async () => {
    const stage = createGenericCommitTestStages()[1];
    const markup = renderAffectionStageFields(stage, 1, true, [], 'S2');
    const rail = renderAffectionStageRail('沈青', 352, createGenericCommitTestStages());
    assertTest(markup.includes('aria-expanded="true"') && markup.includes('aria-controls='), '手风琴缺少展开状态或控制目标。');
    assertTest(markup.includes('当前阶段') && markup.includes('阶段名') && markup.includes('关系含义'), '当前阶段状态或可见 label 缺失。');
    assertTest(rail.includes('aria-label="沈青当前好感 35.2'), '只读刻度缺少可读状态。');
    return '手风琴、字段标签与只读刻度均提供文字状态。';
  }));

  affectionTestState.uiSuiteResults = results;
  affectionTestState.uiSuiteStatus = results.every(item => item.status === 'passed') ? 'passed' : 'failed';
  return results;
}

async function runAffectionInjectionSimulator() {
  try {
    const mode = affectionTestState.injectionMode;
    const settings = createBuildTestSettings('generic');
    if (mode === 'summary_off') settings.modules.summary.enabled = false;
    if (mode === 'affection_off') settings.modules.affection.enabled = false;
    const chatState = createInjectionTestChatState({ empty: mode === 'empty' });
    const recorder = createSetExtensionPromptRecorder();
    const result = await syncAffectionInjection({
      settings,
      chatState,
      setExtensionPrompt: recorder.setExtensionPrompt,
      getLatestSettings: () => settings,
      getLatestChatState: () => chatState,
    });
    const stripInput = `<memory>\n[emotion_changed:false]\n[affection_changed:true]\n[emotion:沈青|朋友|平静|保持信任]\n[affection:沈青|0.2|35.2]\n[affection_first:阿蛮|35.0]\n</memory>`;
    affectionTestState.injectionResult = {
      mode,
      action: result.action,
      promptId: result.promptId,
      injectionContent: result.content,
      setExtensionPromptCalls: recorder.calls.map(call => ({
        promptId: call[0],
        content: call[1],
        position: call[2],
        depth: call[3],
        filterResult: typeof call[6] === 'function' ? call[6]() : null,
      })),
      renderPreview: {
        affectionPositive: formatMemoryMultiRowParts('affection', '沈青|0.2|35.2', 3),
        affectionZero: formatMemoryMultiRowParts('affection', '沈青|0|35.0', 3),
        affectionFirst: formatMemoryMultiRowParts('affection_first', '阿蛮|35.0', 2),
      },
      stripPreview: {
        before: stripInput,
        after: stripMemoryChangedControlLines(stripInput),
      },
    };
    affectionTestState.injectionStatus = 'passed';
    affectionTestState.injectionError = '';
  } catch (error) {
    affectionTestState.injectionResult = null;
    affectionTestState.injectionStatus = 'failed';
    affectionTestState.injectionError = error?.message || String(error);
  }
}

function renderJsonResult(result, error, emptyText) {
  if (error) return `<div class="slx-affection-test-error">${escapeHtml(error)}</div>`;
  if (!result) return `<div class="slx-affection-test-empty">${escapeHtml(emptyText)}</div>`;
  return `<pre class="slx-affection-test-output">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
}

function renderSuiteResults(results = []) {
  if (!results.length) {
    return '<div class="slx-affection-test-empty">尚未运行。点击上方按钮后会逐项显示通过或失败原因。</div>';
  }

  return `
    <ul class="slx-affection-test-list">
      ${results.map(item => `
        <li class="is-${escapeHtml(item.status)}">
          <span class="slx-affection-test-mark">${item.status === 'passed' ? '✓' : '×'}</span>
          <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></span>
        </li>
      `).join('')}
    </ul>
  `;
}

function getTestStatusLabel(status, passedCount = 0, totalCount = 0) {
  if (status === 'passed') return totalCount ? `全部通过（${passedCount}/${totalCount}）` : '通过';
  if (status === 'failed') return totalCount ? `存在失败（${passedCount}/${totalCount}）` : '失败';
  if (status === 'running') return '运行中';
  return '等待测试';
}

function renderAffectionDiagnostics() {
  const passedCount = affectionTestState.suiteResults.filter(item => item.status === 'passed').length;
  const totalCount = affectionTestState.suiteResults.length;
  const suiteLabel = getTestStatusLabel(affectionTestState.suiteStatus, passedCount, totalCount);
  const settingsPassedCount = affectionTestState.settingsSuiteResults.filter(item => item.status === 'passed').length;
  const settingsTotalCount = affectionTestState.settingsSuiteResults.length;
  const settingsSuiteLabel = getTestStatusLabel(
    affectionTestState.settingsSuiteStatus,
    settingsPassedCount,
    settingsTotalCount,
  );
  const sharedCorePassedCount = affectionTestState.sharedCoreSuiteResults.filter(item => item.status === 'passed').length;
  const sharedCoreTotalCount = affectionTestState.sharedCoreSuiteResults.length;
  const sharedCoreSuiteLabel = getTestStatusLabel(
    affectionTestState.sharedCoreSuiteStatus,
    sharedCorePassedCount,
    sharedCoreTotalCount,
  );
  const fieldPassedCount = affectionTestState.fieldSuiteResults.filter(item => item.status === 'passed').length;
  const fieldTotalCount = affectionTestState.fieldSuiteResults.length;
  const fieldSuiteLabel = getTestStatusLabel(
    affectionTestState.fieldSuiteStatus,
    fieldPassedCount,
    fieldTotalCount,
  );
  const buildPassedCount = affectionTestState.buildSuiteResults.filter(item => item.status === 'passed').length;
  const buildTotalCount = affectionTestState.buildSuiteResults.length;
  const buildSuiteLabel = getTestStatusLabel(
    affectionTestState.buildSuiteStatus,
    buildPassedCount,
    buildTotalCount,
  );
  const commitPassedCount = affectionTestState.commitSuiteResults.filter(item => item.status === 'passed').length;
  const commitTotalCount = affectionTestState.commitSuiteResults.length;
  const commitSuiteLabel = getTestStatusLabel(
    affectionTestState.commitSuiteStatus,
    commitPassedCount,
    commitTotalCount,
  );
  const injectionPassedCount = affectionTestState.injectionSuiteResults.filter(item => item.status === 'passed').length;
  const injectionTotalCount = affectionTestState.injectionSuiteResults.length;
  const injectionSuiteLabel = getTestStatusLabel(
    affectionTestState.injectionSuiteStatus,
    injectionPassedCount,
    injectionTotalCount,
  );
  const uiPassedCount = affectionTestState.uiSuiteResults.filter(item => item.status === 'passed').length;
  const uiTotalCount = affectionTestState.uiSuiteResults.length;
  const uiSuiteLabel = getTestStatusLabel(
    affectionTestState.uiSuiteStatus,
    uiPassedCount,
    uiTotalCount,
  );

  return `
    <div class="slx-affection-panel-prep">
      <details class="slx-detail-card slx-affection-diagnostics" data-slx-affection-diagnostics ${affectionTestState.diagnosticsOpen ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发诊断</small>
            <b>第 1—8 步测试与模拟</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-idle">按需展开</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-diagnostics-body">
          <div class="slx-affection-test-root">
      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="suite" ${affectionTestState.expandedSections.suite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 1 步 · 纯数据模型</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.suiteStatus)}">${escapeHtml(suiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>直接调用 <code>affection/model.js</code> 的真实函数。所有输入和结果只保留在当前页面内存中，不写聊天、不改设置、不请求 API。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-suite>运行第 1 步全部检查</button>
            <button class="slx-soft-btn" type="button" data-slx-affection-reset-tests>重置测试区</button>
          </div>
          ${renderSuiteResults(affectionTestState.suiteResults)}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="change" ${affectionTestState.expandedSections.change ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 A</small>
            <b>0 变化、角色去重与非法值</b>
          </span>
          <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="slx-affection-test-body">
          <p>每行格式为“角色名|变化值”。0 表示已完成判断但本轮无变化；可修改样例观察规范化结果及 diagnostics。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field slx-affection-test-wide">
              <span>affection 行</span>
              <textarea data-slx-affection-change-lines spellcheck="false">${escapeHtml(affectionTestState.changeLines)}</textarea>
            </label>
          </div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-change>模拟规范化</button>
          </div>
          ${renderJsonResult(affectionTestState.changeResult, affectionTestState.changeError, '运行后显示 changed、items 与 diagnostics。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="ledger" ${affectionTestState.expandedSections.ledger ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 B</small>
            <b>楼层排序、账本重算与手动调整</b>
          </span>
          <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="slx-affection-test-body">
          <p>记录使用整数十分位：1 代表 +0.1。输入顺序可以打乱，结果应按 sourceMessageId 重排并逐条承接。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field">
              <span>初始好感（0—100）</span>
              <input type="number" min="0" max="100" step="0.1" value="${escapeHtml(affectionTestState.ledgerInitialValue)}" data-slx-affection-ledger-initial />
            </label>
            <label class="slx-field">
              <span>手动调整目标（可留空）</span>
              <input type="number" min="0" max="100" step="0.1" value="${escapeHtml(affectionTestState.ledgerTargetValue)}" data-slx-affection-ledger-target />
            </label>
            <label class="slx-field slx-affection-test-wide">
              <span>records JSON</span>
              <textarea data-slx-affection-ledger-records spellcheck="false">${escapeHtml(affectionTestState.ledgerRecords)}</textarea>
            </label>
          </div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-ledger>模拟账本</button>
          </div>
          ${renderJsonResult(affectionTestState.ledgerResult, affectionTestState.ledgerError, '运行后显示排序、每条记录前后值、最终值和手动调整记录。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="settingsSuite" ${affectionTestState.expandedSections.settingsSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 2 步 · 设置、聊天态与角色名键</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.settingsSuiteStatus)}">${escapeHtml(settingsSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>直接向真实 getter 传入页面内存中的模拟对象，检查默认字段、非法枚举、旧草案迁移、损坏容器和角色名键。不会读取或修改当前聊天。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-settings-suite>运行第 2 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.settingsSuiteResults)}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="settingsMigration" ${affectionTestState.expandedSections.settingsMigration ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 C</small>
            <b>坏数据迁移预览</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.settingsMigrationStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.settingsMigrationStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>输入含 globalSettings 与 chatState 的 JSON。预览直接调用真实 getter，但只处理当前页面内存中的副本。</p>
          <label class="slx-field slx-field-wide">
            <span>模拟坏数据 JSON</span>
            <textarea data-slx-affection-settings-migration-input spellcheck="false">${escapeHtml(affectionTestState.settingsMigrationInput)}</textarea>
          </label>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-settings-migration>预览迁移结果</button>
          </div>
          ${renderJsonResult(affectionTestState.settingsMigrationResult, affectionTestState.settingsMigrationError, '运行后显示规范化设置、聊天态字段与 profile key。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="storageProbe" ${affectionTestState.expandedSections.storageProbe ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>显式存储探针</small>
            <b>真实设置与 metadata 写入、读回、恢复</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.storageProbeStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.storageProbeStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <div class="slx-affection-test-warning">此按钮会短暂写入当前全局好感设置和当前聊天 metadata，读回后立即用快照恢复。请只在可正常保存的测试聊天中运行。</div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-storage-probe>写入 → 读回 → 恢复</button>
          </div>
          ${renderJsonResult(affectionTestState.storageProbeResult, affectionTestState.storageProbeError, '等待用户显式运行。不会自动触发。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="sharedCoreSuite" ${affectionTestState.expandedSections.sharedCoreSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 3 步 · fingerprint、pending 协调器与发送前剥离</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.sharedCoreSuiteStatus)}">${escapeHtml(sharedCoreSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>直接调用共享 core。pending 检查只使用隔离的模拟处理器，不会执行真实情感或好感提交；事件检查只验证重复注册是否复用现有监听。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-shared-core-suite>运行第 3 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.sharedCoreSuiteResults)}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="stateLines" ${affectionTestState.expandedSections.stateLines ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 D</small>
            <b>正文状态行剥离预览</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.stateLineStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.stateLineStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>普通正文移除 emotion_changed，并兼容清理旧楼层残留的 affection_changed；emotion、三段 affection 与 affection_first 保留，内部小总结模式完整保留输入。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field">
              <span>模拟请求类型</span>
              <select data-slx-affection-state-line-mode>
                <option value="ordinary" ${affectionTestState.stateLineMode === 'ordinary' ? 'selected' : ''}>普通正文请求</option>
                <option value="internal" ${affectionTestState.stateLineMode === 'internal' ? 'selected' : ''}>蜃灵内部小总结</option>
              </select>
            </label>
            <label class="slx-field slx-affection-test-wide">
              <span>待处理文本</span>
              <textarea data-slx-affection-state-line-input spellcheck="false">${escapeHtml(affectionTestState.stateLineInput)}</textarea>
            </label>
          </div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-state-lines>预览处理结果</button>
          </div>
          ${renderJsonResult(affectionTestState.stateLineResult, affectionTestState.stateLineError, '运行后显示剥离结果或内部任务保留结果。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="fieldSuite" ${affectionTestState.expandedSections.fieldSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 4 步 · 字段、提示词、解析与 swipe pending</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.fieldSuiteStatus)}">${escapeHtml(fieldSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>直接调用真实提示词、解析器、整数账本补全和 pending 存储函数。全部使用页面内存模拟数据，不写聊天、不改 metadata、不请求 API。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-field-suite>运行第 4 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.fieldSuiteResults)}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="fieldSimulator" ${affectionTestState.expandedSections.fieldSimulator ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 E</small>
            <b>完整 memory 解析、三段写回与多 swipe 快照</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.fieldStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.fieldStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>粘贴完整 &lt;memory&gt;，选择模拟 swipe 后运行。重复切换 swipe-a / swipe-b 可观察同一 messageId 下两个 fingerprint 的 pending 是否独立保存。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field">
              <span>模拟当前 swipe</span>
              <select data-slx-affection-field-swipe>
                <option value="swipe-a" ${affectionTestState.fieldSwipe === 'swipe-a' ? 'selected' : ''}>swipe-a</option>
                <option value="swipe-b" ${affectionTestState.fieldSwipe === 'swipe-b' ? 'selected' : ''}>swipe-b</option>
              </select>
            </label>
            <label class="slx-field slx-affection-test-wide">
              <span>模拟正式 profiles JSON</span>
              <textarea data-slx-affection-field-profiles spellcheck="false">${escapeHtml(affectionTestState.fieldProfilesInput)}</textarea>
            </label>
            <label class="slx-field slx-affection-test-wide">
              <span>完整 memory</span>
              <textarea data-slx-affection-field-memory spellcheck="false">${escapeHtml(affectionTestState.fieldMemoryInput)}</textarea>
            </label>
          </div>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-field-simulator>解析并保存模拟 swipe</button>
            <button class="slx-soft-btn" type="button" data-slx-affection-clear-field-pending>清空模拟 pending</button>
          </div>
          ${renderJsonResult(affectionTestState.fieldResult, affectionTestState.fieldError, '运行后显示原始解析、三段写回结果和多 swipe pending 快照。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="buildSuite" ${affectionTestState.expandedSections.buildSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 5 步 · 首次角色预建档</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.buildSuiteStatus)}">${escapeHtml(buildSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>使用页面内存与 mock API 调用真实预建档函数，覆盖 generic、custom 去重、坏返回、切 swipe 失效和缺失初值；不写聊天、不改 metadata、不请求真实 API。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-build-suite>运行第 5 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.buildSuiteResults)}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="buildSimulator" ${affectionTestState.expandedSections.buildSimulator ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 F</small>
            <b>generic / custom 建档草稿与显式 API 预览</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.buildStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.buildStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>“模拟预建档”只使用 mock API 和页面内存；“显式调用真实 API”才会使用当前设置中的建档 API，并把完整请求、响应和解析结果写入通讯日志，但不会写入正式 profiles。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field">
              <span>角色名</span>
              <input type="text" data-slx-affection-build-role value="${escapeHtml(affectionTestState.buildRoleName)}">
            </label>
            <label class="slx-field">
              <span>affection_first 初值</span>
              <input type="number" min="0" max="100" step="0.1" data-slx-affection-build-initial value="${escapeHtml(affectionTestState.buildInitialValue)}">
            </label>
            <label class="slx-field">
              <span>模拟建档方式</span>
              <select data-slx-affection-build-mode>
                <option value="generic" ${affectionTestState.buildMode === 'generic' ? 'selected' : ''}>generic · 通用阶段表</option>
                <option value="custom" ${affectionTestState.buildMode === 'custom' ? 'selected' : ''}>custom · mock 专属阶段表</option>
              </select>
            </label>
          </div>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-build-simulator>模拟预建档</button>
            <button class="slx-soft-btn" type="button" data-slx-affection-run-build-real ${affectionTestState.buildRealStatus === 'running' ? 'disabled' : ''}>${affectionTestState.buildRealStatus === 'running' ? '真实 API 请求中…' : '显式调用真实 API'}</button>
          </div>
          ${renderJsonResult(affectionTestState.buildResult, affectionTestState.buildError, '模拟后显示 buildTask、profileDraft 与请求次数。')}
          <p><b>真实 API 预览：</b>${escapeHtml(getTestStatusLabel(affectionTestState.buildRealStatus))}</p>
          ${renderJsonResult(affectionTestState.buildRealResult, affectionTestState.buildRealError, '只有点击“显式调用真实 API”后才会产生请求。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="commitSuite" ${affectionTestState.expandedSections.commitSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 6 步 · 选中 swipe 提交与正式账本</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.commitSuiteStatus)}">${escapeHtml(commitSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>全部检查只使用页面内存，直接调用正式提交函数与预建档函数；覆盖多 swipe、sourceMessageId 替换、0 撤销、ready 转正、building 延迟转正和重复提交，不写聊天 metadata、不请求真实 API。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-commit-suite>运行第 6 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.commitSuiteResults)}
          <div class="slx-affection-test-subsection">
            <p><b>自定义模拟 G：选择本楼正式采用的 swipe</b></p>
            <label class="slx-field">
              <span>当前选中 swipe</span>
              <select data-slx-affection-commit-swipe>
                <option value="swipe-a" ${affectionTestState.commitSelectedSwipe === 'swipe-a' ? 'selected' : ''}>swipe-a · 沈青 +0.1</option>
                <option value="swipe-b" ${affectionTestState.commitSelectedSwipe === 'swipe-b' ? 'selected' : ''}>swipe-b · 沈青 -0.2</option>
              </select>
            </label>
            <div class="slx-action-row">
              <button class="slx-soft-btn" type="button" data-slx-affection-run-commit-simulator>模拟选中 swipe 提交</button>
            </div>
            ${renderJsonResult(affectionTestState.commitResult, affectionTestState.commitError, '运行后显示提交前快照、提交摘要、正式账本与清理结果。')}
          </div>
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="injectionSuite" ${affectionTestState.expandedSections.injectionSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 7 步 · 正文注入与楼层渲染</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.injectionSuiteStatus)}">${escapeHtml(injectionSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>使用页面内存和 mock setExtensionPrompt 调用真实注入、清理、显示格式与控制行剥离函数；不会修改酒馆 prompt、聊天或 metadata。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-injection-suite>运行第 7 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.injectionSuiteResults)}
          <div class="slx-affection-test-subsection">
            <p><b>自定义模拟 H：注入、清空、渲染与剥离预览</b></p>
            <label class="slx-field">
              <span>模拟运行状态</span>
              <select data-slx-affection-injection-mode>
                <option value="active" ${affectionTestState.injectionMode === 'active' ? 'selected' : ''}>攻略 active + 已建档</option>
                <option value="summary_off" ${affectionTestState.injectionMode === 'summary_off' ? 'selected' : ''}>自动小总结关闭</option>
                <option value="affection_off" ${affectionTestState.injectionMode === 'affection_off' ? 'selected' : ''}>好感度关闭</option>
                <option value="empty" ${affectionTestState.injectionMode === 'empty' ? 'selected' : ''}>没有正式档案</option>
              </select>
            </label>
            <div class="slx-action-row">
              <button class="slx-soft-btn" type="button" data-slx-affection-run-injection-simulator>生成第 7 步预览</button>
            </div>
            ${renderJsonResult(affectionTestState.injectionResult, affectionTestState.injectionError, '运行后显示注入正文、真实槽位参数、显示分段和 changed 控制行剥离前后。')}
          </div>
        </div>
      </details>
      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="uiSuite" ${affectionTestState.expandedSections.uiSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 8 步 · 面板操作、编辑副本与可访问结构</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.uiSuiteStatus)}">${escapeHtml(uiSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>使用页面内存与 mock API 调用正式 pending 编辑、手动校准、阶段覆盖和按需求重新生成函数；不写聊天、不改 metadata、不请求真实 API。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-ui-suite>运行第 8 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.uiSuiteResults)}
        </div>
      </details>
          </div>
        </div>
      </details>
    </div>
  `;
}

export function renderAffectionPanel() {
  const settings = getGlobalSettings();
  const chatState = getChatState();
  const store = getAffectionSystemState(chatState);
  normalizeAffectionPanelView(store);
  const selectedPending = getSelectedPendingEntries(settings, store);
  const pendingItemCount = selectedPending.reduce((count, entry) => (
    count + (Array.isArray(entry.pending?.changes) ? entry.pending.changes.length : 0)
  ), 0);
  const profileCount = Object.values(store.profiles || {}).filter(isPlainObject).length;

  return `
    <div class="slx-affection-root">
      <div class="slx-affection-main">
        <div class="slx-affection-overview" aria-label="好感度档案概况">
          <span>档案 <b>${profileCount}</b></span>
          <span>待确认 <b>${pendingItemCount}</b></span>
        </div>
        ${renderAffectionFeedback()}
        ${renderAffectionSettings(settings)}
        ${renderManualCreateEntryCard()}
        ${renderAffectionPending(settings, store)}
        ${renderAffectionProfiles(store)}
        ${renderAffectionDiagnostics()}
      </div>
      ${renderManualAffectionCreateOverlay(store)}
      ${renderAffectionDetailOverlay(store)}
      ${renderAffectionStageEditorOverlay(store)}
    </div>
  `;
}

function syncAffectionTestInputs(panelRoot) {
  affectionTestState.changeLines = panelRoot.querySelector('[data-slx-affection-change-lines]')?.value
    ?? affectionTestState.changeLines;
  affectionTestState.ledgerInitialValue = panelRoot.querySelector('[data-slx-affection-ledger-initial]')?.value
    ?? affectionTestState.ledgerInitialValue;
  affectionTestState.ledgerTargetValue = panelRoot.querySelector('[data-slx-affection-ledger-target]')?.value
    ?? affectionTestState.ledgerTargetValue;
  affectionTestState.ledgerRecords = panelRoot.querySelector('[data-slx-affection-ledger-records]')?.value
    ?? affectionTestState.ledgerRecords;
  affectionTestState.settingsMigrationInput = panelRoot.querySelector('[data-slx-affection-settings-migration-input]')?.value
    ?? affectionTestState.settingsMigrationInput;
  affectionTestState.stateLineMode = panelRoot.querySelector('[data-slx-affection-state-line-mode]')?.value
    || affectionTestState.stateLineMode;
  affectionTestState.stateLineInput = panelRoot.querySelector('[data-slx-affection-state-line-input]')?.value
    ?? affectionTestState.stateLineInput;
  affectionTestState.fieldSwipe = panelRoot.querySelector('[data-slx-affection-field-swipe]')?.value
    || affectionTestState.fieldSwipe;
  affectionTestState.fieldProfilesInput = panelRoot.querySelector('[data-slx-affection-field-profiles]')?.value
    ?? affectionTestState.fieldProfilesInput;
  affectionTestState.fieldMemoryInput = panelRoot.querySelector('[data-slx-affection-field-memory]')?.value
    ?? affectionTestState.fieldMemoryInput;
  affectionTestState.buildRoleName = panelRoot.querySelector('[data-slx-affection-build-role]')?.value
    ?? affectionTestState.buildRoleName;
  affectionTestState.buildInitialValue = panelRoot.querySelector('[data-slx-affection-build-initial]')?.value
    ?? affectionTestState.buildInitialValue;
  affectionTestState.buildMode = panelRoot.querySelector('[data-slx-affection-build-mode]')?.value
    || affectionTestState.buildMode;
  affectionTestState.commitSelectedSwipe = panelRoot.querySelector('[data-slx-affection-commit-swipe]')?.value
    || affectionTestState.commitSelectedSwipe;
  affectionTestState.injectionMode = panelRoot.querySelector('[data-slx-affection-injection-mode]')?.value
    || affectionTestState.injectionMode;
}

function restoreAffectionPanelFocus(panelRoot) {
  if (affectionPanelState.focusRoleName) {
    const roleName = affectionPanelState.focusRoleName;
    affectionPanelState.focusRoleName = '';
    requestAnimationFrame(() => [...panelRoot.querySelectorAll('[data-slx-affection-open-detail]')]
      .find(button => button.dataset.slxAffectionOpenDetail === roleName)?.focus());
    return;
  }
  const selector = affectionPanelState.focusSelector;
  if (!selector) return;
  affectionPanelState.focusSelector = '';
  requestAnimationFrame(() => panelRoot.querySelector(selector)?.focus());
}

function getTaskInitialInputValue(panelRoot, taskKey) {
  const input = [...panelRoot.querySelectorAll('[data-slx-affection-task-initial]')]
    .find(item => item.dataset.slxAffectionTaskInitial === taskKey);
  return input?.value ?? '';
}

function updateStageEditorField(input) {
  const editor = affectionPanelState.editor;
  const stageIndex = Number(input.dataset.stageIndex);
  const stage = editor?.stages?.[stageIndex];
  if (!stage) return;
  if (input.dataset.slxAffectionStageField) {
    stage[input.dataset.slxAffectionStageField] = input.value;
  } else if (input.dataset.slxAffectionStageBehavior !== undefined) {
    const behaviorIndex = Number(input.dataset.slxAffectionStageBehavior);
    const behaviors = Array.isArray(stage.behaviors) ? [...stage.behaviors] : ['', '', ''];
    behaviors[behaviorIndex] = input.value;
    stage.behaviors = behaviors;
  }
  const stageId = stage.stageId || `S${stageIndex + 1}`;
  editor.dirty = true;
  if (!editor.modifiedStageIds.includes(stageId)) editor.modifiedStageIds.push(stageId);
  delete editor.fieldErrors[stageId];
  panelRootEditorStatus(input.closest('.slx-affection-editor'));
}

function panelRootEditorStatus(editorRoot) {
  const editor = affectionPanelState.editor;
  if (!editorRoot || !editor) return;
  const copyStatus = editorRoot.querySelector('.slx-affection-stage-accordion .slx-affection-section-head small');
  if (copyStatus) copyStatus.textContent = editor.dirty ? '尚未应用' : '与正式阶段一致';
  const confirmButton = editorRoot.querySelector('[data-slx-affection-confirm-stages]');
  if (confirmButton) confirmButton.disabled = !editor.dirty
    || editor.generationStatus === 'running'
    || (editor.sourceBuildMode === 'generic' && editor.generationStatus !== 'success');
}

function trapAffectionOverlayFocus(event, overlay) {
  if (event.key !== 'Tab') return;
  const focusable = [...overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
    .filter(item => item.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindAffectionFormalEvents(panelRoot) {
  restoreAffectionPanelFocus(panelRoot);

  panelRoot.querySelector('[data-slx-affection-settings]')?.addEventListener('toggle', event => {
    affectionPanelState.settingsOpen = event.currentTarget.open;
  });
  panelRoot.querySelector('[data-slx-affection-full-stages]')?.addEventListener('toggle', event => {
    affectionPanelState.fullStagesOpen = event.currentTarget.open;
  });
  panelRoot.querySelector('[data-slx-affection-regenerate-fold]')?.addEventListener('toggle', event => {
    affectionPanelState.regenerateOpen = event.currentTarget.open;
  });

  panelRoot.querySelector('[data-slx-affection-enabled]')?.addEventListener('change', async event => {
    const settings = getGlobalSettings();
    getAffectionSettings(settings).enabled = event.currentTarget.checked;
    saveGlobalSettings();
    await syncAffectionInjection({ settings, chatState: getChatState() });
    setAffectionPanelFeedback({ notice: event.currentTarget.checked ? '好感度追踪已开启。' : '好感度追踪与正文注入已停用。' });
    refreshPanel();
  });
  panelRoot.querySelectorAll('[data-slx-affection-build-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const settings = getGlobalSettings();
      getAffectionSettings(settings).defaultBuildMode = button.dataset.slxAffectionBuildMode;
      saveGlobalSettings();
      setAffectionPanelFeedback({ notice: `新建档案将默认使用${button.dataset.slxAffectionBuildMode === 'generic' ? '通用阶段' : '专属阶段'}。` });
      refreshPanel();
    });
  });
  panelRoot.querySelectorAll('[data-slx-affection-build-api]').forEach(button => {
    button.addEventListener('click', () => {
      const settings = getGlobalSettings();
      getAffectionSettings(settings).profileBuildApiMode = button.dataset.slxAffectionBuildApi;
      saveGlobalSettings();
      setAffectionPanelFeedback({ notice: `专属阶段默认改用${button.dataset.slxAffectionBuildApi === 'main_api' ? '主 API' : '副 API'}。` });
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-affection-delta-step]').forEach(button => {
    button.addEventListener('click', () => {
      try {
        const settings = getGlobalSettings();
        const store = getAffectionSystemState(getChatState());
        const messageId = Number(button.dataset.messageId);
        const fingerprint = button.dataset.fingerprint || '';
        const roleName = button.dataset.roleName || '';
        const pending = store.pendingByMessage?.[String(messageId)]?.items?.[fingerprint];
        const change = pending?.changes?.find(item => normalizeAffectionRoleName(item?.roleName) === normalizeAffectionRoleName(roleName));
        const currentIndex = AFFECTION_ALLOWED_DELTA_TENTHS.indexOf(Number(change?.deltaTenths));
        const nextIndex = currentIndex + Number(button.dataset.slxAffectionDeltaStep);
        const nextDelta = AFFECTION_ALLOWED_DELTA_TENTHS[nextIndex];
        if (!Number.isInteger(nextDelta)) return;
        updatePendingAffectionDelta({ messageId, fingerprint, roleName, deltaTenths: nextDelta }, { settings, chatState: getChatState() });
        setAffectionPanelFeedback({ notice: `已把「${roleName}」本轮变化调整为 ${formatAffectionDeltaTenths(nextDelta)}。` });
      } catch (error) {
        setAffectionPanelFeedback({ error: error?.message || String(error) });
      }
      refreshPanel();
    });
  });
  panelRoot.querySelectorAll('[data-slx-affection-discard-pending]').forEach(button => {
    button.addEventListener('click', () => {
      const roleName = button.dataset.roleName || '';
      const removed = discardPendingAffectionItem({
        messageId: Number(button.dataset.messageId),
        fingerprint: button.dataset.fingerprint || '',
        roleName,
      });
      setAffectionPanelFeedback(removed
        ? { notice: `已放弃「${roleName}」的这项待确认内容。` }
        : { error: '待确认内容已不存在。' });
      refreshPanel();
    });
  });
  panelRoot.querySelectorAll('[data-slx-affection-open-detail]').forEach(button => {
    button.addEventListener('click', () => {
      affectionPanelState.view = 'detail';
      affectionPanelState.roleName = button.dataset.slxAffectionOpenDetail || '';
      affectionPanelState.fullStagesOpen = false;
      affectionPanelState.focusSelector = '[data-slx-affection-close-overlay]';
      setAffectionPanelFeedback();
      refreshPanel();
    });
  });
  panelRoot.querySelector('[data-slx-affection-close-overlay]')?.addEventListener('click', () => {
    affectionPanelState.view = 'main';
    affectionPanelState.focusRoleName = affectionPanelState.roleName;
    refreshPanel();
  });
  panelRoot.querySelector('[data-slx-affection-apply-adjust]')?.addEventListener('click', async event => {
    const targetValueTenths = parseAffectionValueTenths(panelRoot.querySelector('[data-slx-affection-adjust-value]')?.value);
    if (!Number.isInteger(targetValueTenths)) {
      setAffectionPanelFeedback({ error: '当前好感必须是 0—100、最多一位小数。' });
      refreshPanel();
      return;
    }
    event.currentTarget.disabled = true;
    try {
      const result = await adjustAffectionProfileValue({ roleName: affectionPanelState.roleName, targetValueTenths });
      setAffectionPanelFeedback({ notice: result.changed ? '当前好感已写入一条手动调整记录。' : '当前好感没有变化。' });
    } catch (error) {
      setAffectionPanelFeedback({ error: error?.message || String(error) });
    }
    refreshPanel();
  });
  panelRoot.querySelectorAll('[data-slx-affection-profile-mode]').forEach(button => {
    button.addEventListener('click', async () => {
      const mode = button.dataset.slxAffectionProfileMode;
      if (mode === 'custom') {
        const profile = getAffectionSystemState(getChatState()).profiles?.[affectionPanelState.roleName];
        affectionPanelState.editor = createAffectionStageEditor(profile, affectionPanelState.roleName);
        affectionPanelState.regenerateOpen = profile?.buildMode === 'generic';
        affectionPanelState.view = 'stages';
        affectionPanelState.focusSelector = '[data-slx-affection-back-detail]';
        refreshPanel();
        return;
      }
      try {
        await applyAffectionProfileStages({
          roleName: affectionPanelState.roleName,
          stages: createGenericAffectionStages(),
          buildMode: 'generic',
        });
        affectionPanelState.editor = null;
        setAffectionPanelFeedback({ notice: '已切换为通用五阶段。' });
      } catch (error) {
        setAffectionPanelFeedback({ error: error?.message || String(error) });
      }
      refreshPanel();
    });
  });
  panelRoot.querySelector('[data-slx-affection-open-stage-editor]')?.addEventListener('click', () => {
    const profile = getAffectionSystemState(getChatState()).profiles?.[affectionPanelState.roleName];
    if (!affectionPanelState.editor || affectionPanelState.editor.roleName !== affectionPanelState.roleName) {
      affectionPanelState.editor = createAffectionStageEditor(profile, affectionPanelState.roleName);
    }
    affectionPanelState.regenerateOpen = profile?.buildMode === 'generic' || affectionPanelState.regenerateOpen;
    affectionPanelState.view = 'stages';
    affectionPanelState.focusSelector = '[data-slx-affection-back-detail]';
    setAffectionPanelFeedback();
    refreshPanel();
  });
  panelRoot.querySelector('[data-slx-affection-delete-profile]')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      await deleteAffectionProfile({ roleName: affectionPanelState.roleName });
      affectionPanelState.view = 'main';
      affectionPanelState.roleName = '';
      affectionPanelState.editor = null;
      setAffectionPanelFeedback({ notice: '角色好感档案已删除。' });
    } catch (error) {
      setAffectionPanelFeedback({ error: error?.message || String(error) });
    }
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-back-detail]')?.addEventListener('click', () => {
    affectionPanelState.view = 'detail';
    affectionPanelState.focusSelector = '[data-slx-affection-open-stage-editor]';
    refreshPanel();
  });
  panelRoot.querySelectorAll('[data-slx-affection-regenerate-api]').forEach(button => {
    button.addEventListener('click', () => {
      affectionPanelState.editor.regenerateApiMode = button.dataset.slxAffectionRegenerateApi;
      panelRoot.querySelectorAll('[data-slx-affection-regenerate-api]').forEach(item => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
    });
  });
  panelRoot.querySelector('[data-slx-affection-requirement]')?.addEventListener('input', event => {
    affectionPanelState.editor.userRequirement = event.currentTarget.value;
  });
  panelRoot.querySelectorAll('[data-slx-affection-toggle-stage]').forEach(button => {
    button.addEventListener('click', () => {
      const stageId = button.dataset.slxAffectionToggleStage;
      const card = button.closest('.slx-affection-stage-draft-card');
      const fields = card?.querySelector('.slx-affection-stage-fields');
      const willOpen = !card?.classList.contains('is-open');
      affectionPanelState.editor.expandedStageId = willOpen ? stageId : '';
      panelRoot.querySelectorAll('.slx-affection-stage-draft-card').forEach(item => item.classList.remove('is-open'));
      panelRoot.querySelectorAll('[data-slx-affection-toggle-stage]').forEach(item => item.setAttribute('aria-expanded', 'false'));
      panelRoot.querySelectorAll('.slx-affection-stage-fields').forEach(item => { item.hidden = true; });
      if (willOpen && card && fields) {
        card.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
        fields.hidden = false;
      }
    });
  });
  panelRoot.querySelectorAll('[data-slx-affection-stage-field], [data-slx-affection-stage-behavior]').forEach(input => {
    input.addEventListener('input', () => updateStageEditorField(input));
  });
  panelRoot.querySelector('[data-slx-affection-regenerate]')?.addEventListener('click', async event => {
    const editor = affectionPanelState.editor;
    editor.generationStatus = 'running';
    editor.error = '';
    event.currentTarget.disabled = true;
    refreshPanel();
    try {
      const result = await regenerateAffectionProfileStages({
        roleName: editor.roleName,
        userRequirement: editor.userRequirement,
        apiMode: editor.regenerateApiMode,
      });
      if (affectionPanelState.editor !== editor || editor.chatId !== getCurrentAffectionChatId()) return;
      editor.stages = cloneData(result.stages);
      editor.dirty = true;
      editor.modifiedStageIds = editor.stages.map((stage, index) => stage.stageId || `S${index + 1}`);
      editor.fieldErrors = {};
      editor.generationStatus = 'success';
      editor.expandedStageId = getStageForValueTenths(
        recalculateAffectionLedger(
          getAffectionSystemState(getChatState()).profiles[editor.roleName].initialValueTenths,
          getAffectionSystemState(getChatState()).profiles[editor.roleName].records,
        ).valueTenths,
        editor.stages,
      ).stageId;
    } catch (error) {
      if (affectionPanelState.editor === editor) {
        editor.generationStatus = 'error';
        editor.error = error?.message || String(error);
      }
    }
    refreshPanel();
  });
  panelRoot.querySelector('[data-slx-affection-cancel-stage-edit]')?.addEventListener('click', () => {
    affectionPanelState.editor = null;
    affectionPanelState.view = 'detail';
    affectionPanelState.regenerateOpen = false;
    affectionPanelState.focusSelector = '[data-slx-affection-open-stage-editor]';
    setAffectionPanelFeedback({ notice: '编辑副本已放弃，正式阶段未改变。' });
    refreshPanel();
  });
  panelRoot.querySelector('[data-slx-affection-confirm-stages]')?.addEventListener('click', async event => {
    const editor = affectionPanelState.editor;
    if (editor.sourceBuildMode === 'generic' && editor.generationStatus !== 'success') {
      affectionPanelState.regenerateOpen = true;
      setAffectionPanelFeedback({ error: '请先生成专属五阶段草稿，再确认覆盖。' });
      refreshPanel();
      return;
    }
    const errors = getStageEditorErrors(editor.stages);
    if (Object.keys(errors).length) {
      editor.fieldErrors = errors;
      editor.expandedStageId = Object.keys(errors)[0];
      affectionPanelState.focusSelector = `.slx-affection-stage-draft-card.has-error [data-slx-affection-stage-field="name"]`;
      refreshPanel();
      return;
    }
    event.currentTarget.disabled = true;
    try {
      await applyAffectionProfileStages({
        roleName: editor.roleName,
        stages: editor.stages,
        buildMode: 'custom',
        stageDesignRequirement: editor.userRequirement,
      });
      affectionPanelState.editor = null;
      affectionPanelState.view = 'detail';
      affectionPanelState.regenerateOpen = false;
      setAffectionPanelFeedback({ notice: '新的专属五阶段已正式启用。' });
    } catch (error) {
      setAffectionPanelFeedback({ error: error?.message || String(error) });
    }
    refreshPanel();
  });

  // ---- 手动新建档案 ----
  panelRoot.querySelector('[data-slx-affection-open-create]')?.addEventListener('click', () => {
    const diagnostics = getStorageDiagnostics();
    if (!diagnostics?.hasChatMetadata) {
      setAffectionPanelFeedback({ error: '请先进入一个可保存的聊天，再新建角色档案。' });
      refreshPanel();
      return;
    }
    affectionPanelState.manualCreate = createManualCreateState();
    affectionPanelState.view = 'create';
    affectionPanelState.focusSelector = '[data-slx-affection-create-role]';
    setAffectionPanelFeedback();
    refreshPanel();
  });

  const closeManualCreate = () => {
    const session = affectionPanelState.manualCreate;
    // 正式提交进行中：禁止关闭，避免“界面取消、档案已创建”
    if (session?.generationStatus === 'committing') return;
    clearManualCreateSession();
    affectionPanelState.focusSelector = '[data-slx-affection-open-create]';
    refreshPanel();
  };

  panelRoot.querySelectorAll('[data-slx-affection-close-create]').forEach(button => {
    button.addEventListener('click', () => closeManualCreate());
  });

  panelRoot.querySelectorAll('[data-slx-affection-create-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const session = affectionPanelState.manualCreate;
      if (!session || session.generationStatus === 'running' || session.generationStatus === 'committing') return;
      const mode = button.dataset.slxAffectionCreateMode === 'generic' ? 'generic' : 'custom';
      if (session.buildMode === mode) return;
      session.buildMode = mode;
      invalidateManualCreateDraft(session);
      session.error = '';
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-affection-create-api]').forEach(button => {
    button.addEventListener('click', () => {
      const session = affectionPanelState.manualCreate;
      if (!session || session.generationStatus === 'running' || session.generationStatus === 'committing') return;
      const apiMode = button.dataset.slxAffectionCreateApi === 'main_api' ? 'main_api' : 'secondary_api';
      if (session.apiMode === apiMode) return;
      session.apiMode = apiMode;
      invalidateManualCreateDraft(session);
      session.error = '';
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-affection-create-role]')?.addEventListener('input', event => {
    const session = affectionPanelState.manualCreate;
    if (!session || session.generationStatus === 'committing') return;
    session.roleName = event.currentTarget.value;
    invalidateManualCreateDraft(session, { clearContext: true });
    session.error = '';
    syncManualCreateDraftInvalidation(panelRoot, { clearContext: true });
  });

  panelRoot.querySelector('[data-slx-affection-create-initial]')?.addEventListener('input', event => {
    const session = affectionPanelState.manualCreate;
    if (!session || session.generationStatus === 'committing') return;
    session.initialValue = event.currentTarget.value;
    invalidateManualCreateDraft(session);
    session.error = '';
    syncManualCreateDraftInvalidation(panelRoot, { clearContext: false });
  });

  panelRoot.querySelector('[data-slx-affection-create-requirement]')?.addEventListener('input', event => {
    const session = affectionPanelState.manualCreate;
    if (!session || session.generationStatus === 'committing') return;
    session.userRequirement = event.currentTarget.value;
    invalidateManualCreateDraft(session);
    session.error = '';
    syncManualCreateDraftInvalidation(panelRoot, { clearContext: false });
  });

  panelRoot.querySelector('[data-slx-affection-test-create-context]')?.addEventListener('click', async event => {
    const session = affectionPanelState.manualCreate;
    if (!session) return;
    const requestedRoleName = normalizeAffectionRoleName(session.roleName);
    if (!requestedRoleName) {
      session.error = '角色名不能为空。';
      session.contextStatus = 'idle';
      refreshPanel();
      return;
    }
    const requestId = createManualContextRequestId();
    session.contextRequestId = requestId;
    session.contextStatus = 'running';
    session.contextResult = null;
    session.contextError = '';
    session.error = '';
    event.currentTarget.disabled = true;
    refreshPanel();
    const { resolveContext } = getManualCreateDeps();
    try {
      const result = await resolveContext(requestedRoleName);
      if (!isActiveManualContextRequest(session, requestId, requestedRoleName)) return;
      session.contextStatus = 'success';
      session.contextResult = result;
      session.contextError = '';
    } catch (error) {
      if (!isActiveManualContextRequest(session, requestId, requestedRoleName)) return;
      session.contextStatus = 'error';
      session.contextResult = null;
      session.contextError = error?.message || String(error);
    }
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-generate-create-draft]')?.addEventListener('click', async event => {
    const session = affectionPanelState.manualCreate;
    if (!session) return;
    const roleName = normalizeAffectionRoleName(session.roleName);
    const initialValueTenths = parseAffectionValueTenths(session.initialValue);
    if (!roleName) {
      session.error = '角色名不能为空。';
      refreshPanel();
      return;
    }
    if (!Number.isInteger(initialValueTenths)) {
      session.error = '初始好感必须是 0—100、最多一位小数。';
      refreshPanel();
      return;
    }
    session.generationStatus = 'running';
    session.generationError = '';
    session.error = '';
    session.notice = '';
    session.draft = null;
    event.currentTarget.disabled = true;
    refreshPanel();
    const { generateDraft } = getManualCreateDeps();
    try {
      const draft = await generateDraft({
        roleName,
        initialValueTenths,
        userRequirement: session.userRequirement,
        apiMode: session.apiMode,
      });
      if (!isActiveManualCreateSession(session)) return;
      session.draft = draft;
      session.generationStatus = 'success';
      session.notice = '专属阶段草稿已生成，请确认后创建档案。';
    } catch (error) {
      if (!isActiveManualCreateSession(session)) return;
      session.generationStatus = 'error';
      session.draft = null;
      session.generationError = error?.message || String(error);
    }
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-create-generic]')?.addEventListener('click', async event => {
    const session = affectionPanelState.manualCreate;
    if (!session) return;
    const roleName = normalizeAffectionRoleName(session.roleName);
    const initialValueTenths = parseAffectionValueTenths(session.initialValue);
    if (!roleName) {
      session.error = '角色名不能为空。';
      refreshPanel();
      return;
    }
    if (!Number.isInteger(initialValueTenths)) {
      session.error = '初始好感必须是 0—100、最多一位小数。';
      refreshPanel();
      return;
    }
    session.generationStatus = 'committing';
    session.error = '';
    event.currentTarget.disabled = true;
    refreshPanel();
    const { createGeneric } = getManualCreateDeps();
    try {
      await createGeneric({ roleName, initialValueTenths });
      if (!isActiveManualCreateSession(session)) return;
      affectionPanelState.manualCreate = null;
      affectionPanelState.view = 'main';
      affectionPanelState.focusRoleName = roleName;
      setAffectionPanelFeedback({ notice: `「${roleName}」好感档案已创建。` });
    } catch (error) {
      if (!isActiveManualCreateSession(session)) return;
      session.generationStatus = 'idle';
      session.error = error?.message || String(error);
    }
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-commit-create-draft]')?.addEventListener('click', async event => {
    const session = affectionPanelState.manualCreate;
    if (!session?.draft) return;
    const roleName = normalizeAffectionRoleName(session.roleName);
    const initialValueTenths = parseAffectionValueTenths(session.initialValue);
    if (!roleName) {
      session.error = '角色名不能为空。';
      refreshPanel();
      return;
    }
    if (!Number.isInteger(initialValueTenths)) {
      session.error = '初始好感必须是 0—100、最多一位小数。';
      refreshPanel();
      return;
    }
    session.generationStatus = 'committing';
    session.error = '';
    event.currentTarget.disabled = true;
    refreshPanel();
    const { commitDraft } = getManualCreateDeps();
    try {
      await commitDraft({
        draft: session.draft,
        roleName,
        initialValueTenths,
        userRequirement: session.userRequirement,
      });
      if (!isActiveManualCreateSession(session)) return;
      affectionPanelState.manualCreate = null;
      affectionPanelState.view = 'main';
      affectionPanelState.focusRoleName = roleName;
      setAffectionPanelFeedback({ notice: `「${roleName}」专属好感档案已创建。` });
    } catch (error) {
      if (!isActiveManualCreateSession(session)) return;
      session.generationStatus = session.draft ? 'success' : 'idle';
      session.error = error?.message || String(error);
    }
    refreshPanel();
  });

  panelRoot.querySelectorAll('.slx-affection-editor-overlay').forEach(overlay => {
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (affectionPanelState.view === 'create') {
          const session = affectionPanelState.manualCreate;
          // 正式提交中忽略 Escape，不关闭、不改 focus
          if (session?.generationStatus === 'committing') return;
          event.preventDefault();
          clearManualCreateSession();
          affectionPanelState.focusSelector = '[data-slx-affection-open-create]';
          refreshPanel();
          return;
        }
        event.preventDefault();
        if (affectionPanelState.view === 'stages') {
          affectionPanelState.view = 'detail';
          affectionPanelState.focusSelector = '[data-slx-affection-open-stage-editor]';
        } else {
          affectionPanelState.view = 'main';
          affectionPanelState.focusRoleName = affectionPanelState.roleName;
        }
        refreshPanel();
        return;
      }
      trapAffectionOverlayFocus(event, overlay);
    });
  });
}

export function bindAffectionPanelEvents(panelRoot) {
  bindAffectionFormalEvents(panelRoot);

  panelRoot.querySelector('[data-slx-affection-diagnostics]')?.addEventListener('toggle', event => {
    affectionTestState.diagnosticsOpen = event.currentTarget.open;
  });

  panelRoot.querySelectorAll('[data-slx-affection-test-section]').forEach(section => {
    section.addEventListener('toggle', () => {
      const sectionId = section.dataset.slxAffectionTestSection;
      if (sectionId && Object.hasOwn(affectionTestState.expandedSections, sectionId)) {
        affectionTestState.expandedSections[sectionId] = section.open;
      }
    });
  });

  panelRoot.querySelector('[data-slx-affection-run-suite]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionModelSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-change]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runChangeSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-ledger]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runLedgerSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-settings-suite]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionSettingsSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-settings-migration]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runSettingsMigrationPreview();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-storage-probe]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionStorageProbe();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-shared-core-suite]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionSharedCoreSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-state-lines]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runStateLineSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-field-suite]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionFieldSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-field-simulator]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionFieldSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-clear-field-pending]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    affectionTestState.fieldPendingByMessage = {};
    affectionTestState.fieldResult = null;
    affectionTestState.fieldStatus = 'idle';
    affectionTestState.fieldError = '';
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-build-suite]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionBuildSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-build-simulator]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionBuildSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-build-real]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionBuildRealApiPreview();
  });

  panelRoot.querySelector('[data-slx-affection-run-commit-suite]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionCommitSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-commit-simulator]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionCommitSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-injection-suite]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionInjectionSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-ui-suite]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionUiSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-injection-simulator]')?.addEventListener('click', async () => {
    syncAffectionTestInputs(panelRoot);
    await runAffectionInjectionSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-reset-tests]')?.addEventListener('click', () => {
    affectionTestState = createDefaultTestState();
    refreshPanel();
  });
}
