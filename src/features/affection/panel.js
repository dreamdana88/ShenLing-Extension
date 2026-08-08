import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  getStageForValueTenths,
  normalizeAffectionRoleName,
  parseAffectionValueTenths,
  recalculateAffectionLedger,
} from './model.js';
import {
  cloneData,
  escapeHtml,
  isPlainObject,
} from '../../utils/text.js';
import {
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getStorageDiagnostics,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  getMessageContentFingerprint,
} from '../../core/message-fingerprint.js';
import { slxIcon } from '../../icons.js';
import {
  syncAffectionInjection,
} from './injection.js';
import {
  discardPendingAffectionItem,
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
  deleteAffectionProfile,
  regenerateAffectionProfileStages,
} from './workflow.js';
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
    draftExpandedStageId: '',
    draftFieldErrors: {},
    draftDirty: false,
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
  session.draftExpandedStageId = '';
  session.draftFieldErrors = {};
  session.draftDirty = false;
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

function renderManualCreateDraftStage(stage, index, expanded, stageErrors, currentStageId = '') {
  const stageId = stage.stageId || `S${index + 1}`;
  const errorText = stageErrors?.length ? `请补全：${stageErrors.join('、')}` : '';
  const isCurrent = stageId === currentStageId;
  return `
    <article class="slx-affection-create-draft-card slx-affection-stage-draft-card ${expanded ? 'is-open' : ''} ${isCurrent ? 'is-current' : ''} ${errorText ? 'has-error' : ''}">
      <button class="slx-affection-stage-toggle" type="button" data-slx-affection-toggle-create-stage="${escapeHtml(stageId)}" aria-expanded="${expanded}" aria-controls="slx-affection-create-stage-fields-${index}">
        <span>
          <small>${index + 1}</small>
          <b>${escapeHtml(formatAffectionValueTenths(stage.minTenths))}—${escapeHtml(formatAffectionValueTenths(stage.maxTenths))}</b>
          <em>「${escapeHtml(stage.name || '未命名')}」</em>
        </span>
        <span class="slx-affection-stage-tags">
          ${isCurrent ? '<small class="is-current">初始好感所在阶段</small>' : ''}
          ${errorText ? '<small class="is-error">有错误</small>' : ''}
          ${slxIcon('chevronDown')}
        </span>
      </button>
      <div class="slx-affection-stage-fields" id="slx-affection-create-stage-fields-${index}" ${expanded ? '' : 'hidden'}>
        ${errorText ? `<div class="slx-affection-field-error" role="alert">${escapeHtml(errorText)}</div>` : ''}
        <label><span>阶段名</span><input type="text" maxlength="24" data-slx-affection-create-stage-field="name" data-stage-index="${index}" value="${escapeHtml(stage.name || '')}" /></label>
        <label><span>关系含义</span><textarea rows="2" maxlength="120" data-slx-affection-create-stage-field="meaning" data-stage-index="${index}">${escapeHtml(stage.meaning || '')}</textarea></label>
        ${(stage.behaviors || ['', '', '']).map((item, behaviorIndex) => `<label><span>行为 ${behaviorIndex + 1}</span><textarea rows="2" maxlength="100" data-slx-affection-create-stage-behavior="${behaviorIndex}" data-stage-index="${index}">${escapeHtml(item || '')}</textarea></label>`).join('')}
        <label><span>变化倾向</span><textarea rows="2" maxlength="120" data-slx-affection-create-stage-field="trend" data-stage-index="${index}">${escapeHtml(stage.trend || '')}</textarea></label>
        <label><span>阶段边界</span><textarea rows="2" maxlength="120" data-slx-affection-create-stage-field="boundary" data-stage-index="${index}">${escapeHtml(stage.boundary || '')}</textarea></label>
      </div>
    </article>
  `;
}

function renderManualCreateDraftPreview(session) {
  const stages = Array.isArray(session?.draft?.stages) ? session.draft.stages : [];
  if (!stages.length) return '';
  const initialTenths = parseAffectionValueTenths(session.initialValue);
  const currentStage = Number.isInteger(initialTenths)
    ? getStageForValueTenths(initialTenths, stages)
    : null;
  const fieldErrors = session.draftFieldErrors || {};
  const errorCount = Object.keys(fieldErrors).length;
  const expandedStageId = session.draftExpandedStageId || '';
  return `
    <section class="slx-detail-card slx-affection-create-draft-preview" data-slx-affection-create-draft-preview aria-label="专属五阶段草稿">
      <div class="slx-affection-section-head"><b>专属五阶段草稿</b><small>可直接修改，确认后才正式建档</small></div>
      ${errorCount ? '<div class="slx-affection-editor-errors" role="alert">请补全专属阶段草稿后再确认。</div>' : ''}
      <div class="slx-affection-create-draft-list slx-affection-stage-accordion">
        ${stages.map((stage, index) => renderManualCreateDraftStage(
          stage,
          index,
          expandedStageId === (stage.stageId || `S${index + 1}`),
          fieldErrors[stage.stageId || `S${index + 1}`],
          currentStage?.stageId || '',
        )).join('')}
      </div>
    </section>
  `;
}

function updateManualCreateDraftField(input) {
  const session = affectionPanelState.manualCreate;
  if (!session?.draft?.stages || session.generationStatus === 'committing') return;
  const stageIndex = Number(input.dataset.stageIndex);
  const stage = session.draft.stages[stageIndex];
  if (!stage) return;

  if (input.dataset.slxAffectionCreateStageField) {
    stage[input.dataset.slxAffectionCreateStageField] = input.value;
  } else if (input.dataset.slxAffectionCreateStageBehavior !== undefined) {
    const behaviorIndex = Number(input.dataset.slxAffectionCreateStageBehavior);
    const behaviors = Array.isArray(stage.behaviors) ? [...stage.behaviors] : ['', '', ''];
    behaviors[behaviorIndex] = input.value;
    stage.behaviors = behaviors;
  }

  session.draftDirty = true;
  const stageId = stage.stageId || `S${stageIndex + 1}`;
  if (session.draftFieldErrors?.[stageId]) {
    delete session.draftFieldErrors[stageId];
  }
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
      </div>
      ${renderManualAffectionCreateOverlay(store)}
      ${renderAffectionDetailOverlay(store)}
      ${renderAffectionStageEditorOverlay(store)}
    </div>
  `;
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
    session.draftExpandedStageId = '';
    session.draftFieldErrors = {};
    session.draftDirty = false;
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
      session.draftFieldErrors = {};
      session.draftDirty = false;
      const currentStage = getStageForValueTenths(initialValueTenths, draft.stages || []);
      session.draftExpandedStageId = currentStage?.stageId
        || draft.stages?.[0]?.stageId
        || 'S1';
      session.notice = '专属阶段草稿已生成，可直接修改后确认创建。';
    } catch (error) {
      if (!isActiveManualCreateSession(session)) return;
      session.generationStatus = 'error';
      session.draft = null;
      session.draftExpandedStageId = '';
      session.draftFieldErrors = {};
      session.draftDirty = false;
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

  panelRoot.querySelectorAll('[data-slx-affection-toggle-create-stage]').forEach(button => {
    button.addEventListener('click', () => {
      const session = affectionPanelState.manualCreate;
      if (!session || session.generationStatus === 'committing') return;
      const stageId = button.dataset.slxAffectionToggleCreateStage;
      const card = button.closest('.slx-affection-create-draft-card, .slx-affection-stage-draft-card');
      const fields = card?.querySelector('.slx-affection-stage-fields');
      const willOpen = !card?.classList.contains('is-open');
      session.draftExpandedStageId = willOpen ? stageId : '';
      panelRoot.querySelectorAll('.slx-affection-create-draft-card').forEach(item => item.classList.remove('is-open'));
      panelRoot.querySelectorAll('[data-slx-affection-toggle-create-stage]').forEach(item => item.setAttribute('aria-expanded', 'false'));
      panelRoot.querySelectorAll('.slx-affection-create-draft-card .slx-affection-stage-fields').forEach(item => {
        item.hidden = true;
      });
      if (willOpen && card && fields) {
        card.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
        fields.hidden = false;
      }
    });
  });

  panelRoot.querySelectorAll('[data-slx-affection-create-stage-field], [data-slx-affection-create-stage-behavior]').forEach(input => {
    input.addEventListener('input', () => updateManualCreateDraftField(input));
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
    const fieldErrors = getStageEditorErrors(session.draft.stages);
    if (Object.keys(fieldErrors).length) {
      session.draftFieldErrors = fieldErrors;
      session.draftExpandedStageId = Object.keys(fieldErrors)[0];
      session.error = '请补全专属阶段草稿后再确认。';
      session.generationStatus = 'success';
      affectionPanelState.focusSelector = '.slx-affection-create-draft-card.has-error [data-slx-affection-create-stage-field="name"]';
      refreshPanel();
      return;
    }
    session.draftFieldErrors = {};
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
}
