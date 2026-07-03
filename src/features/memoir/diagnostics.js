// 临时诊断模块：回忆录世界书 API 探测 + 读写验收。
// 用途：跑通「阶段一：技术验证」的五项验收，确认 TavernHelper 世界书 API（或 ST 原生回退）
// 能创建 / 绑定 / 写入 / 读回聊天专属世界书。
// 注意：这是临时开发诊断，回忆录功能正式落地后应删除本文件与其在设置页的入口。

import { getContextSafe } from '../../core/chat.js';
import { getMemoirState } from '../../core/settings.js';
import { collectRecentGrandMemories } from '../../core/context-resolver.js';
import { generateSummaryMemory } from '../summary/workflow.js';
import { escapeHtml } from '../../utils/text.js';
import { ensureMemoirWorldbook, tryExtractMemoirFromGrandSummary } from './workflow.js';

// TavernHelper 世界书 API 需要探测的函数名（见 @types/function/worldbook.d.ts）
const TH_WORLDBOOK_FNS = [
  'getChatWorldbookName',
  'getOrCreateChatWorldbook',
  'rebindChatWorldbook',
  'getWorldbookNames',
  'createWorldbook',
  'getWorldbook',
  'createWorldbookEntries',
  'updateWorldbookWith',
  'replaceWorldbook',
  'deleteWorldbook',
  'deleteWorldbookEntries',
];

// ST 原生 world-info.js 回退路径（同 context-resolver 的动态 import 兜底策略）
const ST_WORLD_INFO_MODULE_PATHS = [
  '../../../../../world-info.js',
  '../../../../world-info.js',
  '../../../world-info.js',
];
const ST_WORLD_INFO_FNS = ['createNewWorldInfo', 'loadWorldInfo', 'saveWorldInfo', 'createWorldInfoEntry'];

let diagnosticsOptions = { refreshPanel: null };

// 诊断运行态
let state = {
  running: false,
  prevBoundName: undefined, // 创建测试书前的原绑定，用于还原（undefined=未记录，null=原本无绑定）
  testBookName: '',
  readBack: null, // 读回的条目数组，用于字段核对
  log: [],
};

export function configureMemoirDiagnosticsPanel(options = {}) {
  diagnosticsOptions = { ...diagnosticsOptions, ...options };
}

function refreshPanel() {
  if (typeof diagnosticsOptions.refreshPanel === 'function') {
    diagnosticsOptions.refreshPanel();
  }
}

function logLine(msg) {
  const stamp = new Date().toLocaleTimeString();
  state.log.push(`[${stamp}] ${msg}`);
  if (state.log.length > 40) state.log = state.log.slice(-40);
}

// ── TavernHelper 定位 ────────────────────────────────────────────────
function getTavernHelperRoots() {
  const roots = [];
  try { if (globalThis.TavernHelper) roots.push(globalThis.TavernHelper); } catch {}
  try { if (globalThis.parent?.TavernHelper) roots.push(globalThis.parent.TavernHelper); } catch {}
  try { if (globalThis.top?.TavernHelper) roots.push(globalThis.top.TavernHelper); } catch {}
  return roots;
}

function resolveThFn(name) {
  for (const root of getTavernHelperRoots()) {
    if (root && typeof root[name] === 'function') return root[name].bind(root);
  }
  try { if (typeof globalThis[name] === 'function') return globalThis[name]; } catch {}
  try { if (typeof globalThis.parent?.[name] === 'function') return globalThis.parent[name]; } catch {}
  return null;
}

function requireThFn(name) {
  const fn = resolveThFn(name);
  if (!fn) throw new Error(`未找到 TavernHelper.${name}（请确认已安装酒馆助手，或改用 ST 原生回退路）`);
  return fn;
}

async function probeStWorldInfoModule() {
  for (const path of ST_WORLD_INFO_MODULE_PATHS) {
    try {
      const mod = await import(/* webpackIgnore: true */ path);
      if (mod) return mod;
    } catch {}
  }
  return null;
}

// ── 上下文读取 ───────────────────────────────────────────────────────
function getChatIdSafe() {
  try {
    const ctx = getContextSafe();
    if (ctx && typeof ctx.getCurrentChatId === 'function') return ctx.getCurrentChatId() ?? null;
  } catch {}
  return null;
}

function sanitizeForName(raw) {
  return String(raw || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

function buildTestBookName() {
  const chatId = getChatIdSafe();
  return `蜃灵回忆录诊断｜${chatId ? sanitizeForName(chatId) : 'nochat'}`;
}

// ── 测试条目模板（严格按新 schema，与搭建步骤 §2 一致）────────────────
function buildTestEntries() {
  return [
    {
      name: '【回忆录总览·诊断】',
      enabled: true,
      strategy: {
        type: 'constant', // 蓝灯
        keys: [],
        keys_secondary: { logic: 'and_any', keys: [] },
        scan_depth: 'same_as_global',
      },
      position: { type: 'after_character_definition', role: 'system', depth: 0, order: 50 },
      content: '【诊断】蓝灯总览测试条目。可唤起回忆：初识、雨夜约定。',
      probability: 100,
      recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
      extra: { memoirRole: 'overview', memoirId: 'diag-blue-1', diagnostic: true },
    },
    {
      name: '【回忆·雨夜约定·诊断】',
      enabled: true,
      strategy: {
        type: 'selective', // 绿灯
        keys: ['卡卡西', '旗木卡卡西'],
        keys_secondary: { logic: 'and_any', keys: ['雨夜约定', '别丢下我'] },
        scan_depth: 'same_as_global',
      },
      position: { type: 'after_character_definition', role: 'system', depth: 0, order: 100 },
      content: '【诊断】绿灯详情测试条目。正文不含楼层来源信息。',
      probability: 100,
      recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
      extra: {
        memoirId: 'diag-green-1',
        sourceType: 'grand_memory',
        sourceRange: '第10-18楼',
        importance: 'high',
        diagnostic: true,
      },
    },
  ];
}

// ── 渲染 ─────────────────────────────────────────────────────────────
function renderReadBack() {
  if (!Array.isArray(state.readBack) || !state.readBack.length) return '';
  const rows = state.readBack
    .filter(e => e?.extra?.diagnostic || String(e?.name || '').includes('诊断'))
    .map(e => {
      const s = e.strategy || {};
      const sec = s.keys_secondary || {};
      const rec = e.recursion || {};
      const pos = e.position || {};
      const lines = [
        `name: ${e.name}`,
        `strategy.type: ${s.type}`,
        `keys: [${(s.keys || []).join(', ')}]`,
        `keys_secondary.logic: ${sec.logic} keys: [${(sec.keys || []).join(', ')}]`,
        `recursion: incoming=${rec.prevent_incoming} outgoing=${rec.prevent_outgoing}`,
        `position: ${pos.type} order=${pos.order}`,
        `extra: ${JSON.stringify(e.extra || {})}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
  return `
    <div class="slx-detail-kicker">读回条目字段核对</div>
    <pre class="slx-diag-pre">${escapeHtml(rows || '（未找到诊断条目）')}</pre>
  `;
}

export function renderMemoirWorldbookDiagnostics() {
  const thFound = getTavernHelperRoots().length > 0;
  const presentFns = TH_WORLDBOOK_FNS.filter(n => !!resolveThFn(n));
  const missingFns = TH_WORLDBOOK_FNS.filter(n => !resolveThFn(n));
  const chatId = getChatIdSafe();
  const disabled = state.running ? 'disabled' : '';

  return `
    <div class="slx-detail-card slx-muted-card">
      <div class="slx-detail-title">回忆录世界书 · 读写诊断（临时）</div>
      <p>跑通阶段一五项验收：读绑定 → 创建并绑定 → 写条目 → 读回核对 → 还原绑定。</p>
      <div class="slx-info-line"><span>TavernHelper 根对象</span><b>${thFound ? '已发现' : '未发现'}</b></div>
      <div class="slx-info-line"><span>可用世界书函数</span><b>${escapeHtml(presentFns.length)} / ${TH_WORLDBOOK_FNS.length}</b></div>
      ${missingFns.length ? `<div class="slx-info-line"><span>缺失函数</span><b>${escapeHtml(missingFns.join(', '))}</b></div>` : ''}
      <div class="slx-info-line"><span>当前聊天 ID</span><b>${escapeHtml(chatId || '未读取')}</b></div>
      <div class="slx-info-line"><span>测试世界书名</span><b>${escapeHtml(state.testBookName || buildTestBookName())}</b></div>
      <div class="slx-action-row">
        <button class="slx-soft-btn" type="button" data-slx-memoir-probe ${disabled}>探测 API</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-read-bind ${disabled}>① 读绑定</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-create-bind ${disabled}>② 创建并绑定</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-write ${disabled}>③ 写测试条目</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-readback ${disabled}>④ 读回核对</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-restore ${disabled}>⑤ 还原并删测试书</button>
      </div>
      <div class="slx-action-row">
        <button class="slx-soft-btn" type="button" data-slx-memoir-ensure ${disabled}>⑥ ensureMemoirWorldbook（策略A·写真实状态）</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-extract ${disabled}>⑦ 试跑提炼（读最新大总结·不写入）</button>
        <button class="slx-soft-btn" type="button" data-slx-memoir-clear-log ${disabled}>清空日志</button>
      </div>
      <p class="slx-muted">切卡不串档验收：先「② 创建并绑定」，切换到另一个聊天后点「① 读绑定」，应显示 null 或不同世界书。</p>
      <p class="slx-muted">⑥ 会写真实 chatState.memoir：无绑定→新建「蜃灵回忆录｜聊天」并绑定；已有绑定→复用那本（策略A）。</p>
      ${renderReadBack()}
      <div class="slx-detail-kicker">运行日志</div>
      <pre class="slx-diag-pre">${escapeHtml(state.log.join('\n') || '（暂无）')}</pre>
    </div>
  `;
}

// ── 动作 ─────────────────────────────────────────────────────────────
async function withRunning(fn) {
  if (state.running) return;
  state.running = true;
  refreshPanel();
  try {
    await fn();
  } catch (error) {
    logLine(`❌ ${error.message || String(error)}`);
  } finally {
    state.running = false;
    refreshPanel();
  }
}

async function actionProbe() {
  const roots = getTavernHelperRoots();
  logLine(`探测：TavernHelper 根对象 ${roots.length} 个`);
  for (const n of TH_WORLDBOOK_FNS) {
    logLine(`  TH.${n}: ${resolveThFn(n) ? '✅' : '—'}`);
  }
  const mod = await probeStWorldInfoModule();
  if (mod) {
    logLine('ST 原生 world-info.js：已加载');
    for (const n of ST_WORLD_INFO_FNS) {
      logLine(`  ST.${n}: ${typeof mod[n] === 'function' ? '✅' : '—'}`);
    }
  } else {
    logLine('ST 原生 world-info.js：未能动态 import（回退路不可用）');
  }
}

async function actionReadBind() {
  const getName = requireThFn('getChatWorldbookName');
  const name = await getName('current');
  logLine(`① 当前聊天绑定世界书：${name === null ? 'null（无绑定）' : name}`);
}

async function actionCreateBind() {
  const getOrCreate = requireThFn('getOrCreateChatWorldbook');
  const getName = requireThFn('getChatWorldbookName');

  // 记录原绑定，便于还原（仅第一次记录，避免覆盖）
  if (state.prevBoundName === undefined) {
    try {
      state.prevBoundName = await getName('current');
      logLine(`② 已记录原绑定用于还原：${state.prevBoundName === null ? 'null' : state.prevBoundName}`);
    } catch {
      state.prevBoundName = null;
    }
  }

  const bookName = buildTestBookName();
  state.testBookName = bookName;
  const returned = await getOrCreate('current', bookName);
  logLine(`② getOrCreateChatWorldbook 返回：${returned}`);

  const nowBound = await getName('current');
  logLine(`② 现绑定：${nowBound}（期望 = ${bookName}）${nowBound === bookName ? ' ✅' : ' ⚠️不一致'}`);
}

async function actionWriteEntries() {
  const create = requireThFn('createWorldbookEntries');
  const bookName = state.testBookName || buildTestBookName();
  state.testBookName = bookName;
  const entries = buildTestEntries();
  const result = await create(bookName, entries);
  const newCount = result?.new_entries?.length ?? 0;
  logLine(`③ 已写入 ${newCount} 条（蓝灯 constant + 绿灯 selective，均禁递归）到「${bookName}」`);
}

async function actionReadBack() {
  const getBook = requireThFn('getWorldbook');
  const bookName = state.testBookName || buildTestBookName();
  const book = await getBook(bookName);
  state.readBack = Array.isArray(book) ? book : [];
  logLine(`④ 读回「${bookName}」共 ${state.readBack.length} 条，开始字段往返断言：`);

  const blue = state.readBack.find(e => e?.extra?.memoirId === 'diag-blue-1');
  const green = state.readBack.find(e => e?.extra?.memoirId === 'diag-green-1');

  const checks = [];
  const check = (label, ok) => checks.push(`${ok ? '  ✅' : '  ❌'} ${label}`);

  if (!green) {
    check('绿灯条目按 extra.memoirId 找回', false);
  } else {
    check('绿灯 strategy.type=selective', green.strategy?.type === 'selective');
    check('绿灯 keys 含「卡卡西」', (green.strategy?.keys || []).includes('卡卡西'));
    check('绿灯 keys_secondary.logic=and_any', green.strategy?.keys_secondary?.logic === 'and_any');
    check('绿灯 过滤器含「雨夜约定」', (green.strategy?.keys_secondary?.keys || []).includes('雨夜约定'));
    check('绿灯 禁递归 incoming+outgoing', green.recursion?.prevent_incoming === true && green.recursion?.prevent_outgoing === true);
    check('绿灯 position=after_character_definition', green.position?.type === 'after_character_definition');
    check('绿灯 extra.sourceRange 保留', !!green.extra?.sourceRange);
  }

  if (!blue) {
    check('蓝灯条目按 extra.memoirId 找回', false);
  } else {
    check('蓝灯 strategy.type=constant', blue.strategy?.type === 'constant');
    check('蓝灯 禁出向递归（防批量点亮绿灯）', blue.recursion?.prevent_outgoing === true);
    check('蓝灯 extra.memoirRole=overview', blue.extra?.memoirRole === 'overview');
  }

  checks.forEach(logLine);
  const failed = checks.filter(c => c.includes('❌')).length;
  logLine(failed === 0 ? '④ 字段往返全部通过 🎉' : `④ ${failed} 项未通过（见上，可能被 ST 规范化/丢弃）`);
}

async function actionRestore() {
  const rebind = requireThFn('rebindChatWorldbook');
  const del = resolveThFn('deleteWorldbook');
  const bookName = state.testBookName || buildTestBookName();

  // 还原原绑定（测试 rebindChatWorldbook = 替换绑定）
  const restoreTo = state.prevBoundName;
  if (restoreTo === undefined || restoreTo === null) {
    // 原本无绑定：新 API rebindChatWorldbook 只收 string，用旧 API setChatLorebook(null) 解绑
    const unbind = resolveThFn('setChatLorebook');
    if (unbind) {
      await unbind(null);
      logLine('⑤ 原本无绑定；已用 setChatLorebook(null) 解绑测试书 ✅');
    } else {
      logLine('⑤ 原本无绑定，且未找到可解绑到 null 的 API，删书后会残留悬空绑定，请手动解绑。');
    }
  } else {
    await rebind('current', restoreTo);
    logLine(`⑤ 已还原原绑定：${restoreTo} ✅`);
  }

  // 删除测试世界书
  if (del) {
    const ok = await del(bookName);
    logLine(`⑤ deleteWorldbook「${bookName}」：${ok ? '✅ 已删除' : '未删除（可能不存在）'}`);
  } else {
    logLine('⑤ 未找到 deleteWorldbook，测试世界书未删除，请手动删除。');
  }

  state.prevBoundName = undefined;
  state.readBack = null;
}

async function actionEnsure() {
  const result = await ensureMemoirWorldbook();
  logLine(`⑥ ensureMemoirWorldbook：mode=${result.mode} dedicated=${result.dedicated}`);
  logLine(`⑥ 目标世界书：${result.worldbookName}`);
  const memoir = getMemoirState();
  logLine(`⑥ chatState.memoir → worldbookId=${memoir.worldbookId} prevBoundName=${memoir.prevBoundName || '（空）'} updatedAt=${memoir.updatedAt}`);
}

async function actionExtract() {
  // 读最新一条大总结正文当素材，试跑提炼；不走 enabled 门控、不写世界书、不改 sourceProcessed。
  const grandList = collectRecentGrandMemories({ limit: 1, includeHidden: true });
  const latest = grandList.at(-1);
  if (!latest?.content) {
    logLine('⑦ 未找到可用的大总结楼，无法试跑（请先跑一次大总结）。');
    return;
  }
  logLine(`⑦ 读到最新大总结（第 ${latest.messageId} 楼），提炼中……`);
  const archiveRecord = { summaryMessageId: latest.messageId, memoryFrom: '?', memoryTo: '?' };
  const result = await tryExtractMemoirFromGrandSummary(archiveRecord, {
    generate: generateSummaryMemory,
    grandMemoryText: latest.content,
    force: true, // 诊断试跑：绕过 enabled 门控与幂等，强制走一次真实 API
  });
  if (result.skipped) {
    logLine(`⑦ 跳过：${result.skipped}`);
    if (!result.raw) return;
  }
  logLine(`⑦ 绿灯候选 ${result.memories.length} 条，蓝灯总览：${result.overview ? '有' : '无'}`);
  if (result.overview) {
    const recall = Array.isArray(result.overview.recallList) ? result.overview.recallList.join('、') : '';
    logLine(`⑦ 可唤起回忆：${recall || '（空）'}`);
    (result.overview.characterImprints || []).forEach(ci => {
      logLine(`⑦ 印记 · ${ci.character}：${ci.imprint}`);
    });
  }
  result.memories.forEach((m, i) => {
    logLine(`⑦ [${i + 1}] 「${m.title}」importance=${m.importance} time=${m.storyTime}`);
    logLine(`⑦     人=[${(m.mainKeywords || []).join(', ')}] 事=[${(m.filterKeywords || []).join(', ')}]`);
    logLine(`⑦     ${m.content}`);
  });
}

export function bindMemoirWorldbookDiagnosticsEvents(panelRoot) {
  panelRoot.querySelector('[data-slx-memoir-probe]')?.addEventListener('click', () => withRunning(actionProbe));
  panelRoot.querySelector('[data-slx-memoir-read-bind]')?.addEventListener('click', () => withRunning(actionReadBind));
  panelRoot.querySelector('[data-slx-memoir-create-bind]')?.addEventListener('click', () => withRunning(actionCreateBind));
  panelRoot.querySelector('[data-slx-memoir-write]')?.addEventListener('click', () => withRunning(actionWriteEntries));
  panelRoot.querySelector('[data-slx-memoir-readback]')?.addEventListener('click', () => withRunning(actionReadBack));
  panelRoot.querySelector('[data-slx-memoir-restore]')?.addEventListener('click', () => withRunning(actionRestore));
  panelRoot.querySelector('[data-slx-memoir-ensure]')?.addEventListener('click', () => withRunning(actionEnsure));
  panelRoot.querySelector('[data-slx-memoir-extract]')?.addEventListener('click', () => withRunning(actionExtract));
  panelRoot.querySelector('[data-slx-memoir-clear-log]')?.addEventListener('click', () => {
    state.log = [];
    state.readBack = null;
    refreshPanel();
  });
}
