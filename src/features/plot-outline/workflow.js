import { getContextSafe } from '../../core/chat.js';
import {
  getTavernEventsSafe,
  registerTavernEvent,
} from '../../core/tavern-events.js';
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
import {
  generateWithMainApi,
  generateWithSecondaryApi,
} from '../../core/generation.js';
import { replacePromptMessageMacros } from '../../core/macros.js';
import {
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import {
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getPlotOutlineSettings,
  getPlotOutlineState,
  getWordReplaceSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  buildPlotOutlinePrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import { applyWordReplacementToGeneratedContent } from '../word-replace/generated.js';

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
};

const OUTLINE_GENERATION_TIMEOUT_MS = 180000;
const PLOT_OUTLINE_PROMPT_ID = 'shenling_assistant_plot_outline_state';
// setExtensionPrompt 参数：position 1 = IN_CHAT，depth 0 = 紧贴最新楼层，与情感档案一致
const PLOT_OUTLINE_INJECT_POSITION = 1;
const PLOT_OUTLINE_INJECT_DEPTH = 0;
const VALID_STAGES = ['起', '承', '转', '合'];

const outlineEventStops = [];
let outlineEventsRegistered = false;

export function configurePlotOutlineWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const matched = raw.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return (matched?.[1] || raw).trim();
}

function extractJsonObjectText(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return raw.slice(start, end + 1).trim();
  }
  return '';
}

function cleanFieldText(value) {
  return String(value ?? '').trim();
}

function chapterIdByIndex(index) {
  return `CH${String(index + 1).padStart(2, '0')}`;
}

export function normalizePlotOutlineDraft(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('生成结果不是有效的大纲 JSON 对象。');
  }
  const rawCore = isPlainObject(raw.storyCore) ? raw.storyCore : {};
  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  if (rawChapters.length === 0) {
    throw new Error('生成结果中没有章节。');
  }

  const chapters = rawChapters.map((chapter, index) => {
    const source = isPlainObject(chapter) ? chapter : {};
    const conditions = (Array.isArray(source.conditions) ? source.conditions : [])
      .map(item => cleanFieldText(isPlainObject(item) ? item.text : item))
      .filter(Boolean)
      .map((text, conditionIndex) => ({ id: `C${conditionIndex + 1}`, text }));

    return {
      id: chapterIdByIndex(index),
      title: cleanFieldText(source.title) || `第 ${index + 1} 章`,
      stage: VALID_STAGES.includes(source.stage) ? source.stage : '',
      theme: cleanFieldText(source.theme),
      synopsis: cleanFieldText(source.synopsis),
      keyEvents: (Array.isArray(source.keyEvents) ? source.keyEvents : [])
        .map(cleanFieldText)
        .filter(Boolean),
      conditions,
      exitChapterId: index < rawChapters.length - 1 ? chapterIdByIndex(index + 1) : '',
    };
  });

  return {
    storyCore: {
      logline: cleanFieldText(rawCore.logline),
      conflict: cleanFieldText(rawCore.conflict),
      tone: cleanFieldText(rawCore.tone),
    },
    chapters,
  };
}


export function getActiveOutlineChapter(outline) {
  if (!Array.isArray(outline.chapters) || outline.chapters.length === 0) return null;
  return outline.chapters.find(chapter => chapter.id === outline.currentChapterId)
    || outline.chapters[0];
}

function normalizeOutlineId(value) {
  return String(value || '').trim().toUpperCase();
}

function splitProgressConditionIds(value) {
  return String(value || '')
    .split(/[，、,\s]+/)
    .map(normalizeOutlineId)
    .filter(Boolean);
}

function getOutlineChapterById(outline, chapterId) {
  const normalizedId = normalizeOutlineId(chapterId);
  return (Array.isArray(outline.chapters) ? outline.chapters : [])
    .find(chapter => normalizeOutlineId(chapter.id) === normalizedId) || null;
}

function getValidConditionIdsForChapter(chapter, conditionIds) {
  const conditionIdsByNormalized = new Map(
    (Array.isArray(chapter?.conditions) ? chapter.conditions : [])
      .map(condition => [normalizeOutlineId(condition.id), condition.id]),
  );
  return [...new Set((Array.isArray(conditionIds) ? conditionIds : [])
    .map(id => conditionIdsByNormalized.get(normalizeOutlineId(id)))
    .filter(Boolean))];
}

function getProgressSignature(progress) {
  return JSON.stringify(progress || {});
}

function ensureProgressSources(outline) {
  if (!isPlainObject(outline.progressSources)) {
    outline.progressSources = {};
  }
  return outline.progressSources;
}

export function rebuildPlotOutlineProgressFromSources(outline, { advanceCurrentChapter = true } = {}) {
  const sources = ensureProgressSources(outline);
  const nextProgress = {};
  let sourcesChanged = false;

  Object.entries(sources).forEach(([sourceKey, source]) => {
    if (!isPlainObject(source)) {
      delete sources[sourceKey];
      sourcesChanged = true;
      return;
    }

    const chapter = getOutlineChapterById(outline, source.chapterId);
    if (!chapter) {
      delete sources[sourceKey];
      sourcesChanged = true;
      return;
    }

    const conditionIds = getValidConditionIdsForChapter(chapter, source.conditionIds);
    if (conditionIds.length === 0) {
      if (Array.isArray(source.conditionIds) && source.conditionIds.length === 0) return;
      delete sources[sourceKey];
      sourcesChanged = true;
      return;
    }

    if (!isPlainObject(nextProgress[chapter.id])) {
      nextProgress[chapter.id] = {};
    }
    conditionIds.forEach(conditionId => {
      nextProgress[chapter.id][conditionId] = true;
    });

    if (
      source.chapterId !== chapter.id ||
      getProgressSignature(source.conditionIds) !== getProgressSignature(conditionIds)
    ) {
      sources[sourceKey] = {
        ...source,
        chapterId: chapter.id,
        conditionIds,
      };
      sourcesChanged = true;
    }
  });

  outline.progress = nextProgress;

  let switchedToChapterId = '';
  if (advanceCurrentChapter) {
    const chapter = getActiveOutlineChapter(outline);
    const conditions = Array.isArray(chapter?.conditions) ? chapter.conditions : [];
    const chapterProgress = isPlainObject(outline.progress?.[chapter?.id]) ? outline.progress[chapter.id] : {};
    const exitChapter = getOutlineChapterById(outline, chapter?.exitChapterId);
    if (conditions.length > 0 && conditions.every(condition => chapterProgress[condition.id]) && exitChapter) {
      outline.currentChapterId = exitChapter.id;
      switchedToChapterId = exitChapter.id;
    }
  }

  return { sourcesChanged, switchedToChapterId };
}

export function setManualPlotOutlineProgressSource(outline, chapterId, conditionId, done) {
  const chapter = getOutlineChapterById(outline, chapterId);
  if (!chapter) return { changed: false };
  const validConditionIds = getValidConditionIdsForChapter(chapter, [conditionId]);
  if (validConditionIds.length === 0) return { changed: false };

  const beforeProgress = getProgressSignature(outline.progress);
  const beforeChapterId = outline.currentChapterId;
  const sources = ensureProgressSources(outline);
  const sourceKey = `manual:${chapter.id}:${validConditionIds[0]}`;

  if (done) {
    sources[sourceKey] = {
      source: 'manual',
      chapterId: chapter.id,
      conditionIds: [validConditionIds[0]],
      updatedAt: formatTimestamp(),
    };
  } else {
    delete sources[sourceKey];
  }

  const rebuildResult = rebuildPlotOutlineProgressFromSources(outline);
  const changed = beforeProgress !== getProgressSignature(outline.progress)
    || beforeChapterId !== outline.currentChapterId
    || rebuildResult.sourcesChanged;
  return {
    changed,
    switchedToChapterId: rebuildResult.switchedToChapterId,
  };
}
export function buildPlotOutlineInjection(chatState = getChatState()) {
  const outline = getPlotOutlineState(chatState);
  if (!outline.enabled) return '';
  const chapter = getActiveOutlineChapter(outline);
  if (!chapter) return '';

  const core = outline.storyCore || {};
  const coreLines = [
    core.logline ? `一句话主线：${core.logline}` : '',
    core.conflict ? `核心冲突：${core.conflict}` : '',
    core.tone ? `叙事基调：${core.tone}` : '',
  ].filter(Boolean);

  const conditions = Array.isArray(chapter.conditions) ? chapter.conditions : [];
  const chapterProgress = outline.progress?.[chapter.id] || {};
  const chapterLines = [
    `${chapter.id} ${chapter.title}`,
    chapter.stage ? `叙事阶段：${chapter.stage}` : '',
    chapter.theme ? `主题：${chapter.theme}` : '',
    chapter.synopsis ? `剧情脉络：${chapter.synopsis}` : '',
    chapter.keyEvents?.length
      ? `关键事件：\n${chapter.keyEvents.map(event => `- ${event}`).join('\n')}`
      : '',
    conditions.length
      ? `推进条件：\n${conditions.map(condition => `${condition.id}. ${condition.text}`).join('\n')}`
      : '',
    chapter.exitChapterId ? `出口章节：${chapter.exitChapterId}` : '',
  ].filter(Boolean);

  const progressLines = conditions.map(condition => (
    `${condition.id} ${chapterProgress[condition.id] ? '✅' : '⬜'}`
  ));

  const sections = [
    coreLines.length ? `【故事核心】\n${coreLines.join('\n')}` : '',
    `【当前章节】\n${chapterLines.join('\n')}`,
    progressLines.length ? `【当前推进进度】\n${progressLines.join('\n')}` : '',
  ].filter(Boolean);

  return `<plot_outline_state>
以下为蜃灵助手维护的剧情大纲当前章节状态。它不是已发生剧情，而是当前章节的方向指引，用于把控主线节奏。

使用规则：
- 正文展开时自然向本章方向靠拢，不要照本宣科复述大纲内容。
- 推进条件只用于判断剧情是否逐步靠近章节目标，不要求本轮全部完成，也不要在正文中逐条复述、打卡或宣告条件完成。
- 不要为了满足推进条件而强行触发关键事件、关键物品、告白、战斗或章节结尾。
- 不要提前剧透或展开其他章节内容。

${sections.join('\n\n')}
</plot_outline_state>`;
}

export function buildPlotOutlineProgressPromptSection(chatState = getChatState()) {
  const outline = getPlotOutlineState(chatState);
  if (!outline.enabled) return '';
  const chapter = getActiveOutlineChapter(outline);
  if (!chapter) return '';

  const conditions = Array.isArray(chapter.conditions) ? chapter.conditions : [];
  if (conditions.length === 0) return '';

  const chapterProgress = isPlainObject(outline.progress?.[chapter.id]) ? outline.progress[chapter.id] : {};
  const completedConditionIds = conditions
    .filter(condition => chapterProgress[condition.id])
    .map(condition => condition.id);
  const exitChapter = getOutlineChapterById(outline, chapter.exitChapterId);
  const exitLabel = exitChapter
    ? `${exitChapter.id} ${exitChapter.title}`
    : (chapter.exitChapterId ? `${chapter.exitChapterId}（未找到）` : '无');
  const conditionLines = conditions.map(condition => `${condition.id}. ${condition.text}`);
  const completedDisplay = completedConditionIds.length ? completedConditionIds.join(',') : '无';
  const outputLine = `[progress:${chapter.id}|本轮新增完成条件|${chapter.exitChapterId || ''}|当前已完成:本轮后全部完成条件]`;
  const emptyLine = `[progress:${chapter.id}||${chapter.exitChapterId || ''}|当前已完成:${completedDisplay}]`;

  return `【剧情章节进度检查】
当前章节：${chapter.id} ${chapter.title}
出口章节：${exitLabel}

推进条件：
${conditionLines.join('\n')}

当前已完成：
${completedConditionIds.length ? completedConditionIds.join(',') : '无'}

请根据本轮素材判断是否新增完成推进条件。
只在 <memory> 内追加一行，格式固定为：
${outputLine}

本轮新增完成条件只写本轮新增的条件编号，用英文逗号分隔，例如 C2 或 C2,C3；不要输出累计已完成项。
最后一段“当前已完成”用于展示，必须写本轮判定后的累计完成条件；如果已有 C1,C2 且本轮新增 C3，则写 当前已完成:C1,C2,C3。
如果本轮没有新增完成条件，请输出：
${emptyLine}`;
}

export function parsePlotOutlineProgressLine(memoryText) {
  const matched = String(memoryText || '').match(/\[progress\s*:\s*([^\]]*)\]/i);
  if (!matched) return null;
  const parts = matched[1].split('|');
  if (parts.length < 2) return null;
  const chapterId = normalizeOutlineId(parts[0]);
  if (!chapterId) return null;
  return {
    chapterId,
    conditionIds: splitProgressConditionIds(parts[1]),
    exitChapterId: normalizeOutlineId(parts[2] || ''),
  };
}

function applyLegacyPlotOutlineProgressUpdate(parsed, chapter, chatState) {
  const outline = getPlotOutlineState(chatState);
  const conditions = Array.isArray(chapter.conditions) ? chapter.conditions : [];
  const validConditionIds = getValidConditionIdsForChapter(chapter, parsed.conditionIds);

  if (!isPlainObject(outline.progress)) {
    outline.progress = {};
  }
  if (!isPlainObject(outline.progress[chapter.id])) {
    outline.progress[chapter.id] = {};
  }

  const chapterProgress = outline.progress[chapter.id];
  const completedConditionIds = [];
  validConditionIds.forEach(conditionId => {
    if (!chapterProgress[conditionId]) {
      chapterProgress[conditionId] = true;
      completedConditionIds.push(conditionId);
    }
  });

  let switchedToChapterId = '';
  const allConditionsComplete = conditions.every(condition => chapterProgress[condition.id]);
  const exitChapter = getOutlineChapterById(outline, chapter.exitChapterId);
  if (completedConditionIds.length > 0 && allConditionsComplete && exitChapter) {
    outline.currentChapterId = exitChapter.id;
    switchedToChapterId = exitChapter.id;
  }

  const changed = completedConditionIds.length > 0 || Boolean(switchedToChapterId);
  if (!changed) return { changed: false };

  outline.updatedAt = formatTimestamp();
  saveChatState();
  return {
    changed: true,
    chapterId: chapter.id,
    completedConditionIds,
    switchedToChapterId,
  };
}

export function applyPlotOutlineProgressUpdate(memoryText, chatState = getChatState(), options = {}) {
  const parsed = parsePlotOutlineProgressLine(memoryText);
  if (!parsed) return { changed: false };

  const outline = getPlotOutlineState(chatState);
  if (!outline.enabled) return { changed: false };
  const chapter = getActiveOutlineChapter(outline);
  if (!chapter || normalizeOutlineId(chapter.id) !== parsed.chapterId) return { changed: false };

  const conditions = Array.isArray(chapter.conditions) ? chapter.conditions : [];
  if (conditions.length === 0) return { changed: false };

  const messageId = Number(options.messageId);
  if (!Number.isInteger(messageId) || messageId < 0) {
    return applyLegacyPlotOutlineProgressUpdate(parsed, chapter, chatState);
  }

  const validConditionIds = getValidConditionIdsForChapter(chapter, parsed.conditionIds);
  const beforeProgress = getProgressSignature(outline.progress);
  const beforeChapterId = outline.currentChapterId;
  const beforeChapterProgress = isPlainObject(outline.progress?.[chapter.id]) ? outline.progress[chapter.id] : {};
  const completedConditionIds = validConditionIds.filter(conditionId => !beforeChapterProgress[conditionId]);
  const sources = ensureProgressSources(outline);
  const sourceKey = String(messageId);
  const previousSource = isPlainObject(sources[sourceKey]) ? sources[sourceKey] : null;
  const nextSource = validConditionIds.length
    ? {
      source: 'memory',
      messageId,
      fingerprint: String(options.fingerprint || ''),
      chapterId: chapter.id,
      conditionIds: validConditionIds,
      exitChapterId: parsed.exitChapterId || chapter.exitChapterId || '',
      updatedAt: formatTimestamp(),
    }
    : null;
  const sourceChanged = getProgressSignature(previousSource) !== getProgressSignature(nextSource);

  if (nextSource) {
    sources[sourceKey] = nextSource;
  } else {
    delete sources[sourceKey];
  }

  const rebuildResult = rebuildPlotOutlineProgressFromSources(outline);
  const progressChanged = beforeProgress !== getProgressSignature(outline.progress)
    || beforeChapterId !== outline.currentChapterId;
  const shouldSave = sourceChanged || progressChanged || rebuildResult.sourcesChanged;
  if (!shouldSave) return { changed: false };

  outline.updatedAt = formatTimestamp();
  saveChatState();
  return {
    changed: progressChanged,
    chapterId: chapter.id,
    completedConditionIds,
    switchedToChapterId: rebuildResult.switchedToChapterId,
  };
}
export async function syncPlotOutlineInjection() {
  const context = getContextSafe();
  const setExtensionPrompt = typeof context?.setExtensionPrompt === 'function'
    ? (...args) => context.setExtensionPrompt(...args)
    : typeof globalThis.setExtensionPrompt === 'function'
      ? (...args) => globalThis.setExtensionPrompt(...args)
      : null;
  if (!setExtensionPrompt) return;

  const content = buildPlotOutlineInjection();

  if (!content) {
    await clearPlotOutlineInjection(setExtensionPrompt);
    return;
  }

  await setExtensionPrompt(
    PLOT_OUTLINE_PROMPT_ID,
    content,
    PLOT_OUTLINE_INJECT_POSITION,
    PLOT_OUTLINE_INJECT_DEPTH,
    false,
    0,
    () => Boolean(buildPlotOutlineInjection()),
  );
}

async function clearPlotOutlineInjection(setExtensionPrompt) {
  const disabledFilter = () => false;
  // 兼容旧版清理写法，同时按实际注入槽位覆盖清空，避免 UI 显示“未注入”但旧 prompt 仍留在正文请求里。
  await setExtensionPrompt(PLOT_OUTLINE_PROMPT_ID, '', -1, 0, false, 0, disabledFilter);
  await setExtensionPrompt(
    PLOT_OUTLINE_PROMPT_ID,
    '',
    PLOT_OUTLINE_INJECT_POSITION,
    PLOT_OUTLINE_INJECT_DEPTH,
    false,
    0,
    disabledFilter,
  );
}

export function registerPlotOutlineEvents() {
  if (outlineEventsRegistered) return;
  const tavernEvents = getTavernEventsSafe();
  const syncHandler = () => {
    void syncPlotOutlineInjection().catch(error => {
      console.warn('[蜃灵助手] 剧情大纲注入刷新失败。', error);
    });
  };

  const beforeCombineStop = registerTavernEvent(tavernEvents.GENERATE_BEFORE_COMBINE_PROMPTS, syncHandler);
  if (beforeCombineStop) outlineEventStops.push(beforeCombineStop);

  const chatChangedStop = registerTavernEvent(tavernEvents.CHAT_CHANGED, syncHandler);
  if (chatChangedStop) outlineEventStops.push(chatChangedStop);

  outlineEventsRegistered = outlineEventStops.length > 0;
  syncHandler();
}

function applyWordReplacementToDraft(draft) {
  const settings = getWordReplaceSettings(getGlobalSettings());
  let replacements = 0;

  const replaceField = value => {
    const result = applyWordReplacementToGeneratedContent(value, settings, { mode: 'text' });
    if (result.errors.length > 0) {
      throw new Error(`词汇替换规则错误：${result.errors.join('；')}`);
    }
    replacements += result.replacements;
    return result.text;
  };

  draft.storyCore.logline = replaceField(draft.storyCore.logline);
  draft.storyCore.conflict = replaceField(draft.storyCore.conflict);
  draft.storyCore.tone = replaceField(draft.storyCore.tone);
  draft.chapters.forEach(chapter => {
    chapter.title = replaceField(chapter.title);
    chapter.theme = replaceField(chapter.theme);
    chapter.synopsis = replaceField(chapter.synopsis);
    chapter.keyEvents = chapter.keyEvents.map(replaceField);
    chapter.conditions.forEach(condition => {
      condition.text = replaceField(condition.text);
    });
  });

  return { draft, replacements };
}

function buildPlotOutlineMessages({ userDirection, chapterCount, contextMaterial }) {
  const settings = getGlobalSettings();
  return replacePromptMessageMacros([
    ...resolvePromptMessages(PROMPT_IDS.SUMMARY_SUPPORT_MESSAGES, settings),
    {
      role: 'user',
      content: buildPlotOutlinePrompt({
        userDirection,
        chapterCount,
        contextMaterial,
        template: resolvePromptText(PROMPT_IDS.OUTLINE_BUILD, settings),
      }),
    },
  ]);
}

function buildContextDiagnostics(context) {
  return {
    purpose: context.purpose,
    targetRoleName: context.targetRoleName,
    recentMessageCount: context.diagnostics?.recentMessageCount ?? 0,
    memoryCount: context.diagnostics?.memoryCount ?? 0,
    grandMemoryCount: context.diagnostics?.grandMemoryCount ?? 0,
    emotionProfileCount: context.diagnostics?.emotionProfileCount ?? 0,
    worldInfo: context.diagnostics?.worldInfo || {},
  };
}

export async function runPlotOutlineGeneration({ userDirection } = {}) {
  const info = getContextInfo();
  const plotSettings = getPlotOutlineSettings();
  const apiMode = plotSettings.apiMode;
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let messages = [];
  let apiResult = null;
  let contextDiagnostics = null;

  try {
    const context = await resolveShenlingContext({
      purpose: 'plotOutline',
      targetRoleName: info.characterName,
      recentMessageLimit: 8,
      includeRecentChat: true,
      includeMemories: true,
      includeGrandMemories: true,
      includeEmotionProfile: true,
      includeWorldInfo: true,
      worldInfoMode: 'cache_first',
    });
    contextDiagnostics = buildContextDiagnostics(context);
    const contextMaterial = formatShenlingContextForPrompt(context, {
      worldInfoMaterialMode: 'injection_first',
    });
    messages = buildPlotOutlineMessages({
      userDirection,
      chapterCount: String(plotSettings.chapterCount),
      contextMaterial,
    });

    apiResult = apiMode === 'main_api'
      ? await generateWithMainApi({
        messages,
        timeoutMs: OUTLINE_GENERATION_TIMEOUT_MS,
        timeoutMessage: '剧情大纲生成超时，请稍后重试。',
      })
      : await generateWithSecondaryApi({
        profile: getWorkflowOption('getActiveApiProfile')?.(getGlobalSettings()),
        messages,
        timeoutMs: OUTLINE_GENERATION_TIMEOUT_MS,
        timeoutMessage: '剧情大纲生成超时，请稍后重试。',
      });

    const rawContent = apiResult.content;
    const jsonText = stripMarkdownFence(rawContent);
    if (!jsonText) throw new Error('剧情大纲生成结果为空。');

    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // 模型可能在 JSON 前后附带说明文字，截取首个 { 到末个 } 再试一次
      const fallbackText = extractJsonObjectText(jsonText);
      try {
        parsed = JSON.parse(fallbackText);
      } catch {
        throw new Error('剧情大纲生成结果不是合法 JSON，请重试或检查模型输出。');
      }
    }
    const normalized = normalizePlotOutlineDraft(parsed);
    const { draft, replacements } = applyWordReplacementToDraft(normalized);
    const wordReplacement = {
      mode: 'text',
      replacements,
      changed: replacements > 0,
      errors: [],
      skippedReason: '',
    };

    getWorkflowOption('addCommunicationLog')?.({
      moduleName: apiMode === 'main_api' ? '剧情大纲 / 主 API' : '剧情大纲 / 副 API',
      taskType: '剧情大纲生成',
      status: 'success',
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      profileName: apiResult.profileName,
      model: apiResult.model,
      url: apiResult.url,
      httpStatus: apiResult.httpStatus || '',
      messages,
      requestBody: { ...apiResult.requestBody, contextDiagnostics },
      responseText: apiResult.responseText,
      rawResultContent: jsonText,
      parsedResult: draft,
      wordReplacement,
    });

    return { draft, replacements, contextDiagnostics };
  } catch (error) {
    getWorkflowOption('addCommunicationLog')?.({
      moduleName: apiMode === 'main_api' ? '剧情大纲 / 主 API' : '剧情大纲 / 副 API',
      taskType: '剧情大纲生成',
      status: 'failure',
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      profileName: apiResult?.profileName || (apiMode === 'main_api' ? '酒馆当前连接' : ''),
      model: apiResult?.model || (apiMode === 'main_api' ? '酒馆主 API' : ''),
      url: apiResult?.url || (apiMode === 'main_api' ? '酒馆当前连接' : ''),
      httpStatus: apiResult?.httpStatus || '',
      messages,
      requestBody: apiResult?.requestBody
        ? { ...apiResult.requestBody, contextDiagnostics }
        : { contextDiagnostics },
      responseText: apiResult?.responseText || '',
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}
