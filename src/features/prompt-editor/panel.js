import { PLUGIN_VERSION } from '../../constants.js';
import {
  buildPromptOverrideExport,
  getPromptOverrideState,
  listPromptDefinitions,
  removePromptOverride,
  runPromptOverrideSelfTests,
  setPromptOverride,
  validatePromptValue,
} from '../../core/prompt-overrides.js';
import { saveGlobalSettings } from '../../core/settings.js';
import { slxIcon } from '../../icons.js';
import { escapeHtml } from '../../utils/text.js';

const definitions = listPromptDefinitions();

const editorState = {
  activePromptId: definitions[0]?.id || '',
  search: '',
  onlyOverrides: false,
  drafts: new Map(),
  browserModuleId: definitions[0]?.moduleId || '',
  compareOpen: false,
  notice: '',
  selfTest: null,
};

function cloneValue(value) {
  return Array.isArray(value)
    ? value.map(message => ({ role: String(message.role || ''), content: String(message.content || '') }))
    : String(value || '');
}

function serializeValue(value) {
  return Array.isArray(value) ? JSON.stringify(value) : String(value || '');
}

function getActiveDefinition() {
  return definitions.find(item => item.id === editorState.activePromptId) || definitions[0] || null;
}

function getDraftState(settings, promptId = editorState.activePromptId) {
  const promptState = getPromptOverrideState(promptId, settings);
  if (!promptState) return null;
  const storedValue = promptState.hasOverride ? promptState.overrideValue : promptState.activeValue;
  const draft = editorState.drafts.has(promptId)
    ? editorState.drafts.get(promptId)
    : cloneValue(storedValue);
  const dirty = serializeValue(draft) !== serializeValue(storedValue);
  return {
    ...promptState,
    draft,
    dirty,
    draftValidation: validatePromptValue(promptId, draft),
  };
}

function getStatus(state) {
  if (!state.draftValidation.valid) return { id: 'invalid', label: '校验未通过' };
  if (state.dirty) return { id: 'dirty', label: '未保存' };
  if (state.baseChanged) return { id: 'updated', label: '默认值已更新' };
  if (state.hasOverride) return { id: 'override', label: '本地覆盖' };
  return { id: 'default', label: '默认' };
}

function getModuleGroups() {
  const groups = [];
  definitions.forEach(definition => {
    let group = groups.find(item => item.id === definition.moduleId);
    if (!group) {
      group = { id: definition.moduleId, label: definition.moduleLabel, items: [] };
      groups.push(group);
    }
    group.items.push(definition);
  });
  return groups;
}

function getVisiblePromptGroups(settings) {
  const query = editorState.search.trim().toLocaleLowerCase();
  return getModuleGroups().map(group => ({
    ...group,
    items: group.items.filter(definition => {
      const state = getPromptOverrideState(definition.id, settings);
      if (editorState.onlyOverrides && !state?.hasOverride) return false;
      if (!query) return true;
      return `${definition.label} ${definition.description} ${definition.id}`.toLocaleLowerCase().includes(query);
    }),
  })).filter(group => group.items.length);
}

function renderPromptCascade(settings) {
  const groups = getVisiblePromptGroups(settings);
  if (!groups.length) return '<div class="slx-prompt-empty">没有符合条件的提示词</div>';
  const selectedGroup = groups.find(group => group.id === editorState.browserModuleId) || groups[0];
  const activePromptInGroup = selectedGroup.items.some(item => item.id === editorState.activePromptId);
  return `
    <div class="slx-prompt-cascade" aria-label="选择提示词">
      <label class="slx-prompt-cascade-field">
        <span>模块</span>
        <select data-slx-prompt-module aria-label="选择模块">
          ${groups.map(group => {
            const overrideCount = group.items.filter(item => getPromptOverrideState(item.id, settings)?.hasOverride).length;
            const totalCount = getModuleGroups().find(item => item.id === group.id)?.items.length || group.items.length;
            return `<option value="${escapeHtml(group.id)}" ${group.id === selectedGroup.id ? 'selected' : ''}>${escapeHtml(group.label)} · ${overrideCount}/${totalCount}</option>`;
          }).join('')}
        </select>
      </label>
      <label class="slx-prompt-cascade-field">
        <span>提示词</span>
        <select data-slx-prompt-select aria-label="选择${escapeHtml(selectedGroup.label)}提示词">
          ${activePromptInGroup ? '' : '<option value="" selected disabled>选择提示词</option>'}
          ${selectedGroup.items.map(definition => {
            const status = getStatus(getDraftState(settings, definition.id));
            const statusText = status.id === 'default' ? '' : ` · ${status.label}`;
            return `<option value="${escapeHtml(definition.id)}" ${definition.id === editorState.activePromptId ? 'selected' : ''}>${escapeHtml(definition.label + statusText)}</option>`;
          }).join('')}
        </select>
      </label>
    </div>
  `;
}

function renderVariables(definition) {
  if (!definition.variables?.length) {
    return '<div class="slx-prompt-variable-empty">此提示词没有运行时变量。</div>';
  }
  return definition.variables.map(variable => `
    <button class="slx-prompt-variable" type="button" data-slx-prompt-variable="${escapeHtml(variable.token)}" title="插入变量">
      <code>${escapeHtml(variable.token)}</code>
      <span>${escapeHtml(variable.label)}</span>
    </button>
  `).join('');
}

function renderValidation(validation) {
  if (validation.valid) {
    return `<div class="slx-prompt-validation is-valid">${slxIcon('check')} 协议校验通过</div>`;
  }
  return `
    <div class="slx-prompt-validation is-invalid">
      ${slxIcon('alert')}
      <div>${validation.errors.map(error => `<div>${escapeHtml(error.message)}</div>`).join('')}</div>
    </div>
  `;
}

function renderEditorFields(state) {
  if (state.definition.kind === 'message_list') {
    return `
      <div class="slx-prompt-message-list">
        ${state.draft.map((message, index) => `
          <label class="slx-prompt-message">
            <span class="slx-prompt-role">${escapeHtml(message.role)}</span>
            <textarea data-slx-prompt-message-index="${index}" spellcheck="false">${escapeHtml(message.content)}</textarea>
          </label>
        `).join('')}
      </div>
    `;
  }
  return `<textarea class="slx-prompt-editor-textarea" data-slx-prompt-text spellcheck="false">${escapeHtml(state.draft)}</textarea>`;
}

function renderPromptEditor(settings) {
  const definition = getActiveDefinition();
  if (!definition) return '<div class="slx-prompt-empty">暂无已登记提示词</div>';
  const state = getDraftState(settings, definition.id);
  const status = getStatus(state);
  return `
    <article class="slx-prompt-editor" data-slx-prompt-editor-id="${escapeHtml(definition.id)}">
      <header class="slx-prompt-editor-head">
        <div>
          <div class="slx-prompt-editor-title-row">
            <h3>${escapeHtml(definition.label)}</h3>
            <span class="slx-prompt-status is-${status.id}" data-slx-prompt-status>${escapeHtml(status.label)}</span>
          </div>
          <p>${escapeHtml(definition.description)}</p>
          <code class="slx-prompt-id">${escapeHtml(definition.id)}</code>
          ${state.entry?.updatedAt ? `<span class="slx-prompt-updated-at">保存于 ${escapeHtml(String(state.entry.updatedAt).replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'))}</span>` : ''}
        </div>
      </header>

      <details class="slx-prompt-variables">
        <summary>可用变量 <span>${definition.variables?.length || 0}</span></summary>
        <div class="slx-prompt-variable-list">${renderVariables(definition)}</div>
      </details>

      <div class="slx-prompt-edit-field">${renderEditorFields(state)}</div>
      <div data-slx-prompt-validation>${renderValidation(state.draftValidation)}</div>

      ${state.baseChanged ? '<div class="slx-prompt-base-note">插件默认值已更新；当前仍继续使用你的本地修改，可在“对照”中查看。</div>' : ''}
      <footer class="slx-prompt-editor-actions">
        <button class="slx-soft-btn" type="button" data-slx-prompt-compare>对照默认</button>
        <button class="slx-soft-btn" type="button" data-slx-prompt-restore ${state.hasOverride || state.dirty ? '' : 'disabled'}>恢复默认</button>
        <button class="slx-primary-btn" type="button" data-slx-prompt-save ${state.dirty && state.draftValidation.valid ? '' : 'disabled'}>保存并应用</button>
      </footer>
    </article>
  `;
}

function formatCompareValue(value) {
  if (!Array.isArray(value)) return escapeHtml(value);
  return value.map((message, index) => `【消息 ${index + 1}｜${message.role}】\n${message.content}`).map(escapeHtml).join('\n\n');
}

function renderOverlay(settings) {
  if (editorState.compareOpen) {
    const state = getDraftState(settings);
    return `
      <div class="slx-prompt-overlay" role="dialog" aria-modal="true" aria-label="提示词对照">
        <header><div><b>${escapeHtml(state.definition.label)} · 对照</b><small>默认值与当前编辑稿</small></div><button class="slx-icon-btn" type="button" data-slx-prompt-close-overlay aria-label="关闭">${slxIcon('close')}</button></header>
        <div class="slx-prompt-compare-grid">
          <section><h4>插件默认</h4><pre>${formatCompareValue(state.defaultValue)}</pre></section>
          <section><h4>当前编辑稿</h4><pre>${formatCompareValue(state.draft)}</pre></section>
        </div>
      </div>
    `;
  }
  return '';
}

export function renderPromptEditorPanel(settings) {
  const modifiedCount = definitions.filter(item => getPromptOverrideState(item.id, settings)?.hasOverride).length;
  return `
    <div class="slx-prompt-editor-root">
      <div class="slx-prompt-toolbar">
        <div class="slx-prompt-search-wrap">${slxIcon('summary')}<input type="search" data-slx-prompt-search value="${escapeHtml(editorState.search)}" placeholder="搜索提示词" /></div>
        <label class="slx-prompt-filter"><input type="checkbox" data-slx-prompt-only-overrides ${editorState.onlyOverrides ? 'checked' : ''} /> 只看已修改</label>
        <span class="slx-prompt-count">已修改 ${modifiedCount}</span>
        <button class="slx-soft-btn" type="button" data-slx-prompt-export>导出修改稿</button>
      </div>
      ${editorState.notice ? `<div class="slx-prompt-notice">${escapeHtml(editorState.notice)}</div>` : ''}
      <div class="slx-prompt-workspace">
        <div class="slx-prompt-cascade-wrap" data-slx-prompt-cascade>${renderPromptCascade(settings)}</div>
        ${renderPromptEditor(settings)}
      </div>
      <details class="slx-prompt-self-test">
        <summary>开发验证</summary>
        <div>
          <button class="slx-soft-btn" type="button" data-slx-prompt-self-test>运行自测</button>
          ${editorState.selfTest ? `<pre>${escapeHtml(JSON.stringify(editorState.selfTest, null, 2))}</pre>` : '<p>验证登记表、协议、覆盖隔离、恢复默认与导出隐私。</p>'}
        </div>
      </details>
      ${renderOverlay(settings)}
    </div>
  `;
}

export function isPromptEditorOverlayOpen() {
  return editorState.compareOpen;
}

export function closePromptEditorOverlays() {
  editorState.compareOpen = false;
}

function setNotice(message) {
  editorState.notice = String(message || '');
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function bindPromptEditorPanelEvents(panelRoot, settings, { refresh } = {}) {
  const root = panelRoot.querySelector('.slx-prompt-editor-root');
  if (!root) return;
  const rerender = () => typeof refresh === 'function' && refresh();
  const bindCascadeControls = scope => {
    scope.querySelector('[data-slx-prompt-module]')?.addEventListener('change', event => {
      editorState.browserModuleId = event.currentTarget.value;
      const selectedGroup = getVisiblePromptGroups(settings).find(group => group.id === editorState.browserModuleId);
      const nextPrompt = selectedGroup?.items.find(item => item.id === editorState.activePromptId) || selectedGroup?.items[0];
      if (nextPrompt) editorState.activePromptId = nextPrompt.id;
      editorState.compareOpen = false;
      setNotice('');
      rerender();
    });
    scope.querySelector('[data-slx-prompt-select]')?.addEventListener('change', event => {
      const promptId = event.currentTarget.value;
      if (promptId) {
        editorState.activePromptId = promptId;
        editorState.browserModuleId = getPromptOverrideState(editorState.activePromptId, settings)?.definition.moduleId || editorState.browserModuleId;
        editorState.compareOpen = false;
        setNotice('');
        rerender();
      }
    });
  };

  root.querySelectorAll('[data-slx-prompt-search]').forEach(input => {
    input.addEventListener('input', event => {
      editorState.search = event.currentTarget.value;
      const cascade = root.querySelector('[data-slx-prompt-cascade]');
      if (cascade) {
        cascade.innerHTML = renderPromptCascade(settings);
        bindCascadeControls(cascade);
      }
    });
  });

  root.querySelectorAll('[data-slx-prompt-only-overrides]').forEach(input => {
    input.addEventListener('change', event => {
      editorState.onlyOverrides = Boolean(event.currentTarget.checked);
      rerender();
    });
  });

  bindCascadeControls(root);

  const activeState = getDraftState(settings);
  root.querySelector('[data-slx-prompt-text]')?.addEventListener('input', event => {
    editorState.drafts.set(activeState.definition.id, event.currentTarget.value);
    syncPromptLiveState(root, settings);
  });
  root.querySelectorAll('[data-slx-prompt-message-index]').forEach(textarea => {
    textarea.addEventListener('input', () => {
      const draft = cloneValue(getDraftState(settings).draft);
      draft[Number(textarea.dataset.slxPromptMessageIndex)].content = textarea.value;
      editorState.drafts.set(activeState.definition.id, draft);
      syncPromptLiveState(root, settings);
    });
  });

  root.querySelectorAll('[data-slx-prompt-variable]').forEach(button => {
    button.addEventListener('click', () => {
      const textarea = root.querySelector('.slx-prompt-edit-field textarea:focus') || root.querySelector('.slx-prompt-edit-field textarea');
      if (!textarea) return;
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.setRangeText(button.dataset.slxPromptVariable, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
    });
  });

  root.querySelector('[data-slx-prompt-save]')?.addEventListener('click', () => {
    const state = getDraftState(settings);
    const result = setPromptOverride(settings, state.definition.id, state.draft);
    if (!result.valid) {
      setNotice(result.errors.map(error => error.message).join('；'));
      syncPromptLiveState(root, settings);
      return;
    }
    saveGlobalSettings();
    editorState.drafts.delete(state.definition.id);
    setNotice(result.removed ? '内容与默认值一致，已恢复默认。' : '已保存并应用。');
    rerender();
  });

  root.querySelector('[data-slx-prompt-restore]')?.addEventListener('click', () => {
    const state = getDraftState(settings);
    removePromptOverride(settings, state.definition.id);
    editorState.drafts.delete(state.definition.id);
    saveGlobalSettings();
    setNotice('已恢复插件默认值。');
    rerender();
  });

  root.querySelector('[data-slx-prompt-compare]')?.addEventListener('click', () => {
    editorState.compareOpen = true;
    rerender();
  });
  root.querySelector('[data-slx-prompt-close-overlay]')?.addEventListener('click', () => {
    closePromptEditorOverlays();
    rerender();
  });

  root.querySelector('[data-slx-prompt-export]')?.addEventListener('click', () => {
    const result = buildPromptOverrideExport(settings);
    if (!result.ok) {
      setNotice(`以下提示词未通过校验，暂不能导出：${result.errors.map(item => item.promptId).join('、')}`);
      rerender();
      return;
    }
    if (!result.count) {
      setNotice('当前没有已保存的提示词修改。');
      rerender();
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadText(`蜃灵助手-提示词修改稿-${date}.txt`, result.text);
    setNotice(`已导出 ${result.count} 条修改。`);
    rerender();
  });

  root.querySelector('[data-slx-prompt-self-test]')?.addEventListener('click', () => {
    editorState.selfTest = runPromptOverrideSelfTests();
    rerender();
  });
}

function syncPromptLiveState(root, settings) {
  const state = getDraftState(settings);
  const status = getStatus(state);
  const statusNode = root.querySelector('[data-slx-prompt-status]');
  if (statusNode) {
    statusNode.className = `slx-prompt-status is-${status.id}`;
    statusNode.textContent = status.label;
  }
  const validationNode = root.querySelector('[data-slx-prompt-validation]');
  if (validationNode) validationNode.innerHTML = renderValidation(state.draftValidation);
  const saveButton = root.querySelector('[data-slx-prompt-save]');
  if (saveButton) saveButton.disabled = !(state.dirty && state.draftValidation.valid);
  const restoreButton = root.querySelector('[data-slx-prompt-restore]');
  if (restoreButton) restoreButton.disabled = !(state.hasOverride || state.dirty);
}
