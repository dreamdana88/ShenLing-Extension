import {
  DEFAULT_SUMMARY_EXCLUDE_TAGS,
  DEFAULT_SUMMARY_INCLUDE_TAGS,
} from '../constants.js';

export function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mergeDefaults(target, defaults) {
  const output = isPlainObject(target) ? target : {};

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (isPlainObject(defaultValue)) {
      output[key] = mergeDefaults(output[key], defaultValue);
    } else if (!Object.hasOwn(output, key)) {
      output[key] = cloneData(defaultValue);
    }
  }

  return output;
}

export function formatTimestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeTagName(value) {
  return String(value || '')
    .trim()
    .replace(/^<\/?/, '')
    .replace(/>$/, '')
    .replace(/\s.*$/, '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function parseTagList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,，、;；\s]+/);
  return [...new Set(items.map(normalizeTagName).filter(Boolean))];
}

export function formatTagList(value) {
  return parseTagList(value).join(', ');
}

export function getSummarySourceTags(summary) {
  if (!isPlainObject(summary.sourceTags)) {
    summary.sourceTags = {};
  }
  summary.sourceTags.includeTags = Object.hasOwn(summary.sourceTags, 'includeTags')
    ? parseTagList(summary.sourceTags.includeTags)
    : [...DEFAULT_SUMMARY_INCLUDE_TAGS];
  summary.sourceTags.excludeTags = Object.hasOwn(summary.sourceTags, 'excludeTags')
    ? parseTagList(summary.sourceTags.excludeTags)
    : [...DEFAULT_SUMMARY_EXCLUDE_TAGS];
  const oldDefaultExcludeTags = ['thinking', 'wave', 'memory', 'grand_memory'];
  if (oldDefaultExcludeTags.every(tag => summary.sourceTags.excludeTags.includes(tag)) && summary.sourceTags.excludeTags.length === oldDefaultExcludeTags.length) {
    summary.sourceTags.excludeTags = [...DEFAULT_SUMMARY_EXCLUDE_TAGS];
  }
  return summary.sourceTags;
}

export function stripTaggedBlocks(content, tags) {
  return parseTagList(tags).reduce((text, tag) => {
    const safeTag = escapeRegExp(tag);
    const blockRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeTag}>`, 'gi');
    const selfClosingRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?\\/>`, 'gi');
    const orphanOpenRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?>`, 'gi');
    const orphanCloseRe = new RegExp(`<\\/${safeTag}>`, 'gi');
    return text
      .replace(blockRe, '')
      .replace(selfClosingRe, '')
      .replace(orphanOpenRe, '')
      .replace(orphanCloseRe, '');
  }, String(content || ''));
}

export function hasTaggedBlocks(content, tags) {
  const source = String(content || '');
  return parseTagList(tags).some(tag => {
    const safeTag = escapeRegExp(tag);
    const blockRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeTag}>`, 'i');
    const selfClosingRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?\\/>`, 'i');
    return blockRe.test(source) || selfClosingRe.test(source);
  });
}

export function getMeaningfulSourceText(content) {
  return String(content || '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;|&ensp;|&emsp;/gi, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

export function hasMeaningfulSourceContent(content) {
  return getMeaningfulSourceText(content).length > 0;
}

export function extractTaggedBlocks(content, tags) {
  const source = String(content || '');
  return parseTagList(tags).flatMap(tag => {
    const safeTag = escapeRegExp(tag);
    const blockRe = new RegExp(`<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeTag}>`, 'gi');
    return Array.from(source.matchAll(blockRe))
      .map(match => match[1].trim())
      .filter(hasMeaningfulSourceContent);
  });
}

export function extractSummarySourceContent(content, summary = {}) {
  const tags = getSummarySourceTags(summary);
  const withoutExcluded = stripTaggedBlocks(content, tags.excludeTags).replace(/\n{3,}/g, '\n\n').trim();
  const includeTags = parseTagList(tags.includeTags);
  const includedBlocks = extractTaggedBlocks(withoutExcluded, includeTags);
  if (includeTags.length && hasTaggedBlocks(withoutExcluded, includeTags)) {
    return includedBlocks.join('\n\n').trim();
  }
  return hasMeaningfulSourceContent(withoutExcluded) ? withoutExcluded.trim() : '';
}
