#!/usr/bin/env node
/* ============================================================
 * doctor.mjs —— 部署体检（只读，不改任何东西）
 *
 *   node scripts/doctor.mjs
 *
 * 检查：Node 版本 / config.json / 数据目录可写 / 服务健康 /
 *      DSH 注册块 / MCP 握手与工具清单。
 * 退出码：0 = 核心项全过（警告不算失败）；1 = 有核心项失败。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
let criticalFail = 0;
const pass = (name, detail = '') => console.log(`${C.ok('✓')} ${name}${detail ? '  ' + C.dim(detail) : ''}`);
const fail = (name, detail = '') => { criticalFail++; console.log(`${C.err('✗')} ${name}${detail ? '  ' + detail : ''}`); };
const warn = (name, detail = '') => console.log(`${C.warn('!')} ${name}${detail ? '  ' + detail : ''}`);

/* 1. Node */
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? pass('Node 版本', process.versions.node) : fail('Node 版本过低', `${process.versions.node}（需要 ≥18）`);

/* 2. config.json */
const cfgPath = path.join(ROOT, 'config.json');
let cfg = null;
if (!fs.existsSync(cfgPath)) {
  warn('config.json 不存在', '可跑 node scripts/install.mjs 生成');
} else {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    pass('config.json 可解析', `端口 ${cfg.port || 8790}`);
  } catch (e) { fail('config.json 解析失败', e.message); }
}
const mask = (k) => (k ? k.slice(0, 6) + '****' + k.slice(-4) : '');
if (cfg) {
  if (cfg.llm?.apiKey) pass('LLM Key 已配置', mask(cfg.llm.apiKey));
  else warn('LLM 未配置', '/reflect 与智能抽取不可用（记忆存取不受影响）');
  if (cfg.upstream?.baseUrl) pass('上游代理已配置', cfg.upstream.baseUrl);
  else warn('/v1 代理未配置', '记忆存取不受影响');
  pass('默认用户', cfg.defaultUser || '(空)');
}

/* 3. 数据目录可写 */
const dataDir = path.join(ROOT, 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.doctor-probe');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  const brain = path.join(dataDir, 'brain.json');
  if (fs.existsSync(brain)) {
    const st = fs.statSync(brain);
    pass('数据目录可写', `brain.json ${(st.size / 1024).toFixed(0)} KB`);
  } else {
    pass('数据目录可写', '尚无 brain.json（首次写入时创建）');
  }
} catch (e) { fail('数据目录不可写', e.message); }

/* 4. 服务健康 */
const port = Number(cfg?.port) || 8790;
let health = null;
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
  health = (await res.json()).data;
} catch { /* down */ }
if (health) {
  pass('服务健康', `v${health.version} · 活跃记忆 ${health.active} · 待裁决冲突 ${health.pendingConflicts}`);
} else {
  warn('服务未运行', `node server.mjs（端口 ${port}）`);
}

/* 5. DSH 注册 */
function findDshHomes() {
  const cands = [process.env.DSH_HOME || '', path.join(os.homedir(), '.dsh'),
    'E:/DSH-data/dot-dsh', 'D:/DSH-data/dot-dsh', 'C:/DSH-data/dot-dsh'].filter(Boolean);
  return cands.filter((c) => { try { return fs.existsSync(path.join(c, 'profiles')); } catch { return false; } });
}
let registered = 0;
for (const home of findDshHomes()) {
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { }
  for (const p of profiles) {
    const f = path.join(home, 'profiles', p, 'cordis.patch.yml');
    try {
      const txt = fs.readFileSync(f, 'utf8');
      if (txt.includes('mind-sea-memory MCP BEGIN')) { pass(`DSH 注册（${p}）`, home); registered++; }
    } catch { /* no file */ }
  }
}
if (!registered) warn('未检测到 DSH 注册', 'node scripts/register-dsh.mjs desktop --home <DSH 数据目录>');

/* 6. MCP 握手 */
async function mcpCheck() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { child.kill(); } catch { } resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, reason: '握手超时（5s）' }), 5000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        } else if (msg.id === 2) {
          clearTimeout(timer);
          const names = (msg.result?.tools || []).map((t) => t.name);
          finish({ ok: names.length >= 5, reason: names.join(', ') });
        }
      }
    });
    child.on('error', (e) => finish({ ok: false, reason: e.message }));
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } },
    }) + '\n');
  });
}
const mcp = await mcpCheck();
mcp.ok ? pass('MCP 握手与工具', mcp.reason) : fail('MCP 握手失败', mcp.reason);

/* 汇总 */
console.log('');
if (criticalFail === 0) console.log(C.ok('体检通过：核心项全部正常 ✅'));
else console.log(C.err(`体检未通过：${criticalFail} 项核心检查失败`));
process.exit(criticalFail ? 1 : 0);
