import { escapeHtml } from '../../utils/text.js';
import {
  getChatState,
  getScheduleState,
  saveChatState,
} from '../../core/settings.js';

let schedulePanelOptions = {
  refreshPanel: () => {},
};

export function configureSchedulePanel(options = {}) {
  schedulePanelOptions = {
    ...schedulePanelOptions,
    ...options,
  };
}

function normalizeOptionText(option) {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') return option.text || option.summary || '';
  return '';
}

function renderScheduleDay(day, index, hasCurrent) {
  if (!hasCurrent) {
    return `
      <div class="slx-schedule-day-card">
        <div class="slx-schedule-day-index">D${index + 1}</div>
        <div class="slx-schedule-day-body">
          <b>剧情机会待生成</b>
          <span>主机会、介入入口与角色动向会在这里展开。</span>
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
      <div class="slx-schedule-day-index">D${escapeHtml(day.day || index + 1)}</div>
      <div class="slx-schedule-day-body">
        <b>${escapeHtml(day.theme || day.label || `第${index + 1}天`)}</b>
        <span>${escapeHtml(day.mainOpportunity || '暂无主剧情机会')}</span>
        ${entryOptions.length ? `
          <div class="slx-schedule-chip-list">
            ${entryOptions.map(option => `<button class="slx-schedule-chip" type="button" disabled>${escapeHtml(option)}</button>`).join('')}
          </div>
        ` : ''}
        ${movements.length ? `<small>${escapeHtml(movements.length)} 条角色动向</small>` : ''}
      </div>
    </div>
  `;
}

export function renderSchedulePanel(settings, chatState) {
  const schedule = getScheduleState(chatState);
  const current = schedule.current;
  const hasCurrent = Boolean(current);
  const days = hasCurrent ? current.days : [null, null, null, null, null, null, null];

  return `
    <div class="slx-schedule-root">
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
  panelRoot.querySelector('[data-slx-schedule-clear]')?.addEventListener('click', () => {
    if (!confirm('清空当前日程表？')) return;
    const chatState = getChatState();
    const schedule = getScheduleState(chatState);
    schedule.current = null;
    schedule.lastGeneratedAt = '';
    saveChatState();
    schedulePanelOptions.refreshPanel();
  });
}
