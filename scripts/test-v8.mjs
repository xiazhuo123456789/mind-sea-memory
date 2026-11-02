#!/usr/bin/env node
/* ============================================================
 * test-v8.mjs —— L1 会话缓冲 + L4 状态层（2026-11-01）
 * ============================================================ */
'use strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MEMORY_DATA_DIR = path.join(os.tmpdir(), 'mind-sea-memory-v8-' + Date.now());
const store = await import('../lib/store.mjs');
const l1 = await import('../lib/buffer.mjs');
const mood = await import('../lib/state.mjs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  ok ? pass++ : fail++;
}
const OWNER = 'u:qq:10001';
const NOW = Date.now();

/* ---------- ① L1 缓冲：闲聊进缓冲、满了压缩 ---------- */
l1.configBuffer({ maxItems: 3, maxChars: 900, llm: null });   // 测试环境无 LLM → 拼接摘要
const r1 = await l1.addBuffered({ owner: OWNER, rec: { text: '今天上班好累啊', kind: 'episode', importance: 0.35, entities: ['上班'] }, episodeId: 'e000001', now: NOW });
check('① 闲聊进缓冲（未直插）', r1.action === 'buffered');
const r2 = await l1.addBuffered({ owner: OWNER, rec: { text: '中午吃了麻辣烫', kind: 'episode', importance: 0.3, entities: ['麻辣烫'] }, episodeId: 'e000002', now: NOW });
check('① 未满继续缓冲', r2.action === 'buffered');
const r3 = await l1.addBuffered({ owner: OWNER, rec: { text: '晚上打算早点睡', kind: 'episode', importance: 0.3, entities: [] }, episodeId: 'e000003', now: NOW });
check('① 攒满 3 条触发压缩', r3.action === 'flushed' && !!r3.memory, r3.action);
check('① 摘要是单条 episode 且标 summary', r3.memory.kind === 'episode' && r3.memory.meta?.summary === true, r3.memory.text.slice(0, 30));
check('① 摘要带证据链（最后一条 episode）', (r3.memory.evidence || {}).episode_id === 'e000003');
check('① 摘要实体是并集', r3.memory.entities.includes('上班') && r3.memory.entities.includes('麻辣烫'));
check('① 缓冲清空', l1.pendingCount() === 0);

/* ---------- ② 高优直通 ---------- */
const r4 = await l1.addBuffered({ owner: OWNER, rec: { text: '我的游戏ID是夜风', kind: 'fact', importance: 0.8, pin: true, entities: ['夜风'] }, episodeId: 'e000004', now: NOW });
check('② 高优直通（返回 direct，由调用方立即插入）', r4.action === 'direct');
store.insertMemory({ text: r4 && '我的游戏ID是夜风', kind: 'fact', importance: 0.8, pin: true, owner: OWNER, visibility: 'private', entities: ['夜风'], evidence: { episode_id: 'e000004', snippet: '我的游戏ID是夜风' } });
check('② 调用方插入后库里立即可查', store.load().memories.some((m) => m.text.includes('夜风')));

/* ---------- ③ LLM 失败回退拼接（上面已隐含），再验证无 LLM 摘要格式 ---------- */
check('③ 无 LLM 时摘要带【会话摘要】前缀', r3.memory.text.startsWith('【'));

/* ---------- ③b 结构化记忆直通（不丢 fact_key） ---------- */
const r5 = await l1.addBuffered({ owner: OWNER, rec: { text: '用户住在杭州', kind: 'fact', importance: 0.4, fact_key: 'qq:10001.城市', entities: ['杭州'] }, episodeId: 'e000005', now: NOW });
check('③b fact 即使重要度低也直通（保 fact_key）', r5.action === 'direct');
const r6 = await l1.addBuffered({ owner: OWNER, rec: { text: '用户喜欢蓝色', kind: 'preference', importance: 0.3, entities: ['蓝色'] }, episodeId: 'e000006', now: NOW });
check('③b preference 也直通', r6.action === 'direct');

/* ---------- ③c 退出同步冲刷 ---------- */
l1.configBuffer({ maxItems: 6, maxChars: 900, llm: null });
await l1.addBuffered({ owner: 'u:qq:20002', rec: { text: '同步冲刷测试的闲聊', kind: 'episode', importance: 0.3, entities: [] }, episodeId: 'e000007', now: NOW });
const beforeSync = store.load().memories.length;
l1.flushAllSync(NOW);
const afterSync = store.load().memories;
check('③c flushAllSync 同步落库', afterSync.length === beforeSync + 1 && afterSync[afterSync.length - 1].meta?.summary === true);
check('③c 同步摘要无双前缀', !afterSync[afterSync.length - 1].text.includes('会话摘要】【会话摘要'));

/* ---------- ④ 状态层：刺激、回落、标签 ---------- */
mood.resetState(OWNER, NOW);
const s1 = mood.tickState(OWNER, '今天好累啊，加班到现在，压力好大', NOW);
check('④ 负面刺激 → 压力上升', s1.dims.stress > 0.25, 'stress=' + s1.dims.stress);
check('④ 累/加班 → 精力下降', s1.dims.energy < 0.6, 'energy=' + s1.dims.energy);
const s2 = mood.tickState(OWNER, '哈哈谢谢你陪我', NOW + 60e3);
check('④ 亲密刺激 → 亲密上升', s2.dims.intimacy > 0.35, 'intimacy=' + s2.dims.intimacy);
check('④ 输出情绪标签与行为倾向', !!s2.label && s2.tendencies['黏人度'] != null, s2.label);

/* 回落：6 小时无交互 → 向基线回落 */
const s3 = mood.view(OWNER, NOW + 6 * 3600e3);
check('④ 时间回落：6 小时后压力明显下降', s3.dims.stress < s2.dims.stress, `stress ${s2.dims.stress}→${s3.dims.stress}`);
check('④ 回落向基线靠拢（不低于基线的一半以下）', s3.dims.intimacy >= 0.15);

/* 单轮上限：一段全是刺激词的文本不能把维度打满 */
mood.resetState(OWNER, NOW);
const s4 = mood.tickState(OWNER, '烦烦烦累累累累困困困压力大压力崩溃', NOW);
check('④ 单轮刺激有上限（≤0.35）', s4.dims.stress <= 0.35, 'stress=' + s4.dims.stress);

/* per-owner 隔离 */
const other = mood.tickState('u:qq:99999', '哈哈开心', NOW);
check('④ 按 owner 隔离：别人的状态不影响我', mood.view(OWNER, NOW).dims.intimacy < 0.4, 'mine=' + mood.view(OWNER, NOW).dims.intimacy);

/* 重置 */
const s5 = mood.resetState(OWNER, NOW);
check('④ 重置回基线', Math.abs(s5.dims.intimacy - 0.3) < 0.01 && Math.abs(s5.dims.stress - 0.2) < 0.01);

/* 持久化：重开 store 后仍在 */
store.flush();
const moods = store.load().moods;
check('④ 状态持久化到 brain.json', !!moods[OWNER]);

/* ---------- 清理 ---------- */
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }

console.log('────────────────────────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
