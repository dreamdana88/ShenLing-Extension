import { escapeHtml } from '../../utils/text.js';
import {
  getChatMessageById,
  getLastMessageId,
  setChatMessageContent,
} from '../../core/chat.js';
import {
  getGlobalSettings,
  getWordReplaceSettings,
  saveGlobalSettings,
} from '../../core/settings.js';
import {
  applyReplacementRulesByScope,
  buildReplacementRuleGroups,
  createImportedReplacementRules,
  createReplacementRuleId,
  REPLACEMENT_GROUPS,
  replacementRuleMatchesSearch,
  splitReplacementSources,
} from './core.js';
import { markSummaryWriteIgnored } from '../summary/workflow.js';

let wordReplacePanelOptions = {
  refreshPanel: null,
  getPanelRoot: null,
};

let wordReplaceUiState = {
  searchQuery: '',
  importKind: 'fixed',
  importText: '',
  previewInput: '',
  previewOutput: '',
  previewMessage: '',
  editorOpen: false,
  draftId: null,
  draftIds: [],
  draftEnabled: true,
  draftKind: 'fixed',
  draftSource: '',
  draftTarget: '',
  draftMode: 'plain',
};

export function configureWordReplacePanel(options = {}) {
  wordReplacePanelOptions = {
    ...wordReplacePanelOptions,
    ...options,
  };
}

function notifyWordReplace(type, message, title = '词汇替换') {
  const toastr = globalThis.toastr || globalThis.parent?.toastr;
  if (toastr && typeof toastr[type] === 'function') {
    toastr[type](message, title);
    return;
  }
  const logger = type === 'error' ? console.error : console.info;
  logger(`[蜃灵助手] ${title}：${message}`);
}

function refreshWordReplacePanel(panelRoot = wordReplacePanelOptions.getPanelRoot?.()) {
  if (!panelRoot || typeof wordReplacePanelOptions.refreshPanel !== 'function') return;
  wordReplacePanelOptions.refreshPanel({
    moduleScrollTop: panelRoot.querySelector('.slx-module-grid')?.scrollTop ?? 0,
    detailScrollTop: panelRoot.querySelector('.slx-detail')?.scrollTop ?? 0,
  });
}

function getReplacementKindDesc(kind) {
  if (kind === 'delete') return '匹配后直接删除。';
  if (kind === 'wildcard') return '用 * 表示模糊文字。';
  return '稳定的一对一替换。';
}

function getVisibleReplacementGroups(replace) {
  const query = wordReplaceUiState.searchQuery.trim().toLocaleLowerCase();
  const visibleRules = replace.rules.filter(rule => replacementRuleMatchesSearch(rule, query));
  const rulesByKind = {
    delete: visibleRules.filter(rule => rule.kind === 'delete'),
    fixed: visibleRules.filter(rule => rule.kind === 'fixed'),
    wildcard: visibleRules.filter(rule => rule.kind === 'wildcard'),
  };
  return {
    visibleRules,
    groupedByKind: {
      delete: buildReplacementRuleGroups(rulesByKind.delete),
      fixed: buildReplacementRuleGroups(rulesByKind.fixed),
      wildcard: buildReplacementRuleGroups(rulesByKind.wildcard),
    },
  };
}

function renderRuleGroup(group, rules, replace) {
  const expanded = replace.expandedGroups?.[group.kind] !== false;
  const ruleItems = rules.map(rule => `
    <div class="slx-replacement-rule${rule.enabled ? '' : ' slx-replacement-rule-off'}">
      <div class="slx-replacement-rule-main">
        <button class="slx-rule-toggle" type="button" data-slx-toggle-replacement-rule="${escapeHtml(rule.ids.join(','))}" title="${rule.enabled ? '关闭规则' : '启用规则'}">
          <i class="${rule.enabled ? 'fa-solid fa-check' : 'fa-solid fa-minus'}"></i>
        </button>
        <div class="slx-rule-text">
          <div class="slx-rule-title">
            <span>${escapeHtml(rule.source)}</span>
            ${rule.kind === 'delete' ? '' : `<i class="fa-solid fa-arrow-right-long"></i><span>${escapeHtml(rule.target)}</span>`}
          </div>
        </div>
      </div>
      <div class="slx-card-actions">
        <button class="slx-mini-action-btn" type="button" data-slx-edit-replacement-rule="${escapeHtml(rule.ids.join(','))}" title="编辑规则"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="slx-mini-action-btn" type="button" data-slx-delete-replacement-rule="${escapeHtml(rule.ids.join(','))}" title="删除规则"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>
  `).join('');

  return `
    <div class="slx-replacement-group">
      <button class="slx-replacement-group-head" type="button" data-slx-toggle-replacement-group="${escapeHtml(group.kind)}">
        <div class="slx-replacement-group-title">
          <i class="${escapeHtml(group.icon)}"></i>
          <span>${escapeHtml(group.title)}</span>
          <b>${escapeHtml(rules.length)} 条</b>
        </div>
        <i class="fa-solid fa-chevron-down slx-collapse-icon${expanded ? ' slx-collapse-icon-open' : ''}"></i>
      </button>
      ${expanded ? `
        <div class="slx-replacement-group-body">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-new-replacement-rule="${escapeHtml(group.kind)}">
            <i class="fa-solid fa-plus"></i><span>添加${escapeHtml(group.title)}</span>
          </button>
          <div class="slx-field-hint">${escapeHtml(group.desc)}</div>
          ${rules.length ? ruleItems : '<div class="slx-log-empty"><b>没有匹配的规则。</b></div>'}
        </div>
      ` : ''}
    </div>
  `;
}

function renderReplacementEditor() {
  if (!wordReplaceUiState.editorOpen) return '';
  const kind = wordReplaceUiState.draftKind;
  return `
    <div class="slx-rule-modal" data-slx-close-replacement-editor>
      <div class="slx-rule-modal-card" data-slx-replacement-editor-card>
        <div class="slx-summary-card-head">
          <div>
            <div class="slx-detail-title">${wordReplaceUiState.draftId ? '编辑规则' : '新增规则'}</div>
            <p>${escapeHtml(getReplacementKindDesc(kind))}</p>
          </div>
          <button class="slx-mini-action-btn" type="button" data-slx-close-replacement-editor title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <label class="slx-field slx-field-wide">
          <span>${kind === 'delete' ? '要删除的词' : '原词 / 通配词'}</span>
          <input type="text" data-slx-replacement-draft-field="source" value="${escapeHtml(wordReplaceUiState.draftSource)}" placeholder="例如：*妈的" />
        </label>
        ${kind === 'delete' ? '' : `
          <label class="slx-field slx-field-wide">
            <span>替换为</span>
            <input type="text" data-slx-replacement-draft-field="target" value="${escapeHtml(wordReplaceUiState.draftTarget)}" placeholder="例如：*爹的" />
          </label>
        `}
        ${kind === 'wildcard' ? `
          <label class="slx-field slx-field-wide">
            <span>匹配模式</span>
            <select data-slx-replacement-draft-field="mode">
              <option value="wildcard" ${wordReplaceUiState.draftMode === 'wildcard' ? 'selected' : ''}>通配（用 * 表示模糊文字，插件自动处理）</option>
              <option value="independent" ${wordReplaceUiState.draftMode === 'independent' ? 'selected' : ''}>独立词（只替换“独自出现”的词，不替换嵌在别的词/语义里的）</option>
              <option value="family_swear" ${wordReplaceUiState.draftMode === 'family_swear' ? 'selected' : ''}>亲属脏话（“妈 / 娘 / 妹”这类亲属词作为脏话，保护正常语义）</option>
              <option value="regex" ${wordReplaceUiState.draftMode === 'regex' ? 'selected' : ''}>正则（高级匹配，原词框填写正则表达式）</option>
            </select>
          </label>
        ` : ''}
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-replacement-rule>
          <i class="fa-solid fa-floppy-disk"></i><span>保存规则</span>
        </button>
      </div>
    </div>
  `;
}

export function renderWordReplacePanel(settings = getGlobalSettings()) {
  const replace = getWordReplaceSettings(settings);
  const { visibleRules, groupedByKind } = getVisibleReplacementGroups(replace);
  const enabledCount = replace.rules.filter(rule => rule.enabled).length;

  return `
    <div class="slx-detail-card slx-summary-settings-card">
      <label class="slx-setting-toggle-row" for="slx-word-replace-enabled">
        <span>
          <b>词汇替换</b>
          <small>AI 回复后自动替换，也可重跑当前楼层。</small>
          <small>规则数量：${escapeHtml(replace.rules.length)}｜启用规则：${escapeHtml(enabledCount)}</small>
        </span>
        <input id="slx-word-replace-enabled" type="checkbox" data-slx-word-replace-enabled ${replace.enabled ? 'checked' : ''} />
      </label>
      <div class="slx-action-row slx-summary-action-row">
        <button class="slx-soft-btn" type="button" data-slx-rerun-word-replace>
          <i class="fa-solid fa-rotate"></i><span>重新替换当前楼层</span>
        </button>
      </div>
      ${wordReplaceUiState.searchQuery.trim() ? `<div class="slx-field-hint">搜索匹配：${escapeHtml(visibleRules.length)} 条</div>` : ''}
    </div>

    <div class="slx-detail-card slx-replacement-search-card">
      <label class="slx-field slx-field-wide">
        <span>搜索规则</span>
        <div class="slx-secret-field">
          <input type="text" data-slx-replacement-search value="${escapeHtml(wordReplaceUiState.searchQuery)}" placeholder="先查重再添加" />
          <button class="slx-secret-toggle" type="button" data-slx-clear-replacement-search title="清空搜索"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </label>
    </div>

    <div class="slx-replacement-groups">
      ${REPLACEMENT_GROUPS.map(group => renderRuleGroup(group, groupedByKind[group.kind], replace)).join('')}
    </div>

    <div class="slx-detail-card">
      <button class="slx-collapse-head" type="button" data-slx-toggle-replacement-import>
        <div>
          <div class="slx-detail-title">批量导入</div>
          <p>支持逗号分隔，支持 - / -> / → 表示替换。</p>
        </div>
        <i class="fa-solid fa-chevron-down slx-collapse-icon${replace.importCollapsed ? '' : ' slx-collapse-icon-open'}"></i>
      </button>
      ${replace.importCollapsed ? '' : `
        <div class="slx-collapse-body">
          <div class="slx-form-grid">
            <label class="slx-field">
              <span>导入到</span>
              <select data-slx-replacement-import-kind>
                <option value="delete" ${wordReplaceUiState.importKind === 'delete' ? 'selected' : ''}>删除词</option>
                <option value="fixed" ${wordReplaceUiState.importKind === 'fixed' ? 'selected' : ''}>固定替换</option>
                <option value="wildcard" ${wordReplaceUiState.importKind === 'wildcard' ? 'selected' : ''}>通配替换</option>
              </select>
            </label>
            <label class="slx-field">
              <span>格式</span>
              <input type="text" value="原词，原词-替换词" readonly />
            </label>
          </div>
          <label class="slx-field slx-field-wide">
            <span>导入内容</span>
            <textarea class="slx-replacement-textarea" data-slx-replacement-import-text placeholder="白嫖-白剽&#10;我操,我草,卧槽-我劁&#10;极其">${escapeHtml(wordReplaceUiState.importText)}</textarea>
          </label>
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-import-replacement-rules>
            <i class="fa-solid fa-file-import"></i><span>导入规则</span>
          </button>
        </div>
      `}
    </div>

    <div class="slx-detail-card">
      <div class="slx-detail-title">预览测试</div>
      <label class="slx-field slx-field-wide">
        <span>测试文本</span>
        <textarea class="slx-replacement-textarea" data-slx-replacement-preview-input placeholder="输入一段测试文本">${escapeHtml(wordReplaceUiState.previewInput)}</textarea>
      </label>
      <button class="slx-soft-btn" type="button" data-slx-preview-replacement-rules>
        <i class="fa-solid fa-wand-magic-sparkles"></i><span>预览替换</span>
      </button>
      ${wordReplaceUiState.previewMessage ? `<div class="slx-field-hint">${escapeHtml(wordReplaceUiState.previewMessage)}</div>` : ''}
      ${wordReplaceUiState.previewOutput ? `
        <label class="slx-field slx-field-wide">
          <span>替换结果</span>
          <textarea class="slx-replacement-textarea slx-replacement-preview-output" readonly>${escapeHtml(wordReplaceUiState.previewOutput)}</textarea>
        </label>
      ` : ''}
    </div>
    ${renderReplacementEditor()}
  `;
}

function syncDraftFromDom(panelRoot) {
  panelRoot.querySelectorAll('[data-slx-replacement-draft-field]').forEach(input => {
    const field = input.dataset.slxReplacementDraftField;
    if (field === 'source') wordReplaceUiState.draftSource = input.value;
    if (field === 'target') wordReplaceUiState.draftTarget = input.value;
    if (field === 'mode') wordReplaceUiState.draftMode = input.value;
  });
}

function closeReplacementEditor() {
  wordReplaceUiState = {
    ...wordReplaceUiState,
    editorOpen: false,
    draftId: null,
    draftIds: [],
    draftEnabled: true,
    draftKind: 'fixed',
    draftSource: '',
    draftTarget: '',
    draftMode: 'plain',
  };
}

function openReplacementEditorForNew(kind) {
  wordReplaceUiState = {
    ...wordReplaceUiState,
    editorOpen: true,
    draftId: null,
    draftIds: [],
    draftEnabled: true,
    draftKind: kind,
    draftSource: '',
    draftTarget: '',
    draftMode: kind === 'wildcard' ? 'wildcard' : 'plain',
  };
}

function openReplacementEditorForRule(rule) {
  wordReplaceUiState = {
    ...wordReplaceUiState,
    editorOpen: true,
    draftId: rule.id,
    draftIds: rule.ids || [rule.id],
    draftEnabled: rule.enabled,
    draftKind: rule.kind,
    draftSource: rule.source,
    draftTarget: rule.target,
    draftMode: rule.mode,
  };
}

function saveReplacementRule(panelRoot, settings) {
  syncDraftFromDom(panelRoot);
  const replace = getWordReplaceSettings(settings);
  const sources = splitReplacementSources(wordReplaceUiState.draftSource);
  if (!sources.length) return;
  const kind = wordReplaceUiState.draftKind;
  const target = kind === 'delete' ? '' : wordReplaceUiState.draftTarget;
  const mode = kind === 'wildcard' ? wordReplaceUiState.draftMode : 'plain';
  const nextRules = sources.map((source, index) => ({
    id: wordReplaceUiState.draftIds[index] || createReplacementRuleId(),
    enabled: wordReplaceUiState.draftId ? wordReplaceUiState.draftEnabled : true,
    kind,
    source,
    target,
    mode,
    scope: 'all',
  }));
  const editingIds = new Set(wordReplaceUiState.draftIds);
  if (editingIds.size > 0) {
    const rules = [...replace.rules];
    const firstIndex = rules.findIndex(item => editingIds.has(item.id));
    const keptRules = rules.filter(item => !editingIds.has(item.id));
    keptRules.splice(firstIndex >= 0 ? firstIndex : 0, 0, ...nextRules);
    replace.rules = keptRules;
  } else {
    replace.rules = [...nextRules, ...replace.rules];
  }
  closeReplacementEditor();
  saveGlobalSettings();
  notifyWordReplace('success', '词汇替换规则已保存。');
}

export async function rerunReplacementForCurrentMessage(settings = getGlobalSettings()) {
  const messageId = getLastMessageId();
  const chatMessage = getChatMessageById(messageId);
  if (!chatMessage) {
    notifyWordReplace('warning', '未找到当前楼层。');
    return;
  }
  if (chatMessage.role !== 'assistant') {
    notifyWordReplace('warning', '当前最新楼层不是 AI 回复，暂不执行替换。');
    return;
  }
  const result = applyReplacementRulesByScope(chatMessage.message, getWordReplaceSettings(settings), { force: true });
  if (result.errors.length > 0) {
    notifyWordReplace('error', `词汇替换规则错误：${result.errors.join('；')}`, '词汇替换失败');
    return;
  }
  if (!result.changed) {
    notifyWordReplace('info', '当前楼层没有命中的替换词。');
    return;
  }
  markSummaryWriteIgnored(chatMessage.message_id);
  await setChatMessageContent(chatMessage.message_id, result.text);
  notifyWordReplace('success', `已重新替换当前楼层 ${result.replacements} 处。`);
}

export function bindWordReplacePanelEvents(panelRoot, settings = getGlobalSettings()) {
  if (!panelRoot) return;

  panelRoot.querySelector('[data-slx-word-replace-enabled]')?.addEventListener('change', event => {
    getWordReplaceSettings(settings).enabled = Boolean(event.currentTarget.checked);
    saveGlobalSettings();
    refreshWordReplacePanel(panelRoot);
  });

  panelRoot.querySelector('[data-slx-rerun-word-replace]')?.addEventListener('click', () => {
    void rerunReplacementForCurrentMessage(settings).finally(() => refreshWordReplacePanel(panelRoot));
  });

  const syncSearchInput = event => {
    wordReplaceUiState.searchQuery = event.currentTarget.value;
    refreshWordReplacePanel(panelRoot);
  };
  panelRoot.querySelector('[data-slx-replacement-search]')?.addEventListener('change', syncSearchInput);
  panelRoot.querySelector('[data-slx-replacement-search]')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    syncSearchInput(event);
  });
  panelRoot.querySelector('[data-slx-clear-replacement-search]')?.addEventListener('click', () => {
    wordReplaceUiState.searchQuery = '';
    refreshWordReplacePanel(panelRoot);
  });

  panelRoot.querySelectorAll('[data-slx-toggle-replacement-group]').forEach(button => {
    button.addEventListener('click', () => {
      const kind = button.dataset.slxToggleReplacementGroup;
      const replace = getWordReplaceSettings(settings);
      replace.expandedGroups[kind] = replace.expandedGroups[kind] === false;
      saveGlobalSettings();
      refreshWordReplacePanel(panelRoot);
    });
  });

  panelRoot.querySelectorAll('[data-slx-new-replacement-rule]').forEach(button => {
    button.addEventListener('click', () => {
      openReplacementEditorForNew(button.dataset.slxNewReplacementRule || 'fixed');
      refreshWordReplacePanel(panelRoot);
    });
  });

  panelRoot.querySelectorAll('[data-slx-toggle-replacement-rule]').forEach(button => {
    button.addEventListener('click', () => {
      const ids = new Set(String(button.dataset.slxToggleReplacementRule || '').split(',').filter(Boolean));
      const replace = getWordReplaceSettings(settings);
      const shouldEnable = replace.rules.some(rule => ids.has(rule.id) && !rule.enabled);
      replace.rules = replace.rules.map(rule => ids.has(rule.id) ? { ...rule, enabled: shouldEnable } : rule);
      saveGlobalSettings();
      refreshWordReplacePanel(panelRoot);
    });
  });

  panelRoot.querySelectorAll('[data-slx-edit-replacement-rule]').forEach(button => {
    button.addEventListener('click', () => {
      const ids = new Set(String(button.dataset.slxEditReplacementRule || '').split(',').filter(Boolean));
      const replace = getWordReplaceSettings(settings);
      const group = buildReplacementRuleGroups(replace.rules).find(item => item.ids.some(id => ids.has(id)));
      if (group) openReplacementEditorForRule(group);
      refreshWordReplacePanel(panelRoot);
    });
  });

  panelRoot.querySelectorAll('[data-slx-delete-replacement-rule]').forEach(button => {
    button.addEventListener('click', () => {
      const ids = new Set(String(button.dataset.slxDeleteReplacementRule || '').split(',').filter(Boolean));
      const replace = getWordReplaceSettings(settings);
      replace.rules = replace.rules.filter(rule => !ids.has(rule.id));
      saveGlobalSettings();
      refreshWordReplacePanel(panelRoot);
    });
  });

  panelRoot.querySelector('[data-slx-toggle-replacement-import]')?.addEventListener('click', () => {
    const replace = getWordReplaceSettings(settings);
    replace.importCollapsed = !replace.importCollapsed;
    saveGlobalSettings();
    refreshWordReplacePanel(panelRoot);
  });
  panelRoot.querySelector('[data-slx-replacement-import-kind]')?.addEventListener('change', event => {
    wordReplaceUiState.importKind = event.currentTarget.value;
    refreshWordReplacePanel(panelRoot);
  });
  panelRoot.querySelector('[data-slx-replacement-import-text]')?.addEventListener('change', event => {
    wordReplaceUiState.importText = event.currentTarget.value;
  });
  panelRoot.querySelector('[data-slx-import-replacement-rules]')?.addEventListener('click', () => {
    const importText = panelRoot.querySelector('[data-slx-replacement-import-text]')?.value || wordReplaceUiState.importText;
    wordReplaceUiState.importText = importText;
    const replace = getWordReplaceSettings(settings);
    const rules = createImportedReplacementRules(importText, wordReplaceUiState.importKind);
    if (!rules.length) {
      notifyWordReplace('warning', '没有识别到可导入的规则。');
      return;
    }
    replace.rules = [...replace.rules, ...rules];
    replace.expandedGroups[wordReplaceUiState.importKind] = true;
    wordReplaceUiState.importText = '';
    saveGlobalSettings();
    notifyWordReplace('success', `已导入 ${rules.length} 条规则。`);
    refreshWordReplacePanel(panelRoot);
  });

  panelRoot.querySelector('[data-slx-replacement-preview-input]')?.addEventListener('input', event => {
    wordReplaceUiState.previewInput = event.currentTarget.value;
  });
  panelRoot.querySelector('[data-slx-preview-replacement-rules]')?.addEventListener('click', () => {
    if (!wordReplaceUiState.previewInput) {
      wordReplaceUiState.previewOutput = '';
      wordReplaceUiState.previewMessage = '请先输入测试文本。';
    } else {
      const result = applyReplacementRulesByScope(wordReplaceUiState.previewInput, getWordReplaceSettings(settings), { force: true });
      wordReplaceUiState.previewOutput = result.text;
      wordReplaceUiState.previewMessage = result.errors.length
        ? `替换 ${result.replacements} 处；规则错误：${result.errors.join('；')}`
        : `替换 ${result.replacements} 处。`;
    }
    refreshWordReplacePanel(panelRoot);
  });

  panelRoot.querySelector('[data-slx-save-replacement-rule]')?.addEventListener('click', () => {
    saveReplacementRule(panelRoot, settings);
    refreshWordReplacePanel(panelRoot);
  });
  panelRoot.querySelectorAll('[data-slx-close-replacement-editor]').forEach(node => {
    node.addEventListener('click', event => {
      if (node.classList.contains('slx-rule-modal') && event.target.closest?.('[data-slx-replacement-editor-card]')) return;
      closeReplacementEditor();
      refreshWordReplacePanel(panelRoot);
    });
  });
}
