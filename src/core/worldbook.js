// 世界书 Platform Provider：统一解析 TavernHelper 4.8.19 的真实世界书能力。
// 正式扩展环境使用 globalThis.TavernHelper；直接全局函数及 parent/top 路径仅作为
// TavernHelper iframe 暴露形式的 Compatibility，在能力解析阶段确定，不参与执行失败后的切换。

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
  return [...new Set(roots)];
}

function resolveTavernHelperWorldbookFunction(name) {
  for (const root of getTavernHelperRoots()) {
    if (typeof root?.[name] === 'function') return root[name].bind(root);
  }
  try {
    if (typeof globalThis[name] === 'function') return globalThis[name].bind(globalThis);
  } catch {}
  try {
    if (typeof globalThis.parent?.[name] === 'function') {
      return globalThis.parent[name].bind(globalThis.parent);
    }
  } catch {}
  return null;
}

/** Memoir 写入与“新建并切换”所需的最小函数是否可用。 */
export function isWorldbookApiAvailable() {
  return !!resolveTavernHelperWorldbookFunction('getWorldbookNames')
    && !!resolveTavernHelperWorldbookFunction('getChatWorldbookName')
    && !!resolveTavernHelperWorldbookFunction('rebindChatWorldbook')
    && !!resolveTavernHelperWorldbookFunction('getWorldbook')
    && !!resolveTavernHelperWorldbookFunction('createWorldbook')
    && !!resolveTavernHelperWorldbookFunction('updateWorldbookWith');
}

/** 只读消费者所需的世界书能力；角色绑定查询在旧 Compatibility 环境中允许缺失。 */
export function getWorldbookReadApi() {
  const getWorldbookNames = resolveTavernHelperWorldbookFunction('getWorldbookNames');
  const getWorldbook = resolveTavernHelperWorldbookFunction('getWorldbook');
  if (!getWorldbookNames || !getWorldbook) {
    throw new Error('未找到 TavernHelper 世界书只读 API，无法浏览世界书条目。');
  }
  const getCharWorldbookNames = resolveTavernHelperWorldbookFunction('getCharWorldbookNames');
  return { getWorldbookNames, getWorldbook, getCharWorldbookNames };
}

/**
 * 返回当前环境已解析并绑定的世界书能力；缺少 Memoir 关键函数时抛错。
 * Provider 选定后的调用异常由调用方直接接收，不会重新扫描其他 root。
 */
export function getWorldbookApi() {
  const api = {};
  for (const name of TH_WORLDBOOK_FN_NAMES) {
    const fn = resolveTavernHelperWorldbookFunction(name);
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
