#!/usr/bin/env node
/* ============================================================
 * mcp-server.mjs —— 记忆星海 · MCP stdio 服务器
 *
 * 把本记忆引擎以 MCP 工具的形式挂进 DSH（DeepSeek Harness），
 * AI 从此拥有 mem_recall / mem_remember / mem_stats 三个记忆工具。
 *
 * 注册方式（由 scripts/register-dsh.mjs 自动写入 cordis.patch.yml）：
 *   serverName: mind-sea-memory → 工具名 mcp__mind-sea-memory__mem_recall 等
 *
 * 依赖：零第三方依赖（Node ≥ 18）。记忆数据走本机 HTTP API（server.mjs，:8790）。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); } catch { /* 默认 */ }
  return {
    base: String(cfg.serverUrl || 'http://127.0.0.1:8790').replace(/\/+$/, ''),
    token: String(cfg.token || cfg.serverToken || ''),
    defaultUser: String(cfg.defaultUser || 'dsh:main'),
    k: Number(cfg.k) || 5,
    minScore: Number.isFinite(Number(cfg.minScore)) ? Number(cfg.minScore) : 0.35,
  };
}
const CFG = loadConfig();

function logErr(...a) { process.stderr.write('[mind-sea-memory] ' + a.join(' ') + '\n'); }

async function api(endpoint, payload, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (CFG.token) headers.Authorization = 'Bearer ' + CFG.token;
  const res = await fetch(CFG.base + endpoint, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('记忆引擎返回非 JSON：' + text.slice(0, 120)); }
  if (data.status === 'error') throw new Error(data.message || '记忆引擎错误');
  return data.data !== undefined ? data.data : data;
}

/* ---------------- 三个工具 ---------------- */
const TOOLS = [
  {
    name: 'mem_recall',
    description: '回忆和当前话题相关的旧事（长期记忆检索）。用户问"你还记得…吗""上次说的…""我之前说过什么"时用。返回按相关度排序的记忆片段；块开头的【永久规则】是用户硬性要求必须遵守，标注（未证实）或（已被用户纠正）的记忆要谨慎引用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词或整句话，如"团子""上次约的饭"' },
        k: { type: 'number', description: '返回几条，默认 5' },
        user: { type: 'string', description: '用户标识（如 qq:10001）；不填则用默认记忆空间' },
      },
      required: ['query'],
    },
    async run(args) {
      const hits = await api('/recall', {
        query: String(args.query || ''),
        k: Number(args.k) || CFG.k,
        minScore: CFG.minScore,
        user: String(args.user || CFG.defaultUser),
        visibility: ['public', 'private', 'group'],
        tick: true,   // 每次召回代表用户说了一句话 → 推进 L4 情绪状态
      });
      if (!hits.block) return { content: [{ type: 'text', text: `没有找到和「${args.query}」相关的记忆。` }] };
      return { content: [{ type: 'text', text: '🧠 我想起来了：\n' + hits.block }] };
    },
  },
  {
    name: 'mem_remember',
    description: '把一条长期事实写进记忆库。用户说"记住…""别忘了…""以后请…"时用。涉及称呼、账号、长期约定的内容把 pin 设为 true。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一句话说清' },
        kind: { type: 'string', description: 'episode 事件 / fact 事实 / preference 偏好 / relation 关系 / skill 做法' },
        importance: { type: 'number', description: '0-1；寒暄 0.2、日常 0.4、约定偏好 0.6、重要事件 0.8' },
        pin: { type: 'boolean', description: '身份/账号/长期约定等永不遗忘的信息设 true' },
        user: { type: 'string', description: '用户标识（如 qq:10001）；不填则记到默认记忆空间' },
      },
      required: ['text'],
    },
    async run(args) {
      const mem = await api('/remember', {
        text: String(args.text || '').slice(0, 800),
        kind: args.kind,
        importance: args.importance,
        pin: args.pin === true,
        user: String(args.user || CFG.defaultUser),
        source: 'mcp',
      });
      return { content: [{ type: 'text', text: `🧠 记住了（${mem.id}，${mem.kind}${mem.pin ? '，已钉住' : ''}）：${mem.text}` }] };
    },
  },
  {
    name: 'mem_boot',
    description: '加载"开机包"：新会话/新话题开始时用一次，一次拿到身份、永久规则、事实、偏好、关系、近期事件、未闭环承诺等分层记忆（有预算上限，不会撑爆上下文）。',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: '用户标识（如 qq:10001）；不填则用默认记忆空间' },
        maxChars: { type: 'number', description: '整包字符预算，默认 3000' },
      },
    },
    async run(args) {
      const b = await api('/boot', {
        user: String(args.user || CFG.defaultUser),
        maxChars: Number(args.maxChars) || undefined,
      }, 'POST');
      return { content: [{ type: 'text', text: '🧠 开机包（' + b.chars + ' 字 / 预算 ' + b.budget + '）：' + '\n\n' + b.text }] };
    },
  },
  {
    name: 'mem_intents',
    description: '承诺/待办账本。action=list 查看未闭环承诺与逾期项；action=add 记一条承诺（text 里带"明天下午三点""3小时后""周三"等中文时间会自动解析到期时间）；action=done 把某条标记完成（传 id）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list（默认）/ add / done' },
        text: { type: 'string', description: 'action=add 时的承诺内容' },
        id: { type: 'string', description: 'action=done 时的意图 id' },
        user: { type: 'string', description: '用户标识；不填用默认记忆空间' },
      },
    },
    async run(args) {
      const action = String(args.action || 'list').toLowerCase();
      const user = String(args.user || CFG.defaultUser || '');
      if (action === 'add') {
        const it = await api('/intent', { text: String(args.text || ''), user }, 'POST');
        const due = it.due_at ? '（' + new Date(it.due_at).toLocaleString('zh-CN') + ' 到期）' : '（无截止时间）';
        return { content: [{ type: 'text', text: `📌 记下了（${it.id}）：${it.text}${due}` }] };
      }
      if (action === 'done') {
        if (!args.id) return { content: [{ type: 'text', text: '需要提供要完成的意图 id（可先 action=list 查看）' }] };
        const r = await api('/intent/' + encodeURIComponent(String(args.id)) + '/resolve', { outcome: 'fulfilled' }, 'POST');
        return { content: [{ type: 'text', text: `✅ 已完成：${r.text}` }] };
      }
      const all = await api('/intents', null, 'GET');
      const own = (all.intents || []).filter((t) => !user || t.owner === 'u:' + user || t.owner === user || t.owner === 'global');
      const open = own.filter((t) => t.status === 'open' || t.status === 'overdue');
      if (!open.length) return { content: [{ type: 'text', text: '账本很干净：没有未闭环的承诺 ✅' }] };
      const lines = open.map((t) => {
        const due = t.due_at ? new Date(t.due_at).toLocaleString('zh-CN') : '无截止';
        return `- [${t.status === 'overdue' ? '已逾期' : '进行中'}] ${t.text}（${due}${t.evidence_hint ? '，' + t.evidence_hint : ''}）id=${t.id}`;
      });
      const overdue = open.filter((t) => t.status === 'overdue').length;
      return { content: [{ type: 'text', text: `📌 未闭环承诺 ${open.length} 条${overdue ? `（其中 ${overdue} 条已逾期）` : ''}：` + '\n' + lines.join('\n') }] };
    },
  },
  {
    name: 'mem_stats',
    description: '查看记忆库的规模：多少条记忆、什么类型、实体与关系数量。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const s = await api('/stats', null, 'GET');
      const kinds = Object.entries(s.kinds || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '空';
      let text = `📊 记忆库：${s.active} 条（归档 ${s.archived}）\n类型：${kinds}\n实体 ${s.entities} · 关系 ${s.relations}\n平均重要度 ${s.avgImportance}`;
      /* 到期提醒透出（借 ldo1um）：模型看到就能主动提醒用户 */
      if (s.remindersDue) text += `\n⏰ 有 ${s.remindersDue} 条承诺在 24 小时内到期或已过期——建议主动提醒用户处理`;
      return { content: [{ type: 'text', text }] };
    },
  },
];

/* ---------------- JSON-RPC over stdio（MCP 基本子集） ---------------- */
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  const reply = (result) => id !== undefined && write({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mind-sea-memory', version: '1.5.4' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `未知工具: ${name}`);
      try {
        const result = await tool.run((params && params.arguments) || {});
        return reply({ ...result, isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: '记忆工具执行失败: ' + (e.message || e) }], isError: true });
      }
    }
    default:
      return fail(-32601, 'method not found: ' + method);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line).catch((e) => logErr('处理请求出错: ' + e.message));
  }
});
process.stdin.on('end', () => process.exit(0));

logErr(`记忆星海 MCP 已启动：${TOOLS.length} 个工具（引擎 ${CFG.base}）`);
