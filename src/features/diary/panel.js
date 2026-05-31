import {
  escapeHtml,
  formatTimestamp,
  isPlainObject,
} from '../../utils/text.js';
import {
  buildApiUrl,
} from '../../core/api.js';
import {
  getChatState,
  getGlobalSettings,
  saveChatState,
} from '../../core/settings.js';
import {
  resolveDiaryContext,
  collectRecentMemories,
} from '../../core/context-resolver.js';
import {
  replacePromptMacros,
  replacePromptMessageMacros,
} from '../../core/macros.js';
import {
  extractMemoryBlocks,
  getOpenAiResponseContent,
} from '../../core/summary.js';
import {
  SUMMARY_SUPPORT_MESSAGES,
} from '../../prompts.js';

const DIARY_TABS = [
  { id: 'notebooks', label: '日记本', icon: 'fa-book-open' },
  { id: 'settings', label: '日记设置', icon: 'fa-sliders' },
];

const DEFAULT_COVERS = [
  { id: 'linen', label: '简约日册' },
  { id: 'gufeng', label: '古风花笺' },
  { id: 'shouhui', label: '手绘手账' },
  { id: 'fugu', label: '复古蓝灰' },
];

const DEFAULT_PAGES = [
  { id: 'warm', label: '简约纸页' },
  { id: 'gufeng', label: '古风信笺' },
  { id: 'shouhui', label: '手绘横线' },
  { id: 'fugu', label: '复古横线' },
];

// ── 手账（Tcho）主题：仅用于 UI 渲染，不涉及业务逻辑 ──

const TCHO_SPINE_COLORS = ['#d4a5a5', '#a5b4d4', '#a5c4b4', '#d4c4a5', '#c4a5c4', '#b4c4d4', '#d4b8a5'];

function getTchoSpineColor(roleName) {
  let h = 0;
  for (let i = 0; i < roleName.length; i++) h = (h * 31 + roleName.charCodeAt(i)) >>> 0;
  return TCHO_SPINE_COLORS[h % TCHO_SPINE_COLORS.length];
}

const TCHO_WAVE_SVG = `<svg class="slx-diary-tcho-wave" viewBox="0 0 140 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 7 Q20 2 38 7 Q56 12 74 7 Q92 2 110 7 Q125 11 138 6" stroke="#e8a09a" stroke-width="2.5" stroke-linecap="round"/></svg>`;

const TCHO_LEAF_L = `<svg class="slx-diary-tcho-leaf" viewBox="0 0 56 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M52 12 Q38 6 24 11" stroke="#8ab49a" stroke-width="1.2" stroke-linecap="round"/><path d="M32 11 Q26 5 16 8 Q24 9 32 11Z" fill="#a8c8b4" opacity="0.85"/><path d="M32 11 Q26 17 16 14 Q24 13 32 11Z" fill="#c0d8c6" opacity="0.7"/><path d="M20 10 Q14 5 6 8 Q13 9 20 10Z" fill="#a8c8b4" opacity="0.8"/><path d="M20 10 Q14 15 6 12 Q13 11 20 10Z" fill="#c0d8c6" opacity="0.65"/></svg>`;

const TCHO_LEAF_R = `<svg class="slx-diary-tcho-leaf slx-diary-tcho-leaf-r" viewBox="0 0 56 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 12 Q18 6 32 11" stroke="#8ab49a" stroke-width="1.2" stroke-linecap="round"/><path d="M24 11 Q30 5 40 8 Q32 9 24 11Z" fill="#a8c8b4" opacity="0.85"/><path d="M24 11 Q30 17 40 14 Q32 13 24 11Z" fill="#c0d8c6" opacity="0.7"/><path d="M36 10 Q42 5 50 8 Q43 9 36 10Z" fill="#a8c8b4" opacity="0.8"/><path d="M36 10 Q42 15 50 12 Q43 11 36 10Z" fill="#c0d8c6" opacity="0.65"/></svg>`;

const DIARY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const DIARY_ASSET_BASE = '/scripts/extensions/third-party/ShenLing-Extension/assets/diary/';
const DIARY_PLANNER_STICKER_SRC = `${DIARY_ASSET_BASE}planner-sticker.png`;
const DIARY_GUFENG_COVER_SRC = `${DIARY_ASSET_BASE}gufeng-cover.png`;
const DIARY_GUFENG_PAGE_SRC = `${DIARY_ASSET_BASE}gufeng-page.png`;
const DIARY_SHOUHUI_COVER_SRC = `${DIARY_ASSET_BASE}shouhui-cover.png`;
const DIARY_SHOUHUI_PAGE_SRC = `${DIARY_ASSET_BASE}shouhui-page.png`;
const DIARY_SHOUHUI_PAGE_MOBILE_SRC = `${DIARY_ASSET_BASE}shouhui-page-mobile.png`;
const DIARY_FUGU_COVER_SRC = `${DIARY_ASSET_BASE}fugu-cover.png`;
const DIARY_FUGU_PAGE_SRC = `${DIARY_ASSET_BASE}fugu-page.png`;
const DIARY_DATE_FALLBACK_LABEL = '当前剧情日期';
const ROLE_DIARY_PROMPT_TEMPLATE = `蜃灵当前处于日记编织状态。

请根据下方梦境上下文素材，以【\${targetRoleName}】的第一人称视角与口吻，写一则日期为【\${diaryDate}】的角色日记。

以下是本次日记可参考的梦境上下文素材：
\${diaryContextMaterial}

日记要求：
- 日记正文控制在 300-500 字。
- 语气、用词、关注重点必须符合【\${targetRoleName}】的角色设定。
- 是角色的私密日记，应展示其真实内心且富有生活气息，像真正的私人手帐/日记一样自然。
- 只写【\${targetRoleName}】本人能知道、能感受到、会在意的事情，避免全知视角。
- 不要写未来剧情，只内化已发生的事。
- 如果角色设定语言不是中文，content 字段内先写角色设定语言版本，再写中文翻译版。
- 必须只输出合法 JSON，不要输出 Markdown 代码块，不要输出解释文字。

输出格式：
{
  "title": "标题",
  "time": "\${diaryDate}",
  "content": "正文"
}`;

const EXCHANGE_DIARY_PROMPT_TEMPLATE = `蜃灵当前处于日记编织状态。

请根据下方梦境上下文素材，以【\${targetRoleName}】的第一人称视角与口吻，写一则日期为【\${diaryDate}】、写给{{user}}看的交换日记回复。

以下是本次日记可参考的梦境上下文素材：
\${diaryContextMaterial}

以下是本次{{user}}已经写下的日记内容：
\${userDiaryContent}

交换日记要求：
- 【\${targetRoleName}】与{{user}}在同一本日记上书写，{{user}}已经先写了她的部分，现在轮到【\${targetRoleName}】写下回应。


- 语气、用词、关注重点必须符合【\${targetRoleName}】的角色设定。
- 应展示真实内心且富有生活气息，像真正的私人手帐/日记一样自然。
- 内容要回应{{user}}写的内容，可以补充【\${targetRoleName}】的视角、感受、或分享这边发生的事。
- 只写【\${targetRoleName}】本人能知道、能感受到、会在意的事情，避免全知视角。
- 不要写未来剧情，只内化已发生的事。
- 如果角色设定语言不是中文，content 字段内先写角色设定语言版本，再写中文翻译版。
- 必须只输出合法 JSON，不要输出 Markdown 代码块，不要输出解释文字。

输出格式：
{
  "title": "角色回复标题",
  "time": "\${diaryDate}",
  "content": "回复日记内容"
}`;

let panelOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getGenerateRawFunction: null,
  refreshPanel: null,
};

let diaryPanelState = {
  tab: 'notebooks',
  screen: 'library',
  roleName: '',
  entryId: '',
  composeRoleName: '',
  composeDate: '',
  generationStatus: 'idle',
  generationError: '',
};

let diaryEditorState = {
  open: false,
  entryId: '',
};

let diaryContextTestState = {
  status: 'idle',
  result: null,
  error: '',
};

export function configureDiaryPanel(options = {}) {
  panelOptions = {
    ...panelOptions,
    ...options,
  };
}

function refreshPanel() {
  if (typeof panelOptions.refreshPanel === 'function') {
    panelOptions.refreshPanel();
  }
}

function getPanelOption(name) {
  const value = panelOptions[name];
  return typeof value === 'function' ? value : null;
}

function createDiaryId() {
  return `diary-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function fillTemplate(template, values = {}) {
  return String(template || '').replace(/\$\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function buildRoleDiaryPrompt({ targetRoleName, diaryDate, diaryContextMaterial }) {
  const promptDiaryDate = String(diaryDate || '').trim() || DIARY_DATE_FALLBACK_LABEL;
  return replacePromptMacros(fillTemplate(ROLE_DIARY_PROMPT_TEMPLATE, {
    targetRoleName,
    diaryDate: promptDiaryDate,
    diaryContextMaterial,
  }));
}

function buildExchangeDiaryPrompt({ targetRoleName, diaryDate, diaryContextMaterial, userDiaryContent }) {
  const promptDiaryDate = String(diaryDate || '').trim() || DIARY_DATE_FALLBACK_LABEL;
  return replacePromptMacros(fillTemplate(EXCHANGE_DIARY_PROMPT_TEMPLATE, {
    targetRoleName,
    diaryDate: promptDiaryDate,
    diaryContextMaterial,
    userDiaryContent,
  }));
}

function cleanJsonResponse(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseDiaryGenerationResult(raw, fallbackDate) {
  const cleaned = cleanJsonResponse(raw);
  try {
    const parsed = JSON.parse(cleaned);
    const title = String(parsed?.title || '').trim();
    const time = String(parsed?.time || fallbackDate || '').trim();
    const content = String(parsed?.content || '').trim();
    if (!title || !content) {
      throw new Error('日记 JSON 缺少 title 或 content。');
    }
    return { title, time, content };
  } catch (error) {
    const matched = cleaned.match(/\{[\s\S]*\}/);
    if (matched?.[0] && matched[0] !== cleaned) {
      try {
        return parseDiaryGenerationResult(matched[0], fallbackDate);
      } catch {
        // Keep the original, clearer parsing error below.
      }
    }
    throw new Error(`日记生成结果不是可解析 JSON：${error.message || error}`);
  }
}

function normalizeDiarySettings(settings = {}) {
  return {
    apiMode: settings.apiMode === 'secondary' ? 'secondary' : 'main',
    userTextColor: String(settings.userTextColor || '#8b4b43').trim(),
    characterTextColor: String(settings.characterTextColor || '#4f3926').trim(),
    coverPreset: DEFAULT_COVERS.some(item => item.id === settings.coverPreset) ? settings.coverPreset : 'linen',
    pagePreset: DEFAULT_PAGES.some(item => item.id === settings.pagePreset) ? settings.pagePreset : 'warm',
    customCover: String(settings.customCover || '').trim(),
    customPage: String(settings.customPage || '').trim(),
  };
}

function toCssString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
}

function getSafeImageSource(value) {
  const source = String(value || '').trim();
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(source)) return source;
  return '';
}

function getBuiltinCoverSource(coverPreset) {
  if (coverPreset === 'gufeng') return DIARY_GUFENG_COVER_SRC;
  if (coverPreset === 'shouhui') return DIARY_SHOUHUI_COVER_SRC;
  if (coverPreset === 'fugu') return DIARY_FUGU_COVER_SRC;
  return '';
}

function getBuiltinPageSource(pagePreset) {
  if (pagePreset === 'gufeng') return DIARY_GUFENG_PAGE_SRC;
  if (pagePreset === 'shouhui') return DIARY_SHOUHUI_PAGE_SRC;
  if (pagePreset === 'fugu') return DIARY_FUGU_PAGE_SRC;
  return '';
}

function getDiaryCoverTheme(coverPreset) {
  return ['gufeng', 'shouhui', 'fugu'].includes(coverPreset) ? coverPreset : '';
}

function buildDiaryVisualStyle(settings = {}) {
  const coverImage = getBuiltinCoverSource(settings.coverPreset) || getSafeImageSource(settings.customCover);
  const pageImage = getBuiltinPageSource(settings.pagePreset) || getSafeImageSource(settings.customPage);
  const declarations = [];
  if (coverImage) declarations.push(`--slx-diary-cover-image: url("${toCssString(coverImage)}")`);
  if (pageImage) declarations.push(`--slx-diary-page-image: url("${toCssString(pageImage)}")`);
  if (settings.pagePreset === 'shouhui' && !settings.customPage) {
    declarations.push(`--slx-diary-page-mobile-image: url("${toCssString(DIARY_SHOUHUI_PAGE_MOBILE_SRC)}")`);
  }
  declarations.push(`--slx-diary-user-text-color: ${toCssString(settings.userTextColor || '#8b4b43')}`);
  declarations.push(`--slx-diary-character-text-color: ${toCssString(settings.characterTextColor || '#4f3926')}`);
  return declarations.length ? ` style="${escapeHtml(declarations.join('; '))}"` : '';
}

function getDiaryStore(chatState) {
  if (!isPlainObject(chatState.diary)) {
    chatState.diary = {};
  }
  if (!Array.isArray(chatState.diary.entries)) {
    chatState.diary.entries = [];
  }
  if (!Array.isArray(chatState.diary.books)) {
    chatState.diary.books = [];
  }
  chatState.diary.settings = normalizeDiarySettings(chatState.diary.settings);
  return chatState.diary;
}

function normalizeRoleName(value) {
  return String(value || '').trim();
}

function normalizeDiaryEntry(entry = {}) {
  const hasExchangeShape = isPlainObject(entry.userDiary)
    || isPlainObject(entry.characterReply)
    || String(entry.userContent || '').trim();
  const type = entry.type === 'exchange_diary' || hasExchangeShape ? 'exchange_diary' : 'role_diary';
  const status = entry.status === 'draft' ? 'draft' : 'collected';
  const now = formatTimestamp();
  const roleName = normalizeRoleName(entry.roleName || entry.targetRoleName || entry.authorName || entry.characterName);

  return {
    id: String(entry.id || createDiaryId()),
    type,
    status,
    roleName,
    authorName: normalizeRoleName(entry.authorName || roleName),
    targetRoleName: normalizeRoleName(entry.targetRoleName || roleName),
    title: String(entry.title || '').trim(),
    time: String(entry.time || '').trim(),
    content: String(entry.content || '').trim(),
    userContent: String(entry.userContent || entry.userDiary?.content || '').trim(),
    characterReply: isPlainObject(entry.characterReply)
      ? {
        title: String(entry.characterReply.title || '').trim(),
        time: String(entry.characterReply.time || '').trim(),
        content: String(entry.characterReply.content || '').trim(),
      }
      : null,
    source: String(entry.source || 'manual'),
    createdAt: String(entry.createdAt || now),
    updatedAt: String(entry.updatedAt || entry.createdAt || now),
    contextDigest: isPlainObject(entry.contextDigest) ? entry.contextDigest : null,
  };
}

function getDiaryEntries(chatState) {
  const store = getDiaryStore(chatState);
  store.entries = store.entries.map(normalizeDiaryEntry);
  return store.entries;
}

function getEntryRoleName(entry) {
  return normalizeRoleName(entry.roleName || entry.targetRoleName || entry.authorName) || '未填写角色';
}

function getEntryTitle(entry) {
  if (entry.type === 'exchange_diary') {
    return entry.characterReply?.title || entry.title || '等待角色回信';
  }
  return entry.title || '待生成标题';
}

function getEntryTime(entry) {
  return entry.time || entry.characterReply?.time || entry.updatedAt || entry.createdAt || '未记录';
}

function getEntryPreview(entry) {
  if (entry.type === 'exchange_diary') {
    return entry.characterReply?.content || entry.userContent || '等待角色回信';
  }
  return entry.content || '等待生成正文';
}

function getDefaultDiaryDate(chatState) {
  const latestMemoryTime = getLatestMemoryTime();
  return latestMemoryTime || '';
}

function getLatestMemoryTime() {
  const memories = collectRecentMemories({ limit: 12 }).map(item => item.content).filter(Boolean).reverse();
  for (const memory of memories) {
    const time = String(memory).match(/<time>\s*([\s\S]*?)\s*<\/time>/i)?.[1]?.trim()
      || String(memory).match(/时间[:：]\s*([^\n<]+)/i)?.[1]?.trim();
    if (time) return time;
    const nestedMemory = extractMemoryBlocks(memory).at(-1) || '';
    const nestedTime = String(nestedMemory).match(/<time>\s*([\s\S]*?)\s*<\/time>/i)?.[1]?.trim()
      || String(nestedMemory).match(/时间[:：]\s*([^\n<]+)/i)?.[1]?.trim();
    if (nestedTime) return nestedTime;
  }
  return '';
}

function getRoleEntries(entries, roleName) {
  const cleanRoleName = normalizeRoleName(roleName);
  return entries
    .filter(entry => getEntryRoleName(entry) === cleanRoleName)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function getNotebooks(chatState) {
  const store = getDiaryStore(chatState);
  const entries = getDiaryEntries(chatState);
  const roles = new Map();

  store.books.forEach(book => {
    const roleName = normalizeRoleName(book.roleName || book.name);
    if (!roleName) return;
    roles.set(roleName, {
      roleName,
      createdAt: String(book.createdAt || ''),
      updatedAt: String(book.updatedAt || ''),
      entryCount: 0,
      latestEntry: null,
    });
  });

  entries.forEach(entry => {
    const roleName = getEntryRoleName(entry);
    if (!roles.has(roleName)) {
      roles.set(roleName, {
        roleName,
        createdAt: entry.createdAt || '',
        updatedAt: entry.updatedAt || '',
        entryCount: 0,
        latestEntry: null,
      });
    }
    const book = roles.get(roleName);
    book.entryCount += 1;
    if (!book.latestEntry || String(entry.createdAt || '') > String(book.latestEntry.createdAt || '')) {
      book.latestEntry = entry;
      book.updatedAt = entry.updatedAt || entry.createdAt || book.updatedAt;
    }
  });

  return [...roles.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function ensureNotebook(roleName) {
  const cleanRoleName = normalizeRoleName(roleName);
  if (!cleanRoleName) return null;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const existing = store.books.find(book => normalizeRoleName(book.roleName || book.name) === cleanRoleName);
  const now = formatTimestamp();
  if (existing) {
    existing.roleName = cleanRoleName;
    existing.updatedAt = now;
  } else {
    store.books.push({
      id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      roleName: cleanRoleName,
      createdAt: now,
      updatedAt: now,
    });
  }
  store.lastSavedAt = now;
  saveChatState();
  return cleanRoleName;
}

function setDiaryScreen(screen, patch = {}) {
  diaryPanelState = {
    ...diaryPanelState,
    screen,
    ...patch,
  };
  refreshPanel();
}

function renderDiaryTabs() {
  return `
    <div class="slx-segment-row slx-diary-tabs" role="group" aria-label="日记模块视图">
      ${DIARY_TABS.map(tab => `
        <button class="slx-segment-btn ${diaryPanelState.tab === tab.id ? 'slx-segment-btn-active' : ''}" type="button" data-slx-diary-tab="${escapeHtml(tab.id)}">
          <i class="fa-solid ${escapeHtml(tab.icon)}"></i><span>${escapeHtml(tab.label)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function renderDiaryEmpty(title = '日记') {
  return `
    <div class="slx-diary-empty">
      <b>暂无${escapeHtml(title)}</b>
      <p>日记只保存在当前聊天 metadata，删除聊天时会一起消失。</p>
    </div>
  `;
}

function renderContextTestResult() {
  if (diaryContextTestState.status !== 'success' || !diaryContextTestState.result) return '';
  const result = diaryContextTestState.result;
  const worldInfo = result.diagnostics?.worldInfo || {};
  return `
    <div class="slx-diary-context-result">
      <div class="slx-detail-kicker">测试上下文</div>
      <div class="slx-diary-stat-grid">
        <span><b>${escapeHtml(result.materialLength)}</b><small>材料字数</small></span>
        <span><b>${escapeHtml(result.recentMessageCount)}</b><small>最近楼层</small></span>
        <span><b>${escapeHtml(result.memoryCount)}</b><small>memory</small></span>
        <span><b>${escapeHtml(result.emotionProfileCount)}</b><small>情感档案</small></span>
      </div>
      <div class="slx-info-line"><span>世界书来源</span><b>${escapeHtml(worldInfo.source || '未记录')}</b></div>
      <div class="slx-info-line"><span>世界书可用条目</span><b>${escapeHtml(worldInfo.usedCount ?? 0)}</b></div>
      <div class="slx-info-line"><span>世界书注入文本</span><b>${escapeHtml(worldInfo.injectionTextLength ?? 0)}</b></div>
    </div>
  `;
}

function getContextTestStatusText() {
  if (diaryContextTestState.status === 'running') return '正在整理日记上下文';
  if (diaryContextTestState.status === 'failed') return diaryContextTestState.error || '上下文测试失败';
  if (diaryContextTestState.status === 'success') {
    const worldInfo = diaryContextTestState.result?.diagnostics?.worldInfo || {};
    return `材料 ${diaryContextTestState.result?.materialLength || 0} 字 · 世界书 ${worldInfo.source || '未记录'}`;
  }
  return '可先验证这本日记生成前会拿到哪些上下文';
}

function renderDiaryLibrary(chatState) {
  const notebooks = getNotebooks(chatState);
  const totalEntries = getDiaryEntries(chatState).length;
  return `
    <div class="slx-diary-tcho-library">
      <div class="slx-diary-tcho-stars" aria-hidden="true">
        <svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path d="M5 0 L5.7 3.8 L9.5 5 L5.7 6.2 L5 10 L4.3 6.2 L0.5 5 L4.3 3.8 Z" fill="#e8c46a"/></svg>
        <svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path d="M5 0 L5.7 3.8 L9.5 5 L5.7 6.2 L5 10 L4.3 6.2 L0.5 5 L4.3 3.8 Z" fill="#e8c46a"/></svg>
        <svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path d="M5 0 L5.7 3.8 L9.5 5 L5.7 6.2 L5 10 L4.3 6.2 L0.5 5 L4.3 3.8 Z" fill="#e8c46a"/></svg>
      </div>

      <div class="slx-diary-tcho-header">
        <div class="slx-diary-tcho-title-block">
          <div class="slx-diary-tcho-icon-slot" aria-hidden="true">
            <!-- 素材图占位：日记本插画，填入 src 路径后即可显示 -->
            <img class="slx-diary-tcho-book-illus" src="${escapeHtml(DIARY_PLANNER_STICKER_SRC)}" alt="" />
          </div>
          <div class="slx-diary-tcho-title-text">
            <div class="slx-diary-tcho-title">角色日记本</div>
            ${TCHO_WAVE_SVG}
          </div>
        </div>
        <button class="slx-diary-tcho-export-tag" type="button" data-slx-export-diary ${totalEntries ? '' : 'disabled'}>
          <i class="fa-solid fa-file-export"></i> 导出
        </button>
      </div>

      <div class="slx-diary-tcho-create-section">
        <div class="slx-diary-tcho-create-label">
          <svg viewBox="0 0 14 12" fill="#e8807a" xmlns="http://www.w3.org/2000/svg" width="11" height="11" aria-hidden="true"><path d="M7 11 Q4 8 2 6 Q0 4 2 2 Q4 0 7 3 Q10 0 12 2 Q14 4 12 6 Q10 8 7 11Z"/></svg>
          新建一本角色日记
          <svg viewBox="0 0 14 12" fill="#e8807a" xmlns="http://www.w3.org/2000/svg" width="11" height="11" aria-hidden="true"><path d="M7 11 Q4 8 2 6 Q0 4 2 2 Q4 0 7 3 Q10 0 12 2 Q14 4 12 6 Q10 8 7 11Z"/></svg>
        </div>
        <input class="slx-diary-tcho-input" type="text" data-slx-diary-new-book-role
          value="${escapeHtml(diaryPanelState.composeRoleName)}"
          placeholder="写下角色名字..." />
        <button class="slx-diary-tcho-create-btn" type="button" data-slx-create-diary-book>
          <i class="fa-solid fa-heart"></i> 创建日记
        </button>
      </div>

      <div class="slx-diary-tcho-books-section">
        <div class="slx-diary-tcho-section-hd">
          ${TCHO_LEAF_L}
          <span>我的日记本们</span>
          ${TCHO_LEAF_R}
        </div>
        <div class="slx-diary-tcho-book-list">
          ${notebooks.map(book => `
            <div class="slx-diary-tcho-book-card">
              <span class="slx-diary-tcho-book-spine" style="background: ${escapeHtml(getTchoSpineColor(book.roleName))}"></span>
              <div class="slx-diary-tcho-book-info">
                <b>${escapeHtml(book.roleName)}</b>
                <small>${escapeHtml(book.entryCount)} 篇日记</small>
              </div>
              <div class="slx-diary-tcho-book-actions">
                <button class="slx-diary-tcho-open-pill" type="button" data-slx-open-diary-book="${escapeHtml(book.roleName)}">打开</button>
                <button class="slx-diary-tcho-delete-pill" type="button" data-slx-delete-diary-book="${escapeHtml(book.roleName)}" title="删除日记本">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        ${!notebooks.length ? `<p class="slx-diary-tcho-empty">还没有日记本，从上面创建第一本吧~</p>` : ''}
        <p class="slx-diary-tcho-tagline">把属于角色的故事收进这里。</p>
        <!-- 素材图占位：填入 src 即可显示，留空不显示 -->
        <img class="slx-diary-tcho-deco slx-diary-tcho-deco-vase" src="" alt="" aria-hidden="true" />
        <img class="slx-diary-tcho-deco slx-diary-tcho-deco-flora" src="" alt="" aria-hidden="true" />
      </div>
    </div>
  `;
}

function renderDiarySettings(chatState) {
  const store = getDiaryStore(chatState);
  const settings = store.settings;
  const hasCustomCover = Boolean(getSafeImageSource(settings.customCover));
  const hasCustomPage = Boolean(getSafeImageSource(settings.customPage));
  return `
    <div class="slx-detail-card slx-diary-shell-card slx-diary-tcho-settings">
      <div class="slx-summary-card-head">
        <div>
          <div class="slx-detail-title">日记设置</div>
          <p>这些设置后续会影响日记生成和日记本外观。</p>
        </div>
      </div>
      <div class="slx-diary-setting-line">
        <span>生成 API</span>
        <div class="slx-diary-pill-toggle" role="group" aria-label="日记生成 API">
          <button class="${settings.apiMode === 'main' ? 'is-active' : ''}" type="button" data-slx-diary-api-mode="main">主 API</button>
          <button class="${settings.apiMode === 'secondary' ? 'is-active' : ''}" type="button" data-slx-diary-api-mode="secondary">副 API</button>
        </div>
      </div>
      <div class="slx-form-grid">
        <label class="slx-field">
          <span>U 字体颜色</span>
          <input type="color" data-slx-diary-user-color value="${escapeHtml(settings.userTextColor)}" />
        </label>
        <label class="slx-field">
          <span>C 字体颜色</span>
          <input type="color" data-slx-diary-character-color value="${escapeHtml(settings.characterTextColor)}" />
        </label>
        <label class="slx-field">
          <span>日记封面</span>
          <select data-slx-diary-cover-preset>
            ${DEFAULT_COVERS.map(item => `<option value="${escapeHtml(item.id)}" ${settings.coverPreset === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          </select>
        </label>
        <label class="slx-field">
          <span>日记内页</span>
          <select data-slx-diary-page-preset>
            ${DEFAULT_PAGES.map(item => `<option value="${escapeHtml(item.id)}" ${settings.pagePreset === item.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          </select>
        </label>
        <label class="slx-field slx-field-wide">
          <span>封面图片地址</span>
          <input type="text" data-slx-diary-custom-cover value="${escapeHtml(settings.customCover)}" placeholder="可粘贴图片地址，或使用下方上传" />
        </label>
        <label class="slx-field slx-field-wide">
          <span>内页图片地址</span>
          <input type="text" data-slx-diary-custom-page value="${escapeHtml(settings.customPage)}" placeholder="可粘贴图片地址，或使用下方上传" />
        </label>
      </div>
      <div class="slx-diary-upload-grid">
        <label class="slx-diary-upload-box">
          <span><i class="fa-solid fa-image"></i> 上传封面</span>
          <input type="file" accept="image/*" data-slx-diary-upload-cover />
          <small>${hasCustomCover ? '已设置自定义封面' : '建议竖版图片，最大 4 MB'}</small>
        </label>
        <label class="slx-diary-upload-box">
          <span><i class="fa-solid fa-file-image"></i> 上传内页</span>
          <input type="file" accept="image/*" data-slx-diary-upload-page />
          <small>${hasCustomPage ? '已设置自定义内页' : '建议纸张纹理，最大 4 MB'}</small>
        </label>
      </div>
      <div class="slx-action-row">
        <button class="slx-soft-btn" type="button" data-slx-clear-diary-cover ${hasCustomCover ? '' : 'disabled'}>清除封面</button>
        <button class="slx-soft-btn" type="button" data-slx-clear-diary-page ${hasCustomPage ? '' : 'disabled'}>清除内页</button>
      </div>
    </div>
  `;
}

function renderDiaryCover(chatState) {
  const roleName = diaryPanelState.roleName;
  const settings = getDiaryStore(chatState).settings;
  const coverTheme = getDiaryCoverTheme(settings.coverPreset);
  return `
    <div class="slx-diary-cover-wrap">
      <button class="slx-diary-book-close-btn" type="button" data-slx-close-diary-notebook title="回到书架">
        <i class="fa-solid fa-xmark"></i>
      </button>
      <button class="slx-diary-cover ${coverTheme ? `slx-diary-cover-${coverTheme}` : ''}" type="button" data-slx-open-diary-toc>
        ${coverTheme
          ? `<span class="slx-diary-cover-owner">${escapeHtml(roleName || '未命名角色')}</span>`
          : `
            <span class="slx-diary-cover-label">SHENLING DIARY</span>
            <b>${escapeHtml(roleName || '未命名角色')}</b>
          `}
      </button>
    </div>
  `;
}

function renderDiaryToc(chatState) {
  const roleName = diaryPanelState.roleName;
  const entries = getRoleEntries(getDiaryEntries(chatState), roleName);
  return `
    <div class="slx-diary-book-spread slx-diary-inline-book slx-diary-toc-spread">
      <section class="slx-diary-book-page">
        <button class="slx-diary-page-corner-btn slx-diary-page-corner-left" type="button" data-slx-diary-back-cover title="返回封面">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="slx-diary-book-page-title">目录</div>
        <div class="slx-diary-book-rule"></div>
        <div class="slx-diary-toc-list">
          ${entries.length ? entries.map((entry, index) => `
            <button type="button" data-slx-open-diary-entry="${escapeHtml(entry.id)}">
              <span>${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
              <b>${escapeHtml(getEntryTitle(entry))}</b>
              <small>${escapeHtml(getEntryTime(entry))} · ${entry.type === 'exchange_diary' ? '交换日记' : '角色独白'}</small>
            </button>
          `).join('') : '<p>这本日记还没有写下第一篇。</p>'}
        </div>
        <button class="slx-diary-feather-btn slx-diary-mobile-compose-btn" type="button" data-slx-open-diary-compose title="撰写日记">
          <i class="fa-solid fa-feather"></i>
        </button>
      </section>
      <section class="slx-diary-book-page slx-diary-book-page-right">
        <button class="slx-diary-book-close-btn slx-diary-page-close-btn" type="button" data-slx-close-diary-notebook title="回到书架">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="slx-diary-book-page-title">撰写</div>
        <div class="slx-diary-book-rule"></div>
        <p>若你的日记内容为空，会生成角色独白；若写下给角色看的内容，会生成交换日记。</p>
        <button class="slx-diary-feather-btn" type="button" data-slx-open-diary-compose title="撰写日记">
          <i class="fa-solid fa-feather"></i>
        </button>
        <div class="slx-diary-book-page-num">${escapeHtml(roleName || '')}</div>
      </section>
    </div>
  `;
}

function renderDiaryEntryPage(chatState) {
  const entries = getRoleEntries(getDiaryEntries(chatState), diaryPanelState.roleName);
  const entry = entries.find(item => item.id === diaryPanelState.entryId);
  if (!entry) return renderDiaryToc(chatState);

  const index = entries.findIndex(item => item.id === entry.id);
  const isExchange = entry.type === 'exchange_diary';
  const leftTitle = isExchange ? '你的日记' : getEntryTitle(entry);
  const leftText = isExchange ? entry.userContent : entry.content || '正文将在生成后写入这里。';
  const entryTime = getEntryTime(entry);
  const rightTitle = isExchange ? (entry.characterReply?.title || '角色回信') : '日记信息';
  const rightText = isExchange ? entry.characterReply?.content || '角色回信将在生成后写入这里。' : '';
  const entryActions = `
    <div class="slx-diary-page-actions slx-diary-entry-page-actions">
      ${entry.status === 'draft' ? `<button class="slx-diary-page-action-btn" type="button" data-slx-collect-diary="${escapeHtml(entry.id)}" title="收录"><i class="fa-solid fa-check"></i></button>` : ''}
      <button class="slx-diary-page-action-btn" type="button" data-slx-edit-diary="${escapeHtml(entry.id)}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
      <button class="slx-diary-page-action-btn" type="button" data-slx-delete-diary="${escapeHtml(entry.id)}" title="删除"><i class="fa-solid fa-trash"></i></button>
    </div>
  `;

  return `
    <div class="slx-diary-book-spread slx-diary-inline-book slx-diary-entry-spread ${isExchange ? 'slx-diary-exchange-spread' : ''}">
      <section class="slx-diary-book-page slx-diary-entry-left-page">
        ${entryActions}
        <div class="slx-diary-book-page-title">${escapeHtml(leftTitle)}</div>
        <div class="slx-diary-book-page-date">${escapeHtml(entryTime || '当前剧情日期')}</div>
        <div class="slx-diary-book-rule"></div>
        <div class="slx-diary-entry-scroll">
          <p class="${isExchange ? 'slx-diary-text-user' : 'slx-diary-text-character'}">${escapeHtml(leftText)}</p>
        </div>
        <div class="slx-diary-page-footer-left">
          <button class="slx-diary-page-corner-btn" type="button" data-slx-diary-back-toc title="返回目录">
            <i class="fa-solid fa-list"></i>
          </button>
          <span>${escapeHtml(index + 1)}</span>
        </div>
      </section>
      <section class="slx-diary-book-page slx-diary-book-page-right">
        <button class="slx-diary-book-close-btn slx-diary-page-close-btn" type="button" data-slx-close-diary-notebook title="回到书架">
          <i class="fa-solid fa-xmark"></i>
        </button>
        ${isExchange ? `
          <div class="slx-diary-book-page-title">${escapeHtml(rightTitle)}</div>
          <div class="slx-diary-book-rule"></div>
          <p class="slx-diary-text-character">${escapeHtml(rightText)}</p>
          <div class="slx-diary-book-page-num">${escapeHtml(entryTime)}</div>
        ` : '<div class="slx-diary-blank-page" aria-hidden="true"></div>'}
      </section>
    </div>
  `;
}

function renderDiaryCompose(chatState) {
  const roleName = diaryPanelState.composeRoleName || diaryPanelState.roleName;
  const dateValue = diaryPanelState.composeDate || getDefaultDiaryDate(chatState);
  const isGenerating = diaryPanelState.generationStatus === 'running';
  const generationHint = isGenerating
    ? `【${roleName || '角色'}】正在书写日记……`
    : diaryPanelState.generationStatus === 'failed'
      ? diaryPanelState.generationError || '日记生成失败。'
      : '用户内容为空时生成角色独白；写下内容时生成交换日记回复。';
  return `
    <div class="slx-diary-book-spread slx-diary-inline-book slx-diary-compose-spread">
      <section class="slx-diary-book-page">
        <button class="slx-diary-page-corner-btn slx-diary-page-corner-left" type="button" data-slx-diary-back-toc title="返回目录">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="slx-diary-book-page-title">撰写日记</div>
        <div class="slx-diary-book-rule"></div>
        <input type="hidden" data-slx-diary-compose-role value="${escapeHtml(roleName)}" />
        <div class="slx-diary-paper-field">
          <span>日记角色</span>
          <p>${escapeHtml(roleName || '未命名角色')}</p>
        </div>
        <label class="slx-field slx-diary-paper-field">
          <span>日记日期</span>
          <input type="text" data-slx-diary-compose-date value="${escapeHtml(dateValue)}" placeholder="默认当前剧情日期，可手动改" />
        </label>
        <label class="slx-field slx-diary-paper-field">
          <span>给角色看的内容</span>
          <textarea class="slx-diary-new-textarea" data-slx-diary-compose-user-content placeholder="可空。为空时生成角色独白；写下你的内容时生成交换日记。"></textarea>
        </label>
        <div class="slx-diary-compose-mobile-actions">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-create-unified-diary-draft ${isGenerating ? 'disabled' : ''}>
            <i class="fa-solid fa-feather"></i><span>${isGenerating ? '日记生成中' : '生成日记草稿'}</span>
          </button>
          <button class="slx-soft-btn" type="button" data-slx-test-diary-context ${diaryContextTestState.status === 'running' ? 'disabled' : ''}>
            <i class="fa-solid fa-magnifying-glass"></i><span>测试上下文</span>
          </button>
          <div class="slx-field-hint">${escapeHtml(generationHint)}</div>
          <div class="slx-field-hint">${escapeHtml(getContextTestStatusText())}</div>
          ${renderContextTestResult()}
        </div>
      </section>
      <section class="slx-diary-book-page slx-diary-book-page-right">
        <button class="slx-diary-book-close-btn slx-diary-page-close-btn" type="button" data-slx-close-diary-notebook title="回到书架">
          <i class="fa-solid fa-xmark"></i>
        </button>
        <div class="slx-diary-book-page-title">落笔前</div>
        <div class="slx-diary-book-rule"></div>
        <p>标题由 AI 生成。生成完成后会先作为草稿收入这本日记。</p>
        <div class="slx-action-row slx-diary-compose-actions">
          <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-create-unified-diary-draft ${isGenerating ? 'disabled' : ''}>
            <i class="fa-solid fa-feather"></i><span>${isGenerating ? '日记生成中' : '生成日记草稿'}</span>
          </button>
          <button class="slx-soft-btn" type="button" data-slx-test-diary-context ${diaryContextTestState.status === 'running' ? 'disabled' : ''}>
            <i class="fa-solid fa-magnifying-glass"></i><span>测试上下文</span>
          </button>
        </div>
        <div class="slx-field-hint">${escapeHtml(generationHint)}</div>
        <div class="slx-field-hint">${escapeHtml(getContextTestStatusText())}</div>
        ${renderContextTestResult()}
      </section>
    </div>
  `;
}

function renderDiaryEditor(chatState) {
  if (!diaryEditorState.open) return '';
  const entry = getDiaryEntries(chatState).find(item => item.id === diaryEditorState.entryId);
  if (!entry) return '';
  const isExchange = entry.type === 'exchange_diary';

  return `
    <div class="slx-rule-modal" data-slx-close-diary-editor>
      <div class="slx-rule-modal-card slx-diary-editor-card" data-slx-diary-editor-card>
        <div class="slx-summary-card-head">
          <div>
            <div class="slx-detail-title">编辑${isExchange ? '交换日记' : '角色日记'}</div>
            <p>${escapeHtml(entry.createdAt || '未记录创建时间')}</p>
          </div>
          <button class="slx-mini-action-btn" type="button" data-slx-close-diary-editor title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="slx-form-grid">
          <label class="slx-field">
            <span>日记角色</span>
            <input type="text" data-slx-diary-edit-role value="${escapeHtml(getEntryRoleName(entry))}" />
          </label>
          <label class="slx-field">
            <span>标题</span>
            <input type="text" data-slx-diary-edit-title value="${escapeHtml(getEntryTitle(entry) === '待生成标题' || getEntryTitle(entry) === '等待角色回信' ? '' : getEntryTitle(entry))}" />
          </label>
          <label class="slx-field">
            <span>日期</span>
            <input type="text" data-slx-diary-edit-time value="${escapeHtml(entry.time || entry.characterReply?.time || '')}" />
          </label>
          <label class="slx-field">
            <span>状态</span>
            <select data-slx-diary-edit-status>
              <option value="draft" ${entry.status === 'draft' ? 'selected' : ''}>草稿</option>
              <option value="collected" ${entry.status === 'collected' ? 'selected' : ''}>已收录</option>
            </select>
          </label>
          ${isExchange ? `
            <label class="slx-field slx-field-wide">
              <span>你的日记</span>
              <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-user-content>${escapeHtml(entry.userContent)}</textarea>
            </label>
            <label class="slx-field slx-field-wide">
              <span>角色回信</span>
              <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-content>${escapeHtml(entry.characterReply?.content || '')}</textarea>
            </label>
          ` : `
            <label class="slx-field slx-field-wide">
              <span>正文</span>
              <textarea class="slx-diary-editor-textarea" data-slx-diary-edit-content>${escapeHtml(entry.content)}</textarea>
            </label>
          `}
        </div>
        <button class="slx-soft-btn slx-primary-btn" type="button" data-slx-save-diary-edit>
          <i class="fa-solid fa-floppy-disk"></i><span>保存修改</span>
        </button>
      </div>
    </div>
  `;
}

function renderDiaryNotebookBody(chatState) {
  if (diaryPanelState.screen === 'cover') return renderDiaryCover(chatState);
  if (diaryPanelState.screen === 'toc') return renderDiaryToc(chatState);
  if (diaryPanelState.screen === 'entry') return renderDiaryEntryPage(chatState);
  if (diaryPanelState.screen === 'compose') return renderDiaryCompose(chatState);
  return renderDiaryLibrary(chatState);
}

function renderDiaryNotebookModal(chatState) {
  if (diaryPanelState.tab !== 'notebooks' || diaryPanelState.screen === 'library') return '';
  const stageClass = diaryPanelState.screen === 'cover' ? 'slx-diary-stage-cover' : 'slx-diary-stage-open';
  const settings = getDiaryStore(chatState).settings;
  const visualStyle = buildDiaryVisualStyle(settings);
  const coverTheme = getDiaryCoverTheme(settings.coverPreset);
  const themeClass = [
    coverTheme ? `slx-diary-theme-cover-${coverTheme}` : '',
    settings.pagePreset === 'gufeng' ? 'slx-diary-theme-page-gufeng' : '',
    settings.pagePreset === 'shouhui' ? 'slx-diary-theme-page-shouhui' : '',
    settings.pagePreset === 'fugu' ? 'slx-diary-theme-page-fugu' : '',
  ].filter(Boolean).join(' ');
  return `
    <div class="slx-diary-notebook-modal" data-slx-close-diary-notebook>
      <div class="slx-diary-notebook-stage ${stageClass} ${themeClass}" data-slx-diary-notebook-stage${visualStyle}>
        ${renderDiaryNotebookBody(chatState)}
      </div>
    </div>
  `;
}

export function renderDiaryPanel(settings, chatState) {
  getDiaryStore(chatState);

  return `
    <div class="slx-diary-tcho-frame">
      ${renderDiaryTabs()}
      <div class="slx-diary-tcho-body">
        ${diaryPanelState.tab === 'settings' ? renderDiarySettings(chatState) : renderDiaryLibrary(chatState)}
      </div>
    </div>
    ${renderDiaryNotebookModal(chatState)}
    ${renderDiaryEditor(chatState)}
  `;
}

export function isDiaryNotebookOpen() {
  return diaryPanelState.tab === 'notebooks' && diaryPanelState.screen !== 'library';
}

function saveEntry(entryInput) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entry = normalizeDiaryEntry(entryInput);
  ensureNotebook(getEntryRoleName(entry));
  store.entries.push(entry);
  store.lastComposeDate = entry.time || store.lastComposeDate || '';
  store.lastSavedAt = entry.updatedAt;
  saveChatState();
  return entry;
}

async function runDiaryGeneration({ messages, taskType, fallbackDate }) {
  const store = getDiaryStore(getChatState());
  const addCommunicationLog = getPanelOption('addCommunicationLog');
  const startedAt = performance.now();

  if (store.settings.apiMode === 'main') {
    const requestBody = {
      prompt: messages,
    };
    try {
      const generateRaw = getPanelOption('getGenerateRawFunction')?.();
      if (typeof generateRaw !== 'function') {
        throw new Error('当前环境未发现 generateRaw，无法调用酒馆主 API。');
      }
      const responseText = await generateRaw(requestBody);
      const parsedResult = parseDiaryGenerationResult(responseText, fallbackDate);
      addCommunicationLog?.({
        moduleName: '日程日记 / 主 API',
        taskType,
        status: 'success',
        startedAt: formatTimestamp(),
        durationMs: Math.round(performance.now() - startedAt),
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url: '酒馆当前连接',
        messages,
        requestBody,
        responseText,
        parsedResult,
      });
      return parsedResult;
    } catch (error) {
      addCommunicationLog?.({
        moduleName: '日程日记 / 主 API',
        taskType,
        status: 'failure',
        startedAt: formatTimestamp(),
        durationMs: Math.round(performance.now() - startedAt),
        profileName: '酒馆当前连接',
        model: '酒馆主 API',
        url: '酒馆当前连接',
        messages,
        requestBody,
        errorStack: error.stack || error.message || error,
      });
      throw error;
    }
  }

  const profile = getPanelOption('getActiveApiProfile')?.(getGlobalSettings());
  let url = '';
  let requestBody = null;
  try {
    if (!profile) throw new Error('当前环境未提供副 API 配置。');
    url = buildApiUrl(profile);
    if (!String(profile.model || '').trim()) {
      throw new Error('请先在设置页选择日记生成模型。');
    }
    requestBody = {
      model: String(profile.model).trim(),
      messages,
      stream: false,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (String(profile.apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text();
    let responseJson = null;
    try {
      responseJson = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseJson = null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${responseText}`);
    }
    const content = getOpenAiResponseContent(responseJson).trim();
    if (!content) {
      throw new Error(`接口返回成功，但没有读取到回复正文：${responseText}`);
    }
    const parsedResult = parseDiaryGenerationResult(content, fallbackDate);
    addCommunicationLog?.({
      moduleName: '日程日记 / 副 API',
      taskType,
      status: 'success',
      startedAt: formatTimestamp(),
      durationMs: Math.round(performance.now() - startedAt),
      profileName: profile.name,
      model: profile.model,
      url,
      httpStatus: response.status,
      messages,
      requestBody,
      responseText,
      parsedResult,
    });
    return parsedResult;
  } catch (error) {
    addCommunicationLog?.({
      moduleName: '日程日记 / 副 API',
      taskType,
      status: 'failure',
      startedAt: formatTimestamp(),
      durationMs: Math.round(performance.now() - startedAt),
      profileName: profile?.name,
      model: profile?.model,
      url,
      messages,
      requestBody,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

function getDiaryContextOptions(roleName) {
  const store = getDiaryStore(getChatState());
  const isMainApi = store.settings.apiMode === 'main';
  return {
    targetRoleName: roleName,
    worldInfoMode: isMainApi ? 'cache_only' : 'cache_first',
    worldInfoMaterialMode: isMainApi ? 'injection_only' : 'injection_first',
  };
}

async function generateRoleDiary({ roleName, date }) {
  const fallbackDate = String(date || '').trim() || DIARY_DATE_FALLBACK_LABEL;
  const context = await resolveDiaryContext(getDiaryContextOptions(roleName));
  const prompt = buildRoleDiaryPrompt({
    targetRoleName: roleName,
    diaryDate: date,
    diaryContextMaterial: context.material,
  });
  const messages = replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    { role: 'user', content: prompt },
  ]);

  return runDiaryGeneration({
    messages,
    taskType: '角色日记生成',
    fallbackDate,
  });
}

async function generateExchangeDiary({ roleName, date, userDiaryContent }) {
  const fallbackDate = String(date || '').trim() || DIARY_DATE_FALLBACK_LABEL;
  const context = await resolveDiaryContext(getDiaryContextOptions(roleName));
  const prompt = buildExchangeDiaryPrompt({
    targetRoleName: roleName,
    diaryDate: date,
    diaryContextMaterial: context.material,
    userDiaryContent,
  });
  const messages = replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map(message => ({ ...message })),
    { role: 'user', content: prompt },
  ]);

  return runDiaryGeneration({
    messages,
    taskType: '交换日记生成',
    fallbackDate,
  });
}

async function createUnifiedDiaryDraft(panelRoot) {
  const roleName = normalizeRoleName(panelRoot.querySelector('[data-slx-diary-compose-role]')?.value);
  const date = String(panelRoot.querySelector('[data-slx-diary-compose-date]')?.value || '').trim();
  const userContent = String(panelRoot.querySelector('[data-slx-diary-compose-user-content]')?.value || '').trim();
  if (!roleName) return;

  diaryPanelState.composeRoleName = roleName;
  diaryPanelState.composeDate = date;
  diaryPanelState.generationStatus = 'running';
  diaryPanelState.generationError = '';
  refreshPanel();
  const now = formatTimestamp();
  let generated = null;
  try {
    generated = userContent
      ? await generateExchangeDiary({ roleName, date, userDiaryContent: userContent })
      : await generateRoleDiary({ roleName, date });
  } catch (error) {
    diaryPanelState.generationStatus = 'failed';
    diaryPanelState.generationError = error.message || String(error);
    refreshPanel();
    return;
  }
  const entryTime = generated?.time || date || DIARY_DATE_FALLBACK_LABEL;

  const entry = saveEntry({
    type: userContent ? 'exchange_diary' : 'role_diary',
    status: 'draft',
    roleName,
    authorName: roleName,
    targetRoleName: roleName,
    title: userContent ? generated?.title || '' : generated?.title || '',
    time: entryTime,
    content: userContent ? '' : generated?.content || '',
    userContent,
    characterReply: userContent
      ? { title: generated?.title || '', time: entryTime, content: generated?.content || '' }
      : null,
    source: 'ai',
    createdAt: now,
    updatedAt: formatTimestamp(),
    contextDigest: { generatedAt: formatTimestamp() },
  });

  diaryPanelState = {
    ...diaryPanelState,
    roleName,
    entryId: entry.id,
    screen: 'entry',
    generationStatus: 'idle',
    generationError: '',
  };
  refreshPanel();
}

function updateDiaryEntry(entryId, updater) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const index = store.entries.findIndex(entry => entry.id === entryId);
  if (index < 0) return null;
  const entry = normalizeDiaryEntry(store.entries[index]);
  updater(entry);
  entry.updatedAt = formatTimestamp();
  store.entries[index] = entry;
  store.lastSavedAt = entry.updatedAt;
  saveChatState();
  return entry;
}

function saveDiaryEdit(panelRoot) {
  const entryId = diaryEditorState.entryId;
  if (!entryId) return;
  const updated = updateDiaryEntry(entryId, entry => {
    const roleName = normalizeRoleName(panelRoot.querySelector('[data-slx-diary-edit-role]')?.value);
    const title = String(panelRoot.querySelector('[data-slx-diary-edit-title]')?.value || '').trim();
    const time = String(panelRoot.querySelector('[data-slx-diary-edit-time]')?.value || '').trim();
    const status = panelRoot.querySelector('[data-slx-diary-edit-status]')?.value === 'draft' ? 'draft' : 'collected';
    const content = String(panelRoot.querySelector('[data-slx-diary-edit-content]')?.value || '').trim();

    entry.status = status;
    entry.roleName = roleName;
    entry.authorName = roleName;
    entry.targetRoleName = roleName;
    entry.title = title;
    entry.time = time;
    if (entry.type === 'exchange_diary') {
      entry.userContent = String(panelRoot.querySelector('[data-slx-diary-edit-user-content]')?.value || '').trim();
      entry.characterReply = {
        ...(entry.characterReply || {}),
        title,
        time,
        content,
      };
    } else {
      entry.content = content;
    }
    ensureNotebook(roleName);
  });
  diaryEditorState.open = false;
  if (updated) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: getEntryRoleName(updated),
      entryId: updated.id,
      screen: 'entry',
    };
  }
  refreshPanel();
}

function collectDiaryEntry(entryId) {
  const updated = updateDiaryEntry(entryId, entry => {
    entry.status = 'collected';
  });
  if (updated) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: getEntryRoleName(updated),
      entryId: updated.id,
      screen: 'entry',
    };
  }
  refreshPanel();
}

function deleteDiaryEntry(entryId) {
  if (!confirm('删除这条日记记录？')) return;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const deleted = store.entries.find(entry => entry.id === entryId);
  store.entries = store.entries.filter(entry => entry.id !== entryId);
  store.lastSavedAt = formatTimestamp();
  saveChatState();
  if (deleted && diaryPanelState.entryId === entryId) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: getEntryRoleName(normalizeDiaryEntry(deleted)),
      entryId: '',
      screen: 'toc',
    };
  }
  refreshPanel();
}

function deleteDiaryBook(roleName) {
  const cleanRoleName = normalizeRoleName(roleName);
  if (!cleanRoleName) return;
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entries = getDiaryEntries(chatState);
  const deleteCount = entries.filter(entry => getEntryRoleName(entry) === cleanRoleName).length;
  const message = deleteCount
    ? `删除「${cleanRoleName}」这本日记本？里面的 ${deleteCount} 篇日记也会一起删除。`
    : `删除「${cleanRoleName}」这本空日记本？`;
  if (!confirm(message)) return;

  store.books = store.books.filter(book => normalizeRoleName(book.roleName || book.name) !== cleanRoleName);
  store.entries = entries.filter(entry => getEntryRoleName(entry) !== cleanRoleName);
  store.lastSavedAt = formatTimestamp();
  saveChatState();

  if (diaryPanelState.roleName === cleanRoleName) {
    diaryPanelState = {
      ...diaryPanelState,
      roleName: '',
      composeRoleName: '',
      entryId: '',
      screen: 'library',
    };
  }
  refreshPanel();
}

function exportDiaryBook() {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  const entries = getDiaryEntries(chatState);
  if (!entries.length) return;

  const payload = {
    exportedAt: new Date().toISOString(),
    identity: chatState.identity,
    books: store.books,
    settings: store.settings,
    entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const chatName = String(chatState.identity?.chatName || 'shenling-diary').replace(/[\\/:*?"<>|]+/g, '_');
  anchor.href = url;
  anchor.download = `${chatName}-diary.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function testDiaryContext(panelRoot) {
  const targetRoleName = normalizeRoleName(panelRoot.querySelector('[data-slx-diary-compose-role]')?.value || diaryPanelState.roleName);
  diaryPanelState.composeRoleName = targetRoleName;

  diaryContextTestState = {
    status: 'running',
    result: null,
    error: '',
  };
  refreshPanel();

  try {
    const context = await resolveDiaryContext(getDiaryContextOptions(targetRoleName));
    diaryContextTestState = {
      status: 'success',
      result: {
        materialLength: context.material.length,
        recentMessageCount: context.diagnostics?.recentMessageCount ?? 0,
        memoryCount: context.diagnostics?.memoryCount ?? 0,
        grandMemoryCount: context.diagnostics?.grandMemoryCount ?? 0,
        emotionProfileCount: context.diagnostics?.emotionProfileCount ?? 0,
        diagnostics: context.diagnostics,
      },
      error: '',
    };
  } catch (error) {
    diaryContextTestState = {
      status: 'failed',
      result: null,
      error: error.message || String(error),
    };
  }
  refreshPanel();
}

function saveDiarySettings(panelRoot) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  store.settings = normalizeDiarySettings({
    ...store.settings,
    userTextColor: panelRoot.querySelector('[data-slx-diary-user-color]')?.value,
    characterTextColor: panelRoot.querySelector('[data-slx-diary-character-color]')?.value,
    coverPreset: panelRoot.querySelector('[data-slx-diary-cover-preset]')?.value,
    pagePreset: panelRoot.querySelector('[data-slx-diary-page-preset]')?.value,
    customCover: panelRoot.querySelector('[data-slx-diary-custom-cover]')?.value,
    customPage: panelRoot.querySelector('[data-slx-diary-custom-page]')?.value,
  });
  store.lastSavedAt = formatTimestamp();
  saveChatState();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(reader.error || new Error('图片读取失败。')));
    reader.readAsDataURL(file);
  });
}

async function uploadDiaryImage(input, key) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('请选择图片文件。');
    input.value = '';
    return;
  }
  if (file.size > DIARY_IMAGE_MAX_BYTES) {
    alert('图片太大啦，建议压到 4 MB 以内再上传。');
    input.value = '';
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const chatState = getChatState();
    const store = getDiaryStore(chatState);
    store.settings[key] = dataUrl;
    store.lastSavedAt = formatTimestamp();
    saveChatState();
    input.value = '';
    refreshPanel();
  } catch (error) {
    alert(error.message || '图片上传失败。');
  }
}

function clearDiaryImage(key) {
  const chatState = getChatState();
  const store = getDiaryStore(chatState);
  store.settings[key] = '';
  store.lastSavedAt = formatTimestamp();
  saveChatState();
  refreshPanel();
}

export function bindDiaryPanelEvents(panelRoot) {
  panelRoot.addEventListener('click', event => {
    const openCover = event.target.closest?.('[data-slx-open-diary-toc]');
    if (openCover) {
      event.preventDefault();
      setDiaryScreen('toc', { entryId: '' });
    }
  });

  panelRoot.querySelectorAll('[data-slx-diary-tab]').forEach(button => {
    button.addEventListener('click', () => {
      diaryPanelState.tab = button.dataset.slxDiaryTab || 'notebooks';
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-export-diary]')?.addEventListener('click', exportDiaryBook);

  panelRoot.querySelector('[data-slx-create-diary-book]')?.addEventListener('click', () => {
    const roleName = ensureNotebook(panelRoot.querySelector('[data-slx-diary-new-book-role]')?.value);
    if (!roleName) return;
    diaryPanelState = {
      ...diaryPanelState,
      roleName,
      composeRoleName: roleName,
      screen: 'cover',
    };
    refreshPanel();
  });

  panelRoot.querySelector('[data-slx-diary-new-book-role]')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    panelRoot.querySelector('[data-slx-create-diary-book]')?.click();
  });

  panelRoot.querySelectorAll('[data-slx-open-diary-book]').forEach(button => {
    button.addEventListener('click', () => {
      const roleName = normalizeRoleName(button.dataset.slxOpenDiaryBook);
      diaryPanelState = {
        ...diaryPanelState,
        roleName,
        composeRoleName: roleName,
        entryId: '',
        screen: 'cover',
      };
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-delete-diary-book]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      deleteDiaryBook(button.dataset.slxDeleteDiaryBook);
    });
  });

  panelRoot.querySelector('[data-slx-diary-back-library]')?.addEventListener('click', () => {
    setDiaryScreen('library', { roleName: '', entryId: '' });
  });

  panelRoot.querySelectorAll('[data-slx-close-diary-notebook]').forEach(node => {
    node.addEventListener('click', event => {
      const clickedBackdrop = event.target === node && node.classList?.contains('slx-diary-notebook-modal');
      const closeControl = event.target.closest?.('[data-slx-close-diary-notebook]');
      const clickedCloseButton = Boolean(closeControl && closeControl !== node);
      if (!clickedBackdrop && !clickedCloseButton) {
        return;
      }
      setDiaryScreen('library', { roleName: '', entryId: '' });
    });
  });

  panelRoot.querySelector('[data-slx-diary-back-cover]')?.addEventListener('click', () => {
    setDiaryScreen('cover', { entryId: '' });
  });

  panelRoot.querySelector('[data-slx-diary-back-toc]')?.addEventListener('click', () => {
    setDiaryScreen('toc', { entryId: '' });
  });

  panelRoot.querySelectorAll('[data-slx-open-diary-entry]').forEach(button => {
    button.addEventListener('click', () => {
      const entryId = button.dataset.slxOpenDiaryEntry || '';
      if (!entryId) return;
      setDiaryScreen('entry', { entryId });
    });
  });

  panelRoot.querySelectorAll('[data-slx-open-diary-compose]').forEach(button => {
    button.addEventListener('click', () => {
      const chatState = getChatState();
      setDiaryScreen('compose', {
        composeRoleName: diaryPanelState.roleName,
        composeDate: getDefaultDiaryDate(chatState),
      });
    });
  });

  panelRoot.querySelectorAll('[data-slx-create-unified-diary-draft]').forEach(button => {
    button.addEventListener('click', () => {
      void createUnifiedDiaryDraft(panelRoot);
    });
  });

  panelRoot.querySelectorAll('[data-slx-test-diary-context]').forEach(button => {
    button.addEventListener('click', () => {
      void testDiaryContext(panelRoot);
    });
  });

  panelRoot.querySelectorAll('[data-slx-edit-diary]').forEach(button => {
    button.addEventListener('click', () => {
      diaryEditorState = { open: true, entryId: button.dataset.slxEditDiary || '' };
      refreshPanel();
    });
  });

  panelRoot.querySelectorAll('[data-slx-collect-diary]').forEach(button => {
    button.addEventListener('click', () => {
      collectDiaryEntry(button.dataset.slxCollectDiary);
    });
  });

  panelRoot.querySelectorAll('[data-slx-delete-diary]').forEach(button => {
    button.addEventListener('click', () => {
      deleteDiaryEntry(button.dataset.slxDeleteDiary);
    });
  });

  panelRoot.querySelectorAll('[data-slx-close-diary-editor]').forEach(node => {
    node.addEventListener('click', event => {
      if (event.target.closest?.('[data-slx-diary-editor-card]') && !event.target.closest?.('[data-slx-close-diary-editor]')) {
        return;
      }
      diaryEditorState = { open: false, entryId: '' };
      refreshPanel();
    });
  });

  panelRoot.querySelector('[data-slx-save-diary-edit]')?.addEventListener('click', () => {
    saveDiaryEdit(panelRoot);
  });

  panelRoot.querySelectorAll('[data-slx-diary-api-mode]').forEach(button => {
    button.addEventListener('click', () => {
      const chatState = getChatState();
      const store = getDiaryStore(chatState);
      store.settings.apiMode = button.dataset.slxDiaryApiMode === 'secondary' ? 'secondary' : 'main';
      store.lastSavedAt = formatTimestamp();
      saveChatState();
      refreshPanel();
    });
  });

  [
    '[data-slx-diary-user-color]',
    '[data-slx-diary-character-color]',
    '[data-slx-diary-cover-preset]',
    '[data-slx-diary-page-preset]',
    '[data-slx-diary-custom-cover]',
    '[data-slx-diary-custom-page]',
  ].forEach(selector => {
    panelRoot.querySelector(selector)?.addEventListener('change', () => saveDiarySettings(panelRoot));
  });

  panelRoot.querySelector('[data-slx-diary-upload-cover]')?.addEventListener('change', event => {
    void uploadDiaryImage(event.currentTarget, 'customCover');
  });

  panelRoot.querySelector('[data-slx-diary-upload-page]')?.addEventListener('change', event => {
    void uploadDiaryImage(event.currentTarget, 'customPage');
  });

  panelRoot.querySelector('[data-slx-clear-diary-cover]')?.addEventListener('click', () => {
    clearDiaryImage('customCover');
  });

  panelRoot.querySelector('[data-slx-clear-diary-page]')?.addEventListener('click', () => {
    clearDiaryImage('customPage');
  });
}
