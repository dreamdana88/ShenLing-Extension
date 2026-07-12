// 设定采集持久化状态模型。保持纯数据职责，不读取 DOM、设置或世界书 API。

export const CAPTURE_TYPES = Object.freeze(['auto', 'npc', 'item', 'location', 'other']);
export const CAPTURE_SOURCE_MODES = Object.freeze(['recent_chat', 'floor_range', 'grand_plus_after']);
export const CAPTURE_POSITIONS = Object.freeze([
  'before_character_definition',
  'after_character_definition',
]);

const DRAFT_TYPES = CAPTURE_TYPES.filter(type => type !== 'auto');
const DEFAULT_RECENT_COUNT = 20;
const DEFAULT_ORDER = 100;

export function createDefaultCaptureState() {
  return {
    request: '',
    requestedType: 'auto',
    source: {
      mode: 'recent_chat',
      recentCount: DEFAULT_RECENT_COUNT,
      fromFloor: null,
      toFloor: null,
      summaryId: null,
    },
    optionalContext: {
      includeCharacterCard: false,
      includePersona: false,
      worldbookRefs: [],
    },
    drafts: [],
    lastError: '',
  };
}

export function createCaptureId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `capture-${globalThis.crypto.randomUUID()}`;
    }
  } catch {}
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 12) || 'fallback';
  return `capture-${time}-${random}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCaptureId(value) {
  return typeof value === 'string'
    && /^capture-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function normalizeFiniteInteger(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalizeFloor(value) {
  const number = normalizeFiniteInteger(value, null);
  return number !== null && number >= 0 ? number : null;
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
}

function normalizeWorldbookRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const refs = [];
  value.forEach((item) => {
    if (!isPlainObject(item)) return;
    const worldbookName = String(item.worldbookName ?? '').trim();
    const uid = normalizeFiniteInteger(item.uid, null);
    if (!worldbookName || uid === null || uid < 0) return;
    const key = `${worldbookName}\u0000${uid}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      worldbookName,
      uid,
      entryNameSnapshot: String(item.entryNameSnapshot ?? '').trim(),
    });
  });
  return refs;
}

export function normalizeCaptureDraft(value) {
  const draft = isPlainObject(value) ? value : {};
  const type = DRAFT_TYPES.includes(draft.type) ? draft.type : 'other';
  const position = CAPTURE_POSITIONS.includes(draft.position)
    ? draft.position
    : 'after_character_definition';
  return {
    captureId: isCaptureId(draft.captureId) ? draft.captureId : createCaptureId(),
    type,
    title: String(draft.title ?? '').trim(),
    mainKeywords: normalizeKeywords(draft.mainKeywords),
    filterKeywords: normalizeKeywords(draft.filterKeywords),
    content: String(draft.content ?? '').trim(),
    position,
    order: normalizeFiniteInteger(draft.order, DEFAULT_ORDER),
  };
}

export function normalizeCaptureState(value) {
  const state = isPlainObject(value) ? value : {};
  const source = isPlainObject(state.source) ? state.source : {};
  const optionalContext = isPlainObject(state.optionalContext) ? state.optionalContext : {};
  const recentCount = normalizeFiniteInteger(source.recentCount, DEFAULT_RECENT_COUNT);
  return {
    request: String(state.request ?? ''),
    requestedType: CAPTURE_TYPES.includes(state.requestedType) ? state.requestedType : 'auto',
    source: {
      mode: CAPTURE_SOURCE_MODES.includes(source.mode) ? source.mode : 'recent_chat',
      recentCount: Math.min(200, Math.max(5, recentCount)),
      fromFloor: normalizeFloor(source.fromFloor),
      toFloor: normalizeFloor(source.toFloor),
      summaryId: typeof source.summaryId === 'string' ? source.summaryId : null,
    },
    optionalContext: {
      includeCharacterCard: optionalContext.includeCharacterCard === true,
      includePersona: optionalContext.includePersona === true,
      worldbookRefs: normalizeWorldbookRefs(optionalContext.worldbookRefs),
    },
    drafts: Array.isArray(state.drafts) ? state.drafts.map(normalizeCaptureDraft) : [],
    lastError: String(state.lastError ?? ''),
  };
}

export function appendCaptureDrafts(existing, incoming) {
  const current = Array.isArray(existing) ? existing.map(normalizeCaptureDraft) : [];
  const knownIds = new Set(current.map(draft => draft.captureId));
  const additions = [];
  (Array.isArray(incoming) ? incoming : []).forEach((value) => {
    const draft = normalizeCaptureDraft(value);
    if (knownIds.has(draft.captureId)) return;
    knownIds.add(draft.captureId);
    additions.push(draft);
  });
  return [...current, ...additions];
}

export function removeCaptureDrafts(existing, captureIds) {
  const ids = captureIds instanceof Set
    ? captureIds
    : new Set(Array.isArray(captureIds) ? captureIds : []);
  return (Array.isArray(existing) ? existing : [])
    .map(normalizeCaptureDraft)
    .filter(draft => !ids.has(draft.captureId));
}

export function clearCaptureDrafts() {
  return [];
}
