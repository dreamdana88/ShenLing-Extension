// 回忆录世界书 API 封装层：优先 TavernHelper 世界书 API（见 @types/function/worldbook.d.ts）。
// 阶段一诊断已验证本环境 TavernHelper 世界书函数全可用；此层供正式 workflow（创建/绑定/写条目）复用。
// 未来若要支持无 TavernHelper 环境，再在此补 ST 原生 world-info.js 回退。

const TH_WORLDBOOK_FN_NAMES = [
  'getWorldbookNames',
  'getCharWorldbookNames',
  'getChatWorldbookName',
  'getOrCreateChatWorldbook',
  'rebindChatWorldbook',
  'getWorldbook',
  'createWorldbook',
  'createWorldbookEntries',
  'updateWorldbookWith',
  'replaceWorldbook',
  'deleteWorldbook',
  'deleteWorldbookEntries',
];

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

/** 回忆录写入与“新建并切换”所需的最小函数是否可用 */
export function isWorldbookApiAvailable() {
  return !!resolveThFn('getWorldbookNames')
    && !!resolveThFn('getChatWorldbookName')
    && !!resolveThFn('rebindChatWorldbook')
    && !!resolveThFn('getWorldbook')
    && !!resolveThFn('createWorldbook')
    && !!resolveThFn('updateWorldbookWith');
}

/** 设定采集浏览与材料解析只需要世界书只读能力。 */
export function getWorldbookReadApi() {
  const getWorldbookNames = resolveThFn('getWorldbookNames');
  const getWorldbook = resolveThFn('getWorldbook');
  if (!getWorldbookNames || !getWorldbook) {
    throw new Error('未找到 TavernHelper 世界书只读 API，无法浏览世界书条目。');
  }
  // getCharWorldbookNames 用于只读取当前角色卡绑定的世界书；旧环境可能缺失，缺失时置 null 交由上层降级。
  const getCharWorldbookNames = resolveThFn('getCharWorldbookNames');
  return { getWorldbookNames, getWorldbook, getCharWorldbookNames };
}

/**
 * 返回一组已绑定的 TavernHelper 世界书函数；缺少关键函数时抛错。
 * @returns {{ getWorldbookNames, getChatWorldbookName, getOrCreateChatWorldbook, rebindChatWorldbook,
 *   getWorldbook, createWorldbook, createWorldbookEntries, updateWorldbookWith, replaceWorldbook,
 *   deleteWorldbook, deleteWorldbookEntries }}
 */
export function getWorldbookApi() {
  const api = {};
  for (const name of TH_WORLDBOOK_FN_NAMES) {
    const fn = resolveThFn(name);
    if (fn) api[name] = fn;
  }
  if (
    !api.getWorldbookNames
    || !api.getChatWorldbookName
    || !api.rebindChatWorldbook
    || !api.getWorldbook
    || !api.createWorldbook
    || !api.updateWorldbookWith
  ) {
    throw new Error('未找到 TavernHelper 世界书 API（回忆录功能需要酒馆助手环境）。');
  }
  return api;
}
