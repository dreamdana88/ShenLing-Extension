import { formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  AFFECTION_STAGE_RANGES,
  formatAffectionValueTenths,
  recalculateAffectionLedger,
} from './model.js';

export function getProfileCurrentValueTenths(profile) {
  if (!isPlainObject(profile)) return null;
  return recalculateAffectionLedger(
    profile.initialValueTenths,
    Array.isArray(profile.records) ? profile.records : [],
  ).valueTenths;
}

export function buildKnownAffectionText(profiles = {}) {
  const lines = Object.entries(isPlainObject(profiles) ? profiles : {})
    .filter(([, profile]) => isPlainObject(profile))
    .map(([storedRoleName, profile]) => {
      const roleName = String(profile.roleName || storedRoleName || '').trim();
      if (!roleName) return '';
      const ledger = recalculateAffectionLedger(profile.initialValueTenths, profile.records);
      const recent = ledger.records.slice(-3).map(record => {
        const source = record.sourceMessageId === null || record.sourceMessageId === undefined
          ? '手动调整'
          : `第${record.sourceMessageId}楼`;
        const deltaTenths = Number(record.deltaTenths);
        const deltaValue = Number.isInteger(deltaTenths) ? (deltaTenths / 10).toFixed(1) : '0.0';
        const delta = deltaTenths > 0 ? `+${deltaValue}` : deltaValue;
        return `${source}${delta}→${formatAffectionValueTenths(record.valueAfterTenths)}`;
      });
      return `【${roleName}】已建档，当前好感 ${formatAffectionValueTenths(ledger.valueTenths)}/100${recent.length ? `；近期：${recent.join('、')}` : '；暂无正式变化记录'}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : '暂无已建档角色。';
}

export function buildAffectionStageBehaviorText(stage) {
  const meaning = String(stage?.meaning || '').trim();
  const behaviors = (Array.isArray(stage?.behaviors) ? stage.behaviors : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return [meaning, behaviors.length ? behaviors.join('；') : '']
    .filter(Boolean)
    .join('；');
}

const GENERIC_AFFECTION_STAGE_CONTENT = Object.freeze([
  Object.freeze({
    name: '陌路星辰',
    meaning: '仍是需要保持距离与观察的陌生人。',
    behaviors: ['保持基本礼貌与必要交流', '优先观察 {{user}} 的言行与边界', '不主动透露私人情绪与重要秘密'],
    trend: '开始记住 {{user}} 的习惯，并愿意延长普通交流。',
    boundary: '不提前表现亲密依赖、暧昧占有或无条件信任。',
  }),
  Object.freeze({
    name: '微光初现',
    meaning: '把 {{user}} 视为可以继续接触的熟人与朋友。',
    behaviors: ['愿意回应日常关心与普通邀约', '在力所能及的范围提供帮助', '偶尔分享不敏感的个人想法'],
    trend: '逐渐主动寻找共同话题，并在意 {{user}} 的评价。',
    boundary: '不提前作出恋爱承诺或表现强烈排他性。',
  }),
  Object.freeze({
    name: '情愫暗生',
    meaning: '已产生明确好感，但仍在确认彼此心意。',
    behaviors: ['更主动关注 {{user}} 的情绪变化', '愿意创造单独相处与深入交流的机会', '在关键时刻给予带有个人倾向的支持'],
    trend: '试探彼此边界，并逐渐显露区别于普通朋友的在意。',
    boundary: '不把尚未确认的好感直接演成稳定伴侣关系。',
  }),
  Object.freeze({
    name: '心意相通',
    meaning: '已确认彼此具有亲密倾向，关系进入稳定磨合。',
    behaviors: ['主动表达思念、关心与亲密需求', '把 {{user}} 纳入重要计划与决定', '遇到分歧时愿意沟通并修复关系'],
    trend: '逐步建立更深的承诺、默契与共同生活感。',
    boundary: '不忽略角色自身原则，也不把亲密等同于失去独立性。',
  }),
  Object.freeze({
    name: '灵魂交融',
    meaning: '把 {{user}} 视为深度信赖并愿意长期相伴的爱人。',
    behaviors: ['自然分享最重要的脆弱、秘密与长期愿景', '在尊重彼此主体性的前提下承担共同责任', '以稳定而具体的行动维护双方关系'],
    trend: '继续深化共同经历与长期承诺，而非机械重复示爱。',
    boundary: '不因高好感取消人设、现实矛盾、个人边界或合理分歧。',
  }),
]);

function sanitizeAffectionStageText(value, maxLength) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[(?:emotion|affection|progress|memory|grand_memory)[^\]\r\n]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function createGenericAffectionStages() {
  return AFFECTION_STAGE_RANGES.map((range, index) => ({
    ...range,
    ...GENERIC_AFFECTION_STAGE_CONTENT[index],
    behaviors: [...GENERIC_AFFECTION_STAGE_CONTENT[index].behaviors],
  }));
}

export function normalizeAffectionProfileStages(value) {
  const stages = Array.isArray(value?.stages) ? value.stages : Array.isArray(value) ? value : [];
  if (stages.length !== AFFECTION_STAGE_RANGES.length) {
    throw new Error('专属阶段表必须恰好包含五个阶段。');
  }

  return AFFECTION_STAGE_RANGES.map((range, index) => {
    const source = isPlainObject(stages[index]) ? stages[index] : {};
    const name = sanitizeAffectionStageText(source.name, 24);
    const meaning = sanitizeAffectionStageText(source.meaning, 120);
    const trend = sanitizeAffectionStageText(source.trend, 120);
    const boundary = sanitizeAffectionStageText(source.boundary, 120);
    const behaviors = (Array.isArray(source.behaviors) ? source.behaviors : [])
      .map(item => sanitizeAffectionStageText(item, 100))
      .filter(Boolean);
    if (!name || !meaning || !trend || !boundary || behaviors.length !== 3) {
      throw new Error(`专属阶段表第 ${index + 1} 阶段字段不完整，且 behaviors 必须恰好三条非空文本。`);
    }
    return {
      ...range,
      name,
      meaning,
      behaviors,
      trend,
      boundary,
    };
  });
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const matched = raw.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return (matched?.[1] || raw).trim();
}

export function parseAffectionProfileResponse(value) {
  if (isPlainObject(value) && Array.isArray(value.stages)) return value;
  const raw = stripMarkdownFence(value);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('专属阶段表返回不是合法 JSON。');
  }
}

export function createProfileDraft(task, stages) {
  const now = formatTimestamp();
  return {
    roleName: task.roleName,
    initialValueTenths: task.initialValueTenths,
    valueTenths: task.initialValueTenths,
    buildMode: task.buildMode,
    buildStatus: 'ready',
    stages,
    records: [],
    sourceMessageId: task.messageId,
    sourceFingerprint: task.fingerprint,
    createdAt: now,
    updatedAt: now,
  };
}
