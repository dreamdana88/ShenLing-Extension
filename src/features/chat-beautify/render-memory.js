import {
  getMemoryField,
  getMemoryFields,
  parseMemoryLines,
  parsePipeFields,
} from '../../core/summary.js';
import {
  MEMORY_CONTROL_FIELDS,
  MEMORY_FIELD_CONFIG,
} from './field-config.js';

const ICONS = Object.freeze({
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
  'book-open': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 0 1 1h7V5H4a1 1 0 0 0-1 1z"/><path d="M21 18a1 1 0 0 1-1 1h-7V5h7a1 1 0 0 1 1 1z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  'circle-help': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.8 1c-.7 1.2-1.9 1.6-2.5 2.5"/><path d="M12 17h.01"/></svg>',
  hash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>',
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8"/></svg>',
  'map-pin': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 4.9-8 12-8 12S4 14.9 4 10a8 8 0 1 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
  'message-circle': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-4-.9L3 21l2-4.6a8.4 8.4 0 1 1 16-4.9"/></svg>',
  route: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6 16V8a3 3 0 0 1 3-3h6"/><path d="M18 8v8a3 3 0 0 1-3 3H9"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  'trending-up': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
});

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

function appendIconLabel(parent, config, labelOverride = '') {
  parent.append(createIcon(config.icon));
  const label = createElement('span', 'slx-mc-label', labelOverride || config.label);
  parent.append(label);
}

function getOrderedConfigEntries(slot) {
  return Object.entries(MEMORY_FIELD_CONFIG)
    .filter(([, config]) => config.enabled !== false && config.slot === slot)
    .sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
}

function shouldRenderField(memoryText, key) {
  if (key === 'emotion') {
    const changed = getMemoryField(memoryText, 'emotion_changed').trim().toLowerCase();
    return changed !== 'false';
  }
  if (key === 'affection') {
    const changed = getMemoryField(memoryText, 'affection_changed').trim().toLowerCase();
    return changed === 'true';
  }
  return true;
}

function createTitleField(key, config, value) {
  const field = createElement('span', `slx-mc-title-field slx-mc-title-field--${key}`);
  field.append(createIcon(config.icon));
  const text = createElement('span', 'slx-mc-title-value', value);
  field.append(text);
  return field;
}

function createThemeToggle(theme = 'light') {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const button = createElement('button', 'slx-mc-theme-toggle', theme === 'dark' ? '☀️' : '🌙');
  button.type = 'button';
  button.dataset.slxMemoryThemeToggle = 'true';
  button.setAttribute('aria-label', `切换小总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`);
  button.title = `切换小总结为${nextTheme === 'dark' ? '深色' : '浅色'}主题`;
  return button;
}

function createSingleRow(key, config, value) {
  const row = createElement('div', `slx-mc-row slx-mc-row--${key}`);
  appendIconLabel(row, config);
  row.append(createElement('span', 'slx-mc-value', value));
  return row;
}

function createBlockRow(key, config, value) {
  const block = createElement('section', `slx-mc-block slx-mc-block--${key}`);
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, config);
  block.append(title);
  block.append(createElement('p', 'slx-mc-block-text', value));
  return block;
}

function createMultiRow(key, config, values) {
  const block = createElement('section', `slx-mc-list-block slx-mc-list-block--${key}`);
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, config);
  block.append(title);

  const list = createElement('ul', `slx-mc-list slx-mc-list--${key}`);
  values.forEach((value, valueIndex) => {
    const item = createElement('li', `slx-mc-list-item slx-mc-list-item--${key} slx-mc-list-item-${valueIndex + 1}`);
    const parts = parsePipeFields(value, config.pipe || 0).filter(part => part !== '');
    if (key === 'quote') {
      const speaker = String(parts[0] || '').trim();
      if (speaker === '{{user}}') {
        item.classList.add('slx-mc-list-item--quote-user');
      } else {
        item.classList.add('slx-mc-list-item--quote-character');
      }
    }
    if (parts.length <= 1) {
      item.append(createElement('span', 'slx-mc-value', parts[0] || value));
    } else {
      parts.forEach((part, index) => {
        const partElement = createElement(
          'span',
          `slx-mc-part slx-mc-part-${index + 1}`,
          part,
        );
        item.append(partElement);
      });
    }
    list.append(item);
  });
  block.append(list);
  return block;
}

function createUnknownRows(memoryText) {
  const knownKeys = new Set([...Object.keys(MEMORY_FIELD_CONFIG), ...MEMORY_CONTROL_FIELDS]);
  const unknownLines = parseMemoryLines(memoryText).filter(line => !knownKeys.has(line.key));
  if (!unknownLines.length) return null;

  const config = { icon: 'circle-help', label: '其他' };
  const block = createElement('section', 'slx-mc-list-block slx-mc-list-block--unknown');
  const title = createElement('div', 'slx-mc-block-title');
  appendIconLabel(title, config);
  block.append(title);
  const list = createElement('ul', 'slx-mc-list slx-mc-list--unknown');
  unknownLines.forEach(line => {
    const item = createElement('li', 'slx-mc-list-item');
    item.append(createElement('span', 'slx-mc-part slx-mc-part-1', line.rawKey));
    item.append(createElement('span', 'slx-mc-part slx-mc-part-2', line.value));
    list.append(item);
  });
  block.append(list);
  return block;
}

export function renderMemoryCard(memoryText, theme = 'light') {
  const card = createElement('section', 'slx-memory-card slx-memory-card--collapsed');
  card.dataset.slxMemoryCard = 'true';

  const headerWrap = createElement('div', 'slx-memory-card__header');
  const header = createElement('button', 'slx-memory-card__title');
  header.type = 'button';
  header.setAttribute('aria-expanded', 'false');
  header.title = '展开 / 折叠 memory 记录';

  const titleContent = createElement('span', 'slx-memory-card__title-content');
  getOrderedConfigEntries('title').forEach(([key, config]) => {
    const value = getMemoryField(memoryText, key);
    if (!value) return;
    if (titleContent.childNodes.length) {
      titleContent.append(createElement('span', 'slx-mc-sep', '·'));
    }
    titleContent.append(createTitleField(key, config, value));
  });
  if (!titleContent.childNodes.length) {
    titleContent.append(createElement('span', 'slx-mc-title-field', 'Memory'));
  }

  const toggle = createElement('span', 'slx-mc-toggle', '▾');
  header.append(titleContent, toggle);
  headerWrap.append(header, createThemeToggle(theme));
  card.append(headerWrap);

  const body = createElement('div', 'slx-memory-card__body');
  getOrderedConfigEntries('body').forEach(([key, config]) => {
    if (!shouldRenderField(memoryText, key)) return;
    const values = getMemoryFields(memoryText, key).filter(Boolean);
    if (!values.length) return;
    if (config.mode === 'block') {
      body.append(createBlockRow(key, config, values[0]));
      return;
    }
    if (config.mode === 'multi') {
      body.append(createMultiRow(key, config, values));
      return;
    }
    body.append(createSingleRow(key, config, values[0]));
  });

  const unknownRows = createUnknownRows(memoryText);
  if (unknownRows) body.append(unknownRows);
  if (!body.childNodes.length) {
    body.append(createElement('div', 'slx-mc-empty', '暂无可显示字段'));
  }
  card.append(body);
  return card;
}
