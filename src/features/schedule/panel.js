import { escapeHtml } from '../../utils/text.js';
import {
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getScheduleSettings,
  getScheduleState,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  normalizeScheduleEntryOption,
  normalizeScheduleMovement,
} from './model.js';
import { runScheduleGeneration } from './workflow.js';

let schedulePanelOptions = {
  refreshPanel: () => {},
};

let schedulePanelState = {
  activeChatKey: '',
  confirmClearOpen: false,
  expandedDayIndex: null,
  generationStatus: 'idle',
  generationError: '',
  userDirection: '',
};

export function configureSchedulePanel(options = {}) {
  schedulePanelOptions = {
    ...schedulePanelOptions,
    ...options,
  };
}

function refreshPanel() {
  schedulePanelOptions.refreshPanel();
}

function getSchedulePanelChatKey() {
  const info = getContextInfo();
  return [
    info.characterName || '',
    info.chatId || info.chatName || '',
  ].join('::');
}

function resetSchedulePanelTransientState(chatKey = getSchedulePanelChatKey()) {
  schedulePanelState = {
    activeChatKey: chatKey,
    confirmClearOpen: false,
    expandedDayIndex: null,
    generationStatus: 'idle',
    generationError: '',
    userDirection: '',
  };
}

function syncSchedulePanelChatState() {
  const chatKey = getSchedulePanelChatKey();
  if (schedulePanelState.activeChatKey !== chatKey) {
    resetSchedulePanelTransientState(chatKey);
  }
}

function notifySchedule(type, message, title = '日程表') {
  const toast = globalThis.toastr || globalThis.parent?.toastr;
  if (toast && typeof toast[type] === 'function') {
    toast[type](message, title);
    return;
  }
  console[type === 'error' ? 'warn' : 'info'](`[${title}] ${message}`);
}

function appendToChatInput(text) {
  const textarea = document.querySelector('#send_textarea');
  if (!textarea) {
    notifySchedule('error', '没有找到聊天输入框。');
    return false;
  }
  const current = String(textarea.value || '').trimEnd();
  textarea.value = current ? `${current}\n\n${text}` : text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  requestAnimationFrame(() => {
    textarea.focus?.();
    textarea.setSelectionRange?.(textarea.value.length, textarea.value.length);
  });
  return true;
}

function getScheduleOptionText(option) {
  return normalizeScheduleEntryOption(option)?.text || '';
}

function formatScheduleMovementLoadText(movement) {
  if (!movement?.summary) return '';
  const where = movement.location ? `在${movement.location}` : '';
  const timeParts = [
    movement.startsAt ? `开始：${movement.startsAt}` : '',
    movement.durationMinutes > 0 ? `耗时：${movement.durationMinutes}分钟` : '',
  ].filter(Boolean);
  const timeText = timeParts.length ? `；${timeParts.join('；')}` : '';
  const impactText = movement.mainlineImpact ? `；主线影响：${movement.mainlineImpact}` : '';
  return `（场外动向：${movement.character || '未命名角色'}${where}${timeText}，${movement.summary}${impactText}）`;
}

function renderScheduleMovement(movement, dayIndex, movementIndex) {
  const item = normalizeScheduleMovement(movement, movementIndex);
  if (!item) return '';
  const metaItems = [
    item.startsAt,
    item.durationMinutes > 0 ? `${item.durationMinutes} 分钟` : '',
  ].filter(Boolean);

  return `
    <div class="slx-schedule-movement">
      <div class="slx-schedule-movement-head">
        <strong>${escapeHtml(item.character || '未命名角色')}</strong>
        ${item.location ? `<span>${escapeHtml(item.location)}</span>` : ''}
      </div>
      ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      ${metaItems.length ? `<div class="slx-schedule-movement-meta">${metaItems.map(meta => `<span>${escapeHtml(meta)}</span>`).join('')}</div>` : ''}
      ${item.mainlineImpact ? `<div class="slx-schedule-impact">${escapeHtml(item.mainlineImpact)}</div>` : ''}
      ${item.summary ? `<button class="slx-schedule-load-btn" type="button" data-slx-schedule-load-mv="${dayIndex}:${movementIndex}" title="以旁白形态填入聊天输入框">引用动向</button>` : ''}
    </div>
  `;
}

function renderScheduleEmpty() {
  return `
    <div class="slx-schedule-empty">
      <div class="slx-schedule-empty-mark">七日剧情菜单</div>
      <p>还没有日程表。写下短期方向（也可以留空），点击「生成日程表」，未来七天的剧情机会、介入入口与角色动向会在这里展开。</p>
    </div>
  `;
}

function renderScheduleDay(day, index, expanded) {
  const entryOptions = (Array.isArray(day.entryOptions) ? day.entryOptions : [])
    .map(getScheduleOptionText)
    .filter(Boolean);
  const movements = Array.isArray(day.characterMovements) ? day.characterMovements : [];
  return `
    <div class="slx-schedule-day-card ${expanded ? 'slx-schedule-day-card-expanded' : 'slx-schedule-day-card-collapsed'}">
      <div class="slx-schedule-day-head">
        <button class="slx-schedule-day-toggle" type="button" data-slx-schedule-toggle-day="${index}" aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? '收起本日' : '展开本日'}">
          <span class="slx-schedule-day-index"><i>DAY</i><b>${escapeHtml(day.day || index + 1)}</b></span>
          <span class="slx-schedule-day-title"><b>${escapeHtml(day.theme || `第${index + 1}天`)}</b></span>
          <span class="slx-schedule-day-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
        </button>
        ${day.mainOpportunity || entryOptions.length || movements.length ? `<button class="slx-schedule-load-btn slx-schedule-load-day-btn" type="button" data-slx-schedule-load-day="${index}" title="把本日主机会、介入入口与角色动向填入聊天输入框">载入本日</button>` : ''}
      </div>
      ${expanded ? `
        <div class="slx-schedule-day-content">
          <div class="slx-schedule-section slx-schedule-main">
            <div class="slx-schedule-section-label">主机会</div>
            <p>${escapeHtml(day.mainOpportunity || '暂无主剧情机会')}</p>
            ${day.mainOpportunity ? `<button class="slx-schedule-load-btn" type="button" data-slx-schedule-load-main="${index}" title="以旁白形态填入聊天输入框">推进此机会</button>` : ''}
          </div>
          ${entryOptions.length ? `
            <div class="slx-schedule-section">
              <div class="slx-schedule-section-label">可介入</div>
              <div class="slx-schedule-chip-list">
                ${entryOptions.map(option => `<button class="slx-schedule-chip" type="button" data-slx-schedule-send="${escapeHtml(option)}" title="填入聊天输入框">${escapeHtml(option)}</button>`).join('')}
              </div>
            </div>
          ` : ''}
          ${movements.length ? `
            <div class="slx-schedule-section">
              <div class="slx-schedule-section-label">角色动向</div>
              <div class="slx-schedule-movement-list">
                ${movements.map((movement, movementIndex) => renderScheduleMovement(movement, index, movementIndex)).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderScheduleClearConfirm() {
  if (!schedulePanelState.confirmClearOpen) return '';
  return `
    <div class="slx-schedule-confirm-overlay" role="dialog" aria-modal="true" aria-label="清空当前日程表">
      <div class="slx-schedule-confirm-card">
        <div class="slx-detail-title">清空当前日程表？</div>
        <p>这会移除当前聊天里正在显示的七日日程内容，不影响剧情大纲和其他模块。</p>
        <div class="slx-schedule-confirm-actions">
          <button class="slx-soft-btn" type="button" data-slx-schedule-clear-cancel>取消</button>
          <button class="slx-soft-btn slx-schedule-danger-btn" type="button" data-slx-schedule-clear-confirm>清空</button>
        </div>
      </div>
    </div>
  `;
}

export function renderSchedulePanel(settings, chatState) {
  syncSchedulePanelChatState();
  const schedule = getScheduleState(chatState);
  const scheduleSettings = getScheduleSettings(settings);
  const current = schedule.current;
  const hasCurrent = Boolean(current) && Array.isArray(current.days) && current.days.length > 0;
  const isRunning = schedulePanelState.generationStatus === 'running';
  const disabled = isRunning ? 'disabled' : '';

  return `
    <div class="slx-schedule-root">
      <div class="slx-detail-card slx-schedule-generate-card">
        <label class="slx-field">
          <div class="slx-schedule-label-row">
            <span>短期方向</span>
            <div class="slx-schedule-api-toggle" role="group" aria-label="日程表 API 模式">
              <button class="${scheduleSettings.apiMode === 'main_api' ? 'is-active' : ''}" type="button" data-slx-schedule-api-mode="main_api" ${disabled}>主 API</button>
              <button class="${scheduleSettings.apiMode === 'secondary_api' ? 'is-active' : ''}" type="button" data-slx-schedule-api-mode="secondary_api" ${disabled}>副 API</button>
            </div>
          </div>
          <textarea rows="3" data-slx-schedule-direction placeholder="可写想看的短期推进、角色动向、冲突方向；也可以留空。" ${disabled}>${escapeHtml(schedulePanelState.userDirection)}</textarea>
        </label>
        <div class="slx-schedule-btn-row">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-schedule-generate ${isRunning ? 'disabled' : ''}>${isRunning ? '生成中...' : '生成日程表'}</button>
        </div>
        ${schedulePanelState.generationError ? `<div class="slx-schedule-error">${escapeHtml(schedulePanelState.generationError)}</div>` : ''}
      </div>

      <div class="slx-detail-card slx-schedule-current-card">
        <div class="slx-schedule-card-head">
          <div>
            <div class="slx-detail-title">${hasCurrent ? escapeHtml(current.title || '当前日程表') : '还没有日程表'}</div>
            <p>${hasCurrent ? `上次生成：${escapeHtml(schedule.lastGeneratedAt || '未记录')}。当前聊天的临时剧情菜单，可随时重 Roll 覆盖。` : '当前聊天的临时剧情菜单。生成后会显示七日剧情机会、介入入口与角色动向。'}</p>
          </div>
          ${hasCurrent ? '<button class="slx-soft-btn" type="button" data-slx-schedule-clear>清空</button>' : ''}
        </div>
        ${hasCurrent ? `
          <div class="slx-schedule-grid">
            ${current.days.map((day, index) => renderScheduleDay(day, index, schedulePanelState.expandedDayIndex === index)).join('')}
          </div>
        ` : renderScheduleEmpty()}
      </div>
      ${renderScheduleClearConfirm()}
    </div>
  `;
}

export function bindSchedulePanelEvents(panelRoot) {
  if (!panelRoot) return;
  panelRoot.querySelector('[data-slx-schedule-direction]')?.addEventListener('change', event => {
    schedulePanelState.userDirection = String(event.currentTarget.value || '').trim();
  });

  panelRoot.querySelectorAll('[data-slx-schedule-api-mode]').forEach(button => {
    button.addEventListener('click', event => {
      const settings = getGlobalSettings();
      const scheduleSettings = getScheduleSettings(settings);
      scheduleSettings.apiMode = event.currentTarget.dataset.slxScheduleApiMode === 'main_api' ? 'main_api' : 'secondary_api';
      saveGlobalSettings();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-schedule-generate]')?.addEventListener('click', async () => {
    if (schedulePanelState.generationStatus === 'running') return;
    const requestChatKey = getSchedulePanelChatKey();
    schedulePanelState.userDirection = String(panelRoot.querySelector('[data-slx-schedule-direction]')?.value || '').trim();
    schedulePanelState.generationStatus = 'running';
    schedulePanelState.generationError = '';
    schedulePanelState.confirmClearOpen = false;
    schedulePanelState.expandedDayIndex = null;
    refreshPanel();
    try {
      const result = await runScheduleGeneration({ userDirection: schedulePanelState.userDirection });
      if (getSchedulePanelChatKey() !== requestChatKey) {
        resetSchedulePanelTransientState();
        notifySchedule('warning', '聊天已切换，本次日程表结果未写入。');
        refreshPanel();
        return;
      }
      const chatState = getChatState();
      const schedule = getScheduleState(chatState);
      schedule.current = result.schedule;
      schedule.lastGeneratedAt = result.schedule.updatedAt || result.schedule.createdAt || '';
      saveChatState();
      schedulePanelState.generationStatus = 'success';
      if (result.replacements > 0) {
        notifySchedule('success', `日程表生成结果已替换 ${result.replacements} 处。`, '禁词替换');
      } else {
        notifySchedule('success', '日程表已生成。');
      }
    } catch (error) {
      schedulePanelState.generationStatus = 'failed';
      schedulePanelState.generationError = error.message || String(error);
      notifySchedule('error', schedulePanelState.generationError);
    }
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-schedule-clear]')?.addEventListener('click', () => {
    schedulePanelState.confirmClearOpen = true;
    schedulePanelState.generationError = '';
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-schedule-clear-cancel]')?.addEventListener('click', () => {
    schedulePanelState.confirmClearOpen = false;
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-schedule-clear-confirm]')?.addEventListener('click', () => {
    const chatState = getChatState();
    const schedule = getScheduleState(chatState);
    schedule.current = null;
    schedule.lastGeneratedAt = '';
    saveChatState();
    schedulePanelState.generationStatus = 'idle';
    schedulePanelState.generationError = '';
    schedulePanelState.confirmClearOpen = false;
    schedulePanelState.expandedDayIndex = null;
    refreshPanel();
  });

  panelRoot.querySelectorAll('[data-slx-schedule-toggle-day]').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.slxScheduleToggleDay);
      if (!Number.isInteger(index)) return;
      schedulePanelState.expandedDayIndex = schedulePanelState.expandedDayIndex === index ? null : index;
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-schedule-send]').forEach(button => {
    button.addEventListener('click', () => {
      const text = String(button.dataset.slxScheduleSend || '').trim();
      if (!text) return;
      if (appendToChatInput(text)) {
        notifySchedule('success', '已填入聊天输入框。');
      }
    });
  });

  const getCurrentDays = () => {
    const current = getScheduleState(getChatState()).current;
    return current && Array.isArray(current.days) ? current.days : [];
  };

  const loadTextToInput = text => {
    const value = String(text || '').trim();
    if (!value) return;
    if (appendToChatInput(value)) {
      notifySchedule('success', '已填入聊天输入框。');
    }
  };

  panelRoot.querySelectorAll('[data-slx-schedule-load-main]').forEach(button => {
    button.addEventListener('click', () => {
      const day = getCurrentDays()[Number(button.dataset.slxScheduleLoadMain)];
      if (!day || !day.mainOpportunity) return;
      const theme = String(day.theme || '').trim();
      loadTextToInput(theme ? `（推进剧情：${theme} —— ${day.mainOpportunity}）` : `（推进剧情：${day.mainOpportunity}）`);
    });
  });

  panelRoot.querySelectorAll('[data-slx-schedule-load-mv]').forEach(button => {
    button.addEventListener('click', () => {
      const [dayIndex, movementIndex] = String(button.dataset.slxScheduleLoadMv || '').split(':').map(Number);
      const movement = normalizeScheduleMovement(getCurrentDays()[dayIndex]?.characterMovements?.[movementIndex], movementIndex);
      if (!movement?.summary) return;
      loadTextToInput(formatScheduleMovementLoadText(movement));
    });
  });

  panelRoot.querySelectorAll('[data-slx-schedule-load-day]').forEach(button => {
    button.addEventListener('click', () => {
      const day = getCurrentDays()[Number(button.dataset.slxScheduleLoadDay)];
      if (!day) return;
      const entryOptions = (Array.isArray(day.entryOptions) ? day.entryOptions : [])
        .map(getScheduleOptionText)
        .filter(Boolean);
      const lines = [];
      if (day.mainOpportunity) {
        const theme = String(day.theme || '').trim();
        lines.push(theme ? `（推进剧情：${theme} —— ${day.mainOpportunity}）` : `（推进剧情：${day.mainOpportunity}）`);
      }
      entryOptions.forEach(option => lines.push(option));
      (Array.isArray(day.characterMovements) ? day.characterMovements : [])
        .map((movement, movementIndex) => normalizeScheduleMovement(movement, movementIndex))
        .map(formatScheduleMovementLoadText)
        .filter(Boolean)
        .forEach(text => lines.push(text));
      loadTextToInput(lines.join('\n'));
    });
  });
}
