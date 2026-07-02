import { escapeHtml } from '../../utils/text.js';

let schedulePanelOptions = {
  refreshPanel: () => {},
};

export function configureSchedulePanel(options = {}) {
  schedulePanelOptions = {
    ...schedulePanelOptions,
    ...options,
  };
}

function getScheduleStore(chatState = {}) {
  const schedule = chatState.schedule && typeof chatState.schedule === 'object'
    ? chatState.schedule
    : {};
  return {
    activeScheduleId: String(schedule.activeScheduleId || ''),
    drafts: Array.isArray(schedule.drafts) ? schedule.drafts : [],
    entries: Array.isArray(schedule.entries) ? schedule.entries : [],
    lastGeneratedAt: String(schedule.lastGeneratedAt || ''),
    lastSavedAt: String(schedule.lastSavedAt || ''),
  };
}

function renderScheduleDayPlaceholder(day) {
  return `
    <div class="slx-schedule-day-card">
      <div class="slx-schedule-day-index">D${day}</div>
      <div class="slx-schedule-day-body">
        <b>剧情机会待生成</b>
        <span>主机会、介入入口与角色动向会在这里展开。</span>
      </div>
    </div>
  `;
}

export function renderSchedulePanel(settings, chatState) {
  const schedule = getScheduleStore(chatState);
  const savedCount = schedule.entries.length;
  const draftCount = schedule.drafts.length;
  const activeEntry = schedule.entries.find(item => item?.id === schedule.activeScheduleId) || schedule.entries[0];

  return `
    <div class="slx-schedule-root">
      <div class="slx-detail-card slx-schedule-hero">
        <div>
          <div class="slx-detail-title">日程表</div>
          <p>短期剧情机会表。后续会支持生成七天计划、编辑草稿、重 Roll，并把介入入口填入输入框。</p>
        </div>
        <div class="slx-schedule-stats">
          <span><b>${savedCount}</b> 已保存</span>
          <span><b>${draftCount}</b> 草稿</span>
        </div>
      </div>

      <div class="slx-detail-card slx-schedule-empty-card">
        <div class="slx-detail-title">${activeEntry ? escapeHtml(activeEntry.title || '当前日程') : '还没有日程表'}</div>
        <p>${activeEntry ? '当前仅接入模块入口与状态读取，生成和编辑会在下一阶段施工。' : '第一刀先建立独立模块入口。生成、编辑、保存和点击介入会逐步接上。'}</p>
        <div class="slx-schedule-grid">
          ${[1, 2, 3, 4, 5, 6, 7].map(renderScheduleDayPlaceholder).join('')}
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
}
