import { buildApiUrl } from "../../core/api.js";
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from "../../core/context-resolver.js";
import { replacePromptMessageMacros } from "../../core/macros.js";
import {
  getContextInfo,
  getGlobalSettings,
  saveGlobalSettings,
} from "../../core/settings.js";
import { getOpenAiResponseContent } from "../../core/summary.js";
import { SUMMARY_SUPPORT_MESSAGES } from "../../prompts.js";
import { escapeHtml, formatTimestamp } from "../../utils/text.js";

let panelOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getGenerateRawFunction: null,
  refreshPanel: null,
};

let promptSearchRefreshTimer = null;
let pickSearchRefreshTimer = null;

const THEATER_GENERATION_TIMEOUT_MS = 120000;

// 跨渲染持久化的面板本地状态
let panelState = {
  activeTab: "prompts", // 'prompts' | 'generate' | 'saves'
  previewOpen: false,
  promptText: "",
  promptSource: null, // { id, name } | null
  generationStatus: "idle", // 'idle' | 'running' | 'success' | 'failed'
  generationError: "",
  result: null,
  promptSearch: "",
  promptSortBy: "newest", // 'newest' | 'name'
  promptFolderFilter: null, // folderId | null（null = 全部）
  modal: null, // 见下方 modal 类型注释
  pickSearch: "", // 从库选择弹窗内的搜索词
};

/*
  modal 类型：
  { type: 'prompt-form', promptId: null|string, fields: { name, content, folderId } }
  { type: 'folder-form', fields: { name } }
  { type: 'delete-confirm', target: 'prompt'|'folder', id, name }
  { type: 'pick-prompt' }
*/

export function configureMiniTheaterPanel(options = {}) {
  panelOptions = { ...panelOptions, ...options };
}

function refreshPanel() {
  if (typeof panelOptions.refreshPanel === "function") {
    panelOptions.refreshPanel();
  }
}

function getPanelOption(name) {
  const value = panelOptions[name];
  return typeof value === "function" ? value : null;
}

function refreshPanelDebounced(kind, delay = 450) {
  const key =
    kind === "pick" ? "pickSearchRefreshTimer" : "promptSearchRefreshTimer";
  if (key === "pickSearchRefreshTimer") {
    clearTimeout(pickSearchRefreshTimer);
    pickSearchRefreshTimer = setTimeout(refreshPanel, delay);
  } else {
    clearTimeout(promptSearchRefreshTimer);
    promptSearchRefreshTimer = setTimeout(refreshPanel, delay);
  }
}

// ── 数据访问 ──────────────────────────────────────────────────────────

function getMiniTheaterSettings() {
  const settings = getGlobalSettings();
  settings.modules = settings.modules || {};
  settings.modules.miniTheater = settings.modules.miniTheater || {};
  const mt = settings.modules.miniTheater;
  if (!["main_api", "secondary_api"].includes(mt.apiMode))
    mt.apiMode = "secondary_api";
  if (!Array.isArray(mt.folders)) mt.folders = [];
  if (!Array.isArray(mt.prompts)) mt.prompts = [];
  return mt;
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getFolderName(folderId, folders) {
  if (!folderId) return null;
  return folders.find((f) => f.id === folderId)?.name ?? null;
}

function getFilteredSortedPrompts(prompts, { search, folderId, sortBy }) {
  let result = [...prompts];
  if (folderId !== null) {
    result = result.filter((p) => (p.folderId || null) === folderId);
  }
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(
      (p) =>
        (p.name || "").toLowerCase().includes(q) ||
        (p.content || "").toLowerCase().includes(q),
    );
  }
  if (sortBy === "name") {
    result.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh"));
  } else {
    result.sort((a, b) => ((b.createdAt || "") > (a.createdAt || "") ? 1 : -1));
  }
  return result;
}

function withTimeout(promise, timeoutMs = THEATER_GENERATION_TIMEOUT_MS) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("小剧场生成超时，请稍后重试。")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer),
  );
}

function stripMarkdownFence(text) {
  const raw = String(text || "").trim();
  const matched = raw.match(/^```(?:html|HTML|text|txt)?\s*([\s\S]*?)\s*```$/);
  return (matched?.[1] || raw).trim();
}

function detectTheaterResultType(content) {
  const text = String(content || "").trim();
  return /(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<section[\s>]|<article[\s>]|<main[\s>]|<div[\s>])/i.test(
    text,
  )
    ? "html"
    : "text";
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function renderMarkdownInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return html;
}

function renderMarkdownText(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let listType = "";

  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length);
      output.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) {
      closeList();
      output.push("<hr>");
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      output.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      if (listType !== "ul") {
        closeList();
        output.push("<ul>");
        listType = "ul";
      }
      output.push(`<li>${renderMarkdownInline(unordered[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      if (listType !== "ol") {
        closeList();
        output.push("<ol>");
        listType = "ol";
      }
      output.push(`<li>${renderMarkdownInline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    output.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  }

  closeList();
  return output.join("\n");
}

function buildMiniTheaterPrompt({ userPrompt, contextMaterial }) {
  return [
    "当前蜃灵已进入小剧场专属梦境，小剧场内容须严格尊重梦境素材中的角色设定、关系、世界信息、近期剧情与情感档案。",
    "请只输出小剧场正文或完整静态 HTML，不要解释你的创作过程，不要输出上下文分析，不要要求用户补充。",
    "如果用户要求美化小剧场，请输出可直接渲染的 HTML/CSS。不要包含 <script>，不要依赖外部资源。",
    "如果用户没有要求 HTML，请输出自然的文字小剧场正文。",
    "",
    "以下是本次小剧场番外可参考的梦境上下文素材：",
    "",
    contextMaterial || "（未读取到额外上下文）",
    "",
    `【梦境小剧场要求】\n${userPrompt}`,
    "",
    "【小剧场筑部清单】",
    "以下步骤仅用于小剧场构筑与校准，不要输出分析、清单或思考过程；完成校准后，只输出完整小剧场正文。",
    "",
    "### 背景回响",
    "- a. 分析【梦境小剧场要求】的内容与意图",
    "- b. 判断小剧场类型（文字故事类 / 美化页面类）",
    "- c. 判断梦境素材中的世界设定与禁忌",
    "- d. 梳理过往故事发展情节",
    "",
    "### 角色回响",
    "- a. 逐个分析主要角色信息：",
    "  - 0. 启用语言 / 角色母语",
    "  - 1. 糅合角色信息与性格人设",
    "  - 2. 根据小剧场需求创造合理化身份",
    "  - 3. 应规避的 OOC 方向",
    "",
    "### 织境定格",
    "综合以上角色与背景信息，确定小剧场所处时间、季节、天气等外部信息。",
    "",
    "### 编织梦境大纲",
    "- 美化页面类：梳理内容构架与视觉规范",
    "  - 应适配手机与电脑双端；字体颜色与背景保持足够对比度，确保清晰可读护眼",
    "  - 美化风格应契合世界观与故事背景",
    "- 文字故事类：设计起承转合与结尾收束方式",
    "",
    "### 检验与校正",
    "- a. 是否遵循女性凝视、女本位、去男权化",
    "- b. NPC 是否避免性别刻板",
    "",
    "对校准后大纲进行以上自检并优化调整，之后输出完整小剧场正文。",
  ].join("\n");
}

function buildMiniTheaterMessages({ userPrompt, contextMaterial }) {
  return replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map((message) => ({ ...message })),
    {
      role: "user",
      content: buildMiniTheaterPrompt({ userPrompt, contextMaterial }),
    },
  ]);
}

function buildTheaterContextDiagnostics(context = {}) {
  return {
    purpose: context.purpose,
    targetRoleName: context.targetRoleName,
    recentMessageCount: context.diagnostics?.recentMessageCount ?? 0,
    memoryCount: context.diagnostics?.memoryCount ?? 0,
    grandMemoryCount: context.diagnostics?.grandMemoryCount ?? 0,
    emotionProfileCount: context.diagnostics?.emotionProfileCount ?? 0,
    worldInfo: context.diagnostics?.worldInfo || {},
  };
}

async function requestMiniTheaterMainApi({ messages }) {
  const generateRaw = getPanelOption("getGenerateRawFunction")?.();
  if (typeof generateRaw !== "function") {
    throw new Error("当前环境未发现 generateRaw，无法调用酒馆主 API。");
  }
  const requestBody = { prompt: messages };
  const responseText = await withTimeout(
    Promise.resolve().then(() => generateRaw(requestBody)),
  );
  return {
    profileName: "酒馆当前连接",
    model: "酒馆主 API",
    url: "酒馆当前连接",
    requestBody,
    responseText: String(responseText || ""),
  };
}

async function requestMiniTheaterSecondaryApi({ messages }) {
  const profile = getPanelOption("getActiveApiProfile")?.(getGlobalSettings());
  if (!profile) throw new Error("当前环境未提供副 API 配置。");
  if (!String(profile.model || "").trim()) {
    throw new Error("请先在设置页选择小剧场生成模型。");
  }
  const url = buildApiUrl(profile);
  const requestBody = {
    model: String(profile.model).trim(),
    messages,
    stream: false,
  };
  const headers = { "Content-Type": "application/json" };
  if (String(profile.apiKey || "").trim()) {
    headers.Authorization = `Bearer ${String(profile.apiKey).trim()}`;
  }
  const response = await withTimeout(
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }),
  );
  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${responseText}`,
    );
  }
  return {
    profileName: profile.name || "未命名副 API",
    model: profile.model,
    url,
    httpStatus: `${response.status} ${response.statusText}`,
    requestBody,
    responseText,
    responseJson,
  };
}

async function runMiniTheaterGeneration() {
  const userPrompt = String(panelState.promptText || "").trim();
  if (!userPrompt) {
    throw new Error("请先输入小剧场提示词，或从提示词库选择一条。");
  }

  const info = getContextInfo();
  const mt = getMiniTheaterSettings();
  const apiMode = mt.apiMode;
  const startedAt = formatTimestamp();
  const startedMs = performance.now();
  let messages = [];
  let requestBody = null;
  let apiResult = null;
  let contextDiagnostics = null;

  try {
    const context = await resolveShenlingContext({
      purpose: "miniTheater",
      targetRoleName: info.characterName,
      recentMessageLimit: 8,
      memoryLimit: 4,
      grandMemoryLimit: 1,
      includeRecentChat: true,
      includeMemories: true,
      includeGrandMemories: true,
      includeEmotionProfile: true,
      includeWorldInfo: true,
      worldInfoMode: "cache_first",
    });
    contextDiagnostics = buildTheaterContextDiagnostics(context);
    const contextMaterial = formatShenlingContextForPrompt(context, {
      worldInfoMaterialMode: "injection_first",
    });
    messages = buildMiniTheaterMessages({ userPrompt, contextMaterial });
    apiResult =
      apiMode === "main_api"
        ? await requestMiniTheaterMainApi({ messages })
        : await requestMiniTheaterSecondaryApi({ messages });
    requestBody = apiResult.requestBody;

    const rawContent = apiResult.responseJson
      ? getOpenAiResponseContent(apiResult.responseJson)
      : apiResult.responseText;
    const content = stripMarkdownFence(rawContent);
    if (!content) throw new Error("小剧场生成结果为空。");
    const resultType = detectTheaterResultType(content);
    const result = {
      id: genId(),
      promptName: panelState.promptSource?.name || "自定义小剧场",
      promptContent: userPrompt,
      resultType,
      resultContent: content,
      characterName: info.characterName,
      chatName: info.chatName,
      apiMode,
      createdAt: formatTimestamp(),
      contextDiagnostics,
    };

    getPanelOption("addCommunicationLog")?.({
      moduleName:
        apiMode === "main_api" ? "小剧场 / 主 API" : "小剧场 / 副 API",
      taskType: "小剧场生成",
      status: "success",
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      profileName: apiResult.profileName,
      model: apiResult.model,
      url: apiResult.url,
      httpStatus: apiResult.httpStatus || "",
      messages,
      requestBody: { ...requestBody, contextDiagnostics },
      responseText: apiResult.responseText,
      parsedResult: result,
    });

    return result;
  } catch (error) {
    getPanelOption("addCommunicationLog")?.({
      moduleName:
        apiMode === "main_api" ? "小剧场 / 主 API" : "小剧场 / 副 API",
      taskType: "小剧场生成",
      status: "failure",
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      profileName:
        apiResult?.profileName ||
        (apiMode === "main_api" ? "酒馆当前连接" : ""),
      model: apiResult?.model || (apiMode === "main_api" ? "酒馆主 API" : ""),
      url: apiResult?.url || (apiMode === "main_api" ? "酒馆当前连接" : ""),
      httpStatus: apiResult?.httpStatus || "",
      messages,
      requestBody: requestBody
        ? { ...requestBody, contextDiagnostics }
        : { contextDiagnostics },
      responseText: apiResult?.responseText || "",
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

async function generateMiniTheater() {
  if (panelState.generationStatus === "running") return;
  panelState.generationStatus = "running";
  panelState.generationError = "";
  refreshPanel();
  try {
    panelState.result = await runMiniTheaterGeneration();
    panelState.generationStatus = "success";
    panelState.previewOpen = true;
  } catch (error) {
    panelState.generationStatus = "failed";
    panelState.generationError = error.message || String(error);
  }
  refreshPanel();
}

async function copyTheaterResult() {
  const content = String(panelState.result?.resultContent || "");
  if (!content) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

// ── API 切换 / 标签栏 ─────────────────────────────────────────────────

function renderApiToggle() {
  const mt = getMiniTheaterSettings();
  const apiMode = mt.apiMode;
  return `
    <div class="slx-theater-api-toggle" role="group" aria-label="小剧场生成 API">
      <button class="${apiMode === "main_api" ? "is-active" : ""}" type="button" data-theater-api-mode="main_api">主 API</button>
      <button class="${apiMode === "secondary_api" ? "is-active" : ""}" type="button" data-theater-api-mode="secondary_api">副 API</button>
    </div>
  `;
}

function renderTabBar() {
  const tabs = [
    { id: "prompts", label: "提示词库" },
    { id: "generate", label: "发送与生成" },
    { id: "saves", label: "已收藏回看" },
  ];
  return `
    <div class="slx-theater-tabbar-row">
      <div class="slx-theater-tabs" role="tablist">
        ${tabs
          .map(
            (tab) => `
          <button
            class="slx-theater-tab${panelState.activeTab === tab.id ? " slx-theater-tab-active" : ""}"
            type="button" role="tab"
            aria-selected="${panelState.activeTab === tab.id}"
            data-theater-tab="${escapeHtml(tab.id)}"
          >${escapeHtml(tab.label)}</button>
        `,
          )
          .join("")}
      </div>
      ${renderApiToggle()}
    </div>
  `;
}

// ── Tab 1：提示词库 ───────────────────────────────────────────────────

function renderFolderChips(folders) {
  const active = panelState.promptFolderFilter;
  const chips = [
    { id: null, label: "全部" },
    ...folders.map((f) => ({ id: f.id, label: f.name })),
  ];
  const activeFolder = active ? folders.find((f) => f.id === active) : null;
  return `
    <div class="slx-theater-folder-chips" role="group" aria-label="按文件夹筛选">
      ${chips
        .map(
          (c) => `
        <button
          class="slx-theater-folder-chip${(c.id === null ? active === null : active === c.id) ? " is-active" : ""}"
          type="button"
          data-theater-folder-filter="${c.id === null ? "" : escapeHtml(c.id)}"
        >${escapeHtml(c.label)}</button>
      `,
        )
        .join("")}
      <button class="slx-theater-folder-chip slx-theater-folder-chip-add" type="button" data-theater-new-folder>＋ 文件夹</button>
      ${
        activeFolder
          ? `
        <button
          class="slx-theater-folder-chip slx-theater-folder-chip-delete"
          type="button"
          data-theater-delete-folder="${escapeHtml(activeFolder.id)}"
        >删除当前文件夹</button>
      `
          : ""
      }
    </div>
  `;
}

function renderPromptCard(prompt, folders) {
  const folderName = getFolderName(prompt.folderId, folders);
  const preview = (prompt.content || "").slice(0, 65).replace(/[\r\n]+/g, " ");
  const hasMore = (prompt.content || "").length > 65;
  return `
    <div class="slx-theater-prompt-card" data-prompt-id="${escapeHtml(prompt.id)}">
      <div class="slx-theater-prompt-card-body">
        <div class="slx-theater-prompt-card-name">${escapeHtml(prompt.name || "未命名")}</div>
        ${preview ? `<div class="slx-theater-prompt-card-preview">${escapeHtml(preview)}${hasMore ? "…" : ""}</div>` : ""}
        ${folderName ? `<span class="slx-theater-prompt-card-folder">${escapeHtml(folderName)}</span>` : ""}
      </div>
      <div class="slx-theater-prompt-card-actions">
        <button class="slx-soft-btn" type="button" data-theater-copy-prompt="${escapeHtml(prompt.id)}">复制</button>
        <button class="slx-soft-btn" type="button" data-theater-send-prompt="${escapeHtml(prompt.id)}">发送到生成</button>
        <button class="slx-soft-btn" type="button" data-theater-edit-prompt="${escapeHtml(prompt.id)}">编辑</button>
        <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-delete-prompt="${escapeHtml(prompt.id)}">删除</button>
      </div>
    </div>
  `;
}

function renderPromptsTab() {
  const mt = getMiniTheaterSettings();
  const { folders, prompts } = mt;
  const filtered = getFilteredSortedPrompts(prompts, {
    search: panelState.promptSearch,
    folderId: panelState.promptFolderFilter,
    sortBy: panelState.promptSortBy,
  });

  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-theater-prompts-toolbar">
        <input
          class="slx-theater-search-input"
          type="search"
          placeholder="搜索提示词…"
          value="${escapeHtml(panelState.promptSearch)}"
          data-theater-prompt-search
          aria-label="搜索提示词"
        >
        <select class="slx-theater-sort-select" data-theater-sort aria-label="排序方式">
          <option value="newest" ${panelState.promptSortBy === "newest" ? "selected" : ""}>最新</option>
          <option value="name" ${panelState.promptSortBy === "name" ? "selected" : ""}>名称</option>
        </select>
        <button class="slx-soft-btn" type="button" data-theater-new-prompt>＋ 新建</button>
      </div>

      ${renderFolderChips(folders)}

      ${
        filtered.length === 0
          ? `<div class="slx-detail-card slx-theater-empty-state">
           <div class="slx-theater-empty-icon">📝</div>
           <p>${prompts.length === 0 ? "还没有收藏的提示词" : "没有符合条件的提示词"}</p>
           ${prompts.length === 0 ? '<button class="slx-soft-btn" type="button" data-theater-new-prompt>＋ 新建第一条</button>' : ""}
         </div>`
          : `<div class="slx-theater-prompt-list">
           ${filtered.map((p) => renderPromptCard(p, folders)).join("")}
         </div>`
      }
    </div>
  `;
}

// ── Tab 2：发送与生成 ─────────────────────────────────────────────────

function renderGenerateTab() {
  const isRunning = panelState.generationStatus === "running";
  const isSuccess = panelState.generationStatus === "success";
  const isFailed = panelState.generationStatus === "failed";
  const buttonLabel = isRunning
    ? "生成中…"
    : isSuccess
      ? "已生成 ✓"
      : "生成小剧场 ▶";
  const buttonClass = [
    "slx-soft-btn",
    "slx-theater-generate-btn",
    isRunning ? "is-running" : "",
    isSuccess ? "is-success" : "",
    isFailed ? "is-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-detail-card">
        <label class="slx-detail-title" for="slx-theater-prompt-input">提示词内容</label>
        <textarea
          id="slx-theater-prompt-input"
          class="slx-theater-prompt-textarea"
          rows="5"
          placeholder="输入小剧场提示词，或从提示词库中选择…"
          data-theater-prompt-text
        >${escapeHtml(panelState.promptText)}</textarea>
        <div class="slx-action-row">
          <button class="slx-soft-btn" type="button" data-theater-pick-prompt>从提示词库选择</button>
          ${
            panelState.promptSource
              ? `<span class="slx-theater-source-bar">
               来源：${escapeHtml(panelState.promptSource.name)}
               <button class="slx-theater-source-clear" type="button" data-theater-clear-source aria-label="清除来源">✕</button>
             </span>`
              : ""
          }
        </div>
      </div>

      <div class="slx-action-row">
        <button class="${buttonClass}" type="button" data-theater-generate ${isRunning ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(buttonLabel)}
        </button>
        ${isFailed ? '<button class="slx-soft-btn" type="button" data-theater-generate>重试</button>' : ""}
      </div>
    </div>
  `;
}

// ── Tab 3：已收藏回看 ─────────────────────────────────────────────────

function renderSavesTab() {
  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      <div class="slx-detail-card slx-theater-empty-state">
        <div class="slx-theater-empty-icon">🎬</div>
        <p>生成后的小剧场将在这里留档</p>
      </div>
    </div>
  `;
}

// ── 模态弹窗 ──────────────────────────────────────────────────────────

function renderModalContent() {
  const m = panelState.modal;
  if (!m) return "";

  if (m.type === "prompt-form") {
    const mt = getMiniTheaterSettings();
    const isEdit = Boolean(m.promptId);
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">${isEdit ? "编辑提示词" : "新建提示词"}</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <div class="slx-theater-modal-form-row">
          <div class="slx-theater-form-field">
            <label for="slx-theater-modal-name">名称</label>
            <input id="slx-theater-modal-name" type="text" class="slx-theater-text-input"
              value="${escapeHtml(m.fields.name)}" placeholder="给提示词起个名字…"
              data-theater-modal-field="name" maxlength="60" autocomplete="off">
          </div>
          <div class="slx-theater-form-field slx-theater-folder-field">
            <label for="slx-theater-modal-folder">文件夹</label>
            <select id="slx-theater-modal-folder" class="slx-theater-select" data-theater-modal-field="folderId">
              <option value="" ${!m.fields.folderId ? "selected" : ""}>未分类</option>
              ${mt.folders
                .map(
                  (f) => `
                <option value="${escapeHtml(f.id)}" ${m.fields.folderId === f.id ? "selected" : ""}>${escapeHtml(f.name)}</option>
              `,
                )
                .join("")}
            </select>
          </div>
        </div>
        <div class="slx-theater-form-field">
          <label for="slx-theater-modal-content">内容</label>
          <textarea id="slx-theater-modal-content" class="slx-theater-prompt-textarea slx-theater-modal-textarea" rows="12"
            placeholder="提示词正文…"
            data-theater-modal-field="content"
          >${escapeHtml(m.fields.content)}</textarea>
        </div>
      </div>
      <div class="slx-theater-modal-footer">
        ${
          isEdit
            ? `<button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-modal-delete-prompt="${escapeHtml(m.promptId)}">删除</button>`
            : "<span></span>"
        }
        <div style="display:flex;gap:8px">
          <button class="slx-soft-btn" type="button" data-theater-modal-close>取消</button>
          <button class="slx-soft-btn slx-primary-btn slx-theater-modal-primary-btn" type="button" data-theater-modal-save>保存</button>
        </div>
      </div>
    `;
  }

  if (m.type === "folder-form") {
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">新建文件夹</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <div class="slx-theater-form-field">
          <label for="slx-theater-modal-folder-name">文件夹名称</label>
          <input id="slx-theater-modal-folder-name" type="text" class="slx-theater-text-input"
            value="${escapeHtml(m.fields.name)}" placeholder="例如：浪漫番外"
            data-theater-modal-field="name" maxlength="30" autocomplete="off">
        </div>
      </div>
      <div class="slx-theater-modal-footer">
        <span></span>
        <div style="display:flex;gap:8px">
          <button class="slx-soft-btn" type="button" data-theater-modal-close>取消</button>
          <button class="slx-soft-btn slx-primary-btn slx-theater-modal-primary-btn" type="button" data-theater-modal-save>创建</button>
        </div>
      </div>
    `;
  }

  if (m.type === "delete-confirm") {
    const extra =
      m.target === "folder" ? "<br>文件夹内的提示词将移至未分类。" : "";
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">确认删除</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <p style="margin:0;line-height:1.6;color:var(--slx-text)">
          删除「${escapeHtml(m.name)}」？此操作无法撤销。${extra}
        </p>
      </div>
      <div class="slx-theater-modal-footer">
        <span></span>
        <div style="display:flex;gap:8px">
          <button class="slx-soft-btn" type="button" data-theater-modal-close>取消</button>
          <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-modal-confirm-delete>确认删除</button>
        </div>
      </div>
    `;
  }

  if (m.type === "pick-prompt") {
    const mt = getMiniTheaterSettings();
    const filtered = getFilteredSortedPrompts(mt.prompts, {
      search: panelState.pickSearch,
      folderId: null,
      sortBy: "name",
    });
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">选择提示词</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body slx-theater-pick-body">
        <input type="search" class="slx-theater-search-input" placeholder="搜索…"
          value="${escapeHtml(panelState.pickSearch)}"
          data-theater-pick-search aria-label="搜索提示词">
        <div class="slx-theater-pick-list">
          ${
            filtered.length === 0
              ? `<p style="color:var(--slx-muted);font-size:12px;padding:8px 0;margin:0">
                ${mt.prompts.length === 0 ? "提示词库为空，请先新建提示词" : "没有匹配的提示词"}</p>`
              : filtered
                  .map(
                    (p) => `
                <button class="slx-theater-pick-item" type="button" data-theater-pick-item="${escapeHtml(p.id)}">
                  <span class="slx-theater-pick-item-name">${escapeHtml(p.name || "未命名")}</span>
                  <span class="slx-theater-pick-item-preview">${escapeHtml((p.content || "").slice(0, 55))}${(p.content || "").length > 55 ? "…" : ""}</span>
                </button>
              `,
                  )
                  .join("")
          }
        </div>
      </div>
    `;
  }

  return "";
}

function renderModal() {
  if (!panelState.modal) return "";
  const modalClass = [
    "slx-theater-modal",
    panelState.modal.type === "prompt-form"
      ? "slx-theater-modal-prompt-form"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
    <div class="slx-theater-overlay slx-theater-modal-overlay" data-theater-modal-overlay role="dialog" aria-modal="true">
      <div class="${modalClass}">
        ${renderModalContent()}
      </div>
    </div>
  `;
}

// ── 预览弹窗 ──────────────────────────────────────────────────────────

function renderPreviewOverlay() {
  if (!panelState.previewOpen) return "";
  const result = panelState.result;
  const info = getContextInfo();
  const title = result?.promptName || "小剧场预览";
  const meta = result
    ? `${result.characterName || info.characterName} · ${result.chatName || info.chatName} · ${result.createdAt || ""}`
    : `${info.characterName} · ${info.chatName}`;
  const body = !result
    ? `<div class="slx-theater-text-body">
         <p class="slx-theater-text-placeholder">小剧场内容将在这里展示。生成结果如果包含 HTML，会自动进入安全预览；纯文字会按正文展示。</p>
       </div>`
    : result.resultType === "html"
      ? `<div class="slx-theater-iframe-wrap">
           <iframe class="slx-theater-iframe" sandbox="" srcdoc="${escapeAttribute(result.resultContent)}"></iframe>
         </div>`
      : `<div class="slx-theater-text-body slx-theater-generated-text">${renderMarkdownText(result.resultContent)}</div>`;
  const bodyClass = [
    "slx-theater-preview-body",
    result?.resultType === "html"
      ? "slx-theater-preview-body-html"
      : "slx-theater-preview-body-text",
  ].join(" ");
  return `
    <div class="slx-theater-overlay slx-theater-preview-overlay" data-theater-overlay role="dialog" aria-modal="true" aria-label="小剧场预览">
      <div class="slx-theater-preview">
        <div class="slx-theater-preview-header">
          <div class="slx-theater-preview-title-wrap">
            <span class="slx-theater-preview-title">${escapeHtml(title)}</span>
            <span class="slx-theater-preview-meta">${escapeHtml(meta)}</span>
          </div>
          <button class="slx-icon-btn" type="button" data-theater-close-preview aria-label="关闭预览">×</button>
        </div>
        <div class="${bodyClass}">
          ${body}
        </div>
        <div class="slx-theater-preview-footer">
          <button class="slx-soft-btn" type="button" data-theater-close-preview>关闭</button>
          <button class="slx-soft-btn" type="button" disabled title="0.4 版本接入">收藏</button>
          <button class="slx-soft-btn" type="button" data-theater-copy-result ${result ? "" : "disabled"}>${result?.resultType === "html" ? "复制 HTML" : "复制"}</button>
          <button class="slx-soft-btn" type="button" data-theater-regenerate ${panelState.generationStatus === "running" ? "disabled" : ""}>重新生成</button>
        </div>
      </div>
    </div>
  `;
}

// ── 主渲染入口 ────────────────────────────────────────────────────────

export function renderMiniTheaterPanel() {
  return `
    <div class="slx-theater-root" data-theater-root>
      ${renderTabBar()}
      ${renderActiveTab()}
      ${renderPreviewOverlay()}
      ${renderModal()}
    </div>
  `;
}

function renderActiveTab() {
  switch (panelState.activeTab) {
    case "generate":
      return renderGenerateTab();
    case "saves":
      return renderSavesTab();
    default:
      return renderPromptsTab();
  }
}

// ── 事件绑定 ──────────────────────────────────────────────────────────

export function bindMiniTheaterPanelEvents(panelRoot) {
  const root = panelRoot.querySelector("[data-theater-root]");
  if (!root) return;

  // ── 标签切换 ──
  root.querySelectorAll("[data-theater-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.activeTab = btn.dataset.theaterTab;
      refreshPanel();
    });
  });

  // ── API 模式 ──
  root.querySelectorAll("[data-theater-api-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.theaterApiMode;
      if (!["main_api", "secondary_api"].includes(mode)) return;
      getMiniTheaterSettings().apiMode = mode;
      saveGlobalSettings();
      refreshPanel();
    });
  });

  // ── 提示词库：搜索 / 排序 / 文件夹筛选 ──
  root
    .querySelector("[data-theater-prompt-search]")
    ?.addEventListener("input", (e) => {
      panelState.promptSearch = e.target.value;
      refreshPanelDebounced("prompt");
    });

  root.querySelector("[data-theater-sort]")?.addEventListener("change", (e) => {
    panelState.promptSortBy = e.target.value;
    refreshPanel();
  });

  root.querySelectorAll("[data-theater-folder-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.theaterFolderFilter;
      panelState.promptFolderFilter = val === "" ? null : val;
      refreshPanel();
    });
  });

  // ── 新建提示词 ──
  root.querySelectorAll("[data-theater-new-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.modal = {
        type: "prompt-form",
        promptId: null,
        fields: { name: "", content: "", folderId: null },
      };
      refreshPanel();
    });
  });

  // ── 新建文件夹 ──
  root
    .querySelector("[data-theater-new-folder]")
    ?.addEventListener("click", () => {
      panelState.modal = { type: "folder-form", fields: { name: "" } };
      refreshPanel();
    });

  root
    .querySelector("[data-theater-delete-folder]")
    ?.addEventListener("click", (btn) => {
      const mt = getMiniTheaterSettings();
      const folder = mt.folders.find(
        (f) => f.id === btn.currentTarget.dataset.theaterDeleteFolder,
      );
      if (!folder) return;
      panelState.modal = {
        type: "delete-confirm",
        target: "folder",
        id: folder.id,
        name: folder.name || "未命名文件夹",
      };
      refreshPanel();
    });

  // ── 卡片操作 ──
  root.querySelectorAll("[data-theater-copy-prompt]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(
        (p) => p.id === btn.dataset.theaterCopyPrompt,
      );
      if (!prompt) return;
      try {
        await navigator.clipboard.writeText(prompt.content || "");
        const orig = btn.textContent;
        btn.textContent = "已复制 ✓";
        setTimeout(() => {
          btn.textContent = orig;
        }, 1400);
      } catch {
        btn.textContent = "复制失败";
      }
    });
  });

  root.querySelectorAll("[data-theater-send-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(
        (p) => p.id === btn.dataset.theaterSendPrompt,
      );
      if (!prompt) return;
      panelState.promptText = prompt.content || "";
      panelState.promptSource = {
        id: prompt.id,
        name: prompt.name || "未命名",
      };
      panelState.activeTab = "generate";
      refreshPanel();
    });
  });

  root.querySelectorAll("[data-theater-edit-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(
        (p) => p.id === btn.dataset.theaterEditPrompt,
      );
      if (!prompt) return;
      panelState.modal = {
        type: "prompt-form",
        promptId: prompt.id,
        fields: {
          name: prompt.name || "",
          content: prompt.content || "",
          folderId: prompt.folderId || null,
        },
      };
      refreshPanel();
    });
  });

  root.querySelectorAll("[data-theater-delete-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(
        (p) => p.id === btn.dataset.theaterDeletePrompt,
      );
      if (!prompt) return;
      panelState.modal = {
        type: "delete-confirm",
        target: "prompt",
        id: prompt.id,
        name: prompt.name || "未命名",
      };
      refreshPanel();
    });
  });

  // ── 发送与生成 tab ──
  root
    .querySelector("[data-theater-prompt-text]")
    ?.addEventListener("input", (e) => {
      panelState.promptText = e.target.value;
      if (panelState.promptSource) {
        panelState.promptSource = null;
        // 不 refreshPanel，避免光标跳位
      }
    });

  root
    .querySelector("[data-theater-clear-source]")
    ?.addEventListener("click", () => {
      panelState.promptSource = null;
      refreshPanel();
    });

  root
    .querySelector("[data-theater-pick-prompt]")
    ?.addEventListener("click", () => {
      panelState.pickSearch = "";
      panelState.modal = { type: "pick-prompt" };
      refreshPanel();
    });

  root.querySelectorAll("[data-theater-generate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      generateMiniTheater();
    });
  });

  // ── 预览弹窗 ──
  root.querySelectorAll("[data-theater-close-preview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.previewOpen = false;
      refreshPanel();
    });
  });
  root
    .querySelector("[data-theater-overlay]")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        panelState.previewOpen = false;
        refreshPanel();
      }
    });
  root
    .querySelector("[data-theater-copy-result]")
    ?.addEventListener("click", async function () {
      try {
        await copyTheaterResult();
        const orig = this.textContent;
        this.textContent = "已复制 ✓";
        setTimeout(() => {
          this.textContent = orig;
        }, 1400);
      } catch {
        this.textContent = "复制失败";
      }
    });
  root
    .querySelector("[data-theater-regenerate]")
    ?.addEventListener("click", () => {
      generateMiniTheater();
    });

  // ── 模态弹窗通用 ──
  root.querySelectorAll("[data-theater-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.modal = null;
      refreshPanel();
    });
  });

  root
    .querySelector("[data-theater-modal-overlay]")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        panelState.modal = null;
        refreshPanel();
      }
    });

  root.querySelectorAll("[data-theater-modal-field]").forEach((el) => {
    const event = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(event, (e) => {
      if (!panelState.modal?.fields) return;
      const field = el.dataset.theaterModalField;
      const val = e.target.value;
      panelState.modal.fields[field] = field === "folderId" ? val || null : val;
    });
  });

  root
    .querySelector("[data-theater-modal-save]")
    ?.addEventListener("click", () => {
      const m = panelState.modal;
      if (!m) return;
      const now = new Date().toISOString();

      if (m.type === "prompt-form") {
        const name = (m.fields.name || "").trim();
        if (!name) return;
        const mt = getMiniTheaterSettings();
        if (m.promptId) {
          const existing = mt.prompts.find((p) => p.id === m.promptId);
          if (existing) {
            existing.name = name;
            existing.content = (m.fields.content || "").trim();
            existing.folderId = m.fields.folderId || null;
            existing.updatedAt = now;
          }
        } else {
          mt.prompts.push({
            id: genId(),
            name,
            content: (m.fields.content || "").trim(),
            folderId: m.fields.folderId || null,
            createdAt: now,
            updatedAt: now,
          });
        }
        saveGlobalSettings();
        panelState.modal = null;
        refreshPanel();
      }

      if (m.type === "folder-form") {
        const name = (m.fields.name || "").trim();
        if (!name) return;
        getMiniTheaterSettings().folders.push({ id: genId(), name });
        saveGlobalSettings();
        panelState.modal = null;
        refreshPanel();
      }
    });

  // 从编辑模态内点删除 → 进入删除确认
  root
    .querySelector("[data-theater-modal-delete-prompt]")
    ?.addEventListener("click", function () {
      const promptId = this.dataset.theaterModalDeletePrompt;
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find((p) => p.id === promptId);
      if (!prompt) return;
      panelState.modal = {
        type: "delete-confirm",
        target: "prompt",
        id: promptId,
        name: prompt.name || "未命名",
      };
      refreshPanel();
    });

  // 确认删除
  root
    .querySelector("[data-theater-modal-confirm-delete]")
    ?.addEventListener("click", () => {
      const m = panelState.modal;
      if (!m || m.type !== "delete-confirm") return;
      const mt = getMiniTheaterSettings();
      if (m.target === "prompt") {
        mt.prompts = mt.prompts.filter((p) => p.id !== m.id);
        if (panelState.promptSource?.id === m.id)
          panelState.promptSource = null;
      }
      if (m.target === "folder") {
        mt.folders = mt.folders.filter((f) => f.id !== m.id);
        mt.prompts.forEach((p) => {
          if (p.folderId === m.id) p.folderId = null;
        });
        if (panelState.promptFolderFilter === m.id)
          panelState.promptFolderFilter = null;
      }
      saveGlobalSettings();
      panelState.modal = null;
      refreshPanel();
    });

  // ── 从库选择弹窗 ──
  root
    .querySelector("[data-theater-pick-search]")
    ?.addEventListener("input", (e) => {
      panelState.pickSearch = e.target.value;
      refreshPanelDebounced("pick");
    });

  root.querySelectorAll("[data-theater-pick-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(
        (p) => p.id === btn.dataset.theaterPickItem,
      );
      if (!prompt) return;
      panelState.promptText = prompt.content || "";
      panelState.promptSource = {
        id: prompt.id,
        name: prompt.name || "未命名",
      };
      panelState.modal = null;
      panelState.activeTab = "generate";
      refreshPanel();
    });
  });
}
