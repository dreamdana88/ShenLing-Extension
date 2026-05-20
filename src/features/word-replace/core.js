export const REPLACEMENT_DEFAULTS_VERSION = 11;

export const REPLACEMENT_GROUPS = Object.freeze([
  { kind: 'delete', title: '删除词', desc: '匹配后直接移除，适合口癖或赘词。', icon: 'fa-solid fa-eraser' },
  { kind: 'fixed', title: '固定替换', desc: '硬性替换，不容易破坏句子语义。', icon: 'fa-solid fa-right-left' },
  {
    kind: 'wildcard',
    title: '通配替换',
    desc: '智能替换，内置防护减少语义误伤。',
    icon: 'fa-solid fa-asterisk',
  },
]);

const ADDED_REPLACEMENT_DEFAULTS_V2 = [
  ['怨妇', '怨夫'],
  ['不容置疑的', '', 'delete'],
];
const ADDED_REPLACEMENT_DEFAULTS_V3 = [
  ['傻逼', '臭傻屌'],
  ['臭逼', '臭傻屌'],
  ['妈逼', '臭傻屌'],
];
const ADDED_REPLACEMENT_DEFAULTS_V4 = [['臭傻逼', '臭傻屌']];
const ADDED_REPLACEMENT_DEFAULTS_V5 = [['操', '劁', 'wildcard', 'independent']];
const ADDED_REPLACEMENT_DEFAULTS_V6 = [
  ['妈', '爹', 'wildcard', 'family_swear'],
  ['娘', '爹', 'wildcard', 'family_swear'],
];
const ADDED_REPLACEMENT_DEFAULTS_V7 = [
  ['妨碍', '㤃碍'],
  ['父老乡亲', '妇姥乡亲'],
  ['倒霉', '倒楣'],
  ['嫁娶', '傢取'],
  ['结婚', '结阍'],
  ['婚姻', '阍因'],
  ['夫妻', '妻夫'],
  ['财神爷', '财神姥'],
  ['祖师爷', '祖师奶'],
  ['长子', '长男'],
  ['太女', '太子'],
  ['公道话', '公平话'],
  ['处女作', '出道作'],
  ['金主爸爸', '金主妈妈'],
];
const ADDED_REPLACEMENT_DEFAULTS_V8 = [['妹', '爹', 'wildcard', 'family_swear']];
const ADDED_REPLACEMENT_DEFAULTS_V9 = [
  ['我靠', '我骟', 'wildcard', 'independent'],
  ['我去', '我骟', 'wildcard', 'independent'],
];
const ADDED_REPLACEMENT_DEFAULTS_V10 = [['甲方爸爸', '甲方妈妈']];

const DEFAULT_REPLACEMENT_RULE_ITEMS = [
  ['极其', '', 'delete'],
  ['操你*', '劁你爹', 'wildcard'],
  ['丫头', '女孩'],
  ['婆婆妈妈', '磨磨唧唧'],
  ['娘们唧唧', '磨磨唧唧'],
  ['老妈子', '碎嘴爹'],
  ['这女人', '这人'],
  ['男妈妈', '温柔爹地'],
  ['女爸爸', '霸气妈咪'],
  ['女汉子', '有力量的女性'],
  ['女强人', '强大的女性'],
  ['我操', '我劁'],
  ['我草', '我劁'],
  ['卧槽', '我劁'],
  ['婊子', '烂屌货'],
  ['荡妇', '荡夫'],
  ['学姐', '学长'],
  ['女老板', '老板'],
  ['老板娘', '老板'],
  ['父母', '母父'],
  ['妒忌', '忮忌'],
  ['嫉妒', '厌羡'],
  ['师父', '师傅'],
  ['师母', '师尊'],
  ['徒弟', '徒儿'],
  ['英雄', '英杰'],
  ['奴隶', '虜隶'],
  ['奴才', '虜才'],
  ['奴婢', '虜俾'],
  ['外婆', '姥姥'],
  ['外公', '姥爷'],
  ['老天爷', '老天奶'],
  ['甲方爸爸', '甲方妈妈'],
  ['大姨妈', '月经'],
  ['男小三', '第三者'],
  ['小三', '第三者'],
  ['防闺蜜', '防老公'],
  ['红颜祸水', '蓝颜祸水'],
  ['水性杨花', '轻浮'],
  ['雌小鬼', '雄小鬼'],
  ['事妈', '事精'],
  ['妇人之仁', '宋襄之仁'],
  ['贤妻良母', '贤夫良婿'],
  ['嫌弃', '慊弃'],
  ['娼妓', '性工作者'],
  ['娼妇', '性工作者'],
  ['妓女', '性工作者'],
  ['嫖娼', '闝倡'],
  ['白嫖', '白剽'],
  ['化妆', '化粧'],
  ['守妇道', '守夫格'],
  ['娘炮', '鸭里鸭气'],
  ['八婆', '八公'],
  ...ADDED_REPLACEMENT_DEFAULTS_V2,
  ...ADDED_REPLACEMENT_DEFAULTS_V3,
  ...ADDED_REPLACEMENT_DEFAULTS_V4,
  ...ADDED_REPLACEMENT_DEFAULTS_V5,
  ...ADDED_REPLACEMENT_DEFAULTS_V6,
  ...ADDED_REPLACEMENT_DEFAULTS_V7,
  ...ADDED_REPLACEMENT_DEFAULTS_V8,
  ...ADDED_REPLACEMENT_DEFAULTS_V9,
  ...ADDED_REPLACEMENT_DEFAULTS_V10,
];

export function createReplacementRule(source, target, index, kind = target ? 'fixed' : 'delete', mode = kind === 'wildcard' ? 'wildcard' : 'plain') {
  return {
    id: `default-replacement-${index}`,
    enabled: true,
    kind,
    source,
    target,
    mode,
    scope: 'all',
  };
}

export const DEFAULT_REPLACEMENT_RULES = Object.freeze(
  DEFAULT_REPLACEMENT_RULE_ITEMS.map(([source, target, kind, mode], index) => {
    const ruleKind = kind || (target ? 'fixed' : 'delete');
    return createReplacementRule(source, target, index, ruleKind, mode);
  }),
);

export function getDefaultWordReplaceSettings() {
  return {
    enabled: false,
    defaultsVersion: REPLACEMENT_DEFAULTS_VERSION,
    importCollapsed: true,
    expandedGroups: {
      delete: false,
      fixed: true,
      wildcard: false,
    },
    rules: JSON.parse(JSON.stringify(DEFAULT_REPLACEMENT_RULES)),
  };
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeReplacementRules(rules, storedDefaultsVersion = 0) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return getDefaultWordReplaceSettings().rules;
  }

  const normalizedRules = rules
    .map((rule, index) => ({
      id: typeof rule.id === 'string' ? rule.id : `replacement-${Date.now()}-${index}`,
      enabled: rule.enabled !== false,
      kind: ['delete', 'fixed', 'wildcard'].includes(rule.kind)
        ? rule.kind
        : rule.target
          ? rule.mode === 'regex' ? 'wildcard' : 'fixed'
          : 'delete',
      source: typeof rule.source === 'string' ? rule.source : '',
      target: typeof rule.target === 'string' ? rule.target : '',
      mode: ['plain', 'exact', 'wildcard', 'regex', 'independent', 'family_swear'].includes(rule.mode)
        ? rule.mode
        : 'plain',
      scope: 'all',
    }))
    .filter(rule => rule.source.trim());

  if (storedDefaultsVersion >= REPLACEMENT_DEFAULTS_VERSION) {
    return normalizedRules;
  }

  const addedDefaults = storedDefaultsVersion < 11 ? ADDED_REPLACEMENT_DEFAULTS_V10 : [];
  const hasEquivalentRule = (source, target, kind, mode) => normalizedRules.some(rule => (
    rule.source === source &&
    rule.target === target &&
    rule.kind === kind &&
    (!mode || rule.mode === mode)
  ));
  const migratedRules = addedDefaults.flatMap(([source, target, kind, mode], index) => {
    const ruleKind = kind || (target ? 'fixed' : 'delete');
    if (hasEquivalentRule(source, target, ruleKind, mode)) return [];
    return [{
      ...createReplacementRule(source, target, DEFAULT_REPLACEMENT_RULES.length + index, ruleKind, mode),
      id: `default-replacement-v${REPLACEMENT_DEFAULTS_VERSION}-${index}`,
    }];
  });

  return [...normalizedRules, ...migratedRules];
}

export function splitReplacementSources(source) {
  return String(source || '')
    .split(/[，,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function parseReplacementImportLine(line, kind) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return [];

  if (kind === 'delete') {
    const sourcePart = trimmed.replace(/(?:->|→|-).*$/, '');
    return splitReplacementSources(sourcePart).map(source => ({
      kind,
      source,
      target: '',
      mode: 'plain',
      scope: 'all',
    }));
  }

  const delimiter = trimmed.match(/->|→|-/);
  if (!delimiter || delimiter.index === undefined) return [];

  const sourcePart = trimmed.slice(0, delimiter.index);
  const target = trimmed.slice(delimiter.index + delimiter[0].length).trim();
  return splitReplacementSources(sourcePart).map(source => ({
    kind,
    source,
    target,
    mode: kind === 'wildcard' ? 'wildcard' : 'plain',
    scope: 'all',
  }));
}

export function createReplacementRuleId() {
  return `replacement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createImportedReplacementRules(text, kind) {
  const imported = String(text || '').split(/\r?\n/).flatMap(line => parseReplacementImportLine(line, kind));
  const now = Date.now();
  return imported.map((rule, index) => ({
    ...rule,
    id: `replacement-${now}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    enabled: true,
  }));
}

export function buildReplacementRuleGroups(rules) {
  const groups = new Map();
  for (const rule of rules) {
    const key = [rule.kind, rule.target, rule.mode, rule.scope].join('\u0001');
    const group = groups.get(key);
    if (group) {
      group.ids.push(rule.id);
      group.sources.push(rule.source);
      group.enabled = group.enabled && rule.enabled;
      group.source = group.sources.join('，');
      continue;
    }
    groups.set(key, {
      id: key,
      ids: [rule.id],
      enabled: rule.enabled,
      kind: rule.kind,
      sources: [rule.source],
      source: rule.source,
      target: rule.target,
      mode: rule.mode,
      scope: rule.scope,
    });
  }
  return Array.from(groups.values());
}

export function replacementRuleMatchesSearch(rule, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [rule.source, rule.target, rule.kind, rule.mode]
    .filter(Boolean)
    .some(value => String(value).toLocaleLowerCase().includes(normalizedQuery));
}

function escapeRegExp(content) {
  return String(content || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWildcardReplacement(source, target) {
  const parts = source.split('*').map(escapeRegExp);
  const captureCount = parts.length - 1;
  const safeCapture = '([^\\s\\u3001\\uff0c\\u3002\\uff01\\uff1f\\uff1b\\uff1a,.!?;:]{0,6})';
  const pattern = parts.join(safeCapture);
  let index = 0;
  const replacement = String(target || '').replace(/\*/g, () => {
    index += 1;
    return index <= captureCount ? `$${index}` : '*';
  });
  return { pattern, replacement };
}

function createIndependentReplacement(source, target) {
  return {
    pattern: `(?<![\\u4e00-\\u9fffA-Za-z0-9])${escapeRegExp(source)}(?![\\u4e00-\\u9fffA-Za-z0-9])`,
    replacement: target,
  };
}

function createFamilySwearReplacement(source, target) {
  return {
    pattern: `${escapeRegExp(source)}的`,
    replacement: `${target}的`,
  };
}

function replaceWithCount(text, regexp, replacer, shouldSkip) {
  let replacements = 0;
  const nextText = text.replace(regexp, (...args) => {
    const matched = String(args[0]);
    const offset = Number(args.at(-2));
    if (shouldSkip?.(matched, offset)) return matched;
    replacements += 1;
    return replacer(...args);
  });
  return { text: nextText, replacements };
}

const FAMILY_WORD_RE = /[\u5988\u5a18]/u;
const FAMILY_PROTECTED_AFTER_RE =
  /^(?:\u4e1c\u897f|\u5bb6|\u623f|\u8f66|\u94b1|\u5305|\u4e8b|\u670b\u53cb|\u540c\u5b66|\u8001\u5e08|\u624b\u673a|\u8863\u670d|\u978b|\u4e66|\u7b14|\u996d|\u83dc|\u7167\u7247|\u5de5\u4f5c|\u5355\u4f4d|\u516c\u53f8|\u75c5|\u751f\u65e5|\u540d\u5b57|\u9879\u94fe|\u6212\u6307|\u773c\u955c|\u94a5\u5319|\u7535\u8111|\u732b|\u72d7|\u624b\u827a)/u;
const FAMILY_KIN_AFTER_RE = /^[\u5988\u54aa\u4eb2\u7956\u8205\u5bb6\u90a3\u8fd9]/u;
const FAMILY_ACTION_BEFORE_RE =
  /[\u662f\u60f3\u770b\u542c\u627e\u56de\u50cf\u63a5\u9001\u966a\u5e2e\u7231\u75bc\u6068\u6253\u95ee\u6c42\u53eb\u8ba4\u7ed9\u8ddf\u540c\u5e26\u6478\u62b1\u4eb2\u5938\u9a82\u78b0\u62ff\u4e70\u5077\u62a2]/u;
const FAMILY_PRONOUN_RE = /^(?:[\u4f60\u6211\u4ed6\u5979\u5b83\u7279\u795e]|[tT][aA])/u;
const BI_PROTECTED_AFTER_RE = /^[\u8fd1\u8feb\u771f\u95ee\u4f9b\u503a\u4ec4\u89c6\u89c9]/u;

function applyFamilySwearRule(text, rule) {
  const source = rule.source.trim();
  if (!source) return { text, replacements: 0 };

  const sourcePattern = escapeRegExp(source);
  const target = rule.target;
  const kinGuard = `(?!\\s*(?:${sourcePattern}|妈|咪|亲|祖|舅|家|那|这))`;
  const skipProtectedNoun = (matched, offset) => FAMILY_PROTECTED_AFTER_RE.test(text.slice(offset + matched.length));
  let nextText = text;
  let replacements = 0;

  const apply = (regexp, replacer, shouldSkip) => {
    const result = replaceWithCount(nextText, regexp, replacer, shouldSkip);
    nextText = result.text;
    replacements += result.replacements;
  };

  apply(
    new RegExp(
      `(?<![是想看听找回像接送陪帮爱疼恨打问求叫认给跟同带摸抱亲夸骂碰拿买偷抢去])(你|他|她|它|牠|祂|[tT][aA])${sourcePattern}的`,
      'gu',
    ),
    (...args) => `${String(args[1])}${target}的`,
    skipProtectedNoun,
  );
  apply(
    new RegExp(`(你|我|他|她|它|你们|我们|他们|她们|它们)(他|她|它|牠|祂|你|我|[tT][aA])${sourcePattern}(的)?${kinGuard}`, 'gu'),
    (...args) => `${String(args[1])}${String(args[2])}${target}${String(args[3] ?? '')}`,
  );
  apply(
    new RegExp(`(真|太|最|简直|特么|还|又|竟|竟然|老子)(他|她|它|牠|祂|你|我|[tT][aA])?${sourcePattern}(的)?${kinGuard}`, 'gu'),
    (...args) => `${String(args[1])}${String(args[2] ?? '')}${target}${String(args[3] ?? '')}`,
  );
  apply(new RegExp(`(这|那|都|就|全)(他|她|它|牠|祂|你|我|[tT][aA])${sourcePattern}(的)?${kinGuard}`, 'gu'), (...args) => (
    `${String(args[1])}${String(args[2])}${target}${String(args[3] ?? '')}`
  ));
  apply(new RegExp(`(?<![\\u4e00-\\u9fa5])${sourcePattern}的(?![\\u4e00-\\u9fa5])`, 'gu'), () => `${target}的`);

  return { text: nextText, replacements };
}

function shouldSkipProtectedReplacement(rule, fullText, matched, offset) {
  const after = fullText.slice(offset + matched.length);

  if (rule.mode === 'family_swear') {
    const before = fullText.slice(Math.max(0, offset - 3), offset);
    if (before.endsWith(rule.source)) return true;
    if (FAMILY_PROTECTED_AFTER_RE.test(after)) return true;
    if (!matched.includes('的') && (FAMILY_KIN_AFTER_RE.test(after) || after.startsWith(rule.source))) return true;
  }

  if (FAMILY_WORD_RE.test(matched)) {
    const before = fullText.slice(Math.max(0, offset - 3), offset);
    const previousChar = before.at(-1) ?? '';
    const actionBeforePronoun = FAMILY_PRONOUN_RE.test(matched)
      ? FAMILY_ACTION_BEFORE_RE.test(previousChar)
      : /[你我他她它牠祂]$/u.test(before) && FAMILY_ACTION_BEFORE_RE.test(before.at(-2) ?? '');

    if (/[妈娘]$/u.test(before)) return true;
    if (FAMILY_PROTECTED_AFTER_RE.test(after)) return true;
    if (!matched.includes('的') && FAMILY_KIN_AFTER_RE.test(after)) return true;
    if (actionBeforePronoun && FAMILY_PROTECTED_AFTER_RE.test(after)) return true;
  }

  if (matched.includes('逼') && matched.length <= 1 && BI_PROTECTED_AFTER_RE.test(after)) {
    return true;
  }

  return false;
}

function createReplacementRegExp(rule) {
  if (rule.mode === 'wildcard') {
    return new RegExp(createWildcardReplacement(rule.source.trim(), rule.target).pattern, 'gu');
  }
  if (rule.mode === 'independent') {
    return new RegExp(createIndependentReplacement(rule.source.trim(), rule.target).pattern, 'gu');
  }
  if (rule.mode === 'family_swear') {
    return new RegExp(createFamilySwearReplacement(rule.source.trim(), rule.target).pattern, 'gu');
  }
  if (rule.mode === 'regex') {
    const source = rule.source.trim();
    const slashMatch = source.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    const pattern = slashMatch ? slashMatch[1] : source;
    const rawFlags = slashMatch ? slashMatch[2] : 'u';
    const flags = Array.from(new Set(`${rawFlags}gu`.split(''))).join('');
    return new RegExp(pattern, flags);
  }
  return new RegExp(escapeRegExp(rule.source), 'gu');
}

export function applyReplacementRulesToSegment(text, rules) {
  let nextText = String(text || '');
  let replacements = 0;
  const errors = [];
  const sortedRules = [...rules].sort((a, b) => {
    const priority = { wildcard: 0, delete: 1, fixed: 2 };
    const kindDelta = priority[a.kind] - priority[b.kind];
    if (kindDelta !== 0) return kindDelta;
    return b.source.length - a.source.length;
  });

  for (const rule of sortedRules) {
    if (!rule.enabled || !rule.source.trim()) continue;
    try {
      if (rule.mode === 'family_swear') {
        const result = applyFamilySwearRule(nextText, rule);
        if (result.replacements > 0) {
          nextText = result.text;
          replacements += result.replacements;
        }
        continue;
      }

      const regexp = createReplacementRegExp(rule);
      if (!regexp.test(nextText)) continue;
      regexp.lastIndex = 0;
      const replacement = rule.mode === 'wildcard'
        ? createWildcardReplacement(rule.source.trim(), rule.target).replacement
        : rule.kind === 'delete'
          ? ''
          : rule.target;

      nextText = nextText.replace(regexp, (...args) => {
        const matched = String(args[0]);
        const offset = Number(args.at(-2));
        if (shouldSkipProtectedReplacement(rule, nextText, matched, offset)) return matched;
        replacements += 1;
        return matched.replace(regexp, replacement);
      });
    } catch (error) {
      errors.push(`${rule.source}: ${getErrorMessage(error)}`);
    }
  }

  return {
    text: nextText,
    changed: nextText !== String(text || ''),
    replacements,
    errors,
  };
}

export function applyReplacementRulesByScope(content, settings, { force = false } = {}) {
  const rules = normalizeReplacementRules(settings?.rules, settings?.defaultsVersion).filter(rule => rule.enabled);
  if ((!force && !settings?.enabled) || rules.length === 0) {
    return { text: String(content || ''), changed: false, replacements: 0, errors: [] };
  }
  return applyReplacementRulesToSegment(String(content || ''), rules);
}
