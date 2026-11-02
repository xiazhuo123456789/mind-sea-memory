#!/usr/bin/env node
/* ============================================================
 * register-dsh.mjs —— 把记忆星海的 MCP 服务器注册进 DSH
 *
 *   node scripts/register-dsh.mjs <profile>          注册（幂等）
 *   node scripts/register-dsh.mjs <profile> --remove 移除
 *
 * 与 qq-bridge / SurfCore / 插件市场的注册脚本同一机制：
 * cordis.patch.yml 顶层 YAML 数组 + 注释块管理，互不覆盖。
 * 注册后必须完整退出并重启 DSH 才生效。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const BEGIN = '# === mind-sea-memory MCP BEGIN ===';
const END = '# === mind-sea-memory MCP END ===';

const yamlSingleQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function managedBlock() {
  const node = process.execPath;
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.mjs');
  return [BEGIN,
    '- insert:',
    '    - id: mcp-mind-sea-memory',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: mind-sea-memory',
    '        transport: stdio',
    '        command: ' + yamlSingleQuote(node),
    '        args:',
    '          - ' + yamlSingleQuote(script),
    '        toolCallTimeoutMs: 120000',
    END, ''].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const homeIdx = args.indexOf('--home');
  /* 位置参数 = 不带 -- 前缀、且不是 --home 的取值 */
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== homeIdx + 1);
  const profile = positional[0] || 'desktop';
  /* 家目录优先级：--home 参数 > DSH_HOME 环境变量 > ~/.dsh
   * （便携部署常把数据盘指到别处，如 E:\DSH-data\dot-dsh） */
  const home = (homeIdx >= 0 && args[homeIdx + 1]) || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || os.homedir(), '.dsh');
  const dir = path.join(home, 'profiles', profile);
  const file = path.join(dir, 'cordis.patch.yml');

  if (!fs.existsSync(dir)) {
    console.error(`profile 目录不存在：${dir}`);
    console.error('可指定实际数据盘位置重跑，例如：');
    console.error('  node scripts/register-dsh.mjs desktop --home E:\\DSH-data\\dot-dsh');
    process.exit(1);
  }

  let lines = [];
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    lines = raw.split('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, file + '.' + stamp + '.bak');
    console.log('已备份原文件 → ' + file + '.' + stamp + '.bak');
    const out = [];
    let inBlock = false;
    for (const l of lines) {
      if (l.trim() === BEGIN) { inBlock = true; continue; }
      if (l.trim() === END) { inBlock = false; continue; }
      if (!inBlock) out.push(l);
    }
    lines = out;
  } else {
    console.log('cordis.patch.yml 不存在，将新建：' + file);
  }

  if (!remove) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    fs.writeFileSync(file, (lines.length ? lines.join('\n') + '\n\n' : '') + managedBlock());
    console.log('✅ 已把记忆星海注册进 DSH（serverName: mind-sea-memory）');
  } else {
    fs.writeFileSync(file, lines.join('\n'));
    console.log('✅ 已从 DSH 移除记忆星海注册');
  }

  console.log('配置文件：' + file);
  console.log('⚠️  MCP 只在 DSH 启动时加载——请【完整退出 DSH 并重新打开】，');
  console.log('   然后在 DSH 里搜索 mcp__mind-sea-memory__ 验证工具已挂上。');
}

main();
