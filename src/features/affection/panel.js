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
import {
  cloneData,
  escapeHtml,
} from '../../utils/text.js';
import {
  getAffectionProfileKey,
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getGlobalSettings,
  getStorageDiagnostics,
  saveChatState,
  saveGlobalSettings,
} from '../../core/settings.js';

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

const DEFAULT_SETTINGS_MIGRATION_INPUT = JSON.stringify({
  globalSettings: {
    modules: {
      affection: {
        enabled: true,
        mode: 'off',
        buildMode: 'generic',
        apiMode: 'main_api',
        obsoleteField: '会被移除',
      },
    },
  },
  chatState: {
    affectionSystem: {
      profiles: {
        '旧键不会参与身份': {
          roleName: '  沈 青  ',
          characterId: 'world-card-id',
          aliases: ['阿青'],
          initialValueTenths: 425,
        },
      },
      pendingByMessage: [],
      buildTasks: '损坏对象',
      mode: 'reverse',
      buildMode: 'generic',
    },
  },
}, null, 2);

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
    settingsSuiteStatus: 'idle',
    settingsSuiteResults: [],
    settingsMigrationInput: DEFAULT_SETTINGS_MIGRATION_INPUT,
    settingsMigrationStatus: 'idle',
    settingsMigrationResult: null,
    settingsMigrationError: '',
    storageProbeStatus: 'idle',
    storageProbeResult: null,
    storageProbeError: '',
    expandedSections: {
      suite: false,
      change: false,
      ledger: false,
      settingsSuite: false,
      settingsMigration: false,
      storageProbe: false,
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

function runAffectionSettingsSuite() {
  const results = [
    runModelTest('全局默认设置字段完整且唯一', () => {
      const holder = { modules: {} };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: false,
        mode: 'normal',
        defaultBuildMode: 'custom',
        profileBuildApiMode: 'secondary_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      assertTest(sameValue(Object.keys(actual), [
        'enabled', 'mode', 'defaultBuildMode', 'profileBuildApiMode',
      ]), `实际字段：${JSON.stringify(Object.keys(actual))}`);
      return '只生成四个已定稿的全局字段。';
    }),
    runModelTest('非法枚举和损坏开关回落到安全默认值', () => {
      const holder = {
        modules: {
          affection: {
            enabled: 'true',
            mode: 'broken',
            defaultBuildMode: 'unknown',
            profileBuildApiMode: 'third_api',
            extra: 'remove-me',
          },
        },
      };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: false,
        mode: 'normal',
        defaultBuildMode: 'custom',
        profileBuildApiMode: 'secondary_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      return '损坏布尔值、非法枚举与多余字段均已安全规范化。';
    }),
    runModelTest('合法模式枚举保持兼容但不扩展第一版 UI', () => {
      const holder = {
        modules: {
          affection: {
            enabled: true,
            mode: 'reverse',
            defaultBuildMode: 'generic',
            profileBuildApiMode: 'main_api',
          },
        },
      };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: true,
        mode: 'reverse',
        defaultBuildMode: 'generic',
        profileBuildApiMode: 'main_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      return '数据层保留 reverse 枚举兼容；本测试区未提供 reverse 操作入口。';
    }),
    runModelTest('旧草案字段迁移且 off 不会误开启攻略', () => {
      const holder = {
        modules: {
          affection: {
            enabled: true,
            mode: 'off',
            buildMode: 'generic',
            apiMode: 'main_api',
          },
        },
      };
      const actual = getAffectionSettings(holder);
      assertTest(sameValue(actual, {
        enabled: false,
        mode: 'normal',
        defaultBuildMode: 'generic',
        profileBuildApiMode: 'main_api',
      }), `实际结果：${JSON.stringify(actual)}`);
      return '旧 off 被迁移为 enabled=false，旧建档/API 字段映射到正式字段。';
    }),
    runModelTest('聊天态只保留三个独立数据容器', () => {
      const holder = {
        affectionSystem: {
          profiles: null,
          pendingByMessage: [],
          buildTasks: 'broken',
          mode: 'reverse',
          buildMode: 'generic',
          profileBuildApiMode: 'main_api',
        },
      };
      const actual = getAffectionSystemState(holder);
      assertTest(sameValue(actual, {
        profiles: {},
        pendingByMessage: {},
        buildTasks: {},
      }), `实际结果：${JSON.stringify(actual)}`);
      return '损坏容器已修复，聊天态未复制任何全局模式字段。';
    }),
    runModelTest('顶层模块和 affectionSystem 损坏时可完整重建', () => {
      const globalHolder = { modules: [] };
      const chatHolder = { affectionSystem: [] };
      const settings = getAffectionSettings(globalHolder);
      const system = getAffectionSystemState(chatHolder);
      assertTest(settings.enabled === false && settings.mode === 'normal', `全局设置：${JSON.stringify(settings)}`);
      assertTest(sameValue(system, { profiles: {}, pendingByMessage: {}, buildTasks: {} }), `聊天态：${JSON.stringify(system)}`);
      return '数组、空值等损坏顶层结构会回落为完整安全默认值。';
    }),
    runModelTest('profile key 只采用保守规范化角色名', () => {
      const holder = {
        affectionSystem: {
          profiles: {
            'storage-key': {
              roleName: '  沈 青  ',
              characterId: 'world-card-id',
              uuid: 'fake-uuid',
              aliases: ['阿青'],
            },
            ' 阿 蛮 ': {
              initialValueTenths: 100,
            },
            duplicate: {
              roleName: '沈青',
              initialValueTenths: 999,
            },
          },
          pendingByMessage: {},
          buildTasks: {},
        },
      };
      const actual = getAffectionSystemState(holder);
      assertTest(sameValue(Object.keys(actual.profiles), ['沈青', '阿蛮']), `实际 key：${JSON.stringify(Object.keys(actual.profiles))}`);
      assertTest(actual.profiles['沈青'].roleName === '沈青', 'profile.roleName 未同步规范化。');
      assertTest(!Object.hasOwn(actual.profiles, 'world-card-id') && !Object.hasOwn(actual.profiles, 'fake-uuid'), '角色卡或 UUID 被误作 profile key。');
      assertTest(getAffectionProfileKey(' 苏 暮 香 ') === '苏暮香', '角色名键函数未复用 model 的保守规范化。');
      return '角色卡 ID、UUID、aliases 均未参与身份键推断，同名保留首条档案。';
    }),
    runModelTest('旧数组草案可按显式 roleName 恢复', () => {
      const holder = {
        affectionSystem: {
          profiles: [
            { roleName: ' 苏 暮 香 ', initialValueTenths: 300 },
            { name: '没有 roleName', characterId: 'not-a-role' },
          ],
        },
      };
      const actual = getAffectionSystemState(holder);
      assertTest(sameValue(Object.keys(actual.profiles), ['苏暮香']), `实际 key：${JSON.stringify(Object.keys(actual.profiles))}`);
      assertTest(sameValue(Object.keys(actual), ['profiles', 'pendingByMessage', 'buildTasks']), '聊天态字段不完整。');
      return '只迁移带显式 roleName 的旧数组条目。';
    }),
  ];

  affectionTestState.settingsSuiteResults = results;
  affectionTestState.settingsSuiteStatus = results.every(item => item.status === 'passed') ? 'passed' : 'failed';
}

function runSettingsMigrationPreview() {
  try {
    const source = JSON.parse(affectionTestState.settingsMigrationInput || '{}');
    const globalSettings = cloneData(source.globalSettings || {});
    const chatState = cloneData(source.chatState || {});
    const affectionSettings = getAffectionSettings(globalSettings);
    const affectionSystem = getAffectionSystemState(chatState);
    affectionTestState.settingsMigrationResult = {
      affectionSettings,
      affectionSystem,
      persistedGlobalFields: Object.keys(affectionSettings),
      persistedChatFields: Object.keys(affectionSystem),
      profileKeys: Object.keys(affectionSystem.profiles),
      note: '本次预览只修改解析后的页面内存副本。',
    };
    affectionTestState.settingsMigrationStatus = 'passed';
    affectionTestState.settingsMigrationError = '';
  } catch (error) {
    affectionTestState.settingsMigrationResult = null;
    affectionTestState.settingsMigrationStatus = 'failed';
    affectionTestState.settingsMigrationError = error?.message || String(error);
  }
}

function runAffectionStorageProbe() {
  const diagnostics = getStorageDiagnostics();
  if (!diagnostics.hasExtensionSettings || !diagnostics.hasChatMetadata) {
    affectionTestState.storageProbeStatus = 'failed';
    affectionTestState.storageProbeResult = null;
    affectionTestState.storageProbeError = '需要先进入一个可保存 metadata 的聊天，并确保扩展设置已就绪。';
    return;
  }

  const settings = getGlobalSettings();
  const chatState = getChatState();
  const globalSnapshot = cloneData(settings.modules?.affection || {});
  const chatSnapshot = cloneData(chatState.affectionSystem || {});
  const probeKey = `settings-probe:${Date.now()}`;
  let readback = null;
  let probeError = null;
  let restored = false;

  try {
    settings.modules.affection = {
      enabled: true,
      mode: 'normal',
      defaultBuildMode: 'generic',
      profileBuildApiMode: 'main_api',
    };
    const system = getAffectionSystemState(chatState);
    system.buildTasks[probeKey] = { status: 'probe', probeKey };
    saveGlobalSettings();
    saveChatState();

    const readSettings = getAffectionSettings(getGlobalSettings());
    const readSystem = getAffectionSystemState(getChatState());
    readback = {
      settings: cloneData(readSettings),
      buildTask: cloneData(readSystem.buildTasks[probeKey] || null),
    };
    assertTest(readSettings.enabled === true, '全局 enabled 未读回。');
    assertTest(readSettings.defaultBuildMode === 'generic', '全局建档模式未读回。');
    assertTest(readSettings.profileBuildApiMode === 'main_api', '全局建档 API 模式未读回。');
    assertTest(readSystem.buildTasks[probeKey]?.probeKey === probeKey, '聊天 metadata 探针未读回。');
  } catch (error) {
    probeError = error;
  } finally {
    try {
      settings.modules.affection = globalSnapshot;
      chatState.affectionSystem = chatSnapshot;
      saveGlobalSettings();
      saveChatState();
      restored = true;
    } catch (restoreError) {
      probeError = probeError || restoreError;
    }
  }

  affectionTestState.storageProbeResult = {
    probeKey,
    readback,
    restored,
    note: restored ? '原全局设置与当前聊天好感状态已恢复。' : '恢复未完成，请查看错误。',
  };
  affectionTestState.storageProbeStatus = !probeError && restored ? 'passed' : 'failed';
  affectionTestState.storageProbeError = probeError?.message || String(probeError || '');
}

function renderJsonResult(result, error, emptyText) {
  if (error) return `<div class="slx-affection-test-error">${escapeHtml(error)}</div>`;
  if (!result) return `<div class="slx-affection-test-empty">${escapeHtml(emptyText)}</div>`;
  return `<pre class="slx-affection-test-output">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
}

function renderSuiteResults(results = []) {
  if (!results.length) {
    return '<div class="slx-affection-test-empty">尚未运行。点击上方按钮后会逐项显示通过或失败原因。</div>';
  }

  return `
    <ul class="slx-affection-test-list">
      ${results.map(item => `
        <li class="is-${escapeHtml(item.status)}">
          <span class="slx-affection-test-mark">${item.status === 'passed' ? '✓' : '×'}</span>
          <span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></span>
        </li>
      `).join('')}
    </ul>
  `;
}

function getTestStatusLabel(status, passedCount = 0, totalCount = 0) {
  if (status === 'passed') return totalCount ? `全部通过（${passedCount}/${totalCount}）` : '通过';
  if (status === 'failed') return totalCount ? `存在失败（${passedCount}/${totalCount}）` : '失败';
  return '等待测试';
}

export function renderAffectionPanel() {
  const passedCount = affectionTestState.suiteResults.filter(item => item.status === 'passed').length;
  const totalCount = affectionTestState.suiteResults.length;
  const suiteLabel = getTestStatusLabel(affectionTestState.suiteStatus, passedCount, totalCount);
  const settingsPassedCount = affectionTestState.settingsSuiteResults.filter(item => item.status === 'passed').length;
  const settingsTotalCount = affectionTestState.settingsSuiteResults.length;
  const settingsSuiteLabel = getTestStatusLabel(
    affectionTestState.settingsSuiteStatus,
    settingsPassedCount,
    settingsTotalCount,
  );

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
          ${renderSuiteResults(affectionTestState.suiteResults)}
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

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="settingsSuite" ${affectionTestState.expandedSections.settingsSuite ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>开发期测试区</small>
            <b>第 2 步 · 设置、聊天态与角色名键</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.settingsSuiteStatus)}">${escapeHtml(settingsSuiteLabel)}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>直接向真实 getter 传入页面内存中的模拟对象，检查默认字段、非法枚举、旧草案迁移、损坏容器和角色名键。不会读取或修改当前聊天。</p>
          <div class="slx-action-row">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-settings-suite>运行第 2 步全部检查</button>
          </div>
          ${renderSuiteResults(affectionTestState.settingsSuiteResults)}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="settingsMigration" ${affectionTestState.expandedSections.settingsMigration ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>自定义模拟 C</small>
            <b>坏数据迁移预览</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.settingsMigrationStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.settingsMigrationStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <p>输入含 globalSettings 与 chatState 的 JSON。预览直接调用真实 getter，但只处理当前页面内存中的副本。</p>
          <label class="slx-field slx-field-wide">
            <span>模拟坏数据 JSON</span>
            <textarea data-slx-affection-settings-migration-input spellcheck="false">${escapeHtml(affectionTestState.settingsMigrationInput)}</textarea>
          </label>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-settings-migration>预览迁移结果</button>
          </div>
          ${renderJsonResult(affectionTestState.settingsMigrationResult, affectionTestState.settingsMigrationError, '运行后显示规范化设置、聊天态字段与 profile key。')}
        </div>
      </details>

      <details class="slx-detail-card slx-affection-test-section" data-slx-affection-test-section="storageProbe" ${affectionTestState.expandedSections.storageProbe ? 'open' : ''}>
        <summary class="slx-affection-test-heading">
          <span class="slx-affection-test-title">
            <small>显式存储探针</small>
            <b>真实设置与 metadata 写入、读回、恢复</b>
          </span>
          <span class="slx-affection-test-summary-side">
            <span class="slx-affection-test-status is-${escapeHtml(affectionTestState.storageProbeStatus)}">${escapeHtml(getTestStatusLabel(affectionTestState.storageProbeStatus))}</span>
            <span class="slx-affection-test-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="slx-affection-test-body">
          <div class="slx-affection-test-warning">此按钮会短暂写入当前全局好感设置和当前聊天 metadata，读回后立即用快照恢复。请只在可正常保存的测试聊天中运行。</div>
          <div class="slx-action-row slx-affection-test-single-action">
            <button class="slx-soft-btn" type="button" data-slx-affection-run-storage-probe>写入 → 读回 → 恢复</button>
          </div>
          ${renderJsonResult(affectionTestState.storageProbeResult, affectionTestState.storageProbeError, '等待用户显式运行。不会自动触发。')}
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
  affectionTestState.settingsMigrationInput = panelRoot.querySelector('[data-slx-affection-settings-migration-input]')?.value
    ?? affectionTestState.settingsMigrationInput;
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

  panelRoot.querySelector('[data-slx-affection-run-settings-suite]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionSettingsSuite();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-settings-migration]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runSettingsMigrationPreview();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-run-storage-probe]')?.addEventListener('click', () => {
    syncAffectionTestInputs(panelRoot);
    runAffectionStorageProbe();
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-affection-reset-tests]')?.addEventListener('click', () => {
    affectionTestState = createDefaultTestState();
    refreshPanel();
  });
}
