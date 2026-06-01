export const MODULE_NAME = 'shenling_assistant';
export const CHAT_STATE_KEY = `${MODULE_NAME}_chat_state`;
export const STORAGE_VERSION = 1;
export const PLUGIN_VERSION = '0.11.62';
export const DEFAULT_SUMMARY_INCLUDE_TAGS = Object.freeze(['content']);
export const DEFAULT_SUMMARY_EXCLUDE_TAGS = Object.freeze(['thinking', 'wave']);
export const MEMORY_BLOCK_RE = /<memory>[\s\S]*?<\/memory>/gi;
export const GRAND_MEMORY_BLOCK_RE = /<grand_memory>[\s\S]*?<\/grand_memory>/i;
export const LIST_BLOCK_RE = /<list>[\s\S]*?<\/list>/gi;
export const SUMMARY_EVENT_DELAY_MS = 700;
export const SUMMARY_PROMPT_VERSION = 8;

export const MODULES = [
  { id: 'summary', icon: '🫧', shortTitle: '总结', title: '自动总结', desc: '副 API、小总结、大总结与归档管理。' },
  { id: 'profile', icon: '🎭', shortTitle: '情感', title: '情感档案', desc: '关系阶段、情感变化、角色目标与隐秘动机。' },
  { id: 'outline', icon: '🧭', shortTitle: '剧情', title: '剧情规划', desc: '故事大纲、主线阶段与当前剧情节点。' },
  { id: 'memoir', icon: '📚', shortTitle: '回忆', title: '回忆录世界书', desc: '关键节点提炼、绿灯关键词与聊天专属回忆录。' },
  { id: 'pursuit', icon: '💘', shortTitle: '攻略', title: '逆攻略', desc: '让角色在不崩人设的前提下主动推进关系。' },
  { id: 'parallel', icon: '🌈', shortTitle: '平行', title: '平行事件', desc: '基于时间轴低频续写不在场角色动态。' },
  { id: 'diary', icon: '📓', shortTitle: '日记', title: '日程日记', desc: '七日程表、普通日记与交换日记。' },
  { id: 'inspire', icon: '✨', shortTitle: '灵感', title: '灵感工具', desc: '小剧场、分支选项、冲突事件与场景推进。' },
  { id: 'replace', icon: '🈲', shortTitle: '替换', title: '词汇替换', desc: '用户词库、替换预览与当前楼层重新替换。' },
  { id: 'settings', icon: '⚙️', shortTitle: '设置', title: '设置', desc: '副 API、存储诊断与通讯日志。' },
];
