#!/usr/bin/env node
/* ============================================================
 * test-v6.mjs —— 意图账本闭环（2026-11-01）
 *   中文时间解析 / 承诺自动认领 / 完成检测 / MCP mem_intents 的数据面
 * ============================================================ */
'use strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MEMORY_DATA_DIR = path.join(os.tmpdir(), 'mind-sea-memory-v6-' + Date.now());
const store = await import('../lib/store.mjs');
const { parseChineseTime, detectPromise, detectCompletion, linkIntent } = await import('../lib/intent.mjs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  ok ? pass++ : fail++;
}
const OWNER = 'u:qq:10001';
/* 固定"现在"：2026-11-01 10:00 本地时间，测试可复现 */
const NOW = new Date(2026, 10, 1, 10, 0, 0).getTime();
const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const dayOf = (ts) => new Date(ts).toDateString();
const hourOf = (ts) => new Date(ts).getHours();
const tomorrow = new Date(NOW + 86400000).toDateString();

/* ---------- ① 中文时间解析 ---------- */
const t1 = parseChineseTime('明天下午三点交报告', NOW);
check('① 明天下午三点 → 明天 15:00', !!t1 && dayOf(t1.at) === tomorrow && hourOf(t1.at) === 15, t1 ? fmt(t1.at) : 'null');

const t2 = parseChineseTime('大后天上午10点开会', NOW);
check('① 大后天上午10点 → 3 天后 10:00', !!t2 && dayOf(t2.at) === new Date(NOW + 3 * 86400000).toDateString() && hourOf(t2.at) === 10, t2 ? fmt(t2.at) : 'null');

const t3 = parseChineseTime('3小时后提醒我', NOW);
check('① 3小时后 → now+3h', !!t3 && Math.abs(t3.at - (NOW + 3 * 3600e3)) < 1000, t3 ? fmt(t3.at) : 'null');

const t4 = parseChineseTime('半小时后', NOW);
check('① "半小时后"不误判（无数字）', t4 === null, t4 ? fmt(t4.at) : 'null');

const t5 = parseChineseTime('周三下午两点', NOW);
check('① 周三下午两点 → 本周三 14:00', !!t5 && hourOf(t5.at) === 14 && new Date(t5.at).getDay() === 3, t5 ? fmt(t5.at) : 'null');

const t6 = parseChineseTime('下周三下午两点', NOW);
check('① 下周三 → 至少 7 天后且仍是周三', !!t6 && t6.at >= NOW + 7 * 86400000 && new Date(t6.at).getDay() === 3, t6 ? fmt(t6.at) : 'null');

const t7 = parseChineseTime('今晚8点', NOW);
check('① 今晚8点 → 今天 20:00（未过）', !!t7 && hourOf(t7.at) === 20, t7 ? fmt(t7.at) : 'null');

const t8 = parseChineseTime('今晚7点', NOW);
check('① 今晚7点 → 今天 19:00（未来）', !!t8 && dayOf(t8.at) === new Date(NOW).toDateString() && hourOf(t8.at) === 19, t8 ? fmt(t8.at) : 'null');
const t8b = parseChineseTime('今天早上8点', NOW);
check('① 已过的钟点 → 顺延到明天', !!t8b && dayOf(t8b.at) === tomorrow && hourOf(t8b.at) === 8, t8b ? fmt(t8b.at) : 'null');

const t9 = parseChineseTime('随便聊聊', NOW);
check('① 无时间词 → null', t9 === null);

/* ---------- ② 承诺认领 ---------- */
const p1 = detectPromise('别忘了明天下午三点交报告', NOW);
check('② 别忘了+时间+任务 → 认领且带截止', !!p1 && p1.due_at && hourOf(p1.due_at) === 15);

const p2 = detectPromise('我记得你爱吃香菜', NOW);
check('② 过去回忆不算承诺', p2 === null);

const p3 = detectPromise('明天要去面试', NOW);
check('② 时间+任务动词 → 认领', !!p3);

const p4 = detectPromise('今天天气不错', NOW);
check('② 闲话不认领', p4 === null);

const p5 = detectPromise('答应你周末陪你去爬山', NOW);
check('② 答应 → 认领（无具体时间也可建待办）', !!p5 && p5.due_at == null);

/* ---------- ③ 完成检测 ---------- */
check('③ "报告搞定了" → 完成', detectCompletion('报告搞定了'));
check('③ "还没搞定" → 不算完成', !detectCompletion('还没搞定'));
check('③ "已经发过去了" → 完成', detectCompletion('已经发过去了'));

/* ---------- ④ linkIntent 闭环 ---------- */
const r1 = linkIntent({ owner: OWNER, text: '别忘了明天下午三点交报告', now: NOW });
check('④ 认领：新建意图并带截止', r1.action === 'created' && r1.intent.due_at != null, r1.action);
const before = store.listIntents().length;
const r2 = linkIntent({ owner: OWNER, text: '别忘了明天下午三点交报告', now: NOW });
check('④ 去重：同一承诺不重复建', r2.action === 'duplicate' && store.listIntents().length === before, r2.action);

const r3 = linkIntent({ owner: OWNER, text: '报告搞定了，已经发过去了', now: NOW + 3600e3 });
check('④ 完成：自动匹配并闭环', r3.action === 'resolved' && r3.intent.status === 'fulfilled', `${r3.action}/${r3.intent?.status}`);

const r4 = linkIntent({ owner: OWNER, text: '完全无关的一句话', now: NOW });
check('④ 无关文本 → none', r4.action === 'none');

/* ---------- ⑤ 账本状态 ---------- */
store.addIntent({ text: '三天后交周报', owner: OWNER, due_at: NOW + 3 * 86400000 });
const list = store.listIntents().filter((t) => t.status !== 'fulfilled' && t.status !== 'missed');
check('⑤ 未闭环列表可读', list.length >= 1, 'open=' + list.length);
const overdueOne = store.addIntent({ text: '昨天的作业', owner: OWNER, due_at: NOW - 86400000 });
const listed = store.listIntents().find((t) => t.id === overdueOne.id);
check('⑤ 过期自动标记 overdue', listed.status === 'overdue' && listed.overdue === true);

/* ---------- 清理 ---------- */
store.flush();
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }

console.log('────────────────────────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
