import {
  AFFECTION_ALLOWED_DELTA_TENTHS,
  createManualAffectionAdjustmentRecord,
  formatAffectionValueTenths,
  getStageForValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionRoleName,
  parseAffectionDeltaTenths,
  parseAffectionValueTenths,
  recalculateAffectionLedger,
  replaceAffectionRecord,
  upsertAffectionRecord,
} from './model.js';
import { escapeHtml } from '../../utils/text.js';

const DEFAULT_CHANGE_LINES = [
  '沈青 |0.1',
  '沈 青|0.2',
  '阿蛮|5',
  '苏暮香|-0.2',
].join('\n');

const DEFAULT_LEDGER_RECORDS = JSON.stringify([
  {
    recordId: 'message-12',
    sourceMessageId: 12,
    sourceFingerprint: 'swipe-b',
    deltaTenths: 2,
    sourceType: 'auto',
    createdAt: '2026-07-13T12:02:00.000Z',
  },
  {
    recordId: 'message-10',
    sourceMessageId: 10,
    sourceFingerprint: 'swipe-a',
    deltaTenths: 1,
    sourceType: 'auto',
    createdAt: '2026-07-13T12:01:00.000Z',
  },
], null, 2);

let affectionPanelOptions = {
  refreshPanel: null,
};

let affectionTestState = createDefaultTestState();

function createDefaultTestState() {
  return {
    suiteStatus: 'idle',
    suiteResults: [],
    changeGate: 'true',
    changeLines: DEFAULT_CHANGE_LINES,
    changeResult: null,
    changeError: '',
    ledgerInitialValue: '42.2',
    ledgerRecords: DEFAULT_LEDGER_RECORDS,
    ledgerTargetValue: '50.0',
    ledgerResult: null,
    ledgerError: '',
    expandedSections: {
      suite: false,
      change: false,
      ledger: false,
    },
  };
}

export function configureAffectionPanel(options = {}) {
  affectionPanelOptions = {
    ...affectionPanelOptions,
    ...options,
  };
}

function refreshPanel() {
  if (typeof affectionPanelOptions.refreshPanel === 'function') {
    affectionPanelOptions.refreshPanel();
  }
}

function assertTest(condition, message) {
  if (!condition) throw new Error(message);
}

function sameValue(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function runModelTest(title, run) {
  try {
    const detail = run();
    return {
      title,
      status: 'passed',
      detail: String(detail || '结果符合预期。'),
    };
  } catch (error) {
    return {
      title,
      status: 'failed',
      detail: error?.message || String(error),
    };
  }
}

function runAffectionModelSuite() {
  const results = [
    runModelTest('合法 delta 转为整数十分位', () => {
      const actual = ['-0.3', '-0.2', '-0.1', '0.1', '0.2', '0.3']
        .map(parseAffectionDeltaTenths);
      assertTest(sameValue(actual, [-3, -2, -1, 1, 2, 3]), `实际结果：${JSON.stringify(actual)}`);
      assertTest(sameValue(AFFECTION_ALLOWED_DELTA_TENTHS, [-3, -2, -1, 1, 2, 3]), '允许值常量与解析规则不一致。');
      return '±0.1 / ±0.2 / ±0.3 均正确转换。';
    }),
    runModelTest('拒绝 0、越界值与非法小数', () => {
      const values = [0, '0', '0.11', '1', '999', 'abc', ''];
      const actual = values.map(parseAffectionDeltaTenths);
      assertTest(actual.every(value => value === null), `未全部拒绝：${JSON.stringify(actual)}`);
      return '所有非法变化值均返回 null。';
    }),
    runModelTest('角色名保守规范化', () => {
      const actual = normalizeAffectionRoleName('  沈\n   青  ');
      assertTest(actual === '沈青', `中文名实际结果：${actual}`);
      assertTest(normalizeAffectionRoleName('  Mary   Jane  ') === 'Mary Jane', '外文姓名的正常分隔空格被误删。');
      return '中文字符间异常空格已清除，外文姓名分隔空格保留。';
    }),
    runModelTest('affection_changed 关闭时忽略变化行', () => {
      const actual = normalizeAffectionChanges({
        changed: false,
        entries: [['沈青', '0.1']],
      });
      assertTest(actual.changed === false && actual.items.length === 0, 'gate 关闭后仍产生了变化。');
      assertTest(actual.diagnostics.some(item => item.code === 'gate_closed'), '缺少 gate_closed 诊断。');
      return '变化被忽略且给出 gate_closed 诊断。';
    }),
    runModelTest('同轮同名角色只保留第一条合法变化', () => {
      const actual = normalizeAffectionChanges({
        changed: true,
        entries: [['沈青', '0.1'], ['沈 青', '0.2'], ['阿蛮', '-0.2']],
      });
      assertTest(sameValue(actual.items, [
        { roleName: '沈青', deltaTenths: 1 },
        { roleName: '阿蛮', deltaTenths: -2 },
      ]), `实际结果：${JSON.stringify(actual.items)}`);
      assertTest(actual.diagnostics.some(item => item.code === 'duplicate_role'), '缺少 duplicate_role 诊断。');
      return '规范化同名已去重，并保留其他角色。';
    }),
    runModelTest('gate 开启但无合法 delta 时归一为无变化', () => {
      const actual = normalizeAffectionChanges({
        changed: true,
        entries: [['沈青', '0'], ['', '0.1']],
      });
      assertTest(actual.changed === false && actual.items.length === 0, '无合法变化时 changed 未关闭。');
      assertTest(actual.diagnostics.some(item => item.code === 'no_valid_delta'), '缺少 no_valid_delta 诊断。');
      return 'changed=false，非法原因保留在 diagnostics。';
    }),
    runModelTest('五阶段边界连续且无空档', () => {
      const samples = [
        [0, 'S1'], [200, 'S1'], [201, 'S2'], [400, 'S2'], [401, 'S3'],
        [600, 'S3'], [601, 'S4'], [800, 'S4'], [801, 'S5'], [1000, 'S5'],
      ];
      const actual = samples.map(([value]) => getStageForValueTenths(value).stageId);
      const expected = samples.map(([, stageId]) => stageId);
      assertTest(sameValue(actual, expected), `实际阶段：${JSON.stringify(actual)}`);
      return '0/20.0/20.1/40.0/40.1/60.0/60.1/80.0/80.1/100.0 全部命中正确阶段。';
    }),
    runModelTest('账本按楼层排序并重算前后值', () => {
      const ledger = recalculateAffectionLedger(422, [
        { recordId: 'later', sourceMessageId: 12, deltaTenths: 2, sourceType: 'auto' },
        { recordId: 'earlier', sourceMessageId: 10, deltaTenths: 1, sourceType: 'auto' },
      ]);
      assertTest(sameValue(ledger.records.map(item => item.recordId), ['earlier', 'later']), '记录未按楼层排序。');
      assertTest(sameValue(ledger.records.map(item => [item.valueBeforeTenths, item.valueAfterTenths]), [
        [422, 423], [423, 425],
      ]), `前后值错误：${JSON.stringify(ledger.records)}`);
      assertTest(ledger.valueTenths === 425, `最终值错误：${ledger.valueTenths}`);
      return '乱序输入被整理为 10 楼 → 12 楼，最终值 42.5。';
    }),
    runModelTest('同楼自动记录替换且手动记录保留', () => {
      const actual = replaceAffectionRecord([
        { recordId: 'old-auto', sourceMessageId: 10, deltaTenths: 1, sourceType: 'auto' },
        { recordId: 'manual', sourceMessageId: 10, deltaTenths: 5, sourceType: 'manual_adjustment' },
      ], {
        recordId: 'new-auto', sourceMessageId: 10, deltaTenths: -2, sourceType: 'auto',
      });
      assertTest(!actual.some(item => item.recordId === 'old-auto'), '旧自动记录未被替换。');
      assertTest(actual.some(item => item.recordId === 'new-auto'), '新自动记录未写入。');
      assertTest(actual.some(item => item.recordId === 'manual'), '同楼手动记录被误删。');
      return '只替换同楼自动记录。';
    }),
    runModelTest('重复提交同一楼层保持幂等', () => {
      const first = upsertAffectionRecord(400, [], {
        recordId: 'first', sourceMessageId: 20, deltaTenths: 1, sourceType: 'auto',
      });
      const second = upsertAffectionRecord(400, first.records, {
        recordId: 'second', sourceMessageId: 20, deltaTenths: 2, sourceType: 'auto',
      });
      assertTest(second.records.length === 1, `实际记录数：${second.records.length}`);
      assertTest(second.valueTenths === 402, `实际最终值：${second.valueTenths}`);
      return '同楼第二次处理替换旧值，不发生 0.1 + 0.2 的重复累计。';
    }),
    runModelTest('上下限截断后从可见值继续累计', () => {
      const ledger = recalculateAffectionLedger(999, [
        { recordId: 'up', sourceMessageId: 1, deltaTenths: 3, sourceType: 'auto' },
        { recordId: 'down', sourceMessageId: 2, deltaTenths: -1, sourceType: 'auto' },
      ]);
      assertTest(sameValue(ledger.records.map(item => [item.valueBeforeTenths, item.valueAfterTenths]), [
        [999, 1000], [1000, 999],
      ]), `截断承接错误：${JSON.stringify(ledger.records)}`);
      return '99.9 + 0.3 = 100.0，随后 -0.1 = 99.9。';
    }),
    runModelTest('手动调整按当前正式值生成记录', () => {
      const records = [{ recordId: 'auto', sourceMessageId: 1, deltaTenths: 1, sourceType: 'auto' }];
      const manual = createManualAffectionAdjustmentRecord({
        initialValueTenths: 422,
        records,
        targetValueTenths: 500,
        recordId: 'manual',
      });
      assertTest(manual?.deltaTenths === 77, `手动 delta：${manual?.deltaTenths}`);
      const ledger = recalculateAffectionLedger(422, [...records, manual]);
      assertTest(manual?.sourceMessageId === null, `手动记录楼层号应为 null，实际为：${manual?.sourceMessageId}`);
      assertTest(sameValue(ledger.records.map(item => item.recordId), ['auto', 'manual']), '手动记录没有排在现有楼层记录之后。');
      assertTest(manual?.valueBeforeTenths === 423 && manual?.valueAfterTenths === 500, '手动记录的前后值不正确。');
      assertTest(ledger.valueTenths === 500, `调整后最终值：${ledger.valueTenths}`);
      return '自动记录先算到 42.3，随后以无楼层手动记录调整到 50.0。';
    }),
  ];

  affectionTestState.suiteResults = results;
  affectionTestState.suiteStatus = results.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

function parseChangeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separatorIndex = line.indexOf('|');
      if (separatorIndex < 0) return [line, ''];
      return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
    });
}

function runChangeSimulator() {
  try {
    const result = normalizeAffectionChanges({
      changed: affectionTestState.changeGate,
      entries: parseChangeLines(affectionTestState.changeLines),
    });
    affectionTestState.changeResult = result;
    affectionTestState.changeError = '';
  } catch (error) {
    affectionTestState.changeResult = null;
    affectionTestState.changeError = error?.message || String(error);
  }
}

function runLedgerSimulator() {
  try {
    const initialValueTenths = parseAffectionValueTenths(affectionTestState.ledgerInitialValue);
    if (initialValueTenths === null) throw new Error('初始好感必须是 0—100、最多一位小数。');

    const records = JSON.parse(affectionTestState.ledgerRecords || '[]');
    if (!Array.isArray(records)) throw new Error('账本记录必须是 JSON 数组。');

    const ledger = recalculateAffectionLedger(initialValueTenths, records);
    const targetValueTenths = parseAffectionValueTenths(affectionTestState.ledgerTargetValue);
    const manualRecord = targetValueTenths === null ? null : createManualAffectionAdjustmentRecord({
      initialValueTenths,
      records: ledger.records,
      targetValueTenths,
      recordId: 'manual:test-area',
      createdAt: new Date().toISOString(),
    });
    const adjustedLedger = manualRecord
      ? recalculateAffectionLedger(initialValueTenths, [...ledger.records, manualRecord])
      : ledger;

    affectionTestState.ledgerResult = {
      orderedValue: formatAffectionValueTenths(ledger.valueTenths),
      ledger,
      manualTarget: targetValueTenths === null ? '未提供' : formatAffectionValueTenths(targetValueTenths),
      manualRecord,
      adjustedValue: formatAffectionValueTenths(adjustedLedger.valueTenths),
      adjustedLedger,
    };
    affectionTestState.ledgerError = '';
  } catch (error) {
    affectionTestState.ledgerResult = null;
    affectionTestState.ledgerError = error?.message || String(error);
  }
}

function renderJsonResult(result, error, emptyText) {
  if (error) return `<div class="slx-affection-test-error">${escapeHtml(error)}</div>`;
  if (!result) return `<div class="slx-affection-test-empty">${escapeHtml(emptyText)}</div>`;
  return `<pre class="slx-affection-test-output">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
}

function renderSuiteResults() {
  if (!affectionTestState.suiteResults.length) {
    return '<div class="slx-affection-test-empty">尚未运行。点击上方按钮后会逐项显示通过或失败原因。</div>';
  }

  return `
    <ul class="slx-affection-test-list">
      ${affectionTestState.suiteResults.map(item => `
        <li class="is-${escapeHtml(item.status)}">
          <span class="slx-affection-test-mark">${item.status === 'passed' ? '✓' : '×'}</span>
          <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></span>
        </li>
      `).join('')}
    </ul>
  `;
}

export function renderAffectionPanel() {
  const passedCount = affectionTestState.suiteResults.filter(item => item.status === 'passed').length;
  const totalCount = affectionTestState.suiteResults.length;
  const suiteLabel = affectionTestState.suiteStatus === 'passed'
    ? `全部通过（${passedCount}/${totalCount}）`
    : affectionTestState.suiteStatus === 'failed'
      ? `存在失败（${passedCount}/${totalCount}）`
      : '等待测试';

  return `
    <div class="slx-affection-test-root">
      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="suite" ${affectionTestState.expandedSections.suite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 1 步 · 纯数据模型</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.suiteStatus)}">${escapeHtml(suiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>直接调用 <code>affection/model.js</code> 的真实函数。所有输入和结果只保留在当前页面内存中，不写聊天、不改设置、不请求 API。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-suite>运行第 1 步全部检查</button>
            <button class="slx-soft-btn" type="button" data-slx-affection-reset-tests>重置测试区</button>
          </div>
          ${renderSuiteResults()}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="change" ${affectionTestState.expandedSections.change ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 A</small>
            <b>变化门控、角色去重与非法值</b>
          </span>
          <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="slx-affection-test-body">
          <p>每行格式为“角色名|变化值”。可修改 gate 和样例，观察规范化结果及 diagnostics。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field">
              <span>affection_changed</span>
              <select data-slx-affection-change-gate>
                <option value="true" ${affectionTestState.changeGate === 'true' ? 'selected' : ''}>true</option>
                <option value="false" ${affectionTestState.changeGate === 'false' ? 'selected' : ''}>false</option>
              </select>
            </label>
            <label class="slx-field slx-affection-test-wide">
              <span>affection 行</span>
              <textarea data-slx-affection-change-lines spellcheck="false">${escapeHtml(affectionTestState.changeLines)}</textarea>
            </label>
          </div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-change>模拟规范化</button>
          </div>
          ${renderJsonResult(affectionTestState.changeResult, affectionTestState.changeError, '运行后显示 changed、items 与 diagnostics。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="ledger" ${affectionTestState.expandedSections.ledger ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 B</small>
            <b>楼层排序、账本重算与手动调整</b>
          </span>
          <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="slx-affection-test-body">
          <p>记录使用整数十分位：1 代表 +0.1。输入顺序可以打乱，结果应按 sourceMessageId 重排并逐条承接。</p>
          <div class="slx-affection-test-grid">
            <label class="slx-field">
              <span>初始好感（0—100）</span>
              <input type="number" min="0" max="100" step="0.1" value="${escapeHtml(affectionTestState.ledgerInitialValue)}" data-slx-affection-ledger-initial />
            </label>
            <label class="slx-field">
              <span>手动调整目标（可留空）</span>
              <input type="number" min="0" max="100" step="0.1" value="${escapeHtml(affectionTestState.ledgerTargetValue)}" data-slx-affection-ledger-target />
            </label>
            <label class="slx-field slx-affection-test-wide">
              <span>records JSON</span>
              <textarea data-slx-affection-ledger-records spellcheck="false">${escapeHtml(affectionTestState.ledgerRecords)}</textarea>
            </label>
          </div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-ledger>模拟账本</button>
          </div>
          ${renderJsonResult(affectionTestState.ledgerResult, affectionTestState.ledgerError, '运行后显示排序、每条记录前后值、最终值和手动调整记录。')}
        </div>
      </details>
    </div>
  `;
}

function syncAffectionTestInputs(panelRoot) {
  affectionTestState.changeGate = panelRoot.querySelector('[data-slx-affection-change-gate]')?.value
    || affectionTestState.changeGate;
  affectionTestState.changeLines = panelRoot.querySelector('[data-slx-affection-change-lines]')?.value
    ?? affectionTestState.changeLines;
  affectionTestState.ledgerInitialValue = panelRoot.querySelector('[data-slx-affection-ledger-initial]')?.value
    ?? affectionTestState.ledgerInitialValue;
  affectionTestState.ledgerTargetValue = panelRoot.querySelector('[data-slx-affection-ledger-target]')?.value
    ?? affectionTestState.ledgerTargetValue;
  affectionTestState.ledgerRecords = panelRoot.querySelector('[data-slx-affection-ledger-records]')?.value
    ?? affectionTestState.ledgerRecords;
}

export function bindAffectionPanelEvents(panelRoot) {
  panelRoot.querySelectorAll('[data-slx-affection-test-section]').forEach(section => {
    section.addEventListener('toggle', () => {
      const sectionId = section.dataset.slxAffectionTestSection;
      if (sectionId && Object.hasOwn(affectionTestState.expandedSections, sectionId)) {
        affectionTestState.expandedSections[sectionId] = section.open;
      }
    });
  });

  panelRoot.querySelector('[data-slx-affection-run-suite]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionModelSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-change]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runChangeSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-ledger]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runLedgerSimulator();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-reset-tests]')?.addEventListener('click', () => {
    affectionTestState = createDefaultTestState();
    refreshPanel();
  });
}
