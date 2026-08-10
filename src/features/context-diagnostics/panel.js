import {
  collectCachedWorldInfoContext,
} from '../../core/context-resolver.js';
import {
  escapeHtml,
} from '../../utils/text.js';

let diagnosticsOptions = {
  refreshPanel: null,
};

export function configureContextDiagnosticsPanel(options = {}) {
  diagnosticsOptions = {
    ...diagnosticsOptions,
    ...options,
  };
}

function renderDiagnosticLine(label, value) {
  return `<div class="slx-info-line"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function renderWorldInfoDecisionDiagnostics(diag = {}, prefix = '') {
  const labelPrefix = prefix ? `${prefix} ` : '';
  return [
    renderDiagnosticLine(`${labelPrefix}来源`, diag.source || '未记录'),
    renderDiagnosticLine(`${labelPrefix}模式`, diag.mode || '未记录'),
    renderDiagnosticLine(`${labelPrefix}素材来源`, diag.materialSource || 'none'),
    renderDiagnosticLine(`${labelPrefix}注入来源`, diag.injectionSource || 'none'),
    renderDiagnosticLine(`${labelPrefix}缓存命中`, diag.cacheHitReason || '无'),
    renderDiagnosticLine(`${labelPrefix}兜底原因`, diag.fallbackReason || '无'),
    renderDiagnosticLine(`${labelPrefix}使用缓存`, diag.usedCache ? '是' : '否'),
    renderDiagnosticLine(`${labelPrefix}使用兜底扫描`, diag.usedDryRun ? '是' : '否'),
    renderDiagnosticLine(`${labelPrefix}扫描楼层`, diag.scanMessageCount ?? 0),
    renderDiagnosticLine(`${labelPrefix}注入角色名`, diag.targetRoleInjected ? '是' : '否'),
    renderDiagnosticLine(`${labelPrefix}包含说话人`, diag.includeNames === null ? '未记录' : (diag.includeNames ? '是' : '否')),
    renderDiagnosticLine(`${labelPrefix}before/after`, `${diag.hasWorldInfoBefore ? 'before' : '-'} / ${diag.hasWorldInfoAfter ? 'after' : '-'}`),
    renderDiagnosticLine(`${labelPrefix}裸 activated.text`, diag.activatedTextLength ?? 0),
  ].join('');
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
    ${renderWorldInfoDecisionDiagnostics(diag)}
    ${renderDiagnosticLine('世界书缓存批次', diag.cacheCount ?? 0)}
    ${renderDiagnosticLine('世界书激活条目', diag.activatedCount ?? 0)}
    ${renderDiagnosticLine('世界书过滤条目', diag.filteredCount ?? 0)}
    ${renderDiagnosticLine('世界书可疑条目', diag.suspiciousCount ?? 0)}
    ${renderDiagnosticLine('世界书可用条目', diag.usedCount ?? 0)}
    ${renderDiagnosticLine('世界书注入文本', diag.injectionTextLength ?? 0)}
    <div class="slx-worldinfo-diagnostics">
      ${renderWorldInfoEntryList('可用条目', usedEntries)}
      ${renderWorldInfoEntryList('可疑条目', diag.suspiciousEntries || [], { showReason: true })}
      ${renderWorldInfoEntryList('已过滤条目', diag.filteredEntries || [], { showReason: true })}
      ${renderRawSourceCounts('缓存原始字段计数', diag.rawSourceCounts)}
    </div>
  `;
}

/** 保留绑定入口，避免 index 装配改动；开发期手动 dry run 测试已移除。 */
export function bindContextDiagnosticsPanelEvents(_panelRoot) {
  // no-op: manual dry-run test entry removed for release
}
