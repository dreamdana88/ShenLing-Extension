import {
  collectCachedWorldInfoContext,
} from '../../core/context-resolver.js';
import {
  escapeHtml,
} from '../../utils/text.js';

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
      ${renderWorldInfoEntryList('可用条目', usedEntries)}
      ${renderWorldInfoEntryList('可疑条目', diag.suspiciousEntries || [], { showReason: true })}
      ${renderWorldInfoEntryList('已过滤条目', diag.filteredEntries || [], { showReason: true })}
    </div>
  `;
}
