import { buildApiUrl } from '../../core/api.js';
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
import { replacePromptMessageMacros } from '../../core/macros.js';
import {
  getContextInfo,
  getGlobalSettings,
  getPlotOutlineSettings,
  getWordReplaceSettings,
} from '../../core/settings.js';
import { getOpenAiResponseContent } from '../../core/summary.js';
import {
  buildPlotOutlinePrompt,
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

const OUTLINE_GENERATION_TIMEOUT_MS = 180000;
const VALID_STAGES = ['起', '承', '转', '合'];

export function configurePlotOutlineWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

function withTimeout(promise, timeoutMs = OUTLINE_GENERATION_TIMEOUT_MS) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('剧情大纲生成超时，请稍后重试。')),
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
  return replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    {
      role: 'user',
      content: buildPlotOutlinePrompt({ userDirection, chapterCount, contextMaterial }),
    },
  ]);
}

async function requestPlotOutlineMainApi({ messages }) {
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

async function requestPlotOutlineSecondaryApi({ messages }) {
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
      ? await requestPlotOutlineMainApi({ messages })
      : await requestPlotOutlineSecondaryApi({ messages });

    const rawContent = apiResult.responseJson
      ? getOpenAiResponseContent(apiResult.responseJson)
      : apiResult.responseText;
    const jsonText = stripMarkdownFence(rawContent);
    if (!jsonText) throw new Error('剧情大纲生成结果为空。');

    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('剧情大纲生成结果不是合法 JSON，请重试或检查模型输出。');
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
