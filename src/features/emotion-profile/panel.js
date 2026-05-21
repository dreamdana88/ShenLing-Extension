import {
  escapeHtml,
  isPlainObject,
} from '../../utils/text.js';

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
  return getRecordText(profile, ['currentStatus', 'currentState', 'summary'])
    || getRecordText(latestRecord, ['currentStatus', 'currentState', 'summary', 'status'])
    || '尚未整理';
}

function getProfileLatestChange(latestRecord) {
  return getRecordText(latestRecord, ['changeSummary', 'change', 'content', 'summary'])
    || '尚未记录显著变化';
}

function getProfileSourceLabel(latestRecord) {
  const sourceMessageId = latestRecord?.sourceMessageId ?? latestRecord?.messageId ?? latestRecord?.floor;
  return sourceMessageId === undefined || sourceMessageId === null || sourceMessageId === ''
    ? '未记录'
    : `第 ${sourceMessageId} 楼`;
}

function getProfileUpdatedAt(profile, latestRecord) {
  return getRecordText(latestRecord, ['updatedAt', 'createdAt', 'occurredAt'])
    || getRecordText(profile, ['lastUpdatedAt', 'updatedAt'])
    || '未记录';
}

function renderHistory(profile) {
  const records = getProfileRecords(profile);
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

function renderProfileCard(roleName, profile) {
  const records = getProfileRecords(profile);
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
      ${renderHistory(profile)}
    </article>
  `;
}

export function renderEmotionProfilePanel(chatState) {
  const store = getEmotionProfileStore(chatState);
  const profiles = Object.entries(store.profiles)
    .filter(([, profile]) => isPlainObject(profile));

  if (!profiles.length) {
    return `
      <div class="slx-detail-card slx-emotion-shell-card">
        <div class="slx-detail-kicker">🎭 角色档案</div>
        <div class="slx-detail-title">暂无情感档案</div>
        <p>当角色关系出现显著变化后，会在这里整理成档案。</p>
        <div class="slx-action-row slx-summary-action-row">
          <button class="slx-soft-btn" type="button" disabled>扫描旧小总结</button>
          <button class="slx-soft-btn" type="button" disabled>生成情感档案</button>
          <button class="slx-soft-btn" type="button" disabled>清空档案</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="slx-detail-card slx-emotion-shell-card">
      <div class="slx-detail-kicker">🎭 角色档案</div>
      <div class="slx-detail-title">情感档案</div>
      <p>只显示显著变化，完整历史可展开查看。</p>
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" disabled>扫描旧小总结</button>
        <button class="slx-soft-btn" type="button" disabled>生成情感档案</button>
        <button class="slx-soft-btn" type="button" disabled>清空档案</button>
      </div>
    </div>
    <div class="slx-emotion-profile-list">
      ${profiles.map(([roleName, profile]) => renderProfileCard(roleName, profile)).join('')}
    </div>
  `;
}
