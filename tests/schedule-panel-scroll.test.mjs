import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  bindSchedulePanelEvents,
  configureSchedulePanel,
} from '../src/features/schedule/panel.js';

function createDayToggle(index = 0) {
  const listeners = new Map();
  return {
    dataset: { slxScheduleToggleDay: String(index) },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    click() {
      listeners.get('click')?.();
    },
  };
}

function createSchedulePanelRoot(dayToggle) {
  return {
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector === '[data-slx-schedule-toggle-day]' ? [dayToggle] : [];
    },
  };
}

test('DAY 展开和收起都会调用注入的刷新函数', () => {
  const dayToggle = createDayToggle();
  let refreshCount = 0;
  configureSchedulePanel({ refreshPanel: () => { refreshCount += 1; } });
  bindSchedulePanelEvents(createSchedulePanelRoot(dayToggle));

  dayToggle.click();
  dayToggle.click();

  assert.equal(refreshCount, 2);
});

test('Schedule 刷新把当前模块与详情滚动位置传给重渲染', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = indexSource.indexOf('  configureSchedulePanel({');
  const end = indexSource.indexOf('  configureAffectionPanel({', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const moduleGrid = { scrollTop: 73 };
  const detailPanel = { scrollTop: 241 };
  const panelRoot = {
    querySelector(selector) {
      return selector === '.slx-module-grid' ? moduleGrid : detailPanel;
    },
  };
  let scheduleOptions = null;
  const renders = [];
  new Function('configureSchedulePanel', 'renderFloatingPanel', 'panelRoot', indexSource.slice(start, end))(
    options => { scheduleOptions = options; },
    options => { renders.push(options); },
    panelRoot,
  );

  scheduleOptions.refreshPanel();
  assert.deepEqual(renders, [{ moduleScrollTop: 73, detailScrollTop: 241 }]);
});

test('Schedule 重渲染会恢复传入的详情滚动位置而非归零', () => {
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  assert.match(indexSource, /if \(moduleGrid && Number\.isFinite\(options\.moduleScrollTop\)\) \{\s*moduleGrid\.scrollTop = options\.moduleScrollTop;/s);
  assert.match(indexSource, /if \(detailPanel && Number\.isFinite\(options\.detailScrollTop\)\) \{\s*detailPanel\.scrollTop = options\.detailScrollTop;/s);
});
