#!/usr/bin/env node
/* ============================================================
 * test-v7.mjs —— 全面体检后的加固回归（2026-11-01）
 *   ① null/空值不再被 Number() 强转成 0
 *   ② 周几解析到过去要顺延一周，不是一天
 *   ③ 清库保护：待裁决冲突引用的记忆不物理删除
 *   ④ 导入白名单 + 钳制（importance/visibility/owner/id）
 *   ⑤ 面板鉴权包装存在
 * ============================================================ */
'use strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MEMORY_DATA_DIR = path.join(os.tmpdir(), 'mind-sea-memory-v7-' + Date.now());
const store = await import('../lib/store.mjs');
const { nightly } = await import('../lib/engine.mjs');
const { parseChineseTime } = await import('../lib/intent.mjs');
const { validateImport } = await import('../lib/viewmodel.mjs');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  ' + detail : ''));
  ok ? pass++ : fail++;
}
const DAY = 86400000;

/* ① null 安全 */
const m1 = store.insertMemory({ text: '无有效期的记忆', kind: 'fact', importance: 0.5, owner: 'global', visibility: 'public', entities: [], valid_until: null, confidence: null });
check('① valid_until=null 保持 null（不是 0/1970）', m1.valid_until === null, '=' + m1.valid_until);
check('① confidence=null 回退 0.6（不是 0）', m1.confidence === 0.6, '=' + m1.confidence);
check('① clamp(null) 回退默认值', store.clamp(null, 0, 1, 0.42) === 0.42);
const it1 = store.addIntent({ text: '无截止承诺', owner: 'global', due_at: null });
check('① 承诺 due_at=null 保持 null', it1.due_at === null, '=' + it1.due_at);

/* ② 周几顺延 */
const NOW = new Date(2026, 10, 1, 10, 0, 0).getTime();   // 2026-11-01 周日 10:00
const tSun = parseChineseTime('周日', NOW);
const diffDays = tSun ? Math.round((tSun.at - NOW) / DAY) : null;
check('② 周日（今天已过 9 点）→ 顺延 7 天而不是 1 天', diffDays === 7 && new Date(tSun.at).getDay() === 0, tSun ? new Date(tSun.at).toString().slice(0, 15) : 'null');
const tWed = parseChineseTime('周三下午两点', NOW);
check('② 周三仍在 3 天后且是周三', tWed && Math.round((tWed.at - NOW) / DAY) === 3 && new Date(tWed.at).getDay() === 3);
const tToday = parseChineseTime('今天早上8点', NOW);
check('② 普通日期顺延仍为 1 天', tToday && Math.round((tToday.at - NOW) / DAY) === 1);

/* ③ 清库保护 */
const s = store.load();
const referenced = store.insertMemory({ text: '被冲突引用的归档记忆', kind: 'fact', importance: 0.5, owner: 'global', visibility: 'public', entities: [] });
const orphan = store.insertMemory({ text: '无人引用的归档记忆', kind: 'fact', importance: 0.5, owner: 'global', visibility: 'public', entities: [] });
for (const m of s.memories) {
  if (m.id === referenced.id || m.id === orphan.id) { m.status = 'archived'; m.archived_at = Date.now() - 300 * DAY; }
}
s.conflicts.push({ id: 'c900001', owner: 'global', fact_key: '', old_id: referenced.id, new_id: referenced.id, status: 'pending', created_at: Date.now() });
const n = nightly({ purgeDays: 180, autoConflict: false });
check('③ 待裁决冲突引用的归档记忆不被清除', !!store.getMemory(referenced.id), 'purged=' + n.purged);
check('③ 无引用的归档记忆正常清除', !store.getMemory(orphan.id));

/* ④ 导入加固 */
const bad = {
  format: 'dafenyu-memory-export',
  memories: [
    { text: '恶意导入：重要度超限', importance: 999, visibility: '乱写', owner: 'hacker', kind: '不存在的类型' },
    { text: '无 id 的记忆', importance: 0.5 },
    { text: 123 },   // 非字符串 text 应被过滤
  ],
};
const v = validateImport(bad);
check('④ 导入通过基本格式校验', v.ok === true);
const im0 = v.data.memories[0];
check('④ importance 被钳到 1', im0.importance === 1, '=' + im0.importance);
check('④ visibility 非法值回落 public', im0.visibility === 'public', im0.visibility);
check('④ owner 非法值回落 global', im0.owner === 'global', im0.owner);
check('④ kind 非法值回落 episode', im0.kind === 'episode', im0.kind);
check('④ 非字符串 text 被过滤', v.data.memories.length === 2, 'n=' + v.data.memories.length);
const before = store.load().memories.length;
store.importMemories(v.data, { replace: false });
const added = store.load().memories.slice(before);
check('④ 无 id 的导入记忆自动补发 id', added.every((m) => /^m\d+$/.test(m.id)), added.map((m) => m.id).join(','));

/* ⑥ seq 维护：外部指定 id / 导入后，新写入不能撞车 */
const s6 = store.load();
const ext = store.insertMemory({ id: 'm000500', text: '外部指定 id 的记忆', kind: 'fact', importance: 0.5, owner: 'global', visibility: 'public', entities: [] });
const afterExt = store.insertMemory({ text: '紧随其后的新记忆', kind: 'fact', importance: 0.5, owner: 'global', visibility: 'public', entities: [] });
check('⑥ 指定 id 后 seq 已顶高（新 id > 指定 id）', Number(afterExt.id.slice(1)) > 500, `${ext.id} → ${afterExt.id}`);
const v6 = validateImport({ format: 'dafenyu-memory-export', memories: [{ id: 'm000900', text: '导入的指定 id' }] });
store.importMemories(v6.data);
const afterImp = store.insertMemory({ text: '导入后的新记忆', kind: 'fact', importance: 0.5, owner: 'global', visibility: 'public', entities: [] });
check('⑥ 导入后 seq 已顶高（新 id > 导入 id）', Number(afterImp.id.slice(1)) > 900, afterImp.id);

/* ⑤ 面板鉴权包装 */
const html = fs.readFileSync(new URL('../public/panel.html', import.meta.url), 'utf8');
check('⑤ 面板含 token 注入包装', html.includes('mindsea-token') && html.includes("'Bearer '"));
check('⑤ 面板 401 会自动重试', html.includes('res.status === 401'));

/* 清理 */
store.flush();
try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch { /* tmp */ }

console.log('────────────────────────────');
console.log(`通过 ${pass} · 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
