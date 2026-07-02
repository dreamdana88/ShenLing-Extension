import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';

const VALID_MOVEMENT_STATUS = new Set(['pending', 'active', 'engaged', 'done']);

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function normalizeScheduleEntryOption(option, index = 0) {
  const text = cleanText(isPlainObject(option) ? option.text || option.summary : option);
  if (!text) return null;
  return {
    id: `E${index + 1}`,
    text,
  };
}

export function normalizeScheduleMovement(movement, index = 0, options = {}) {
  const source = isPlainObject(movement) ? movement : {};
  const summary = cleanText(source.summary);
  const character = cleanText(source.character);
  if (!summary && !character) return null;
  const rawStatus = cleanText(source.status);
  return {
    id: `M${index + 1}`,
    character,
    location: cleanText(source.location),
    summary,
    startsAt: cleanText(source.startsAt),
    durationMinutes: normalizeNonNegativeInteger(source.durationMinutes),
    status: options.forcePending ? 'pending' : (VALID_MOVEMENT_STATUS.has(rawStatus) ? rawStatus : 'pending'),
    mainlineImpact: cleanText(source.mainlineImpact),
  };
}

export function normalizeScheduleDay(day, index = 0, options = {}) {
  const source = isPlainObject(day) ? day : {};
  const entryOptions = (Array.isArray(source.entryOptions) ? source.entryOptions : [])
    .map(normalizeScheduleEntryOption)
    .filter(Boolean)
    .slice(0, 3)
    .map((option, optionIndex) => ({ ...option, id: `E${optionIndex + 1}` }));
  const characterMovements = (Array.isArray(source.characterMovements) ? source.characterMovements : [])
    .map((movement, movementIndex) => normalizeScheduleMovement(movement, movementIndex, {
      forcePending: Boolean(options.forcePending),
    }))
    .filter(Boolean)
    .slice(0, 3)
    .map((movement, movementIndex) => ({ ...movement, id: `M${movementIndex + 1}` }));

  return {
    day: index + 1,
    theme: cleanText(source.theme || source.label) || `第${index + 1}天`,
    mainOpportunity: cleanText(source.mainOpportunity),
    entryOptions,
    characterMovements,
  };
}

export function normalizeScheduleResult(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('生成结果不是有效的日程表 JSON 对象。');
  }
  const rawDays = Array.isArray(raw.days) ? raw.days : [];
  if (!rawDays.length) {
    throw new Error('生成结果中没有日程天数。');
  }
  const timestamp = formatTimestamp();
  return {
    title: cleanText(raw.title) || '七日剧情机会表',
    days: Array.from({ length: 7 }, (_, index) => normalizeScheduleDay(rawDays[index], index, { forcePending: true })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeScheduleCurrent(current) {
  if (!isPlainObject(current) || !Array.isArray(current.days)) return null;
  const rawDays = current.days.filter(day => isPlainObject(day)).slice(0, 7);
  if (!rawDays.length) return null;
  return {
    ...current,
    title: cleanText(current.title) || '当前日程表',
    days: rawDays.map((day, index) => normalizeScheduleDay(day, index)),
    createdAt: cleanText(current.createdAt),
    updatedAt: cleanText(current.updatedAt),
  };
}
