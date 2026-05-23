import {
  getChatBeautifySettings,
  getGlobalSettings,
} from '../../core/settings.js';

let rendererRegistered = false;

export function registerChatBeautifyRenderer() {
  if (rendererRegistered) return;
  rendererRegistered = true;

  // 占位：后续在这里接入聊天楼层 <memory>/<grand_memory> 的非破坏性渲染。
  // 当前版本不改 DOM、不隐藏原文、不影响任何聊天内容。
  getChatBeautifySettings(getGlobalSettings());
}

export function refreshChatBeautifyRenderer() {
  // 占位：未来用于在消息更新、swipe、主题切换后重新渲染美化卡片。
}

export function clearChatBeautifyRenderer() {
  // 占位：未来用于卸载美化 DOM 包装，还原聊天楼层显示。
}
