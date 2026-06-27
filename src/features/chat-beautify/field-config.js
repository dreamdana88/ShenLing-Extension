export const MEMORY_FIELD_CONFIG = Object.freeze({
  number: { icon: 'hash', label: '编号', mode: 'single', slot: 'title', order: 0 },
  time: { icon: 'clock', label: '时间', mode: 'single', slot: 'title', order: 1 },
  task: { icon: 'target', label: '主线', mode: 'single', slot: 'title', order: 2 },
  location: { icon: 'map-pin', label: '地点', mode: 'single', slot: 'body', order: 10 },
  characters: { icon: 'users', label: '在场', mode: 'single', slot: 'body', order: 11 },
  plot: { icon: 'book-open', label: '剧情', mode: 'block', slot: 'body', order: 12 },
  quote: { icon: 'message-circle', label: '台词', mode: 'multi', slot: 'body', pipe: 2, order: 13 },
  db: { icon: 'archive', label: '档案', mode: 'multi', slot: 'body', pipe: 2, order: 14 },
  emotion: { icon: 'heart', label: '情感', mode: 'multi', slot: 'body', pipe: 4, order: 15 },
  affection: { icon: 'trending-up', label: '好感', mode: 'multi', slot: 'body', pipe: 3, order: 16, enabled: false },
  progress: { icon: 'route', label: '进度', mode: 'multi', slot: 'body', pipe: 3, order: 17 },
});

export const MEMORY_CONTROL_FIELDS = Object.freeze(new Set([
  'emotion_changed',
  'affection_changed',
]));
