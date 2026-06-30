/**
 * 蜃灵助手图标系统
 *
 * 全部图标来自 Lucide（ISC 协议，可商用），统一 viewBox 0 0 24 24、
 * stroke-width 1.5、stroke:currentColor、fill:none。
 * 颜色由 CSS `.slx-ico` + 容器 color 控制，自动跟随深浅主题，无需在此配色。
 *
 * 用法：
 *   import { slxIcon } from './src/icons.js';
 *   slxIcon('summary')                 // -> '<svg class="slx-ico" ...>...</svg>'
 *   slxIcon('settings', 'slx-ico-lg')  // 追加额外类名
 *
 * 新增图标：从 https://lucide.dev 复制对应 path，去掉外层 <svg>，
 * 只保留内部路径塞进 SLX_ICON_PATHS 即可。
 */

export const SLX_ICON_PATHS = Object.freeze({
  // —— 功能模块 ——
  // scroll-text : 自动总结
  summary:
    '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  // heart-pulse : 情感档案
  profile:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h4.78"/>',
  // route : 剧情大纲
  outline:
    '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  // book-open : 回忆录世界书
  memoir:
    '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  // target : 逆攻略（与情感 heart-pulse 拉开区分）
  pursuit:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  // shuffle : 平行事件
  parallel:
    '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  // notebook : 日程日记
  diary:
    '<path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M16 2v20"/>',
  // drama : 小剧场
  theater:
    '<path d="M10 11h.01"/><path d="M14 6h.01"/><path d="M18 6h.01"/><path d="M6.5 13.1h.01"/><path d="M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3"/><path d="M17.4 9.9c-.8.8-2 .8-2.8 0"/><path d="M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7"/><path d="M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4"/>',
  // arrow-right-left : 词汇替换
  replace:
    '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  // settings : 设置
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',

  // —— 品牌 / 头部 / 系统控件 ——
  // brand : 浮窗品牌标（幻境光体）
  brand:
    '<path d="M12 3a6 6 0 0 0 5.5 6A6 6 0 0 0 12 15a6 6 0 0 0-5.5-6A6 6 0 0 0 12 3Z"/><circle cx="18.5" cy="17.5" r="2"/>',
  // radio : 通讯日志
  log:
    '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  // sun : 浅色主题（点击切到暗色）
  sun:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  // moon : 暗色主题（点击切到浅色）
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  // x : 关闭
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
});

/**
 * 生成图标 SVG 字符串。
 * @param {string} name - SLX_ICON_PATHS 中的 key
 * @param {string} [extraClass] - 追加到 class 的额外类名
 * @returns {string} 内联 SVG 字符串；name 不存在时返回空字符串
 */
export function slxIcon(name, extraClass = '') {
  const path = SLX_ICON_PATHS[name];
  if (!path) {
    return '';
  }
  const cls = extraClass ? `slx-ico ${extraClass}` : 'slx-ico';
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
}
