export const MODULE_NAME = 'shenling_assistant';
export const CHAT_STATE_KEY = `${MODULE_NAME}_chat_state`;
export const STORAGE_VERSION = 1;
export const PLUGIN_VERSION = '0.16.35';
export const DEFAULT_SUMMARY_INCLUDE_TAGS = Object.freeze(['content']);
export const DEFAULT_SUMMARY_EXCLUDE_TAGS = Object.freeze(['thinking', 'wave']);
export const MEMORY_BLOCK_RE = /<memory>[\s\S]*?<\/memory>/gi;
export const GRAND_MEMORY_BLOCK_RE = /<grand_memory>[\s\S]*?<\/grand_memory>/i;
export const LIST_BLOCK_RE = /<list>[\s\S]*?<\/list>/gi;
export const SUMMARY_EVENT_DELAY_MS = 700;
export const SUMMARY_PROMPT_VERSION = 10;

// 各模块 icon 现为 Lucide 图标 key（见 src/icons.js 的 SLX_ICON_PATHS），
// 不再是 emoji。渲染处用 slxIcon(module.icon) 取得内联 SVG。
export const MODULES = [
  { id: 'summary', icon: 'summary', shortTitle: '总结', title: '自动总结', desc: '副 API、小总结、大总结与归档管理。' },
  { id: 'profile', icon: 'profile', shortTitle: '情感', title: '情感档案', desc: '关系阶段、情感变化、角色目标与隐秘动机。' },
  { id: 'outline', icon: 'outline', shortTitle: '大纲', title: '剧情大纲', desc: '故事核心、章节蓝图与当前推进进度。' },
  { id: 'schedule', icon: 'schedule', shortTitle: '日程', title: '日程表', desc: '七天剧情机会、介入入口与角色动向。' },
  { id: 'memoir', icon: 'memoir', shortTitle: '回忆', title: '回忆录世界书', desc: '关键节点提炼、绿灯关键词与聊天专属回忆录。' },
  { id: 'pursuit', icon: 'pursuit', shortTitle: '攻略', title: '逆攻略', desc: '让角色在不崩人设的前提下主动推进关系。' },
  { id: 'parallel', icon: 'parallel', shortTitle: '平行', title: '平行事件', desc: '基于时间轴低频续写不在场角色动态。' },
  { id: 'diary', icon: 'diary', shortTitle: '日记', title: '日记', desc: '普通日记、交换日记与角色日记本。' },
  { id: 'theater', icon: 'theater', shortTitle: '小剧场', title: '小剧场', desc: '番外侧幕、提示词收藏与 AI 即时生成。' },
  { id: 'replace', icon: 'replace', shortTitle: '替换', title: '词汇替换', desc: '用户词库、替换预览与当前楼层重新替换。' },
  { id: 'settings', icon: 'settings', shortTitle: '设置', title: '设置', desc: '副 API、存储诊断与通讯日志。' },
];
