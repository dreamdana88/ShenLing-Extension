import {
  escapeHtml,
  isPlainObject,
} from '../../utils/text.js';
import {
  getEmotionProfileSettings,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  getCurrentPendingEmotionUpdates,
  getCurrentPendingEmotionMessageIds,
  syncEmotionProfileInjection,
} from './workflow.js';

let panelOptions = {
  refreshPanel: null,
};

export function configureEmotionProfilePanel(options = {}) {
  panelOptions = {
    ...panelOptions,
    ...options,
  };
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

function renderEmotionProfileControls(settings) {
  const emotionSettings = getEmotionProfileSettings(settings);
  return `
    <div class="slx-emotion-toggle-strip">
      <label class="slx-setting-toggle-row slx-emotion-toggle-only" for="slx-emotion-enabled" title="情感档案">
        <input id="slx-emotion-enabled" type="checkbox" data-slx-emotion-field="enabled" ${emotionSettings.enabled ? 'checked' : ''} />
      </label>
    </div>
  `;
}

export function renderEmotionProfilePanel(settings, chatState) {
  const store = getEmotionProfileStore(chatState);
  const pendingMessageIds = getCurrentPendingEmotionMessageIds(settings);
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
      ${renderEmotionProfileControls(settings)}
      ${renderPendingEmotionPanel(settings)}
      <div class="slx-detail-card slx-emotion-shell-card">
        <div class="slx-detail-title">暂无情感档案</div>
        <p>当角色关系出现显著变化后，会在这里整理成档案。</p>
      </div>
    `;
  }

  return `
    ${renderEmotionProfileControls(settings)}
    ${renderPendingEmotionPanel(settings)}
    <div class="slx-emotion-profile-list">
      ${profiles.map(([roleName, profile, records]) => renderProfileCard(roleName, profile, records)).join('')}
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

}
