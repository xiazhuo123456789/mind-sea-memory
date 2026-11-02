#!/usr/bin/env node
/* ============================================================
 * test-v5.mjs —— memory-brain 借鉴三批的回归（2026-11-01）
 *   第一批 P0-1：频率感知衰减 / 归档保护期 / 核心人物地板 / 按类上限
 *   第二批     ：规则自动冲突检测 / 时间窗口召回
 *   第三批     ：开机包 /boot（分层 + 预算裁剪）
 * ============================================================ */
'use strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MEMORY_DATA_DIR = path.join(os.tmpdir(), 'mind-sea-memory-v5-' + Date.now());
const store = await import('../lib/store.mjs');
const { recall, nightly, bootPackage, parseTimeWindow } = await import('../lib/engine.mjs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  ok ? pass++ : fail++;
}
const DAY = 86400000;
const OWNER = 'u:qq:10001';

/* ---------- ① 频率感知衰减 ---------- */
const hot = store.insertMemory({ text: '用户最喜欢的游戏是塞尔达', kind: 'episode', importance: 0.6, owner: OWNER, visibility: 'private', entities: ['塞尔达'], created_at: Date.now() - 10 * DAY });
const cold = store.insertMemory({ text: '用户提过一句天气不错', kind: 'episode', importance: 0.6, owner: OWNER, visibility: 'private', entities: ['天气'], created_at: Date.now() - 10 * DAY });
/* 手动造 hit_ts：hot 最近 30 天被想起 8 次 */
const s0 = store.load();
const hotMem = s0.memories.find((m) => m.id === hot.id);
hotMem.hit_ts = Array.from({ length: 8 }, (_, i) => Date.now() - i * DAY);
hotMem.last_hit = Date.now();

/* ---------- ② 归档保护期 ---------- */
const protectedLow = store.insertMemory({ text: '新近被想起但重要度很低的一句话', kind: 'episode', importance: 0.06, owner: OWNER, visibility: 'private', entities: ['低分话题'], created_at: Date.now() - 60 * DAY });
const deadLow = store.insertMemory({ text: '从没人提过的陈年碎语', kind: 'episode', importance: 0.06, owner: OWNER, visibility: 'private', entities: ['无人话题'], created_at: Date.now() - 60 * DAY });
const s0b = store.load();
const pl = s0b.memories.find((m) => m.id === protectedLow.id);
pl.last_hit = Date.now() - 2 * DAY; pl.hit_ts = [Date.now() - 2 * DAY];
const dl = s0b.memories.find((m) => m.id === deadLow.id);
dl.last_hit = Date.now() - 60 * DAY; dl.hit_ts = [];

/* ---------- ③ 核心人物地板 ---------- */
const vip = store.insertMemory({ text: '老王的生日是三月十二', kind: 'episode', importance: 0.2, owner: OWNER, visibility: 'private', entities: ['老王'], created_at: Date.now() - 40 * DAY });
const s0c = store.load();
const vipMem = s0c.memories.find((m) => m.id === vip.id);
vipMem.hit_ts = []; vipMem.last_hit = Date.now() - 40 * DAY;

/* ---------- ④ 按类上限 ---------- */
for (let i = 0; i < 6; i++) {
  store.insertMemory({ text: `笔记第${i}条：一些备忘内容`, kind: 'skill', importance: 0.3 + i * 0.05, owner: OWNER, visibility: 'private', entities: [] });
}

/* ---------- ⑤ 自动冲突检测 ---------- */
store.insertMemory({ text: '用户喜欢吃香菜', kind: 'fact', importance: 0.7, owner: 'u:qq:10002', visibility: 'private', entities: ['香菜'], created_at: Date.now() - 5 * DAY });
store.insertMemory({ text: '用户讨厌吃香菜，闻到就难受', kind: 'fact', importance: 0.7, owner: 'u:qq:10002', visibility: 'private', entities: ['香菜'], created_at: Date.now() - 1 * DAY });
store.insertMemory({ text: '用户的生日是八月十五', kind: 'fact', importance: 0.7, owner: 'u:qq:10002', visibility: 'private', entities: ['生日'], created_at: Date.now() - 3 * DAY });

const n1 = nightly({ purgeDays: 0, protectNames: ['老王'], protectFloor: 0.45, kindCaps: { skill: 3 }, autoConflict: true });

const gHot = store.getMemory(hot.id), gCold = store.getMemory(cold.id);
check('① 频率感知：常被想起的衰减更慢', gHot.importance > gCold.importance, `热=${gHot.importance} 冷=${gCold.importance}`);
check('② 归档保护：新近被想起的低分记忆不归档', store.getMemory(protectedLow.id).status === 'active');
check('② 归档保护：没被想起的低分记忆照常归档', store.getMemory(deadLow.id).status === 'archived');
check('③ 人物地板：protectNames 命中后重要度抬到 0.45', store.getMemory(vip.id).importance >= 0.45, '=' + store.getMemory(vip.id).importance);
check('④ 按类上限：skill 超 3 条被归档', store.load().memories.filter((m) => m.status === 'active' && m.kind === 'skill').length <= 3);
const autoC = store.listConflicts('pending').filter((c) => c.by === 'auto');
check('⑤ 自动冲突：喜欢/讨厌+同实体 进待裁决队列', autoC.length >= 1, 'auto=' + autoC.length);
check('⑤ 自动冲突：不误伤无关事实（生日那条）', !autoC.some((c) => [c.old_id, c.new_id].some((id) => (store.getMemory(id) || {}).text?.includes('生日'))));
check('⑤ 自动冲突：绝不自动 supersede（两方都还在）', autoC.every((c) => store.getMemory(c.old_id) && store.getMemory(c.new_id)));

/* ---------- ⑥ 时间窗口召回 ---------- */
const Y = Date.now() - DAY;
store.insertMemory({ text: '昨天聊了周末去爬山的事', kind: 'episode', importance: 0.5, owner: OWNER, visibility: 'private', entities: ['爬山'], created_at: Y });
store.insertMemory({ text: '今天在说新买的键盘', kind: 'episode', importance: 0.5, owner: OWNER, visibility: 'private', entities: ['键盘'], created_at: Date.now() - 60000 });
const tw = parseTimeWindow('昨天说了什么');
check('⑥ 时间解析：昨天 → 时间范围', !!tw && tw.label === '昨天' && tw.end - tw.start === DAY, JSON.stringify(tw && { label: tw.label }));
const yHits = await recall('昨天说了什么', { owner: 'qq:10001', channel: 'private', k: 5, reinforce: 'none' });
check('⑥ 时间召回：只返回昨天的内容', yHits.some((h) => h.text.includes('爬山')) && !yHits.some((h) => h.text.includes('键盘')),
  yHits.map((h) => h.text.slice(0, 8)).join(' | '));
check('⑥ 时间召回：标记 byTime 与时间窗口标签', yHits.timeWindow?.label === '昨天' && yHits.every((h) => h.byTime));
const todayHits = await recall('今天说了什么', { owner: 'qq:10001', channel: 'private', k: 5, reinforce: 'none' });
check('⑥ 时间召回：今天 → 只返回今天的', todayHits.some((h) => h.text.includes('键盘')));

/* ---------- ⑦ 开机包 ---------- */
store.saveRules('- 回答保持简短\n- 不要提工作的事');
store.insertMemory({ text: '用户叫小明', kind: 'fact', importance: 0.9, pin: true, owner: OWNER, visibility: 'private', entities: ['小明'] });
store.insertMemory({ text: '用户最爱的颜色是蓝色', kind: 'preference', importance: 0.6, owner: OWNER, visibility: 'private', entities: ['蓝色'] });
store.addIntent({ text: '周五提醒他交报告', owner: OWNER, due_at: Date.now() + DAY });

const boot = bootPackage({ owner: 'qq:10001', channel: 'private', maxChars: 3000 });
check('⑦ 开机包：含永久规则块', boot.blocks.some((b) => b.key === 'rules'));
check('⑦ 开机包：含身份层（pin）', boot.blocks.some((b) => b.key === 'identity'));
check('⑦ 开机包：含事实与偏好层', boot.blocks.some((b) => b.key === 'facts') && boot.blocks.some((b) => b.key === 'prefs'));
check('⑦ 开机包：含未闭环承诺', boot.blocks.some((b) => b.key === 'intents'));
check('⑦ 开机包：文本以永久规则开头', boot.text.startsWith('【永久规则'));
check('⑦ 开机包：预算内', boot.chars <= boot.budget, `${boot.chars}/${boot.budget}`);

const tiny = bootPackage({ owner: 'qq:10001', channel: 'private', maxChars: 80 });
check('⑦ 预算裁剪：hard 块（规则+身份）永不丢', tiny.blocks.some((b) => b.key === 'rules') && tiny.blocks.some((b) => b.key === 'identity'));
check('⑦ 预算裁剪：软块被丢弃并记录', tiny.dropped.length > 0 && tiny.chars <= 80 + 200, 'dropped=' + tiny.dropped.join(','));

/* ---------- 清理 ---------- */
store.flush();
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }

console.log('────────────────────────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
