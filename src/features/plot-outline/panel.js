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
import {
  runPlotOutlineGeneration,
  syncPlotOutlineInjection,
} from './workflow.js';

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

export function isPlotOutlineEditorOpen() {
  return Boolean(panelState.editing);
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

function scheduleInjectionSync() {
  void syncPlotOutlineInjection().catch(error => {
    console.warn('[蜃灵助手] 剧情大纲注入同步失败。', error);
  });
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
        <div class="slx-field">
          <span>API 模式</span>
          <div class="slx-segment-row slx-outline-api-segment" role="group" aria-label="剧情大纲 API 模式">
            <button class="slx-segment-btn ${plotSettings.apiMode === 'secondary_api' ? 'slx-segment-btn-active' : ''}" type="button" data-slx-outline-api-mode="secondary_api" ${disabled}>副 API</button>
            <button class="slx-segment-btn ${plotSettings.apiMode === 'main_api' ? 'slx-segment-btn-active' : ''}" type="button" data-slx-outline-api-mode="main_api" ${disabled}>主 API</button>
          </div>
        </div>
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
  const injecting = Boolean(outline.enabled);
  return `
    <div class="slx-detail-card">
      <div class="slx-detail-title">当前大纲 <span class="slx-outline-inject-badge ${injecting ? 'slx-outline-inject-on' : ''}">${injecting ? '注入中' : '未注入'}</span></div>
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

function renderOutlineEditorOverlay(editing) {
  if (!editing) return '';
  const data = editing.data;
  const theme = getGlobalSettings().theme === 'dark' ? 'dark' : 'light';
  const title = editing.target === 'draft' ? '编辑大纲草稿' : '编辑当前大纲';
  const meta = `${data.chapters.length} 章 · 出口章节按顺序自动维护`;
  return `
    <div class="slx-outline-overlay slx-outline-editor-overlay" data-theme="${theme}" data-slx-outline-editor-overlay role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="slx-outline-editor">
        <div class="slx-outline-editor-header">
          <div class="slx-outline-editor-title-wrap">
            <span class="slx-outline-editor-title">${escapeHtml(title)}</span>
            <span class="slx-outline-editor-meta">${escapeHtml(meta)}</span>
          </div>
          <button class="slx-icon-btn" type="button" data-slx-outline-editor-cancel aria-label="关闭编辑器">×</button>
        </div>
        <div class="slx-outline-editor-body">
          <section class="slx-outline-editor-section">
            <div class="slx-outline-editor-section-title">故事核心</div>
            <div class="slx-outline-editor-core-grid">
              <label class="slx-outline-editor-field"><span>一句话主线</span><input type="text" data-slx-outline-edit="logline" value="${escapeHtml(data.storyCore.logline)}" /></label>
              <label class="slx-outline-editor-field"><span>核心冲突</span><input type="text" data-slx-outline-edit="conflict" value="${escapeHtml(data.storyCore.conflict)}" /></label>
              <label class="slx-outline-editor-field"><span>叙事基调</span><input type="text" data-slx-outline-edit="tone" value="${escapeHtml(data.storyCore.tone)}" /></label>
            </div>
          </section>
          ${data.chapters.map((chapter, index) => `
            <section class="slx-outline-editor-chapter" data-slx-outline-edit-chapter="${index}">
              <div class="slx-outline-editor-chapter-head">
                <span class="slx-outline-chapter-badge">${escapeHtml(chapter.id)}</span>
                <b>${escapeHtml(chapter.title || '未命名章节')}</b>
              </div>
              <div class="slx-outline-editor-chapter-grid">
                <label class="slx-outline-editor-field"><span>章节名</span><input type="text" data-slx-chapter-field="title" value="${escapeHtml(chapter.title)}" /></label>
                <label class="slx-outline-editor-field"><span>叙事阶段</span>
                  <select data-slx-chapter-field="stage">
                    ${['', '起', '承', '转', '合'].map(stage => `<option value="${stage}" ${chapter.stage === stage ? 'selected' : ''}>${stage || '未设置'}</option>`).join('')}
                  </select>
                </label>
                <label class="slx-outline-editor-field slx-outline-editor-field-wide"><span>主题</span><input type="text" data-slx-chapter-field="theme" value="${escapeHtml(chapter.theme)}" /></label>
                <label class="slx-outline-editor-field slx-outline-editor-field-wide"><span>剧情脉络</span><textarea rows="4" data-slx-chapter-field="synopsis">${escapeHtml(chapter.synopsis)}</textarea></label>
                <label class="slx-outline-editor-field"><span>关键事件（每行一条）</span><textarea rows="6" data-slx-chapter-field="keyEvents">${escapeHtml(chapter.keyEvents.join('\\n'))}</textarea></label>
                <label class="slx-outline-editor-field"><span>推进条件（每行一条，自动编号）</span><textarea rows="6" data-slx-chapter-field="conditions">${escapeHtml(chapter.conditions.map(condition => condition.text).join('\\n'))}</textarea></label>
              </div>
            </section>
          `).join('')}
        </div>
        <div class="slx-outline-editor-footer">
          <button class="slx-soft-btn" type="button" data-slx-outline-editor-cancel>取消</button>
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-outline-editor-save>保存修改</button>
        </div>
      </div>
    </div>
  `;
}

export function renderPlotOutlinePanel(settings, chatState) {
  const outline = getPlotOutlineState(chatState);
  const plotSettings = getPlotOutlineSettings(settings);
  const hasOutline = outline.chapters.length > 0;
  const mainContent = !hasOutline
    ? `
      ${renderGenerateCard(outline, plotSettings, { collapsed: false })}
      ${renderDraftCard()}
      ${panelState.draft ? '' : renderEmptyHint()}
    `
    : `
      ${renderDraftCard()}
      ${renderSavedOutline(outline)}
      ${renderGenerateCard(outline, plotSettings, { collapsed: true })}
    `;
  return `
    <div class="slx-outline-root" data-slx-outline-root>
      <div class="slx-outline-main">
        ${mainContent}
      </div>
      ${renderOutlineEditorOverlay(panelState.editing)}
    </div>
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

  panelRoot.querySelectorAll('[data-slx-outline-editor-cancel]').forEach(button => {
    button.addEventListener('click', () => {
      panelState.editing = null;
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-outline-editor-overlay]')?.addEventListener('click', event => {
    if (event.target !== event.currentTarget) return;
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
      scheduleInjectionSync();
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
    scheduleInjectionSync();
    refreshPanel();
  });

  panelRoot.querySelectorAll('[data-slx-outline-api-mode]').forEach(button => {
    button.addEventListener('click', event => {
      const settings = getGlobalSettings();
      const plotSettings = getPlotOutlineSettings(settings);
      plotSettings.apiMode = event.currentTarget.dataset.slxOutlineApiMode === 'main_api' ? 'main_api' : 'secondary_api';
      saveGlobalSettings();
      refreshPanel();
    });
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
    scheduleInjectionSync();
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
    scheduleInjectionSync();
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
      scheduleInjectionSync();
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
    scheduleInjectionSync();
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
    scheduleInjectionSync();
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
      scheduleInjectionSync();
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-outline-gen-details]')?.addEventListener('toggle', event => {
    panelState.generateOpen = event.currentTarget.open;
  });

  bindEditorEvents(panelRoot);
}
