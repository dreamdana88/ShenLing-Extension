// 设定采集主要剧情材料读取与预检。阶段 C 只处理聊天和大总结，不读取可选上下文。

import { GRAND_MEMORY_BLOCK_RE, LIST_BLOCK_RE, MEMORY_BLOCK_RE } from '../../constants.js';
import { getChatMessagesSafe, getContextSafe } from '../../core/chat.js';
import { getChatState, getSummarySettings } from '../../core/settings.js';
import {
  formatCharacterCardForPrompt,
  formatUserPersonaForPrompt,
  getResolvedCharacterCard,
  getUserPersona,
} from '../../core/context-resolver.js';
import { extractSummarySourceContent } from '../../utils/text.js';
import { CAPTURE_SOURCE_MODES } from './capture-model.js';
import { getWorldbookReadApi } from './worldbook-api.js';

export const MAX_CAPTURE_CHAT_MESSAGES = 200;

export const CAPTURE_MATERIAL_ERROR_CODES = Object.freeze({
  INVALID_SOURCE_MODE: 'invalid_source_mode',
  INVALID_FLOOR_RANGE: 'invalid_floor_range',
  FLOOR_OUT_OF_RANGE: 'floor_out_of_range',
  EMPTY_CHAT: 'empty_chat',
  EMPTY_MATERIAL: 'empty_material',
  GRAND_SUMMARY_NOT_FOUND: 'grand_summary_not_found',
  TOO_MANY_MESSAGES: 'too_many_messages',
});

export const CAPTURE_OPTIONAL_ERROR_CODES = Object.freeze({
  CHARACTER_CARD_UNAVAILABLE: 'character_card_unavailable',
  PERSONA_UNAVAILABLE: 'persona_unavailable',
  WORLDBOOK_LIST_FAILED: 'worldbook_list_failed',
  WORLDBOOK_LOAD_FAILED: 'worldbook_load_failed',
  WORLDBOOK_REF_MISSING: 'worldbook_ref_missing',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFloor(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeRecentCount(value) {
  if (value === null || value === undefined || value === '') return 20;
  const number = Number(value);
  if (!Number.isFinite(number)) return 20;
  return Math.min(200, Math.max(5, Math.trunc(number)));
}

function normalizeRole(message) {
  const role = String(message?.role || (message?.is_user ? 'user' : 'assistant')).toLowerCase();
  return role === 'user' || role === 'assistant' ? role : '';
}

function getMessageFloor(message, index = 0) {
  const floor = Number(message?.message_id ?? message?.id ?? index);
  return Number.isFinite(floor) && floor >= 0 ? Math.trunc(floor) : null;
}

function getRawMessageContent(message) {
  return String(message?.message ?? message?.mes ?? message?.content ?? '');
}

function isSystemOrInjectedMessage(message) {
  return message?.is_system === true
    || message?.extra?.is_system === true
    || message?.extra?.isSmallSys === true
    || message?.extra?.isAuthorNote === true
    || message?.extra?.is_author_note === true;
}

function cleanPureChatContent(content, summarySettings) {
  const withoutManagedBlocks = String(content || '')
    .replace(GRAND_MEMORY_BLOCK_RE, '')
    .replace(MEMORY_BLOCK_RE, '')
    .replace(LIST_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return extractSummarySourceContent(withoutManagedBlocks, summarySettings).trim();
}

function resolveSpeaker(message, role, names) {
  const explicitName = String(message?.name ?? '').trim();
  if (explicitName) return explicitName;
  return role === 'user' ? names.userName : names.characterName;
}

function resolveNames(names = {}) {
  const context = getContextSafe();
  return {
    userName: String(names.userName || context?.name1 || context?.user_name || '用户').trim() || '用户',
    characterName: String(names.characterName || context?.name2 || context?.character?.name || '角色').trim() || '角色',
  };
}

/**
 * 从真实聊天楼层中提取纯聊天。隐藏的正常用户/角色楼层仍保留，以支持读取被大总结归档的原始剧情。
 * getChatMessagesSafe 只返回当前选中的 swipe；本函数不会遍历 message.swipes。
 */
export function collectPureChatMessages({ messages, summarySettings, names } = {}) {
  const rawMessages = Array.isArray(messages)
    ? messages
    : getChatMessagesSafe(undefined, { hide_state: 'all' });
  const settings = isPlainObject(summarySettings) ? summarySettings : getSummarySettings();
  const resolvedNames = resolveNames(names);

  return rawMessages
    .map((message, index) => ({ message, floor: getMessageFloor(message, index) }))
    .filter(item => item.floor !== null)
    .sort((a, b) => a.floor - b.floor)
    .flatMap(({ message, floor }) => {
      const role = normalizeRole(message);
      if (!role || isSystemOrInjectedMessage(message)) return [];
      const rawContent = getRawMessageContent(message);
      if (GRAND_MEMORY_BLOCK_RE.test(rawContent)) return [];
      const content = cleanPureChatContent(rawContent, settings);
      if (!content) return [];
      return [{
        floor,
        role,
        speaker: resolveSpeaker(message, role, resolvedNames),
        content,
        characterCount: content.length,
        isHidden: message?.is_hidden === true,
      }];
    });
}

export function formatCaptureChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => `第 ${message.floor} 楼｜${message.speaker}：${message.content}`)
    .join('\n\n');
}

function createStats(messages, material) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    fromFloor: list[0]?.floor ?? null,
    toFloor: list.at(-1)?.floor ?? null,
    floorIds: list.map(message => message.floor),
    messageCount: list.length,
    characterCount: String(material || '').length,
  };
}

function createSuccess(mode, messages, material, extra = {}) {
  return {
    ok: true,
    mode,
    material,
    messages,
    summary: extra.summary || null,
    stats: createStats(messages, material),
    errors: [],
    ...extra,
  };
}

function createFailure(mode, code, message, details = {}) {
  return {
    ok: false,
    mode,
    material: '',
    messages: [],
    summary: null,
    stats: createStats([], ''),
    errors: [{ code, message, details }],
  };
}

function getRawFloorBounds(rawMessages) {
  const floors = (Array.isArray(rawMessages) ? rawMessages : [])
    .map(getMessageFloor)
    .filter(floor => floor !== null);
  return {
    minFloor: floors.length ? Math.min(...floors) : null,
    maxFloor: floors.length ? Math.max(...floors) : null,
  };
}

function resolveRecentChat(source, context) {
  const count = normalizeRecentCount(source.recentCount);
  const selected = context.pureMessages.slice(-count);
  if (!selected.length) {
    return createFailure('recent_chat', CAPTURE_MATERIAL_ERROR_CODES.EMPTY_MATERIAL, '最近聊天中没有可用的纯聊天楼层。');
  }
  const material = formatCaptureChatMessages(selected);
  return createSuccess('recent_chat', selected, material, { requestedCount: count });
}

function resolveFloorRange(source, context) {
  const fromFloor = normalizeFloor(source.fromFloor);
  const toFloor = normalizeFloor(source.toFloor);
  if (fromFloor === null || toFloor === null || fromFloor > toFloor) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.INVALID_FLOOR_RANGE,
      '指定楼层范围无效，请填写非负整数，且起始楼层不能大于结束楼层。',
      { fromFloor: source.fromFloor ?? null, toFloor: source.toFloor ?? null },
    );
  }
  const { minFloor, maxFloor } = context.rawFloorBounds;
  if (minFloor === null || maxFloor === null) {
    return createFailure('floor_range', CAPTURE_MATERIAL_ERROR_CODES.EMPTY_CHAT, '当前聊天没有任何楼层。');
  }
  if (fromFloor < minFloor || fromFloor > maxFloor || toFloor > maxFloor) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.FLOOR_OUT_OF_RANGE,
      `指定楼层超出当前聊天范围 ${minFloor}—${maxFloor}。`,
      { fromFloor, toFloor, minFloor, maxFloor },
    );
  }
  const selected = context.pureMessages.filter(message => (
    message.floor >= fromFloor && message.floor <= toFloor
  ));
  if (!selected.length) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.EMPTY_MATERIAL,
      `第 ${fromFloor}—${toFloor} 楼没有可用的纯聊天内容。`,
      { fromFloor, toFloor },
    );
  }
  if (selected.length > MAX_CAPTURE_CHAT_MESSAGES) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.TOO_MANY_MESSAGES,
      `指定范围包含 ${selected.length} 条纯聊天，超过单次最多 ${MAX_CAPTURE_CHAT_MESSAGES} 条的保护限制。`,
      { fromFloor, toFloor, messageCount: selected.length, maxMessageCount: MAX_CAPTURE_CHAT_MESSAGES },
    );
  }
  const material = formatCaptureChatMessages(selected);
  return createSuccess('floor_range', selected, material, {
    requestedRange: { fromFloor, toFloor },
  });
}

function extractGrandSummaryContent(content) {
  const match = String(content || '').match(GRAND_MEMORY_BLOCK_RE);
  return match?.[0]?.trim() || '';
}

function findLatestGrandSummary(rawMessages, chatState) {
  const messagesByFloor = new Map(
    (Array.isArray(rawMessages) ? rawMessages : [])
      .map((message, index) => [getMessageFloor(message, index), message])
      .filter(([floor]) => floor !== null),
  );
  const records = Array.isArray(chatState?.summary?.archiveRecords)
    ? chatState.summary.archiveRecords
    : [];
  const activeRecords = records
    .filter(record => !record?.compressedBy)
    .sort((a, b) => Number(b?.summaryMessageId ?? -1) - Number(a?.summaryMessageId ?? -1));

  for (const record of activeRecords) {
    const messageId = normalizeFloor(record?.summaryMessageId);
    const message = messageId === null ? null : messagesByFloor.get(messageId);
    const content = extractGrandSummaryContent(getRawMessageContent(message));
    if (!message || normalizeRole(message) !== 'assistant' || isSystemOrInjectedMessage(message) || !content) continue;
    return {
      messageId,
      content,
      coverageFrom: normalizeFloor(record.archiveFrom),
      coverageTo: normalizeFloor(record.archiveTo),
      recordId: String(record.id ?? ''),
    };
  }

  const fallback = [...messagesByFloor.entries()]
    .sort((a, b) => b[0] - a[0])
    .find(([, message]) => (
      normalizeRole(message) === 'assistant'
      && !isSystemOrInjectedMessage(message)
      && extractGrandSummaryContent(getRawMessageContent(message))
    ));
  if (!fallback) return null;
  return {
    messageId: fallback[0],
    content: extractGrandSummaryContent(getRawMessageContent(fallback[1])),
    coverageFrom: null,
    coverageTo: null,
    recordId: '',
  };
}

function resolveGrandPlusAfter(context) {
  const summary = findLatestGrandSummary(context.rawMessages, context.chatState);
  if (!summary) {
    return createFailure(
      'grand_plus_after',
      CAPTURE_MATERIAL_ERROR_CODES.GRAND_SUMMARY_NOT_FOUND,
      '当前聊天没有可用的大总结。',
    );
  }
  const messages = context.pureMessages.filter(message => message.floor > summary.messageId);
  if (messages.length > MAX_CAPTURE_CHAT_MESSAGES) {
    return createFailure(
      'grand_plus_after',
      CAPTURE_MATERIAL_ERROR_CODES.TOO_MANY_MESSAGES,
      `大总结后有 ${messages.length} 条纯聊天，超过单次最多 ${MAX_CAPTURE_CHAT_MESSAGES} 条的保护限制。`,
      { summaryMessageId: summary.messageId, messageCount: messages.length, maxMessageCount: MAX_CAPTURE_CHAT_MESSAGES },
    );
  }
  const coverage = summary.coverageFrom !== null && summary.coverageTo !== null
    ? `｜覆盖第 ${summary.coverageFrom}—${summary.coverageTo} 楼`
    : '';
  const sections = [`【最近大总结｜第 ${summary.messageId} 楼${coverage}】\n${summary.content}`];
  if (messages.length) {
    sections.push(`【大总结后的纯聊天】\n${formatCaptureChatMessages(messages)}`);
  }
  const material = sections.join('\n\n');
  return createSuccess('grand_plus_after', messages, material, { summary });
}

/**
 * 根据唯一来源模式构建剧情材料，并返回可供 UI 使用的结构化范围、计数与预检错误。
 */
export function buildCaptureSourceMaterial(source, options = {}) {
  const normalizedSource = isPlainObject(source) ? source : {};
  const mode = normalizedSource.mode;
  if (!CAPTURE_SOURCE_MODES.includes(mode)) {
    return createFailure(
      mode || '',
      CAPTURE_MATERIAL_ERROR_CODES.INVALID_SOURCE_MODE,
      '设定采集的主要剧情来源无效。',
      { mode: mode ?? null },
    );
  }

  const rawMessages = Array.isArray(options.messages)
    ? options.messages
    : getChatMessagesSafe(undefined, { hide_state: 'all' });
  const pureMessages = collectPureChatMessages({
    messages: rawMessages,
    summarySettings: options.summarySettings,
    names: options.names,
  });
  const context = {
    rawMessages,
    pureMessages,
    rawFloorBounds: getRawFloorBounds(rawMessages),
    chatState: isPlainObject(options.chatState) ? options.chatState : getChatState(),
  };

  if (mode === 'recent_chat') return resolveRecentChat(normalizedSource, context);
  if (mode === 'floor_range') return resolveFloorRange(normalizedSource, context);
  return resolveGrandPlusAfter(context);
}

function hasActiveCharacterContext(context, characterMaterial) {
  if (!characterMaterial) return false;
  const rawId = context?.characterId ?? context?.this_chid ?? context?.chid;
  const hasId = rawId !== null && rawId !== undefined && String(rawId).trim() !== '' && Number(rawId) !== -1;
  return hasId || Boolean(context?.character) || Boolean(context?.name2);
}

/** 返回角色卡与 Persona 的当前可用状态和已经格式化的材料。 */
export function inspectCaptureOptionalSources(options = {}) {
  const context = getContextSafe();
  const hasInjectedCharacter = Object.hasOwn(options, 'characterCard');
  const hasInjectedPersona = Object.hasOwn(options, 'persona');
  const characterCard = hasInjectedCharacter ? options.characterCard : getResolvedCharacterCard();
  const persona = hasInjectedPersona ? options.persona : getUserPersona();
  const characterMaterial = formatCharacterCardForPrompt(characterCard);
  const personaMaterial = formatUserPersonaForPrompt(persona);
  const characterAvailable = Object.hasOwn(options, 'characterAvailable')
    ? options.characterAvailable === true
    : (hasInjectedCharacter ? Boolean(characterMaterial) : hasActiveCharacterContext(context, characterMaterial));

  return {
    characterCard: {
      available: characterAvailable && Boolean(characterMaterial),
      reason: characterAvailable && characterMaterial ? '' : '当前没有可读取的角色卡。',
      name: String(characterCard?.name || '').trim(),
      material: characterMaterial,
      data: characterCard || null,
    },
    persona: {
      available: Boolean(personaMaterial),
      reason: personaMaterial ? '' : '当前 Persona 没有可读取的描述。',
      material: personaMaterial,
    },
  };
}

function normalizeWorldbookKeyword(value) {
  if (value instanceof RegExp) return value.toString();
  return String(value ?? '').trim();
}

function normalizeWorldbookKeywords(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeWorldbookKeyword).filter(Boolean);
}

function normalizeWorldbookEntryForCapture(worldbookName, entry) {
  const uid = Number(entry?.uid);
  if (!Number.isInteger(uid) || uid < 0) return null;
  const content = String(entry?.content ?? '');
  const name = String(entry?.name ?? '').trim() || `未命名条目 #${uid}`;
  return {
    worldbookName,
    uid,
    name,
    enabled: entry?.enabled !== false,
    strategyType: ['constant', 'selective', 'vectorized'].includes(entry?.strategy?.type)
      ? entry.strategy.type
      : 'selective',
    mainKeywords: normalizeWorldbookKeywords(entry?.strategy?.keys),
    filterKeywords: normalizeWorldbookKeywords(entry?.strategy?.keys_secondary?.keys),
    content,
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 80),
    position: String(entry?.position?.type || ''),
    order: Number.isFinite(Number(entry?.position?.order)) ? Number(entry.position.order) : null,
  };
}

export function createCaptureWorldbookRef(worldbookName, entry) {
  const name = String(worldbookName || '').trim();
  const uid = Number(entry?.uid);
  if (!name || !Number.isInteger(uid) || uid < 0) return null;
  return {
    worldbookName: name,
    uid,
    entryNameSnapshot: String(entry?.name ?? entry?.entryNameSnapshot ?? '').trim(),
  };
}

function getCaptureWorldbookRefKey(ref) {
  return `${String(ref?.worldbookName || '').trim()}\u0000${Number(ref?.uid)}`;
}

export function toggleCaptureWorldbookRef(refs, ref, selected) {
  const normalizedRef = createCaptureWorldbookRef(ref?.worldbookName, ref);
  const current = Array.isArray(refs) ? refs.map(item => createCaptureWorldbookRef(item?.worldbookName, item)).filter(Boolean) : [];
  if (!normalizedRef) return current;
  const key = getCaptureWorldbookRefKey(normalizedRef);
  const exists = current.some(item => getCaptureWorldbookRefKey(item) === key);
  const shouldSelect = selected === undefined ? !exists : selected === true;
  if (shouldSelect && !exists) return [...current, normalizedRef];
  if (!shouldSelect && exists) return current.filter(item => getCaptureWorldbookRefKey(item) !== key);
  return current;
}

export function setCaptureWorldbookRefsForBook(refs, worldbookName, entries, selected) {
  const name = String(worldbookName || '').trim();
  let next = (Array.isArray(refs) ? refs : [])
    .map(item => createCaptureWorldbookRef(item?.worldbookName, item))
    .filter(Boolean);
  if (!selected) return next.filter(ref => ref.worldbookName !== name);
  (Array.isArray(entries) ? entries : []).forEach(entry => {
    const ref = createCaptureWorldbookRef(name, entry);
    if (ref) next = toggleCaptureWorldbookRef(next, ref, true);
  });
  return next;
}

/**
 * 只返回当前角色卡绑定的世界书（primary + additional），不拉取全部世界书。
 * 设定采集只在角色卡绑定的世界书内选择条目。
 */
export async function listCaptureWorldbooks({ api } = {}) {
  try {
    const readApi = api || getWorldbookReadApi();
    if (typeof readApi.getCharWorldbookNames !== 'function') {
      throw new Error('当前环境缺少 getCharWorldbookNames，无法读取角色卡绑定的世界书。');
    }
    const bound = await Promise.resolve(readApi.getCharWorldbookNames('current'));
    const primary = String(bound?.primary || '').trim();
    const additional = Array.isArray(bound?.additional) ? bound.additional : [];
    // primary 排在最前，additional 去重跟随；空名剔除。
    const names = [...new Set([primary, ...additional]
      .map(name => String(name || '').trim())
      .filter(Boolean))];
    return { ok: true, names, primary: primary || null, error: null };
  } catch (error) {
    return {
      ok: false,
      names: [],
      primary: null,
      error: {
        code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_LIST_FAILED,
        message: `读取角色卡绑定的世界书失败：${error.message || String(error)}`,
      },
    };
  }
}

/** 按需加载单本世界书全部条目，保留关闭状态和激活类型供选择器展示。 */
export async function loadCaptureWorldbookEntries(worldbookName, { api } = {}) {
  const name = String(worldbookName || '').trim();
  try {
    const readApi = api || getWorldbookReadApi();
    const rawEntries = await readApi.getWorldbook(name);
    if (!Array.isArray(rawEntries)) throw new Error('返回结果不是条目数组。');
    const entries = rawEntries
      .map(entry => normalizeWorldbookEntryForCapture(name, entry))
      .filter(Boolean);
    return { ok: true, worldbookName: name, entries, error: null };
  } catch (error) {
    return {
      ok: false,
      worldbookName: name,
      entries: [],
      error: {
        code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_LOAD_FAILED,
        message: `读取世界书「${name || '未命名'}」失败：${error.message || String(error)}`,
        worldbookName: name,
      },
    };
  }
}

export function filterCaptureWorldbookEntries(entries, query) {
  const keyword = String(query || '').trim().toLocaleLowerCase();
  if (!keyword) return Array.isArray(entries) ? entries : [];
  return (Array.isArray(entries) ? entries : []).filter(entry => [
    entry?.name,
    ...(Array.isArray(entry?.mainKeywords) ? entry.mainKeywords : []),
    ...(Array.isArray(entry?.filterKeywords) ? entry.filterKeywords : []),
  ].some(value => String(value || '').toLocaleLowerCase().includes(keyword)));
}

function formatSelectedWorldbookEntry(entry) {
  return [
    `【世界书参考｜${entry.worldbookName}｜${entry.name}｜UID ${entry.uid}】`,
    entry.content,
  ].join('\n');
}

/**
 * 正式生成前使用：重新读取所有明确勾选的 worldbookName + uid，并构建最终附加材料。
 * 关闭、常驻、未触发、位置和递归状态均不参与筛选；缺失引用会明确报错。
 */
export async function buildCaptureOptionalContextMaterial(optionalContext, options = {}) {
  const selection = isPlainObject(optionalContext) ? optionalContext : {};
  const sources = inspectCaptureOptionalSources(options);
  const errors = [];
  const sections = [];
  if (selection.includeCharacterCard) {
    if (sources.characterCard.available) sections.push(`【当前角色卡】\n${sources.characterCard.material}`);
    else errors.push({
      code: CAPTURE_OPTIONAL_ERROR_CODES.CHARACTER_CARD_UNAVAILABLE,
      message: sources.characterCard.reason,
    });
  }
  if (selection.includePersona) {
    if (sources.persona.available) sections.push(`【当前 Persona】\n${sources.persona.material}`);
    else errors.push({
      code: CAPTURE_OPTIONAL_ERROR_CODES.PERSONA_UNAVAILABLE,
      message: sources.persona.reason,
    });
  }

  const refs = (Array.isArray(selection.worldbookRefs) ? selection.worldbookRefs : [])
    .map(ref => createCaptureWorldbookRef(ref?.worldbookName, ref))
    .filter(Boolean);
  const uniqueRefs = [...new Map(refs.map(ref => [getCaptureWorldbookRefKey(ref), ref])).values()];
  const refsByBook = new Map();
  uniqueRefs.forEach(ref => {
    if (!refsByBook.has(ref.worldbookName)) refsByBook.set(ref.worldbookName, []);
    refsByBook.get(ref.worldbookName).push(ref);
  });

  const resolvedEntries = [];
  const missingRefs = [];
  for (const [worldbookName, bookRefs] of refsByBook.entries()) {
    const loaded = await loadCaptureWorldbookEntries(worldbookName, { api: options.api });
    if (!loaded.ok) {
      errors.push(loaded.error);
      bookRefs.forEach(ref => missingRefs.push(ref));
      continue;
    }
    const byUid = new Map(loaded.entries.map(entry => [entry.uid, entry]));
    bookRefs.forEach(ref => {
      const entry = byUid.get(ref.uid);
      if (!entry) {
        missingRefs.push(ref);
        errors.push({
          code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_REF_MISSING,
          message: `世界书「${ref.worldbookName}」中找不到 UID ${ref.uid}（选择时标题：${ref.entryNameSnapshot || '未记录'}）。`,
          ref,
        });
        return;
      }
      resolvedEntries.push(entry);
      sections.push(formatSelectedWorldbookEntry(entry));
    });
  }

  const material = sections.join('\n\n');
  return {
    ok: errors.length === 0,
    material,
    characterCount: material.length,
    sources,
    selectedRefCount: uniqueRefs.length,
    resolvedEntries,
    missingRefs,
    errors,
  };
}
