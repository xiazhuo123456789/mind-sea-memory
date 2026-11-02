#!/usr/bin/env node
/* MCP stdio 握手实测：模拟 DSH 启动加载 mcp-server.mjs 的完整过程
 * initialize → tools/list → tools/call(mem_stats) → tools/call(mem_remember→mem_recall) */
'use strict';
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['mcp-server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

let nextId = 0;
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(method + ' 超时')), 20000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
}

/* 1. initialize */
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'dsh-mcp-client-sim', version: '1.0.0' },
});
check('initialize', init.result?.serverInfo?.name === 'mind-sea-memory',
  'serverInfo=' + JSON.stringify(init.result?.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

/* 2. tools/list */
const list = await rpc('tools/list', {});
const tools = (list.result?.tools || []).map((t) => t.name);
check('tools/list', ['mem_recall', 'mem_remember', 'mem_boot', 'mem_intents', 'mem_stats'].every((t) => tools.includes(t)),
  tools.join(', '));

/* 3. mem_stats */
const stats = await rpc('tools/call', { name: 'mem_stats', arguments: {} });
const statsOk = stats.result?.content?.[0]?.text?.includes('记忆库');
check('mem_stats', statsOk, (stats.result?.content?.[0]?.text || '').slice(0, 60));

/* 4. 写入→召回 闭环（defaultUser 兜底路径） */
const stamp = '记忆星海MCP自检' + Date.now();
const rem = await rpc('tools/call', { name: 'mem_remember', arguments: { text: stamp + '：用户最喜欢的测试句是苹果踩香蕉', kind: 'fact' } });
check('mem_remember', (rem.result?.content?.[0]?.text || '').includes('ok') || rem.result?.content?.[0]?.text,
  (rem.result?.content?.[0]?.text || '').slice(0, 60));

const rec = await rpc('tools/call', { name: 'mem_recall', arguments: { query: '苹果踩香蕉' } });
check('mem_recall（能召回刚写入）', (rec.result?.content?.[0]?.text || '').includes('苹果踩香蕉'),
  (rec.result?.content?.[0]?.text || '').slice(0, 60));

child.kill();
console.log(fail ? `\n${fail} 项失败` : '\nMCP 全链路自检通过——DSH 启动即挂载 ✅');
process.exit(fail ? 1 : 0);
