#!/usr/bin/env node
/* ============================================================
 * eval.mjs —— 记忆能力评测（LongMemEval 五维度改造，LoCoMo 式对话史）
 *
 *   node scripts/eval.mjs            跑全部五维度，输出得分表
 *   node scripts/eval.mjs --json     机器可读
 *
 * 方法：生成一份带标准答案的合成对话史（确定性种子）→ 写入临时记忆库 →
 *       逐题调 engine.recall → 对照标准答案判分。
 * 维度：事实召回 / 时间推理(双时间线) / 知识更新(冲突) / 多跳关联(图扩散) / 拒答
 * 这是记忆质量的验收工具——不是装饰。
 * ============================================================ */
'use strict';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/* 数据隔离：先设目录再动态 import */
process.env.MEMORY_DATA_DIR = path.join(os.tmpdir(), 'dafenyu-eval-' + Date.now());
const store = await import('../lib/store.mjs');
const { recall } = await import('../lib/engine.mjs');
const { insertMemory, appendEpisode, supersede } = store;

const DAY = 86400000;
const NOW = Date.now();
const U = 'qq:10001';
const OWNER = 'u:' + U;

let seed = 424242;
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const daysAgo = (d) => NOW - d * DAY;

/* ── 合成对话史（每条都带标准答案）── */
const FACTS = [
  { t: '我叫小明，是杭州人', owner: OWNER, ents: ['小明', '杭州'], at: 300 },
  { t: '我养了一只叫团子的橘猫，特别粘人', owner: OWNER, ents: ['团子', '橘猫'], at: 280 },
  { t: '我女朋友叫小美，她是上海人', owner: OWNER, ents: ['小美', '上海'], at: 260 },
  { t: '我最喜欢的游戏是塞尔达', owner: OWNER, ents: ['塞尔达'], at: 200 },
  { t: '我在一家游戏公司上班，做策划', owner: OWNER, ents: ['游戏公司'], at: 180 },
  { t: '我不吃香菜，闻到就难受', owner: OWNER, ents: ['香菜'], at: 150 },
  { t: '我周五晚上一般九点下班', owner: OWNER, ents: ['周五'], at: 90 },
  { t: '我最近在读《三体》，很喜欢黑暗森林法则', owner: OWNER, ents: ['三体'], at: 45 },
  { t: '老王是我大学室友，现在在北京工作', owner: 'global', ents: ['老王', '北京'], at: 120 },
  { t: '小美养了一只叫雪球的英短', owner: 'global', ents: ['小美', '雪球'], at: 60 },
];
for (const f of FACTS) {
  appendEpisode({ channel: 'private', user: U, text: f.t });
  insertMemory({ text: f.t, kind: 'fact', importance: 0.75, owner: f.owner === OWNER ? OWNER : 'global',
    visibility: 'private', entities: f.ents, created_at: daysAgo(f.at), source: 'eval' });
}

/* 时间推理：城市变更（杭州 → 上海），旧事实保留 */
appendEpisode({ channel: 'private', user: U, text: '我搬去上海了，工作调动' });
const cityOld = insertMemory({ text: '他住在杭州', kind: 'fact', importance: 0.8, owner: OWNER,
  visibility: 'private', entities: ['杭州'], created_at: daysAgo(300), fact_key: `${U}.城市`, source: 'eval' });
const cityNew = insertMemory({ text: '他搬到上海了，工作调动', kind: 'fact', importance: 0.85, owner: OWNER,
  visibility: 'private', entities: ['上海'], created_at: daysAgo(7),
  fact_key: `${U}.城市`, source: 'eval' });
supersede(cityOld.id, cityNew.id, 'eval: city changed');

/* 干扰项（不相关记忆，测试拒答与噪声抵抗） */
for (let i = 0; i < 40; i++) {
  insertMemory({ text: `群聊闲话第${i}条：今天天气不错，大家聊得很开心`, kind: 'episode',
    importance: 0.3, owner: 'g:888', visibility: 'group', entities: [], created_at: daysAgo(ri2(1, 200)), source: 'eval' });
}
function ri2(a, b) { return a + Math.floor(rng() * (b - a + 1)); }

/* ── 评测题（五维度）── */
const CASES = [
  // 维度1：事实召回
  { dim: '事实召回', q: '我的猫叫什么名字', expectText: '团子' },
  { dim: '事实召回', q: '我不吃什么菜', expectText: '香菜' },
  { dim: '事实召回', q: '我最喜欢的游戏是什么', expectText: '塞尔达' },
  { dim: '事实召回', q: '小美的猫叫什么', expectText: '雪球' },
  { dim: '事实召回', q: '我在读什么书', expectText: '三体' },
  // 维度2：知识更新（冲突裁决后应返回新值）
  { dim: '知识更新', q: '我现在住哪个城市', expectText: '上海', notExpect: '杭州' },
  { dim: '知识更新', q: '他住在哪个城市', expectText: '上海', notExpect: '杭州' },
  // 维度3：多跳关联（团子 → 主人 → 城市变更）
  { dim: '多跳关联', q: '团子的主人现在住在哪里', expectText: '上海' },
  { dim: '多跳关联', q: '小美的猫的主人叫什么', expectText: '小美' },
  // 维度4：时间推理（as_of 历史视图）
  { dim: '时间推理', q: '他以前住哪个城市', expectText: '杭州', asOf: daysAgo(15), notExpect: null },
  // 维度5：拒答（没记过的问题应召回为空或低分）
  { dim: '拒答', q: '我最喜欢的歌手是谁', abstain: true },
  { dim: '拒答', q: '我的银行卡密码是多少', abstain: true },
  { dim: '拒答', q: '上次我去巴黎吃了什么', abstain: true },
];

/* ── 跑分 ── */
const results = [];
const byDim = {};
/* 检索指标（借 memory-brain EvalService 的指标形态）：recall@1/3/5 + MRR + 拒答正确率 */
const metrics = { r1: 0, r3: 0, r5: 0, mrr: 0, nonAbstain: 0, abstainOk: 0, abstainTotal: 0 };

async function main() {
  for (const c of CASES) {
    const hits = await recall(c.q, {
      owner: U, channel: 'private', k: 5,
      minScore: c.abstain ? 0.35 : 0.2,     // 拒答题用标准门槛
      asOf: c.asOf || null,
    });
    let pass, detail;
    if (c.abstain) {
      /* 拒答：期望没有高相关命中（Top1 分数 < 0.5 或无命中） */
      const top = hits[0];
      pass = !top || top.score < 0.55;   // 拒答阈值：Top1<0.55 视为无把握
      detail = top ? `Top1 ${top.score}「${top.text.slice(0, 24)}」` : '无命中';
      metrics.abstainTotal++;
      if (pass) metrics.abstainOk++;
    } else {
      const top3 = hits.slice(0, 3).map(h => h.text);
      const hitOk = top3.some(t => t.includes(c.expectText));
      const notOk = c.notExpect ? !top3.some(t => t.includes(c.notExpect)) : true;
      pass = hitOk && notOk;
      detail = top3.length ? top3[0].slice(0, 30) : '无命中';
      /* recall@k / MRR：第一个命中标准答案的名次 */
      metrics.nonAbstain++;
      const all = hits.map(h => h.text);
      const rank = all.findIndex(t => t.includes(c.expectText));
      if (rank === 0) metrics.r1++;
      if (rank >= 0 && rank < 3) metrics.r3++;
      if (rank >= 0 && rank < 5) metrics.r5++;
      if (rank >= 0) metrics.mrr += 1 / (rank + 1);
    }
    results.push({ dim: c.dim, q: c.q, pass, detail });
    byDim[c.dim] = byDim[c.dim] || { pass: 0, total: 0 };
    byDim[c.dim].total++; if (pass) byDim[c.dim].pass++;
  }

  /* 输出 */
  const rows = Object.entries(byDim).map(([d, v]) => `${d}: ${v.pass}/${v.total}`);
  const totalPass = results.filter(r => r.pass).length;
  const json = { total: results.length, pass: totalPass, byDim: {}, cases: results };
  for (const r of results) { json.byDim[r.dim] = json.byDim[r.dim] || { pass: 0, total: 0 }; json.byDim[r.dim].total++; if (r.pass) json.byDim[r.dim].pass++; }

  /* 指标归一化 */
  const n = Math.max(1, metrics.nonAbstain);
  const report = {
    recall1: +(metrics.r1 / n).toFixed(3),
    recall3: +(metrics.r3 / n).toFixed(3),
    recall5: +(metrics.r5 / n).toFixed(3),
    mrr: +(metrics.mrr / n).toFixed(3),
    abstainAcc: metrics.abstainTotal ? +(metrics.abstainOk / metrics.abstainTotal).toFixed(3) : null,
  };
  json.metrics = report;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log('══ 记忆能力评测（LongMemEval 五维度改造）══');
    for (const r of results) console.log(`${r.pass ? '✅' : '❌'} [${r.dim}] ${r.q} → ${r.detail}`);
    console.log('────────────────────────────');
    console.log(`总计：${totalPass}/${results.length} 通过`);
    for (const [d, v] of Object.entries(json.byDim)) console.log(`  ${d}: ${v.pass}/${v.total}`);
    console.log('────────────────────────────');
    console.log(`检索指标（非拒答题 ${metrics.nonAbstain} 条）：`);
    console.log(`  recall@1 ${report.recall1} · recall@3 ${report.recall3} · recall@5 ${report.recall5} · MRR ${report.mrr}`);
    if (report.abstainAcc != null) console.log(`  拒答正确率 ${report.abstainAcc}（${metrics.abstainOk}/${metrics.abstainTotal}）`);
  }

  /* 清理临时库（先 flush 防抖写，再删目录） */
  store.flush();
  try { fs.rmSync(process.env.MEMORY_DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exitCode = 0;
}

main().catch(e => { console.error('评测出错:', e); process.exit(1); });
