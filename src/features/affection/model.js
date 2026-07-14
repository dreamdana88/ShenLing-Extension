const MIN_VALUE_TENTHS = 0;
const MAX_VALUE_TENTHS = 1000;
const ALLOWED_DELTA_TENTHS = new Set([-3, -2, -1, 1, 2, 3]);

export const AFFECTION_VALUE_MIN_TENTHS = MIN_VALUE_TENTHS;
export const AFFECTION_VALUE_MAX_TENTHS = MAX_VALUE_TENTHS;
export const AFFECTION_ALLOWED_DELTA_TENTHS = Object.freeze([...ALLOWED_DELTA_TENTHS]);
export const AFFECTION_STAGE_RANGES = Object.freeze([
  Object.freeze({ stageId: 'S1', minTenths: 0, maxTenths: 200 }),
  Object.freeze({ stageId: 'S2', minTenths: 201, maxTenths: 400 }),
  Object.freeze({ stageId: 'S3', minTenths: 401, maxTenths: 600 }),
  Object.freeze({ stageId: 'S4', minTenths: 601, maxTenths: 800 }),
  Object.freeze({ stageId: 'S5', minTenths: 801, maxTenths: 1000 }),
]);

function clampTenths(value) {
  return Math.min(MAX_VALUE_TENTHS, Math.max(MIN_VALUE_TENTHS, value));
}

function parseBooleanFlag(value) {
  if (value === true) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeStoredValueTenths(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return clampTenths(Math.round(Number(fallback) || 0));
  return clampTenths(Math.round(number));
}

function normalizeRecordMessageId(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function getRecordSortMessageId(record) {
  const messageId = normalizeRecordMessageId(record?.sourceMessageId);
  return messageId === null ? Number.MAX_SAFE_INTEGER : messageId;
}

function compareAffectionRecords(left, right) {
  const messageDifference = getRecordSortMessageId(left.record) - getRecordSortMessageId(right.record);
  if (messageDifference !== 0) return messageDifference;

  const createdAtDifference = String(left.record?.createdAt || '')
    .localeCompare(String(right.record?.createdAt || ''));
  if (createdAtDifference !== 0) return createdAtDifference;

  const sourceTypeDifference = Number(left.record?.sourceType === 'manual_adjustment')
    - Number(right.record?.sourceType === 'manual_adjustment');
  if (sourceTypeDifference !== 0) return sourceTypeDifference;

  const recordIdDifference = String(left.record?.recordId || '')
    .localeCompare(String(right.record?.recordId || ''));
  return recordIdDifference || left.index - right.index;
}

function normalizeChangeEntry(entry) {
  if (Array.isArray(entry)) {
    return { roleName: entry[0], delta: entry[1] };
  }
  if (entry && typeof entry === 'object') {
    return {
      roleName: entry.roleName ?? entry.name ?? entry.character,
      delta: entry.deltaTenths !== undefined ? Number(entry.deltaTenths) / 10 : entry.delta,
    };
  }
  const [roleName = '', delta = ''] = String(entry ?? '').split('|');
  return { roleName, delta };
}

function normalizeFirstEntry(entry) {
  if (Array.isArray(entry)) {
    return { roleName: entry[0], initialValue: entry[1] };
  }
  if (entry && typeof entry === 'object') {
    return {
      roleName: entry.roleName ?? entry.name ?? entry.character,
      initialValue: entry.initialValueTenths !== undefined
        ? Number(entry.initialValueTenths) / 10
        : entry.initialAffection ?? entry.initialValue ?? entry.value,
    };
  }
  const [roleName = '', initialValue = ''] = String(entry ?? '').split('|');
  return { roleName, initialValue };
}

export function normalizeAffectionRoleName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1');
}

export function parseAffectionDeltaTenths(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  const tenths = Math.round(number * 10);
  if (Math.abs(number * 10 - tenths) > Number.EPSILON * 10) return null;
  return ALLOWED_DELTA_TENTHS.has(tenths) ? tenths : null;
}

export function parseAffectionValueTenths(value, { clamp = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  const tenths = Math.round(number * 10);
  if (Math.abs(number * 10 - tenths) > Number.EPSILON * 10) return null;
  if (clamp) return clampTenths(tenths);
  return tenths >= MIN_VALUE_TENTHS && tenths <= MAX_VALUE_TENTHS ? tenths : null;
}

export function clampAffectionValueTenths(valueTenths) {
  return normalizeStoredValueTenths(valueTenths);
}

export function formatAffectionValueTenths(valueTenths) {
  return (normalizeStoredValueTenths(valueTenths) / 10).toFixed(1);
}

export function formatAffectionDeltaTenths(deltaTenths) {
  const value = Number(deltaTenths);
  return Number.isInteger(value) && ALLOWED_DELTA_TENTHS.has(value)
    ? (value / 10).toFixed(1)
    : '';
}

export function normalizeAffectionChanges({ changed, entries = [] } = {}) {
  const gateOpen = parseBooleanFlag(changed);
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const diagnostics = [];

  if (!gateOpen) {
    if (sourceEntries.length) {
      diagnostics.push({
        code: 'gate_closed',
        message: 'affection_changed 不是 true，已忽略本轮 affection 行。',
      });
    }
    return { changed: false, items: [], diagnostics };
  }

  const seenRoleNames = new Set();
  const items = [];

  sourceEntries.forEach((rawEntry, index) => {
    const entry = normalizeChangeEntry(rawEntry);
    const roleName = normalizeAffectionRoleName(entry.roleName);
    if (!roleName) {
      diagnostics.push({
        code: 'missing_role_name',
        index,
        message: 'affection 行缺少角色名，已拒绝。',
      });
      return;
    }

    const deltaTenths = parseAffectionDeltaTenths(entry.delta);
    if (deltaTenths === null) {
      diagnostics.push({
        code: 'invalid_delta',
        index,
        roleName,
        value: entry.delta,
        message: `「${roleName}」的好感变化值不在允许范围内，已拒绝。`,
      });
      return;
    }

    if (seenRoleNames.has(roleName)) {
      diagnostics.push({
        code: 'duplicate_role',
        index,
        roleName,
        message: `「${roleName}」在同一轮重复出现，已保留第一条合法变化。`,
      });
      return;
    }

    seenRoleNames.add(roleName);
    items.push({ roleName, deltaTenths });
  });

  if (!items.length) {
    diagnostics.push({
      code: 'no_valid_delta',
      message: 'affection_changed 为 true，但没有合法的非零 affection 变化，已规范化为无变化。',
    });
  }

  return {
    changed: items.length > 0,
    items,
    diagnostics,
  };
}

export function normalizeAffectionFirstEntries({ entries = [], existingRoleNames = [] } = {}) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const existing = new Set(
    (Array.isArray(existingRoleNames) ? existingRoleNames : [])
      .map(normalizeAffectionRoleName)
      .filter(Boolean),
  );
  const seenRoleNames = new Set();
  const items = [];
  const diagnostics = [];

  sourceEntries.forEach((rawEntry, index) => {
    const entry = normalizeFirstEntry(rawEntry);
    const roleName = normalizeAffectionRoleName(entry.roleName);
    if (!roleName) {
      diagnostics.push({
        code: 'first_missing_role_name',
        index,
        message: 'affection_first 行缺少角色名，已拒绝。',
      });
      return;
    }
    if (existing.has(roleName)) {
      diagnostics.push({
        code: 'first_already_profiled',
        index,
        roleName,
        message: `「${roleName}」已有正式好感档案，已忽略 affection_first。`,
      });
      return;
    }
    const initialValueTenths = parseAffectionValueTenths(entry.initialValue);
    if (initialValueTenths === null) {
      diagnostics.push({
        code: 'first_invalid_initial_value',
        index,
        roleName,
        value: entry.initialValue,
        message: `「${roleName}」的首次好感必须是 0—100、最多一位小数，已拒绝。`,
      });
      return;
    }
    if (seenRoleNames.has(roleName)) {
      diagnostics.push({
        code: 'first_duplicate_role',
        index,
        roleName,
        message: `「${roleName}」在同一轮重复出现 affection_first，已保留第一条合法值。`,
      });
      return;
    }

    seenRoleNames.add(roleName);
    items.push({ roleName, initialValueTenths });
  });

  return { items, diagnostics };
}

export function getStageForValueTenths(valueTenths, stages = []) {
  const value = normalizeStoredValueTenths(valueTenths);
  const stageIndex = AFFECTION_STAGE_RANGES.findIndex(range => (
    value >= range.minTenths && value <= range.maxTenths
  ));
  const range = AFFECTION_STAGE_RANGES[stageIndex] || AFFECTION_STAGE_RANGES[0];
  const stage = Array.isArray(stages) && stages[stageIndex] && typeof stages[stageIndex] === 'object'
    ? stages[stageIndex]
    : {};
  return {
    ...stage,
    stageId: range.stageId,
    minTenths: range.minTenths,
    maxTenths: range.maxTenths,
  };
}

export function sortAffectionRecords(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record && typeof record === 'object')
    .sort(compareAffectionRecords)
    .map(({ record }) => ({ ...record }));
}

export function recalculateAffectionLedger(initialValueTenths, records = []) {
  const initialValue = normalizeStoredValueTenths(initialValueTenths);
  let valueTenths = initialValue;
  const normalizedRecords = [];
  const diagnostics = [];

  sortAffectionRecords(records).forEach((record, index) => {
    const deltaTenths = Number(record.deltaTenths);
    if (!Number.isInteger(deltaTenths)) {
      diagnostics.push({
        code: 'invalid_record_delta',
        index,
        recordId: String(record.recordId || ''),
        message: '账本记录的 deltaTenths 不是整数，已跳过。',
      });
      return;
    }

    const valueBeforeTenths = valueTenths;
    valueTenths = clampTenths(valueBeforeTenths + deltaTenths);
    normalizedRecords.push({
      ...record,
      sourceMessageId: normalizeRecordMessageId(record.sourceMessageId),
      deltaTenths,
      valueBeforeTenths,
      valueAfterTenths: valueTenths,
    });
  });

  return {
    initialValueTenths: initialValue,
    valueTenths,
    records: normalizedRecords,
    diagnostics,
  };
}

export function replaceAffectionRecord(records = [], nextRecord = {}) {
  if (!nextRecord || typeof nextRecord !== 'object') {
    return sortAffectionRecords(records);
  }
  const nextDeltaTenths = Number(nextRecord.deltaTenths);
  if (!Number.isInteger(nextDeltaTenths)) {
    return sortAffectionRecords(records);
  }

  const sourceMessageId = normalizeRecordMessageId(nextRecord.sourceMessageId);
  const recordId = String(nextRecord.recordId || '').trim();
  const filteredRecords = (Array.isArray(records) ? records : []).filter(record => {
    if (!record || typeof record !== 'object') return false;
    if (recordId && String(record.recordId || '') === recordId) return false;
    if (sourceMessageId !== null) {
      const sameMessage = normalizeRecordMessageId(record.sourceMessageId) === sourceMessageId;
      const bothAutomatic = record.sourceType !== 'manual_adjustment'
        && nextRecord.sourceType !== 'manual_adjustment';
      return !(sameMessage && bothAutomatic);
    }
    return true;
  });

  return sortAffectionRecords([
    ...filteredRecords,
    {
      ...nextRecord,
      sourceMessageId,
      deltaTenths: nextDeltaTenths,
    },
  ]);
}

export function upsertAffectionRecord(initialValueTenths, records, nextRecord) {
  return recalculateAffectionLedger(
    initialValueTenths,
    replaceAffectionRecord(records, nextRecord),
  );
}

export function createManualAffectionAdjustmentRecord({
  initialValueTenths,
  records = [],
  targetValueTenths,
  recordId = '',
  sourceMessageId = null,
  sourceFingerprint = '',
  createdAt = '',
} = {}) {
  const ledger = recalculateAffectionLedger(initialValueTenths, records);
  const targetNumber = Number(targetValueTenths);
  if (!Number.isInteger(targetNumber)) return null;
  const targetValue = clampTenths(targetNumber);
  const deltaTenths = targetValue - ledger.valueTenths;
  if (deltaTenths === 0) return null;

  return {
    recordId: String(recordId || `manual:${createdAt || 'pending'}:${ledger.records.length + 1}`),
    sourceMessageId: normalizeRecordMessageId(sourceMessageId),
    sourceFingerprint: String(sourceFingerprint || ''),
    deltaTenths,
    valueBeforeTenths: ledger.valueTenths,
    valueAfterTenths: targetValue,
    sourceType: 'manual_adjustment',
    createdAt: String(createdAt || ''),
    updatedAt: String(createdAt || ''),
  };
}
