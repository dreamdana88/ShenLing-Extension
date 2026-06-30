import {
  parsePipeFields,
} from '../../core/summary.js';

const ICONS = Object.freeze({
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
  'book-open': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 0 1 1h7V5H4a1 1 0 0 0-1 1z"/><path d="M21 18a1 1 0 0 1-1 1h-7V5h7a1 1 0 0 1 1 1z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  'circle-help': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.8 1c-.7 1.2-1.9 1.6-2.5 2.5"/><path d="M12 17h.01"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
  route: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6 16V8a3 3 0 0 1 3-3h6"/><path d="M18 8v8a3 3 0 0 1-3 3H9"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
});

const GRAND_CONTROL_FIELDS = new Set(['volume']);
const GRAND_FIELD_RE = /^\s*\[([A-Za-z][\w-]*)\s*:\s*([\s\S]*?)\]\s*$/;

function createElement(tagName, className, text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function createIcon(name) {
  const icon = createElement('span', 'slx-mc-icon');
  icon.dataset.icon = name || 'circle-help';
  icon.innerHTML = ICONS[name] || ICONS['circle-help'];
  return icon;
}

function appendIconLabel(parent, icon, label) {
  parent.append(createIcon(icon));
  parent.append(createElement('span', 'slx-mc-label', label));
}

function parseGrandLines(grandMemoryText) {
  const body = String(grandMemoryText || '')
    .replace(/^<grand_memory\b[^>]*>/i, '')
    .replace(/<\/grand_memory>\s*$/i, '');

  return body
    .split(/\r?\n/)
    .map((line, index) => {
      const match = String(line || '').match(GRAND_FIELD_RE);
      if (!match) return null;
      return {
        key: match[1].trim().toLowerCase(),
        rawKey: match[1].trim(),
        value: match[2].trim(),
        index,
      };
    })
    .filter(Boolean);
}

function getGrandFields(lines, key) {
  const normalizedKey = String(key || '').trim().toLowerCase();
  return lines.filter(line => line.key === normalizedKey).map(line => line.value);
}

function getGrandField(lines, key) {
  return getGrandFields(lines, key)[0] ?? '';
}

function extractGrandVolume(grandMemoryText, lines) {
  const fromParsedLines = getGrandField(lines, 'volume').trim();
  if (fromParsedLines) return fromParsedLines;
  const match = String(grandMemoryText || '').match(/\[\s*volume\s*:\s*([^\]\r\n]+?)\s*\]/i);
  return match?.[1]?.trim() || '未标注';
}

function createThemeToggle(theme = 'light') {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const button = createElement('button', 'slx-mc-theme-toggle', theme === 'dark' ? '☀️' : '🌙');
  button.type = 'button';
  button.dataset.slxMemoryThemeToggle = 'true';
  button.setAttribute('aria-label', `切换大总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`);
  button.title = `切换大总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`;
  return button;
}

function createSingleRow(key, icon, label, value) {
  const row = createElement('div', `slx-mc-row slx-mc-row--${key}`);
  appendIconLabel(row, icon, label);
  row.append(createElement('span', 'slx-mc-value', value));
  return row;
}

function createBlockRow(key, icon, label, value) {
  const block = createElement('section', `slx-mc-block slx-mc-block--${key}`);
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, icon, label);
  block.append(title);
  block.append(createElement('p', 'slx-mc-block-text', value));
  return block;
}

function createSimpleListBlock(key, icon, label, values) {
  const block = createElement('section', `slx-mc-list-block slx-mc-list-block--${key}`);
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, icon, label);
  block.append(title);
  const list = createElement('ul', `slx-mc-list slx-mc-list--${key}`);
  values.forEach(value => {
    const item = createElement('li', `slx-mc-list-item slx-mc-list-item--${key}`);
    item.append(createElement('span', 'slx-mc-part slx-mc-part-1', value));
    list.append(item);
  });
  block.append(list);
  return block;
}

function createPipeListBlock(key, icon, label, values, pipeCount) {
  const block = createElement('section', `slx-mc-list-block slx-mc-list-block--${key}`);
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, icon, label);
  block.append(title);
  const list = createElement('ul', `slx-mc-list slx-mc-list--${key}`);
  values.forEach(value => {
    const parts = parsePipeFields(value, pipeCount).filter(part => part !== '');
    const item = createElement('li', `slx-mc-list-item slx-mc-list-item--${key}`);
    if (parts.length <= 1) {
      item.append(createElement('span', 'slx-mc-value', parts[0] || value));
    } else {
      parts.forEach((part, index) => {
        item.append(createElement('span', `slx-mc-part slx-mc-part-${index + 1}`, part));
      });
    }
    list.append(item);
  });
  block.append(list);
  return block;
}

function createChronicleGroups(lines) {
  const groups = [];
  let active = null;
  lines.forEach(line => {
    if (line.key === 'chronicle') {
      active = {
        chronicle: line.value,
        plots: [],
      };
      groups.push(active);
      return;
    }
    if (line.key === 'plot' && active) {
      active.plots.push(line.value);
    }
  });
  return groups;
}

function createChronicleBlock(lines) {
  const groups = createChronicleGroups(lines);
  if (!groups.length) return null;

  const block = createElement('section', 'slx-mc-list-block slx-mc-list-block--chronicle');
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, 'book-open', '编年');
  block.append(title);
  const list = createElement('ul', 'slx-mc-list slx-mc-list--chronicle');

  groups.forEach(group => {
    const parts = parsePipeFields(group.chronicle, 5);
    const item = createElement('li', 'slx-mc-list-item slx-mc-list-item--chronicle');
    if (parts[0]) item.append(createElement('span', 'slx-mc-part slx-mc-part-1', parts[0]));
    if (parts[1]) item.append(createElement('span', 'slx-mc-part slx-mc-part-2', parts[1]));
    if (parts[2]) item.append(createElement('span', 'slx-mc-part slx-mc-part-3', parts[2]));
    if (parts[3]) item.append(createElement('span', 'slx-mc-part slx-mc-part-4', parts[3]));
    if (parts[4]) item.append(createElement('span', 'slx-mc-part slx-mc-part-5', parts[4]));
    group.plots.forEach(plot => {
      item.append(createElement('p', 'slx-mc-block-text slx-grand-plot-text', plot));
    });
    list.append(item);
  });

  block.append(list);
  return block;
}

function createUnknownRows(lines) {
  const knownKeys = new Set([
    'volume',
    'span',
    'chronicle',
    'plot',
    'arc',
    'db',
    'task',
    'faction',
    'next',
  ]);
  const unknownLines = lines.filter(line => !knownKeys.has(line.key) && !GRAND_CONTROL_FIELDS.has(line.key));
  if (!unknownLines.length) return null;
  return createPipeListBlock(
    'unknown',
    'circle-help',
    '其他',
    unknownLines.map(line => `${line.rawKey}|${line.value}`),
    2,
  );
}

export function renderGrandMemoryCard(grandMemoryText, theme = 'light') {
  const lines = parseGrandLines(grandMemoryText);
  const volume = extractGrandVolume(grandMemoryText, lines);
  const card = createElement('section', 'slx-memory-card slx-grand-memory-card slx-memory-card--collapsed');
  card.dataset.slxGrandMemoryCard = 'true';

  const headerWrap = createElement('div', 'slx-memory-card__header');
  const header = createElement('button', 'slx-memory-card__title');
  header.type = 'button';
  header.setAttribute('aria-expanded', 'false');
  header.title = '展开 / 折叠 grand_memory 记录';

  const titleContent = createElement('span', 'slx-memory-card__title-content');
  const volumeField = createElement('span', 'slx-mc-title-field slx-mc-title-field--volume');
  volumeField.append(createIcon('archive'));
  volumeField.append(createElement('span', 'slx-mc-title-value', volume));
  titleContent.append(volumeField);

  const toggle = createElement('span', 'slx-mc-toggle', '▾');
  header.append(titleContent, toggle);
  headerWrap.append(header, createThemeToggle(theme));
  card.append(headerWrap);

  const body = createElement('div', 'slx-memory-card__body');
  const span = getGrandField(lines, 'span');
  if (span) {
    const parts = parsePipeFields(span, 2).filter(Boolean);
    body.append(createPipeListBlock('span', 'clock', '跨度', [parts.join('|')], 2));
  }

  const chronicleBlock = createChronicleBlock(lines);
  if (chronicleBlock) body.append(chronicleBlock);

  const arcs = getGrandFields(lines, 'arc').filter(Boolean);
  if (arcs.length) body.append(createPipeListBlock('arc', 'heart', '角色弧线', arcs, 5));

  const dbs = getGrandFields(lines, 'db').filter(Boolean);
  if (dbs.length) body.append(createPipeListBlock('db', 'archive', '档案', dbs, 2));

  const task = getGrandField(lines, 'task');
  if (task) body.append(createBlockRow('task', 'target', '主线', task));

  const factions = getGrandFields(lines, 'faction').filter(Boolean);
  if (factions.length) body.append(createPipeListBlock('faction', 'users', '势力', factions, 3));

  const nextItems = getGrandFields(lines, 'next').filter(Boolean);
  if (nextItems.length) body.append(createSimpleListBlock('next', 'route', '下一步', nextItems));

  const unknownRows = createUnknownRows(lines);
  if (unknownRows) body.append(unknownRows);
  if (!body.childNodes.length) {
    body.append(createElement('div', 'slx-mc-empty', '暂无可显示字段'));
  }
  card.append(body);
  return card;
}
