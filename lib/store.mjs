/* ============================================================
 * store.mjs —— 存储层（零依赖，JSON + JSONL）
 *
 * 设计：
 *   · brain.json    全部记忆 + 实体 + 关系（内存中持有，原子写盘）
 *   · episodes.jsonl 只追加的原始对话（回溯 / 重新总结用）
 *   · digests.jsonl  每晚"三件事"（元记忆流水）
 *
 * 与 memory-brain 的关键差异：
 *   · 每条记忆带 owner（u:qq:xxx / g:群号 / global）—— 解决"全库共享串记忆"
 *   · 每条记忆带 visibility（public/private/group）—— 群里绝不召回私聊的话
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const KINDS = new Set(['episode', 'fact', 'preference', 'relation', 'skill', 'digest', 'hypothesis', 'insight']);
const VISIBILITY = new Set(['public', 'private', 'group']);

let state = null;
/* 数据目录惰性求值：必须在 import 之前设 MEMORY_DATA_DIR 才生效 → 改成首次调用时读 */
export const DATA_DIR = () => process.env.MEMORY_DATA_DIR
  ? path.resolve(process.env.MEMORY_DATA_DIR)
  : path.join(path.dirname(HERE), 'data');

function emptyState() {
  return {
    version: 3,
    createdAt: new Date().toISOString(),
    seq: 0,                 // 记忆 id 计数
    memories: [],           // 记忆数组（活跃 + 归档）
    entities: {},           // name -> { type, count, first, last }
    relations: [],          // { src, dst, relation, weight, at }
    conflicts: [],          // v3：事实键冲突待裁决队列
    intents: [],            // v3：承诺 / 意图账本
    stats: { added: 0, hits: 0, archived: 0, merged: 0, purged: 0, forgotten: 0 },
  };
}

function files() {
  const dir = DATA_DIR();
  return {
    dir,
    brain: path.join(dir, 'brain.json'),
    episodes: path.join(dir, 'episodes.jsonl'),
    digests: path.join(dir, 'digests.jsonl'),
    audit: path.join(dir, 'audit.jsonl'),
  };
}

/** 审计日志（v3）：只追加一行 JSON，绝不改写历史。写失败时静默，绝不阻断主流程。 */
export function audit(event, detail = {}) {
  try {
    const f = files();
    fs.mkdirSync(f.dir, { recursive: true });
    fs.appendFileSync(f.audit, JSON.stringify({ at: Date.now(), event, ...detail }) + '\n');
  } catch { /* 审计失败不阻断记忆写入 */ }
}

export function load() {
  if (state) return state;
  const { dir, brain } = files();
  fs.mkdirSync(dir, { recursive: true });
  try {
    state = JSON.parse(fs.readFileSync(brain, 'utf8'));
  } catch {
    state = emptyState();
    save();
  }
  if (!state.memories) state.memories = [];
  if (!state.entities) state.entities = {};
  if (!state.relations) state.relations = [];
  if (!state.conflicts) state.conflicts = [];
  if (!state.intents) state.intents = [];
  /* P0-4 数据迁移：v3.1 schema —— 旧数据缺失的新字段在读取侧按缺省处理，
     这里只补 schema 标记与 memories 数组的字段兜底（幂等，不重写历史）。 */
  if (!state.schemaVersion || state.schemaVersion < 3.1) {
    state.schemaVersion = 3.1;
    for (const m of state.memories) {
      if (m.valid_from === undefined) m.valid_from = m.created_at || Date.now();
      if (m.valid_until === undefined) m.valid_until = null;
      if (m.confidence === undefined) m.confidence = 0.6;
      if (m.evidence === undefined) m.evidence = null;
      if (m.attachments === undefined) m.attachments = [];
    }
    save(true);
  }
  /* v3.2 修复迁移（2026-10-31）：干扰衰减 v1.0 公式方向错误（rate×1.6>1），
     一夜之间把同实体旧记忆的重要度乘大 1.592 倍——把 >1 的膨胀值除回去。
     只修 >1 的（单次运行必然 >1），保留 ≤1 的相对次序；一次性，幂等。 */
  if (!state.schemaVersion || state.schemaVersion < 3.2) {
    state.schemaVersion = 3.2;
    let repaired = 0;
    for (const m of state.memories) {
      if (m.importance > 1) { m.importance = +Math.min(1, m.importance / 1.592).toFixed(4); repaired++; }
    }
    if (repaired) { audit('migration_3_2_deflate', { repaired }); save(true); }
  }
  return state;
}

let saveTimer = null;
/** 原子写盘：写临时文件再 rename；300ms 防抖合并连续写 */
export function save(immediate = false) {
  if (!state) return;
  const write = () => {
    const { brain } = files();
    const tmp = brain + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, brain);
  };
  if (immediate) { clearTimeout(saveTimer); saveTimer = null; write(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 300);
}
export function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(true); }
process.on('exit', () => { try { flush(); } catch { /* 退出时不阻塞 */ } });

export function nextId() {
  const s = load();
  s.seq += 1;
  return 'm' + String(s.seq).padStart(6, '0');
}
function nextIdFor(prefix) {
  const s = load();
  s.seq += 1;
  return prefix + String(s.seq).padStart(6, '0');
}
/** 让 seq 不低于 id 里的数字后缀（m000123 / e000124 / c000005 都算） */
function bumpSeq(s, id) {
  const m = /^[a-z](\d{1,9})$/i.exec(String(id || ''));
  if (!m) return;
  const n = Number(m[1]);
  if (Number.isFinite(n) && n > (s.seq || 0)) s.seq = n;
}

/** 追加一条记忆（已校验字段），返回完整对象 */
export function insertMemory(rec) {
  const s = load();
  if (rec.id) bumpSeq(s, rec.id);   // 外部指定 id 时同步 seq，防后续 nextId 撞车
  const mem = {
    id: rec.id || nextId(),
    owner: rec.owner || 'global',
    visibility: VISIBILITY.has(rec.visibility) ? rec.visibility : 'public',
    kind: KINDS.has(rec.kind) ? rec.kind : 'episode',
    text: String(rec.text || '').slice(0, 1000),
    importance: clamp(rec.importance, 0.05, 1, 0.5),
    valence: clamp(rec.valence, -1, 1, 0),
    arousal: clamp(rec.arousal, 0, 1, 0),
    entities: (rec.entities || []).slice(0, 12),
    pin: !!rec.pin,
    status: 'active',
    source: rec.source || 'auto',
    created_at: rec.created_at || Date.now(),
    last_hit: rec.created_at || Date.now(),
    hits: 0,
    vector: Array.isArray(rec.vector) ? rec.vector.slice(0, 2048) : undefined,
    fact_key: typeof rec.fact_key === 'string' && rec.fact_key.trim()
      ? rec.fact_key.trim().slice(0, 64) : undefined,
    meta: rec.meta || {},
    /* P1 双时间线：事实在世界里的有效期（Graphiti 式 bi-temporal 的轻量版）
       注意：null/空串必须先判掉——Number(null)===0 会把"无有效期"写成 1970 年 */
    valid_from: numOrNull(rec.valid_from, rec.created_at || Date.now()),
    valid_until: numOrNull(rec.valid_until, null),
    /* P1 置信度：LLM 抽取自评，注入时低于 0.5 带"(未证实)"前缀 */
    confidence: clamp(rec.confidence, 0, 1, 0.6),
    /* P0 证据链：指向 episodes.jsonl 的原始行 */
    evidence: rec.evidence || null,
    /* P2 多模态：attachments = [{type:'ocr'|'caption'|'audio_text', text}] */
    attachments: Array.isArray(rec.attachments) ? rec.attachments.slice(0, 8) : [],
  };
  s.memories.push(mem);
  s.stats.added += 1;
  for (const name of mem.entities) upsertEntity(name, 'thing');
  // v3 事实键冲突：同 owner + 同 fact_key 已有 active 记忆时，不自动覆盖，
  // 只挂入待裁决队列——裁决前旧条继续生效，新条也保留（不删除任何一方）。
  if (mem.fact_key) {
    for (const old of s.memories) {
      if (old.id === mem.id || old.status !== 'active') continue;
      if (old.owner === mem.owner && old.fact_key === mem.fact_key) {
        const c = {
          id: nextIdFor('c'), owner: mem.owner, fact_key: mem.fact_key,
          old_id: old.id, new_id: mem.id, status: 'pending',
          created_at: Date.now(),
        };
        s.conflicts.push(c);
        audit('conflict_created', { conflict_id: c.id, fact_key: c.fact_key, old_id: c.old_id, new_id: c.new_id });
      }
    }
  }
  save();
  return mem;
}

/* ---------------- v3：冲突待裁决队列 ---------------- */
export function listConflicts(status = '') {
  const s = load();
  return (status ? s.conflicts.filter((c) => c.status === status) : [...s.conflicts])
    .map((c) => ({ ...c }));
}

/**
 * 裁决一条 pending 冲突：
 *   keep_new  → 旧条 superseded（新条成为当前事实）
 *   keep_old  → 新条 superseded（旧条继续生效）
 *   mark_only → 两条都保持 active，只记录“已知冲突、暂不处理”
 * 裁决结果写入 audit，绝不物理删除任何记忆。
 */
export function resolveConflict(id, choice, note = '') {
  const s = load();
  const c = s.conflicts.find((x) => x.id === id);
  if (!c || c.status !== 'pending') return null;
  if (!['keep_new', 'keep_old', 'mark_only'].includes(choice)) return null;
  if (choice === 'keep_new') supersede(c.old_id, c.new_id, 'conflict resolved: keep_new');
  else if (choice === 'keep_old') supersede(c.new_id, c.old_id, 'conflict resolved: keep_old');
  c.status = 'resolved';
  c.choice = choice;
  c.note = String(note || '').slice(0, 200);
  c.resolved_at = Date.now();
  audit('conflict_resolved', { conflict_id: c.id, choice, old_id: c.old_id, new_id: c.new_id });
  save();
  return { ...c };
}

/* ---------------- v3：承诺 / 意图账本 ---------------- */
export function addIntent(rec) {
  const s = load();
  const text = String(rec.text || '').trim();
  if (!text) return null;
  const intent = {
    id: nextIdFor('i'),
    text: text.slice(0, 500),
    owner: rec.owner || 'global',
    evidence_hint: String(rec.evidence_hint || '').slice(0, 200),
    due_at: numOrNull(rec.due_at, null),
    status: 'open',
    outcome: null,
    evidence: null,
    created_at: Date.now(),
    resolved_at: null,
  };
  s.intents.push(intent);
  audit('intent_created', { intent_id: intent.id, owner: intent.owner });
  save();
  return { ...intent };
}

/** 列表时计算状态：已裁决 → outcome；未裁决且已过 due_at → overdue；其余 open。原记录不被改写。 */
export function listIntents() {
  const s = load();
  const now = Date.now();
  return s.intents.map((t) => {
    const overdue = t.status !== 'resolved' && t.due_at != null && now > t.due_at;
    return {
      ...t,
      status: t.status === 'resolved' ? t.outcome : (overdue ? 'overdue' : 'open'),
      overdue,
    };
  });
}

export function resolveIntent(id, outcome, evidence = '') {
  const s = load();
  const t = s.intents.find((x) => x.id === id);
  if (!t || t.status === 'resolved') return null;
  if (!['fulfilled', 'missed'].includes(outcome)) return null;
  t.status = 'resolved';
  t.outcome = outcome;
  t.evidence = String(evidence || '').slice(0, 500);
  t.resolved_at = Date.now();
  audit('intent_resolved', { intent_id: t.id, outcome });
  save();
  return { ...t, status: outcome, overdue: false };
}

export function upsertEntity(name, type = 'thing', now = Date.now()) {
  const s = load();
  const key = String(name || '').trim().slice(0, 30);
  if (!key) return null;
  const e = s.entities[key] || (s.entities[key] = { type, count: 0, first: now, last: now });
  e.count += 1; e.last = now;
  if (type && type !== 'thing') e.type = type;
  return key;
}

export function addRelation(src, dst, relation, now = Date.now()) {
  const s = load();
  const a = String(src || '').trim(), b = String(dst || '').trim(), r = String(relation || '').trim();
  if (!a || !b || !r || a === b) return;
  s.relations.push({ src: a, dst: b, relation: r.slice(0, 12), at: now });
}

export function getMemory(id) { return load().memories.find((m) => m.id === id) || null; }

/**
 * 冲突标记（v2）：新事实取代旧事实时不删除旧的，只标记 superseded，
 * 保留“以前是什么”的查询能力。被取代的记忆不再参与 active 召回。
 */
export function supersede(oldId, newId, reason = '') {
  const s = load();
  const old = s.memories.find((m) => m.id === oldId);
  if (!old || old.status !== 'active') return null;
  old.status = 'superseded';
  old.superseded_by = newId;
  old.superseded_at = Date.now();
  old.superseded_reason = String(reason || '').slice(0, 200);
  audit('supersede', { old_id: oldId, new_id: newId, reason: old.superseded_reason });
  save();
  return old;
}

export function importMemories(doc, { replace = false } = {}) {
  const s = load();
  if (replace) { s.memories = []; s.entities = {}; s.relations = []; s.conflicts = []; s.intents = []; }
  let added = 0;
  for (const m of doc.memories || []) {
    if (m.id && s.memories.some((x) => x.id === m.id)) continue;
    s.memories.push({ ...m, id: m.id || nextId(), status: m.status || 'active' });
    added++;
  }
  Object.assign(s.entities, doc.entities || {});
  for (const r of doc.relations || []) s.relations.push(r);
  // v3 字段：导入时按 id 去重合并；旧版（v2）导出没有这两项时安全缺省为空。
  for (const c of doc.conflicts || []) {
    if (c && c.id && !s.conflicts.some((x) => x.id === c.id)) s.conflicts.push({ ...c });
  }
  for (const t of doc.intents || []) {
    if (t && t.id && !s.intents.some((x) => x.id === t.id)) s.intents.push({ ...t });
  }
  /* 导入后把 seq 顶到已有 id 的最大值，否则新写入可能生成重复 id */
  for (const m of s.memories) bumpSeq(s, m.id);
  for (const c of s.conflicts) bumpSeq(s, c.id);
  for (const t of s.intents) bumpSeq(s, t.id);
  s.stats.added += added;
  save(true);
  return { added, total: s.memories.length };
}

/**
 * 被想起=续命。v3.2 区分来源，防"模型自问自答"污染新近度（借 ldo1um）：
 *   mode 'full'  用户亲口再次提及 → hits+1 且 last_hit 前移（重置新近度）
 *   mode 'light' 模型检索命中    → 只计 hits（统计用），新近度不动
 */
export function touch(ids, now = Date.now(), mode = 'full') {
  const s = load();
  for (const m of s.memories) {
    if (!ids.includes(m.id)) continue;
    m.hits += 1; s.stats.hits += 1;
    if (mode === 'full') m.last_hit = now;
    /* P0-1 频率感知衰减的数据基础（借 memory-brain 思路）：滚动保留最近 20 次被想起的时间点，
       夜间治理据此判断"30 天内被想起几次"——常被想起的忘得更慢 */
    if (!Array.isArray(m.hit_ts)) m.hit_ts = [];
    m.hit_ts.push(now);
    if (m.hit_ts.length > 20) m.hit_ts.shift();
  }
  save();
}

/** 纠错降权（借 ldo1um）：用户指出记错 → 错误计数+1、重要度打折；绝不删除，可审计 */
export function markError(id) {
  const s = load();
  const m = s.memories.find((x) => x.id === id);
  if (!m) return null;
  m.errors = (m.errors || 0) + 1;
  m.importance = +Math.max(0.05, m.importance * 0.7).toFixed(4);
  audit('error_marked', { id, errors: m.errors, importance: m.importance });
  save();
  return { id: m.id, errors: m.errors, importance: m.importance };
}

/* ---------------- 手写永久规则层（借 ldo1um L4） ----------------
 * data/rules.md 人工编辑，一条一行；# 开头是注释/标题不参与注入。
 * 规则不参与打分、衰减与冲突裁决，召回时永远置顶，优先级高于一切记忆。 */
function rulesFile() { return path.join(DATA_DIR(), 'rules.md'); }
export function rulesRaw() { try { return fs.readFileSync(rulesFile(), 'utf8'); } catch { return ''; } }
export function listRules() {
  return rulesRaw().split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^[-*·•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((l) => l.slice(0, 300));
}
export function saveRules(text) {
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  fs.writeFileSync(rulesFile(), String(text || '').slice(0, 20000), 'utf8');
  audit('rules_saved', { count: listRules().length });
  return listRules().length;
}

/** 到期扫描（借 ldo1um）：windowMs 内到期、或已过期仍未解决的开放承诺（未通知过的） */
export function dueIntents(windowMs = 86400000, now = Date.now()) {
  return listIntents().filter((t) =>
    (t.status === 'open' || t.status === 'overdue') &&
    t.due_at != null && (t.due_at - now <= windowMs) &&
    !t.notified_at);
}
export function markNotified(ids, now = Date.now()) {
  const s = load();
  let n = 0;
  for (const t of s.intents) {
    if (ids.includes(t.id) && !t.notified_at) { t.notified_at = now; n++; }
  }
  if (n) { save(); audit('reminders_notified', { count: n, ids }); }
  return n;
}

export function appendEpisode(row) {
  const f = files();
  fs.mkdirSync(f.dir, { recursive: true });
  const rec = { id: nextIdFor('e'), at: Date.now(), ...row };
  fs.appendFileSync(f.episodes, JSON.stringify(rec) + '\n');
  return rec;   // 返回带 id 的完整行——调用方据此挂 evidence（修复 v1.0 未返回导致证据链断线）
}
export function appendDigest(row) {
  const f = files();
  fs.mkdirSync(f.dir, { recursive: true });
  fs.appendFileSync(f.digests, JSON.stringify(row) + '\n');
}
export function readEpisodes(sinceTs = 0) {
  try {
    return fs.readFileSync(files().episodes, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.at >= sinceTs);
  } catch { return []; }
}

export function stats() {
  const s = load();
  const active = s.memories.filter((m) => m.status === 'active');
  const kinds = {};
  for (const m of active) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
  const owners = {};
  for (const m of active) {
    const k = m.owner.split('|')[0];
    owners[k] = (owners[k] || 0) + 1;
  }
  return {
    active: active.length,
    archived: s.memories.length - active.length,
    entities: Object.keys(s.entities).length,
    relations: s.relations.length,
    pendingConflicts: (s.conflicts || []).filter((c) => c.status === 'pending').length,
    openIntents: (s.intents || []).filter((t) => t.status !== 'resolved').length,
    kinds, owners,
    avgImportance: active.length ? +(active.reduce((a, m) => a + m.importance, 0) / active.length).toFixed(3) : 0,
    /* 到期提醒：24h 内到期或已过期的开放承诺数（借 ldo1um 到期待办） */
    remindersDue: (s.intents || []).filter((t) => t.status !== 'resolved' && t.due_at != null &&
      (t.due_at - Date.now() <= 86400000 || Date.now() > t.due_at)).length,
    ...s.stats,
  };
}

export function persistPath() { return files(); }

export function clamp(v, lo, hi, dflt) {
  /* null/空串必须视为"未提供"，否则 Number(null)===0 会把缺省值写成 0 */
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** 可空数值：null/undefined/空串/NaN → dflt，其余转数字 */
export function numOrNull(v, dflt = null) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
export function isKind(k) { return KINDS.has(k); }
