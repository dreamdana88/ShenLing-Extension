import { applyReplacementRulesByScope } from './core.js';

const HTML_TEXT_SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TEXTAREA',
  'NOSCRIPT',
  'TEMPLATE',
]);

function createEmptyReplacementResult(content, mode, skippedReason = '') {
  return {
    text: String(content || ''),
    changed: false,
    replacements: 0,
    errors: [],
    mode,
    skippedReason,
  };
}

function applyReplacementToTextNodes(root, settings) {
  let replacements = 0;
  const errors = [];
  let changed = false;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parentTag = node.parentElement?.tagName || '';
        if (HTML_TEXT_SKIP_TAGS.has(parentTag)) return NodeFilter.FILTER_REJECT;
        if (!String(node.nodeValue || '').trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach((node) => {
    const result = applyReplacementRulesByScope(node.nodeValue || '', settings);
    result.errors.forEach((error) => {
      if (!errors.includes(error)) errors.push(error);
    });
    if (result.changed) {
      node.nodeValue = result.text;
      changed = true;
      replacements += result.replacements;
    }
  });

  return { changed, replacements, errors };
}

function applyReplacementToHtml(content, settings) {
  const original = String(content || '');
  if (!original.trim()) return createEmptyReplacementResult(original, 'html');
  if (typeof document === 'undefined' || typeof NodeFilter === 'undefined') {
    return createEmptyReplacementResult(original, 'html', 'html_dom_unavailable');
  }

  try {
    const isFullDocument = /(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(original);
    if (isFullDocument && typeof DOMParser !== 'undefined') {
      const doc = new DOMParser().parseFromString(original, 'text/html');
      const result = applyReplacementToTextNodes(doc.body || doc, settings);
      const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
      const text = `${doctype}${doc.documentElement.outerHTML}`;
      return {
        text,
        changed: result.changed && text !== original,
        replacements: result.replacements,
        errors: result.errors,
        mode: 'html',
        skippedReason: '',
      };
    }

    const template = document.createElement('template');
    template.innerHTML = original;
    const result = applyReplacementToTextNodes(template.content, settings);
    const text = template.innerHTML;
    return {
      text,
      changed: result.changed && text !== original,
      replacements: result.replacements,
      errors: result.errors,
      mode: 'html',
      skippedReason: '',
    };
  } catch (error) {
    return createEmptyReplacementResult(
      original,
      'html',
      `html_replace_failed: ${error?.message || error}`,
    );
  }
}

export function applyWordReplacementToGeneratedContent(content, settings, { mode = 'text' } = {}) {
  const normalizedMode = mode === 'html' ? 'html' : 'text';
  if (normalizedMode === 'html') return applyReplacementToHtml(content, settings);
  const result = applyReplacementRulesByScope(content, settings);
  return {
    ...result,
    mode: 'text',
    skippedReason: '',
  };
}
