#!/usr/bin/env node
/* ============================================================
 * test-v4.mjs —— 借 ldo1um 的四条机制回归（2026-10-31）
 *   ① hit 来源区分（light/full/none，防自污染）
 *   ② 纠错降权（errors 计数 → 检索降权 → 注入块标注）
 *   ③ 手写永久规则层（rules.md → 置顶注入）
 *   ④ 到期提醒（dueIntents 扫描 → 通知标记 → stats 透出）
 * ============================================================ */
'use strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MEMORY_DATA_DIR = path.join(os.tmpdir(), 'mind-sea-memory-v4-' + Date.now());
const store = await import('../lib/store.mjs');
const { recall, blockOf } = await import('../lib/engine.mjs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  ok ? pass++ : fail++;
}
const DAY = 86400000;

/* ---------- ① hit 来源区分 ---------- */
const a = store.insertMemory({ text: '用户养了一只叫团子的橘猫', kind: 'fact', importance: 0.7, owner: 'u:qq:10001', visibility: 'private', entities: ['团子'] });
/* 注意：insertMemory/getMemory 返回活引用，快照必须先存原始数值 */
const h0 = a.hits, l0 = a.last_hit;
await recall('团子', { owner: 'qq:10001', channel: 'private', k: 3, minScore: 0.1 });            // 默认 light
const afterLight = store.getMemory(a.id);
check('① light：hits 自增', afterLight.hits === h0 + 1, `${h0}→${afterLight.hits}`);
check('① light：last_hit 不动（新近度不被模型检索污染）', afterLight.last_hit === l0);
await recall('团子', { owner: 'qq:10001', channel: 'private', k: 3, minScore: 0.1, reinforce: 'full' });
const l1 = store.getMemory(a.id).last_hit;
check('① full：last_hit 前移（用户亲口再说才续命）', l1 > l0);
const hitsBefore = store.getMemory(a.id).hits;
await recall('团子', { owner: 'qq:10001', channel: 'private', k: 3, minScore: 0.1, reinforce: 'none' });
check('① none：纯只读，hits 不变', store.getMemory(a.id).hits === hitsBefore);

/* ---------- ② 纠错降权 ---------- */
const b = store.insertMemory({ text: '用户住在杭州', kind: 'fact', importance: 0.8, owner: 'u:qq:10001', visibility: 'private', entities: ['杭州'] });
const q = '用户住哪个城市';
const s0 = (await recall(q, { owner: 'qq:10001', channel: 'private', k: 5, minScore: 0.05, reinforce: 'none' })).find((h) => h.id === b.id)?.score;
store.markError(b.id);
const afterErr = (await recall(q, { owner: 'qq:10001', channel: 'private', k: 5, minScore: 0.05, reinforce: 'none' })).find((h) => h.id === b.id);
check('② 纠错：errors 计数随行', afterErr?.errors === 1, 'errors=' + afterErr?.errors);
check('② 纠错：分数被压低（×0.6）', s0 > 0 && afterErr.score < s0, `${s0} → ${afterErr.score}`);
check('② 纠错：注入块带（已被用户纠正）标注', blockOf([afterErr]).includes('已被用户纠正×1'));
check('② 纠错：markError 打折重要度且可审计', store.getMemory(b.id).importance < 0.8);

/* ---------- ③ 手写永久规则层 ---------- */
store.saveRules('# 相处规则\n- 永远不要提工作的事\n* 说话保持简短，可以玩梗\n\n# 隐私规则\n- 群里不提用户的私人住址');
const rules = store.listRules();
check('③ 规则：解析 3 条（注释与空行剔除）', rules.length === 3, JSON.stringify(rules));
const r2 = await recall('完全无关的查询词量子波动', { owner: 'qq:10001', channel: 'private', k: 3, minScore: 0.5, reinforce: 'none' });
check('③ 规则：零命中也随召回携带', Array.isArray(r2.rules) && r2.rules.length === 3);
const blk = blockOf(r2);
check('③ 规则：注入块置顶且带最高优先标注', blk.startsWith('【永久规则（最高优先，必须遵守）】'), blk.slice(0, 40));
check('③ 规则：空记忆时规则仍注入', blockOf(r2).includes('永远不要提工作的事'));

/* ---------- ④ 到期提醒 ---------- */
store.addIntent({ text: '帮用户订周五的蛋糕', owner: 'u:qq:10001', due_at: Date.now() + 2 * 3600e3 });   // 2h 后到期
store.addIntent({ text: '上周说好的复盘', owner: 'u:qq:10001', due_at: Date.now() - 2 * 3600e3 });      // 已过期
check('④ 提醒：stats 透出 remindersDue', store.stats().remindersDue >= 2, 'due=' + store.stats().remindersDue);
const due = store.dueIntents();
check('④ 提醒：扫描到 2 条未通知（含逾期）', due.length === 2, 'found=' + due.length);
store.markNotified(due.map((t) => t.id));
check('④ 提醒：通知后不再重复扫描', store.dueIntents().length === 0);
const far = store.addIntent({ text: '三个月后的事', owner: 'u:qq:10001', due_at: Date.now() + 90 * DAY });
check('④ 提醒：远期承诺不进 24h 窗口', !store.dueIntents().some((t) => t.id === far.id));

/* ---------- ⑤ 审计违规报告 + purgeDays 可配置 ---------- */
const s5 = store.load();
// 造一条 200 天前归档的记忆：purgeDays=0 时必须活着
const old5 = store.insertMemory({ text: '很久以前的旧事', kind: 'episode', importance: 0.2, owner: 'u:qq:10001', visibility: 'private', entities: [] });
old5.status = 'archived'; old5.archived_at = Date.now() - 200 * DAY;
// 造一条搁置 8 天的 pending 冲突（同 owner 同 fact_key 自动生成）
store.insertMemory({ text: '用户住在杭州', kind: 'fact', importance: 0.8, owner: 'u:qq:10002', visibility: 'private', entities: ['杭州'], fact_key: 'qq:10002.城市' });
store.insertMemory({ text: '用户搬到上海', kind: 'fact', importance: 0.8, owner: 'u:qq:10002', visibility: 'private', entities: ['上海'], fact_key: 'qq:10002.城市' });
s5.conflicts[s5.conflicts.length - 1].created_at = Date.now() - 8 * DAY;
// 造一条逾期 5 天的承诺
store.addIntent({ text: '拖了五天的约定', owner: 'u:qq:10002', due_at: Date.now() - 5 * DAY });

const n0 = (await import('../lib/engine.mjs')).nightly({ purgeDays: 0 });
check('⑤ purgeDays=0：归档 200 天也不物理删除（只进不出）', !!store.getMemory(old5.id), 'purged=' + n0.purged);
check('⑤ 违规报告：搁置冲突被巡查出', n0.violations.some((v) => v.type === 'conflict_stale' && v.days >= 8), JSON.stringify(n0.violations.map((v) => v.type)));
check('⑤ 违规报告：逾期承诺被巡查出', n0.violations.some((v) => v.type === 'intent_overdue' && v.days >= 5));
check('⑤ 违规报告持久化（/health 与体检页透出）', Array.isArray(store.load().lastViolations) && store.load().lastViolations.length >= 2);

/* ---------- ⑥ 情绪巩固 + 干扰衰减（修复后语义） ---------- */
const eA = store.insertMemory({ text: '结婚纪念日的惊喜场面', kind: 'episode', importance: 0.6, valence: 0.95, arousal: 0.8, owner: 'u:qq:10003', visibility: 'private', entities: ['纪念日'] });
const eB = store.insertMemory({ text: '日常买早饭的流水账', kind: 'episode', importance: 0.6, valence: 0, arousal: 0, owner: 'u:qq:10003', visibility: 'private', entities: ['早饭'] });
/* 干扰组：O 与 N 同实体且 N 更新 → O 衰减加快；C 实体独立 → 正常衰减 */
const day2 = Date.now() - 2 * 86400000;
const mO = store.insertMemory({ text: '旧版方案讨论记录', kind: 'episode', importance: 0.6, owner: 'u:qq:10003', visibility: 'private', entities: ['方案X'], created_at: day2 });
const mN = store.insertMemory({ text: '新版方案讨论记录', kind: 'episode', importance: 0.6, owner: 'u:qq:10003', visibility: 'private', entities: ['方案X'] });
const mC = store.insertMemory({ text: '独立主题的对照记录', kind: 'episode', importance: 0.6, owner: 'u:qq:10003', visibility: 'private', entities: ['独立Y'], created_at: day2 });
const n6 = (await import('../lib/engine.mjs')).nightly({ purgeDays: 0 });
const gA = store.getMemory(eA.id), gB = store.getMemory(eB.id);
check('⑥ 情绪巩固：情绪浓的衰减慢于中性（同起点）', gA.importance > gB.importance, `${gA.importance} vs ${gB.importance}`);
const gO = store.getMemory(mO.id), gC = store.getMemory(mC.id);
check('⑥ 干扰衰减：被同实体新记忆干扰的衰减更快（修复乘法方向）', gO.importance < gC.importance, `O=${gO.importance} vs C=${gC.importance}`);
const maxImp = Math.max(...store.load().memories.map((m) => m.importance));
check('⑥ 重要度恒不超 1（膨胀 bug 回归哨兵）', maxImp <= 1, 'max=' + maxImp);
check('⑥ nightly 结果带 violations 字段（结构回归）', Array.isArray(n6.violations));

/* ---------- ⑦ 证据链回归（2026-11-01 修复 appendEpisode 不返回 id） ---------- */
const ep7 = store.appendEpisode({ channel: 'private', user: 'qq:10001', text: '证据链自检原文', source: 'test' });
check('⑦ 证据链：appendEpisode 返回带 e 前缀 id 的完整行', !!ep7 && typeof ep7.id === 'string' && ep7.id.startsWith('e'), JSON.stringify(ep7 && ep7.id));
const m7 = store.insertMemory({ text: '带证据的记忆', kind: 'fact', importance: 0.5, owner: 'u:qq:10001', visibility: 'private', entities: [], evidence: { episode_id: ep7.id, snippet: '证据链自检原文' } });
check('⑦ 证据链：记忆可挂 evidence 并读回', (store.getMemory(m7.id).evidence || {}).episode_id === ep7.id);

/* ---------- 清理 ---------- */
store.flush();
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }

console.log('────────────────────────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
