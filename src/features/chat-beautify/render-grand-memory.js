import {
  parsePipeFields,
} from '../../core/summary.js';

const ICONS = Object.freeze({
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
  'book-open': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 0 1 1h7V5H4a1 1 0 0 0-1 1z"/><path d="M21 18a1 1 0 0 1-1 1h-7V5h7a1 1 0 0 1 1 1z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  hash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8"/></svg>',
  route: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6 16V8a3 3 0 0 1 3-3h6"/><path d="M18 8v8a3 3 0 0 1-3 3H9"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
});

const GRAND_CONTROL_FIELDS = new Set(['volume']);
const GRAND_FIELD_RE = /^\s*\[([A-Za-z][\w-]*)\s*:\s*([\s\S]*?)\]\s*$/;
const EVENT_COLORS = ['#b6a48a', '#cf9a86', '#c79a9a', '#a8a0c4', '#93b5c9', '#9bbbb0'];
const ARC_THEMES = Object.freeze([
  { accent: '#c2806f', bg: 'rgba(224, 169, 154, 0.16)', border: 'rgba(194, 128, 111, 0.22)' },
  { accent: '#b18b4f', bg: 'rgba(218, 184, 119, 0.17)', border: 'rgba(177, 139, 79, 0.22)' },
  { accent: '#8f729f', bg: 'rgba(168, 150, 190, 0.17)', border: 'rgba(143, 114, 159, 0.22)' },
  { accent: '#6f9a8d', bg: 'rgba(139, 184, 169, 0.17)', border: 'rgba(111, 154, 141, 0.22)' },
]);

function createElement(tagName, className, text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function createIcon(name, className = 'slx-mc-icon') {
  const icon = createElement('span', className);
  icon.dataset.icon = name || 'target';
  icon.innerHTML = ICONS[name] || ICONS.target;
  return icon;
}

function createColorTargetIcon() {
  const icon = createElement('span', 'slx-mc-icon slx-grand-target-icon');
  icon.dataset.icon = 'target-color';
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#6f93bf"/><circle cx="12" cy="12" r="5.5" stroke="#c2806f"/><circle cx="12" cy="12" r="2" fill="#d7a64f" stroke="#d7a64f"/></svg>';
  return icon;
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
  const button = createElement('button', 'slx-mc-theme-toggle slx-grand-theme-toggle', theme === 'dark' ? '☀️' : '🌙');
  button.type = 'button';
  button.dataset.slxMemoryThemeToggle = 'true';
  button.setAttribute('aria-label', `切换大总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`);
  button.title = `切换大总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`;
  return button;
}

function createArrow(className) {
  return createElement('span', className, '▾');
}

function splitQuote(value) {
  const raw = String(value || '').trim();
  const index = raw.indexOf('»');
  if (index < 0) return ['', raw];
  return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()];
}

function createChronicleGroups(lines) {
  const groups = [];
  let active = null;
  lines.forEach(line => {
    if (line.key === 'chronicle') {
      active = { chronicle: line.value, plots: [] };
      groups.push(active);
      return;
    }
    if (line.key === 'plot' && active) {
      active.plots.push(line.value);
    }
  });
  return groups;
}

function createGrandSection(key, icon, label, count, color, children, collapsed = false) {
  const section = createElement('section', `slx-grand-section slx-grand-section--${key}${collapsed ? ' slx-grand-section--collapsed' : ''}`);
  section.style.setProperty('--slx-grand-section-color', color);

  const head = createElement('button', 'slx-grand-section__head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(!collapsed));
  head.append(createIcon(icon), createElement('span', 'slx-grand-section__label', label));
  if (count) head.append(createElement('span', 'slx-grand-section__count', count));
  head.append(createArrow('slx-grand-section__arrow'));
  section.append(head);

  const content = createElement('div', 'slx-grand-section__content');
  children.filter(Boolean).forEach(child => content.append(child));
  section.append(content);
  return section;
}

function createMetaChip(icon, value) {
  const chip = createElement('span', 'slx-grand-event__meta-chip');
  chip.append(createIcon(icon, 'slx-mc-icon slx-grand-icon-sm'), document.createTextNode(value));
  return chip;
}

function createChronicleEvent(group, index) {
  const parts = parsePipeFields(group.chronicle, 5);
  const [seg, name, timestamp, characters, quoteRaw] = parts;
  const event = createElement('article', 'slx-grand-event slx-grand-event--collapsed');
  event.style.setProperty('--slx-grand-event-color', EVENT_COLORS[index % EVENT_COLORS.length]);

  const head = createElement('button', 'slx-grand-event__head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');
  if (seg) head.append(createElement('span', 'slx-grand-event__seg', seg));
  head.append(createElement('span', 'slx-grand-event__name', name || '未命名事件'));
  head.append(createArrow('slx-grand-event__arrow'));
  event.append(head);

  const detail = createElement('div', 'slx-grand-event__detail');
  const meta = createElement('div', 'slx-grand-event__meta');
  if (timestamp) meta.append(createMetaChip('clock', timestamp));
  if (characters) meta.append(createMetaChip('users', characters));
  if (meta.childNodes.length) detail.append(meta);

  const [speaker, quote] = splitQuote(quoteRaw);
  if (speaker || quote) {
    const quoteElement = createElement('div', 'slx-grand-event__quote');
    if (speaker) quoteElement.append(createElement('span', 'slx-grand-event__speaker', speaker));
    if (quote) quoteElement.append(createElement('span', 'slx-grand-event__line', quote));
    detail.append(quoteElement);
  }

  group.plots.forEach(plot => {
    detail.append(createElement('p', 'slx-grand-event__plot', plot));
  });

  event.append(detail);
  return event;
}

function createChronicleSection(lines) {
  const groups = createChronicleGroups(lines);
  if (!groups.length) return null;
  return createGrandSection(
    'chronicle',
    'book-open',
    '编年',
    `${groups.length} 个事件`,
    '#b6a48a',
    groups.map(createChronicleEvent),
  );
}

function createArcCard(value, index) {
  const [name, start, turn, end, relation] = parsePipeFields(value, 5);
  const theme = ARC_THEMES[index % ARC_THEMES.length];
  const card = createElement('article', 'slx-grand-arc');
  card.style.setProperty('--slx-grand-arc-bg', theme.bg);
  card.style.setProperty('--slx-grand-arc-border', theme.border);
  card.style.setProperty('--slx-grand-arc-accent', theme.accent);

  card.append(createElement('div', 'slx-grand-arc__name', name || '未命名角色'));
  const flow = createElement('div', 'slx-grand-arc__flow');
  [start, turn, end].filter(Boolean).forEach((part, partIndex) => {
    if (partIndex > 0) flow.append(createElement('span', 'slx-grand-arc__sep', '→'));
    flow.append(createElement('span', 'slx-grand-arc__node', part));
  });
  if (flow.childNodes.length) card.append(flow);
  if (relation) card.append(createElement('div', 'slx-grand-arc__rel', `关系：${relation}`));
  return card;
}

function createKvCard(key, value, extraClass = '') {
  const card = createElement('div', `slx-grand-kv${extraClass ? ` ${extraClass}` : ''}`);
  if (key) card.append(createElement('span', 'slx-grand-kv__key', key));
  if (value) card.append(createElement('span', 'slx-grand-kv__value', value));
  return card;
}

function createDbSection(lines) {
  const dbs = getGrandFields(lines, 'db').filter(Boolean);
  if (!dbs.length) return null;
  return createGrandSection(
    'db',
    'archive',
    '档案',
    `${dbs.length} 条`,
    '#7fa05f',
    dbs.map(value => {
      const [key, detail] = parsePipeFields(value, 2);
      return createKvCard(key, detail, 'slx-grand-kv--db');
    }),
    true,
  );
}

function createStatusSection(lines) {
  const children = [];
  const task = getGrandField(lines, 'task');
  if (task) {
    const taskElement = createElement('div', 'slx-grand-task');
    taskElement.append(createColorTargetIcon(), createElement('b', '', '主线：'), document.createTextNode(task));
    children.push(taskElement);
  }

  getGrandFields(lines, 'faction').filter(Boolean).forEach(value => {
    const [name, goal, state] = parsePipeFields(value, 3);
    children.push(createKvCard(name, [goal, state].filter(Boolean).join('｜'), 'slx-grand-kv--faction'));
  });

  const nextItems = getGrandFields(lines, 'next').filter(Boolean);
  if (nextItems.length) {
    const list = createElement('div', 'slx-grand-next-list');
    nextItems.forEach(value => list.append(createElement('div', 'slx-grand-next-item', value)));
    children.push(list);
  }

  if (!children.length) return null;
  return createGrandSection('status', 'users', '状态与势力', '', '#6f93bf', children, true);
}

function createUnknownSection(lines) {
  const knownKeys = new Set(['volume', 'span', 'chronicle', 'plot', 'arc', 'db', 'task', 'faction', 'next']);
  const unknownLines = lines.filter(line => !knownKeys.has(line.key) && !GRAND_CONTROL_FIELDS.has(line.key));
  if (!unknownLines.length) return null;
  return createGrandSection(
    'unknown',
    'target',
    '其他',
    `${unknownLines.length} 条`,
    '#8f729f',
    unknownLines.map(line => createKvCard(line.rawKey, line.value)),
    true,
  );
}

export function renderGrandMemoryCard(grandMemoryText, theme = 'light') {
  const lines = parseGrandLines(grandMemoryText);
  const volume = extractGrandVolume(grandMemoryText, lines);
  const span = parsePipeFields(getGrandField(lines, 'span'), 2).filter(Boolean);

  const card = createElement('section', 'slx-memory-card slx-grand-memory-card slx-grand-card');
  card.dataset.slxGrandMemoryCard = 'true';

  const headerWrap = createElement('div', 'slx-memory-card__header slx-grand-card__header');
  const header = createElement('button', 'slx-memory-card__title slx-grand-card__title');
  header.type = 'button';
  header.setAttribute('aria-expanded', 'true');
  header.title = '展开 / 折叠 grand_memory 记录';

  const titleContent = createElement('span', 'slx-memory-card__title-content slx-grand-title-content');
  const volumeField = createElement('span', 'slx-mc-title-field slx-mc-title-field--volume slx-grand-title-volume');
  volumeField.append(createIcon('hash'));
  volumeField.append(createElement('span', 'slx-mc-title-value slx-grand-volume-value', volume));
  titleContent.append(volumeField);

  if (span.length) {
    const spanField = createElement('span', 'slx-grand-title-span');
    spanField.append(createIcon('clock', 'slx-mc-icon slx-grand-icon-sm'));
    spanField.append(document.createTextNode(span.join(' · ')));
    titleContent.append(spanField);
  }

  header.append(titleContent, createArrow('slx-mc-toggle slx-grand-card__toggle'));
  headerWrap.append(header, createThemeToggle(theme));
  card.append(headerWrap);

  const body = createElement('div', 'slx-memory-card__body slx-grand-card__body');
  const sections = [
    createChronicleSection(lines),
    getGrandFields(lines, 'arc').filter(Boolean).length
      ? createGrandSection(
        'arc',
        'heart',
        '角色弧线',
        `${getGrandFields(lines, 'arc').filter(Boolean).length} 人`,
        '#c2806f',
        getGrandFields(lines, 'arc').filter(Boolean).map(createArcCard),
        true,
      )
      : null,
    createDbSection(lines),
    createStatusSection(lines),
    createUnknownSection(lines),
  ];

  sections.filter(Boolean).forEach(section => body.append(section));
  if (!body.childNodes.length) {
    body.append(createElement('div', 'slx-mc-empty', '暂无可显示字段'));
  }
  card.append(body);
  return card;
}
