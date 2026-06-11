import {
  GRAND_MEMORY_BLOCK_RE,
  LIST_BLOCK_RE,
  MEMORY_BLOCK_RE,
} from '../constants.js';
import {
  DEFAULT_GRAND_MEMORY_TEMPLATE,
  GRAND_SUMMARY_INTERNAL_CHECKLIST,
  LEGACY_ARCHIVE_INTERNAL_CHECKLIST,
  SUMMARY_GAZE_GUIDANCE,
  SUMMARY_INTERNAL_CHECKLIST,
  SUMMARY_SUPPORT_MESSAGES,
} from '../prompts.js';

const PROMPT_BUNDLE_MARKER = '__shenlingPromptBundle';

function createPromptBundle(systemContent, userContent) {
  const cleanSystem = String(systemContent || '').trim();
  const cleanUser = String(userContent || '').trim();
  return {
    [PROMPT_BUNDLE_MARKER]: true,
    systemContent: cleanSystem,
    userContent: cleanUser,
    flatContent: [cleanSystem, cleanUser].filter(Boolean).join('\n\n'),
  };
}

function isPromptBundle(prompt) {
  return Boolean(prompt && typeof prompt === 'object' && prompt[PROMPT_BUNDLE_MARKER]);
}

export function flattenSummaryPrompt(prompt) {
  return isPromptBundle(prompt) ? prompt.flatContent : String(prompt || '');
}

export function getSummaryPromptUserInput(prompt) {
  return isPromptBundle(prompt) ? prompt.userContent : String(prompt || '');
}

export function stripMemoryBlock(content) {
  return String(content || '').replace(MEMORY_BLOCK_RE, '').trim();
}

export function stripListBlocks(content) {
  return String(content || '').replace(LIST_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractMemoryBlocks(content) {
  return Array.from(String(content || '').matchAll(/<memory>[\s\S]*?<\/memory>/gi)).map(match => match[0].trim());
}

export function parseMemoryNumber(content) {
  const text = String(content || '');
  const match = text.match(/\[number\s*:\s*(\d+)\s*\]/i);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function normalizeMemoryBlock(content) {
  const matched = String(content || '').match(/<memory>[\s\S]*?<\/memory>/i);
  if (matched) return matched[0].trim();
  return `<memory>\n${String(content || '').trim()}\n</memory>`;
}

export function normalizeGrandMemoryBlock(content) {
  const matched = String(content || '').match(GRAND_MEMORY_BLOCK_RE);
  if (matched) return matched[0].trim();
  return `<grand_memory>\n${String(content || '').trim()}\n</grand_memory>`;
}

export function forceGrandMemoryRange(content, memoryFrom, memoryTo) {
  const summaryText = `<summary>【梦境档案：第${memoryFrom}-${memoryTo}卷】</summary>`;
  const rangeText = `编号范围：${memoryFrom}-${memoryTo}`;
  let grandMemory = normalizeGrandMemoryBlock(content);

  if (/<summary>[\s\S]*?<\/summary>/i.test(grandMemory)) {
    grandMemory = grandMemory.replace(/<summary>[\s\S]*?<\/summary>/i, summaryText);
  } else if (/<details>/i.test(grandMemory)) {
    grandMemory = grandMemory.replace(/<details>/i, `<details>\n${summaryText}`);
  } else {
    grandMemory = grandMemory.replace(/<grand_memory>/i, `<grand_memory>\n${summaryText}`);
  }

  if (/编号范围[:：][^\r\n]*/i.test(grandMemory)) {
    return grandMemory.replace(/编号范围[:：][^\r\n]*/i, rangeText).trim();
  }

  return grandMemory.replace(/(<summary>[\s\S]*?<\/summary>)/i, `$1\n\n${rangeText}`).trim();
}

export function isGrandMemoryOnly(content) {
  return normalizeGrandMemoryBlock(content) === String(content || '').trim();
}

export function getGrandMemoryPromptTemplate(summary = {}) {
  return String(summary.grandPromptTemplate || DEFAULT_GRAND_MEMORY_TEMPLATE);
}

export function fillGrandMemoryTemplate(template, archiveFrom, archiveTo) {
  return String(template || '')
    .replaceAll('${archiveFrom}', String(archiveFrom))
    .replaceAll('${archiveTo}', String(archiveTo));
}

export function buildGrandMemoryMaterialPrompt(memoryFrom, memoryTo, archiveMaterial, { regenerate = false, summary = {}, extraInstructions = '' } = {}) {
  const grandMemoryTemplate = fillGrandMemoryTemplate(getGrandMemoryPromptTemplate(summary), memoryFrom, memoryTo);
  const verb = regenerate ? '重新生成' : '生成';
  const cleanExtraInstructions = String(extraInstructions || '').trim();
  const outputRule = cleanExtraInstructions
    ? '请不要输出 <content>，只输出完整的 <grand_memory>...</grand_memory>，并按附加要求输出其他独立块。'
    : '请不要输出 <content>，只输出完整的 <grand_memory>...</grand_memory>。';
  const systemContent = [
    '蜃灵处于梦境档案编制状态。',
    '现在是梦境大归档模块，只负责把给定小总结素材压缩为可追溯的大总结，不续写剧情。',
    grandMemoryTemplate,
    SUMMARY_GAZE_GUIDANCE,
    GRAND_SUMMARY_INTERNAL_CHECKLIST,
    cleanExtraInstructions,
    `现在请根据用户提供的梦境记忆${verb}本轮归档大总结。`,
    '请只依据素材内容归纳，不要续写剧情。',
    outputRule,
  ].filter(Boolean).join('\n\n');
  const userContent = `【梦境记忆素材】\n${archiveMaterial}`;
  return createPromptBundle(systemContent, userContent);
}

export function buildTotalGrandMemoryMaterialPrompt(memoryFrom, memoryTo, archiveMaterial, { summary = {} } = {}) {
  const grandMemoryTemplate = fillGrandMemoryTemplate(getGrandMemoryPromptTemplate(summary), memoryFrom, memoryTo);
  const systemContent = [
    '蜃灵处于梦境档案编制状态。',
    '你是蜃灵助手的总档案压缩模块，只负责把多个已有大总结合并为一个更高层梦境总档案，不续写剧情。',
    grandMemoryTemplate,
    SUMMARY_GAZE_GUIDANCE,
    GRAND_SUMMARY_INTERNAL_CHECKLIST,
    '现在请根据用户提供的多个已有大总结，生成一份覆盖完整范围的全新完整大总结。',
    '请按剧情发展重新整合精炼，不要机械拼接旧大总结。',
    '请只依据素材内容归纳，不要续写剧情。',
    '请不要输出 <content>，只输出完整的 <grand_memory>...</grand_memory>。',
  ].filter(Boolean).join('\n\n');
  const userContent = `【已有大总结素材】\n${archiveMaterial}`;
  return createPromptBundle(systemContent, userContent);
}

export function buildMemorySummaryPrompt(content, priorMemories = [], summary = {}, options = {}) {
  const priorSection = priorMemories.length > 0
    ? `【过往梦境档案】\n${priorMemories.join('\n\n')}`
    : '';
  const extraInstructions = String(options.extraInstructions || '').trim();
  const materialInstructions = String(options.materialInstructions || '').trim();
  const outputRule = extraInstructions
    ? '严格按照格式要求输出完整的 <memory>...</memory>，并按附加要求输出其他独立块。'
    : '严格按照格式要求输出完整的 <memory>...</memory>。';
  const systemContent = [
    '蜃灵处于梦境档案编制状态。',
    '现在是梦境小总结模块，只需把用户提供的本轮素材压缩为剧情档案。',
    summary.promptTemplate || '',
    SUMMARY_GAZE_GUIDANCE,
    SUMMARY_INTERNAL_CHECKLIST,
    materialInstructions,
    extraInstructions,
    `请不要续写剧情，不要输出 <content>，${outputRule}`,
  ].filter(Boolean).join('\n\n');
  const userContent = [
    priorSection,
    `【本轮素材】\n${content}`,
  ].filter(Boolean).join('\n\n');
  return createPromptBundle(systemContent, userContent);
}

export function buildOpeningSummaryPromptContent(openingContent, characterFoundation = '') {
  const cleanOpeningContent = String(openingContent || '').trim();
  const cleanCharacterFoundation = String(characterFoundation || '').trim();
  if (!cleanCharacterFoundation) {
    return `【0楼正文】\n${cleanOpeningContent}`;
  }

  return `【角色基础信息】\n${cleanCharacterFoundation}\n\n【0楼正文】\n${cleanOpeningContent}`;
}

export function buildMemorySummaryMessages(prompt) {
  if (isPromptBundle(prompt)) {
    return [
      ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
      { role: 'system', content: prompt.systemContent },
      { role: 'user', content: prompt.userContent },
    ];
  }

  return [
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    { role: 'user', content: String(prompt || '') },
  ];
}

export function getOpenAiResponseContent(data) {
  const firstChoice = data?.choices?.[0];
  const messageContent = firstChoice?.message?.content;
  if (typeof messageContent === 'string') return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent.map(item => (typeof item === 'string' ? item : item?.text || '')).join('');
  }
  if (typeof firstChoice?.text === 'string') return firstChoice.text;
  return '';
}

export function buildSummaryPromptContent(aiContent, userContent = '') {
  const cleanAiContent = String(aiContent || '').trim();
  const cleanUserContent = String(userContent || '').trim();
  if (!cleanUserContent) return cleanAiContent;
  return `【最新用户输入】
${cleanUserContent}

【最新正文】
${cleanAiContent}`;
}

export function forceMemoryNumber(memory, number) {
  const normalized = normalizeMemoryBlock(memory)
    .replace(/<number>[\s\S]*?<\/number>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const numberLine = `[number:${number}]`;
  if (/\[number\s*:[^\]]*\]/i.test(normalized)) {
    return normalized.replace(/\[number\s*:[^\]]*\]/i, numberLine);
  }
  return normalized.replace(/<memory\b[^>]*>/i, match => `${match}\n${numberLine}`);
}

export function getLegacyArchiveBatchSize(summary = {}) {
  const value = Number.parseInt(String(summary.legacyArchiveBatchSize || '').trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : 30;
}

export function createLegacyArchiveBatches(entries, batchSize) {
  const safeBatchSize = Math.max(1, Number(batchSize) || 30);
  const batches = [];
  for (let index = 0; index < entries.length; index += safeBatchSize) {
    batches.push(entries.slice(index, index + safeBatchSize));
  }
  return batches;
}

export function buildLegacyArchiveBatchMaterial(batch) {
  return batch.map(entry => (
    '### 第 ' + entry.messageId + ' 楼｜' + entry.role + '\n' + entry.content
  )).join('\n\n');
}

export function buildLegacyArchiveBatchPrompt(batch, batchIndex, batchTotal) {
  const firstId = batch[0]?.messageId ?? '?';
  const lastId = batch.at(-1)?.messageId ?? '?';
  const systemContent = [
    '蜃灵处于梦境档案编制状态。',
    '',
    '请把以下旧聊天片段压缩为批次归档摘要。',
    '这是第 ' + (batchIndex + 1) + ' / ' + batchTotal + ' 批，楼层范围 ' + firstId + '-' + lastId + '。',
    '要求：',
    '1. 严格按时间顺序梳理剧情。',
    '2. 保留时间、地点、人物、关键互动、重要台词、世界设定和未解决伏笔。',
    '3. 不要续写剧情，不要输出 <content>、<memory> 或 <grand_memory>。',
    '4. 输出独立可读的纯文本批次摘要。',
    '',
    LEGACY_ARCHIVE_INTERNAL_CHECKLIST,
  ].join('\n');
  const userContent = [
    '【旧聊天片段】',
    buildLegacyArchiveBatchMaterial(batch),
  ].join('\n');
  return createPromptBundle(systemContent, userContent);
}

export function buildLegacyArchiveFinalMaterial(batchSummaries) {
  return batchSummaries.map((item, index) => (
    '### 批次 ' + (index + 1) + '（楼层 ' + item.archiveFrom + '-' + item.archiveTo + '）\n' + item.summary
  )).join('\n\n');
}
