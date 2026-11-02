#!/usr/bin/env node
/* ============================================================
 * install.mjs —— 一键 / 提问式部署
 *
 *   node scripts/install.mjs                 # 提问式（逐项确认）
 *   node scripts/install.mjs --yes           # 全默认，不停顿
 *   node scripts/install.mjs --yes --key sk-xxx --register-dsh --dsh-home E:\DSH-data\dot-dsh
 *   node scripts/install.mjs --dry-run       # 只打印计划，不改任何东西
 *   node scripts/install.mjs --check         # 只做部署体检（等同 doctor）
 *
 * 做的事：环境检查 → 生成 config.json →（可选）灌演示数据 →
 *        （可选）注册进 DSH →（可选）后台启动 → 健康验证 → 打印验收清单。
 * 幂等：重复运行不会覆盖已有配置（只补缺项），不会重复注册。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name, dflt = '') => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const YES = has('--yes') || has('-y');
const DRY = has('--dry-run');
const CHECK = has('--check');
const START = has('--start') || (!has('--no-start') && YES);
const REGISTER = has('--register-dsh') || (!has('--no-register-dsh') && YES);
const SEED = Number(val('--seed', '0')) || 0;
const KEY = val('--key', '');
const PORT = Number(val('--port', '0')) || 0;
const PROFILE = val('--profile', '');
const DSH_HOME_ARG = val('--dsh-home', '');

if (has('--help') || has('-h')) {
  console.log(`记忆星海 一键部署

  node scripts/install.mjs                 提问式安装
  node scripts/install.mjs --yes           全默认安装
  node scripts/install.mjs --yes --key sk-xxx --register-dsh --dsh-home E:\\DSH-data\\dot-dsh
  node scripts/install.mjs --dry-run       只看计划
  node scripts/install.mjs --check         部署体检

选项：
  --port 8790        监听端口
  --key sk-xxx       DeepSeek Key（写入 llm+upstream）
  --seed 3000        灌入 N 条演示记忆（会覆盖 data/brain.json）
  --register-dsh     注册进 DSH 的 cordis.patch.yml
  --dsh-home PATH    DSH 数据目录（默认自动探测）
  --profile desktop  DSH profile 名
  --no-start         不自动后台启动
  --dry-run / --check
`);
  process.exit(0);
}

const say = (s = '') => console.log(s);
const step = (n, s) => say(`\n${C.b(`[${n}]`)} ${s}`);

/* ---------------- 工具 ---------------- */
function nodeMajor() { return Number(process.versions.node.split('.')[0]); }

function findDshHome(explicit = '') {
  const cands = [
    explicit,
    process.env.DSH_HOME || '',
    path.join(os.homedir(), '.dsh'),
    'E:/DSH-data/dot-dsh',
    'D:/DSH-data/dot-dsh',
    'C:/DSH-data/dot-dsh',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'profiles'))) return c;
    } catch { /* ignore */ }
  }
  return '';
}

function findProfile(home) {
  try {
    const dirs = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
    if (dirs.includes('desktop')) return 'desktop';
    return dirs[0] || 'desktop';
  } catch { return 'desktop'; }
}

async function health(port, timeoutMs = 1200) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json();
    return j.status === 'ok' ? j.data : null;
  } catch { return null; }
}

async function waitHealth(port, secs = 15) {
  const until = Date.now() + secs * 1000;
  while (Date.now() < until) {
    const h = await health(port);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function runChild(script, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true,
  });
  return r.status === 0;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  say(C.b('\n🌌 记忆星海 · 部署向导'));
  say(C.dim(`仓库：${ROOT}`));

  if (CHECK) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/doctor.mjs')], { cwd: ROOT, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  /* 0. 环境检查 */
  step(0, '环境检查');
  if (nodeMajor() < 18) {
    say(C.err(`✗ Node 版本过低：${process.versions.node}（需要 ≥ 18）`));
    process.exit(1);
  }
  say(C.ok(`✓ Node ${process.versions.node}`));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  say(C.dim(`  包名 ${pkg.name} v${pkg.version} · 依赖 ${Object.keys(pkg.dependencies || {}).length} 个（零依赖）`));

  /* 交互问答 */
  let port = PORT;
  let key = KEY;
  let register = REGISTER;
  let seedN = SEED;
  let start = START;
  let dshHome = DSH_HOME_ARG;
  let profile = PROFILE;

  const detectedHome = findDshHome(dshHome);
  const detectedProfile = detectedHome ? findProfile(detectedHome) : 'desktop';

  if (!YES && !DRY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!port) {
        const a = await rl.question(`监听端口（默认 8790）：`);
        port = Number(a.trim()) || 8790;
      } else port = port || 8790;
      if (!key) {
        say(C.dim('DeepSeek Key 可留空：留空则不启用 LLM 抽取/反思//v1 代理（记忆存取不受影响）'));
        const a = await rl.question('DeepSeek API Key（直接回车跳过）：');
        key = a.trim();
      }
      if (!has('--register-dsh') && !has('--no-register-dsh')) {
        const hint = detectedHome ? `检测到 DSH：${detectedHome}` : '未检测到 DSH 数据目录';
        const a = await rl.question(`是否注册进 DSH 的 MCP？（${hint}）[Y/n]：`);
        register = !/^n/i.test(a.trim());
      }
      if (register && !dshHome) {
        const a = await rl.question(`DSH 数据目录（回车用 ${detectedHome || '未检测到，跳过注册'}）：`);
        dshHome = a.trim() || detectedHome;
        register = !!dshHome;
      }
      profile = profile || detectedProfile;
      if (!SEED && has('--seed') === false) {
        const a = await rl.question('是否灌入 3000 条演示记忆先看星海效果？（会覆盖 data/brain.json）[y/N]：');
        seedN = /^y/i.test(a.trim()) ? 3000 : 0;
      }
      if (!has('--start') && !has('--no-start')) {
        const a = await rl.question('现在后台启动服务？[Y/n]：');
        start = !/^n/i.test(a.trim());
      }
    } finally { rl.close(); }
  }

  port = port || 8790;
  profile = profile || 'desktop';

  /* 计划预览 */
  if (DRY) {
    step(1, '计划（dry-run，不改任何文件）');
    say(`  端口            ${port}`);
    say(`  config.json     ${fs.existsSync(path.join(ROOT, 'config.json')) ? '已存在（只补缺项）' : '将创建'}`);
    say(`  LLM Key         ${key ? '将写入' : '不配置'}`);
    say(`  演示数据        ${SEED ? `灌入 ${SEED} 条` : '不灌'}`);
    say(`  DSH 注册        ${REGISTER && (dshHome || detectedHome) ? `是（${dshHome || detectedHome} / ${profile}）` : '否'}`);
    say(`  启动服务        ${START ? '是' : '否'}`);
    say('\n执行：去掉 --dry-run 即可。');
    return;
  }

  /* 1. 配置 */
  step(1, '生成配置');
  const cfgPath = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); say(C.dim('  已有 config.json，保留现有内容')); } catch { cfg = {}; }
  } else if (fs.existsSync(examplePath)) {
    cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    say(C.ok('✓ 从 config.example.json 生成 config.json'));
  }
  cfg.port = port;
  if (key) {
    cfg.llm = Object.assign({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, cfg.llm, { apiKey: key });
    cfg.upstream = Object.assign({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, cfg.upstream, { apiKey: key });
    say(C.ok('✓ 已写入 llm + upstream（Key 不会进 git）'));
  } else if (cfg.llm?.apiKey) {
    const k = cfg.llm.apiKey;
    say(C.ok('✓ 沿用已有 LLM Key') + C.dim(`  ${k.slice(0, 6)}****${k.slice(-4)}`));
  } else {
    say(C.dim('  LLM 未配置：记忆存取正常，反思/智能抽取走规则兜底'));
  }
  if (!cfg.defaultUser) cfg.defaultUser = 'dsh:main';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  say(C.ok('✓ config.json 就绪'));

  /* 2. 演示数据（可选） */
  if (seedN > 0) {
    step(2, `灌入 ${seedN} 条演示记忆`);
    if (!runChild('scripts/seed-demo.mjs', [String(seedN)])) {
      say(C.warn('⚠ 演示数据生成失败（可稍后手动：node scripts/seed-demo.mjs 3000）'));
    }
  } else {
    step(2, '演示数据：跳过');
  }

  /* 3. 注册进 DSH（可选） */
  if (register) {
    const home = dshHome || detectedHome;
    step(3, '注册进 DSH');
    if (!home) {
      say(C.warn('⚠ 未找到 DSH 数据目录，跳过。可稍后手动：'));
      say(C.dim('   node scripts/register-dsh.mjs desktop --home <你的 .dsh 数据目录>'));
    } else {
      const okReg = runChild('scripts/register-dsh.mjs', [profile, '--home', home]);
      if (okReg) say(C.ok(`✓ 已注册（${home} / ${profile}），重启 DSH 后生效`));
    }
  } else {
    step(3, 'DSH 注册：跳过');
  }

  /* 4. 启动（可选） */
  step(4, '启动服务');
  let h = await health(port);
  if (h) {
    say(C.ok(`✓ ${port} 端口已有服务在跑（v${h.version}，活跃记忆 ${h.active} 条）`));
  } else if (start) {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    h = await waitHealth(port, 15);
    if (h) say(C.ok(`✓ 已后台启动 v${h.version}（PID ${child.pid}）`));
    else say(C.err('✗ 启动后健康检查未通过，请手动运行 node server.mjs 查看报错'));
  } else {
    say(C.dim('  未启动。手动启动：node server.mjs'));
  }

  /* 5. 验收清单 */
  step(5, '验收清单');
  const portOk = !!h;
  const keyOk = !!(cfg.llm && cfg.llm.apiKey);
  const reg = register && (dshHome || detectedHome);
  say(`  ${portOk ? C.ok('✓') : C.err('✗')} 服务健康      http://127.0.0.1:${port}/health`);
  say(`  ${portOk ? C.ok('✓') : C.dim('·')} 3D 面板       http://127.0.0.1:${port}/panel`);
  if (keyOk) say(`  ${C.ok('✓')} LLM 已配置    /reflect 与 /v1 可用`);
  else say(`  ${C.dim('·')} LLM 未配置    只影响反思/智能抽取（之后填 config.json llm.apiKey 即可）`);
  if (reg) say(`  ${C.ok('✓')} DSH 已注册    重启 DSH 后搜索 mcp__mind-sea-memory__ 验证`);
  else say(`  ${C.dim('·')} DSH 未注册    可跑 node scripts/register-dsh.mjs <profile> --home <dir>`);

  say('\n' + C.b('下一步：'));
  if (reg) say('  1. 完整退出并重新打开 DSH → 在对话框里说「记住，我的游戏ID是夜风」→ 再问「我的游戏ID是什么」');
  say(`  ${reg ? 2 : 1}. 打开面板看星海：http://127.0.0.1:${port}/panel`);
  say(`  ${reg ? 3 : 2}. 随时体检：node scripts/install.mjs --check`);
  say(C.dim('\n文档：docs/DEPLOY.md（完整部署手册） · docs/AI_DEPLOY_PROMPT.md（丢给 AI 的部署提示词）'));
}

main().catch((e) => {
  console.error(C.err('部署失败：' + e.message));
  process.exit(1);
});
