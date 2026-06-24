import {
  escapeHtml,
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  getChatState,
  getEmotionProfileSettings,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  deleteEmotionProfileByRole,
  getCurrentPendingEmotionUpdates,
  getCurrentPendingEmotionMessageIds,
  syncEmotionProfileInjection,
  updateCurrentPendingEmotionProfile,
} from './workflow.js';

let panelOptions = {
  refreshPanel: null,
};

let emotionProfileEditorState = {
  open: false,
  mode: 'profile',
  roleName: '',
  messageId: null,
};

export function configureEmotionProfilePanel(options = {}) {
  panelOptions = {
    ...panelOptions,
    ...options,
  };
}

export function isEmotionProfileEditorOpen() {
  return Boolean(emotionProfileEditorState.open);
}

function refreshPanel() {
  if (typeof panelOptions.refreshPanel === 'function') {
    panelOptions.refreshPanel();
  }
}

function getEmotionProfileStore(chatState) {
  if (!isPlainObject(chatState.emotionProfiles)) {
    chatState.emotionProfiles = {};
  }
  if (!isPlainObject(chatState.emotionProfiles.profiles)) {
    chatState.emotionProfiles.profiles = {};
  }
  return chatState.emotionProfiles;
}

function getProfileRecords(profile) {
  return Array.isArray(profile?.records) ? profile.records : [];
}

function getRecordText(record, fields) {
  if (!isPlainObject(record)) return '';
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function getProfileCurrentStatus(profile, latestRecord) {
  return getRecordText(latestRecord, ['currentStatus', 'currentState', 'summary', 'status'])
    || getRecordText(profile, ['currentStatus', 'currentState', 'summary'])
    || '尚未整理';
}

function getProfileLatestChange(latestRecord) {
  return getRecordText(latestRecord, ['changeSummary', 'change', 'content', 'summary'])
    || '尚未记录显著变化';
}

function getProfileSourceLabel(latestRecord) {
  const sourceMessageId = latestRecord?.sourceMessageId ?? latestRecord?.messageId ?? latestRecord?.floor;
  const prefix = latestRecord?.sourceType === 'legacy_archive' ? '旧聊天归档 · ' : '';
  return sourceMessageId === undefined || sourceMessageId === null || sourceMessageId === ''
    ? '未记录'
    : `${prefix}第 ${sourceMessageId} 楼`;
}

function getProfileUpdatedAt(profile, latestRecord) {
  return getRecordText(latestRecord, ['updatedAt', 'createdAt', 'occurredAt'])
    || getRecordText(profile, ['lastUpdatedAt', 'updatedAt'])
    || '未记录';
}

function closeEmotionProfileEditor() {
  emotionProfileEditorState = {
    open: false,
    mode: 'profile',
    roleName: '',
    messageId: null,
  };
}

function openEmotionProfileEditor(roleName, { mode = 'profile', messageId = null } = {}) {
  emotionProfileEditorState = {
    open: true,
    mode,
    roleName: String(roleName || ''),
    messageId: messageId === null ? null : Number(messageId),
  };
}

function getPendingEditorProfile() {
  const roleName = emotionProfileEditorState.roleName;
  const messageId = Number(emotionProfileEditorState.messageId);
  if (!roleName || !Number.isFinite(messageId)) return null;
  const pendingItems = getCurrentPendingEmotionUpdates();
  const item = pendingItems.find(candidate => Number(candidate.messageId) === messageId);
  return item?.profiles?.find(profile => String(profile.roleName || '') === roleName) || null;
}

function renderEmotionProfileEditor(chatState) {
  if (!emotionProfileEditorState.open) return '';
  const roleName = emotionProfileEditorState.roleName;
  const isPending = emotionProfileEditorState.mode === 'pending';
  const store = getEmotionProfileStore(chatState);
  const profile = isPending ? getPendingEditorProfile() : store.profiles[roleName];
  if (!isPlainObject(profile)) return '';

  const records = isPending ? [] : getProfileRecords(profile);
  const latestRecord = records.at(-1) || null;
  const currentStatus = isPending
    ? String(profile.currentStatus || '').trim() || '尚未整理'
    : getProfileCurrentStatus(profile, latestRecord);
  const latestChange = isPending
    ? String(profile.changeSummary || '').trim() || '尚未记录显著变化'
    : getProfileLatestChange(latestRecord);

  return `
    <div class="slx-emotion-editor-overlay" data-slx-close-emotion-editor role="dialog" aria-modal="true" aria-label="${isPending ? '编辑待确认情感变化' : '编辑情感档案'}">
      <div class="slx-emotion-editor-card" data-slx-emotion-editor-card>
        <div class="slx-summary-card-head">
          <div>
            <div class="slx-detail-title">${isPending ? '编辑待确认情感变化' : '编辑情感档案'}</div>
            <p>${escapeHtml(profile.name || profile.roleName || roleName)}</p>
          </div>
          <button class="slx-mini-action-btn" type="button" data-slx-close-emotion-editor title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="slx-emotion-editor-body">
          <label class="slx-field slx-field-wide">
            <span>当前状态</span>
            <textarea class="slx-emotion-editor-textarea" data-slx-emotion-edit-current>${escapeHtml(currentStatus)}</textarea>
          </label>
          <label class="slx-field slx-field-wide">
            <span>最近变化</span>
            <textarea class="slx-emotion-editor-textarea" data-slx-emotion-edit-change>${escapeHtml(latestChange)}</textarea>
          </label>
        </div>
        <div class="slx-emotion-editor-footer">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-emotion-profile>
            <i class="fa-solid fa-floppy-disk"></i><span>保存修改</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function saveEmotionProfileEditor(panelRoot) {
  const roleName = emotionProfileEditorState.roleName;
  if (!roleName) return;
  const currentStatus = String(panelRoot.querySelector('[data-slx-emotion-edit-current]')?.value || '').trim();
  const latestChange = String(panelRoot.querySelector('[data-slx-emotion-edit-change]')?.value || '').trim();

  if (emotionProfileEditorState.mode === 'pending') {
    updateCurrentPendingEmotionProfile({
      messageId: emotionProfileEditorState.messageId,
      roleName,
      currentStatus,
      changeSummary: latestChange,
    });
    closeEmotionProfileEditor();
    refreshPanel();
    return;
  }

  const chatState = getChatState();
  const store = getEmotionProfileStore(chatState);
  const profile = store.profiles[roleName];
  if (!isPlainObject(profile)) return;

  const records = getProfileRecords(profile);
  const latestRecord = records.at(-1);
  if (!latestRecord) return;
  const now = formatTimestamp();

  latestRecord.currentStatus = currentStatus;
  latestRecord.changeSummary = latestChange;
  latestRecord.updatedAt = now;
  profile.currentStatus = latestRecord.currentStatus || profile.currentStatus || '';
  profile.lastUpdatedAt = now;
  profile.records = records;
  store.profiles[roleName] = profile;
  store.lastUpdatedAt = now;

  saveChatState();
  closeEmotionProfileEditor();
  void syncEmotionProfileInjection();
  refreshPanel();
}

function renderHistory(records) {
  if (!records.length) {
    return '';
  }

  const items = records.slice().reverse().map(record => {
    const sourceLabel = getProfileSourceLabel(record);
    const updatedAt = getProfileUpdatedAt({}, record);
    const text = getProfileLatestChange(record);
    return `
      <li>
        <span>${escapeHtml(sourceLabel)} · ${escapeHtml(updatedAt)}</span>
        <p>${escapeHtml(text)}</p>
      </li>
    `;
  }).join('');

  return `
    <details class="slx-emotion-history">
      <summary>历史变化</summary>
      <ol>${items}</ol>
    </details>
  `;
}

function renderProfileCard(roleName, profile, records = getProfileRecords(profile)) {
  const latestRecord = records.at(-1) || null;
  const currentStatus = getProfileCurrentStatus(profile, latestRecord);
  const latestChange = getProfileLatestChange(latestRecord);
  const sourceLabel = getProfileSourceLabel(latestRecord);
  const updatedAt = getProfileUpdatedAt(profile, latestRecord);

  return `
    <article class="slx-emotion-profile-card">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">${escapeHtml(profile.name || roleName)}</div>
          <p>${escapeHtml(sourceLabel)} · ${escapeHtml(updatedAt)}</p>
        </div>
        <div class="slx-card-actions">
          <button class="slx-mini-action-btn" type="button" data-slx-edit-emotion-profile="${escapeHtml(roleName)}" title="编辑情感档案"><i class="fa-solid fa-pen-to-square"></i></button>
          <button class="slx-mini-action-btn slx-danger-mini-btn" type="button" data-slx-delete-emotion-profile="${escapeHtml(roleName)}" title="删除该角色全部情感档案"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div class="slx-emotion-profile-section">
        <span>当前状态</span>
        <p>${escapeHtml(currentStatus)}</p>
      </div>
      <div class="slx-emotion-profile-section">
        <span>最近变化</span>
        <p>${escapeHtml(latestChange)}</p>
      </div>
      ${renderHistory(records)}
    </article>
  `;
}

function renderPendingEmotionPanel(settings) {
  const pendingItems = getCurrentPendingEmotionUpdates(settings);
  if (!pendingItems.length) return '';

  const cards = pendingItems.map(item => {
    const profiles = item.profiles.map(profile => `
      <article class="slx-emotion-profile-card slx-emotion-pending-card">
        <div class="slx-summary-card-head">
          <div>
            <div class="slx-detail-title">${escapeHtml(profile.roleName || '未命名角色')}</div>
            <p>第 ${escapeHtml(item.messageId)} 楼 · 待确认</p>
          </div>
          <button class="slx-mini-action-btn" type="button" data-slx-edit-pending-emotion-profile="${escapeHtml(profile.roleName || '')}" data-slx-pending-emotion-message-id="${escapeHtml(item.messageId)}" title="编辑待确认变化"><i class="fa-solid fa-pen-to-square"></i></button>
        </div>
        <div class="slx-emotion-profile-section">
          <span>待确认状态</span>
          <p>${escapeHtml(profile.currentStatus || '未整理')}</p>
        </div>
        <div class="slx-emotion-profile-section">
          <span>本页变化</span>
          <p>${escapeHtml(profile.changeSummary || '未记录')}</p>
        </div>
      </article>
    `).join('');

    return profiles;
  }).join('');

  return `
    <div class="slx-detail-card slx-emotion-shell-card">
      <div class="slx-detail-kicker">待确认</div>
      <div class="slx-detail-title">当前 swipe 情感变化</div>
      <p>继续下一轮后，当前选中页会写入正式档案。</p>
    </div>
    <div class="slx-emotion-profile-list">
      ${cards}
    </div>
  `;
}

export function renderEmotionProfilePanel(settings, chatState) {
  const store = getEmotionProfileStore(chatState);
  const pendingMessageIds = getCurrentPendingEmotionMessageIds(settings);
  const editor = renderEmotionProfileEditor(chatState);
  const profiles = Object.entries(store.profiles)
    .filter(([, profile]) => isPlainObject(profile))
    .map(([roleName, profile]) => {
      const records = getProfileRecords(profile)
        .filter(record => !pendingMessageIds.has(Number(record?.sourceMessageId)));
      return [roleName, profile, records];
    })
    .filter(([, , records]) => records.length);

  if (!profiles.length) {
    return `
      <div class="slx-emotion-root" data-slx-emotion-root>
        <div class="slx-emotion-main">
          ${renderPendingEmotionPanel(settings)}
          <div class="slx-detail-card slx-emotion-shell-card">
            <div class="slx-detail-title">暂无情感档案</div>
            <p>当角色关系出现显著变化后，会在这里整理成档案。</p>
          </div>
        </div>
        ${editor}
      </div>
    `;
  }

  return `
    <div class="slx-emotion-root" data-slx-emotion-root>
      <div class="slx-emotion-main">
        ${renderPendingEmotionPanel(settings)}
        <div class="slx-emotion-profile-list">
          ${profiles.map(([roleName, profile, records]) => renderProfileCard(roleName, profile, records)).join('')}
        </div>
      </div>
      ${editor}
    </div>
  `;
}

export function bindEmotionProfilePanelEvents(panelRoot, settings) {
  panelRoot.querySelectorAll('[data-slx-emotion-field]').forEach(input => {
    input.addEventListener('change', () => {
      const field = input.dataset.slxEmotionField;
      const emotionSettings = getEmotionProfileSettings(settings);
      if (!field || !Object.hasOwn(emotionSettings, field)) return;
      emotionSettings[field] = Boolean(input.checked);
      if (field === 'enabled') {
        emotionSettings.autoAnalyze = Boolean(input.checked);
        emotionSettings.injectEnabled = Boolean(input.checked);
      }
      saveGlobalSettings();
      void syncEmotionProfileInjection();
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-edit-emotion-profile]').forEach(button => {
    button.addEventListener('click', () => {
      openEmotionProfileEditor(button.dataset.slxEditEmotionProfile || '');
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-delete-emotion-profile]').forEach(button => {
    button.addEventListener('click', () => {
      const roleName = button.dataset.slxDeleteEmotionProfile || '';
      if (!roleName) return;
      if (!confirm(`删除「${roleName}」的所有情感档案？此操作不会删除聊天楼层里的 memory。`)) return;
      if (emotionProfileEditorState.roleName === roleName) {
        closeEmotionProfileEditor();
      }
      void deleteEmotionProfileByRole(roleName);
    });
  });

  panelRoot.querySelectorAll('[data-slx-edit-pending-emotion-profile]').forEach(button => {
    button.addEventListener('click', () => {
      openEmotionProfileEditor(button.dataset.slxEditPendingEmotionProfile || '', {
        mode: 'pending',
        messageId: button.dataset.slxPendingEmotionMessageId,
      });
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-close-emotion-editor]').forEach(node => {
    node.addEventListener('click', event => {
      if (node.classList.contains('slx-emotion-editor-overlay') && event.target.closest?.('[data-slx-emotion-editor-card]')) return;
      closeEmotionProfileEditor();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-save-emotion-profile]')?.addEventListener('click', () => {
    saveEmotionProfileEditor(panelRoot);
  });
}
