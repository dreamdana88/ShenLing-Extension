import {
  getChatState,
  getGlobalSettings,
  getPlotOutlineSettings,
  getPlotOutlineState,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  cloneData,
  escapeHtml,
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import { runPlotOutlineGeneration } from './workflow.js';

let panelOptions = {
  refreshPanel: () => {},
};

let panelState = {
  draft: null,
  draftReplacements: 0,
  generationStatus: 'idle',
  generationError: '',
  editing: null,
  // 章节折叠状态：key 形如 'saved:CH01' / 'draft:CH01'，未记录时按默认规则展开
  expandedChapters: {},
  // 已有大纲时生成区折叠为 details，记录用户手动开合
  generateOpen: false,
};

function isChapterExpanded(scope, chapterId, fallback) {
  const key = `${scope}:${chapterId}`;
  return Object.hasOwn(panelState.expandedChapters, key)
    ? Boolean(panelState.expandedChapters[key])
    : fallback;
}

function clearExpandedChapters(scope = null) {
  if (!scope) {
    panelState.expandedChapters = {};
    return;
  }
  Object.keys(panelState.expandedChapters).forEach(key => {
    if (key.startsWith(`${scope}:`)) {
      delete panelState.expandedChapters[key];
    }
  });
}

export function configurePlotOutlinePanel(options = {}) {
  panelOptions = { ...panelOptions, ...options };
}

function refreshPanel() {
  panelOptions.refreshPanel();
}

function cloneOutlineData(data) {
  if (typeof structuredClone === 'function') {
    return structuredClone(data);
  }
  return cloneData(data);
}

function notifyOutline(type, message, title = '剧情大纲') {
  const toast = globalThis.toastr;
  if (toast && typeof toast[type] === 'function') {
    toast[type](message, title);
    return;
  }
  console[type === 'error' ? 'warn' : 'info'](`[${title}] ${message}`);
}

function normalizeEditedOutline(data) {
  const chapters = Array.isArray(data.chapters) ? data.chapters : [];
  chapters.forEach((chapter, index) => {
    chapter.id = `CH${String(index + 1).padStart(2, '0')}`;
    chapter.exitChapterId = index < chapters.length - 1
      ? `CH${String(index + 2).padStart(2, '0')}`
      : '';
  });
  return {
    storyCore: {
      logline: String(data.storyCore?.logline || '').trim(),
      conflict: String(data.storyCore?.conflict || '').trim(),
      tone: String(data.storyCore?.tone || '').trim(),
    },
    chapters,
  };
}

function renderStoryCoreBlock(storyCore = {}) {
  return `
    <div class="slx-outline-story-core">
      <div class="slx-outline-core-row">
        <span class="slx-outline-core-label">主线</span>
        <span class="slx-outline-core-value">${escapeHtml(storyCore.logline || '未填写')}</span>
      </div>
      <div class="slx-outline-core-row">
        <span class="slx-outline-core-label">冲突</span>
        <span class="slx-outline-core-value">${escapeHtml(storyCore.conflict || '未填写')}</span>
      </div>
      <div class="slx-outline-core-row">
        <span class="slx-outline-core-label">基调</span>
        <span class="slx-outline-core-value">${escapeHtml(storyCore.tone || '未填写')}</span>
      </div>
    </div>
  `;
}

function renderChapterBlock(chapter, { scope = 'saved', progress = {}, readonly = false, isCurrent = false } = {}) {
  const chapterProgress = isPlainObject(progress[chapter.id]) ? progress[chapter.id] : {};
  const totalCount = chapter.conditions?.length || 0;
  const doneCount = totalCount
    ? chapter.conditions.filter(condition => chapterProgress[condition.id]).length
    : 0;
  const expanded = isChapterExpanded(scope, chapter.id, scope === 'draft' ? true : isCurrent);
  const tagName = readonly ? 'div' : 'button type="button"';
  const closingTag = readonly ? 'div' : 'button';
  const cardClasses = [
    'slx-outline-chapter-card',
    isCurrent ? 'slx-outline-chapter-current' : '',
    expanded ? 'slx-outline-chapter-expanded' : 'slx-outline-chapter-collapsed',
  ].filter(Boolean).join(' ');

  const body = `
    <div class="slx-outline-chapter-body">
      ${chapter.theme ? `<div class="slx-outline-chapter-line"><span>主题</span><div>${escapeHtml(chapter.theme)}</div></div>` : ''}
      ${chapter.synopsis ? `<div class="slx-outline-chapter-line"><span>脉络</span><div>${escapeHtml(chapter.synopsis)}</div></div>` : ''}
      ${chapter.keyEvents?.length ? `
        <div class="slx-outline-chapter-line"><span>关键事件</span>
          <ul class="slx-outline-event-list">${chapter.keyEvents.map(event => `<li>${escapeHtml(event)}</li>`).join('')}</ul>
        </div>` : ''}
      ${chapter.conditions?.length ? `
        <div class="slx-outline-chapter-line"><span>推进条件</span>
          <div class="slx-outline-checklist">
            ${chapter.conditions.map(condition => {
              const done = Boolean(chapterProgress[condition.id]);
              return `
                <${tagName} class="slx-outline-check-item ${done ? 'slx-outline-check-done' : ''}"
                  ${readonly ? '' : `data-slx-outline-toggle-condition="${escapeHtml(chapter.id)}|${escapeHtml(condition.id)}"`}>
                  <span class="slx-outline-check-box">${done ? '✅' : '⬜'}</span>
                  <span>${escapeHtml(condition.id)}. ${escapeHtml(condition.text)}</span>
                </${closingTag}>
              `;
            }).join('')}
          </div>
        </div>` : ''}
      ${chapter.exitChapterId ? `<div class="slx-outline-chapter-line"><span>出口</span><div>${escapeHtml(chapter.exitChapterId)}</div></div>` : ''}
      ${scope === 'saved' && !readonly && !isCurrent ? `
        <div class="slx-outline-btn-row">
          <button class="slx-soft-btn" type="button" data-slx-outline-set-current="${escapeHtml(chapter.id)}">设为当前章节</button>
        </div>` : ''}
    </div>
  `;

  return `
    <div class="${cardClasses}">
      <button class="slx-outline-chapter-head" type="button" data-slx-outline-toggle-chapter="${escapeHtml(scope)}|${escapeHtml(chapter.id)}" title="${expanded ? '收起章节' : '展开章节'}">
        <span class="slx-outline-chevron" aria-hidden="true">▸</span>
        <span class="slx-outline-chapter-badge">${escapeHtml(chapter.id)}</span>
        <b>${escapeHtml(chapter.title)}</b>
        ${chapter.stage ? `<span class="slx-outline-stage-badge" data-stage="${escapeHtml(chapter.stage)}">${escapeHtml(chapter.stage)}</span>` : ''}
        <span class="slx-outline-head-tail">
          ${totalCount && scope === 'saved' ? `<span class="slx-outline-progress-badge ${doneCount === totalCount ? 'slx-outline-progress-done' : ''}">${doneCount}/${totalCount}</span>` : ''}
          ${isCurrent ? '<span class="slx-outline-current-mark">当前</span>' : ''}
        </span>
      </button>
      ${expanded ? body : ''}
    </div>
  `;
}

function renderGenerateCard(outline, plotSettings, { collapsed = false } = {}) {
  const isRunning = panelState.generationStatus === 'running';
  const hasSavedOutline = outline.chapters.length > 0;
  const disabled = isRunning ? 'disabled' : '';
  const body = `
      <label class="slx-field">
        <span>剧情方向</span>
        <textarea rows="3" data-slx-outline-user-direction placeholder="可写想看的主线方向、关系张力、案件目标或结局倾向。" ${disabled}>${escapeHtml(outline.userDirection || '')}</textarea>
      </label>
      <div class="slx-form-grid">
        <label class="slx-field">
          <span>章节数</span>
          <select data-slx-outline-chapter-count ${disabled}>
            ${[
              ['auto', '自动（4-6章）'],
              ['4', '4章'],
              ['5', '5章'],
              ['6', '6章'],
              ['8', '8章'],
            ].map(([value, label]) => `<option value="${value}" ${String(plotSettings.chapterCount) === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="slx-field">
          <span>API 模式</span>
          <select data-slx-outline-api-mode ${disabled}>
            <option value="secondary_api" ${plotSettings.apiMode === 'secondary_api' ? 'selected' : ''}>独立副 API</option>
            <option value="main_api" ${plotSettings.apiMode === 'main_api' ? 'selected' : ''}>使用主 API</option>
          </select>
        </label>
      </div>
      <div class="slx-outline-btn-row">
        <button class="slx-soft-btn" type="button" data-slx-outline-generate ${isRunning ? 'disabled' : ''}>${isRunning ? '生成中...' : hasSavedOutline ? '重 Roll 大纲' : '生成剧情大纲'}</button>
      </div>
      ${panelState.generationStatus === 'success' ? `<div class="slx-field-hint">草稿已生成，确认后可保存到当前聊天。</div>` : ''}
      ${panelState.generationError ? `<div class="slx-outline-error">${escapeHtml(panelState.generationError)}</div>` : ''}
  `;

  if (!collapsed) {
    return `
      <div class="slx-detail-card">
        <div class="slx-detail-title">生成剧情大纲</div>
        ${body}
      </div>
    `;
  }

  // 已有大纲时折叠为 details，生成中强制展开以显示状态
  const open = isRunning || panelState.generateOpen;
  return `
    <details class="slx-detail-card slx-outline-gen-details" data-slx-outline-gen-details ${open ? 'open' : ''}>
      <summary class="slx-outline-gen-summary">🎲 重新生成大纲</summary>
      ${body}
    </details>
  `;
}

function renderDraftCard() {
  if (!panelState.draft) return '';
  const draft = panelState.draft;
  return `
    <div class="slx-detail-card slx-outline-draft-card">
      <div class="slx-detail-title">剧情大纲草稿 <span class="slx-outline-draft-badge">未保存</span></div>
      ${renderStoryCoreBlock(draft.storyCore)}
      ${draft.chapters.map(chapter => renderChapterBlock(chapter, { scope: 'draft', readonly: true })).join('')}
      <div class="slx-outline-btn-row">
        <button class="slx-soft-btn" type="button" data-slx-outline-save-draft>保存大纲</button>
        <button class="slx-soft-btn" type="button" data-slx-outline-edit-draft>编辑草稿</button>
        <button class="slx-soft-btn" type="button" data-slx-outline-discard-draft>放弃草稿</button>
      </div>
      <div class="slx-field-hint">草稿尚未写入当前聊天 metadata。${panelState.draftReplacements ? `禁词替换 ${escapeHtml(String(panelState.draftReplacements))} 处。` : ''}</div>
    </div>
  `;
}

function renderEmptyHint() {
  return `
    <div class="slx-detail-card slx-outline-empty-card">
      <div class="slx-outline-empty-icon">🧭</div>
      <div class="slx-outline-empty-title">尚未保存剧情大纲</div>
      <p class="slx-outline-empty-hint">填写期望方向并点击「生成剧情大纲」，AI 会参考角色、世界书与近期剧情生成章节蓝图。</p>
    </div>
  `;
}

function renderSavedOutline(outline) {
  if (!outline.chapters.length) return '';
  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">当前大纲</div>
      ${renderStoryCoreBlock(outline.storyCore)}
      <label class="slx-field">
        <span>当前章节</span>
        <select data-slx-outline-current-chapter>
          ${outline.chapters.map(chapter => `<option value="${escapeHtml(chapter.id)}" ${chapter.id === outline.currentChapterId ? 'selected' : ''}>${escapeHtml(chapter.id)} ${escapeHtml(chapter.title)}</option>`).join('')}
        </select>
      </label>
      ${outline.chapters.map(chapter => renderChapterBlock(chapter, {
        scope: 'saved',
        progress: outline.progress,
        readonly: false,
        isCurrent: chapter.id === outline.currentChapterId,
      })).join('')}
      <div class="slx-outline-btn-row">
        <button class="slx-soft-btn" type="button" data-slx-outline-edit-saved>编辑</button>
        <button class="slx-soft-btn" type="button" data-slx-outline-reset>重置进度</button>
        <button class="slx-soft-btn" type="button" data-slx-outline-clear>清空大纲</button>
      </div>
      <div class="slx-field-hint">更新于 ${escapeHtml(outline.updatedAt || '未记录')}</div>
    </div>
  `;
}

function renderOutlineEditor(editing) {
  const data = editing.data;
  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">编辑大纲${editing.target === 'draft' ? '草稿' : ''}</div>
      <div class="slx-form-grid">
        <label class="slx-field"><span>一句话主线</span><input type="text" data-slx-outline-edit="logline" value="${escapeHtml(data.storyCore.logline)}" /></label>
        <label class="slx-field"><span>核心冲突</span><input type="text" data-slx-outline-edit="conflict" value="${escapeHtml(data.storyCore.conflict)}" /></label>
        <label class="slx-field"><span>叙事基调</span><input type="text" data-slx-outline-edit="tone" value="${escapeHtml(data.storyCore.tone)}" /></label>
      </div>
      ${data.chapters.map((chapter, index) => `
        <div class="slx-outline-chapter-card" data-slx-outline-edit-chapter="${index}">
          <div class="slx-outline-chapter-head"><span class="slx-outline-chapter-badge">${escapeHtml(chapter.id)}</span></div>
          <div class="slx-form-grid">
            <label class="slx-field"><span>章节名</span><input type="text" data-slx-chapter-field="title" value="${escapeHtml(chapter.title)}" /></label>
            <label class="slx-field"><span>叙事阶段</span>
              <select data-slx-chapter-field="stage">
                ${['', '起', '承', '转', '合'].map(stage => `<option value="${stage}" ${chapter.stage === stage ? 'selected' : ''}>${stage || '未设置'}</option>`).join('')}
              </select>
            </label>
            <label class="slx-field"><span>主题</span><input type="text" data-slx-chapter-field="theme" value="${escapeHtml(chapter.theme)}" /></label>
            <label class="slx-field"><span>剧情脉络</span><textarea rows="3" data-slx-chapter-field="synopsis">${escapeHtml(chapter.synopsis)}</textarea></label>
            <label class="slx-field"><span>关键事件（每行一条）</span><textarea rows="3" data-slx-chapter-field="keyEvents">${escapeHtml(chapter.keyEvents.join('\n'))}</textarea></label>
            <label class="slx-field"><span>推进条件（每行一条，自动编号）</span><textarea rows="3" data-slx-chapter-field="conditions">${escapeHtml(chapter.conditions.map(condition => condition.text).join('\n'))}</textarea></label>
          </div>
        </div>
      `).join('')}
      <div class="slx-outline-btn-row">
        <button class="slx-soft-btn" type="button" data-slx-outline-editor-save>保存修改</button>
        <button class="slx-soft-btn" type="button" data-slx-outline-editor-cancel>取消</button>
      </div>
      <div class="slx-field-hint">出口章节按顺序自动维护，无需手动填写。</div>
    </div>
  `;
}

export function renderPlotOutlinePanel(settings, chatState) {
  const outline = getPlotOutlineState(chatState);
  const plotSettings = getPlotOutlineSettings(settings);
  if (panelState.editing) {
    return renderOutlineEditor(panelState.editing);
  }
  const hasOutline = outline.chapters.length > 0;
  if (!hasOutline) {
    return `
      ${renderGenerateCard(outline, plotSettings, { collapsed: false })}
      ${renderDraftCard()}
      ${panelState.draft ? '' : renderEmptyHint()}
    `;
  }
  return `
    ${renderDraftCard()}
    ${renderSavedOutline(outline)}
    ${renderGenerateCard(outline, plotSettings, { collapsed: true })}
  `;
}

function readDirectionAndPersist(panelRoot) {
  const chatState = getChatState();
  const outline = getPlotOutlineState(chatState);
  outline.userDirection = String(panelRoot.querySelector('[data-slx-outline-user-direction]')?.value || '').trim();
  saveChatState();
  return outline.userDirection;
}

function bindEditorEvents(panelRoot) {
  panelRoot.querySelector('[data-slx-outline-edit-draft]')?.addEventListener('click', () => {
    if (!panelState.draft) return;
    panelState.editing = { target: 'draft', data: cloneOutlineData(panelState.draft) };
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-edit-saved]')?.addEventListener('click', () => {
    const outline = getPlotOutlineState(getChatState());
    if (!outline.chapters.length) return;
    panelState.editing = {
      target: 'saved',
      data: cloneOutlineData({ storyCore: outline.storyCore, chapters: outline.chapters }),
    };
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-editor-cancel]')?.addEventListener('click', () => {
    panelState.editing = null;
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-editor-save]')?.addEventListener('click', () => {
    const editing = panelState.editing;
    if (!editing) return;
    const data = editing.data;
    data.storyCore.logline = String(panelRoot.querySelector('[data-slx-outline-edit="logline"]')?.value || '').trim();
    data.storyCore.conflict = String(panelRoot.querySelector('[data-slx-outline-edit="conflict"]')?.value || '').trim();
    data.storyCore.tone = String(panelRoot.querySelector('[data-slx-outline-edit="tone"]')?.value || '').trim();

    panelRoot.querySelectorAll('[data-slx-outline-edit-chapter]').forEach(card => {
      const chapter = data.chapters[Number(card.dataset.slxOutlineEditChapter)];
      if (!chapter) return;
      const readField = name => String(card.querySelector(`[data-slx-chapter-field="${name}"]`)?.value || '').trim();
      chapter.title = readField('title') || chapter.id;
      chapter.stage = readField('stage');
      chapter.theme = readField('theme');
      chapter.synopsis = readField('synopsis');
      chapter.keyEvents = readField('keyEvents').split('\n').map(line => line.trim()).filter(Boolean);
      chapter.conditions = readField('conditions').split('\n').map(line => line.trim()).filter(Boolean)
        .map((text, index) => ({ id: `C${index + 1}`, text: text.replace(/^C?\d+[.、]\s*/, '') }));
    });

    const normalized = normalizeEditedOutline(data);
    if (editing.target === 'draft') {
      panelState.draft = normalized;
    } else {
      const chatState = getChatState();
      const outline = getPlotOutlineState(chatState);
      outline.storyCore = normalized.storyCore;
      outline.chapters = normalized.chapters;
      if (!outline.chapters.some(chapter => chapter.id === outline.currentChapterId)) {
        outline.currentChapterId = outline.chapters[0]?.id || '';
      }
      outline.updatedAt = formatTimestamp();
      saveChatState();
    }
    panelState.editing = null;
    notifyOutline('success', '大纲修改已保存。');
    refreshPanel();
  });
}

export function bindPlotOutlinePanelEvents(panelRoot) {
  panelRoot.querySelector('[data-slx-outline-enabled]')?.addEventListener('change', event => {
    const chatState = getChatState();
    const outline = getPlotOutlineState(chatState);
    outline.enabled = Boolean(event.currentTarget.checked);
    outline.updatedAt = formatTimestamp();
    saveChatState();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-api-mode]')?.addEventListener('change', event => {
    const settings = getGlobalSettings();
    const plotSettings = getPlotOutlineSettings(settings);
    plotSettings.apiMode = event.currentTarget.value === 'main_api' ? 'main_api' : 'secondary_api';
    saveGlobalSettings();
  });

  panelRoot.querySelector('[data-slx-outline-chapter-count]')?.addEventListener('change', event => {
    const settings = getGlobalSettings();
    const plotSettings = getPlotOutlineSettings(settings);
    plotSettings.chapterCount = event.currentTarget.value;
    saveGlobalSettings();
  });

  panelRoot.querySelector('[data-slx-outline-user-direction]')?.addEventListener('change', () => {
    readDirectionAndPersist(panelRoot);
  });

  panelRoot.querySelector('[data-slx-outline-generate]')?.addEventListener('click', async () => {
    if (panelState.generationStatus === 'running') return;
    const userDirection = readDirectionAndPersist(panelRoot);
    panelState.generationStatus = 'running';
    panelState.generationError = '';
    refreshPanel();
    try {
      const result = await runPlotOutlineGeneration({ userDirection });
      panelState.draft = result.draft;
      panelState.draftReplacements = result.replacements || 0;
      panelState.generationStatus = 'success';
      clearExpandedChapters('draft');
      if (panelState.draftReplacements > 0) {
        notifyOutline('success', `剧情大纲生成结果已替换 ${panelState.draftReplacements} 处。`, '禁词替换');
      }
    } catch (error) {
      panelState.generationStatus = 'failed';
      panelState.generationError = error.message || String(error);
      notifyOutline('error', panelState.generationError);
    }
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-save-draft]')?.addEventListener('click', () => {
    if (!panelState.draft) return;
    const chatState = getChatState();
    const outline = getPlotOutlineState(chatState);
    outline.storyCore = panelState.draft.storyCore;
    outline.chapters = panelState.draft.chapters;
    outline.currentChapterId = panelState.draft.chapters[0]?.id || '';
    outline.progress = {};
    outline.updatedAt = formatTimestamp();
    saveChatState();
    panelState.draft = null;
    panelState.draftReplacements = 0;
    panelState.generationStatus = 'idle';
    panelState.generateOpen = false;
    clearExpandedChapters();
    notifyOutline('success', '剧情大纲已保存到当前聊天。');
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-discard-draft]')?.addEventListener('click', () => {
    panelState.draft = null;
    panelState.draftReplacements = 0;
    panelState.generationStatus = 'idle';
    clearExpandedChapters('draft');
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-current-chapter]')?.addEventListener('change', event => {
    const chatState = getChatState();
    const outline = getPlotOutlineState(chatState);
    outline.currentChapterId = event.currentTarget.value;
    outline.updatedAt = formatTimestamp();
    saveChatState();
    refreshPanel();
  });

  panelRoot.querySelectorAll('[data-slx-outline-toggle-condition]').forEach(button => {
    button.addEventListener('click', () => {
      const [chapterId, conditionId] = String(button.dataset.slxOutlineToggleCondition).split('|');
      if (!chapterId || !conditionId) return;
      const chatState = getChatState();
      const outline = getPlotOutlineState(chatState);
      if (!isPlainObject(outline.progress[chapterId])) {
        outline.progress[chapterId] = {};
      }
      outline.progress[chapterId][conditionId] = !outline.progress[chapterId][conditionId];
      outline.updatedAt = formatTimestamp();
      saveChatState();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-outline-reset]')?.addEventListener('click', () => {
    if (!confirm('重置所有推进进度，并把当前章节切回第一章？')) return;
    const chatState = getChatState();
    const outline = getPlotOutlineState(chatState);
    outline.progress = {};
    outline.currentChapterId = outline.chapters[0]?.id || '';
    outline.updatedAt = formatTimestamp();
    saveChatState();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-outline-clear]')?.addEventListener('click', () => {
    if (!confirm('清空整个剧情大纲？此操作不可恢复。')) return;
    const chatState = getChatState();
    const outline = getPlotOutlineState(chatState);
    outline.storyCore = { logline: '', conflict: '', tone: '' };
    outline.chapters = [];
    outline.currentChapterId = '';
    outline.progress = {};
    outline.updatedAt = formatTimestamp();
    saveChatState();
    clearExpandedChapters();
    panelState.generateOpen = false;
    notifyOutline('info', '剧情大纲已清空。');
    refreshPanel();
  });

  panelRoot.querySelectorAll('[data-slx-outline-toggle-chapter]').forEach(button => {
    button.addEventListener('click', () => {
      const [scope, chapterId] = String(button.dataset.slxOutlineToggleChapter).split('|');
      if (!scope || !chapterId) return;
      const fallback = scope === 'draft'
        ? true
        : chapterId === getPlotOutlineState(getChatState()).currentChapterId;
      panelState.expandedChapters[`${scope}:${chapterId}`] = !isChapterExpanded(scope, chapterId, fallback);
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-outline-set-current]').forEach(button => {
    button.addEventListener('click', () => {
      const chapterId = String(button.dataset.slxOutlineSetCurrent || '');
      if (!chapterId) return;
      const chatState = getChatState();
      const outline = getPlotOutlineState(chatState);
      outline.currentChapterId = chapterId;
      outline.updatedAt = formatTimestamp();
      saveChatState();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-outline-gen-details]')?.addEventListener('toggle', event => {
    panelState.generateOpen = event.currentTarget.open;
  });

  bindEditorEvents(panelRoot);
}
