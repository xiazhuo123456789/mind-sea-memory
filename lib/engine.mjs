/* ============================================================
 * engine.mjs —— 检索引擎：五路打分 + 图扩散 + 钉住激活 + 意图重排 + 去重
 *
 * 打分权重沿用 memory-brain 实测结论（中文短 query 下关键词比语义可靠）：
 *   score = 0.18*语义 + 0.46*关键词 + 0.14*重要性 + 0.11*新鲜度 + 0.11*图谱
 *
 * 在它基础上修的四个洞：
 *   ① 停用词 + IDF 加权      → "最近/怎么样"不再压过"团子"
 *   ② owner 归属过滤          → 群里绝不召回别人私聊的记忆
 *   ③ visibility 场合过滤     → 群聊场合召不回 private
 *   ④ 分数门槛 minScore       → 低分记忆不进 prompt
 * ============================================================ */
'use strict';

import * as store from './store.mjs';

/* ---------------- 权重与常量 ---------------- */
export const W = { semantic: 0.18, keyword: 0.46, importance: 0.14, recency: 0.11, graph: 0.11 };
const RECENCY_HALF_LIFE_DAYS = 14;
const DEDUP_SIMILARITY = 0.82;
const KIND_BOOST = 0.05;
const PIN_SCORE = 0.9;

const INTENT_HINTS = {
  fact: ['规则', '喜欢', '讨厌', '习惯', '叫什么', '生日', '不能', '永远', '是不是', '会不会', '住哪', '在哪'],
  episode: ['那天', '上次', '当时', '记得', '之前', '昨天', '今天', '说好', '答应', '后来', '约好'],
};

const STOPWORDS = new Set(('的 了 吗 呢 吧 啊 呀 哦 嗯 唉 哈 呗 嘛 么 什么 怎么样 怎么 如何 是不是 会不会 ' +
  '最近 现在 今天 昨天 前天 刚才 刚刚 那个 这 这个 这些 那些 事情 东西 时候 地方 还是 还有 就是 因为 所以 ' +
  '一个 一种 一下 一直 一起 一样 我们 你们 他们 她们 自己 大家 我 你 他 她 它 说 说话 问 回答 知道 不知道 ' +
  '记得 不记得 想起 想起来 忘 忘了 记住 请 帮 帮忙 可以 能 不能 有没有 是 在 的了 呀啦 咯 咧 啦').split(/\s+/));

/* ---------------- 文本处理 ---------------- */
export function bigrams(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  for (const w of s.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(w)) { out.add(w); continue; }
    out.add(w);
    /* CJK 同时索引单字 + 二元组：单字解决"猫"在"橘猫"词尾被二元组边界漏掉的
       跨界问题；高频字（的/了）由 IDF 自动压低，稀有字（猫/团）成为强信号 */
    for (const ch of w) out.add(ch);
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/** 查询清洗：去标点/停用词/虚词，只留实词。清洗过短则退回原句分词 */
export function cleanQuery(text) {
  let s = String(text || '')
    .replace(/[?？!！。，,、；;：:"'“”‘’（）()\[\]{}<>《》…·—~～]+/g, ' ')
    .replace(/^(你|您|她|他|它|帮我|请|请问|我想|想知道|还记得|记得|问问|查查)+/g, ' ')
    .replace(/(你还?记得|记得|怎么样|如何|什么|啥|哪|谁|多少|为什么|为啥|了吗|了吗|呢|吗)+/g, ' ');
  const tokens = s.split(/\s+/).flatMap((w) => {
    if (!w) return [];
    if (/^[a-z0-9]+$/i.test(w)) return [w.toLowerCase()];
    const pieces = [];
    for (let i = 0; i < w.length - 1; i++) pieces.push(w.slice(i, i + 2));
    for (const ch of w) pieces.push(ch);      // 单字：跨词边界的字（猫/团）也要能命中
    if (pieces.length === 0) pieces.push(w);
    return pieces;
  }).filter((t) => t && !STOPWORDS.has(t));
  const uniq = [...new Set(tokens)];
  return uniq.length >= 1 ? uniq : bigrams(String(text || ''));
}

function similarity(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.min(ga.size, gb.size);
}

/* ---------------- 归属与场合过滤 ---------------- */
/** 返回该记忆在当前场合是否可见。隐私优先：拿不准就不给。 */
export function visibleIn(mem, { channel, group, owner, asOf }) {
  /* P1 双时间线：asOf 提供时进入历史视图——
     该时点已存在、且此后未被取代/归档的记忆都可见（含现在已 superseded 的） */
  if (asOf) {
    if (mem.created_at > asOf) return false;
    if (mem.superseded_at && mem.superseded_at <= asOf) return false;
    if (mem.status === 'archived' && mem.archived_at && mem.archived_at <= asOf) return false;
  } else if (mem.status !== 'active') {
    return false;
  }
  /* 事实有效期：valid_until 已过的记忆在"当前"视图不可见（历史视图 asOf 早于它则可见） */
  if (!asOf && mem.valid_until && mem.valid_until <= Date.now()) return false;
  const o = mem.owner || 'global';
  if (channel === 'group') {
    // 群聊：本群的事 + 全局 + 明确标记 public 的（他人私聊的话默认 private，不会漏出去）
    if (o === 'g:' + group) return true;
    if (o === 'global') return true;
    return mem.visibility === 'public';
  }
  // 私聊（owner = u:qq:xxx）：本人的 + 全局 + 本人所在群的话（可选，默认关）
  if (o === 'global') return true;
  if (o === 'u:' + owner) return true;
  return false;
}

/* 判断"去掉时间词后是否只剩虚词"——直接判字符，不走 cleanQuery
   （cleanQuery 在空结果时会回退 bigrams，会把纯时间查询误判成有实词） */
const TIME_FILLER_RE = /(说了什么|说了啥|聊了什么|聊了啥|发生了什么|干了什么|做了什么|有什么事|有什么|有啥|什么事情|事情|又说|说|聊|干|做|发生|什么|啥|些|都|我|你|他|她|它|我们|你们|他们|的|了|吗|呢|啊|呀|嗯|和|跟|吃|喝|玩|看|听|去|来|逛|买|学|见|遇到)/g;
function isTimeOnlyQuery(query, matched) {
  let r = String(query || '').replace(matched, ' ');
  r = r.replace(/[?？!！。，,、；;：:"'“”‘’（）()\[\]{}<>《》…·—~～\s]+/g, '');
  r = r.replace(TIME_FILLER_RE, '');
  return r.length === 0;
}

/* 纯时间查询：该窗口内的记忆 + 原始对话，按时间倒序，不做语义排序 */
function timeWindowRecall(tw, { owner = '', group = '', channel = 'private', k = 5, coreK = 3, now = Date.now() }) {
  const out = [];
  const s = store.load();
  const limit = k + coreK;
  const mems = s.memories
    .filter((m) => visibleIn(m, { channel, group, owner, asOf: null }))
    .filter((m) => m.created_at >= tw.start && m.created_at <= tw.end)
    .sort((a, b) => b.created_at - a.created_at);
  for (const m of mems) {
    if (out.length >= limit) break;
    out.push({
      id: m.id, owner: m.owner, text: m.text, kind: m.kind,
      importance: +Number(m.importance).toFixed(3), score: 0.5,
      confidence: m.confidence ?? 0.6, errors: m.errors || 0,
      created_at: m.created_at, visibility: m.visibility, pin: m.pin,
      channel: isCoreMem(m) ? 'core' : 'event', byTime: true,
    });
  }
  /* 原始消息：问"昨天说了什么"时原话比提炼后的记忆更接近答案 */
  if (out.length < limit) {
    const eps = store.readEpisodes(tw.start)
      .filter((r) => r.at <= tw.end)
      .filter((r) => (channel === 'group'
        ? r.channel === 'group' && String(r.group || '') === String(group || '')
        : r.channel === 'private' && String(r.user || '') === String(owner || '')))
      .sort((a, b) => b.at - a.at);
    for (const r of eps) {
      if (out.length >= limit) break;
      out.push({
        id: r.id || ('ep' + r.at),
        owner: channel === 'group' ? 'g:' + group : 'u:' + owner,
        text: r.text, kind: 'episode', importance: 0.3, score: 0.4,
        confidence: 0.9, errors: 0, created_at: r.at,
        visibility: channel === 'group' ? 'group' : 'private',
        pin: false, channel: 'event', byTime: true, raw: true,
      });
    }
  }
  out.channels = { core: [], event: [] };
  for (const r of out) out.channels[r.channel].push(r.id);
  out.rejected = [];
  out.rules = store.listRules().slice(0, 10);
  out.timeWindow = { label: tw.label, start: tw.start, end: tw.end };
  /* 时间检索只算轻量访问（不重置新近度，防"翻旧账把旧记忆续命"） */
  const memIds = out.filter((r) => !r.raw).map((r) => r.id);
  if (memIds.length) store.touch(memIds, now, 'light');
  return out;
}

/* ---------------- 主检索 ---------------- *//**
 * recall(query, opts)
 *   opts.owner  'qq:10001'        当前说话人
 *   opts.group  '888'             当前群号（群聊时）
 *   opts.channel 'group'|'private'
 *   opts.k       默认 5
 *   opts.minScore 默认 0.35
 *   opts.embed   可选 (text)=>Promise<Float32Array|number[]>
 *   opts.explain 返回打分明细
 */
const CORE_KINDS = new Set(['fact', 'preference', 'digest']);
function isCoreMem(m) { return !!m.pin || CORE_KINDS.has(m.kind); }

/* ---------------- P0-3 时间窗口召回（借 memory-brain 思路，原创重写） ----------------
 * 中文时间词 → 绝对时间范围。命中且查询里没有其他实词时，直接按时间取原话，
 * 不依赖语义碰运气（"昨天说了什么"从此有确定答案）。 */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function parseTimeWindow(query, now = Date.now()) {
  const q = String(query || '');
  const DAY = 86400000;
  const today = startOfDay(now);
  const table = [
    { re: /(前天)/, start: today - 2 * DAY, end: today - DAY, label: '前天' },
    { re: /(昨天|昨晚|昨日)/, start: today - DAY, end: today, label: '昨天' },
    { re: /(今天早上|今早|今天上午)/, start: today, end: now, label: '今天上午' },
    { re: /(今天中午)/, start: today + 11 * 3600e3, end: now, label: '今天中午' },
    { re: /(今天下午)/, start: today + 13 * 3600e3, end: now, label: '今天下午' },
    { re: /(今天晚上|今晚)/, start: today + 18 * 3600e3, end: now, label: '今天晚上' },
    { re: /(刚才|刚刚)/, start: now - 30 * 60e3, end: now, label: '刚才' },
    { re: /(今天)/, start: today, end: now, label: '今天' },
    { re: /(上周|上个星期)/, start: today - 7 * DAY, end: today, label: '上周' },
    { re: /(上个月|上月)/, start: now - 30 * DAY, end: now, label: '上个月' },
    { re: /(最近三天|这三天)/, start: now - 3 * DAY, end: now, label: '最近三天' },
    { re: /(最近一周|这周|本周)/, start: now - 7 * DAY, end: now, label: '最近一周' },
  ];
  for (const t of table) {
    const m = q.match(t.re);
    if (m) return { start: t.start, end: t.end, label: t.label, matched: m[1] };
  }
  return null;
}

export async function recall(query, opts = {}) {
  const {
    owner = '', group = '', channel = 'private',
    k = 5, coreK = 3, minScore = 0.35, embed = null, explain = false, moodValence = null,
    asOf = null,
    /* 续命来源（借 ldo1um，防自污染）：full=用户亲口再说；light=模型检索（默认）；none=纯只读 */
    reinforce = 'light',
  } = opts;
  const now = asOf || Date.now();
  const q = String(query || '').trim();
  if (!q) { const e = []; e.channels = { core: [], event: [] }; e.rejected = []; return e; }

  const qTokens = cleanQuery(q);
  const qSet = new Set(qTokens);
  if (!qSet.size) { const e = []; e.channels = { core: [], event: [] }; e.rejected = []; return e; }

  /* P0-3 时间窗口：命中时间词且没有其他实词 → 直接按时间取原话；有实词则把候选限制进窗口 */
  const tw = asOf ? null : parseTimeWindow(q, now);
  const timeOnly = tw ? isTimeOnlyQuery(q, tw.matched) : false;
  if (tw && timeOnly) return timeWindowRecall(tw, { owner, group, channel, k, coreK, now });

  const s = store.load();
  let active = s.memories.filter((m) => visibleIn(m, { channel, group, owner, asOf }));
  if (tw) active = active.filter((m) => m.created_at >= tw.start && m.created_at <= tw.end);

  /* 关键词路：IDF 加权的 token 重合度 */
  const N = Math.max(1, active.length);
  const df = new Map();
  const tokenSets = new Map();
  for (const m of active) {
    const ts = new Set([...bigrams(m.text), ...m.entities.map((e) => e.toLowerCase())]);
    tokenSets.set(m.id, ts);
    for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const totalIdf = qTokens.reduce((a, t) => a + idf(t), 0) || 1;

  /* 语义路：可选 */
  let qVec = null;
  if (embed) { try { qVec = await embed(q); } catch { qVec = null; } }
  const cos = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };

  /* 意图判定：问事实还是问往事 */
  let bestKind = '', bestHits = 0;
  for (const [kind, hints] of Object.entries(INTENT_HINTS)) {
    const n = hints.filter((h) => q.includes(h)).length;
    if (n > bestHits) { bestKind = kind; bestHits = n; }
  }

  const rows = [];
  const seedEntities = new Set();
  const firstPass = [];
  for (const m of active) {
    const ts = tokenSets.get(m.id);
    let hitIdf = 0;
    for (const t of qTokens) if (ts.has(t)) hitIdf += idf(t);
    const sKw = hitIdf / totalIdf;
    const sImp = m.importance;
    const days = Math.max(0, (now - (m.last_hit || m.created_at)) / 86400000);
    const sRec = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
    let sSem = 0;
    if (qVec) sSem = Math.max(0, cos(qVec, m.vector));

    const base = W.keyword * sKw + W.importance * sImp + W.recency * sRec + W.semantic * sSem;
    firstPass.push({ m, sKw, sSem, sImp, sRec, base });
  }

  /* 图谱扩散（P2-1 两步近似 PPR）：hop1 = 关键词 Top5 的实体共现；
     hop2 = hop1 候选的实体再扩散一轮（分数减半），实现"单步调用多跳联想" */
  firstPass.sort((a, b) => b.base - a.base);
  const seeds = firstPass.slice(0, 5);
  for (const { m } of seeds) for (const e of m.entities) seedEntities.add(e);
  const inSeeds = new Set(seeds.map(({ m }) => m.id));
  for (const m of active) {
    if (inSeeds.has(m.id)) continue;
    const shared = m.entities.filter((e) => seedEntities.has(e)).length;
    if (shared > 0) firstPass.push({ m, sKw: 0, sSem: 0, sImp: m.importance, sRec: 0, graphOnly: true, shared, hop: 1 });
  }
  /* hop2：用 hop1 候选的实体继续扩散（上限 60 条，防爆炸） */
  const hop1 = firstPass.filter((r) => r.hop === 1).slice(0, 40);
  const seed2 = new Set();
  for (const { m } of hop1) for (const e of m.entities) if (!seedEntities.has(e)) seed2.add(e);
  if (seed2.size) {
    let added2 = 0;
    for (const m of active) {
      if (inSeeds.has(m.id) || firstPass.some((r) => r.m.id === m.id)) continue;
      const shared = m.entities.filter((e) => seed2.has(e)).length;
      if (shared > 0) {
        firstPass.push({ m, sKw: 0, sSem: 0, sImp: m.importance, sRec: 0, graphOnly: true, shared, hop: 2 });
        if (++added2 >= 60) break;
      }
    }
  }

  /* 汇总打分 */
  const memEntityCache = new Map();
  for (const row of firstPass) {
    const m = row.m;
    if (!memEntityCache.has(m.id)) memEntityCache.set(m.id, new Set(m.entities));
    const shared = [...memEntityCache.get(m.id)].filter((e) => seedEntities.has(e)).length;
    let sGraph = Math.min(1, shared / 3);
    if (row.hop === 2) sGraph *= 0.5;   // 二跳扩散衰减

    let sImp = row.sImp;
    /* 情绪一致：心情差时略微偏负向记忆（权重很小） */
    if (moodValence != null) {
      const mv = Math.max(-1, Math.min(1, moodValence));
      if ((mv < -0.15 && m.valence < -0.1) || (mv > 0.15 && m.valence > 0.1)) sImp = Math.min(1, sImp + 0.03);
    }

    let score = W.keyword * row.sKw + W.semantic * row.sSem + W.importance * sImp
      + W.recency * row.sRec + W.graph * sGraph;

    /* 钉住 + 事实键激活：pin 与带 fact_key 的记忆——
       fact_key 的属性部分（"qq:10001.城市"里的"城市"）就是这条记忆的语义索引，
       查询命中属性词即视为相关（解决"哪个城市"查不到"我住在杭州"的问题）。
       注意只对 fact_key 记忆用键名判定——否则"上次"的单字"上"会误命中"上海" */
    if (m.pin || m.fact_key) {
      let relevant;
      if (m.fact_key) {
        const attr = m.fact_key.includes('.') ? m.fact_key.split('.').pop() : m.fact_key;
        const keyTokens = new Set([...bigrams(attr), ...attr]);
        relevant = qTokens.some((t) => keyTokens.has(t)) || row.sKw >= 0.3;
      } else {
        const pinTokens = new Set([...bigrams(m.text), ...m.entities.map((e) => e.toLowerCase())]);
        relevant = qTokens.some((t) => pinTokens.has(t)) || row.sKw >= 0.3;
      }
      if (relevant) score = Math.max(score, PIN_SCORE);
      else if (m.pin) score += 0.1;   // 没问对也给钉住一点保底
    }

    /* 意图重排 */
    if (bestHits && m.kind === bestKind) score += KIND_BOOST;

    /* 纠错降权（借 ldo1um）：被用户纠正过的记忆强制降权，错得越多压得越狠（上限3次） */
    if (m.errors) score *= Math.pow(0.6, Math.min(m.errors, 3));

    if (score <= 0) continue;
    const item = {
      id: m.id, owner: m.owner, text: m.text, kind: m.kind,
      importance: +sImp.toFixed(3), score: +score.toFixed(4),
      confidence: m.confidence ?? 0.6,          // P1-6 置信度随行，blockOf 用它标注"未证实"
      errors: m.errors || 0,                    // 纠错计数随行，blockOf 用它标注"已纠错"
      created_at: m.created_at, visibility: m.visibility, pin: m.pin,
      channel: isCoreMem(m) ? 'core' : 'event',
    };
    if (explain) {
      item.why = {
        keyword: +row.sKw.toFixed(3), semantic: +row.sSem.toFixed(3),
        importance: +sImp.toFixed(3), recency: +row.sRec.toFixed(3),
        graph: +sGraph.toFixed(3), graphOnly: !!row.graphOnly,
        intent: bestKind || null,
      };
    }
    rows.push(item);
  }

  rows.sort((a, b) => b.score - a.score);

  /* v3 双通道 + 落选原因：核心事实（pin / fact / preference / digest）走 coreK 预算，
     事件类走 k 预算，两条通道互不挤占；落选者按去重 / 超预算 / 低于门槛记录原因。
     注意顺序：先判去重与预算，再判门槛——低于门槛的条目不占预算。 */
  const picked = [];
  const rejected = [];
  const channels = { core: [], event: [] };
  const coreMemById = new Map();
  for (const m of active) coreMemById.set(m.id, m);
  for (const r of rows) {
    const mem = coreMemById.get(r.id);
    const ch = mem && isCoreMem(mem) ? 'core' : 'event';
    r.channel = ch;
    if (picked.some((p) => similarity(p.text, r.text) >= DEDUP_SIMILARITY)) {
      if (rejected.length < 20) rejected.push({ id: r.id, text: r.text, score: r.score, channel: ch, reason: 'dedup' });
      continue;
    }
    const budget = ch === 'core' ? coreK : k;
    if (channels[ch].length >= budget) {
      if (rejected.length < 20) rejected.push({ id: r.id, text: r.text, score: r.score, channel: ch, reason: 'over_budget_k' });
      continue;
    }
    if (r.score < minScore) {
      if (rejected.length < 20) rejected.push({ id: r.id, text: r.text, score: r.score, channel: ch, reason: 'below_minScore' });
      continue;
    }
    picked.push(r);
    channels[ch].push(r.id);
  }
  const out = picked;
  out.channels = channels;
  out.rejected = rejected;
  /* 手写永久规则（借 ldo1um L4）：不经打分，随召回整体注入，blockOf 置顶输出 */
  out.rules = store.listRules().slice(0, 10);

  /* 被想起 = 续命。v3.2 区分来源防自污染：
     full=用户亲口再说（重置新近度）；light=模型检索（只计数）；none=纯只读 */
  if (out.length && reinforce !== 'none') store.touch(out.map((r) => r.id), now, reinforce);
  // nightly 审计在 engine.nightly 末尾做；这里不审计每轮召回（避免 audit 日志爆炸）。
  return out;
}

/* ---------------- 遗忘治理 ---------------- */
/**
 * nightly 一趟：
 *   1. 衰减：importance *= rate（pin 豁免）
 *      + 频率感知：30 天内被想起越多，衰减越慢（最高打 5 折）
 *      + 干扰加速 / 情绪巩固
 *   2. 归档：importance < 0.15；或 30 天未想起且 importance < 0.3；
 *      **归档保护期：archiveProtectDays 内被想起过且 importance ≥ 0.05 的不归档**
 *   3. 合并：相似度 ≥ 0.92 且同 owner → 并入较新的一条
 *   4. 清除：归档超 purgeDays 天（purgeDays<=0 = 永不物理删除）
 *   5. 按类上限：kindCaps 超出时归档最不重要最旧的
 *   6. 核心人物地板：protectNames 命中的实体相关记忆不低于 floor
 *   7. 规则自动冲突检测：共享实体 + 相似度高 + 反义词对 → 进待裁决队列（不自动改）
 *   8. 违规巡查：只报告不代改
 */
export function nightly(opts = {}) {
  const {
    rate = 0.995, now = Date.now(),
    purgeDays = 180, staleConflictDays = 7, staleIntentDays = 3,
    /* P0-1（借 memory-brain）*/
    freqWindowDays = 30, freqMaxDiscount = 0.5, freqPerHit = 0.05,
    archiveProtectDays = 30,
    protectNames = [], protectFloor = 0.45,
    kindCaps = {},
    /* 规则自动冲突检测 */
    autoConflict = true, autoConflictSim = 0.5,
  } = opts;
  const s = store.load();
  const DAY = 86400000;
  let archived = 0, merged = 0, purged = 0, decayed = 0, floorLifted = 0, capped = 0;
  const protect = new Set((protectNames || []).map((n) => String(n).toLowerCase()).filter(Boolean));

  const active = s.memories.filter((m) => m.status === 'active');
  for (const m of active) {
    if (m.pin || m.kind === 'insight' || m.kind === 'digest') continue;   // 洞察/元记忆永不衰减
    /* P2-2 干扰衰减（MSR 2026）：同一实体下更新的记忆会加速旧记忆淡忘。
       语义：加快"衰减量"而非放大乘数——r2 = 1 - 1.6×(1-rate)，仍 <1（修复 v1.0 的
       rate×1.6>1 导致重要度越衰减越膨胀的乘法方向 bug） */
    let r2 = rate;
    const newerSameEntity = s.memories.some((o) =>
      o.id !== m.id && o.status === 'active' && !o.pin &&
      o.created_at > m.created_at && (o.entities || []).some((e) => (m.entities || []).includes(e)));
    if (newerSameEntity) r2 = 1 - 1.6 * (1 - rate);
    /* P0-1 频率感知（借 memory-brain）：30 天内被想起越多，衰减量越小（最高减半）。
       数据来自 touch() 维护的 hit_ts 滚动窗口——常被想起的忘得更慢 */
    const freq = (m.hit_ts || []).filter((t) => now - t <= freqWindowDays * DAY).length;
    if (freq > 0) {
      const discount = Math.min(freqMaxDiscount, freq * freqPerHit);
      r2 = 1 - (1 - r2) * (1 - discount);
    }
    /* 情绪巩固（借氪"情绪残留"六变量 + MSR 2026）：情绪印记深（|valence| 或 arousal 高）
       的记忆衰减量减半缓释——情绪浓的记更牢，即使被干扰也只被部分加速 */
    const emo = Math.max(Math.abs(m.valence || 0), (m.arousal || 0) * 0.8);
    if (emo > 0.3) r2 = 1 - (1 - r2) * (1 - 0.5 * Math.min(1, (emo - 0.3) / 0.7));
    m.importance = +Math.min(1, Math.max(0.02, m.importance * r2)).toFixed(4);
    decayed++;
    /* 核心人物地板（借 memory-brain protect_names）：重要的人相关记忆不会被衰减掉 */
    if (protect.size && (m.entities || []).some((e) => protect.has(String(e).toLowerCase()))) {
      if (m.importance < protectFloor) { m.importance = protectFloor; floorLifted++; }
    }
  }

  for (const m of active) {
    if (m.pin || m.source === 'digest') continue;
    if (m.kind === 'insight' || m.kind === 'digest') continue;
    const lastAccess = Math.max(m.last_hit || 0, ...(m.hit_ts || []).slice(-1), m.created_at || 0);
    const recentlyHit = now - lastAccess < archiveProtectDays * DAY;
    /* 归档保护期：最近被想起过且不是彻底垃圾的，先不归档（借 memory-brain） */
    if (recentlyHit && m.importance >= 0.05) continue;
    const idleDays = (now - (m.last_hit || m.created_at)) / DAY;
    const shouldArchive = m.importance < 0.15 || (idleDays > 30 && m.importance < 0.3);
    if (shouldArchive) { m.status = 'archived'; m.archived_at = now; s.stats.archived += 1; archived++; }
  }

  /* 合并：同 owner、相似度超阈值 → 并入较新的 */
  const active2 = s.memories.filter((m) => m.status === 'active');
  const dropped = new Set();
  for (let i = 0; i < active2.length; i++) {
    const a = active2[i];
    if (dropped.has(a.id) || a.pin) continue;
    for (let j = i + 1; j < active2.length; j++) {
      const b = active2[j];
      if (dropped.has(b.id) || b.pin || b.owner !== a.owner) continue;
      if (similarity(a.text, b.text) >= 0.92) {
        const [keep, drop] = a.created_at >= b.created_at ? [a, b] : [b, a];
        keep.importance = Math.max(keep.importance, drop.importance);
        keep.hits += drop.hits;
        keep.entities = [...new Set([...keep.entities, ...drop.entities])].slice(0, 12);
        drop.status = 'archived'; drop.archived_at = now;
        dropped.add(drop.id);
        merged++;
      }
    }
  }

  /* 按类上限（借 memory-brain trim_kind）：某类超限时归档最不重要最旧的 */
  for (const [kind, cap] of Object.entries(kindCaps || {})) {
    const n = Number(cap);
    if (!Number.isFinite(n) || n <= 0) continue;
    const list = s.memories.filter((m) => m.status === 'active' && m.kind === kind && !m.pin);
    if (list.length <= n) continue;
    list.sort((a, b) => a.importance - b.importance || a.created_at - b.created_at);
    for (const m of list.slice(0, list.length - n)) {
      m.status = 'archived'; m.archived_at = now; s.stats.archived += 1; capped++;
    }
  }

  /* 清除：归档超 purgeDays 天（purgeDays<=0 = 永不物理删除）。
     保护：仍被"待裁决冲突"引用的记忆不物理删除，否则冲突队列会悬空 */
  if (purgeDays > 0) {
    const referenced = new Set();
    for (const c of s.conflicts || []) {
      if (c.status === 'pending') { referenced.add(c.old_id); referenced.add(c.new_id); }
    }
    const before = s.memories.length;
    s.memories = s.memories.filter((m) => !(m.status === 'archived' && m.archived_at
      && now - m.archived_at > purgeDays * DAY && !referenced.has(m.id)));
    purged = before - s.memories.length;
    s.stats.purged += purged;
  }

  /* 规则自动冲突检测（借 memory-brain conflict.py 思路，原创重写）：
     同 owner + 共享实体 + 文本相似度达标 + 反义词对一正一反 → 进待裁决队列。
     绝不自动 supersede；已有 pending/已裁决的同一对不重复入队。 */
  let autoConflicts = 0;
  if (autoConflict) autoConflicts = detectAutoConflicts(s, { now, minSim: autoConflictSim });

  /* 违规巡查：只报告、不代改（审计层只读原则）。结果持久化到 state，/health 与记忆体检透出 */
  const violations = [];
  for (const c of s.conflicts || []) {
    if (c.status === 'pending' && now - c.created_at > staleConflictDays * DAY) {
      violations.push({ type: 'conflict_stale', id: c.id, fact_key: c.fact_key || '',
        days: Math.floor((now - c.created_at) / DAY),
        hint: `事实冲突待裁决已搁置 ${Math.floor((now - c.created_at) / DAY)} 天，请到面板记忆体检处理` });
    }
  }
  for (const t of s.intents || []) {
    if (t.status !== 'resolved' && t.due_at != null && now - t.due_at > staleIntentDays * DAY) {
      violations.push({ type: 'intent_overdue', id: t.id, text: (t.text || '').slice(0, 40),
        days: Math.floor((now - t.due_at) / DAY),
        hint: `承诺逾期未处理 ${Math.floor((now - t.due_at) / DAY)} 天` });
    }
  }
  const activeCount = s.memories.filter((m) => m.status === 'active').length;
  if (activeCount > 20000) {
    violations.push({ type: 'capacity', count: activeCount,
      hint: '活跃记忆超过 2 万条：建议配置 Ollama 语义向量，或调低归档阈值加大整理力度' });
  }
  s.lastViolations = violations;
  s.lastNightlyAt = now;
  s.stats.merged += merged;
  s.stats.forgotten += archived;

  store.save(true);
  store.audit('nightly', { decayed, archived, merged, purged, capped, floorLifted, autoConflicts, violations: violations.length });
  return {
    decayed, archived, merged, purged, capped, floorLifted, autoConflicts, violations,
    active: s.memories.filter((m) => m.status === 'active').length,
  };
}

/* ---------------- P0-2 规则自动冲突检测（借 memory-brain，原创重写） ---------------- */
/* 反义词对：只收"同一属性上互斥"的常见组合，宁缺勿滥——QQ 口语里过度匹配比漏报更烦 */
const ANTONYMS = [
  ['喜欢', '讨厌'], ['爱', '恨'], ['爱吃', '不吃'], ['爱吃', '讨厌'],
  ['会', '不会'], ['能', '不能'], ['是', '不是'], ['有', '没有'],
  ['同意', '不同意'], ['接受', '不接受'], ['习惯', '不习惯'],
  ['想', '不想'], ['要', '不要'], ['去', '不去'], ['在', '不在'],
  ['吃', '不吃'], ['喝', '不喝'], ['抽烟', '戒烟'], ['单身', '已婚'],
  ['住在', '搬到'], ['上班', '辞职'], ['在读', '毕业'],
];

export function detectAutoConflicts(state, { now = Date.now(), minSim = 0.5, maxNew = 20 } = {}) {
  const facts = (state.memories || []).filter((m) => m.status === 'active' && m.kind === 'fact' && !m.pin);
  const pending = new Set();
  for (const c of state.conflicts || []) {
    if (c.status !== 'pending') continue;
    pending.add(c.old_id + '|' + c.new_id);
    pending.add(c.new_id + '|' + c.old_id);
  }
  /* 按 owner + 实体分桶，避免全量 O(n²) */
  const buckets = new Map();
  for (const m of facts) {
    for (const e of m.entities || []) {
      const key = m.owner + '||' + String(e).toLowerCase();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(m);
    }
  }
  let added = 0;
  const seen = new Set();
  for (const list of buckets.values()) {
    if (added >= maxNew) break;
    if (list.length < 2 || list.length > 60) continue;   // 超热实体跳过，防爆炸
    for (let i = 0; i < list.length && added < maxNew; i++) {
      for (let j = i + 1; j < list.length && added < maxNew; j++) {
        const a = list[i], b = list[j];
        if (a.owner !== b.owner) continue;
        const pairKey = [a.id, b.id].sort().join('|');
        if (seen.has(pairKey) || pending.has(a.id + '|' + b.id)) continue;
        seen.add(pairKey);
        const sim = similarity(a.text, b.text);
        if (sim < minSim) continue;
        let hit = null;
        for (const [x, y] of ANTONYMS) {
          if ((a.text.includes(x) && b.text.includes(y)) || (a.text.includes(y) && b.text.includes(x))) { hit = [x, y]; break; }
        }
        if (!hit) continue;
        const c = {
          id: 'c' + String(state.seq = (state.seq || 0) + 1).padStart(6, '0'),
          owner: a.owner, fact_key: '',
          old_id: a.created_at <= b.created_at ? a.id : b.id,
          new_id: a.created_at <= b.created_at ? b.id : a.id,
          status: 'pending', by: 'auto', reason: `反义词对「${hit[0]}/${hit[1]}」+ 相似度 ${sim.toFixed(2)}`,
          created_at: now,
        };
        state.conflicts.push(c);
        added++;
      }
    }
  }
  if (added) store.audit('conflict_auto_detected', { count: added });
  return added;
}

/* ---------------- P0-4 开机包（借 persistent-self 分层思想，原创重写） ----------------
 * 新会话第一条注入用：按"多快会变"分层，整包有预算上限。
 * 身份层与永久规则是 hard（绝不裁剪）；其余超预算时按顺序丢。
 * 解决"换个窗口就像陌生人"——但绝不做成"全量记忆拼 system"。 */
export function bootPackage({ owner = '', group = '', channel = 'private', maxChars = 3000, now = Date.now() } = {}) {
  const s = store.load();
  const active = s.memories.filter((m) => m.status === 'active' && visibleIn(m, { channel, group, owner, asOf: null }));
  const pick = (kind, n, mode = 'importance') => active.filter((m) => m.kind === kind)
    .sort(mode === 'recent'
      ? (a, b) => b.created_at - a.created_at
      : (a, b) => b.importance - a.importance)
    .slice(0, n);
  const day = (ts) => new Date(ts).toISOString().slice(0, 10);

  const blocks = [];
  const add = (key, name, hard, lines) => {
    const ls = lines.filter(Boolean);
    if (!ls.length) return;
    const text = ls.join('\n');
    blocks.push({ key, name, hard, text, chars: text.length, count: ls.length });
  };
  add('rules', '永久规则（最高优先，必须遵守）', true, store.listRules().map((r) => '- ' + r));
  add('identity', '身份层（永不衰减）', true, active.filter((m) => m.pin).slice(0, 8).map((m) => `- ${m.text}`));
  add('standards', '标准层（相处洞察）', false, pick('insight', 5).map((m) => `- ${m.text}`));
  add('skills', '技术层（做法）', false, pick('skill', 5).map((m) => `- ${m.text}`));
  add('facts', '事实层', false, pick('fact', 10).map((m) => `- ${m.text}`));
  add('prefs', '偏好层', false, pick('preference', 6).map((m) => `- ${m.text}`));
  add('relations', '关系层', false, pick('relation', 6).map((m) => `- ${m.text}`));
  add('events', '近期事件', false, pick('episode', 5, 'recent').map((m) => `- [${day(m.created_at)}] ${m.text}`));
  add('raw', '原话层（带情绪的原话）', false,
    active.filter((m) => Math.abs(m.valence || 0) >= 0.5 && m.evidence && m.evidence.snippet)
      .slice(0, 3).map((m) => `- 「${m.evidence.snippet}」`));
  const intents = store.listIntents().filter((t) => t.status === 'open' || t.status === 'overdue').slice(0, 3);
  add('intents', '未闭环承诺', false,
    intents.map((t) => `- ${t.text}${t.due_at ? `（${day(t.due_at)} 到期）` : ''}`));
  const pending = (s.conflicts || []).filter((c) => c.status === 'pending').length;
  add('conflicts', '待裁决冲突', false, pending ? [`- ${pending} 条事实冲突待裁决（面板·记忆体检）`] : []);
  add('status', '系统状态', false,
    [`- 活跃记忆 ${active.length} 条 · 上次整理 ${s.lastNightlyAt ? day(s.lastNightlyAt) : '未运行'}`]);

  /* 预算裁剪：hard 永不丢；其余按顺序塞，超预算即停 */
  const kept = [];
  let used = 0;
  for (const b of blocks) {
    if (b.hard || used + b.chars <= maxChars) { kept.push(b); used += b.chars; }
  }
  const text = kept.map((b) => `【${b.name}】\n${b.text}`).join('\n\n');
  return {
    blocks: kept.map((b) => ({ key: b.key, name: b.name, count: b.count, chars: b.chars })),
    dropped: blocks.filter((b) => !kept.includes(b)).map((b) => b.key),
    text, chars: text.length, budget: maxChars,
  };
}

/** 摘要块：给 /v1 与 MCP 注入用的文本。永久规则置顶（最高优先），其后是相关记忆 */export function blockOf(hits) {
  const sections = [];
  const rules = hits.rules || [];
  if (rules.length) sections.push('【永久规则（最高优先，必须遵守）】\n' + rules.map((r) => '- ' + r).join('\n'));
  if (hits.length) {
    const lines = hits.map((h) => {
      const day = new Date(h.created_at).toISOString().slice(0, 10);
      /* P1-6 不确定信息标注 + 纠错标注：推测/低置信/被纠正的记忆都提醒模型区别对待 */
      const unsure = h.kind === 'hypothesis' || (h.confidence != null && h.confidence < 0.5);
      const fixed = h.errors ? `（已被用户纠正×${h.errors}，慎用）` : '';
      return `- [${day}]${unsure ? '（未证实）' : ''}${fixed} ${h.text}`;
    });
    sections.push('【相关记忆】\n' + lines.join('\n'));
  }
  return sections.join('\n\n');
}
