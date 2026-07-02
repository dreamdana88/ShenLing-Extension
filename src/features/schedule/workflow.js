import { buildApiUrl } from '../../core/api.js';
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
import { replacePromptMessageMacros } from '../../core/macros.js';
import {
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getPlotOutlineState,
  getScheduleSettings,
  getWordReplaceSettings,
  saveChatState,
} from '../../core/settings.js';
import { getOpenAiResponseContent } from '../../core/summary.js';
import {
  buildSchedulePrompt,
  SUMMARY_SUPPORT_MESSAGES,
} from '../../prompts.js';
import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import { applyWordReplacementToGeneratedContent } from '../word-replace/generated.js';

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getGenerateRawFunction: null,
};

const SCHEDULE_GENERATION_TIMEOUT_MS = 180000;
const VALID_MOVEMENT_STATUS = new Set(['pending', 'active', 'engaged', 'done']);

export function configureScheduleWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

function withTimeout(promise, timeoutMs = SCHEDULE_GENERATION_TIMEOUT_MS) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('日程表生成超时，请稍后重试。')),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
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

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeEntryOption(option, index) {
  const text = cleanText(isPlainObject(option) ? option.text : option);
  if (!text) return null;
  return {
    id: `E${index + 1}`,
    text,
  };
}

function normalizeMovement(movement, index) {
  const source = isPlainObject(movement) ? movement : {};
  const summary = cleanText(source.summary);
  const character = cleanText(source.character);
  if (!summary && !character) return null;
  const status = VALID_MOVEMENT_STATUS.has(cleanText(source.status))
    ? cleanText(source.status)
    : 'pending';
  const durationMinutes = Number(source.durationMinutes);
  const remainingMinutes = Number(source.remainingMinutes);
  return {
    id: `M${index + 1}`,
    character,
    location: cleanText(source.location),
    summary,
    startsAt: cleanText(source.startsAt),
    durationMinutes: Number.isFinite(durationMinutes) ? Math.max(0, Math.round(durationMinutes)) : 0,
    remainingMinutes: Number.isFinite(remainingMinutes) ? Math.max(0, Math.round(remainingMinutes)) : 0,
    status,
    mainlineImpact: cleanText(source.mainlineImpact),
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

  const days = Array.from({ length: 7 }, (_, index) => {
    const source = isPlainObject(rawDays[index]) ? rawDays[index] : {};
    const entryOptions = (Array.isArray(source.entryOptions) ? source.entryOptions : [])
      .map(normalizeEntryOption)
      .filter(Boolean)
      .slice(0, 3)
      .map((option, optionIndex) => ({ ...option, id: `E${optionIndex + 1}` }));
    const characterMovements = (Array.isArray(source.characterMovements) ? source.characterMovements : [])
      .map(normalizeMovement)
      .filter(Boolean)
      .slice(0, 3)
      .map((movement, movementIndex) => ({ ...movement, id: `M${movementIndex + 1}` }));

    return {
      day: index + 1,
      label: cleanText(source.label) || `第${index + 1}天`,
      theme: cleanText(source.theme) || `第${index + 1}天`,
      mainOpportunity: cleanText(source.mainOpportunity),
      entryOptions,
      characterMovements,
      note: cleanText(source.note),
    };
  });

  return {
    title: cleanText(raw.title) || '七日剧情机会表',
    days,
    createdAt: formatTimestamp(),
    updatedAt: formatTimestamp(),
  };
}

function getActiveOutlineChapter(outline) {
  if (!Array.isArray(outline.chapters) || outline.chapters.length === 0) return null;
  return outline.chapters.find(chapter => chapter.id === outline.currentChapterId)
    || outline.chapters[0];
}

function buildOutlineMaterial() {
  const outline = getPlotOutlineState(getChatState());
  const chapter = getActiveOutlineChapter(outline);
  if (!chapter) return '';
  const core = outline.storyCore || {};
  const progress = isPlainObject(outline.progress?.[chapter.id]) ? outline.progress[chapter.id] : {};
  const conditionLines = (Array.isArray(chapter.conditions) ? chapter.conditions : [])
    .map(condition => `${condition.id}. ${condition.text} ${progress[condition.id] ? '已完成' : '未完成'}`);
  return [
    core.logline ? `一句话主线：${core.logline}` : '',
    core.conflict ? `核心冲突：${core.conflict}` : '',
    core.tone ? `叙事基调：${core.tone}` : '',
    `当前章节：${chapter.id} ${chapter.title}`,
    chapter.stage ? `叙事阶段：${chapter.stage}` : '',
    chapter.theme ? `主题：${chapter.theme}` : '',
    chapter.synopsis ? `剧情脉络：${chapter.synopsis}` : '',
    conditionLines.length ? `推进条件：\n${conditionLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function applyWordReplacementToSchedule(schedule) {
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

  schedule.title = replaceField(schedule.title);
  schedule.days.forEach(day => {
    day.label = replaceField(day.label);
    day.theme = replaceField(day.theme);
    day.mainOpportunity = replaceField(day.mainOpportunity);
    day.note = replaceField(day.note);
    day.entryOptions.forEach(option => {
      option.text = replaceField(option.text);
    });
    day.characterMovements.forEach(movement => {
      movement.character = replaceField(movement.character);
      movement.location = replaceField(movement.location);
      movement.summary = replaceField(movement.summary);
      movement.startsAt = replaceField(movement.startsAt);
      movement.mainlineImpact = replaceField(movement.mainlineImpact);
    });
  });

  return { schedule, replacements };
}

function buildScheduleMessages({ userDirection, contextMaterial, outlineMaterial }) {
  return replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    {
      role: 'user',
      content: buildSchedulePrompt({ userDirection, contextMaterial, outlineMaterial }),
    },
  ]);
}

async function requestScheduleMainApi({ messages }) {
  const generateRaw = getWorkflowOption('getGenerateRawFunction')?.();
  if (typeof generateRaw !== 'function') {
    throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
  }
  const requestBody = { prompt: messages };
  const responseText = await withTimeout(
    Promise.resolve().then(() => generateRaw(requestBody)),
  );
  return {
    profileName: '酒馆当前连接',
    model: '酒馆主 API',
    url: '酒馆当前连接',
    requestBody,
    responseText: String(responseText || ''),
  };
}

async function requestScheduleSecondaryApi({ messages }) {
  const profile = getWorkflowOption('getActiveApiProfile')?.(getGlobalSettings());
  if (!profile) throw new Error('当前环境未提供副 API 配置。');
  if (!String(profile.model || '').trim()) {
    throw new Error('请先在设置页选择生成模型。');
  }
  const url = buildApiUrl(profile);
  const requestBody = {
    model: String(profile.model).trim(),
    messages,
    stream: false,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (String(profile.apiKey || '').trim()) {
    headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
  }
  const response = await withTimeout(
    fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) }),
  );
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
  }
  return {
    profileName: profile.name || '未命名副 API',
    model: profile.model,
    url,
    httpStatus: `${response.status} ${response.statusText}`,
    requestBody,
    responseText,
    responseJson,
  };
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

export async function runScheduleGeneration({ userDirection } = {}) {
  const info = getContextInfo();
  const scheduleSettings = getScheduleSettings();
  const apiMode = scheduleSettings.apiMode;
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let messages = [];
  let apiResult = null;
  let contextDiagnostics = null;

  try {
    const context = await resolveShenlingContext({
      purpose: 'schedule',
      targetRoleName: info.characterName,
      recentMessageLimit: 8,
      memoryLimit: 4,
      grandMemoryLimit: 1,
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
    const outlineMaterial = buildOutlineMaterial();
    messages = buildScheduleMessages({ userDirection, contextMaterial, outlineMaterial });

    apiResult = apiMode === 'main_api'
      ? await requestScheduleMainApi({ messages })
      : await requestScheduleSecondaryApi({ messages });

    const rawContent = apiResult.responseJson
      ? getOpenAiResponseContent(apiResult.responseJson)
      : apiResult.responseText;
    const jsonText = stripMarkdownFence(rawContent);
    if (!jsonText) throw new Error('日程表生成结果为空。');

    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      const fallbackText = extractJsonObjectText(jsonText);
      try {
        parsed = JSON.parse(fallbackText);
      } catch {
        throw new Error('日程表生成结果不是合法 JSON，请重试或检查模型输出。');
      }
    }
    const normalized = normalizeScheduleResult(parsed);
    const { schedule, replacements } = applyWordReplacementToSchedule(normalized);
    const wordReplacement = {
      mode: 'text',
      replacements,
      changed: replacements > 0,
      errors: [],
      skippedReason: '',
    };

    getWorkflowOption('addCommunicationLog')?.({
      moduleName: apiMode === 'main_api' ? '日程表 / 主 API' : '日程表 / 副 API',
      taskType: '日程表生成',
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
      parsedResult: schedule,
      wordReplacement,
    });

    return { schedule, replacements, contextDiagnostics };
  } catch (error) {
    getWorkflowOption('addCommunicationLog')?.({
      moduleName: apiMode === 'main_api' ? '日程表 / 主 API' : '日程表 / 副 API',
      taskType: '日程表生成',
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
