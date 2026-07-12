// 设定采集开发期阶段验证区。只读检查状态与材料，不调用模型、不写世界书、不修改聊天记录。

import { getContextInfo, getMemoirState } from '../../core/settings.js';
import { escapeHtml } from '../../utils/text.js';
import {
  CAPTURE_SOURCE_MODES,
  CAPTURE_TYPES,
  normalizeCaptureState,
} from './capture-model.js';
import { buildCaptureSourceMaterial } from './capture-materials.js';

const SOURCE_LABELS = {
  recent_chat: '最近聊天',
  floor_range: '指定楼层',
  grand_plus_after: '大总结＋后续',
};

let testState = {
  activeChatKey: '',
  open: false,
  mode: 'recent_chat',
  recentCount: 20,
  fromFloor: '',
  toFloor: '',
  stageBResult: null,
  stageCResult: null,
};

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

function renderFutureStages() {
  const stages = [
    ['D', '角色卡、Persona 与世界书条目材料预览'],
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
}
