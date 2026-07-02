import { escapeHtml } from '../../utils/text.js';
import {
  getChatState,
  getGlobalSettings,
  getScheduleSettings,
  getScheduleState,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';
import { runScheduleGeneration } from './workflow.js';

let schedulePanelOptions = {
  refreshPanel: () => {},
};

let schedulePanelState = {
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

function normalizeOptionText(option) {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') return option.text || option.summary || '';
  return '';
}

function normalizeMovement(movement) {
  const source = movement && typeof movement === 'object' ? movement : {};
  return {
    character: String(source.character || '未命名角色').trim(),
    location: String(source.location || '').trim(),
    summary: String(source.summary || '').trim(),
    startsAt: String(source.startsAt || '').trim(),
    durationMinutes: Number.isFinite(Number(source.durationMinutes)) ? Number(source.durationMinutes) : 0,
    remainingMinutes: Number.isFinite(Number(source.remainingMinutes)) ? Number(source.remainingMinutes) : 0,
    status: String(source.status || 'pending').trim(),
    mainlineImpact: String(source.mainlineImpact || '').trim(),
  };
}

function renderScheduleMovement(movement) {
  const item = normalizeMovement(movement);
  const statusText = {
    pending: '待发生',
    active: '进行中',
    engaged: '已介入',
    done: '已结束',
  }[item.status] || item.status || '待发生';
  const metaItems = [
    item.startsAt,
    item.durationMinutes > 0 ? `${item.durationMinutes} 分钟` : '',
    item.remainingMinutes > 0 ? `剩余 ${item.remainingMinutes} 分钟` : '',
    statusText,
  ].filter(Boolean);

  return `
    <div class="slx-schedule-movement">
      <div class="slx-schedule-movement-head">
        <strong>${escapeHtml(item.character)}</strong>
        ${item.location ? `<span>${escapeHtml(item.location)}</span>` : ''}
      </div>
      ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      ${metaItems.length ? `<div class="slx-schedule-movement-meta">${metaItems.map(meta => `<span>${escapeHtml(meta)}</span>`).join('')}</div>` : ''}
      ${item.mainlineImpact ? `<div class="slx-schedule-impact">${escapeHtml(item.mainlineImpact)}</div>` : ''}
    </div>
  `;
}

function renderScheduleDay(day, index, hasCurrent) {
  if (!hasCurrent) {
    return `
      <div class="slx-schedule-day-card">
        <div class="slx-schedule-day-head">
          <div class="slx-schedule-day-index">D${index + 1}</div>
          <div>
            <b>剧情机会待生成</b>
            <span>${escapeHtml(`第${index + 1}天`)}</span>
          </div>
        </div>
        <div class="slx-schedule-section">
          <div class="slx-schedule-section-label">主机会</div>
          <p>主机会、介入入口与角色动向会在这里展开。</p>
        </div>
      </div>
    `;
  }
  const entryOptions = (Array.isArray(day.entryOptions) ? day.entryOptions : [])
    .map(normalizeOptionText)
    .filter(Boolean);
  const movements = Array.isArray(day.characterMovements) ? day.characterMovements : [];
  return `
    <div class="slx-schedule-day-card">
      <div class="slx-schedule-day-head">
        <div class="slx-schedule-day-index">D${escapeHtml(day.day || index + 1)}</div>
        <div>
          <b>${escapeHtml(day.theme || day.label || `第${index + 1}天`)}</b>
          <span>${escapeHtml(day.label || `第${index + 1}天`)}</span>
        </div>
      </div>
      <div class="slx-schedule-section slx-schedule-main">
        <div class="slx-schedule-section-label">主机会</div>
        <p>${escapeHtml(day.mainOpportunity || '暂无主剧情机会')}</p>
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
            ${movements.map(renderScheduleMovement).join('')}
          </div>
        </div>
      ` : ''}
      ${day.note ? `
        <div class="slx-schedule-section slx-schedule-note">
          <div class="slx-schedule-section-label">备注</div>
          <p>${escapeHtml(day.note)}</p>
        </div>
      ` : ''}
    </div>
  `;
}

export function renderSchedulePanel(settings, chatState) {
  const schedule = getScheduleState(chatState);
  const scheduleSettings = getScheduleSettings(settings);
  const current = schedule.current;
  const hasCurrent = Boolean(current);
  const days = hasCurrent && current.days.length
    ? current.days
    : [null, null, null, null, null, null, null];
  const isRunning = schedulePanelState.generationStatus === 'running';
  const disabled = isRunning ? 'disabled' : '';

  return `
    <div class="slx-schedule-root">
      <div class="slx-detail-card slx-schedule-generate-card">
        <div class="slx-detail-title">Roll 日程表</div>
        <label class="slx-field">
          <span>短期方向</span>
          <textarea rows="3" data-slx-schedule-direction placeholder="可写想看的短期推进、角色动向、冲突方向；也可以留空。" ${disabled}>${escapeHtml(schedulePanelState.userDirection)}</textarea>
        </label>
        <div class="slx-form-grid">
          <div class="slx-field">
            <span>API 模式</span>
            <div class="slx-segment-row slx-schedule-api-segment" role="group" aria-label="日程表 API 模式">
              <button class="slx-segment-btn ${scheduleSettings.apiMode === 'secondary_api' ? 'slx-segment-btn-active' : ''}" type="button" data-slx-schedule-api-mode="secondary_api" ${disabled}>副 API</button>
              <button class="slx-segment-btn ${scheduleSettings.apiMode === 'main_api' ? 'slx-segment-btn-active' : ''}" type="button" data-slx-schedule-api-mode="main_api" ${disabled}>主 API</button>
            </div>
          </div>
        </div>
        <div class="slx-schedule-btn-row">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-schedule-generate ${isRunning ? 'disabled' : ''}>${isRunning ? '生成中...' : hasCurrent ? '重 Roll 日程表' : '生成日程表'}</button>
        </div>
        ${schedulePanelState.generationStatus === 'success' ? '<div class="slx-field-hint">日程表已生成，并覆盖当前 Roll 结果。</div>' : ''}
        ${schedulePanelState.generationError ? `<div class="slx-schedule-error">${escapeHtml(schedulePanelState.generationError)}</div>` : ''}
      </div>

      <div class="slx-detail-card slx-schedule-hero">
        <div>
          <div class="slx-detail-title">日程表</div>
          <p>当前聊天的临时剧情菜单。Roll 出来的七日内容只保留当前这一份，可随时重 Roll 覆盖。</p>
        </div>
        <div class="slx-schedule-stats">
          <span><b>${hasCurrent ? 1 : 0}</b> 当前</span>
          <span><b>${escapeHtml(days.length)}</b> 天数</span>
        </div>
      </div>

      <div class="slx-detail-card slx-schedule-empty-card">
        <div class="slx-schedule-card-head">
          <div>
            <div class="slx-detail-title">${hasCurrent ? escapeHtml(current.title || '当前日程表') : '还没有日程表'}</div>
            <p>${hasCurrent ? `上次生成：${escapeHtml(schedule.lastGeneratedAt || '未记录')}` : '下一阶段接入 API 后，生成结果会直接覆盖当前日程表。'}</p>
          </div>
          ${hasCurrent ? '<button class="slx-soft-btn" type="button" data-slx-schedule-clear>清空</button>' : ''}
        </div>
        <div class="slx-schedule-grid">
          ${days.map((day, index) => renderScheduleDay(day || {}, index, hasCurrent)).join('')}
        </div>
      </div>

      <div class="slx-detail-card slx-schedule-note-card">
        <div class="slx-detail-title">施工边界</div>
        <p>日程表独立于剧情大纲；生成时可以参考大纲，但不会并入大纲模块。平行事件后续再消费这里的角色动向。</p>
      </div>
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
    schedulePanelState.userDirection = String(panelRoot.querySelector('[data-slx-schedule-direction]')?.value || '').trim();
    schedulePanelState.generationStatus = 'running';
    schedulePanelState.generationError = '';
    refreshPanel();
    try {
      const result = await runScheduleGeneration({ userDirection: schedulePanelState.userDirection });
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
    if (!confirm('清空当前日程表？')) return;
    const chatState = getChatState();
    const schedule = getScheduleState(chatState);
    schedule.current = null;
    schedule.lastGeneratedAt = '';
    saveChatState();
    schedulePanelState.generationStatus = 'idle';
    schedulePanelState.generationError = '';
    refreshPanel();
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
}
