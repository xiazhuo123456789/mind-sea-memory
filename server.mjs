#!/usr/bin/env node
/* ============================================================
 * mind-sea-memory 记忆星海 · 服务端 —— 零依赖记忆层
 *
 *   node server.mjs
 *   默认 http://127.0.0.1:8790
 *
 * 三种用法（可叠加）：
 *   A. OpenAI 兼容代理：把客户端 base_url 指到 /v1，记忆自动注入+自动记录
 *   B. 直接调接口：     POST /recall  POST /remember  GET /stats
 *   C. 大脑面板：       GET /panel    （力导向图，实时看"她在想什么"）
 *
 * 身份约定：
 *   每条请求必须带 user（如 "qq:10001"），群聊另带 x-channel: group 和 x-group: 888
 *   不带 user 的 /v1 请求返回 400 —— 防止所有人的记忆混在一起
 * ============================================================ */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.mjs';
import { recall, blockOf, nightly, bootPackage } from './lib/engine.mjs';
import { extractWithLLM, fallback, normalize } from './lib/extract.mjs';
import { buildAtlas, exportData, validateImport, retentionAt, healthCheck } from './lib/viewmodel.mjs';
import { makeEmbedder } from './lib/embed.mjs';
import { linkIntent, parseChineseTime } from './lib/intent.mjs';
import * as l1buffer from './lib/buffer.mjs';
import * as mood from './lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.5.4';
const STARTED = Date.now();

/* ---------------- 配置 ---------------- */
function loadConfig() {
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); } catch { /* 用默认 */ }
  const env = process.env;
  const cfg = {
    port: Number(env.MEMORY_PORT || fileCfg.port || 8790),
    host: env.MEMORY_HOST || fileCfg.host || '127.0.0.1',
    token: env.MEMORY_TOKEN || fileCfg.token || '',
    llm: {
      baseUrl: env.MEMORY_LLM_BASE || fileCfg.llm?.baseUrl || '',
      apiKey: env.MEMORY_LLM_KEY || fileCfg.llm?.apiKey || '',
      model: env.MEMORY_LLM_MODEL || fileCfg.llm?.model || 'deepseek-chat',
    },
    upstream: {
      baseUrl: env.MEMORY_UPSTREAM_BASE || fileCfg.upstream?.baseUrl || '',
      apiKey: env.MEMORY_UPSTREAM_KEY || fileCfg.upstream?.apiKey || '',
      model: env.MEMORY_UPSTREAM_MODEL || fileCfg.upstream?.model || 'deepseek-chat',
    },
    embed: {
      baseUrl: env.MEMORY_EMBED_URL || fileCfg.embed?.baseUrl || '',
      model: env.MEMORY_EMBED_MODEL || fileCfg.embed?.model || 'bge-m3',
    },
    recall: Object.assign({ k: 5, minScore: 0.35, maxBytes: 1400, maxItems: 5 }, fileCfg.recall || {}),
    remember: Object.assign({ enabled: true, minChars: 6, importance: 0.4 }, fileCfg.remember || {}),
    defaultUser: env.MEMORY_DEFAULT_USER || fileCfg.defaultUser || '',
    reminders: {
      webhook: env.MEMORY_REMINDER_WEBHOOK || fileCfg.reminders?.webhook || '',
      intervalMin: Math.max(5, Number(fileCfg.reminders?.intervalMin) || 10),
    },
    buffer: {
      enabled: fileCfg.buffer?.enabled !== false,
      maxItems: Number(fileCfg.buffer?.maxItems) || 6,
      maxChars: Number(fileCfg.buffer?.maxChars) || 900,
    },
    state: { enabled: fileCfg.state?.enabled !== false },
    /* 夜间治理：purgeDays<=0 = 永不物理删除（只进不出派） */
    nightly: {
      purgeDays: Number.isFinite(Number(fileCfg.nightly?.purgeDays)) ? Number(fileCfg.nightly?.purgeDays) : 180,
      /* P0-1 借 memory-brain：频率感知衰减 / 归档保护期 / 核心人物地板 / 按类上限 */
      freqWindowDays: Number(fileCfg.nightly?.freqWindowDays) || 30,
      archiveProtectDays: Number(fileCfg.nightly?.archiveProtectDays) || 30,
      protectNames: Array.isArray(fileCfg.nightly?.protectNames) ? fileCfg.nightly.protectNames : [],
      protectFloor: Number(fileCfg.nightly?.protectFloor) || 0.45,
      kindCaps: fileCfg.nightly?.kindCaps && typeof fileCfg.nightly.kindCaps === 'object' ? fileCfg.nightly.kindCaps : {},
      autoConflict: fileCfg.nightly?.autoConflict !== false,
    },
    shareGroupToPrivate: fileCfg.shareGroupToPrivate === true,
    debug: env.MEMORY_DEBUG === '1' || fileCfg.debug === true,
  };
  return cfg;
}
const CFG = loadConfig();
const log = (...a) => console.log('[mind-sea-memory]', ...a);

/* ---------------- 工具 ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const ok = (res, data) => sendJson(res, 200, { status: 'ok', data });
const err = (res, code, message) => sendJson(res, code, { status: 'error', message });

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(' ');
  }
  return '';
}
function looksLikeQuestion(text) {
  const s = String(text || '').trim();
  if (/[?？]\s*$/.test(s)) return true;
  return /(吗|呢|怎么样|如何|是什么|为什么|为啥|哪个|多少|几点)\s*[。？?]?$/.test(s);
}

function ownerFor({ channel, user, group }) {
  return channel === 'group' && group ? 'g:' + group : 'u:' + (user || 'unknown');
}

/* ---------------- 到期提醒（借 ldo1um）：扫描 + 可选 webhook 推送 ----------------
 * webhook 收到 POST {type:'reminder_due', id, text, owner, due_at} ——
 * 接到 SnowLuma/bridge 的发消息接口即可实现"机器人主动来提醒你"。 */
async function pushReminders() {
  const due = store.dueIntents();
  if (due.length) store.markNotified(due.map((t) => t.id));
  const hook = CFG.reminders?.webhook;
  let pushed = 0;
  if (hook && due.length) {
    for (const t of due) {
      try {
        await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'reminder_due', id: t.id, text: t.text, owner: t.owner, due_at: t.due_at }),
          signal: AbortSignal.timeout(5000) });
        pushed++;
      } catch { /* webhook 失败不重试不阻断 */ }
    }
  }
  if (due.length) store.audit('reminder_scan', { due: due.length, pushed });
  return {
    due: due.length, pushed,
    items: due.map((t) => ({ id: t.id, text: t.text, owner: t.owner, due_at: t.due_at })),
  };
}

/* ---------------- 记忆写入（自动 + 手动共用） ---------------- */
async function rememberConversation(text, { owner, user, channel, group, source = 'auto' }) {
  if (!CFG.remember.enabled) return null;
  const body = String(text || '').trim();
  if (body.length < CFG.remember.minChars) return null;
  if (/^[\s\p{Emoji}\p{P}]+$/u.test(body)) return null;
  if (looksLikeQuestion(body)) return null;

  let extracted = null;
  if (CFG.llm.apiKey) {
    const parsed = await extractWithLLM(body, CFG.llm);
    if (parsed?.skip) return null;
    extracted = normalize(parsed);
  }
  const rec = extracted || fallback([{ who: user || '用户', text: body }]);

  /* ── 借 ldo1um 的两条机制（2026-10-31）──────────────────────────
     ① 用户亲口再说 = 真提及：与旧记忆高度相似 → full 续命（重置新近度）。
        模型自己检索（MCP/recall 默认 light）不产生这种强化 → 防自污染滚雪球。
     ② 纠错话术 = 降权信号："不对/错了/记错了…" → 被纠旧记忆 errors+1 降权，
        不删除、可审计；新写入的纠正内容本身走正常入库（fact_key 冲突照常排队）。 */
  try {
    const chan = channel === 'group' ? 'group' : 'private';
    const isCorrection = /(不[是对]|错了|记错|搞错|说错|我说的是|才对|纠正)/.test(body);
    const prev = await recall(body, {
      owner: user || '', group, channel: chan, k: 1, reinforce: 'none',
      minScore: isCorrection ? 0.55 : 0.8,
    });
    const top = prev[0];
    if (top && isCorrection) store.markError(top.id);
    else if (top && !top.pin) store.touch([top.id], Date.now(), 'full');
  } catch { /* 强化/降权失败不阻断写入 */ }

  // 可选语义向量：配了 Ollama 才算，失败不阻断记忆（语义路退回 0）
  let vector;
  const embedder = makeEmbedder(CFG.embed);
  if (embedder) { try { vector = await embedder(rec.summary || body); } catch { vector = undefined; } }

  /* P0-1 证据链：原始对话先落 episodes.jsonl，记忆引用它的 id（可溯源） */
  let evidence = null;
  const ep = store.appendEpisode({
    channel: channel === 'group' ? 'group' : 'private',
    group: group || null,
    user: user || null,
    text: body.slice(0, 1000),
    source,
  });
  evidence = { episode_id: ep.id, snippet: body.slice(0, 80) };

  /* L1 会话缓冲（借 Diez 四层架构）：闲聊进缓冲攒批压缩，重要内容直通入库 */
  const ownerStr = ownerFor({ channel, user, group });
  const recForBuf = {
    text: rec.summary || body.slice(0, 800),
    kind: rec.kind,
    importance: rec.importance ?? CFG.remember.importance,
    entities: (rec.entities || []).map((e) => e.name || e),
    pin: rec.pin === true,
  };
  const baseRec = {
    text: recForBuf.text, kind: recForBuf.kind, importance: recForBuf.importance,
    confidence: rec.confidence, valence: rec.valence, fact_key: rec.fact_key,
    entities: recForBuf.entities, pin: recForBuf.pin,
    owner: ownerStr, visibility: channel === 'group' ? 'group' : 'private',
    source, vector, evidence,
  };
  let mem;
  if (!CFG.buffer.enabled) {
    mem = store.insertMemory(baseRec);
  } else {
    const r = await l1buffer.addBuffered({
      owner: ownerStr, rec: recForBuf, episodeId: ep ? ep.id : null,
      llm: CFG.llm.apiKey ? CFG.llm : null, now: Date.now(),
    });
    mem = r.action === 'direct' ? store.insertMemory(baseRec) : (r.memory || { id: null, text: recForBuf.text, kind: recForBuf.kind, owner: ownerStr });
  }

  /* P1-3 关系边复活：抽取出的 relations 写入图谱 */
  for (const r of (rec.relations || [])) {
    store.addRelation(r.src, r.dst, r.relation);
  }
  /* 意图账本闭环（借 memory-brain 工作记忆思路）：自动认领承诺 / 自动检测完成 */
  try { linkIntent({ owner: ownerStr, text: body, now: Date.now() }); } catch { /* 不阻断记忆 */ }
  /* L4 状态已在 /v1 注入阶段推进过一次；此处不再 tick，避免同一轮双倍刺激。
     （/remember 路径的状态推进在路由里做，不走本函数） */
  return mem;
}

/* ---------------- /v1 代理 ---------------- */
async function handleChatCompletions(req, res, body) {
  const owner = String(body.user || body.user_id || CFG.defaultUser || '').trim();
  if (!owner) return err(res, 400, '必须带 user 字段（如 "qq:10001"），或在 config.json 里设 defaultUser（单机器人场景），避免不同用户的记忆混在一起');
  const channel = String(req.headers['x-channel'] || body.channel || 'private').toLowerCase() === 'group' ? 'group' : 'private';
  const group = String(req.headers['x-group'] || body.group || '').trim();

  if (!CFG.upstream.baseUrl) {
    return err(res, 503, '未配置上游模型（upstream.baseUrl）。只做记忆时请用 /recall 与 /remember');
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
  const userText = lastUserText(messages);

  /* 1) 注入记忆 */
  let block = '';
  if (userText) {
    const hits = await recall(userText, {
      owner, group, channel,
      k: CFG.recall.k, minScore: CFG.recall.minScore,
    });
    block = blockOf(hits);
    if (CFG.debug) log(`召回 ${hits.length} 条 [${hits.map((h) => h.score).join(',')}]`);
  }
  if (CFG.state.enabled && userText) {
    try {
      const st = mood.tickState(owner, userText, Date.now());
      const stateLine = '【当前状态】情绪：' + st.label + '（亲密 ' + st.dims.intimacy + ' / 压力 ' + st.dims.stress + ' / 精力 ' + st.dims.energy + '）。语气可参考此状态；事实以记忆为准。';
      block = block ? stateLine + '\n\n' + block : stateLine;
    } catch { /* 状态失败不阻断 */ }
  }
  if (block) {
    const memorySystem = { role: 'system', content: '以下是你记得的旧事，用来接话，不要逐条复述：\n' + block };
    const sysIdx = messages.findIndex((m) => m?.role === 'system');
    if (sysIdx >= 0) {
      const old = typeof messages[sysIdx].content === 'string' ? messages[sysIdx].content : '';
      messages[sysIdx] = { ...messages[sysIdx], content: (old ? old + '\n\n' : '') + memorySystem.content };
    } else messages.unshift(memorySystem);
  }

  /* 2) 转发上游 */
  const payload = { ...body, model: body.model || CFG.upstream.model, messages };
  delete payload.user; delete payload.user_id; delete payload.channel; delete payload.group;

  let upRes;
  try {
    upRes = await fetch(CFG.upstream.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(CFG.upstream.apiKey ? { Authorization: 'Bearer ' + CFG.upstream.apiKey } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return err(res, 502, '连不上上游模型：' + e.message);
  }

  /* 流式透传 */
  if (body.stream) {
    res.writeHead(upRes.status, {
      'Content-Type': upRes.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    for await (const chunk of upRes.body) res.write(chunk);
    res.end();
    if (upRes.ok && userText) {
      rememberConversation(userText, { owner, user: owner.replace(/^u:/, ''), channel, group }).catch(() => {});
    }
    return;
  }

  const text = await upRes.text();
  res.writeHead(upRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);

  if (upRes.ok && userText) {
    rememberConversation(userText, { owner, user: owner.replace(/^u:/, ''), channel, group }).catch(() => {});
  }
}

/* ---------------- /brain：面板数据 ---------------- */
function brainData() {
  const s = store.load();
  const active = s.memories.filter((m) => m.status === 'active');
  const entityNodes = Object.entries(s.entities).map(([name, e]) => ({
    id: 'e:' + name, label: name, type: 'entity', etype: e.type, weight: e.count,
  }));
  const memNodes = active.slice(-300).map((m) => ({
    id: 'm:' + m.id, label: m.text.slice(0, 24), type: 'memory', kind: m.kind,
    weight: 1 + m.hits, pin: m.pin, owner: m.owner,
  }));
  const nodeIds = new Set([...entityNodes.map((n) => n.id), ...memNodes.map((n) => n.id)]);
  const edges = [];
  for (const m of active.slice(-300)) {
    for (const e of m.entities) {
      if (nodeIds.has('e:' + e)) edges.push({ s: 'm:' + m.id, t: 'e:' + e, w: 1 });
    }
  }
  for (const r of s.relations.slice(-200)) {
    if (nodeIds.has('e:' + r.src) && nodeIds.has('e:' + r.dst)) edges.push({ s: 'e:' + r.src, t: 'e:' + r.dst, w: 2, label: r.relation });
  }
  return { nodes: [...entityNodes, ...memNodes], edges, stats: store.stats() };
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const auth = () => !CFG.token || (req.headers.authorization === 'Bearer ' + CFG.token);

  try {
    /* 面板（静态） */
    /* 面板：/ 与任何 /panel* 路径都返回面板（容忍末尾杂字符、斜杠、查询串） */
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/panel'))) {
      /* no-store：面板是单文件热更新的，绝不让浏览器拿旧缓存（否则改了看不到） */
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' });
      return res.end(fs.readFileSync(path.join(HERE, 'public', 'panel.html')));
    }
    if (req.method === 'GET' && p === '/brain') return ok(res, brainData());

    /* 健康 */
    if (req.method === 'GET' && p === '/health') {
      return ok(res, {
        version: VERSION,
        uptimeSec: Math.floor((Date.now() - STARTED) / 1000),
        llm: !!CFG.llm.apiKey,
        upstream: !!CFG.upstream.baseUrl,
        /* 审计违规报告（nightly 巡查结果）：冲突搁置过久 / 承诺逾期 / 容量预警 */
        violations: store.load().lastViolations || [],
        ...store.stats(),
      });
    }

    /* 其余接口都要鉴权（配置了 token 时） */
    if (!auth()) return err(res, 401, 'unauthorized：请带 Authorization: Bearer <MEMORY_TOKEN>');

    if (req.method === 'GET' && p === '/stats') return ok(res, store.stats());

    /* v3：记忆体检（只读）与承诺账本 */
    if (req.method === 'GET' && p === '/healthcheck') return ok(res, healthCheck(store.load()));
    if (req.method === 'GET' && p === '/intents') return ok(res, { intents: store.listIntents() });
    if (req.method === 'GET' && p === '/conflicts') return ok(res, { conflicts: store.listConflicts() });
    if (req.method === 'POST' && p === '/intent') {
      const body = JSON.parse(await readBody(req) || '{}');
      /* 未显式给 due_at 时，从文本里解析中文时间（明天下午三点 / 3小时后 / 周三…） */
      let dueAt = (body.due_at == null || body.due_at === '') ? null : (Number.isFinite(Number(body.due_at)) ? Number(body.due_at) : null);
      let dueLabel = body.evidence_hint || '';
      if (!dueAt) {
        const t = parseChineseTime(String(body.text || ''), Date.now());
        if (t) { dueAt = t.at; dueLabel = t.label; }
      }
      const intent = store.addIntent({
        text: body.text, owner: body.owner || ownerFor({ channel: body.channel === 'group' ? 'group' : 'private', user: body.user, group: body.group }),
        due_at: dueAt, evidence_hint: dueLabel,
      });
      if (!intent) return err(res, 400, 'text 不能为空');
      return ok(res, intent);
    }
    if (req.method === 'POST' && p.startsWith('/intent/') && p.endsWith('/resolve')) {
      const id = p.slice('/intent/'.length, -'/resolve'.length);
      const body = JSON.parse(await readBody(req) || '{}');
      const t = store.resolveIntent(id, body.outcome, body.evidence || '');
      if (!t) return err(res, 400, '意图不存在、已裁决，或 outcome 必须是 fulfilled/missed');
      return ok(res, t);
    }
    if (req.method === 'POST' && p.startsWith('/conflict/') && p.endsWith('/resolve')) {
      const id = p.slice('/conflict/'.length, -'/resolve'.length);
      const body = JSON.parse(await readBody(req) || '{}');
      const c = store.resolveConflict(id, body.choice, body.note || '');
      if (!c) return err(res, 400, '冲突不存在、已裁决，或 choice 必须是 keep_new/keep_old/mark_only');
      return ok(res, c);
    }

    /* v2 星图载荷：瘦节点 + 聚合，完整原文不进星图载荷 */
    if (req.method === 'GET' && p === '/atlas') {
      const q = url.searchParams;
      return ok(res, buildAtlas(store.load(), {
        kind: q.get('kind') || '',
        days: Number(q.get('days')) || 0,
        includeArchived: q.get('archived') === '1',
        includeSuperseded: q.get('superseded') === '1',
        limit: Math.min(3000, Math.max(50, Number(q.get('limit')) || 500)),
      }));
    }
    /* 模拟衰减预览：纯计算，绝不写库 */
    if (req.method === 'GET' && p === '/simulate-decay') {
      const daysAhead = Number(url.searchParams.get('days')) || 30;
      const mems = store.load().memories.filter((m) => m.status === 'active');
      return ok(res, {
        daysAhead,
        preview: mems.slice(0, 200).map((m) => ({ id: m.id, retention: retentionAt(m, daysAhead) })),
      });
    }
    /* 单条详情：点节点时才取完整原文 */
    /* P1-7 记忆管理：编辑（PUT）与软删（DELETE），全程审计 */
    if (req.method === 'PUT' && p.startsWith('/memory/')) {
      const id = p.slice('/memory/'.length);
      const mem = store.getMemory(id);
      if (!mem) return err(res, 404, '记忆不存在');
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.text === 'string' && body.text.trim()) {
        const next = body.text.trim().slice(0, 1000);
        if (next !== mem.text) {
          mem.text = next;
          mem.vector = undefined;   // 文本变了，旧向量不再代表这条记忆——作废而不是留着误导语义路
        }
      }
      if (Number.isFinite(Number(body.importance))) mem.importance = store.clamp(Number(body.importance), 0.05, 1, mem.importance);
      if (typeof body.pin === 'boolean') mem.pin = body.pin;
      if (typeof body.visibility === 'string' && ['public','private','group'].includes(body.visibility)) mem.visibility = body.visibility;
      mem.edited_at = Date.now();
      store.audit('memory_edited', { id });
      store.save(true);
      return ok(res, { id: mem.id, text: mem.text, edited: true });
    }
    if (req.method === 'DELETE' && p.startsWith('/memory/')) {
      const id = p.slice('/memory/'.length);
      const mem = store.getMemory(id);
      if (!mem) return err(res, 404, '记忆不存在');
      if (mem.status === 'active') { mem.status = 'archived'; mem.archived_at = Date.now(); }
      store.audit('memory_deleted_by_user', { id, text: mem.text.slice(0, 80) });
      store.save(true);
      return ok(res, { id, status: mem.status, note: '已归档（未物理删除）' });
    }
    if (req.method === 'GET' && p.startsWith('/memory/')) {
      const mem = store.getMemory(p.slice('/memory/'.length));
      if (!mem) return err(res, 404, '记忆不存在');
      const { vector, ...rest } = mem;
      return ok(res, rest);
    }
    /* L4 状态层：查看 / 重置（借 Diez L4 + memory-brain P1-5，可查看可重置） */
    if (req.method === 'GET' && p === '/state') {
      const q = url.searchParams;
      return ok(res, mood.view(q.get('user') || CFG.defaultUser || 'global', Date.now()));
    }
    if (req.method === 'DELETE' && p === '/state') {
      const q = url.searchParams;
      return ok(res, mood.resetState(q.get('user') || CFG.defaultUser || 'global', Date.now()));
    }
    /* P0-4 开机包：新会话第一条注入用，按层组装 + 预算裁剪（hard 块永不丢） */
    if (req.method === 'GET' && p === '/boot') {
      const q = url.searchParams;
      return ok(res, bootPackage({
        owner: q.get('user') || q.get('owner') || '',
        group: q.get('group') || '',
        channel: q.get('channel') === 'group' ? 'group' : 'private',
        maxChars: Number(q.get('maxChars')) || undefined,
      }));
    }
    if (req.method === 'POST' && p === '/boot') {
      const body = JSON.parse(await readBody(req) || '{}');
      return ok(res, bootPackage({
        owner: String(body.user || body.owner || '').trim(),
        group: String(body.group || '').trim(),
        channel: body.channel === 'group' ? 'group' : 'private',
        maxChars: Number(body.maxChars) || undefined,
      }));
    }

    /* 手写永久规则层（借 ldo1um L4）：GET 取原文，PUT 整体保存（一条一行，# 为注释） */
    if (req.method === 'GET' && p === '/rules') {
      return ok(res, { rules: store.listRules(), raw: store.rulesRaw() });
    }
    if (req.method === 'PUT' && p === '/rules') {
      const body = JSON.parse(await readBody(req) || '{}');
      const count = store.saveRules(String(body.text ?? body.rules ?? ''));
      return ok(res, { count, note: '规则不参与打分衰减，下次召回自动置顶注入' });
    }
    /* 到期提醒（借 ldo1um）：GET 查看未通知的到期承诺，POST 手动扫描+webhook 推送 */
    if (req.method === 'GET' && p === '/reminders/due') {
      return ok(res, { reminders: store.dueIntents() });
    }
    if (req.method === 'POST' && p === '/reminders/scan') {
      return ok(res, await pushReminders());
    }
    if (req.method === 'GET' && p === '/export') return ok(res, exportData(store.load()));
    if (req.method === 'POST' && p === '/import') {
      const body = JSON.parse(await readBody(req) || '{}');
      const v = validateImport(body);
      if (!v.ok) return err(res, 400, v.error);
      return ok(res, store.importMemories(v.data, { replace: body.replace === true }));
    }

    if (req.method === 'POST' && p === '/remember') {
      const body = JSON.parse(await readBody(req) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return err(res, 400, 'text 不能为空');
      const channel = body.channel === 'group' || (!body.user && body.group) ? 'group' : 'private';
      /* P0-3：手动写入也补语义向量（未配 Ollama 时安全降级） */
      let vector = Array.isArray(body.vector) ? body.vector : undefined;
      if (!vector) {
        const embedder2 = makeEmbedder(CFG.embed);
        if (embedder2) { try { vector = await embedder2(text); } catch { vector = undefined; } }
      }
      /* P0-1 证据链：手动/MCP 写入同样先落 episodes.jsonl，记忆引用其 id（可溯源）。
         （v1.0 时 /remember 不走 rememberConversation，证据链在此断线——2026-11-01 修复） */
      let evidence = null;
      try {
        const ep = store.appendEpisode({
          channel: channel === 'group' ? 'group' : 'private',
          group: body.group || null,
          user: body.user || null,
          text: text.slice(0, 1000),
          source: body.source || 'manual',
        });
        evidence = { episode_id: ep.id, snippet: text.slice(0, 80) };
      } catch { /* 证据落库失败不阻断记忆写入 */ }
      const mem = store.insertMemory({
        text,
        kind: body.kind,
        importance: body.importance,
        confidence: body.confidence,
        valence: body.valence,
        entities: (body.entities || []).map((e) => (typeof e === 'string' ? e : e.name)),
        pin: body.pin === true,
        owner: body.owner || ownerFor({ channel, user: body.user, group: body.group }),
        visibility: body.visibility || (channel === 'group' ? 'group' : 'private'),
        source: body.source || 'manual',
        vector,
        fact_key: body.fact_key,
        attachments: body.attachments,
        evidence,
      });
      for (const r of (body.relations || [])) {
        if (r && r.src && r.dst && r.relation) store.addRelation(r.src, r.dst, r.relation);
      }
      /* 意图账本闭环：自动认领承诺（"别忘了明天三点交报告"）/ 自动检测完成（"搞定了"） */
      let intentLink = { action: 'none' };
      try { intentLink = linkIntent({ owner: mem.owner, text, now: Date.now() }); } catch { /* 不阻断写入 */ }
      /* L4 状态：手动/MCP 写入也推进情绪（DSH 走的是这条路径） */
      if (CFG.state.enabled) { try { mood.tickState(mem.owner, text, Date.now()); } catch { /* 不阻断 */ } }
      // v3：同 fact_key 产生待裁决冲突时，冲突 id 一并返回；裁决前旧条继续生效
      const conflictIds = store.listConflicts('pending').filter((c) => c.new_id === mem.id).map((c) => c.id);
      // 冲突标记：新事实取代旧事实时，旧的只标记 superseded，不删除
      let superseded = null;
      if (body.supersedes) {
        superseded = store.supersede(String(body.supersedes), mem.id, body.superseded_reason || '');
      }
      return ok(res, {
        id: mem.id, text: mem.text, kind: mem.kind, owner: mem.owner,
        superseded: superseded?.id || null, conflict_ids: conflictIds,
        intent: intentLink.action === 'created'
          ? { id: intentLink.intent.id, due_at: intentLink.intent.due_at, due_label: intentLink.intent.evidence_hint }
          : intentLink.action === 'resolved'
            ? { resolved: intentLink.intent.id }
            : undefined,
      });
    }

    if (req.method === 'POST' && p === '/recall') {
      const body = JSON.parse(await readBody(req) || '{}');
      const channel = body.channel === 'group' || (!body.user && body.group) ? 'group' : 'private';
      /* L4 状态：MCP 每次召回代表"用户说了一句话"，带 tick:true 时推进情绪；
         面板召回解释不带此参数，避免手动查询污染状态 */
      if (body.tick === true && CFG.state.enabled) {
        try { mood.tickState(body.user || CFG.defaultUser || 'global', String(body.query || ''), Date.now()); } catch { /* 不阻断 */ }
      }
      const embedder = body.embed === false ? null : makeEmbedder(CFG.embed);
      const hits = await recall(String(body.query || ''), {
        owner: body.user || '',
        group: body.group || '',
        channel,
        k: Number(body.k) || CFG.recall.k,
        coreK: Number(body.core_k) || 3,
        minScore: Number.isFinite(Number(body.minScore)) ? Number(body.minScore) : CFG.recall.minScore,
        explain: body.explain === true,
        moodValence: body.mood_valence,
        embed: embedder,
        /* as_of 兼容毫秒时间戳与 ISO 日期字符串（"2026-10-01" / 完整 ISO） */
        asOf: body.as_of != null ? (Number(body.as_of) || Date.parse(String(body.as_of)) || null) : null,
        /* 续命来源区分（防自污染）：模型检索默认 light；用户亲口再说传 full；纯只读传 none */
        reinforce: ['none', 'light', 'full'].includes(body.reinforce) ? body.reinforce : 'light',
      });
      if (body.explain === true) {
        return ok(res, {
          hits, rejected: hits.rejected || [],
          channels: hits.channels || { core: [], event: [] },
          block: blockOf(hits),
          rules: hits.rules || [],
          timeWindow: hits.timeWindow || null,
        });
      }
      return ok(res, { hits, block: blockOf(hits), rules: hits.rules || [], timeWindow: hits.timeWindow || null });
    }

    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/agent/chat')) {
      const body = JSON.parse(await readBody(req) || '{}');
      return await handleChatCompletions(req, res, body);
    }

    if ((req.method === 'POST' || req.method === 'GET') && p === '/nightly') {
      return ok(res, nightly({
        purgeDays: CFG.nightly.purgeDays,
        freqWindowDays: CFG.nightly.freqWindowDays,
        archiveProtectDays: CFG.nightly.archiveProtectDays,
        protectNames: CFG.nightly.protectNames,
        protectFloor: CFG.nightly.protectFloor,
        kindCaps: CFG.nightly.kindCaps,
        autoConflict: CFG.nightly.autoConflict,
      }));
    }

    /* P1 反思（Generative Agents 式）：从近期高价值记忆提炼"更高层次的认识"，
       洞察本身入库（kind=insight，永不衰减），meta.source_ids 记录由哪些记忆提炼——可溯源。 */
    if (req.method === 'POST' && p === '/reflect') {
      if (!CFG.llm.apiKey) return err(res, 400, '反思需要 LLM：请在 config.json 配置 llm 段（无 LLM 时规则无法生成有价值的洞察）');
      const body = JSON.parse(await readBody(req) || '{}');
      const days = Number(body.days) || 7;
      const since = Date.now() - days * 86400000;
      const pool = store.load().memories.filter((m) =>
        m.status === 'active' && m.created_at >= since && m.kind !== 'insight' &&
        (m.importance >= 0.55 || Math.abs(m.valence) >= 0.4 || m.pin))
        .sort((a, b) => b.importance - a.importance).slice(0, 15);
      if (pool.length < 3) return ok(res, { note: `近 ${days} 天高价值记忆不足 3 条，暂不反思`, pool: pool.length });

      const conv = pool.map((m) => `- ${m.text}`).join('\n');
      const prompt = `以下是你与主人近 ${days} 天的高价值记忆。请提炼 2-3 条**更高层次的认识**（不是复述事件，
而是模式、偏好变化、关系进展、反复出现的需求）。只输出 JSON：
{{"insights": [{{"summary": "一句话洞察（不超过 60 字）", "confidence": 0.7}}]}}

记忆：
${conv}`;
      try {
        const llmRes = await fetch(String(CFG.llm.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.llm.apiKey },
          body: JSON.stringify({ model: CFG.llm.model, messages: [
            { role: 'system', content: '你是记忆整理器。只输出 JSON。' },
            { role: 'user', content: prompt },
          ], temperature: 0.3, max_tokens: 400 }),
          signal: AbortSignal.timeout(60000),
        });
        const out = await llmRes.json();
        const raw = out?.choices?.[0]?.message?.content || '';
        const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
        const parsed = JSON.parse(raw.slice(start, end + 1));
        const created = [];
        for (const ins of (parsed.insights || []).slice(0, 3)) {
          if (!ins.summary || String(ins.summary).length < 6) continue;
          const mem = store.insertMemory({
            text: '💡 ' + String(ins.summary).slice(0, 200),
            kind: 'insight',
            importance: 0.85,
            confidence: Number(ins.confidence) || 0.6,
            owner: 'global',
            visibility: 'public',
            entities: [],
            pin: false,
            source: 'reflect',
            meta: { source_ids: pool.slice(0, 10).map((m) => m.id), reflect_days: days },
          });
          created.push(mem.id);
        }
        store.audit('reflect', { days, created: created.length, source_count: pool.length });
        return ok(res, { created: created.length, ids: created, source_count: pool.length });
      } catch (e) {
        return err(res, 502, '反思失败：' + (e.message || e));
      }
    }

    if (req.method === 'POST' && p === '/digest') {
      /* 立即做一次"昨日三件事" */
      const body = JSON.parse(await readBody(req) || '{}');
      const since = Date.now() - 86400000;
      const high = store.load().memories
        .filter((m) => m.status === 'active' && m.created_at >= since && m.importance >= 0.5)
        .sort((a, b) => b.importance - a.importance).slice(0, 10);
      if (!high.length) return ok(res, { note: '昨天没有值得记的大事' });
      let rec;
      if (CFG.llm.apiKey) {
        const parsed = await extractWithLLM(high.map((m) => '- ' + m.text).join('\n'), CFG.llm);
        rec = parsed && !parsed.skip ? normalize(parsed) : null;
      }
      if (!rec) rec = fallback(high.map((m) => ({ who: '昨天', text: m.text })));
      const mem = store.insertMemory({
        text: '【昨日三件事】' + rec.summary, kind: 'digest', importance: 0.8,
        owner: 'global', visibility: 'public',
        entities: rec.entities.map((e) => e.name), source: 'digest',
      });
      return ok(res, { id: mem.id, summary: rec.summary });
    }

    return err(res, 404, 'not found: ' + p);
  } catch (e) {
    return err(res, 500, e.message || String(e));
  }
});

server.listen(CFG.port, CFG.host, () => {
  log(`记忆星海 v${VERSION} 已启动  http://${CFG.host}:${CFG.port}`);
  log(`  面板     : http://${CFG.host}:${CFG.port}/panel`);
  log(`  代理端点 : ${CFG.upstream.baseUrl ? CFG.upstream.baseUrl : '(未配置 upstream，/v1 不可用)'}`);
  log(`  LLM 抽取 : ${CFG.llm.apiKey ? '已配置' : '未配置（用规则兜底）'}`);
  log(`  Embedding: ${CFG.embed.baseUrl ? CFG.embed.baseUrl + ' / ' + CFG.embed.model : '未配置（语义路为 0）'}`);
  log(`  星图面板 : http://${CFG.host}:${CFG.port}/panel  ·  数据 /atlas`);
  log(`  鉴权     : ${CFG.token ? '已开启' : '未开启（仅本机使用）'}`);
  log(`  到期提醒 : ${CFG.reminders?.webhook ? 'webhook 已配置' : '仅扫描不推送（GET /reminders/due）'} · 每 ${CFG.reminders?.intervalMin || 10} 分钟`);
  store.flush();
  /* L1 缓冲与退出冲刷（借 Diez L1）：退出前把缓冲压成摘要，不丢闲聊 */
  l1buffer.configBuffer({
    maxItems: CFG.buffer.maxItems,
    maxChars: CFG.buffer.maxChars,
    llm: CFG.llm.apiKey ? CFG.llm : null,
  });
  process.on('exit', () => { try { l1buffer.flushAllSync(); } catch { } });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      try { await l1buffer.flushAll(CFG.llm.apiKey ? CFG.llm : null); } catch { }
      process.exit(0);
    });
  }
});

/* 到期提醒周期扫描（借 ldo1um）：启动 8s 后首扫，此后每 intervalMin 分钟一次。
 * 有 webhook 就推送，没有就只打 notified 标记（供 GET /reminders/due 与 mem_stats 透出）。 */
setTimeout(() => { pushReminders().catch(() => {}); }, 8000);
setInterval(() => { pushReminders().catch(() => {}); }, Math.max(5, CFG.reminders?.intervalMin || 10) * 60000);
