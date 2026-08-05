import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from '../../core/context-resolver.js';
import {
  buildGenerationTransportLog,
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
  notifyBackgroundStreamingFallbackOnce,
  resolveConfiguredGenerationTransport,
} from '../../core/generation.js';
import { replacePromptMessageMacros } from '../../core/macros.js';
import {
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import {
  getBackgroundStreamingEnabled,
  getChatState,
  getContextInfo,
  getGlobalSettings,
  getPlotOutlineState,
  getScheduleSettings,
  getWordReplaceSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  buildSchedulePrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import {
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import { applyWordReplacementToGeneratedContent } from '../word-replace/generated.js';
import { getLongFormGenerationTimeoutMessage, LONG_FORM_GENERATION_TIMEOUT_MS } from '../../constants.js';
import { normalizeScheduleResult } from './model.js';

export { normalizeScheduleResult } from './model.js';

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
};

export const SCHEDULE_GENERATION_TIMEOUT_MS = LONG_FORM_GENERATION_TIMEOUT_MS;

export function configureScheduleWorkflow(options = {}) {
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
    day.theme = replaceField(day.theme);
    day.mainOpportunity = replaceField(day.mainOpportunity);
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
  const settings = getGlobalSettings();
  return replacePromptMessageMacros([
    ...resolvePromptMessages(PROMPT_IDS.SUMMARY_SUPPORT_MESSAGES, settings),
    {
      role: 'user',
      content: buildSchedulePrompt({
        userDirection,
        contextMaterial,
        outlineMaterial,
        template: resolvePromptText(PROMPT_IDS.SCHEDULE_BUILD, settings),
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

export async function runScheduleGeneration({ userDirection } = {}) {
  const info = getContextInfo();
  const scheduleSettings = getScheduleSettings();
  const apiMode = scheduleSettings.apiMode;
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let messages = [];
  let apiResult = null;
  let contextDiagnostics = null;
  let transportPlan = null;

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

    const settings = getGlobalSettings();
    const profile = apiMode === 'secondary_api'
      ? getWorkflowOption('getActiveApiProfile')?.(settings)
      : null;
    transportPlan = resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: getBackgroundStreamingEnabled(settings),
      apiMode,
      profile,
    });
    notifyBackgroundStreamingFallbackOnce(transportPlan.fallbackReason, message => {
      const toastr = globalThis.toastr || globalThis.parent?.toastr;
      toastr?.warning?.(message, '后台流式');
    });
    // 超时文案按 actualMode：stream 请求停止；main legacy wait-only；secondary legacy 取消。
    const timeoutMessage = getLongFormGenerationTimeoutMessage('日程表', apiMode, {
      transportMode: transportPlan.actualMode,
    });

    apiResult = apiMode === 'main_api'
      ? await generateWithMainApi({
        messages,
        timeoutMs: SCHEDULE_GENERATION_TIMEOUT_MS,
        timeoutMessage,
        transportMode: transportPlan.actualMode,
      })
      : await generateWithSecondaryApi({
        profile,
        messages,
        timeoutMs: SCHEDULE_GENERATION_TIMEOUT_MS,
        timeoutMessage,
        transportMode: transportPlan.actualMode,
      });

    const rawContent = apiResult.content;
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
      transport: buildGenerationTransportLog(transportPlan, apiResult),
    });

    return { schedule, replacements, contextDiagnostics };
  } catch (error) {
    const generationErrorContext = getGenerationErrorContext(error);
    const errorCode = generationErrorContext?.code || '';
    const errorStage = generationErrorContext?.stage || '';
    const diagnostics = generationErrorContext?.diagnostics || null;
    getWorkflowOption('addCommunicationLog')?.({
      moduleName: apiMode === 'main_api' ? '日程表 / 主 API' : '日程表 / 副 API',
      taskType: '日程表生成',
      status: 'failure',
      startedAt,
      durationMs: diagnostics?.durationMs ?? Math.round(performance.now() - startedMs),
      profileName: diagnostics?.profileName
        || apiResult?.profileName
        || (apiMode === 'main_api' ? '酒馆当前连接' : ''),
      model: diagnostics?.model
        || apiResult?.model
        || (apiMode === 'main_api' ? '酒馆主 API' : ''),
      url: diagnostics?.url
        || apiResult?.url
        || (apiMode === 'main_api' ? '酒馆当前连接' : ''),
      httpStatus: diagnostics?.httpStatus ?? apiResult?.httpStatus ?? '',
      messages,
      requestBody: apiResult?.requestBody
        ? { ...apiResult.requestBody, contextDiagnostics }
        : { contextDiagnostics },
      responseText: diagnostics?.responseText || apiResult?.responseText || '',
      transport: buildGenerationTransportLog(
        transportPlan || {
          requestedMode: getBackgroundStreamingEnabled() ? 'stream' : 'legacy',
          actualMode: null,
          fallbackReason: null,
          apiMode,
        },
        apiResult,
        diagnostics,
      ),
      errorCode,
      errorStage,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}
