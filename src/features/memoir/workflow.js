// 鍥炲繂褰曚笘鐣屼功涓氬姟娴佺▼銆?// 闃舵 3a锛氱‘淇濆綋鍓嶈亰澶╂湁缁忚繃鐢ㄦ埛纭鐨勫彲鍐欏叆涓栫晫涔︺€?//   - 褰撳墠鑱婂ぉ鏃犵粦瀹?-> 鏂板缓銆岃渻鐏靛洖蹇嗗綍锝?鑱婂ぉ鏍囪瘑>銆嶅苟缁戝畾銆?//   - 宸茬粦瀹氫笖鏈亰澶╃‘璁よ繃 -> 鐩存帴澶嶇敤銆?//   - 宸茬粦瀹氫絾鏈‘璁?缁戝畾宸插彉鍖?-> 鐢?UI 璇㈤棶锛氬鐢ㄥ綋鍓嶄功锛屾垨鍒涘缓铚冪伒涓撳睘涔﹀苟鍒囨崲缁戝畾銆?
import {
  GRAND_MEMORY_BLOCK_RE,
  getLongFormGenerationTimeoutMessage,
  LIST_BLOCK_RE,
  LONG_FORM_GENERATION_TIMEOUT_MS,
  MEMORY_BLOCK_RE,
} from '../../constants.js';
import { getChatMessagesSafe, getContextSafe } from '../../core/chat.js';
import {
  buildGenerationTransportLog,
  generateWithMainApi,
  generateWithSecondaryApi,
  getGenerationErrorContext,
  notifyBackgroundStreamingFallbackOnce,
  resolveConfiguredGenerationTransport,
} from '../../core/generation.js';
import {
  resolvePromptMessages,
  resolvePromptText,
} from '../../core/prompt-overrides.js';
import { extractSummarySourceContent, formatTimestamp, isPlainObject } from '../../utils/text.js';
import {
  CAPTURE_SOURCE_MODES,
  appendCaptureDrafts,
  getBackgroundStreamingEnabled,
  getChatState,
  getGlobalSettings,
  getMemoirState,
  getMemoirSettings,
  getSummarySettings,
  normalizeCaptureDraft,
  normalizeCaptureState,
  saveChatState,
} from '../../core/settings.js';
export {
  CAPTURE_POSITIONS,
  CAPTURE_SOURCE_MODES,
  CAPTURE_TYPES,
  clearCaptureDrafts,
  removeCaptureDrafts,
} from '../../core/settings.js';
import {
  collectEmotionProfiles,
  formatCharacterCardForPrompt,
  formatUserPersonaForPrompt,
  getResolvedCharacterCard,
  getUserPersona,
} from '../../core/context-resolver.js';
import {
  buildCapturePromptMessages,
  buildMemoirExtractPrompt,
  PROMPT_IDS,
} from '../../prompts.js';
import { getWorldbookApi, getWorldbookReadApi } from '../../core/worldbook.js';
import {
  buildMemoirBlueContent,
  ensureMemoirWorldbook,
  isDedicatedMemoirBook,
  reconcileMemoirWorldbookState,
  updateWorldbookWithVerification,
  verifyWorldbookEntries,
} from './worldbook-manager.js';

export { ensureMemoirWorldbook, isDedicatedMemoirBook } from './worldbook-manager.js';

// 鈹€鈹€ 闃舵 3b锛氬ぇ鎬荤粨鍚庢彁鐐煎洖蹇嗗€欓€夛紙鍙В鏋愶紝涓嶅啓鍏ヤ笘鐣屼功锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** 鐢ㄥぇ鎬荤粨鐨?messageId + 鍖洪棿浣滀负骞傜瓑閿紝閬垮厤鍚屼竴娆″綊妗ｉ噸澶嶆彁鐐笺€?*/
function buildSourceKey(archiveRecord = {}) {
  const id = archiveRecord.summaryMessageId ?? archiveRecord.id ?? '';
  const from = archiveRecord.memoryFrom ?? archiveRecord.archiveFrom ?? '';
  const to = archiveRecord.memoryTo ?? archiveRecord.archiveTo ?? '';
  return `grand:${id}:${from}-${to}`;
}

/** 鎶婃儏鎰熸。妗堝帇鎴愭彁鐐肩礌鏉愬彲璇荤殑鐭枃鏈€?*/
function buildEmotionMaterial() {
  const profiles = collectEmotionProfiles({ includeAll: true });
  if (!profiles.length) return '';
  return profiles
    .map(p => {
      const parts = [
        p.currentStatus ? `鐘舵€侊細${p.currentStatus}` : '',
        p.relationshipToUser ? `涓巤{user}}鍏崇郴锛?{p.relationshipToUser}` : '',
      ].filter(Boolean).join('锛?);
      return `- ${p.roleName}锝?{parts}`;
    })
    .join('\n');
}

/** 鎶婂凡璁板綍鏉＄洰鍘嬫垚銆屼簨浠?/ 浜?/ 鍏抽敭閿氱偣銆嶇畝琛紝渚?AI 鍘婚噸鍙傝€冦€?*/
function buildRecordedList(memoir) {
  const entries = Array.isArray(memoir.entries) ? memoir.entries : [];
  if (!entries.length) return '';
  return entries
    .map(e => {
      const people = Array.isArray(e.mainKeywords) ? e.mainKeywords.slice(0, 2).join('/') : '';
      const anchor = Array.isArray(e.filterKeywords) ? e.filterKeywords.slice(0, 2).join('/') : '';
      return `- ${e.title || '鏈懡鍚?}${people ? ` / ${people}` : ''}${anchor ? ` / ${anchor}` : ''}`;
    })
    .join('\n');
}

/** 瀹芥澗瑙ｆ瀽妯″瀷杈撳嚭锛氬蹇?```json 浠ｇ爜鍧楀寘瑁规垨鍓嶅悗鏉傝銆?*/
function parseMemoirJson(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('妯″瀷鏃犺緭鍑恒€?);
  let jsonText = text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    jsonText = fence[1].trim();
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = text.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`鍥炲繂褰?JSON 瑙ｆ瀽澶辫触锛?{error.message}`);
  }
  const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const overview = Array.isArray(parsed?.overview) ? parsed.overview : [];
  return { overview, memories };
}

/**
 * 澶ф€荤粨瀹屾垚鍚庡皾璇曟彁鐐煎洖蹇嗗€欓€夈€? * 鍙礋璐ｃ€岄棬鎺?鈫?骞傜瓑 鈫?鏀堕泦绱犳潗 鈫?璋?API 鈫?瑙ｆ瀽銆嶏紝涓嶅啓涓栫晫涔︺€佷笉鏀?sourceProcessed銆? * 鍐欏叆涓庡箓绛夋爣璁扮暀寰呴樁娈靛洓/浜斻€? *
 * @param {object} archiveRecord 鏉ヨ嚜 processAutoGrandMemory 鐨勫綊妗ｈ褰? * @param {object} deps
 *   - generate: (prompt, opts) => Promise<string>  澶嶇敤澶ф€荤粨閾捐矾锛堣窡闅忚缃噷閫夌殑涓?鍓?API锛? *   - grandMemoryText: string 鏈澶ф€荤粨姝ｆ枃
 *   - force: boolean 璇婃柇璇曡窇鐢紱璺宠繃 enabled 闂ㄦ帶涓?sourceProcessed 骞傜瓑锛屽己鍒惰蛋涓€娆＄敓鎴? * @returns {Promise<{ skipped?: string, sourceKey?: string, prompt?: string, raw?: string,
 *   overview: any[], memories: any[] }>}
 */
export async function tryExtractMemoirFromGrandSummary(archiveRecord, { generate, grandMemoryText, force = false } = {}) {
  const memoirSettings = getMemoirSettings();
  if (!force && !memoirSettings.enabled) {
    return { skipped: 'disabled', overview: [], memories: [] };
  }
  if (typeof generate !== 'function') {
    throw new Error('鏈彁渚涚敓鎴愬嚱鏁帮紝鏃犳硶鎻愮偧鍥炲繂鍊欓€夈€?);
  }

  // 鎻愮偧鍓嶅厛妫€鏌ョ湡瀹炰笘鐣屼功锛涙暣鏈功宸插垹闄ゆ椂娓呮帀鏃х储寮?鏉ユ簮锛岄伩鍏嶆棫璁板綍缁х画褰卞搷鍘婚噸绱犳潗銆?  try {
    await reconcileMemoirWorldbookState();
  } catch (error) {
    console.warn('[铚冪伒鍔╂墜] 鎻愮偧鍓嶅悓姝ュ洖蹇嗗綍涓栫晫涔﹀け璐ワ紝灏嗕繚鐣欑幇鏈夋湰鍦扮姸鎬併€?, error);
  }
  const memoir = getMemoirState();
  const sourceKey = buildSourceKey(archiveRecord);
  if (!force && memoir.sourceProcessed.includes(sourceKey)) {
    return { skipped: 'already_processed', sourceKey, overview: [], memories: [] };
  }
  const pendingSourceKeys = Array.isArray(memoir.pending?.sourceKeys)
    ? memoir.pending.sourceKeys
    : [memoir.pending?.sourceKey].filter(Boolean);
  if (!force && pendingSourceKeys.includes(sourceKey)) {
    return { skipped: 'already_pending', sourceKey, overview: [], memories: [] };
  }

  const grandMemoryMaterial = String(grandMemoryText || '').trim();
  if (!grandMemoryMaterial) {
    return { skipped: 'no_material', sourceKey, overview: [], memories: [] };
  }

  const settings = getGlobalSettings();
  const prompt = buildMemoirExtractPrompt({
    grandMemoryMaterial,
    emotionMaterial: buildEmotionMaterial(),
    recordedList: buildRecordedList(memoir),
    template: resolvePromptText(PROMPT_IDS.MEMOIR_EXTRACT, settings),
  });

  const raw = await generate(prompt, { type: '鍥炲繂褰曟彁鐐?, apiMode: memoirSettings.apiMode });
  const { overview, memories } = parseMemoirJson(raw);

  return { sourceKey, prompt, raw, overview, memories };
}

// 鈹€鈹€ 闃舵鍥涳細鍊欓€夋殏瀛樺埌 pending锛屼氦鐢ㄦ埛纭 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function createCandidateId(index) {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `cand-${globalThis.crypto.randomUUID()}`;
    }
  } catch {}
  return `cand-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${index}`;
}

/** 瑙勮寖鍖栧崟鏉＄豢鐏€欓€夛紝瀹归敊缂哄瓧娈点€傚垱寤哄悗鍗虫寔涔呭寲绋冲畾 candidateId锛屼緵闈㈡澘鍜屽け璐ラ噸璇曞鐢ㄣ€?*/
function normalizeCandidate(mem, index) {
  const asArray = v => (Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []);
  const importance = ['high', 'medium', 'low'].includes(mem?.importance) ? mem.importance : 'medium';
  return {
    candidateId: createCandidateId(index),
    title: String(mem?.title || '').trim() || '鏈懡鍚嶅洖蹇?,
    storyTime: String(mem?.storyTime || '').trim() || '鏈槑',
    importance,
    participants: asArray(mem?.participants),
    mainKeywords: asArray(mem?.mainKeywords),
    filterKeywords: asArray(mem?.filterKeywords),
    content: String(mem?.content || '').trim(),
  };
}

/** 鎶婃彁鐐肩粨鏋滆鑼冨寲鍚庢殏瀛樺埌 chatState.memoir.pending锛岀瓑寰呯敤鎴风‘璁ゃ€?*/
export function stageMemoirCandidates({ sourceKey, overview, memories } = {}) {
  const memoir = getMemoirState();
  const candidates = (Array.isArray(memories) ? memories : [])
    .map((m, i) => normalizeCandidate(m, i))
    .filter(c => c.content); // 鏃犳鏂囩殑涓㈠純

  // digest 浠?overview 閲屾寜 title 瀵归綈琛ヨ繘鍊欓€夛紝渚涢潰鏉?钃濈伅浣跨敤
  const overviewList = Array.isArray(overview) ? overview : [];
  const digestByTitle = new Map(
    overviewList
      .filter(o => o && o.title)
      .map(o => [String(o.title).trim(), String(o.digest || '').trim()]),
  );
  candidates.forEach(c => {
    c.digest = digestByTitle.get(c.title) || '';
  });

  const previous = memoir.pending && Array.isArray(memoir.pending.candidates)
    ? memoir.pending
    : null;
  const previousSourceKeys = Array.isArray(previous?.sourceKeys)
    ? previous.sourceKeys
    : [previous?.sourceKey].filter(Boolean);
  const sourceKeys = [...new Set([...previousSourceKeys, sourceKey].filter(Boolean))];

  memoir.pending = {
    sourceKey: sourceKeys[0] || '', // 鍏煎鏃х姸鎬佽鍙栵紱鏂颁唬鐮佷互 sourceKeys 涓哄噯
    sourceKeys,
    candidates: [...(previous?.candidates || []), ...candidates],
    generatedAt: formatTimestamp(),
  };
  saveChatState();
  return memoir.pending;
}

/** 涓㈠純褰撳墠 pending 鍊欓€夛紙鐢ㄦ埛鐐光€滃叏閮ㄥ拷鐣モ€濓級銆?*/
export function discardMemoirPending() {
  const memoir = getMemoirState();
  memoir.pending = null;
  saveChatState();
}

// 鈹€鈹€ 闃舵浜旓細鎶婄‘璁ゅ悗鐨勫€欓€夊啓鍏ヤ笘鐣屼功 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const MEMOIR_GREEN_NAME_PREFIX = 'SLX-Memoir-Green-';
const MEMOIR_BLUE_NAME = 'SLX-Memoir-Blue-鍥炲繂褰曟€昏';

/** 缁跨伅鏉＄洰姝ｆ枃锛氭椂闂村墠缃紝AI 鍙锛屼笉鍚潵婧愪俊鎭€?*/
function buildGreenContent(entry) {
  const time = entry.storyTime && entry.storyTime !== '鏈槑' ? `銆?{entry.storyTime}銆慲 : '';
  return `${time}${entry.content}`.trim();
}

function normalizeWorldbookContent(content) {
  return String(content || '').replace(/\r\n/g, '\n').trim();
}

// 鎻掑叆椤哄簭锛坥rder锛夛細钃濈伅鎬昏鍥哄畾 900锛岀豢鐏粠 901 璧锋寜璁板綍锛堚増鍓ф儏锛夐『搴忛€愭潯 +1銆?// 璇存槑锛歮emoir.entries 鐨勬暟缁勯『搴忓氨鏄褰曢『搴忥紝鍥犲ぇ鎬荤粨鎸夊墽鎯呮帹杩涗緷娆″鐞嗭紝澶╃劧鍗虫椂闂村簭锛?// storyTime 鏄嚜鐢辨枃鏈紙涓嶅悓涓栫晫鐨勭邯骞?鏃舵鍚勫紓锛夛紝涓嶅仛瀛楃涓叉帓搴忥紝閬垮厤璇帓銆?const MEMOIR_BLUE_ORDER = 900;
const MEMOIR_GREEN_ORDER_BASE = 901;

/** 缁跨伅鏉＄洰缁撴瀯锛堟柊 schema锛夛紝渚?createWorldbookEntries銆俹rder 浼氬湪鍐欏叆鍚庣粺涓€閲嶆帓銆?*/
function buildGreenEntryPayload(entry, order) {
  return {
    name: `${MEMOIR_GREEN_NAME_PREFIX}${entry.title}`,
    enabled: true,
    strategy: {
      type: 'selective',
      keys: entry.mainKeywords.length ? entry.mainKeywords : [entry.title],
      keys_secondary: { logic: 'and_any', keys: entry.filterKeywords },
      scan_depth: 'same_as_global',
    },
    position: { type: 'after_character_definition', role: 'system', depth: 0, order },
    content: buildGreenContent(entry),
    probability: 100,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    extra: {
      memoirId: entry.memoirId,
      memoirType: 'green',
      storyTime: entry.storyTime,
      importance: entry.importance,
      participants: entry.participants,
    },
  };
}

/**
 * 鎶婄敤鎴风‘璁ゅ悗鐨勫€欓€夊啓鍏ヤ笘鐣屼功銆? * - 缁跨伅锛氶€愭潯鏂板锛堝閲忥紝涓嶅姩鏃ф潯鐩級銆? * - 钃濈伅锛氱敤鍏ㄩ噺 entries 閲嶅缓鍚庤鐩栵紙涓嶄涪鏃х洰褰曪級銆? * - 鐙珛璇诲洖纭缁跨伅涓庤摑鐏悗锛屾墠鏇存柊 entries銆乻ourceProcessed 骞舵竻绌?pending銆? *
 * @param {Array} confirmedCandidates 鐢ㄦ埛纭淇濈暀锛堝彲鑳藉凡缂栬緫锛夌殑鍊欓€夋暟缁? * @param {object} opts - sourceKey: 骞傜瓑閿紙鍐欏叆鍚庤鍏?sourceProcessed锛? * @returns {Promise<{ worldbookName, greenAdded, blueMode, totalEntries, verified }>}
 */
export async function commitMemoirCandidates(
  confirmedCandidates,
  { sourceKey, sourceKeys: pendingSourceKeys = [], confirmUseCurrent } = {},
) {
  const list = Array.isArray(confirmedCandidates) ? confirmedCandidates.filter(c => c && c.content) : [];
  if (!list.length) {
    throw new Error('娌℃湁鍙啓鍏ョ殑鍥炲繂鍊欓€夈€?);
  }

  // 1) 鍑嗗鏈疆缁跨伅銆俢andidateId 鏉ヨ嚜宸叉寔涔呭寲 pending锛屽彲璁╁け璐ラ噸璇曚繚鎸佸悓涓€ memoirId銆?  const now = formatTimestamp();
  const newEntries = list.map((c) => {
    const memoirId = c.memoirId || (c.candidateId
      ? String(c.candidateId).replace(/^cand-/, 'mem-')
      : '');
    if (!memoirId) {
      throw new Error('寰呭啓鍏ュ€欓€夌己灏戠ǔ瀹?ID锛岃閲嶆柊鎻愮偧鍚庡啀璇曘€?);
    }
    return {
      memoirId,
      title: c.title,
      digest: c.digest || '',
      storyTime: c.storyTime || '鏈槑',
      importance: ['high', 'medium', 'low'].includes(c.importance) ? c.importance : 'medium',
      participants: Array.isArray(c.participants) ? c.participants : [],
      mainKeywords: Array.isArray(c.mainKeywords) ? c.mainKeywords : [],
      filterKeywords: Array.isArray(c.filterKeywords) ? c.filterKeywords : [],
      content: c.content,
      createdAt: now,
      updatedAt: now,
    };
  });

  // 绋冲畾 ID 鏍￠獙閫氳繃鍚庡啀瑙ｆ瀽/鍒涘缓鐩爣涓栫晫涔︼紝閬垮厤鏃犳晥鍊欓€夎Е鍙戠粦瀹氬壇浣滅敤銆?  const api = getWorldbookApi();
  const { worldbookName } = await ensureMemoirWorldbook({ confirmUseCurrent });
  const memoir = getMemoirState();
  const sourceKeys = [...new Set([
    ...(Array.isArray(pendingSourceKeys) ? pendingSourceKeys : []),
    sourceKey,
  ].filter(Boolean))];

  // pending 澶辫触閲嶈瘯鏃讹紝鍚屼竴 candidateId 浼氬緱鍒板悓涓€ memoirId銆傛柊鍊艰鐩栨湰鍦板悓 ID 绱㈠紩锛?  // 浣嗕笉浼氭敼鍙樺師鏈夐『搴忥紱鐪熸鏄惁闇€瑕佽ˉ鍐欙紝浠ヤ笘鐣屼功鍐呯殑绋冲畾 ID 涓哄噯銆?  const unkeyedEntries = memoir.entries.filter(entry => !entry?.memoirId);
  const entriesById = new Map(
    memoir.entries
      .filter(entry => entry?.memoirId)
      .map(entry => [entry.memoirId, entry]),
  );
  newEntries.forEach(entry => entriesById.set(entry.memoirId, entry));
  const allEntries = [...unkeyedEntries, ...entriesById.values()];

  // 2) 鍗曟鏇存柊瀹屾垚缁跨伅鏂板銆佽摑鐏垱寤?瑕嗙洊鍜屽叏閲忔帓搴忥紝閬垮厤涓€斿け璐ョ暀涓嬪崐鎵规潯鐩€?  const blueContent = buildMemoirBlueContent(allEntries);
  const greenOrderById = new Map(
    allEntries.map((e, i) => [e.memoirId, MEMOIR_GREEN_ORDER_BASE + i]),
  );
  let blueMode = 'updated';
  const greenAddedIds = new Set();
  const verification = await updateWorldbookWithVerification(worldbookName, (book) => {
    const list2 = Array.isArray(book) ? book : [];
    const existingMemoirIds = new Set(
      list2.map(entry => entry?.extra?.memoirId).filter(Boolean),
    );
    newEntries.forEach((entry) => {
      if (existingMemoirIds.has(entry.memoirId)) return;
      list2.push(buildGreenEntryPayload(entry, greenOrderById.get(entry.memoirId)));
      existingMemoirIds.add(entry.memoirId);
      greenAddedIds.add(entry.memoirId);
    });

    let blueFound = false;
    list2.forEach(e => {
      if (!e) return;
      if (e.extra?.memoirType === 'green' && greenOrderById.has(e.extra.memoirId)) {
        e.position = { ...(e.position || {}), order: greenOrderById.get(e.extra.memoirId) };
      }
      if (e.name === MEMOIR_BLUE_NAME || e.extra?.memoirType === 'blue') {
        blueFound = true;
        e.content = blueContent;
        e.extra = { ...(e.extra || {}), memoirType: 'blue' };
        e.strategy = { ...(e.strategy || {}), type: 'constant' };
        e.position = { ...(e.position || {}), order: MEMOIR_BLUE_ORDER };
        e.recursion = { prevent_incoming: true, prevent_outgoing: true, delay_until: null };
      }
    });
    if (!blueFound) {
      list2.push({
        name: MEMOIR_BLUE_NAME,
        enabled: true,
        strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
        position: { type: 'after_character_definition', role: 'system', depth: 0, order: MEMOIR_BLUE_ORDER },
        content: blueContent,
        probability: 100,
        recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
        extra: { memoirType: 'blue' },
      });
      blueMode = 'created';
    }
    return list2;
  }, {
    api,
    idField: 'memoirId',
    expectedIds: newEntries.map(entry => entry.memoirId),
    typeField: 'memoirType',
    typeValue: 'green',
  });

  // 3) update 杩斿洖涓嶇瓑浜庣湡瀹炴寔涔呭寲鎴愬姛锛涘叡浜鐞嗗櫒宸茬嫭绔嬭鍥炲苟鎸?memoirId 鏍稿鏈壒缁跨伅銆?  const blueEntry = verification.book.find(entry => entry?.extra?.memoirType === 'blue') || null;
  const blueContentMatches = blueEntry
    && normalizeWorldbookContent(blueEntry.content) === normalizeWorldbookContent(blueContent);
  if (!verification.ok || !blueEntry || !blueContentMatches) {
    const problems = [];
    if (verification.missingIds.length) {
      problems.push(`缂哄皯缁跨伅锛?{verification.missingIds.join('銆?)}`);
    }
    if (!blueEntry) problems.push('缂哄皯钃濈伅鎬昏');
    else if (!blueContentMatches) problems.push('钃濈伅鎬昏鍐呭涓庨鏈熶笉涓€鑷?);
    const error = new Error(`涓栫晫涔﹀啓鍏ュ悗鐨勮鍥炴牳瀵瑰け璐ワ紙${problems.join('锛?)}锛夈€傚緟纭鎵规宸蹭繚鐣欙紝鍙畨鍏ㄩ噸璇曘€俙);
    error.name = 'WorldbookVerificationError';
    error.worldbookName = worldbookName;
    error.missingMemoirIds = verification.missingIds;
    error.blueVerified = !!blueEntry && !!blueContentMatches;
    throw error;
  }

  // 4) 鍏ㄩ儴璇诲洖鎴愬姛鍚庢墠鍐欐湰鍦扮储寮曪紱UID 鎸夌ǔ瀹?ID 鍥炲～锛屼笉鍐嶆寜鍙兘閲嶅悕鐨勬爣棰樺尮閰嶃€?  const verifiedById = new Map(
    verification.verifiedEntries.map(entry => [entry.extra.memoirId, entry]),
  );
  allEntries.forEach(entry => {
    const verified = verifiedById.get(entry.memoirId);
    if (verified?.uid !== undefined && verified?.uid !== null) entry.uid = verified.uid;
  });
  memoir.entries = allEntries;

  // 5) 鍙湁缁跨伅涓庤摑鐏潎鏍稿閫氳繃锛屾墠鍋氬箓绛夋爣璁板苟娓?pending銆?  sourceKeys.forEach((key) => {
    if (!memoir.sourceProcessed.includes(key)) memoir.sourceProcessed.push(key);
  });
  memoir.pending = null;
  memoir.updatedAt = now;
  saveChatState();

  return {
    worldbookName,
    greenAdded: greenAddedIds.size,
    blueMode,
    totalEntries: memoir.entries.length,
    verified: true,
  };
}

// 鈹€鈹€ 鎵嬪姩鎻愮偧锛氫粠鏈€鏂板ぇ鎬荤粨鎻愮偧骞舵殏瀛橈紙渚涢潰鏉库€滄墜鍔ㄦ彁鐐尖€濇寜閽級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 鎵嬪姩瑙﹀彂锛氳鏈€鏂板ぇ鎬荤粨姝ｆ枃鎻愮偧鍊欓€夊苟鏆傚瓨鍒?pending銆? * @param {object} deps - generate: 鐢熸垚鍑芥暟锛堢敱 UI 娉ㄥ叆 generateSummaryMemory锛? *   - grandMemoryText: 鍙€夛紝鎸囧畾绱犳潗锛涗笉浼犲垯鐢辫皟鐢ㄦ柟璇诲彇鏈€鏂板ぇ鎬荤粨
 * @returns {Promise<{ staged: boolean, count: number, reason?: string }>}
 */
export async function runManualMemoirExtraction({
  generate,
  grandMemoryText,
  sourceKey,
  archiveRecord = null,
  allowProcessed = false,
} = {}) {
  const resolvedRecord = archiveRecord || {
    summaryMessageId: sourceKey || 'manual',
    memoryFrom: '?',
    memoryTo: '?',
  };
  const resolvedSourceKey = buildSourceKey(resolvedRecord);
  const memoir = getMemoirState();
  const pendingSourceKeys = Array.isArray(memoir.pending?.sourceKeys)
    ? memoir.pending.sourceKeys
    : [memoir.pending?.sourceKey].filter(Boolean);
  if (!allowProcessed && pendingSourceKeys.includes(resolvedSourceKey)) {
    return { staged: false, count: 0, reason: 'already_pending', sourceKey: resolvedSourceKey };
  }
  if (!allowProcessed && memoir.sourceProcessed.includes(resolvedSourceKey)) {
    return { staged: false, count: 0, reason: 'already_processed', sourceKey: resolvedSourceKey };
  }

  const result = await tryExtractMemoirFromGrandSummary(resolvedRecord, {
    generate,
    grandMemoryText,
    force: true, // 鎵嬪姩鎻愮偧缁曡繃 enabled/骞傜瓑锛岀敱鐢ㄦ埛涓诲姩鍙戣捣
  });
  if (!result.memories.length) {
    return { staged: false, count: 0, reason: 'no_memory' };
  }
  stageMemoirCandidates(result);
  return { staged: true, count: result.memories.length };
}

// 鈹€鈹€ 璁惧畾閲囬泦鏉愭枡璇诲彇涓庤鑹茬粦瀹氫笘鐣屼功瑙ｆ瀽 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// 璁惧畾閲囬泦涓昏鍓ф儏鏉愭枡璇诲彇涓庨妫€銆傞樁娈?C 鍙鐞嗚亰澶╁拰澶ф€荤粨锛屼笉璇诲彇鍙€変笂涓嬫枃銆?

export const MAX_CAPTURE_CHAT_MESSAGES = 200;

export const CAPTURE_MATERIAL_ERROR_CODES = Object.freeze({
  INVALID_SOURCE_MODE: 'invalid_source_mode',
  INVALID_FLOOR_RANGE: 'invalid_floor_range',
  FLOOR_OUT_OF_RANGE: 'floor_out_of_range',
  EMPTY_CHAT: 'empty_chat',
  EMPTY_MATERIAL: 'empty_material',
  GRAND_SUMMARY_NOT_FOUND: 'grand_summary_not_found',
  TOO_MANY_MESSAGES: 'too_many_messages',
});

export const CAPTURE_OPTIONAL_ERROR_CODES = Object.freeze({
  CHARACTER_CARD_UNAVAILABLE: 'character_card_unavailable',
  PERSONA_UNAVAILABLE: 'persona_unavailable',
  WORLDBOOK_LIST_FAILED: 'worldbook_list_failed',
  WORLDBOOK_LOAD_FAILED: 'worldbook_load_failed',
  WORLDBOOK_REF_MISSING: 'worldbook_ref_missing',
});

function isCaptureMaterialObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCaptureMaterialFloor(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeRecentCount(value) {
  if (value === null || value === undefined || value === '') return 20;
  const number = Number(value);
  if (!Number.isFinite(number)) return 20;
  return Math.min(200, Math.max(5, Math.trunc(number)));
}

function normalizeRole(message) {
  const role = String(message?.role || (message?.is_user ? 'user' : 'assistant')).toLowerCase();
  return role === 'user' || role === 'assistant' ? role : '';
}

function getMessageFloor(message, index = 0) {
  const floor = Number(message?.message_id ?? message?.id ?? index);
  return Number.isFinite(floor) && floor >= 0 ? Math.trunc(floor) : null;
}

function getRawMessageContent(message) {
  return String(message?.message ?? message?.mes ?? message?.content ?? '');
}

function isSystemOrInjectedMessage(message) {
  return message?.is_system === true
    || message?.extra?.is_system === true
    || message?.extra?.isSmallSys === true
    || message?.extra?.isAuthorNote === true
    || message?.extra?.is_author_note === true;
}

function cleanPureChatContent(content, summarySettings) {
  const withoutManagedBlocks = String(content || '')
    .replace(GRAND_MEMORY_BLOCK_RE, '')
    .replace(MEMORY_BLOCK_RE, '')
    .replace(LIST_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return extractSummarySourceContent(withoutManagedBlocks, summarySettings).trim();
}

function resolveSpeaker(message, role, names) {
  const explicitName = String(message?.name ?? '').trim();
  if (explicitName) return explicitName;
  return role === 'user' ? names.userName : names.characterName;
}

function resolveNames(names = {}) {
  const context = getContextSafe();
  return {
    userName: String(names.userName || context?.name1 || context?.user_name || '鐢ㄦ埛').trim() || '鐢ㄦ埛',
    characterName: String(names.characterName || context?.name2 || context?.character?.name || '瑙掕壊').trim() || '瑙掕壊',
  };
}

/**
 * 浠庣湡瀹炶亰澶╂ゼ灞備腑鎻愬彇绾亰澶┿€傞殣钘忕殑姝ｅ父鐢ㄦ埛/瑙掕壊妤煎眰浠嶄繚鐣欙紝浠ユ敮鎸佽鍙栬澶ф€荤粨褰掓。鐨勫師濮嬪墽鎯呫€? * getChatMessagesSafe 鍙繑鍥炲綋鍓嶉€変腑鐨?swipe锛涙湰鍑芥暟涓嶄細閬嶅巻 message.swipes銆? */
export function collectPureChatMessages({ messages, summarySettings, names } = {}) {
  const rawMessages = Array.isArray(messages)
    ? messages
    : getChatMessagesSafe(undefined, { hide_state: 'all' });
  const settings = isCaptureMaterialObject(summarySettings) ? summarySettings : getSummarySettings();
  const resolvedNames = resolveNames(names);

  return rawMessages
    .map((message, index) => ({ message, floor: getMessageFloor(message, index) }))
    .filter(item => item.floor !== null)
    .sort((a, b) => a.floor - b.floor)
    .flatMap(({ message, floor }) => {
      const role = normalizeRole(message);
      if (!role || isSystemOrInjectedMessage(message)) return [];
      const rawContent = getRawMessageContent(message);
      if (GRAND_MEMORY_BLOCK_RE.test(rawContent)) return [];
      const content = cleanPureChatContent(rawContent, settings);
      if (!content) return [];
      return [{
        floor,
        role,
        speaker: resolveSpeaker(message, role, resolvedNames),
        content,
        characterCount: content.length,
        isHidden: message?.is_hidden === true,
      }];
    });
}

export function formatCaptureChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => `绗?${message.floor} 妤硷綔${message.speaker}锛?{message.content}`)
    .join('\n\n');
}

function createStats(messages, material) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    fromFloor: list[0]?.floor ?? null,
    toFloor: list.at(-1)?.floor ?? null,
    floorIds: list.map(message => message.floor),
    messageCount: list.length,
    characterCount: String(material || '').length,
  };
}

function createSuccess(mode, messages, material, extra = {}) {
  return {
    ok: true,
    mode,
    material,
    messages,
    summary: extra.summary || null,
    stats: createStats(messages, material),
    errors: [],
    ...extra,
  };
}

function createFailure(mode, code, message, details = {}) {
  return {
    ok: false,
    mode,
    material: '',
    messages: [],
    summary: null,
    stats: createStats([], ''),
    errors: [{ code, message, details }],
  };
}

function getRawFloorBounds(rawMessages) {
  const floors = (Array.isArray(rawMessages) ? rawMessages : [])
    .map(getMessageFloor)
    .filter(floor => floor !== null);
  return {
    minFloor: floors.length ? Math.min(...floors) : null,
    maxFloor: floors.length ? Math.max(...floors) : null,
  };
}

function resolveRecentChat(source, context) {
  const count = normalizeRecentCount(source.recentCount);
  const selected = context.pureMessages.slice(-count);
  if (!selected.length) {
    return createFailure('recent_chat', CAPTURE_MATERIAL_ERROR_CODES.EMPTY_MATERIAL, '鏈€杩戣亰澶╀腑娌℃湁鍙敤鐨勭函鑱婂ぉ妤煎眰銆?);
  }
  const material = formatCaptureChatMessages(selected);
  return createSuccess('recent_chat', selected, material, { requestedCount: count });
}

function resolveFloorRange(source, context) {
  const fromFloor = normalizeCaptureMaterialFloor(source.fromFloor);
  const toFloor = normalizeCaptureMaterialFloor(source.toFloor);
  if (fromFloor === null || toFloor === null || fromFloor > toFloor) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.INVALID_FLOOR_RANGE,
      '鎸囧畾妤煎眰鑼冨洿鏃犳晥锛岃濉啓闈炶礋鏁存暟锛屼笖璧峰妤煎眰涓嶈兘澶т簬缁撴潫妤煎眰銆?,
      { fromFloor: source.fromFloor ?? null, toFloor: source.toFloor ?? null },
    );
  }
  const { minFloor, maxFloor } = context.rawFloorBounds;
  if (minFloor === null || maxFloor === null) {
    return createFailure('floor_range', CAPTURE_MATERIAL_ERROR_CODES.EMPTY_CHAT, '褰撳墠鑱婂ぉ娌℃湁浠讳綍妤煎眰銆?);
  }
  if (fromFloor < minFloor || fromFloor > maxFloor || toFloor > maxFloor) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.FLOOR_OUT_OF_RANGE,
      `鎸囧畾妤煎眰瓒呭嚭褰撳墠鑱婂ぉ鑼冨洿 ${minFloor}鈥?{maxFloor}銆俙,
      { fromFloor, toFloor, minFloor, maxFloor },
    );
  }
  const selected = context.pureMessages.filter(message => (
    message.floor >= fromFloor && message.floor <= toFloor
  ));
  if (!selected.length) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.EMPTY_MATERIAL,
      `绗?${fromFloor}鈥?{toFloor} 妤兼病鏈夊彲鐢ㄧ殑绾亰澶╁唴瀹广€俙,
      { fromFloor, toFloor },
    );
  }
  if (selected.length > MAX_CAPTURE_CHAT_MESSAGES) {
    return createFailure(
      'floor_range',
      CAPTURE_MATERIAL_ERROR_CODES.TOO_MANY_MESSAGES,
      `鎸囧畾鑼冨洿鍖呭惈 ${selected.length} 鏉＄函鑱婂ぉ锛岃秴杩囧崟娆℃渶澶?${MAX_CAPTURE_CHAT_MESSAGES} 鏉＄殑淇濇姢闄愬埗銆俙,
      { fromFloor, toFloor, messageCount: selected.length, maxMessageCount: MAX_CAPTURE_CHAT_MESSAGES },
    );
  }
  const material = formatCaptureChatMessages(selected);
  return createSuccess('floor_range', selected, material, {
    requestedRange: { fromFloor, toFloor },
  });
}

function extractGrandSummaryContent(content) {
  const match = String(content || '').match(GRAND_MEMORY_BLOCK_RE);
  return match?.[0]?.trim() || '';
}

function findLatestGrandSummary(rawMessages, chatState) {
  const messagesByFloor = new Map(
    (Array.isArray(rawMessages) ? rawMessages : [])
      .map((message, index) => [getMessageFloor(message, index), message])
      .filter(([floor]) => floor !== null),
  );
  const records = Array.isArray(chatState?.summary?.archiveRecords)
    ? chatState.summary.archiveRecords
    : [];
  const activeRecords = records
    .filter(record => !record?.compressedBy)
    .sort((a, b) => Number(b?.summaryMessageId ?? -1) - Number(a?.summaryMessageId ?? -1));

  for (const record of activeRecords) {
    const messageId = normalizeCaptureMaterialFloor(record?.summaryMessageId);
    const message = messageId === null ? null : messagesByFloor.get(messageId);
    const content = extractGrandSummaryContent(getRawMessageContent(message));
    if (!message || normalizeRole(message) !== 'assistant' || isSystemOrInjectedMessage(message) || !content) continue;
    return {
      messageId,
      content,
      coverageFrom: normalizeCaptureMaterialFloor(record.archiveFrom),
      coverageTo: normalizeCaptureMaterialFloor(record.archiveTo),
      recordId: String(record.id ?? ''),
    };
  }

  const fallback = [...messagesByFloor.entries()]
    .sort((a, b) => b[0] - a[0])
    .find(([, message]) => (
      normalizeRole(message) === 'assistant'
      && !isSystemOrInjectedMessage(message)
      && extractGrandSummaryContent(getRawMessageContent(message))
    ));
  if (!fallback) return null;
  return {
    messageId: fallback[0],
    content: extractGrandSummaryContent(getRawMessageContent(fallback[1])),
    coverageFrom: null,
    coverageTo: null,
    recordId: '',
  };
}

function resolveGrandPlusAfter(context) {
  const summary = findLatestGrandSummary(context.rawMessages, context.chatState);
  if (!summary) {
    return createFailure(
      'grand_plus_after',
      CAPTURE_MATERIAL_ERROR_CODES.GRAND_SUMMARY_NOT_FOUND,
      '褰撳墠鑱婂ぉ娌℃湁鍙敤鐨勫ぇ鎬荤粨銆?,
    );
  }
  const messages = context.pureMessages.filter(message => message.floor > summary.messageId);
  if (messages.length > MAX_CAPTURE_CHAT_MESSAGES) {
    return createFailure(
      'grand_plus_after',
      CAPTURE_MATERIAL_ERROR_CODES.TOO_MANY_MESSAGES,
      `澶ф€荤粨鍚庢湁 ${messages.length} 鏉＄函鑱婂ぉ锛岃秴杩囧崟娆℃渶澶?${MAX_CAPTURE_CHAT_MESSAGES} 鏉＄殑淇濇姢闄愬埗銆俙,
      { summaryMessageId: summary.messageId, messageCount: messages.length, maxMessageCount: MAX_CAPTURE_CHAT_MESSAGES },
    );
  }
  const coverage = summary.coverageFrom !== null && summary.coverageTo !== null
    ? `锝滆鐩栫 ${summary.coverageFrom}鈥?{summary.coverageTo} 妤糮
    : '';
  const sections = [`銆愭渶杩戝ぇ鎬荤粨锝滅 ${summary.messageId} 妤?{coverage}銆慭n${summary.content}`];
  if (messages.length) {
    sections.push(`銆愬ぇ鎬荤粨鍚庣殑绾亰澶┿€慭n${formatCaptureChatMessages(messages)}`);
  }
  const material = sections.join('\n\n');
  return createSuccess('grand_plus_after', messages, material, { summary });
}

/**
 * 鏍规嵁鍞竴鏉ユ簮妯″紡鏋勫缓鍓ф儏鏉愭枡锛屽苟杩斿洖鍙緵 UI 浣跨敤鐨勭粨鏋勫寲鑼冨洿銆佽鏁颁笌棰勬閿欒銆? */
export function buildCaptureSourceMaterial(source, options = {}) {
  const normalizedSource = isCaptureMaterialObject(source) ? source : {};
  const mode = normalizedSource.mode;
  if (!CAPTURE_SOURCE_MODES.includes(mode)) {
    return createFailure(
      mode || '',
      CAPTURE_MATERIAL_ERROR_CODES.INVALID_SOURCE_MODE,
      '璁惧畾閲囬泦鐨勪富瑕佸墽鎯呮潵婧愭棤鏁堛€?,
      { mode: mode ?? null },
    );
  }

  const rawMessages = Array.isArray(options.messages)
    ? options.messages
    : getChatMessagesSafe(undefined, { hide_state: 'all' });
  const pureMessages = collectPureChatMessages({
    messages: rawMessages,
    summarySettings: options.summarySettings,
    names: options.names,
  });
  const context = {
    rawMessages,
    pureMessages,
    rawFloorBounds: getRawFloorBounds(rawMessages),
    chatState: isCaptureMaterialObject(options.chatState) ? options.chatState : getChatState(),
  };

  if (mode === 'recent_chat') return resolveRecentChat(normalizedSource, context);
  if (mode === 'floor_range') return resolveFloorRange(normalizedSource, context);
  return resolveGrandPlusAfter(context);
}

function hasActiveCharacterContext(context, characterMaterial) {
  if (!characterMaterial) return false;
  const rawId = context?.characterId ?? context?.this_chid ?? context?.chid;
  const hasId = rawId !== null && rawId !== undefined && String(rawId).trim() !== '' && Number(rawId) !== -1;
  return hasId || Boolean(context?.character) || Boolean(context?.name2);
}

/** 杩斿洖瑙掕壊鍗′笌 Persona 鐨勫綋鍓嶅彲鐢ㄧ姸鎬佸拰宸茬粡鏍煎紡鍖栫殑鏉愭枡銆?*/
export function inspectCaptureOptionalSources(options = {}) {
  const context = getContextSafe();
  const hasInjectedCharacter = Object.hasOwn(options, 'characterCard');
  const hasInjectedPersona = Object.hasOwn(options, 'persona');
  const characterCard = hasInjectedCharacter ? options.characterCard : getResolvedCharacterCard();
  const persona = hasInjectedPersona ? options.persona : getUserPersona();
  const characterMaterial = formatCharacterCardForPrompt(characterCard);
  const personaMaterial = formatUserPersonaForPrompt(persona);
  const characterAvailable = Object.hasOwn(options, 'characterAvailable')
    ? options.characterAvailable === true
    : (hasInjectedCharacter ? Boolean(characterMaterial) : hasActiveCharacterContext(context, characterMaterial));

  return {
    characterCard: {
      available: characterAvailable && Boolean(characterMaterial),
      reason: characterAvailable && characterMaterial ? '' : '褰撳墠娌℃湁鍙鍙栫殑瑙掕壊鍗°€?,
      name: String(characterCard?.name || '').trim(),
      material: characterMaterial,
      data: characterCard || null,
    },
    persona: {
      available: Boolean(personaMaterial),
      reason: personaMaterial ? '' : '褰撳墠 Persona 娌℃湁鍙鍙栫殑鎻忚堪銆?,
      material: personaMaterial,
    },
  };
}

function normalizeWorldbookKeyword(value) {
  if (value instanceof RegExp) return value.toString();
  return String(value ?? '').trim();
}

function normalizeWorldbookKeywords(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeWorldbookKeyword).filter(Boolean);
}

function normalizeWorldbookEntryForCapture(worldbookName, entry) {
  const uid = Number(entry?.uid);
  if (!Number.isInteger(uid) || uid < 0) return null;
  const content = String(entry?.content ?? '');
  const name = String(entry?.name ?? '').trim() || `鏈懡鍚嶆潯鐩?#${uid}`;
  return {
    worldbookName,
    uid,
    name,
    enabled: entry?.enabled !== false,
    strategyType: ['constant', 'selective', 'vectorized'].includes(entry?.strategy?.type)
      ? entry.strategy.type
      : 'selective',
    mainKeywords: normalizeWorldbookKeywords(entry?.strategy?.keys),
    filterKeywords: normalizeWorldbookKeywords(entry?.strategy?.keys_secondary?.keys),
    content,
    preview: content.replace(/\s+/g, ' ').trim().slice(0, 80),
    position: String(entry?.position?.type || ''),
    order: Number.isFinite(Number(entry?.position?.order)) ? Number(entry.position.order) : null,
  };
}

export function createCaptureWorldbookRef(worldbookName, entry) {
  const name = String(worldbookName || '').trim();
  const uid = Number(entry?.uid);
  if (!name || !Number.isInteger(uid) || uid < 0) return null;
  return {
    worldbookName: name,
    uid,
    entryNameSnapshot: String(entry?.name ?? entry?.entryNameSnapshot ?? '').trim(),
  };
}

function getCaptureWorldbookRefKey(ref) {
  return `${String(ref?.worldbookName || '').trim()}\u0000${Number(ref?.uid)}`;
}

export function toggleCaptureWorldbookRef(refs, ref, selected) {
  const normalizedRef = createCaptureWorldbookRef(ref?.worldbookName, ref);
  const current = Array.isArray(refs) ? refs.map(item => createCaptureWorldbookRef(item?.worldbookName, item)).filter(Boolean) : [];
  if (!normalizedRef) return current;
  const key = getCaptureWorldbookRefKey(normalizedRef);
  const exists = current.some(item => getCaptureWorldbookRefKey(item) === key);
  const shouldSelect = selected === undefined ? !exists : selected === true;
  if (shouldSelect && !exists) return [...current, normalizedRef];
  if (!shouldSelect && exists) return current.filter(item => getCaptureWorldbookRefKey(item) !== key);
  return current;
}

export function setCaptureWorldbookRefsForBook(refs, worldbookName, entries, selected) {
  const name = String(worldbookName || '').trim();
  let next = (Array.isArray(refs) ? refs : [])
    .map(item => createCaptureWorldbookRef(item?.worldbookName, item))
    .filter(Boolean);
  if (!selected) return next.filter(ref => ref.worldbookName !== name);
  (Array.isArray(entries) ? entries : []).forEach(entry => {
    const ref = createCaptureWorldbookRef(name, entry);
    if (ref) next = toggleCaptureWorldbookRef(next, ref, true);
  });
  return next;
}

/**
 * 鍙繑鍥炲綋鍓嶈鑹插崱缁戝畾鐨勪笘鐣屼功锛坧rimary + additional锛夛紝涓嶆媺鍙栧叏閮ㄤ笘鐣屼功銆? * 璁惧畾閲囬泦鍙湪瑙掕壊鍗＄粦瀹氱殑涓栫晫涔﹀唴閫夋嫨鏉＄洰銆? */
export async function listCaptureWorldbooks({ api } = {}) {
  try {
    const readApi = api || getWorldbookReadApi();
    if (typeof readApi.getCharWorldbookNames !== 'function') {
      throw new Error('褰撳墠鐜缂哄皯 getCharWorldbookNames锛屾棤娉曡鍙栬鑹插崱缁戝畾鐨勪笘鐣屼功銆?);
    }
    const bound = await Promise.resolve(readApi.getCharWorldbookNames('current'));
    const primary = String(bound?.primary || '').trim();
    const additional = Array.isArray(bound?.additional) ? bound.additional : [];
    // primary 鎺掑湪鏈€鍓嶏紝additional 鍘婚噸璺熼殢锛涚┖鍚嶅墧闄ゃ€?    const names = [...new Set([primary, ...additional]
      .map(name => String(name || '').trim())
      .filter(Boolean))];
    return { ok: true, names, primary: primary || null, error: null };
  } catch (error) {
    return {
      ok: false,
      names: [],
      primary: null,
      error: {
        code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_LIST_FAILED,
        message: `璇诲彇瑙掕壊鍗＄粦瀹氱殑涓栫晫涔﹀け璐ワ細${error.message || String(error)}`,
      },
    };
  }
}

/** 鎸夐渶鍔犺浇鍗曟湰涓栫晫涔﹀叏閮ㄦ潯鐩紝淇濈暀鍏抽棴鐘舵€佸拰婵€娲荤被鍨嬩緵閫夋嫨鍣ㄥ睍绀恒€?*/
export async function loadCaptureWorldbookEntries(worldbookName, { api } = {}) {
  const name = String(worldbookName || '').trim();
  try {
    const readApi = api || getWorldbookReadApi();
    const rawEntries = await readApi.getWorldbook(name);
    if (!Array.isArray(rawEntries)) throw new Error('杩斿洖缁撴灉涓嶆槸鏉＄洰鏁扮粍銆?);
    const entries = rawEntries
      .map(entry => normalizeWorldbookEntryForCapture(name, entry))
      .filter(Boolean);
    return { ok: true, worldbookName: name, entries, error: null };
  } catch (error) {
    return {
      ok: false,
      worldbookName: name,
      entries: [],
      error: {
        code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_LOAD_FAILED,
        message: `璇诲彇涓栫晫涔︺€?{name || '鏈懡鍚?}銆嶅け璐ワ細${error.message || String(error)}`,
        worldbookName: name,
      },
    };
  }
}

export function filterCaptureWorldbookEntries(entries, query) {
  const keyword = String(query || '').trim().toLocaleLowerCase();
  if (!keyword) return Array.isArray(entries) ? entries : [];
  return (Array.isArray(entries) ? entries : []).filter(entry => [
    entry?.name,
    ...(Array.isArray(entry?.mainKeywords) ? entry.mainKeywords : []),
    ...(Array.isArray(entry?.filterKeywords) ? entry.filterKeywords : []),
  ].some(value => String(value || '').toLocaleLowerCase().includes(keyword)));
}

function formatSelectedWorldbookEntry(entry) {
  return [
    `銆愪笘鐣屼功鍙傝€冿綔${entry.worldbookName}锝?{entry.name}锝淯ID ${entry.uid}銆慲,
    entry.content,
  ].join('\n');
}

/**
 * 姝ｅ紡鐢熸垚鍓嶄娇鐢細閲嶆柊璇诲彇鎵€鏈夋槑纭嬀閫夌殑 worldbookName + uid锛屽苟鏋勫缓鏈€缁堥檮鍔犳潗鏂欍€? * 鍏抽棴銆佸父椹汇€佹湭瑙﹀彂銆佷綅缃拰閫掑綊鐘舵€佸潎涓嶅弬涓庣瓫閫夛紱缂哄け寮曠敤浼氭槑纭姤閿欍€? */
export async function buildCaptureOptionalContextMaterial(optionalContext, options = {}) {
  const selection = isCaptureMaterialObject(optionalContext) ? optionalContext : {};
  const sources = inspectCaptureOptionalSources(options);
  const errors = [];
  const sections = [];
  if (selection.includeCharacterCard) {
    if (sources.characterCard.available) sections.push(`銆愬綋鍓嶈鑹插崱銆慭n${sources.characterCard.material}`);
    else errors.push({
      code: CAPTURE_OPTIONAL_ERROR_CODES.CHARACTER_CARD_UNAVAILABLE,
      message: sources.characterCard.reason,
    });
  }
  if (selection.includePersona) {
    if (sources.persona.available) sections.push(`銆愬綋鍓?Persona銆慭n${sources.persona.material}`);
    else errors.push({
      code: CAPTURE_OPTIONAL_ERROR_CODES.PERSONA_UNAVAILABLE,
      message: sources.persona.reason,
    });
  }

  const refs = (Array.isArray(selection.worldbookRefs) ? selection.worldbookRefs : [])
    .map(ref => createCaptureWorldbookRef(ref?.worldbookName, ref))
    .filter(Boolean);
  const uniqueRefs = [...new Map(refs.map(ref => [getCaptureWorldbookRefKey(ref), ref])).values()];
  const refsByBook = new Map();
  uniqueRefs.forEach(ref => {
    if (!refsByBook.has(ref.worldbookName)) refsByBook.set(ref.worldbookName, []);
    refsByBook.get(ref.worldbookName).push(ref);
  });

  const resolvedEntries = [];
  const missingRefs = [];
  for (const [worldbookName, bookRefs] of refsByBook.entries()) {
    const loaded = await loadCaptureWorldbookEntries(worldbookName, { api: options.api });
    if (!loaded.ok) {
      errors.push(loaded.error);
      bookRefs.forEach(ref => missingRefs.push(ref));
      continue;
    }
    const byUid = new Map(loaded.entries.map(entry => [entry.uid, entry]));
    bookRefs.forEach(ref => {
      const entry = byUid.get(ref.uid);
      if (!entry) {
        missingRefs.push(ref);
        errors.push({
          code: CAPTURE_OPTIONAL_ERROR_CODES.WORLDBOOK_REF_MISSING,
          message: `涓栫晫涔︺€?{ref.worldbookName}銆嶄腑鎵句笉鍒?UID ${ref.uid}锛堥€夋嫨鏃舵爣棰橈細${ref.entryNameSnapshot || '鏈褰?}锛夈€俙,
          ref,
        });
        return;
      }
      resolvedEntries.push(entry);
      sections.push(formatSelectedWorldbookEntry(entry));
    });
  }

  const material = sections.join('\n\n');
  return {
    ok: errors.length === 0,
    material,
    characterCount: material.length,
    sources,
    selectedRefCount: uniqueRefs.length,
    resolvedEntries,
    missingRefs,
    errors,
  };
}

// 鈹€鈹€ 璁惧畾閲囬泦鐢熸垚銆佷弗鏍艰В鏋愪笌鑽夌杩藉姞 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// 璁惧畾閲囬泦鐢熸垚娴佺▼锛氭潗鏂欓妫€銆佺嫭绔嬭姹傘€佷弗鏍?JSON 瑙ｆ瀽涓庤崏绋胯拷鍔犮€?

export const CAPTURE_GENERATION_TIMEOUT_MS = LONG_FORM_GENERATION_TIMEOUT_MS;

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
};

export function configureCaptureWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function stripMarkdownFence(text) {
  const raw = String(text || '').trim();
  const matched = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (matched?.[1] || raw).trim();
}

function createParseFailure(rawResponse, jsonText, code, message, details = {}) {
  return {
    ok: false,
    rawResponse: String(rawResponse || ''),
    jsonText: String(jsonText || ''),
    entries: [],
    error: { code, message, details },
  };
}

/** 涓ユ牸鎺ュ彈 JSON锛堝厑璁稿畬鏁?JSON 浠ｇ爜鍥存爮锛夛紝骞跺彧鎶婃ā鍨嬪唴瀹瑰瓧娈典氦缁欒崏绋挎爣鍑嗗寲銆?*/
export function parseCaptureGenerationResponse(rawResponse) {
  const raw = String(rawResponse || '');
  const jsonText = stripMarkdownFence(raw);
  if (!jsonText) {
    return createParseFailure(raw, jsonText, 'empty_response', '妯″瀷娌℃湁杩斿洖浠讳綍鍐呭銆?);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return createParseFailure(
      raw,
      jsonText,
      'invalid_json',
      `璁惧畾閲囬泦缁撴灉涓嶆槸鍚堟硶 JSON锛?{error.message}`,
    );
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) {
    return createParseFailure(raw, jsonText, 'invalid_schema', 'JSON 椤跺眰蹇呴』鏄寘鍚?entries 鏁扮粍鐨勫璞°€?);
  }
  if (parsed.entries.length === 0) {
    return createParseFailure(raw, jsonText, 'empty_entries', '妯″瀷杩斿洖鐨?entries 鏁扮粍涓虹┖銆?);
  }
  const invalidIndex = parsed.entries.findIndex(entry => !isPlainObject(entry));
  if (invalidIndex >= 0) {
    return createParseFailure(
      raw,
      jsonText,
      'invalid_entry',
      `绗?${invalidIndex + 1} 鏉?entries 涓嶆槸鏈夋晥瀵硅薄銆俙,
      { index: invalidIndex },
    );
  }

  const entries = parsed.entries.map(entry => normalizeCaptureDraft({
    type: entry.type,
    title: entry.title,
    mainKeywords: entry.mainKeywords,
    filterKeywords: entry.filterKeywords,
    content: entry.content,
  }));
  return {
    ok: true,
    rawResponse: raw,
    jsonText,
    entries,
    error: null,
  };
}

function createPreflightError(code, message, details = {}) {
  return { code, message, details };
}

/** 鍙暣鐞嗘潗鏂欏拰鏈€缁?messages锛屼笉璋冪敤妯″瀷銆佷笉淇敼鐘舵€併€?*/
export async function prepareCaptureGeneration({
  captureState,
  materialOptions = {},
  macroOverrides = {},
} = {}) {
  const capture = normalizeCaptureState(captureState || getMemoirState().capture);
  const errors = [];
  if (!capture.request.trim()) {
    errors.push(createPreflightError('empty_request', '璇峰厛濉啓瑕侀噰闆嗙殑璁惧畾闇€姹傘€?));
  }
  const sourceResult = buildCaptureSourceMaterial(capture.source, materialOptions);
  if (!sourceResult.ok) errors.push(...sourceResult.errors);
  const optionalResult = await buildCaptureOptionalContextMaterial(
    capture.optionalContext,
    materialOptions,
  );
  if (!optionalResult.ok) errors.push(...optionalResult.errors);

  const settings = getGlobalSettings();
  const messages = errors.length ? [] : buildCapturePromptMessages({
    request: capture.request,
    requestedType: capture.requestedType,
    sourceMaterial: sourceResult.material,
    optionalMaterial: optionalResult.material,
  }, macroOverrides, {
    messages: resolvePromptMessages(PROMPT_IDS.CAPTURE_MESSAGES, settings),
  });
  return {
    ok: errors.length === 0,
    capture,
    sourceResult,
    optionalResult,
    messages,
    promptText: messages.map(message => message.content).join('\n\n'),
    errors,
  };
}

function resolveApiMode(apiMode) {
  if (['main_api', 'secondary_api'].includes(apiMode)) return apiMode;
  return getGlobalSettings().api?.mode === 'main_api' ? 'main_api' : 'secondary_api';
}

async function requestCaptureGeneration(messages, apiMode, transportPlan) {
  const settings = getGlobalSettings();
  const profile = apiMode === 'secondary_api'
    ? getWorkflowOption('getActiveApiProfile')?.(settings)
    : null;
  const timeoutMessage = getLongFormGenerationTimeoutMessage('璁惧畾閲囬泦', apiMode, {
    transportMode: transportPlan.actualMode,
  });
  return apiMode === 'main_api'
    ? generateWithMainApi({
      messages,
      timeoutMs: CAPTURE_GENERATION_TIMEOUT_MS,
      timeoutMessage,
      transportMode: transportPlan.actualMode,
    })
    : generateWithSecondaryApi({
      profile,
      messages,
      timeoutMs: CAPTURE_GENERATION_TIMEOUT_MS,
      timeoutMessage,
      transportMode: transportPlan.actualMode,
    });
}

function createWorkflowError(name, message, details = {}) {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, details);
  return error;
}

function saveCaptureError(message, rawResponse = '') {
  const capture = getMemoirState().capture;
  const raw = String(rawResponse || '').trim();
  capture.lastError = raw ? `${message}\n\n銆愬師濮嬪搷搴斻€慭n${raw}` : message;
  saveChatState();
}

/** 鐢ㄦ埛鏄庣‘瑙﹀彂鍚庤皟鐢ㄦā鍨嬶紱鎴愬姛鍙拷鍔犺崏绋匡紝涓嶅啓涓栫晫涔︺€?*/
export async function runCaptureGeneration({
  captureState,
  materialOptions = {},
  macroOverrides = {},
  apiMode,
  persist = true,
} = {}) {
  const startedAt = formatTimestamp();
  const startedMs = nowMs();
  const resolvedApiMode = resolveApiMode(apiMode);
  let prepared = null;
  let apiResult = null;
  let parseResult = null;
  // Outer-scope plan so failure logs keep requested/actual/fallback after generate throws.
  let transportPlan = null;

  try {
    prepared = await prepareCaptureGeneration({ captureState, materialOptions, macroOverrides });
    if (!prepared.ok) {
      const summary = prepared.errors.map(error => error.message || error.code).filter(Boolean).join('锛?);
      throw createWorkflowError('CapturePreflightError', summary || '璁惧畾閲囬泦鏉愭枡棰勬鏈€氳繃銆?, {
        preflightErrors: prepared.errors,
      });
    }

    const settings = getGlobalSettings();
    const profile = resolvedApiMode === 'secondary_api'
      ? getWorkflowOption('getActiveApiProfile')?.(settings)
      : null;
    transportPlan = resolveConfiguredGenerationTransport({
      backgroundStreamingEnabled: getBackgroundStreamingEnabled(settings),
      apiMode: resolvedApiMode,
      profile,
    });
    notifyBackgroundStreamingFallbackOnce(transportPlan.fallbackReason, message => {
      const toastr = globalThis.toastr || globalThis.parent?.toastr;
      toastr?.warning?.(message, '鍚庡彴娴佸紡');
    });

    apiResult = await requestCaptureGeneration(
      prepared.messages,
      resolvedApiMode,
      transportPlan,
    );
    parseResult = parseCaptureGenerationResponse(apiResult.content);
    if (!parseResult.ok) {
      throw createWorkflowError('CaptureParseError', parseResult.error.message, {
        parseError: parseResult.error,
        rawResponse: parseResult.rawResponse,
      });
    }

    const targetCapture = persist ? getMemoirState().capture : prepared.capture;
    const previousCount = targetCapture.drafts.length;
    targetCapture.drafts = appendCaptureDrafts(targetCapture.drafts, parseResult.entries);
    targetCapture.lastError = '';
    if (persist) saveChatState();
    const addedCount = targetCapture.drafts.length - previousCount;

    getWorkflowOption('addCommunicationLog')?.({
      moduleName: resolvedApiMode === 'main_api' ? '璁惧畾閲囬泦 / 涓?API' : '璁惧畾閲囬泦 / 鍓?API',
      taskType: '璁惧畾閲囬泦鑽夌鐢熸垚',
      status: 'success',
      startedAt,
      durationMs: Math.round(nowMs() - startedMs),
      profileName: apiResult.profileName,
      model: apiResult.model,
      url: apiResult.url,
      httpStatus: apiResult.httpStatus || '',
      messages: prepared.messages,
      requestBody: apiResult.requestBody,
      responseText: apiResult.responseText,
      rawResultContent: parseResult.jsonText,
      parsedResult: parseResult.entries,
      transport: buildGenerationTransportLog(transportPlan, apiResult),
    });

    return {
      ok: true,
      apiMode: resolvedApiMode,
      prepared,
      rawResponse: parseResult.rawResponse,
      parsedEntries: parseResult.entries,
      addedCount,
      drafts: targetCapture.drafts,
    };
  } catch (error) {
    const generationErrorContext = getGenerationErrorContext(error);
    const errorCode = generationErrorContext?.code || '';
    const errorStage = generationErrorContext?.stage || '';
    const diagnostics = generationErrorContext?.diagnostics || null;
    const rawResponse = error.rawResponse || parseResult?.rawResponse || apiResult?.responseText || '';
    if (persist) saveCaptureError(error.message || String(error), rawResponse);
    getWorkflowOption('addCommunicationLog')?.({
      moduleName: resolvedApiMode === 'main_api' ? '璁惧畾閲囬泦 / 涓?API' : '璁惧畾閲囬泦 / 鍓?API',
      taskType: '璁惧畾閲囬泦鑽夌鐢熸垚',
      status: 'failure',
      startedAt,
      durationMs: diagnostics?.durationMs ?? Math.round(nowMs() - startedMs),
      profileName: diagnostics?.profileName
        || apiResult?.profileName
        || (resolvedApiMode === 'main_api' ? '閰掗褰撳墠杩炴帴' : ''),
      model: diagnostics?.model
        || apiResult?.model
        || (resolvedApiMode === 'main_api' ? '閰掗涓?API' : ''),
      url: diagnostics?.url
        || apiResult?.url
        || (resolvedApiMode === 'main_api' ? '閰掗褰撳墠杩炴帴' : ''),
      httpStatus: diagnostics?.httpStatus ?? apiResult?.httpStatus ?? '',
      messages: prepared?.messages || [],
      requestBody: apiResult?.requestBody || {},
      responseText: diagnostics?.responseText || apiResult?.responseText || rawResponse,
      parsedResult: parseResult || null,
      transport: buildGenerationTransportLog(transportPlan, apiResult, diagnostics),
      errorCode,
      errorStage,
      errorStack: error.stack || error.message || error,
    });
    throw error;
  }
}

// 鈹€鈹€ 闃舵 G锛氳瀹氳崏绋挎寮忓啓鍏ヤ笌 captureId 鐙珛璇诲洖 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const CAPTURE_ENTRY_TYPE_LABELS = Object.freeze({
  npc: 'NPC',
  item: 'Item',
  location: 'Location',
  other: 'Other',
});

function buildCaptureEntryPayload(draft) {
  const typeLabel = CAPTURE_ENTRY_TYPE_LABELS[draft.type] || 'Other';
  return {
    name: `SLX-Capture-${typeLabel}-${draft.title}`,
    enabled: true,
    strategy: {
      type: 'selective',
      keys: draft.mainKeywords.length ? draft.mainKeywords : [draft.title],
      keys_secondary: { logic: 'and_any', keys: draft.filterKeywords },
      scan_depth: 'same_as_global',
    },
    position: {
      type: draft.position,
      role: 'system',
      depth: 0,
      order: draft.order,
    },
    content: draft.content,
    probability: 100,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    extra: {
      captureId: draft.captureId,
      captureType: draft.type,
    },
  };
}

/**
 * 灏嗙敤鎴锋槑纭€夋嫨鐨勮瀹氳崏绋垮啓鍏ュ綋鍓嶅洖蹇嗗綍涓栫晫涔︺€? * 鏃犺鏇存柊璋冪敤鏄惁鎶ラ敊锛屽潎浠ョ嫭绔?getWorldbook() 璇诲洖鐨?captureId 涓烘渶缁堜簨瀹烇細
 * 宸茶鍥炶崏绋夸粠鏈湴绉婚櫎锛岀己澶辨垨鏃犳晥鑽夌淇濈暀骞惰繑鍥為€愭潯閿欒锛岄噸璇曞鐢ㄥ師 captureId銆? */
export async function commitCaptureDrafts(
  selectedDrafts,
  {
    confirmUseCurrent,
    api: providedApi = null,
    worldbookName: providedWorldbookName = '',
    persist = true,
  } = {},
) {
  const uniqueDrafts = [...new Map(
    (Array.isArray(selectedDrafts) ? selectedDrafts : [])
      .map(normalizeCaptureDraft)
      .map(draft => [draft.captureId, draft]),
  ).values()];
  if (!uniqueDrafts.length) throw new Error('娌℃湁宸查€夋嫨鐨勮瀹氳崏绋裤€?);

  const invalidFailures = [];
  const validDrafts = uniqueDrafts.filter(draft => {
    const reasons = [];
    if (!draft.title.trim()) reasons.push('鏍囬涓虹┖');
    if (!draft.content.trim()) reasons.push('姝ｆ枃涓虹┖');
    if (!draft.mainKeywords.length && !draft.title.trim()) reasons.push('缂哄皯鍙敤鍏抽敭璇?);
    if (!reasons.length) return true;
    invalidFailures.push({ captureId: draft.captureId, message: reasons.join('锛?) });
    return false;
  });

  if (!validDrafts.length) {
    return {
      ok: false,
      worldbookName: providedWorldbookName,
      requestedCount: uniqueDrafts.length,
      verifiedCount: 0,
      addedCount: 0,
      verifiedIds: [],
      failures: invalidFailures,
      updateError: '',
    };
  }

  const api = providedApi || getWorldbookApi();
  const worldbookName = providedWorldbookName || (
    await ensureMemoirWorldbook({ confirmUseCurrent })
  ).worldbookName;
  const expectedIds = validDrafts.map(draft => draft.captureId);
  const addedIds = new Set();
  let updateError = null;
  let verification = null;

  try {
    verification = await updateWorldbookWithVerification(worldbookName, (book) => {
      const list = Array.isArray(book) ? book : [];
      const existingIds = new Set(
        list.map(entry => String(entry?.extra?.captureId || '')).filter(Boolean),
      );
      validDrafts.forEach(draft => {
        if (existingIds.has(draft.captureId)) return;
        list.push(buildCaptureEntryPayload(draft));
        existingIds.add(draft.captureId);
        addedIds.add(draft.captureId);
      });
      return list;
    }, {
      api,
      idField: 'captureId',
      expectedIds,
      typeField: 'captureType',
    });
  } catch (error) {
    updateError = error;
    // updateWorldbookWith 鍙兘鍦ㄩ儴鍒嗘寔涔呭寲鍚庢墠鎶涢敊锛涘繀椤诲啀璇讳竴娆★紝涓嶈兘鍑紓甯稿垽鏁存壒澶辫触銆?    verification = await verifyWorldbookEntries(worldbookName, {
      api,
      idField: 'captureId',
      expectedIds,
      typeField: 'captureType',
    });
  }

  const verifiedIds = verification.verifiedEntries
    .map(entry => String(entry?.extra?.captureId || ''))
    .filter(Boolean);
  const missingFailures = verification.missingIds.map(captureId => ({
    captureId,
    message: updateError
      ? `鍐欏叆璋冪敤寮傚父涓旇鍥炴湭鎵惧埌锛?{updateError.message || String(updateError)}`
      : '鍐欏叆鍚庣嫭绔嬭鍥炴湭鎵惧埌璇?captureId锛屽彲瀹夊叏閲嶈瘯銆?,
  }));
  const failures = [...invalidFailures, ...missingFailures];

  if (persist && verifiedIds.length) {
    const capture = getMemoirState().capture;
    const verifiedSet = new Set(verifiedIds);
    capture.drafts = capture.drafts.filter(draft => !verifiedSet.has(draft.captureId));
    saveChatState();
  }

  return {
    ok: failures.length === 0,
    worldbookName,
    requestedCount: uniqueDrafts.length,
    verifiedCount: verifiedIds.length,
    addedCount: [...addedIds].filter(id => verifiedIds.includes(id)).length,
    verifiedIds,
    verifiedEntries: verification.verifiedEntries,
    failures,
    updateError: updateError?.message || '',
  };
}
