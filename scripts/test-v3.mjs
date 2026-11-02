#!/usr/bin/env node
/* test-v3.mjs —— v3 新增能力自测（临时目录，不碰真实数据） */
'use strict';
process.env.MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR
  || (await import('node:os')).tmpdir().replace(/\\/g, '/') + '/dafenyu-test-v3-' + Date.now();
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../lib/store.mjs';
import { retentionOf, stateOf, healthCheck, exportData, validateImport } from '../lib/viewmodel.mjs';
import { recall } from '../lib/engine.mjs';

let pass = 0, fail = 0;
const ok = (n, e = '') => { pass++; console.log('✅', n, e); };
const bad = (n, w) => { fail++; console.log('❌', n, '→', w); };
const check = (n, cond, extra = '') => (cond ? ok(n, extra) : bad(n, extra));
const DAY = 86400000;
const now = Date.now();
const old = (days) => now - days * DAY;

// 1. 分层衰减：事实 30 天半衰期比事件 14 天慢
const fact = store.insertMemory({ text: '他住在杭州西湖边', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public', created_at: old(14) });
const ep = store.insertMemory({ text: '那天在西湖边散步聊了很久', kind: 'episode', importance: 0.8, owner: 'global', visibility: 'public', created_at: old(14) });
check('分层衰减：14 天后事实留存高于事件', retentionOf(fact) > retentionOf(ep), `${retentionOf(fact)} > ${retentionOf(ep)}`);
check('分层衰减：事实 14 天留存约 0.58', Math.abs(retentionOf(fact) - 0.58) < 0.05, String(retentionOf(fact)));
check('分层衰减：事件 14 天留存约 0.4', Math.abs(retentionOf(ep) - 0.4) < 0.05, String(retentionOf(ep)));

// 2. 三态：清晰 / 模糊 / 折叠
const fuzzy = store.insertMemory({ text: '他多年前去过一次很远的地方旅行', kind: 'episode', importance: 0.9, owner: 'global', visibility: 'public', created_at: old(28) });
const folded = store.insertMemory({ text: '他多年前随口提过一件小事', kind: 'episode', importance: 0.5, owner: 'global', visibility: 'public', created_at: old(90) });
check('三态：新事实为 clear', stateOf(fact) === 'clear', stateOf(fact));
check('三态：28 天事件为 fuzzy', stateOf(fuzzy) === 'fuzzy', `${stateOf(fuzzy)} retention=${retentionOf(fuzzy)}`);
check('三态：90 天事件为 folded', stateOf(folded) === 'folded', `${stateOf(folded)} retention=${retentionOf(folded)}`);

// 3. 事实键冲突：不自动删除，挂待裁决
const a = store.insertMemory({ text: '他住在杭州', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public', fact_key: 'home.city' });
const b = store.insertMemory({ text: '他住在上海', kind: 'fact', importance: 0.8, owner: 'global', visibility: 'public', fact_key: 'home.city' });
const pending = store.listConflicts('pending');
check('事实键冲突：同键新事实产生 pending 冲突', pending.some((c) => c.old_id === a.id && c.new_id === b.id), JSON.stringify(pending.map((c) => c.id)));
check('事实键冲突：裁决前双方都还是 active', store.getMemory(a.id).status === 'active' && store.getMemory(b.id).status === 'active');

// 4. 裁决 keep_new：旧条 superseded，新条生效
const c1 = pending.find((c) => c.old_id === a.id && c.new_id === b.id);
const resolved = store.resolveConflict(c1.id, 'keep_new', '搬家确认');
check('裁决 keep_new：旧条 superseded', store.getMemory(a.id).status === 'superseded' && store.getMemory(a.id).superseded_by === b.id);
check('裁决 keep_new：冲突标记 resolved', resolved && resolved.status === 'resolved' && resolved.choice === 'keep_new');

// 5. 裁决 keep_old：新条 superseded，旧条继续生效
const a2 = store.insertMemory({ text: '他喜欢喝咖啡', kind: 'preference', importance: 0.7, owner: 'global', visibility: 'public', fact_key: 'drink.pref' });
const b2 = store.insertMemory({ text: '他喜欢喝茶', kind: 'preference', importance: 0.7, owner: 'global', visibility: 'public', fact_key: 'drink.pref' });
const c2 = store.listConflicts('pending').find((c) => c.old_id === a2.id && c.new_id === b2.id);
store.resolveConflict(c2.id, 'keep_old');
check('裁决 keep_old：新条 superseded，旧条仍 active', store.getMemory(b2.id).status === 'superseded' && store.getMemory(a2.id).status === 'active');

// 6. 裁决 mark_only：双方都保持 active
const a3 = store.insertMemory({ text: '他周末喜欢爬山', kind: 'preference', importance: 0.6, owner: 'global', visibility: 'public', fact_key: 'weekend.pref' });
const b3 = store.insertMemory({ text: '他周末喜欢游泳', kind: 'preference', importance: 0.6, owner: 'global', visibility: 'public', fact_key: 'weekend.pref' });
const c3 = store.listConflicts('pending').find((c) => c.old_id === a3.id && c.new_id === b3.id);
store.resolveConflict(c3.id, 'mark_only', '两种都可能，暂不裁');
check('裁决 mark_only：双方都保持 active', store.getMemory(a3.id).status === 'active' && store.getMemory(b3.id).status === 'active');

// 7. 审计日志已写
store.flush();
const auditPath = path.join(process.env.MEMORY_DATA_DIR, 'audit.jsonl');
const auditText = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
check('审计日志：conflict_resolved 已写入 audit.jsonl', auditText.includes('conflict_resolved'), `${auditText.split('\n').filter(Boolean).length} 行`);

// 8. 召回解释：落选带原因
const hits = await recall('团子', { owner: '', channel: 'private', k: 1, coreK: 1, minScore: 0.99, explain: true });
check('召回解释：高门槛下有 below_minScore 落选', (hits.rejected || []).some((r) => r.reason === 'below_minScore'), JSON.stringify((hits.rejected || []).map((r) => r.reason)));
check('召回解释：rejected 不含 superseded 旧条', !(hits.rejected || []).some((r) => r.id === a.id));

// 9. 双通道：核心预算与事件预算互不挤占
store.insertMemory({ text: '团子是橘猫', kind: 'fact', importance: 0.9, owner: 'global', visibility: 'public', entities: ['团子'] });
store.insertMemory({ text: '团子昨天打翻了水杯', kind: 'episode', importance: 0.9, owner: 'global', visibility: 'public', entities: ['团子'] });
store.insertMemory({ text: '团子最喜欢晒太阳', kind: 'fact', importance: 0.9, owner: 'global', visibility: 'public', entities: ['团子'] });
store.insertMemory({ text: '团子今天在阳台睡觉', kind: 'episode', importance: 0.9, owner: 'global', visibility: 'public', entities: ['团子'] });
const dual = await recall('团子', { owner: '', channel: 'private', k: 1, coreK: 1, minScore: -1 });
check('双通道：k=1 且 coreK=1 时核心与事件各至少 1 条', (dual.channels.core.length >= 1 && dual.channels.event.length >= 1), JSON.stringify(dual.channels));

// 10. 承诺账本：生命周期 + 逾期只计算不改写
const intent = store.addIntent({ text: '周五晚上陪你开黑', owner: 'global', due_at: now + DAY, evidence_hint: '周五对话记录' });
check('承诺账本：新建为 open', store.listIntents().find((t) => t.id === intent.id)?.status === 'open');
const overdue = store.addIntent({ text: '昨天就该做的事', owner: 'global', due_at: now - DAY });
const overdueView = store.listIntents().find((t) => t.id === overdue.id);
check('承诺账本：已过期的未裁决显示 overdue', overdueView?.status === 'overdue' && overdueView?.overdue === true);
const raw = store.load().intents.find((t) => t.id === overdue.id);
check('承诺账本：逾期计算不改写原记录', raw.status === 'open');
const done = store.resolveIntent(intent.id, 'fulfilled', '周五已开黑截图');
check('承诺账本：兑现后状态为 fulfilled', done && done.status === 'fulfilled' && done.evidence.includes('开黑'));

// 11. 体检只读：调用前后状态 JSON 不变
const before = JSON.stringify(store.load());
const hc = healthCheck(store.load());
const after = JSON.stringify(store.load());
check('体检只读：调用前后状态不变', before === after);
check('体检计数：待裁决冲突与逾期承诺被计入', hc.counts.pendingConflicts >= 0 && hc.counts.overdueIntents >= 1, JSON.stringify(hc.counts));

// 12. 面板 v3 存在且含三个新页签
const panel = fs.readFileSync(path.join(process.cwd(), 'public', 'panel.html'), 'utf8');
check('面板 v3：含 召回解释 / 承诺账本 / 记忆体检', panel.includes('召回解释') && panel.includes('承诺账本') && panel.includes('记忆体检'));
check('面板 v3：含诚实标注（近似/预览）', panel.includes('近似') && panel.includes('预览'));

// 13. 导出导入往返（含 v3 字段），v2 导出仍可接受
const exp = exportData(store.load());
check('导出 v3：含 intents 与 conflicts', Array.isArray(exp.intents) && Array.isArray(exp.conflicts) && exp.version === 3);
const v = validateImport(exp);
check('导入 v3：校验通过且保留 fact_key', v.ok && v.data.memories.some((m) => m.fact_key === 'home.city'));
const v2doc = { format: 'dafenyu-memory-export', version: 2, memories: [{ text: '旧版一条', kind: 'fact' }], entities: {}, relations: [] };
check('导入兼容：v2 导出仍可接受', validateImport(v2doc).ok);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
store.flush();
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exitCode = fail ? 1 : 0;
