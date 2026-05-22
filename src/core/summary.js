import {
  GRAND_MEMORY_BLOCK_RE,
  LIST_BLOCK_RE,
  MEMORY_BLOCK_RE,
} from '../constants.js';
import {
  DEFAULT_GRAND_MEMORY_TEMPLATE,
  SUMMARY_GAZE_GUIDANCE,
  SUMMARY_SUPPORT_MESSAGES,
} from '../prompts.js';

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
  const match = String(content || '').match(/<number>\s*(\d+)\s*<\/number>/i);
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

export function buildGrandMemoryMaterialPrompt(memoryFrom, memoryTo, archiveMaterial, { regenerate = false, summary = {} } = {}) {
  const grandMemoryTemplate = fillGrandMemoryTemplate(getGrandMemoryPromptTemplate(summary), memoryFrom, memoryTo);
  const verb = regenerate ? '重新生成' : '生成';
  return `蜃灵处于梦境档案编制状态。\n\n${grandMemoryTemplate}\n\n${SUMMARY_GAZE_GUIDANCE}\n\n现在请根据以下梦境记忆${verb}本轮归档大总结。\n请只依据素材内容归纳，不要续写剧情。\n请不要输出 <content>，只输出完整的 <grand_memory>...</grand_memory>。\n\n【梦境记忆素材】\n${archiveMaterial}`;
}

export function buildMemorySummaryPrompt(content, priorMemories = [], summary = {}, options = {}) {
  const priorSection = priorMemories.length > 0
    ? `\n\n【过往梦境档案（编号勿重复）】\n${priorMemories.join('\n\n')}`
    : '';
  const extraInstructions = String(options.extraInstructions || '').trim();
  const extraSection = extraInstructions ? `\n\n${extraInstructions}` : '';
  const outputRule = extraInstructions
    ? '严格按照格式要求输出完整的 <memory>...</memory>，并按附加要求输出其他独立块。'
    : '严格按照格式要求输出完整的 <memory>...</memory>。';
  return `蜃灵处于梦境档案编制状态。\n\n${summary.promptTemplate || ''}\n\n${SUMMARY_GAZE_GUIDANCE}${priorSection}${extraSection}\n\n现在只处理以下本轮素材。请不要续写剧情，不要输出 <content>，${outputRule}\n\n【本轮素材】\n${content}`;
}

export function buildMemorySummaryMessages(prompt) {
  return [
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    { role: 'user', content: prompt },
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
  const normalized = normalizeMemoryBlock(memory);
  if (/<number>[\s\S]*?<\/number>/i.test(normalized)) {
    return normalized.replace(/<number>[\s\S]*?<\/number>/i, `<number>\n${number}\n</number>`);
  }
  return normalized.replace(/<memory>/i, `<memory>\n<number>\n${number}\n</number>`);
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
  return [
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
    '【旧聊天片段】',
    buildLegacyArchiveBatchMaterial(batch),
  ].join('\n');
}

export function buildLegacyArchiveFinalMaterial(batchSummaries) {
  return batchSummaries.map((item, index) => (
    '### 批次 ' + (index + 1) + '（楼层 ' + item.archiveFrom + '-' + item.archiveTo + '）\n' + item.summary
  )).join('\n\n');
}
