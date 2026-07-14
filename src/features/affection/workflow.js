import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  getAffectionSettings,
  getAffectionSystemState,
  getChatState,
  getGlobalSettings,
  getSummarySettings,
  saveChatState,
} from '../../core/settings.js';
import {
  getMemoryField,
  getMemoryFields,
  normalizeMemoryBlock,
} from '../../core/summary.js';
import { getMessageContentFingerprint } from '../../core/message-fingerprint.js';
import { buildAffectionUpdatePromptSection as buildAffectionUpdatePromptSectionText } from '../../prompts.js';
import {
  clampAffectionValueTenths,
  formatAffectionDeltaTenths,
  formatAffectionValueTenths,
  normalizeAffectionChanges,
  normalizeAffectionFirstEntries,
  recalculateAffectionLedger,
} from './model.js';

function parseRawPipeEntry(value, valueKey) {
  const parts = String(value || '').split('|').map(part => part.trim());
  return {
    roleName: parts[0] || '',
    [valueKey]: parts[1] || '',
    extraParts: parts.slice(2),
  };
}

function getMemoryLineKey(line) {
  return String(line || '').match(/^\s*\[([A-Za-z][\w-]*)\s*:/)?.[1]?.toLowerCase() || '';
}

function buildNormalizedAffectionLines(changes) {
  return changes.map(item => (
    `[affection:${item.roleName}|${formatAffectionDeltaTenths(item.deltaTenths)}|${formatAffectionValueTenths(item.valueAfterTenths)}]`
  ));
}

function buildNormalizedFirstLines(firsts) {
  return firsts.map(item => (
    `[affection_first:${item.roleName}|${formatAffectionValueTenths(item.initialValueTenths)}]`
  ));
}

export function rewriteAffectionMemoryFields(memoryText, { changes = [], firsts = [] } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const lines = memory.split(/\r?\n/);
  const filteredLines = lines.filter(line => {
    const key = getMemoryLineKey(line);
    return key !== 'affection' && key !== 'affection_first';
  });
  const normalizedLines = [
    ...buildNormalizedAffectionLines(Array.isArray(changes) ? changes : []),
    ...buildNormalizedFirstLines(Array.isArray(firsts) ? firsts : []),
  ];
  if (!normalizedLines.length) return filteredLines.join('\n');

  const progressIndex = filteredLines.findIndex(line => getMemoryLineKey(line) === 'progress');
  const closingIndex = filteredLines.findIndex(line => /^\s*<\/memory>\s*$/i.test(line));
  const boundaryIndex = progressIndex >= 0
    ? progressIndex
    : closingIndex >= 0
      ? closingIndex
      : filteredLines.length;
  let insertionIndex = boundaryIndex;
  for (let index = 0; index < boundaryIndex; index += 1) {
    const key = getMemoryLineKey(filteredLines[index]);
    if (key === 'emotion' || key === 'emotion_changed' || key === 'affection_changed') {
      insertionIndex = index + 1;
    }
  }

  filteredLines.splice(insertionIndex, 0, ...normalizedLines);
  return filteredLines.join('\n');
}

function getProfileCurrentValueTenths(profile) {
  if (!isPlainObject(profile)) return null;
  return recalculateAffectionLedger(
    profile.initialValueTenths,
    Array.isArray(profile.records) ? profile.records : [],
  ).valueTenths;
}

export function buildKnownAffectionText(profiles = {}) {
  const lines = Object.entries(isPlainObject(profiles) ? profiles : {})
    .filter(([, profile]) => isPlainObject(profile))
    .map(([storedRoleName, profile]) => {
      const roleName = String(profile.roleName || storedRoleName || '').trim();
      if (!roleName) return '';
      const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
      const recent = ledger.records.slice(-3).map(record => {
        const source = record.sourceMessageId === null || record.sourceMessageId === undefined
          ? '手动调整'
          : `第${record.sourceMessageId}楼`;
        const deltaTenths = Number(record.deltaTenths);
        const deltaValue = Number.isInteger(deltaTenths) ? (deltaTenths / 10).toFixed(1) : '0.0';
        const delta = deltaTenths > 0 ? `+${deltaValue}` : deltaValue;
        return `${source}${delta}→${formatAffectionValueTenths(record.valueAfterTenths)}`;
      });
      return `【${roleName}】已建档，当前好感 ${formatAffectionValueTenths(ledger.valueTenths)}/100${recent.length ? `；近期：${recent.join('、')}` : '；暂无正式变化记录'}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : '暂无已建档角色。';
}

export function isAffectionAnalysisActive(settings = getGlobalSettings()) {
  const affection = getAffectionSettings(settings);
  const summary = getSummarySettings(settings);
  return Boolean(
    settings?.enabled === true
    && summary.enabled === true
    && affection.enabled === true
    && affection.mode === 'normal'
  );
}

export function buildAffectionUpdatePromptSection(
  settings = getGlobalSettings(),
  chatState = getChatState(),
) {
  if (!isAffectionAnalysisActive(settings)) return '';
  const store = getAffectionSystemState(chatState);
  return buildAffectionUpdatePromptSectionText({
    knownAffectionText: buildKnownAffectionText(store.profiles),
  });
}

export function parseAffectionUpdateFromMemory(memoryText, { profiles = {} } = {}) {
  const memory = normalizeMemoryBlock(memoryText);
  const rawAffectionValues = getMemoryFields(memory, 'affection');
  const rawFirstValues = getMemoryFields(memory, 'affection_first');
  if (!rawAffectionValues.length && !rawFirstValues.length) return null;

  const diagnostics = [];

  const rawAffectionEntries = rawAffectionValues.map((value, index) => {
    const entry = parseRawPipeEntry(value, 'delta');
    if (entry.extraParts.length) {
      diagnostics.push({
        code: 'ignored_ai_value_after',
        index,
        roleName: entry.roleName,
        value: entry.extraParts.join('|'),
        message: 'AI 异常输出了 affection 第三段，已忽略并由账本重算。',
      });
    }
    return entry;
  });
  const rawFirstEntries = rawFirstValues.map((value, index) => {
    const entry = parseRawPipeEntry(value, 'initialValue');
    if (entry.extraParts.length) {
      diagnostics.push({
        code: 'first_extra_fields',
        index,
        roleName: entry.roleName,
        message: 'affection_first 只允许角色名与初始好感两段，多余字段已忽略。',
      });
    }
    return entry;
  });

  const normalizedChanges = normalizeAffectionChanges({
    entries: rawAffectionEntries,
  });
  const normalizedFirsts = normalizeAffectionFirstEntries({
    entries: rawFirstEntries,
    existingRoleNames: Object.keys(isPlainObject(profiles) ? profiles : {}),
  });
  diagnostics.push(...normalizedChanges.diagnostics, ...normalizedFirsts.diagnostics);

  const firstByRoleName = new Map(
    normalizedFirsts.items.map(item => [item.roleName, item]),
  );
  const changes = normalizedChanges.items.flatMap(item => {
    const profile = isPlainObject(profiles?.[item.roleName]) ? profiles[item.roleName] : null;
    const first = firstByRoleName.get(item.roleName);
    if (!profile && !first) {
      diagnostics.push({
        code: 'change_without_profile_or_first',
        roleName: item.roleName,
        message: `「${item.roleName}」尚未建档且本轮没有合法 affection_first，无法计算当前好感，已拒绝该 affection。`,
      });
      return [];
    }

    if (first) {
      diagnostics.push({
        code: 'first_suppresses_same_turn_change',
        roleName: item.roleName,
        message: `「${item.roleName}」本轮为首次建档，affection_first 已表示楼层结束后的初始好感；同角色 affection 已忽略。`,
      });
      return [];
    }

    const valueBeforeTenths = getProfileCurrentValueTenths(profile);
    return [{
      ...item,
      valueBeforeTenths,
      valueAfterTenths: clampAffectionValueTenths(valueBeforeTenths + item.deltaTenths),
    }];
  });

  const changed = changes.some(item => item.deltaTenths !== 0);
  if (
    normalizedChanges.changed
    && !changed
    && !diagnostics.some(item => item.code === 'first_suppresses_same_turn_change')
  ) {
    diagnostics.push({
      code: 'no_resolvable_change',
      message: '本轮没有可计算当前值的 affection，已规范化为无变化。',
    });
  }
  const firsts = normalizedFirsts.items;
  const normalizedMemory = rewriteAffectionMemoryFields(memory, { changes, firsts });

  return {
    changed,
    changes,
    firsts,
    diagnostics,
    raw: {
      affection: rawAffectionValues,
      affectionFirst: rawFirstValues,
    },
    normalizedMemory,
  };
}

export function storePendingAffectionUpdate(
  { messageId, fingerprint, analysis } = {},
  { chatState = getChatState(), persist = true } = {},
) {
  const numericMessageId = Number(messageId);
  const cleanFingerprint = String(fingerprint || '').trim();
  if (!Number.isInteger(numericMessageId) || numericMessageId < 0 || !cleanFingerprint || !analysis) {
    return null;
  }

  const store = getAffectionSystemState(chatState);
  const messageKey = String(numericMessageId);
  const existingBucket = isPlainObject(store.pendingByMessage[messageKey])
    ? store.pendingByMessage[messageKey]
    : {};
  const items = isPlainObject(existingBucket.items) ? existingBucket.items : {};
  const updatedAt = formatTimestamp();
  const pending = {
    messageId: numericMessageId,
    fingerprint: cleanFingerprint,
    changed: analysis.changed === true,
    changes: Array.isArray(analysis.changes) ? analysis.changes.map(item => ({ ...item })) : [],
    firsts: Array.isArray(analysis.firsts) ? analysis.firsts.map(item => ({ ...item })) : [],
    diagnostics: Array.isArray(analysis.diagnostics) ? analysis.diagnostics.map(item => ({ ...item })) : [],
    raw: isPlainObject(analysis.raw) ? { ...analysis.raw } : {},
    updatedAt,
  };
  items[cleanFingerprint] = pending;
  store.pendingByMessage[messageKey] = {
    messageId: numericMessageId,
    items,
    updatedAt,
  };
  if (persist) saveChatState();
  return pending;
}

export function prepareAffectionUpdateFromSummaryResult(
  result,
  {
    settings = getGlobalSettings(),
    chatState = getChatState(),
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const store = getAffectionSystemState(chatState);
  return parseAffectionUpdateFromMemory(result, { profiles: store.profiles });
}

export function processAffectionUpdateFromSummaryResult(
  result,
  {
    messageId,
    analysis = null,
    settings = getGlobalSettings(),
    chatState = getChatState(),
    persist = true,
  } = {},
) {
  if (!isAffectionAnalysisActive(settings)) return null;
  const prepared = analysis || prepareAffectionUpdateFromSummaryResult(result, { settings, chatState });
  if (!prepared) {
    console.warn('[蜃灵助手] 本轮小总结未返回 affection / affection_first，已跳过好感 pending。');
    return null;
  }
  const fingerprint = getMessageContentFingerprint(messageId, settings);
  if (!fingerprint) return { ...prepared, pending: null, fingerprint: '' };
  const pending = storePendingAffectionUpdate(
    { messageId, fingerprint, analysis: prepared },
    { chatState, persist },
  );
  return { ...prepared, pending, fingerprint };
}
