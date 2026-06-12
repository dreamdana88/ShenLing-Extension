import {
  getChatState,
  getPlotOutlineState,
  saveChatState,
} from '../../core/settings.js';
import {
  escapeHtml,
} from '../../utils/text.js';

let panelOptions = {
  refreshPanel: () => {},
};

export function configurePlotOutlinePanel(options = {}) {
  panelOptions = { ...panelOptions, ...options };
}

function refreshPanel() {
  panelOptions.refreshPanel();
}

function renderEmptyStateCard() {
  return `
    <div class="slx-detail-card slx-outline-empty-card">
      <div class="slx-outline-empty-icon">🧭</div>
      <div class="slx-outline-empty-title">尚未生成剧情大纲</div>
      <p class="slx-outline-empty-hint">生成大纲后，故事核心、章节蓝图与推进条件将显示在这里。</p>
      <div class="slx-outline-btn-row">
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">生成剧情大纲</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">编辑</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">保存</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">清空</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">重置</button>
      </div>
      <div class="slx-field-hint">API 生成功能待第二阶段接入。</div>
    </div>
  `;
}

function renderOutlineCard(outline) {
  const chapterCount = outline.chapters.length;
  return `
    <div class="slx-detail-card slx-outline-has-card">
      <div class="slx-outline-story-core">
        <div class="slx-detail-title">故事核心</div>
        <div class="slx-outline-core-row">
          <span class="slx-outline-core-label">主线</span>
          <span class="slx-outline-core-value">${escapeHtml(outline.storyCore.logline || '—')}</span>
        </div>
        <div class="slx-outline-core-row">
          <span class="slx-outline-core-label">冲突</span>
          <span class="slx-outline-core-value">${escapeHtml(outline.storyCore.conflict || '—')}</span>
        </div>
        <div class="slx-outline-core-row">
          <span class="slx-outline-core-label">基调</span>
          <span class="slx-outline-core-value">${escapeHtml(outline.storyCore.tone || '—')}</span>
        </div>
      </div>
      <div class="slx-outline-btn-row">
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">生成剧情大纲</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">编辑</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">保存</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">清空</button>
        <button class="slx-soft-btn" type="button" disabled title="待第二阶段接入">重置</button>
      </div>
      <div class="slx-field-hint">共 ${escapeHtml(String(chapterCount))} 章 · API 生成功能待第二阶段接入。</div>
    </div>
  `;
}

function renderChapterStatusCard(outline) {
  const currentId = outline.currentChapterId;
  const chapters = outline.chapters;
  const currentChapter = chapters.find(ch => ch.id === currentId);
  const chapterCount = chapters.length;

  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">当前章节</div>
      <div class="slx-outline-chapter-status">
        ${currentId
          ? `<span class="slx-outline-chapter-badge">${escapeHtml(currentId)}</span>
             <span class="slx-outline-chapter-title">${escapeHtml(currentChapter?.title || '未命名章节')}</span>`
          : `<span class="slx-outline-chapter-empty">未设置</span>`
        }
        ${chapterCount > 0 ? `<span class="slx-outline-chapter-count">共 ${escapeHtml(String(chapterCount))} 章</span>` : ''}
      </div>
    </div>
  `;
}

function renderProgressChecklist(outline) {
  const currentId = outline.currentChapterId;
  const chapters = outline.chapters;
  const progress = outline.progress;

  if (chapters.length === 0) {
    return `
      <div class="slx-detail-card">
        <div class="slx-detail-title">推进条件</div>
        <div class="slx-outline-checklist slx-outline-checklist-placeholder">
          <div class="slx-outline-check-item slx-outline-check-placeholder">
            <span class="slx-outline-check-box">⬜</span>
            <span>C1. 推进条件占位</span>
          </div>
          <div class="slx-outline-check-item slx-outline-check-placeholder">
            <span class="slx-outline-check-box">⬜</span>
            <span>C2. 推进条件占位</span>
          </div>
          <div class="slx-outline-check-item slx-outline-check-placeholder">
            <span class="slx-outline-check-box">⬜</span>
            <span>C3. 推进条件占位</span>
          </div>
        </div>
        <div class="slx-field-hint">生成大纲后显示当前章节推进条件。</div>
      </div>
    `;
  }

  const currentChapter = chapters.find(ch => ch.id === currentId);
  const conditions = currentChapter?.conditions || [];
  const chapterProgress = (currentId && isPlainObject(progress[currentId])) ? progress[currentId] : {};

  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">推进条件${currentId ? ` · ${escapeHtml(currentId)}` : ''}</div>
      ${conditions.length === 0
        ? `<div class="slx-outline-checklist-empty">当前章节暂无推进条件。</div>`
        : `<div class="slx-outline-checklist">
            ${conditions.map(cond => {
              const done = Boolean(chapterProgress[cond.id]);
              return `
                <div class="slx-outline-check-item ${done ? 'slx-outline-check-done' : ''}">
                  <span class="slx-outline-check-box">${done ? '✅' : '⬜'}</span>
                  <span>${escapeHtml(cond.id)}. ${escapeHtml(cond.text || '')}</span>
                </div>
              `;
            }).join('')}
          </div>`
      }
      <div class="slx-field-hint">壳子阶段只读，手动勾选功能待后续阶段接入。</div>
    </div>
  `;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

export function renderPlotOutlinePanel(settings, chatState) {
  const outline = getPlotOutlineState(chatState);
  const hasOutline = outline.chapters.length > 0 || outline.storyCore.logline;

  return `
    ${hasOutline ? renderOutlineCard(outline) : renderEmptyStateCard()}
    ${renderChapterStatusCard(outline)}
    ${renderProgressChecklist(outline)}
  `;
}

export function bindPlotOutlinePanelEvents(panelRoot) {
  panelRoot.querySelector('[data-slx-outline-enabled]')?.addEventListener('change', event => {
    const chatState = getChatState();
    const outline = getPlotOutlineState(chatState);
    outline.enabled = Boolean(event.currentTarget.checked);
    outline.updatedAt = new Date().toISOString();
    saveChatState();
    refreshPanel();
  });
}
