/* ============================================================
 * viewmodel.mjs —— v2 星图面板的数据模型（纯函数，不改库）
 *
 * 设计原则（来自三路调研的共识）：
 *  · 一个过滤后的集合，五种投影共用，视图之间不各自存一份数据
 *  · 亮度 = 留存度，留存度由重要度 + 距上次被想起的天数 + 14 天半衰期算出
 *  · pin / digest 永不衰减；模拟衰减只是预览，绝不写回 store
 *  · 面板载荷只给短标签，完整原文点节点时才用 /memory/:id 取
 *  · 热力图目前只能由 created_at / last_hit 近似，因为 store 不记逐日召回日志；
 *    面板里必须标明这一点，不能伪造逐日召回历史
 * ============================================================ */
'use strict';

export const HALF_LIFE_DAYS = 14;
/* v3 分层半衰期：事实类慢衰（30 天），事件/技能/假设类正常衰（14 天）。
   pin / digest / 核心层永不衰减。 */
export const HALF_LIFE_BY_KIND = { fact: 30, preference: 30, relation: 30 };
export function halfLifeOf(m) {
  if (m.pin || m.kind === 'digest') return Infinity;
  return HALF_LIFE_BY_KIND[m.kind] || HALF_LIFE_DAYS;
}

/** 留存度：pin / digest 豁免，否则 importance * 0.5^(idleDays/半衰期) */
export function retentionOf(m, now = Date.now()) {
  if (m.pin || m.kind === 'digest') return 1;
  const idleDays = Math.max(0, (now - (m.last_hit || m.created_at)) / 86400000);
  return +(m.importance * Math.pow(0.5, idleDays / halfLifeOf(m))).toFixed(4);
}

/** 模拟 +days 天后的留存度（纯预览，不写库） */
export function retentionAt(m, daysAhead, now = Date.now()) {
  if (m.pin || m.kind === 'digest') return 1;
  const idleDays = Math.max(0, (now - (m.last_hit || m.created_at)) / 86400000) + daysAhead;
  return +(m.importance * Math.pow(0.5, idleDays / halfLifeOf(m))).toFixed(4);
}

/** v3 三态淡忘：清晰 → 模糊（只给摘要）→ 折叠（需显式追问才展开原文）。
    这里只算状态，不改库；召回与面板按状态展示。 */
export function stateOf(m, now = Date.now()) {
  if (m.pin || m.kind === 'digest') return 'clear';
  const r = retentionOf(m, now);
  if (r >= 0.45) return 'clear';
  if (r >= 0.2) return 'fuzzy';
  return 'folded';
}

/** 面板分类：core / selected / ordinary / fading / archived / superseded */
export function categoryOf(m, now = Date.now()) {
  if (m.status === 'archived') return 'archived';
  if (m.status === 'superseded') return 'superseded';
  if (m.pin || m.kind === 'digest') return 'core';
  const r = retentionOf(m, now);
  if (r < 0.35) return 'fading';
  if (m.importance >= 0.7 || m.hits >= 5) return 'selected';
  return 'ordinary';
}

export function shortLabel(text, n = 18) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * buildAtlas(state, opts)
 * opts: { owner, channel, group, kind, days, includeArchived, includeSuperseded, limit }
 * 返回面板用的瘦载荷 + 聚合统计，绝不把全部原文塞进星图载荷。
 */
export function buildAtlas(state, opts = {}) {
  const now = Date.now();
  const {
    kind = '', days = 0, includeArchived = false, includeSuperseded = false,
    limit = 500,
  } = opts;
  let mems = (state.memories || []).filter((m) => {
    if (m.status === 'active') return true;
    if (m.status === 'archived' && includeArchived) return true;
    if (m.status === 'superseded' && includeSuperseded) return true;
    return false;
  });
  if (kind) mems = mems.filter((m) => m.kind === kind);
  if (days > 0) mems = mems.filter((m) => now - m.created_at <= days * 86400000);

  // 最近的在前，保证 limit 截断时丢的是最旧的
  mems = [...mems].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  const ids = new Set(mems.map((m) => m.id));

  const nodes = mems.map((m) => ({
    id: 'm:' + m.id, memId: m.id, label: shortLabel(m.text),
    type: 'memory', kind: m.kind, category: categoryOf(m, now),
    state: stateOf(m, now),
    retention: retentionOf(m, now), importance: m.importance,
    hits: m.hits, pin: !!m.pin, owner: m.owner, visibility: m.visibility,
    created_at: m.created_at, last_hit: m.last_hit,
    entities: m.entities || [],
  }));
  // 实体节点：只保留与所选记忆相连的实体，避免星图被无关实体淹没
  const entityCount = new Map();
  for (const m of mems) for (const e of m.entities || []) entityCount.set(e, (entityCount.get(e) || 0) + 1);
  const entityNodes = [...entityCount.entries()].map(([name, count]) => ({
    id: 'e:' + name, label: name, type: 'entity', weight: count,
  }));
  const nodeIds = new Set([...nodes.map((n) => n.id), ...entityNodes.map((n) => n.id)]);
  const edges = [];
  for (const m of mems) {
    for (const e of m.entities || []) {
      if (nodeIds.has('e:' + e)) edges.push({ s: 'm:' + m.id, t: 'e:' + e, w: 1 });
    }
  }
  for (const r of state.relations || []) {
    if (nodeIds.has('e:' + r.src) && nodeIds.has('e:' + r.dst)) {
      edges.push({ s: 'e:' + r.src, t: 'e:' + r.dst, w: 2, label: r.relation });
    }
  }

  const byKind = {}, byCategory = {};
  for (const n of nodes) {
    byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    byCategory[n.category] = (byCategory[n.category] || 0) + 1;
  }
  // 时间线：按创建日聚合（近 30 天）
  const timeline = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const count = mems.filter((m) => new Date(m.created_at).toISOString().slice(0, 10) === key).length;
    timeline.push({ date: key, count });
  }
  // 热力：近 28 天 created + last_hit 活动（面板必须标明是近似，不是逐日召回日志）
  const heat = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const created = mems.filter((m) => new Date(m.created_at).toISOString().slice(0, 10) === key).length;
    const recalled = mems.filter((m) => new Date(m.last_hit || m.created_at).toISOString().slice(0, 10) === key && m.hits > 0).length;
    heat.push({ date: key, created, recalled });
  }
  const mostRecalled = [...mems].sort((a, b) => b.hits - a.hits).slice(0, 10).map((m) => ({
    id: m.id, label: shortLabel(m.text, 24), kind: m.kind, hits: m.hits,
    retention: retentionOf(m, now),
  }));

  return {
    generatedAt: now,
    nodes: [...entityNodes, ...nodes],
    edges: edges.slice(0, 2000),
    stats: {
      total: mems.length,
      byKind, byCategory,
      entities: entityNodes.length,
      relations: (state.relations || []).length,
      avgRetention: nodes.length
        ? +(nodes.reduce((a, n) => a + n.retention, 0) / nodes.length).toFixed(3) : 0,
    },
    timeline, heat, mostRecalled,
    note: 'heat 是 created_at / last_hit 的近似活动，不是逐日召回日志；simulated decay 只是预览，不写库。',
    _ids: [...ids],
  };
}

/** 导出格式：带版本号，便于换机器迁移；不含 token / 上游 key。
    v3 在 v2 基础上加 intents / conflicts；v2 导出仍可被 validateImport 接受。 */
export function exportData(state) {
  return {
    format: 'dafenyu-memory-export',
    version: 3,
    exportedAt: new Date().toISOString(),
    memories: state.memories || [],
    entities: state.entities || {},
    relations: state.relations || [],
    intents: state.intents || [],
    conflicts: state.conflicts || [],
    stats: state.stats || {},
  };
}

/** 导入校验：只接受本格式，字段缺失给默认值，绝不接受可执行内容 */
export function validateImport(doc) {
  if (!doc || doc.format !== 'dafenyu-memory-export' || !Array.isArray(doc.memories)) {
    return { ok: false, error: '不是 dafenyu-memory 导出格式' };
  }
  /* 白名单 + 钳制：导入文件来自外部，不能让它把 importance=999、visibility=乱写、
     或任意字段直接灌进库（导入的安全边界） */
  const num = (v, lo, hi, d) => {
    if (v == null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  const KINDS = ['episode', 'fact', 'preference', 'relation', 'skill', 'digest', 'hypothesis', 'insight'];
  const memories = doc.memories.filter((m) => m && typeof m.text === 'string').map((m) => ({
    id: typeof m.id === 'string' && /^[a-z]\d{6}$/i.test(m.id) ? m.id : undefined,
    owner: typeof m.owner === 'string' && /^(u:|g:|global)/.test(m.owner) ? m.owner.slice(0, 64) : 'global',
    visibility: ['public', 'private', 'group'].includes(m.visibility) ? m.visibility : 'public',
    kind: KINDS.includes(m.kind) ? m.kind : 'episode',
    text: String(m.text).slice(0, 1000),
    importance: num(m.importance, 0.02, 1, 0.5),
    valence: num(m.valence, -1, 1, 0),
    arousal: num(m.arousal, 0, 1, 0),
    entities: Array.isArray(m.entities) ? m.entities.filter((e) => typeof e === 'string').slice(0, 12) : [],
    pin: m.pin === true,
    status: ['active', 'archived', 'superseded'].includes(m.status) ? m.status : 'active',
    source: typeof m.source === 'string' ? m.source.slice(0, 20) : 'import',
    created_at: num(m.created_at, 0, Date.now() + 86400000, Date.now()),
    last_hit: num(m.last_hit, 0, Date.now() + 86400000, Date.now()),
    hits: num(m.hits, 0, 1e6, 0),
    errors: num(m.errors, 0, 1e6, 0),
    confidence: num(m.confidence, 0, 1, 0.6),
    fact_key: typeof m.fact_key === 'string' ? m.fact_key.slice(0, 64) : undefined,
    evidence: m.evidence && typeof m.evidence === 'object'
      ? { episode_id: String(m.evidence.episode_id || '').slice(0, 16), snippet: String(m.evidence.snippet || '').slice(0, 120) }
      : null,
    attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 8) : [],
    meta: m.meta && typeof m.meta === 'object' ? m.meta : {},
  }));
  return {
    ok: true,
    data: {
      memories,
      entities: doc.entities && typeof doc.entities === 'object' ? doc.entities : {},
      relations: Array.isArray(doc.relations) ? doc.relations : [],
      intents: Array.isArray(doc.intents) ? doc.intents : [],
      conflicts: Array.isArray(doc.conflicts) ? doc.conflicts : [],
    },
  };
}

/**
 * healthCheck(state) —— v3 记忆体检，纯函数，只读，绝不改库。
 * 返回计数 + 上限 20 条的短标签列表（不给全文），供面板“记忆体检”页展示。
 */
export function healthCheck(state, now = Date.now()) {
  const mems = state.memories || [];
  const active = mems.filter((m) => m.status === 'active');
  const soonFading = active
    .filter((m) => retentionOf(m, now) < 0.35)
    .map((m) => ({ id: m.id, label: shortLabel(m.text, 24), retention: retentionOf(m, now), state: stateOf(m, now) }))
    .slice(0, 20);
  const soonSolidifying = active
    .filter((m) => !m.pin && (m.hits || 0) >= 5)
    .map((m) => ({ id: m.id, label: shortLabel(m.text, 24), hits: m.hits }))
    .slice(0, 20);
  const byKey = new Map();
  for (const m of active) {
    if (!m.fact_key) continue;
    const k = m.owner + '|' + m.fact_key;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m.id);
  }
  const contradictoryFactKeys = [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([k, ids]) => ({ key: k, count: ids.length, ids: ids.slice(0, 20) }))
    .slice(0, 20);
  const pendingConflicts = (state.conflicts || []).filter((c) => c.status === 'pending');
  const intents = state.intents || [];
  const openIntents = intents.filter((t) => t.status !== 'resolved');
  const overdueIntents = openIntents.filter((t) => t.due_at != null && now > t.due_at);
  return {
    generatedAt: now,
    /* 审计违规报告（nightly 只读巡查结果，借 DSH 神经中枢总纲的审计层） */
    violations: state.lastViolations || [],
    lastNightlyAt: state.lastNightlyAt || null,
    counts: {
      active: active.length,
      pendingConflicts: pendingConflicts.length,
      soonFading: soonFading.length,
      soonSolidifying: soonSolidifying.length,
      contradictoryFactKeys: contradictoryFactKeys.length,
      openIntents: openIntents.length,
      overdueIntents: overdueIntents.length,
    },
    pendingConflicts: pendingConflicts.slice(0, 20).map((c) => ({
      id: c.id, fact_key: c.fact_key, old_id: c.old_id, new_id: c.new_id,
    })),
    soonFading, soonSolidifying, contradictoryFactKeys,
    openIntents: openIntents.slice(0, 20).map((t) => ({
      id: t.id, label: shortLabel(t.text, 24), due_at: t.due_at || null,
      overdue: t.due_at != null && now > t.due_at,
    })),
    note: '体检只读，不写库；heat 与模拟衰减仍为近似/预览，见 Atlas 备注。',
  };
}
