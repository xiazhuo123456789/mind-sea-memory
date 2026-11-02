#!/usr/bin/env node
/* ============================================================
 * test-install.mjs —— 部署体系自测（只读，不改配置/数据）
 *   安装器 help / dry-run、体检脚本、部署文档完整性、
 *   安全约束（Key 不进 git、文档存在）
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  ok ? pass++ : fail++;
}
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });

/* 1. 安装器 --help */
const help = run(['scripts/install.mjs', '--help']);
check('安装器 --help 可运行', help.status === 0 && help.stdout.includes('一键部署'));

/* 2. 安装器 --dry-run（只打印计划，不改任何东西） */
const dry = run(['scripts/install.mjs', '--dry-run']);
check('安装器 --dry-run 退出码 0', dry.status === 0, 'status=' + dry.status);
check('dry-run 输出包含计划项', /计划/.test(dry.stdout) && /端口/.test(dry.stdout) && /DSH 注册/.test(dry.stdout));

/* 3. 体检脚本 */
const doc = run(['scripts/doctor.mjs']);
check('体检脚本可运行且核心项通过', doc.status === 0,
  (doc.stdout || '').split('\n').filter((l) => l.includes('✗')).join(' ') || 'ok');

/* 4. 部署文档完整性 */
const deploy = fs.readFileSync(path.join(ROOT, 'docs/DEPLOY.md'), 'utf8');
check('DEPLOY.md 含一键/提问式/手动三种方式', /一键/.test(deploy) && /提问式/.test(deploy) && /方式 D：手动/.test(deploy));
check('DEPLOY.md 含故障排查与安全须知', /故障排查/.test(deploy) && /安全须知/.test(deploy));
const ai = fs.readFileSync(path.join(ROOT, 'docs/AI_DEPLOY_PROMPT.md'), 'utf8');
check('AI_DEPLOY_PROMPT.md 含硬性规则与验收步骤', /硬性规则/.test(ai) && /验收/.test(ai) && /提示词开始/.test(ai));

/* 5. 安全约束 */
const gi = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
check('.gitignore 覆盖 config.json 与 data/', /config\.json/.test(gi) && /data\//.test(gi));
const tracked = spawnSync('git', ['ls-files', 'config.json', 'data'], { cwd: ROOT, encoding: 'utf8' });
check('config.json / data 未被 git 跟踪', !(tracked.stdout || '').trim(), (tracked.stdout || '').trim().slice(0, 60));

/* 6. 配置示例含新字段 */
const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
check('config.example.json 含 nightly 全字段', !!ex.nightly && 'freqWindowDays' in ex.nightly && 'kindCaps' in ex.nightly);
check('config.example.json 含 reminders', !!ex.reminders && 'webhook' in ex.reminders);

console.log('────────────────────────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
