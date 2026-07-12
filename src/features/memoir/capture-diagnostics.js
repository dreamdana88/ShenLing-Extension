// 设定采集开发期阶段验证区。只读检查状态与材料，不调用模型、不写世界书、不修改聊天记录。

import { getContextInfo, getMemoirState } from '../../core/settings.js';
import { escapeHtml } from '../../utils/text.js';
import {
  CAPTURE_SOURCE_MODES,
  CAPTURE_TYPES,
  normalizeCaptureState,
} from './capture-model.js';
import {
  buildCaptureOptionalContextMaterial,
  buildCaptureSourceMaterial,
  filterCaptureWorldbookEntries,
  inspectCaptureOptionalSources,
  listCaptureWorldbooks,
  loadCaptureWorldbookEntries,
  setCaptureWorldbookRefsForBook,
  toggleCaptureWorldbookRef,
} from './capture-materials.js';

const SOURCE_LABELS = {
  recent_chat: '最近聊天',
  floor_range: '指定楼层',
  grand_plus_after: '大总结＋后续',
};

function createStageDState() {
  return {
    initialized: false,
    loading: false,
    loadingMessage: '',
    sources: null,
    worldbookNames: [],
    primaryWorldbook: '',
    books: {},
    expandedWorldbooks: new Set(),
    search: '',
    includeCharacterCard: false,
    includePersona: false,
    confirmedRefs: [],
    workingRefs: [],
    result: null,
    error: '',
  };
}

let testState = {
  activeChatKey: '',
  open: false,
  mode: 'recent_chat',
  recentCount: 20,
  fromFloor: '',
  toFloor: '',
  stageBResult: null,
  stageCResult: null,
  stageD: createStageDState(),
};

let stageDSearchTimer = null;

function getTestChatKey() {
  const info = getContextInfo();
  return `${info.characterId || ''}::${info.chatId || info.chatName || ''}`;
}

function syncTestChatState() {
  const activeChatKey = getTestChatKey();
  if (testState.activeChatKey === activeChatKey) return;
  testState = {
    activeChatKey,
    open: false,
    mode: 'recent_chat',
    recentCount: 20,
    fromFloor: '',
    toFloor: '',
    stageBResult: null,
    stageCResult: null,
    stageD: createStageDState(),
  };
}

function jsonForDisplay(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function inspectCaptureState() {
  const capture = getMemoirState().capture;
  const first = normalizeCaptureState(capture);
  const second = normalizeCaptureState(first);
  const draftIds = first.drafts.map(draft => draft.captureId);
  const uniqueDraftIds = new Set(draftIds);
  const refKeys = first.optionalContext.worldbookRefs
    .map(ref => `${ref.worldbookName}\u0000${ref.uid}`);
  const checks = [
    { label: 'capture 状态为对象', ok: !!capture && typeof capture === 'object' && !Array.isArray(capture) },
    { label: '请求类型合法', ok: CAPTURE_TYPES.includes(first.requestedType) },
    { label: '来源模式合法', ok: CAPTURE_SOURCE_MODES.includes(first.source.mode) },
    { label: 'recentCount 位于 5—200', ok: first.source.recentCount >= 5 && first.source.recentCount <= 200 },
    { label: '草稿 captureId 全部唯一', ok: draftIds.length === uniqueDraftIds.size },
    {
      label: '重复标准化不更换 captureId',
      ok: draftIds.every((id, index) => id === second.drafts[index]?.captureId),
    },
    { label: '世界书引用已去重', ok: refKeys.length === new Set(refKeys).size },
  ];
  return {
    ok: checks.every(check => check.ok),
    checks,
    snapshot: first,
  };
}

function renderCheckRows(checks = []) {
  return checks.map(check => `
    <li class="${check.ok ? 'is-pass' : 'is-fail'}">
      <span aria-hidden="true">${check.ok ? '✓' : '×'}</span>
      ${escapeHtml(check.label)}
    </li>
  `).join('');
}

function renderStageBResult() {
  const result = testState.stageBResult;
  if (!result) return '';
  return `
    <div class="slx-capture-test-result ${result.ok ? 'is-pass' : 'is-fail'}">
      <div class="slx-capture-test-result-title">${result.ok ? '阶段 B 状态检查通过' : '阶段 B 状态存在异常'}</div>
      <ul class="slx-capture-test-checks">${renderCheckRows(result.checks)}</ul>
      <details class="slx-capture-test-output-details">
        <summary>查看当前 capture 状态</summary>
        <pre>${escapeHtml(jsonForDisplay(result.snapshot))}</pre>
      </details>
    </div>
  `;
}

function renderSourceControls() {
  const mode = testState.mode;
  let detail = '';
  if (mode === 'recent_chat') {
    detail = `
      <label class="slx-capture-test-inline-field">
        <span>最近</span>
        <input type="number" min="5" max="200" value="${escapeHtml(testState.recentCount)}" data-slx-capture-test-recent />
        <span>楼</span>
      </label>
    `;
  } else if (mode === 'floor_range') {
    detail = `
      <label class="slx-capture-test-inline-field">
        <span>楼层</span>
        <input type="number" min="0" placeholder="从" value="${escapeHtml(testState.fromFloor)}" data-slx-capture-test-from />
        <span>—</span>
        <input type="number" min="0" placeholder="到" value="${escapeHtml(testState.toFloor)}" data-slx-capture-test-to />
      </label>
    `;
  } else {
    detail = '<p class="slx-capture-test-hint">读取最近有效大总结，并追加总结后的纯聊天楼层。</p>';
  }
  return `
    <div class="slx-capture-test-source-tabs" role="radiogroup" aria-label="阶段 C 测试来源">
      ${CAPTURE_SOURCE_MODES.map(sourceMode => `
        <button
          class="${mode === sourceMode ? 'is-active' : ''}"
          type="button"
          role="radio"
          aria-checked="${mode === sourceMode}"
          data-slx-capture-test-mode="${sourceMode}"
        >${escapeHtml(SOURCE_LABELS[sourceMode])}</button>
      `).join('')}
    </div>
    <div class="slx-capture-test-source-detail">${detail}</div>
  `;
}

function renderStageCResult() {
  const result = testState.stageCResult;
  if (!result) return '';
  if (!result.ok) {
    const messages = result.errors?.map(error => error.message).filter(Boolean) || ['材料读取失败。'];
    return `
      <div class="slx-capture-test-result is-fail">
        <div class="slx-capture-test-result-title">阶段 C 预检未通过</div>
        <ul class="slx-capture-test-errors">${messages.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>
        <details class="slx-capture-test-output-details">
          <summary>查看结构化错误</summary>
          <pre>${escapeHtml(jsonForDisplay(result.errors || []))}</pre>
        </details>
      </div>
    `;
  }

  const stats = result.stats || {};
  const hiddenCount = Array.isArray(result.messages)
    ? result.messages.filter(message => message.isHidden).length
    : 0;
  const summaryLines = [
    stats.fromFloor !== null && stats.toFloor !== null ? `楼层 ${stats.fromFloor}—${stats.toFloor}` : '',
    `${stats.messageCount || 0} 条纯聊天`,
    `${stats.characterCount || 0} 字符`,
    hiddenCount ? `含 ${hiddenCount} 条隐藏楼层` : '',
  ].filter(Boolean);
  return `
    <div class="slx-capture-test-result is-pass">
      <div class="slx-capture-test-result-title">阶段 C 材料读取成功</div>
      <div class="slx-capture-test-stats">${summaryLines.map(line => `<span>${escapeHtml(line)}</span>`).join('')}</div>
      ${result.summary ? `
        <p class="slx-capture-test-hint">大总结楼层：${escapeHtml(result.summary.messageId)}${result.summary.coverageFrom !== null ? ` · 覆盖 ${escapeHtml(result.summary.coverageFrom)}—${escapeHtml(result.summary.coverageTo)} 楼` : ''}</p>
      ` : ''}
      <details class="slx-capture-test-output-details" open>
        <summary>查看最终注入材料</summary>
        <pre>${escapeHtml(result.material || '')}</pre>
      </details>
    </div>
  `;
}

function cloneWorldbookRefs(refs = []) {
  return (Array.isArray(refs) ? refs : []).map(ref => ({
    worldbookName: ref.worldbookName,
    uid: ref.uid,
    entryNameSnapshot: ref.entryNameSnapshot || '',
  }));
}

function worldbookRefKey(worldbookName, uid) {
  return `${worldbookName}\u0000${uid}`;
}

function isWorkingRefSelected(worldbookName, uid) {
  const key = worldbookRefKey(worldbookName, uid);
  return testState.stageD.workingRefs.some(ref => worldbookRefKey(ref.worldbookName, ref.uid) === key);
}

function renderStageDResult() {
  const result = testState.stageD.result;
  if (!result) return '';
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return `
    <div class="slx-capture-test-result ${result.ok ? 'is-pass' : 'is-fail'}">
      <div class="slx-capture-test-result-title">${result.ok ? '阶段 D 附加材料解析通过' : '阶段 D 附加材料存在问题'}</div>
      <div class="slx-capture-test-stats">
        <span>确认引用 ${escapeHtml(result.selectedRefCount || 0)} 条</span>
        <span>解析成功 ${escapeHtml(result.resolvedEntries?.length || 0)} 条</span>
        <span>${escapeHtml(result.characterCount || 0)} 字符</span>
      </div>
      ${errors.length ? `
        <ul class="slx-capture-test-errors">${errors.map(error => `<li>${escapeHtml(error.message || error.code)}</li>`).join('')}</ul>
        <details class="slx-capture-test-output-details">
          <summary>查看结构化错误</summary>
          <pre>${escapeHtml(jsonForDisplay(errors))}</pre>
        </details>
      ` : ''}
      <details class="slx-capture-test-output-details" ${result.material ? 'open' : ''}>
        <summary>查看最终附加材料</summary>
        <pre>${escapeHtml(result.material || '（没有启用任何附加材料）')}</pre>
      </details>
    </div>
  `;
}

function renderStageDSourceToggles(stageD) {
  const character = stageD.sources?.characterCard;
  const persona = stageD.sources?.persona;
  return `
    <div class="slx-capture-test-context-toggles">
      <label class="${character?.available ? '' : 'is-disabled'}">
        <input type="checkbox" data-slx-capture-test-d-character ${stageD.includeCharacterCard ? 'checked' : ''} ${character?.available ? '' : 'disabled'} />
        <span>当前角色卡</span>
        <small>${escapeHtml(character?.available ? (character.name || '可读取') : (character?.reason || '不可用'))}</small>
      </label>
      <label class="${persona?.available ? '' : 'is-disabled'}">
        <input type="checkbox" data-slx-capture-test-d-persona ${stageD.includePersona ? 'checked' : ''} ${persona?.available ? '' : 'disabled'} />
        <span>当前 Persona</span>
        <small>${escapeHtml(persona?.available ? '可读取' : (persona?.reason || '不可用'))}</small>
      </label>
    </div>
  `;
}

function renderStageDEntry(worldbookName, entry) {
  const selected = isWorkingRefSelected(worldbookName, entry.uid);
  const strategyLabel = entry.strategyType === 'constant'
    ? '常驻'
    : (entry.strategyType === 'vectorized' ? '向量' : '选择性');
  const keywords = [...entry.mainKeywords, ...entry.filterKeywords].join('、');
  return `
    <label class="slx-capture-test-wb-entry ${selected ? 'is-selected' : ''}">
      <input
        type="checkbox"
        data-slx-capture-test-d-entry
        data-worldbook-name="${escapeHtml(worldbookName)}"
        data-entry-uid="${escapeHtml(entry.uid)}"
        ${selected ? 'checked' : ''}
      />
      <span class="slx-capture-test-wb-entry-main">
        <b>${escapeHtml(entry.name)}</b>
        <span class="slx-capture-test-wb-badges">
          <em>${escapeHtml(strategyLabel)}</em>
          ${entry.enabled ? '' : '<em class="is-disabled">已停用</em>'}
        </span>
        ${keywords ? `<small>${escapeHtml(keywords)}</small>` : ''}
        <small>${escapeHtml(entry.preview || '（正文为空）')}</small>
      </span>
    </label>
  `;
}

function renderStageDWorldbookGroup(worldbookName, stageD) {
  const book = stageD.books[worldbookName];
  const expanded = stageD.expandedWorldbooks.has(worldbookName) || Boolean(stageD.search);
  const entries = book?.status === 'loaded' ? book.entries : [];
  const visibleEntries = filterCaptureWorldbookEntries(entries, stageD.search);
  if (stageD.search && book?.status === 'loaded' && visibleEntries.length === 0) return '';
  const selectedCount = stageD.workingRefs.filter(ref => ref.worldbookName === worldbookName).length;
  let body = '';
  if (expanded) {
    if (!book || book.status === 'idle') body = '<p class="slx-capture-test-hint">展开后读取本书全部条目。</p>';
    else if (book.status === 'loading') body = '<p class="slx-capture-test-hint">条目加载中…</p>';
    else if (book.status === 'failed') body = `<p class="slx-capture-test-error-text">${escapeHtml(book.error || '加载失败')}</p>`;
    else if (!visibleEntries.length) body = '<p class="slx-capture-test-hint">本书没有符合条件的条目。</p>';
    else body = visibleEntries.map(entry => renderStageDEntry(worldbookName, entry)).join('');
  }
  return `
    <div class="slx-capture-test-wb-group">
      <div class="slx-capture-test-wb-head">
        <button type="button" data-slx-capture-test-d-expand="${escapeHtml(worldbookName)}">
          <span aria-hidden="true">${expanded ? '▾' : '▸'}</span>
          <b>${escapeHtml(worldbookName)}</b>
          <small>${book?.status === 'loaded' ? `${selectedCount}/${entries.length}` : `已选 ${selectedCount}`}</small>
        </button>
        ${book?.status === 'loaded' ? `
          <span>
            <button type="button" data-slx-capture-test-d-book-all="${escapeHtml(worldbookName)}">全选</button>
            <button type="button" data-slx-capture-test-d-book-clear="${escapeHtml(worldbookName)}">清空</button>
          </span>
        ` : ''}
      </div>
      ${expanded ? `<div class="slx-capture-test-wb-entries">${body}</div>` : ''}
    </div>
  `;
}

function renderStageDPanel() {
  const stageD = testState.stageD;
  if (!stageD.initialized) {
    return `
      <button class="slx-primary-btn" type="button" data-slx-capture-test-d-init>读取可选材料状态</button>
      <p class="slx-capture-test-hint">读取角色卡、Persona 和当前角色卡绑定的世界书，并展开其全部条目。</p>
    `;
  }
  const groups = stageD.worldbookNames.map(name => renderStageDWorldbookGroup(name, stageD)).join('');
  const boundHint = stageD.worldbookNames.length
    ? `仅显示当前角色卡绑定的世界书${stageD.primaryWorldbook ? `（主要：${escapeHtml(stageD.primaryWorldbook)}）` : ''}。`
    : '';
  return `
    ${renderStageDSourceToggles(stageD)}
    <div class="slx-capture-test-wb-toolbar">
      <input type="search" value="${escapeHtml(stageD.search)}" placeholder="搜索标题或关键词…" data-slx-capture-test-d-search />
      <span>临时选择 ${escapeHtml(stageD.workingRefs.length)} · 已确认 ${escapeHtml(stageD.confirmedRefs.length)}</span>
    </div>
    ${stageD.loadingMessage ? `<p class="slx-capture-test-hint">${escapeHtml(stageD.loadingMessage)}</p>` : ''}
    ${stageD.error ? `<p class="slx-capture-test-error-text">${escapeHtml(stageD.error)}</p>` : ''}
    ${boundHint ? `<p class="slx-capture-test-hint">${boundHint}</p>` : ''}
    <p class="slx-capture-test-hint">手动勾选的条目将直接注入，不受启用状态、常驻/选择性和关键词触发条件影响。</p>
    <div class="slx-capture-test-wb-list">
      ${groups || '<p class="slx-capture-test-hint">当前角色卡没有绑定任何世界书，无条目可选。</p>'}
    </div>
    <div class="slx-capture-test-d-actions">
      <button class="slx-soft-btn" type="button" data-slx-capture-test-d-cancel>取消临时修改</button>
      <button class="slx-soft-btn" type="button" data-slx-capture-test-d-confirm>确认临时选择 (${escapeHtml(stageD.workingRefs.length)})</button>
      <button class="slx-primary-btn" type="button" data-slx-capture-test-d-preview ${stageD.loading ? 'disabled' : ''}>重新读取并预览附加材料</button>
    </div>
    <p class="slx-capture-test-hint">“确认临时选择”只更新本验证区，不写入聊天 metadata；取消会恢复到上次确认结果。</p>
    ${renderStageDResult()}
  `;
}

async function initializeStageD(panelRoot) {
  const stageD = testState.stageD;
  stageD.initialized = true;
  stageD.loading = true;
  stageD.loadingMessage = '正在读取角色卡、Persona 与当前角色卡绑定的世界书…';
  stageD.sources = inspectCaptureOptionalSources();
  const persistedRefs = getMemoirState().capture.optionalContext.worldbookRefs;
  stageD.confirmedRefs = cloneWorldbookRefs(persistedRefs);
  stageD.workingRefs = cloneWorldbookRefs(persistedRefs);
  replaceTestPanel(panelRoot);

  const result = await listCaptureWorldbooks();
  stageD.loading = false;
  stageD.loadingMessage = '';
  if (!result.ok) {
    stageD.error = result.error?.message || '读取角色卡绑定的世界书失败。';
    replaceTestPanel(panelRoot);
    return;
  }
  stageD.worldbookNames = result.names;
  stageD.primaryWorldbook = result.primary || '';
  stageD.books = Object.fromEntries(result.names.map(name => [name, { status: 'idle', entries: [], error: '' }]));
  // 角色卡绑定的书通常只有一两本，直接全部展开并加载条目，省去逐个点开。
  stageD.worldbookNames.forEach(name => stageD.expandedWorldbooks.add(name));
  replaceTestPanel(panelRoot);
  for (const name of stageD.worldbookNames) {
    await ensureStageDBookLoaded(panelRoot, name, { quiet: true });
  }
  replaceTestPanel(panelRoot);
}

async function ensureStageDBookLoaded(panelRoot, worldbookName, { quiet = false } = {}) {
  const stageD = testState.stageD;
  const current = stageD.books[worldbookName];
  if (!current || current.status === 'loaded' || current.status === 'loading') return current;
  stageD.books[worldbookName] = { status: 'loading', entries: [], error: '' };
  if (!quiet) replaceTestPanel(panelRoot);
  const result = await loadCaptureWorldbookEntries(worldbookName);
  stageD.books[worldbookName] = result.ok
    ? { status: 'loaded', entries: result.entries, error: '' }
    : { status: 'failed', entries: [], error: result.error?.message || '加载失败' };
  if (!quiet) replaceTestPanel(panelRoot);
  return stageD.books[worldbookName];
}

async function loadAllStageDBooksForSearch(panelRoot) {
  const stageD = testState.stageD;
  const pending = stageD.worldbookNames.filter(name => stageD.books[name]?.status !== 'loaded');
  stageD.loading = true;
  for (const [index, name] of pending.entries()) {
    stageD.loadingMessage = `搜索正在加载世界书 ${index + 1}/${pending.length}：${name}`;
    replaceTestPanel(panelRoot);
    await ensureStageDBookLoaded(panelRoot, name, { quiet: true });
  }
  stageD.loading = false;
  stageD.loadingMessage = '';
  replaceTestPanel(panelRoot);
}

function renderFutureStages() {
  const stages = [
    ['E', '最终提示词与模型 JSON 解析验证'],
    ['F', '完整表单、草稿卡片与移动端交互验证'],
    ['G', '写入 payload 干跑与 captureId 读回验证'],
  ];
  return `
    <div class="slx-capture-test-future">
      ${stages.map(([stage, label]) => `
        <div><span>阶段 ${stage}</span><p>${escapeHtml(label)}</p><em>待该阶段完成后接入</em></div>
      `).join('')}
    </div>
  `;
}

export function renderCaptureStageTestPanel() {
  syncTestChatState();
  return `
    <details class="slx-capture-test-panel" data-slx-capture-test-root ${testState.open ? 'open' : ''}>
      <summary>
        <span><b>开发期 · 阶段验证</b><small>只读预览，不调用模型、不写世界书</small></span>
        <i>临时工具</i>
      </summary>
      <div class="slx-capture-test-body">
        <section class="slx-capture-test-stage">
          <div class="slx-capture-test-stage-head">
            <span>阶段 B</span>
            <div><b>采集状态模型</b><small>检查迁移、枚举、稳定 ID 和引用去重</small></div>
          </div>
          <button class="slx-soft-btn" type="button" data-slx-capture-test-b>检查当前聊天状态</button>
          ${renderStageBResult()}
        </section>

        <section class="slx-capture-test-stage">
          <div class="slx-capture-test-stage-head">
            <span>阶段 C</span>
            <div><b>主要剧情材料</b><small>从当前酒馆聊天读取真实楼层并展示最终材料</small></div>
          </div>
          ${renderSourceControls()}
          <button class="slx-primary-btn" type="button" data-slx-capture-test-c>预览当前聊天材料</button>
          ${renderStageCResult()}
        </section>

        <section class="slx-capture-test-stage">
          <div class="slx-capture-test-stage-head">
            <span>阶段 D</span>
            <div><b>可选上下文与世界书条目</b><small>测试按需加载、临时选择边界和生成前 UID 重新解析</small></div>
          </div>
          ${renderStageDPanel()}
        </section>

        ${renderFutureStages()}
      </div>
    </details>
  `;
}

function replaceTestPanel(panelRoot) {
  const current = panelRoot.querySelector('[data-slx-capture-test-root]');
  if (!current) return;
  const template = document.createElement('template');
  template.innerHTML = renderCaptureStageTestPanel().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  current.replaceWith(next);
  bindCaptureStageTestEvents(panelRoot);
}

function syncSourceInputs(root) {
  const recent = root.querySelector('[data-slx-capture-test-recent]');
  const from = root.querySelector('[data-slx-capture-test-from]');
  const to = root.querySelector('[data-slx-capture-test-to]');
  if (recent) testState.recentCount = recent.value;
  if (from) testState.fromFloor = from.value;
  if (to) testState.toFloor = to.value;
}

export function bindCaptureStageTestEvents(panelRoot) {
  const root = panelRoot.querySelector('[data-slx-capture-test-root]');
  if (!root) return;

  root.addEventListener('toggle', () => {
    testState.open = root.open;
  });

  root.querySelector('[data-slx-capture-test-b]')?.addEventListener('click', () => {
    testState.open = true;
    testState.stageBResult = inspectCaptureState();
    replaceTestPanel(panelRoot);
  });

  root.querySelectorAll('[data-slx-capture-test-mode]').forEach(button => {
    button.addEventListener('click', () => {
      syncSourceInputs(root);
      testState.open = true;
      testState.mode = button.getAttribute('data-slx-capture-test-mode') || 'recent_chat';
      testState.stageCResult = null;
      replaceTestPanel(panelRoot);
    });
  });

  root.querySelector('[data-slx-capture-test-c]')?.addEventListener('click', () => {
    syncSourceInputs(root);
    testState.open = true;
    testState.stageCResult = buildCaptureSourceMaterial({
      mode: testState.mode,
      recentCount: testState.recentCount,
      fromFloor: testState.fromFloor,
      toFloor: testState.toFloor,
    });
    replaceTestPanel(panelRoot);
  });

  root.querySelector('[data-slx-capture-test-d-init]')?.addEventListener('click', () => {
    testState.open = true;
    void initializeStageD(panelRoot);
  });

  root.querySelector('[data-slx-capture-test-d-character]')?.addEventListener('change', event => {
    testState.stageD.includeCharacterCard = event.target.checked;
    testState.stageD.result = null;
  });

  root.querySelector('[data-slx-capture-test-d-persona]')?.addEventListener('change', event => {
    testState.stageD.includePersona = event.target.checked;
    testState.stageD.result = null;
  });

  root.querySelectorAll('[data-slx-capture-test-d-expand]').forEach(button => {
    button.addEventListener('click', () => {
      const name = button.getAttribute('data-slx-capture-test-d-expand') || '';
      const expanded = testState.stageD.expandedWorldbooks;
      if (expanded.has(name)) {
        expanded.delete(name);
        replaceTestPanel(panelRoot);
        return;
      }
      expanded.add(name);
      replaceTestPanel(panelRoot);
      void ensureStageDBookLoaded(panelRoot, name);
    });
  });

  root.querySelector('[data-slx-capture-test-d-search]')?.addEventListener('input', event => {
    testState.stageD.search = event.target.value;
    testState.stageD.result = null;
    if (stageDSearchTimer) window.clearTimeout(stageDSearchTimer);
    stageDSearchTimer = window.setTimeout(() => {
      stageDSearchTimer = null;
      if (testState.stageD.search.trim()) void loadAllStageDBooksForSearch(panelRoot);
      else replaceTestPanel(panelRoot);
    }, 250);
  });

  root.querySelectorAll('[data-slx-capture-test-d-entry]').forEach(input => {
    input.addEventListener('change', () => {
      const worldbookName = input.getAttribute('data-worldbook-name') || '';
      const uid = Number(input.getAttribute('data-entry-uid'));
      const entry = testState.stageD.books[worldbookName]?.entries?.find(item => item.uid === uid);
      if (!entry) return;
      testState.stageD.workingRefs = toggleCaptureWorldbookRef(
        testState.stageD.workingRefs,
        { worldbookName, ...entry },
        input.checked,
      );
      testState.stageD.result = null;
      replaceTestPanel(panelRoot);
    });
  });

  root.querySelectorAll('[data-slx-capture-test-d-book-all]').forEach(button => {
    button.addEventListener('click', () => {
      const worldbookName = button.getAttribute('data-slx-capture-test-d-book-all') || '';
      const entries = testState.stageD.books[worldbookName]?.entries || [];
      testState.stageD.workingRefs = setCaptureWorldbookRefsForBook(
        testState.stageD.workingRefs,
        worldbookName,
        entries,
        true,
      );
      testState.stageD.result = null;
      replaceTestPanel(panelRoot);
    });
  });

  root.querySelectorAll('[data-slx-capture-test-d-book-clear]').forEach(button => {
    button.addEventListener('click', () => {
      const worldbookName = button.getAttribute('data-slx-capture-test-d-book-clear') || '';
      testState.stageD.workingRefs = setCaptureWorldbookRefsForBook(
        testState.stageD.workingRefs,
        worldbookName,
        [],
        false,
      );
      testState.stageD.result = null;
      replaceTestPanel(panelRoot);
    });
  });

  root.querySelector('[data-slx-capture-test-d-cancel]')?.addEventListener('click', () => {
    testState.stageD.workingRefs = cloneWorldbookRefs(testState.stageD.confirmedRefs);
    testState.stageD.result = null;
    replaceTestPanel(panelRoot);
  });

  root.querySelector('[data-slx-capture-test-d-confirm]')?.addEventListener('click', () => {
    testState.stageD.confirmedRefs = cloneWorldbookRefs(testState.stageD.workingRefs);
    testState.stageD.result = null;
    replaceTestPanel(panelRoot);
  });

  root.querySelector('[data-slx-capture-test-d-preview]')?.addEventListener('click', async () => {
    const stageD = testState.stageD;
    stageD.loading = true;
    stageD.loadingMessage = '正在按 worldbookName + uid 重新读取已确认条目…';
    stageD.result = null;
    replaceTestPanel(panelRoot);
    stageD.result = await buildCaptureOptionalContextMaterial({
      includeCharacterCard: stageD.includeCharacterCard,
      includePersona: stageD.includePersona,
      worldbookRefs: stageD.confirmedRefs,
    });
    stageD.loading = false;
    stageD.loadingMessage = '';
    replaceTestPanel(panelRoot);
  });
}
