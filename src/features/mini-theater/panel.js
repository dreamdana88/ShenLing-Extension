import { buildApiUrl } from "../../core/api.js";
import {
  formatShenlingContextForPrompt,
  resolveShenlingContext,
} from "../../core/context-resolver.js";
import { replacePromptMessageMacros } from "../../core/macros.js";
import {
  getContextInfo,
  getChatState,
  getGlobalSettings,
  getWordReplaceSettings,
  saveChatState,
  saveGlobalSettings,
} from "../../core/settings.js";
import { getOpenAiResponseContent } from "../../core/summary.js";
import {
  buildMiniTheaterPrompt,
  SUMMARY_SUPPORT_MESSAGES,
} from "../../prompts.js";
import { escapeHtml, formatTimestamp } from "../../utils/text.js";
import { applyWordReplacementToGeneratedContent } from "../word-replace/generated.js";

let panelOptions = {
  addCommunicationLog: null,
  closePanel: null,
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
  selectedStyle: null, // { id, name, content } | null
  generationStatus: "idle", // 'idle' | 'running' | 'success' | 'failed'
  generationError: "",
  result: null,
  previewEditing: false,
  previewDraft: null,
  collectionMode: "prompts", // 'prompts' | 'styles'
  promptSearch: "",
  promptSortBy: "newest", // 'newest' | 'name'
  promptFolderFilter: null, // folderId | null（null = 全部）
  modal: null, // 见下方 modal 类型注释
  pickSearch: "", // 从库选择弹窗内的搜索词
};

/*
  modal 类型：
  { type: 'prompt-form', promptId: null|string, fields: { name, content, folderId } }
  { type: 'style-form', styleId: null|string, fields: { name, content } }
  { type: 'folder-form', fields: { name } }
  { type: 'delete-confirm', target: 'prompt'|'folder'|'saved'|'style', id, name }
  { type: 'pick-prompt' }
  { type: 'pick-style' }
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

function notifyMiniTheater(type, message, title = "小剧场") {
  const toastr = globalThis.toastr || globalThis.parent?.toastr;
  if (toastr && typeof toastr[type] === "function") {
    toastr[type](message, title);
    return;
  }
  const logger = type === "error" ? console.error : console.info;
  logger(`[蜃灵助手] ${title}：${message}`);
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
  if (!Array.isArray(mt.styles)) mt.styles = [];
  return mt;
}

function getMiniTheaterStore() {
  const chatState = getChatState();
  chatState.miniTheater = chatState.miniTheater || {};
  if (!Array.isArray(chatState.miniTheater.results)) {
    chatState.miniTheater.results = [];
  }
  if (typeof chatState.miniTheater.lastGeneratedAt !== "string") {
    chatState.miniTheater.lastGeneratedAt = "";
  }
  return chatState.miniTheater;
}

function cloneTheaterResult(result) {
  if (!result) return null;
  return {
    id: result.id || genId(),
    promptName: result.promptName || "自定义小剧场",
    promptContent: result.promptContent || "",
    styleName: result.styleName || "",
    styleContent: result.styleContent || "",
    resultType: result.resultType === "html" ? "html" : "text",
    resultContent: result.resultContent || "",
    characterName: result.characterName || "",
    chatName: result.chatName || "",
    apiMode: result.apiMode || "",
    createdAt: result.createdAt || "",
    updatedAt: result.updatedAt || "",
    savedAt: result.savedAt || "",
    contextDiagnostics: result.contextDiagnostics || null,
  };
}

function getSavedTheaterResults() {
  const store = getMiniTheaterStore();
  return [...store.results]
    .map(cloneTheaterResult)
    .filter(Boolean)
    .sort((a, b) =>
      String(b.updatedAt || b.savedAt || b.createdAt).localeCompare(
        String(a.updatedAt || a.savedAt || a.createdAt),
      ),
    );
}

function isTheaterResultSaved(resultId) {
  if (!resultId) return false;
  return getMiniTheaterStore().results.some((item) => item.id === resultId);
}

function saveTheaterResultToStore(result) {
  const store = getMiniTheaterStore();
  const now = formatTimestamp();
  const next = {
    ...cloneTheaterResult(result),
    savedAt: result.savedAt || now,
    updatedAt: now,
  };
  const index = store.results.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    store.results[index] = {
      ...store.results[index],
      ...next,
      savedAt: store.results[index].savedAt || next.savedAt,
    };
  } else {
    store.results.unshift(next);
  }
  store.lastGeneratedAt = now;
  saveChatState();
  return cloneTheaterResult(index >= 0 ? store.results[index] : next);
}

function updateSavedTheaterResult(result) {
  if (!result?.id) return false;
  const store = getMiniTheaterStore();
  const index = store.results.findIndex((item) => item.id === result.id);
  if (index < 0) return false;
  store.results[index] = {
    ...store.results[index],
    ...cloneTheaterResult(result),
    savedAt: store.results[index].savedAt || result.savedAt || formatTimestamp(),
    updatedAt: result.updatedAt || formatTimestamp(),
  };
  store.lastGeneratedAt = store.results[index].updatedAt;
  saveChatState();
  return true;
}

function deleteSavedTheaterResult(resultId) {
  const store = getMiniTheaterStore();
  const before = store.results.length;
  store.results = store.results.filter((item) => item.id !== resultId);
  if (store.results.length !== before) {
    if (panelState.result?.id === resultId) {
      panelState.result = {
        ...panelState.result,
        savedAt: "",
        updatedAt: panelState.result.updatedAt || "",
      };
    }
    saveChatState();
  }
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

function getFilteredSortedStyles(styles, { search, sortBy }) {
  let result = [...styles];
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(
      (style) =>
        (style.name || "").toLowerCase().includes(q) ||
        (style.content || "").toLowerCase().includes(q),
    );
  }
  if (sortBy === "name") {
    result.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh"));
  } else {
    result.sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
    );
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

function buildMiniTheaterMessages({ userPrompt, styleContent, contextMaterial }) {
  return replacePromptMessageMacros([
    ...SUMMARY_SUPPORT_MESSAGES.map((message) => ({ ...message })),
    {
      role: "user",
      content: buildMiniTheaterPrompt({ userPrompt, styleContent, contextMaterial }),
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
  const selectedStyle = panelState.selectedStyle
    ? {
        id: panelState.selectedStyle.id || "",
        name: panelState.selectedStyle.name || "",
        content: panelState.selectedStyle.content || "",
      }
    : null;

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
    messages = buildMiniTheaterMessages({
      userPrompt,
      styleContent: selectedStyle?.content || "",
      contextMaterial,
    });
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
    const wordReplacement = applyWordReplacementToGeneratedContent(
      content,
      getWordReplaceSettings(getGlobalSettings()),
      { mode: resultType },
    );
    if (wordReplacement.errors.length > 0) {
      throw new Error(`词汇替换规则错误：${wordReplacement.errors.join("；")}`);
    }
    const result = {
      id: genId(),
      promptName: panelState.promptSource?.name || "自定义小剧场",
      promptContent: userPrompt,
      styleName: selectedStyle?.name || "",
      styleContent: selectedStyle?.content || "",
      resultType,
      resultContent: wordReplacement.text,
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
      requestBody: { ...requestBody, contextDiagnostics, selectedStyle },
      responseText: apiResult.responseText,
      rawResultContent: content,
      parsedResult: result,
      wordReplacement,
    });

    if (wordReplacement.replacements > 0) {
      notifyMiniTheater(
        "success",
        `小剧场生成结果已替换 ${wordReplacement.replacements} 处。`,
        "禁词替换",
      );
    }

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
        ? { ...requestBody, contextDiagnostics, selectedStyle }
        : { contextDiagnostics, selectedStyle },
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
  panelState.previewEditing = false;
  panelState.previewDraft = null;
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

async function copyTextToClipboard(content) {
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

async function copyTheaterResult() {
  await copyTextToClipboard(String(panelState.result?.resultContent || ""));
}

function putTextIntoSillyTavernChatInput(content) {
  const text = String(content || "").trim();
  if (!text) {
    notifyMiniTheater("warning", "这条小剧场提示词是空的。", "投到聊天");
    return false;
  }
  const textarea = document.querySelector("#send_textarea");
  if (!textarea) {
    notifyMiniTheater("error", "没有找到酒馆聊天输入框。", "投到聊天");
    return false;
  }
  const current = String(textarea.value || "").trimEnd();
  textarea.value = current ? `${current}\n\n${text}` : text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  getPanelOption("closePanel")?.();
  setTimeout(() => {
    textarea.focus?.();
    textarea.setSelectionRange?.(textarea.value.length, textarea.value.length);
  }, 0);
  notifyMiniTheater("success", "已放入酒馆聊天输入框。", "投到聊天");
  return true;
}

function startPreviewEditing(result = panelState.result) {
  if (!result) return;
  panelState.previewEditing = true;
  panelState.previewDraft = {
    title: result.promptName || "自定义小剧场",
    content: result.resultContent || "",
  };
}

function cancelPreviewEditing() {
  panelState.previewEditing = false;
  panelState.previewDraft = null;
}

function savePreviewEdit() {
  if (!panelState.result || !panelState.previewDraft) return;
  const title = String(panelState.previewDraft.title || "").trim() || "自定义小剧场";
  const content = String(panelState.previewDraft.content || "").trim();
  if (!content) return;
  const updated = {
    ...panelState.result,
    promptName: title,
    resultContent: content,
    resultType: detectTheaterResultType(content),
    updatedAt: formatTimestamp(),
  };
  panelState.result = updated;
  if (isTheaterResultSaved(updated.id)) {
    const saved = saveTheaterResultToStore(updated);
    panelState.result = { ...updated, savedAt: saved.savedAt };
  }
  cancelPreviewEditing();
}

function regeneratePreviewResult() {
  if (!panelState.result) return;
  const promptContent = String(panelState.result.promptContent || "").trim();
  if (promptContent) {
    panelState.promptText = promptContent;
    panelState.promptSource =
      panelState.result.promptName && panelState.result.promptName !== "自定义小剧场"
        ? { id: "", name: panelState.result.promptName }
        : null;
  }
  panelState.selectedStyle = String(panelState.result.styleContent || "").trim()
    ? {
        id: "",
        name: panelState.result.styleName || "当次文风",
        content: panelState.result.styleContent || "",
      }
    : null;
  cancelPreviewEditing();
  generateMiniTheater();
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
    { id: "prompts", label: "收藏" },
    { id: "generate", label: "生成" },
    { id: "saves", label: "回看" },
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
      <button class="slx-theater-card-fly-btn" type="button" data-theater-chat-prompt="${escapeHtml(prompt.id)}" title="发送到聊天输入框" aria-label="发送到聊天输入框">
        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
      </button>
      <div class="slx-theater-prompt-card-body">
        <div class="slx-theater-prompt-card-name">${escapeHtml(prompt.name || "未命名")}</div>
        ${preview ? `<div class="slx-theater-prompt-card-preview">${escapeHtml(preview)}${hasMore ? "…" : ""}</div>` : ""}
        ${folderName ? `<span class="slx-theater-prompt-card-folder">${escapeHtml(folderName)}</span>` : ""}
      </div>
      <div class="slx-theater-prompt-card-actions">
        <button class="slx-soft-btn" type="button" data-theater-copy-prompt="${escapeHtml(prompt.id)}">复制</button>
        <button class="slx-soft-btn" type="button" data-theater-send-prompt="${escapeHtml(prompt.id)}">生成</button>
        <button class="slx-soft-btn" type="button" data-theater-edit-prompt="${escapeHtml(prompt.id)}">编辑</button>
        <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-delete-prompt="${escapeHtml(prompt.id)}">删除</button>
      </div>
    </div>
  `;
}

function renderCollectionModeSwitch() {
  const modes = [
    { id: "prompts", label: "小剧场" },
    { id: "styles", label: "文风" },
  ];
  return `
    <div class="slx-theater-collection-switch" role="tablist" aria-label="收藏类型">
      ${modes
        .map(
          (mode) => `
        <button
          class="slx-theater-folder-chip${panelState.collectionMode === mode.id ? " is-active" : ""}"
          type="button"
          data-theater-collection-mode="${escapeHtml(mode.id)}"
        >${escapeHtml(mode.label)}</button>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderStyleCard(style) {
  const preview = (style.content || "").slice(0, 75).replace(/[\r\n]+/g, " ");
  const hasMore = (style.content || "").length > 75;
  return `
    <div class="slx-theater-prompt-card" data-style-id="${escapeHtml(style.id)}">
      <div class="slx-theater-prompt-card-body">
        <div class="slx-theater-prompt-card-name">${escapeHtml(style.name || "未命名文风")}</div>
        ${preview ? `<div class="slx-theater-prompt-card-preview">${escapeHtml(preview)}${hasMore ? "…" : ""}</div>` : ""}
        <span class="slx-theater-prompt-card-folder">文风</span>
      </div>
      <div class="slx-theater-prompt-card-actions">
        <button class="slx-soft-btn" type="button" data-theater-copy-style="${escapeHtml(style.id)}">复制</button>
        <button class="slx-soft-btn" type="button" data-theater-use-style="${escapeHtml(style.id)}">用于生成</button>
        <button class="slx-soft-btn" type="button" data-theater-edit-style="${escapeHtml(style.id)}">编辑</button>
        <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-delete-style="${escapeHtml(style.id)}">删除</button>
      </div>
    </div>
  `;
}

function renderPromptsTab() {
  const mt = getMiniTheaterSettings();
  const { folders, prompts, styles } = mt;
  const isStyleMode = panelState.collectionMode === "styles";
  const filtered = getFilteredSortedPrompts(prompts, {
    search: panelState.promptSearch,
    folderId: panelState.promptFolderFilter,
    sortBy: panelState.promptSortBy,
  });
  const filteredStyles = getFilteredSortedStyles(styles, {
    search: panelState.promptSearch,
    sortBy: panelState.promptSortBy,
  });

  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      ${renderCollectionModeSwitch()}
      <div class="slx-theater-prompts-toolbar">
        <input
          class="slx-theater-search-input"
          type="search"
          placeholder="${isStyleMode ? "搜索文风…" : "搜索提示词…"}"
          value="${escapeHtml(panelState.promptSearch)}"
          data-theater-prompt-search
          aria-label="${isStyleMode ? "搜索文风" : "搜索提示词"}"
        >
        <select class="slx-theater-sort-select" data-theater-sort aria-label="排序方式">
          <option value="newest" ${panelState.promptSortBy === "newest" ? "selected" : ""}>最新</option>
          <option value="name" ${panelState.promptSortBy === "name" ? "selected" : ""}>名称</option>
        </select>
        <button class="slx-soft-btn" type="button" ${isStyleMode ? "data-theater-new-style" : "data-theater-new-prompt"}>＋ 新建</button>
      </div>

      ${isStyleMode ? "" : renderFolderChips(folders)}

      ${
        isStyleMode
          ? filteredStyles.length === 0
            ? `<div class="slx-detail-card slx-theater-empty-state">
                 <div class="slx-theater-empty-icon">✒️</div>
                 <p>${styles.length === 0 ? "还没有收藏的文风" : "没有符合条件的文风"}</p>
                 ${styles.length === 0 ? '<button class="slx-soft-btn" type="button" data-theater-new-style>＋ 新建第一条</button>' : ""}
               </div>`
            : `<div class="slx-theater-prompt-list">
                 ${filteredStyles.map(renderStyleCard).join("")}
               </div>`
          : filtered.length === 0
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
  const isFailed = panelState.generationStatus === "failed";
  const hasResult = Boolean(panelState.result);
  const buttonLabel = isRunning
    ? "生成中…"
    : "生成";
  const buttonClass = [
    "slx-soft-btn",
    "slx-theater-generate-btn",
    isRunning ? "is-running" : "",
    isFailed ? "is-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const styleButtonLabel = panelState.selectedStyle
    ? `文风：${panelState.selectedStyle.name || "未命名"}`
    : "选择文风";
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
          <button class="slx-soft-btn" type="button" data-theater-pick-prompt>收藏夹</button>
          <button class="slx-soft-btn" type="button" data-theater-pick-style>${escapeHtml(styleButtonLabel)}</button>
        </div>
      </div>

      <div class="slx-action-row slx-theater-generate-actions">
        <button class="${buttonClass}" type="button" data-theater-generate ${isRunning ? 'disabled aria-busy="true"' : ""}>
          ${escapeHtml(buttonLabel)}
        </button>
        ${hasResult ? '<button class="slx-soft-btn slx-theater-open-preview-btn" type="button" data-theater-open-preview>预览</button>' : ""}
        ${isFailed ? '<button class="slx-soft-btn" type="button" data-theater-generate>重试</button>' : ""}
      </div>
    </div>
  `;
}

// ── Tab 3：已收藏回看 ─────────────────────────────────────────────────

function renderSavedResultCard(result) {
  const preview = String(result.resultContent || "").slice(0, 110).replace(/[\r\n]+/g, " ");
  const hasMore = String(result.resultContent || "").length > 110;
  const meta = [
    result.resultType === "html" ? "HTML" : "文字",
    result.characterName || "",
    result.savedAt || result.updatedAt || result.createdAt || "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <div class="slx-theater-saved-card">
      <div class="slx-theater-saved-card-body">
        <div class="slx-theater-saved-card-name">${escapeHtml(result.promptName || "未命名小剧场")}</div>
        <div class="slx-theater-saved-card-meta">${escapeHtml(meta)}</div>
        ${preview ? `<div class="slx-theater-saved-card-preview">${escapeHtml(preview)}${hasMore ? "…" : ""}</div>` : ""}
      </div>
      <div class="slx-theater-saved-card-actions">
        <button class="slx-soft-btn" type="button" data-theater-open-saved="${escapeHtml(result.id)}">打开</button>
        <button class="slx-soft-btn" type="button" data-theater-edit-saved="${escapeHtml(result.id)}">编辑</button>
        <button class="slx-soft-btn" type="button" data-theater-copy-saved="${escapeHtml(result.id)}">复制</button>
        <button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-delete-saved="${escapeHtml(result.id)}">删除</button>
      </div>
    </div>
  `;
}

function renderSavesTab() {
  const results = getSavedTheaterResults();
  return `
    <div class="slx-theater-tab-content" role="tabpanel">
      ${
        results.length === 0
          ? `<div class="slx-detail-card slx-theater-empty-state">
               <div class="slx-theater-empty-icon">🎬</div>
               <p>还没有收藏的小剧场</p>
             </div>`
          : `<div class="slx-theater-saved-list">
               ${results.map(renderSavedResultCard).join("")}
             </div>`
      }
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

  if (m.type === "style-form") {
    const isEdit = Boolean(m.styleId);
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">${isEdit ? "编辑文风" : "新建文风"}</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body">
        <div class="slx-theater-form-field">
          <label for="slx-theater-style-modal-name">名称</label>
          <input id="slx-theater-style-modal-name" type="text" class="slx-theater-text-input"
            value="${escapeHtml(m.fields.name)}" placeholder="例如：冷淡克制、古风留白…"
            data-theater-modal-field="name" maxlength="60" autocomplete="off">
        </div>
        <div class="slx-theater-form-field">
          <label for="slx-theater-style-modal-content">文风要求</label>
          <textarea id="slx-theater-style-modal-content" class="slx-theater-prompt-textarea slx-theater-modal-textarea" rows="12"
            placeholder="写下文风、叙事视角、节奏、修辞、禁忌等要求…"
            data-theater-modal-field="content"
          >${escapeHtml(m.fields.content)}</textarea>
        </div>
      </div>
      <div class="slx-theater-modal-footer">
        ${
          isEdit
            ? `<button class="slx-soft-btn slx-theater-btn-danger" type="button" data-theater-modal-delete-style="${escapeHtml(m.styleId)}">删除</button>`
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

  if (m.type === "pick-style") {
    const mt = getMiniTheaterSettings();
    const filtered = getFilteredSortedStyles(mt.styles, {
      search: panelState.pickSearch,
      sortBy: "name",
    });
    return `
      <div class="slx-theater-modal-header">
        <span class="slx-theater-modal-title">选择文风</span>
        <button class="slx-icon-btn" type="button" data-theater-modal-close aria-label="关闭">×</button>
      </div>
      <div class="slx-theater-modal-body slx-theater-pick-body">
        <input type="search" class="slx-theater-search-input" placeholder="搜索文风…"
          value="${escapeHtml(panelState.pickSearch)}"
          data-theater-pick-search aria-label="搜索文风">
        <div class="slx-theater-pick-list">
          <button class="slx-theater-pick-item" type="button" data-theater-clear-style>
            <span class="slx-theater-pick-item-name">不使用文风</span>
            <span class="slx-theater-pick-item-preview">仅按小剧场提示词本身生成</span>
          </button>
          ${
            filtered.length === 0
              ? `<p style="color:var(--slx-muted);font-size:12px;padding:8px 0;margin:0">
                ${mt.styles.length === 0 ? "文风库为空，请先在收藏页新建文风" : "没有匹配的文风"}</p>`
              : filtered
                  .map(
                    (style) => `
                <button class="slx-theater-pick-item" type="button" data-theater-pick-style-item="${escapeHtml(style.id)}">
                  <span class="slx-theater-pick-item-name">${escapeHtml(style.name || "未命名文风")}</span>
                  <span class="slx-theater-pick-item-preview">${escapeHtml((style.content || "").slice(0, 55))}${(style.content || "").length > 55 ? "…" : ""}</span>
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
    panelState.modal.type === "prompt-form" || panelState.modal.type === "style-form"
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
  const theme = getGlobalSettings().theme === "dark" ? "dark" : "light";
  const result = panelState.result;
  const info = getContextInfo();
  const isEditing = Boolean(result && panelState.previewEditing);
  const draft = panelState.previewDraft || {
    title: result?.promptName || "自定义小剧场",
    content: result?.resultContent || "",
  };
  const isSaved = Boolean(result && isTheaterResultSaved(result.id));
  const title = result?.promptName || "小剧场预览";
  const meta = result
    ? `${result.characterName || info.characterName} · ${result.chatName || info.chatName} · ${result.createdAt || ""}`
    : `${info.characterName} · ${info.chatName}`;
  const body = !result
    ? `<div class="slx-theater-text-body">
         <p class="slx-theater-text-placeholder">小剧场内容将在这里展示。生成结果如果包含 HTML，会自动进入安全预览；纯文字会按正文展示。</p>
       </div>`
    : isEditing
      ? `<div class="slx-theater-preview-edit-form">
           <label class="slx-theater-form-field">
             <span>标题</span>
             <input class="slx-theater-text-input" type="text" value="${escapeHtml(draft.title)}" data-theater-preview-edit-field="title" maxlength="80">
           </label>
           <label class="slx-theater-form-field slx-theater-preview-edit-content">
             <span>内容</span>
             <textarea class="slx-theater-prompt-textarea slx-theater-preview-edit-textarea" data-theater-preview-edit-field="content">${escapeHtml(draft.content)}</textarea>
           </label>
         </div>`
      : result.resultType === "html"
        ? `<div class="slx-theater-iframe-wrap">
           <iframe class="slx-theater-iframe" sandbox="" srcdoc="${escapeAttribute(result.resultContent)}"></iframe>
         </div>`
        : `<div class="slx-theater-text-body slx-theater-generated-text">${renderMarkdownText(result.resultContent)}</div>`;
  const bodyClass = [
    "slx-theater-preview-body",
    isEditing
      ? "slx-theater-preview-body-edit"
      : result?.resultType === "html"
      ? "slx-theater-preview-body-html"
      : "slx-theater-preview-body-text",
  ].join(" ");
  return `
    <div class="slx-theater-overlay slx-theater-preview-overlay" data-theme="${theme}" data-theater-overlay role="dialog" aria-modal="true" aria-label="小剧场预览">
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
          ${
            isEditing
              ? `<button class="slx-soft-btn" type="button" data-theater-cancel-preview-edit>取消</button>
                 <button class="slx-soft-btn slx-primary-btn" type="button" data-theater-save-preview-edit>保存编辑</button>`
              : `<button class="slx-soft-btn" type="button" data-theater-close-preview>关闭</button>
                 <button class="slx-soft-btn" type="button" data-theater-edit-preview ${result ? "" : "disabled"}>编辑</button>
                 <button class="slx-soft-btn" type="button" data-theater-save-result ${result ? "" : "disabled"}>${isSaved ? "取消收藏" : "收藏"}</button>
                 <button class="slx-soft-btn" type="button" data-theater-copy-result ${result ? "" : "disabled"}>${result?.resultType === "html" ? "复制 HTML" : "复制"}</button>
                 ${
                   result && !isSaved
                     ? `<button class="slx-soft-btn" type="button" data-theater-regenerate ${panelState.generationStatus === "running" ? "disabled" : ""}>重新生成</button>`
                     : ""
                 }`
          }
        </div>
      </div>
    </div>
  `;
}

function refreshPreviewOnly(root) {
  const current = root.querySelector("[data-theater-overlay]");
  if (!current) {
    refreshPanel();
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = renderPreviewOverlay().trim();
  const next = template.content.firstElementChild;
  if (!next) {
    current.remove();
    return;
  }
  current.replaceWith(next);
  bindMiniTheaterPreviewEvents(root);
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

function bindMiniTheaterPreviewEvents(root) {
  root.querySelectorAll("[data-theater-preview-edit-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      if (!panelState.previewDraft) return;
      const field = el.dataset.theaterPreviewEditField;
      panelState.previewDraft[field] = e.target.value;
    });
  });

  root
    .querySelector("[data-theater-edit-preview]")
    ?.addEventListener("click", () => {
      startPreviewEditing();
      refreshPreviewOnly(root);
    });

  root
    .querySelector("[data-theater-cancel-preview-edit]")
    ?.addEventListener("click", () => {
      cancelPreviewEditing();
      refreshPreviewOnly(root);
    });

  root
    .querySelector("[data-theater-save-preview-edit]")
    ?.addEventListener("click", () => {
      savePreviewEdit();
      refreshPreviewOnly(root);
    });

  root
    .querySelector("[data-theater-save-result]")
    ?.addEventListener("click", () => {
      if (!panelState.result) return;
      if (isTheaterResultSaved(panelState.result.id)) {
        deleteSavedTheaterResult(panelState.result.id);
        panelState.result = {
          ...panelState.result,
          savedAt: "",
          updatedAt: panelState.result.updatedAt || "",
        };
      } else {
        const saved = saveTheaterResultToStore(panelState.result);
        panelState.result = {
          ...panelState.result,
          savedAt: saved.savedAt,
          updatedAt: saved.updatedAt,
        };
      }
      refreshPreviewOnly(root);
    });

  root.querySelectorAll("[data-theater-close-preview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.previewOpen = false;
      cancelPreviewEditing();
      refreshPanel();
    });
  });

  root
    .querySelector("[data-theater-overlay]")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        panelState.previewOpen = false;
        cancelPreviewEditing();
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
      regeneratePreviewResult();
    });
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

  root.querySelectorAll("[data-theater-collection-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.collectionMode = btn.dataset.theaterCollectionMode === "styles" ? "styles" : "prompts";
      panelState.promptFolderFilter = null;
      refreshPanel();
    });
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

  root.querySelectorAll("[data-theater-new-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelState.modal = {
        type: "style-form",
        styleId: null,
        fields: { name: "", content: "" },
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

  root.querySelectorAll("[data-theater-chat-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mt = getMiniTheaterSettings();
      const prompt = mt.prompts.find(
        (p) => p.id === btn.dataset.theaterChatPrompt,
      );
      if (!prompt) return;
      putTextIntoSillyTavernChatInput(prompt.content || "");
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

  root.querySelectorAll("[data-theater-copy-style]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const style = getMiniTheaterSettings().styles.find(
        (item) => item.id === btn.dataset.theaterCopyStyle,
      );
      if (!style) return;
      try {
        await copyTextToClipboard(style.content || "");
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

  root.querySelectorAll("[data-theater-use-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const style = getMiniTheaterSettings().styles.find(
        (item) => item.id === btn.dataset.theaterUseStyle,
      );
      if (!style) return;
      panelState.selectedStyle = {
        id: style.id,
        name: style.name || "未命名文风",
        content: style.content || "",
      };
      panelState.activeTab = "generate";
      refreshPanel();
    });
  });

  root.querySelectorAll("[data-theater-edit-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const style = getMiniTheaterSettings().styles.find(
        (item) => item.id === btn.dataset.theaterEditStyle,
      );
      if (!style) return;
      panelState.modal = {
        type: "style-form",
        styleId: style.id,
        fields: {
          name: style.name || "",
          content: style.content || "",
        },
      };
      refreshPanel();
    });
  });

  root.querySelectorAll("[data-theater-delete-style]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const style = getMiniTheaterSettings().styles.find(
        (item) => item.id === btn.dataset.theaterDeleteStyle,
      );
      if (!style) return;
      panelState.modal = {
        type: "delete-confirm",
        target: "style",
        id: style.id,
        name: style.name || "未命名文风",
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

  root
    .querySelector("[data-theater-pick-style]")
    ?.addEventListener("click", () => {
      panelState.pickSearch = "";
      panelState.modal = { type: "pick-style" };
      refreshPanel();
    });

  root.querySelectorAll("[data-theater-generate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      generateMiniTheater();
    });
  });
  root.querySelectorAll("[data-theater-open-preview]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!panelState.result) return;
      panelState.previewOpen = true;
      refreshPanel();
    });
  });

  // ── 预览弹窗 ──
  bindMiniTheaterPreviewEvents(root);

  // ── 回看操作 ──
  root.querySelectorAll("[data-theater-open-saved]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const result = getSavedTheaterResults().find(
        (item) => item.id === btn.dataset.theaterOpenSaved,
      );
      if (!result) return;
      panelState.result = result;
      panelState.generationStatus = "success";
      panelState.previewEditing = false;
      panelState.previewDraft = null;
      panelState.previewOpen = true;
      refreshPanel();
    });
  });

  root.querySelectorAll("[data-theater-edit-saved]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const result = getSavedTheaterResults().find(
        (item) => item.id === btn.dataset.theaterEditSaved,
      );
      if (!result) return;
      panelState.result = result;
      panelState.generationStatus = "success";
      panelState.previewOpen = true;
      startPreviewEditing(result);
      refreshPanel();
    });
  });

  root.querySelectorAll("[data-theater-copy-saved]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const result = getSavedTheaterResults().find(
        (item) => item.id === btn.dataset.theaterCopySaved,
      );
      if (!result) return;
      try {
        await copyTextToClipboard(result.resultContent || "");
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

  root.querySelectorAll("[data-theater-delete-saved]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const result = getSavedTheaterResults().find(
        (item) => item.id === btn.dataset.theaterDeleteSaved,
      );
      if (!result) return;
      panelState.modal = {
        type: "delete-confirm",
        target: "saved",
        id: result.id,
        name: result.promptName || "未命名小剧场",
      };
      refreshPanel();
    });
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

      if (m.type === "style-form") {
        const name = (m.fields.name || "").trim();
        const content = (m.fields.content || "").trim();
        if (!name || !content) return;
        const mt = getMiniTheaterSettings();
        if (m.styleId) {
          const existing = mt.styles.find((style) => style.id === m.styleId);
          if (existing) {
            existing.name = name;
            existing.content = content;
            existing.updatedAt = now;
            if (panelState.selectedStyle?.id === existing.id) {
              panelState.selectedStyle = {
                id: existing.id,
                name: existing.name || "未命名文风",
                content: existing.content || "",
              };
            }
          }
        } else {
          mt.styles.push({
            id: genId(),
            name,
            content,
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

  root
    .querySelector("[data-theater-modal-delete-style]")
    ?.addEventListener("click", function () {
      const styleId = this.dataset.theaterModalDeleteStyle;
      const style = getMiniTheaterSettings().styles.find((item) => item.id === styleId);
      if (!style) return;
      panelState.modal = {
        type: "delete-confirm",
        target: "style",
        id: styleId,
        name: style.name || "未命名文风",
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
      if (m.target === "style") {
        mt.styles = mt.styles.filter((style) => style.id !== m.id);
        if (panelState.selectedStyle?.id === m.id) {
          panelState.selectedStyle = null;
        }
      }
      if (m.target === "saved") {
        deleteSavedTheaterResult(m.id);
      } else {
        saveGlobalSettings();
      }
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

  root.querySelector("[data-theater-clear-style]")?.addEventListener("click", () => {
    panelState.selectedStyle = null;
    panelState.modal = null;
    panelState.activeTab = "generate";
    refreshPanel();
  });

  root.querySelectorAll("[data-theater-pick-style-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const style = getMiniTheaterSettings().styles.find(
        (item) => item.id === btn.dataset.theaterPickStyleItem,
      );
      if (!style) return;
      panelState.selectedStyle = {
        id: style.id,
        name: style.name || "未命名文风",
        content: style.content || "",
      };
      panelState.modal = null;
      panelState.activeTab = "generate";
      refreshPanel();
    });
  });
}
