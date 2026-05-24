import {
  collectCachedWorldInfoContext,
  collectDryRunWorldInfoContext,
} from '../../core/context-resolver.js';
import {
  escapeHtml,
} from '../../utils/text.js';

let diagnosticsOptions = {
  refreshPanel: null,
};

let dryRunState = {
  status: 'idle',
  result: null,
  error: '',
};

export function configureContextDiagnosticsPanel(options = {}) {
  diagnosticsOptions = {
    ...diagnosticsOptions,
    ...options,
  };
}

function refreshPanel() {
  if (typeof diagnosticsOptions.refreshPanel === 'function') {
    diagnosticsOptions.refreshPanel();
  }
}

function renderDiagnosticLine(label, value) {
  return `<div class="slx-info-line"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function renderWorldInfoEntryList(title, entries = [], { showReason = false } = {}) {
  const items = entries.map(entry => {
    const world = String(entry.world || '').trim();
    const reason = String(entry.reason || entry.filterReason || '').trim();
    const meta = [
      world ? `世界书：${world}` : '',
      showReason && reason ? `原因：${reason}` : '',
    ].filter(Boolean).join(' · ') || '未记录来源';

    return `
      <li>
        <b>${escapeHtml(entry.title || '未命名条目')}</b>
        <small>${escapeHtml(meta)}</small>
      </li>
    `;
  }).join('');

  return `
    <details class="slx-worldinfo-details">
      <summary>${escapeHtml(title)} (${escapeHtml(entries.length)})</summary>
      ${entries.length ? `<ul>${items}</ul>` : '<p>暂无</p>'}
    </details>
  `;
}

function renderRawSourceCounts(title, counts = {}) {
  const visibleCounts = Object.entries(counts)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `
      <li>
        <b>${escapeHtml(key)}</b>
        <small>${escapeHtml(value)}</small>
      </li>
    `).join('');

  return `
    <details class="slx-worldinfo-details">
      <summary>${escapeHtml(title)}</summary>
      ${visibleCounts ? `<ul>${visibleCounts}</ul>` : '<p>暂无原始字段命中</p>'}
    </details>
  `;
}

export function renderContextDiagnostics() {
  const worldInfo = collectCachedWorldInfoContext();
  const diag = worldInfo.diagnostics || {};
  const usedEntries = (worldInfo.entries || []).map(entry => ({
    title: entry.title,
    world: entry.world,
  }));

  return `
    ${renderDiagnosticLine('世界书缓存批次', diag.cacheCount ?? 0)}
    ${renderDiagnosticLine('世界书激活条目', diag.activatedCount ?? 0)}
    ${renderDiagnosticLine('世界书过滤条目', diag.filteredCount ?? 0)}
    ${renderDiagnosticLine('世界书可疑条目', diag.suspiciousCount ?? 0)}
    ${renderDiagnosticLine('世界书可用条目', diag.usedCount ?? 0)}
    <div class="slx-worldinfo-diagnostics">
      <div class="slx-worldinfo-test-row">
        <button class="slx-soft-btn" type="button" data-slx-test-worldinfo-dry-run ${dryRunState.status === 'running' ? 'disabled' : ''}>
          ${dryRunState.status === 'running' ? '测试中...' : '测试 dry run'}
        </button>
        <span>${escapeHtml(getDryRunStatusText())}</span>
      </div>
      ${renderWorldInfoEntryList('可用条目', usedEntries)}
      ${renderWorldInfoEntryList('可疑条目', diag.suspiciousEntries || [], { showReason: true })}
      ${renderWorldInfoEntryList('已过滤条目', diag.filteredEntries || [], { showReason: true })}
      ${renderRawSourceCounts('缓存原始字段计数', diag.rawSourceCounts)}
      ${renderDryRunDiagnostics()}
    </div>
  `;
}

function getDryRunStatusText() {
  if (dryRunState.status === 'success') {
    const diag = dryRunState.result?.diagnostics || {};
    return `dry run：激活 ${diag.activatedCount ?? 0} / 可用 ${diag.usedCount ?? 0}`;
  }
  if (dryRunState.status === 'failed') return dryRunState.error || 'dry run 失败';
  if (dryRunState.status === 'running') return '正在扫描最近聊天';
  return '可临时验证兜底扫描';
}

function renderDryRunDiagnostics() {
  if (dryRunState.status !== 'success' || !dryRunState.result) return '';
  const result = dryRunState.result;
  const diag = result.diagnostics || {};
  const usedEntries = (result.entries || []).map(entry => ({
    title: entry.title,
    world: entry.world,
  }));
  return `
    <div class="slx-worldinfo-dryrun-result">
      <div class="slx-detail-kicker">dry run 测试结果</div>
      ${renderDiagnosticLine('dry run 激活条目', diag.activatedCount ?? 0)}
      ${renderDiagnosticLine('dry run 过滤条目', diag.filteredCount ?? 0)}
      ${renderDiagnosticLine('dry run 可疑条目', diag.suspiciousCount ?? 0)}
      ${renderDiagnosticLine('dry run 可用条目', diag.usedCount ?? 0)}
      ${renderRawSourceCounts('dry run 原始字段计数', diag.rawSourceCounts)}
      ${renderWorldInfoEntryList('dry run 可用条目', usedEntries)}
      ${renderWorldInfoEntryList('dry run 可疑条目', diag.suspiciousEntries || [], { showReason: true })}
      ${renderWorldInfoEntryList('dry run 已过滤条目', diag.filteredEntries || [], { showReason: true })}
    </div>
  `;
}

export function bindContextDiagnosticsPanelEvents(panelRoot) {
  panelRoot.querySelector('[data-slx-test-worldinfo-dry-run]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    dryRunState = {
      status: 'running',
      result: null,
      error: '',
    };
    refreshPanel();

    try {
      const result = await collectDryRunWorldInfoContext();
      dryRunState = {
        status: result.diagnostics?.source === 'dry_run_failed' ? 'failed' : 'success',
        result,
        error: result.diagnostics?.notes?.join('；') || '',
      };
    } catch (error) {
      dryRunState = {
        status: 'failed',
        result: null,
        error: error.message || String(error),
      };
    }
    refreshPanel();
  });
}
